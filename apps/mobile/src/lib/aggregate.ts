/**
 * On-device aggregation of tide-corrected soundings into per-H3-cell, per-UTC-day rows:
 *   {h3_cell, day, median_ft, p10_ft, n}
 * Upload payloads carry NO uid, boat id, sub-day timestamp or track order: enforced by the
 * DepthUploadRow type (readonly, exactly five keys), by sanitizeUploadRows (runtime strip) and
 * assertAnonymousUploadPayload (runtime guard used right before send and in tests).
 *
 * Values are CHARTED DEPTH in ft below MLLW (positive down); p10_ft is the 10th percentile of depth,
 * i.e. the shoal-biased value (linear-interpolation percentile, "type 7").
 */
import { isValidCell, latLngToCell } from 'h3-js';
import { H3_RESOLUTION, type DepthUploadRow } from '@clearwater/shared';

export interface CorrectedSounding {
  tMs: number;
  lat: number;
  lon: number;
  /** Charted depth, ft below MLLW (positive down). */
  mllwDepthFt: number;
}

export const UPLOAD_ROW_KEYS = ['h3_cell', 'day', 'median_ft', 'p10_ft', 'n'] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcDay(tMs: number): string {
  return new Date(tMs).toISOString().slice(0, 10);
}

/** Linear-interpolation percentile of an ASCENDING array, p in [0,1]. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0] as number;
  const idx = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sortedAsc[lo] as number;
  const b = sortedAsc[hi] as number;
  return a + (b - a) * (idx - lo);
}

/** Round to 0.01 ft: removes float noise and avoids encoding more precision than the sounder has. */
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function aggregateSoundings(soundings: readonly CorrectedSounding[]): DepthUploadRow[] {
  const groups = new Map<string, { h3_cell: string; day: string; depths: number[] }>();
  for (const s of soundings) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || !Number.isFinite(s.mllwDepthFt) || !Number.isFinite(s.tMs)) {
      continue;
    }
    const h3_cell = latLngToCell(s.lat, s.lon, H3_RESOLUTION);
    const day = utcDay(s.tMs);
    const key = `${day}|${h3_cell}`;
    let g = groups.get(key);
    if (!g) {
      g = { h3_cell, day, depths: [] };
      groups.set(key, g);
    }
    g.depths.push(s.mllwDepthFt);
  }
  const rows: DepthUploadRow[] = [];
  for (const g of groups.values()) {
    g.depths.sort((a, b) => a - b);
    rows.push({
      h3_cell: g.h3_cell,
      day: g.day,
      median_ft: r2(percentile(g.depths, 0.5)),
      p10_ft: r2(percentile(g.depths, 0.1)),
      n: g.depths.length,
    });
  }
  // Deterministic order that reveals no track order: by day then cell id.
  rows.sort((a, b) => (a.day === b.day ? (a.h3_cell < b.h3_cell ? -1 : 1) : a.day < b.day ? -1 : 1));
  return rows;
}

/** n-weighted median of values (ties resolved to the lower value). */
function weightedMedian(items: ReadonlyArray<{ v: number; w: number }>): number {
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const it of sorted) {
    acc += it.w;
    if (acc >= total / 2) return it.v;
  }
  return (sorted[sorted.length - 1] as { v: number }).v;
}

/**
 * Merge rows that share (h3_cell, day) — used when the outbox squeezes old depth batches.
 * Approximation (the raw soundings are gone): median = n-weighted median of the medians,
 * p10 = n-weighted mean of the p10s, n = sum.
 */
export function mergeUploadRows(rows: readonly DepthUploadRow[]): DepthUploadRow[] {
  const groups = new Map<string, DepthUploadRow[]>();
  for (const r of rows) {
    const k = `${r.day}|${r.h3_cell}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: DepthUploadRow[] = [];
  for (const g of groups.values()) {
    const first = g[0] as DepthUploadRow;
    if (g.length === 1) {
      out.push(first);
      continue;
    }
    const n = g.reduce((s, r) => s + r.n, 0);
    out.push({
      h3_cell: first.h3_cell,
      day: first.day,
      median_ft: r2(weightedMedian(g.map((r) => ({ v: r.median_ft, w: r.n })))),
      p10_ft: r2(g.reduce((s, r) => s + r.p10_ft * r.n, 0) / n),
      n,
    });
  }
  out.sort((a, b) => (a.day === b.day ? (a.h3_cell < b.h3_cell ? -1 : 1) : a.day < b.day ? -1 : 1));
  return out;
}

/** Type-level guard: resolves to `never` for any row type carrying keys beyond the five allowed ones. */
export type NoExtraKeys<T> = Exclude<keyof T, keyof DepthUploadRow> extends never ? unknown : never;

function isRowShape(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validRow(o: Record<string, unknown>): DepthUploadRow | null {
  const { h3_cell, day, median_ft, p10_ft, n } = o;
  if (typeof h3_cell !== 'string' || !isValidCell(h3_cell)) return null;
  if (typeof day !== 'string' || !DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return null;
  if (typeof median_ft !== 'number' || !Number.isFinite(median_ft)) return null;
  if (typeof p10_ft !== 'number' || !Number.isFinite(p10_ft)) return null;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return null;
  return { h3_cell, day, median_ft, p10_ft, n };
}

export interface SanitizeResult {
  rows: DepthUploadRow[];
  /** Rows dropped for invalid values. */
  dropped: number;
  /** Rows that carried extra keys which were stripped (uid, timestamps, ...). */
  stripped: number;
}

/** Runtime strip: keep ONLY the five allowed keys; drop rows with invalid values. */
export function sanitizeUploadRows(input: readonly unknown[]): SanitizeResult {
  const rows: DepthUploadRow[] = [];
  let dropped = 0;
  let stripped = 0;
  for (const item of input) {
    if (!isRowShape(item)) {
      dropped++;
      continue;
    }
    if (Object.keys(item).some((k) => !(UPLOAD_ROW_KEYS as readonly string[]).includes(k))) stripped++;
    const row = validRow(item);
    if (row) rows.push(row);
    else dropped++;
  }
  return { rows, dropped, stripped };
}

export interface DepthUploadPayload {
  readonly rows: readonly DepthUploadRow[];
}

/** Throws unless the payload is exactly `{rows: [{5 allowed keys}...]}`. Run just before sending. */
export function assertAnonymousUploadPayload(payload: unknown): asserts payload is DepthUploadPayload {
  if (!isRowShape(payload)) throw new Error('depth payload must be an object');
  const topKeys = Object.keys(payload);
  if (topKeys.length !== 1 || topKeys[0] !== 'rows') {
    throw new Error(`depth payload has forbidden top-level keys: ${topKeys.join(',')}`);
  }
  const rows = payload.rows;
  if (!Array.isArray(rows)) throw new Error('depth payload rows must be an array');
  for (const r of rows) {
    if (!isRowShape(r)) throw new Error('depth row must be an object');
    const keys = Object.keys(r).sort();
    const want = [...UPLOAD_ROW_KEYS].sort();
    if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
      throw new Error(`depth row has forbidden or missing keys: ${keys.join(',')}`);
    }
    if (!validRow(r)) throw new Error('depth row has invalid values');
  }
}

/**
 * Build the upload payload. Compile-time: a row type with extra keys (e.g. `uid`) does not type-check.
 * Run-time: extra keys are stripped and invalid rows dropped even if the type was bypassed with a cast.
 */
export function buildUploadPayload<T extends DepthUploadRow>(
  rows: readonly T[] & NoExtraKeys<T>,
): DepthUploadPayload {
  const { rows: clean } = sanitizeUploadRows(rows);
  const payload: DepthUploadPayload = { rows: clean };
  assertAnonymousUploadPayload(payload);
  return payload;
}
