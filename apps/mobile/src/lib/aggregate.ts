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
import { getResolution, isValidCell, latLngToCell } from 'h3-js';
import { DEPTH_VALUE_LIMIT_FT, H3_RESOLUTION, type DepthUploadRow } from '@clearwater/shared';
import { round2 } from './num';

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

/** Accepted sounding times: 2020-01-01 .. 2100-01-01 UTC (the server rejects older; beyond is a clock bug). */
const MIN_T_MS = Date.UTC(2020, 0, 1);
const MAX_T_MS = Date.UTC(2100, 0, 1);

const validLatLon = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

/** True for an acceptable raw sounding. Checked BEFORE H3: out-of-range coordinates still map to valid cells. */
export function validSounding(s: CorrectedSounding): boolean {
  return (
    Number.isFinite(s.tMs) && s.tMs >= MIN_T_MS && s.tMs < MAX_T_MS &&
    validLatLon(s.lat, s.lon) &&
    Number.isFinite(s.mllwDepthFt) && Math.abs(s.mllwDepthFt) <= DEPTH_VALUE_LIMIT_FT
  );
}

export function aggregateSoundings(soundings: readonly CorrectedSounding[]): DepthUploadRow[] {
  const groups = new Map<string, { h3_cell: string; day: string; depths: number[] }>();
  for (const s of soundings) {
    if (!validSounding(s)) continue;
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
      median_ft: round2(percentile(g.depths, 0.5)),
      p10_ft: round2(percentile(g.depths, 0.1)),
      n: g.depths.length,
    });
  }
  // Deterministic order that reveals no track order: by day then cell id.
  rows.sort(byDayThenCell);
  return rows;
}

const byDayThenCell = (a: DepthUploadRow, b: DepthUploadRow): number =>
  a.day === b.day ? (a.h3_cell < b.h3_cell ? -1 : a.h3_cell > b.h3_cell ? 1 : 0) : a.day < b.day ? -1 : 1;

/**
 * Collapse rows that share (h3_cell, day). Every upload is the COMPLETE UTC-day aggregate of its cell (see
 * reaggregateTouched) and the server upserts-replace, so for the same (cell, day) the LATER row supersedes the
 * earlier one; they must never be summed. Input is in send order (oldest first). p10 is clamped to <= median.
 */
export function mergeUploadRows(rows: readonly DepthUploadRow[]): DepthUploadRow[] {
  const latest = new Map<string, DepthUploadRow>();
  for (const r of rows) latest.set(`${r.day}|${r.h3_cell}`, r);
  return [...latest.values()]
    .map((r) => ({ ...r, p10_ft: Math.min(r.p10_ft, r.median_ft) }))
    .sort(byDayThenCell);
}

/**
 * B1: each upload must carry the COMPLETE UTC-day aggregate for every cell touched since the last batch, because the
 * server replaces (cell, day). `fresh` are the soundings not yet uploaded; `dayRows` are ALL stored soundings of the
 * UTC days those touch. A cell logged at 10:00 and again at 14:00 therefore uploads the combined n / median / p10.
 */
export function reaggregateTouched(fresh: readonly CorrectedSounding[], dayRows: readonly CorrectedSounding[]): DepthUploadRow[] {
  const touched = new Set(aggregateSoundings(fresh).map((r) => `${r.day}|${r.h3_cell}`));
  return aggregateSoundings(dayRows).filter((r) => touched.has(`${r.day}|${r.h3_cell}`));
}

/** Type-level guard: resolves to `never` for any row type carrying keys beyond the five allowed ones. */
export type NoExtraKeys<T> = Exclude<keyof T, keyof DepthUploadRow> extends never ? unknown : never;

/** YYYY-MM-DD that is a real calendar day (rejects 2026-02-31, 2026-13-01, ...). */
export function isRealCalendarDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

function isRowShape(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function validRow(o: Record<string, unknown>): DepthUploadRow | null {
  const { h3_cell, day, median_ft, p10_ft, n } = o;
  if (typeof h3_cell !== 'string' || !isValidCell(h3_cell) || getResolution(h3_cell) !== H3_RESOLUTION) return null;
  if (typeof day !== 'string' || !isRealCalendarDay(day)) return null;
  if (typeof median_ft !== 'number' || !Number.isFinite(median_ft) || Math.abs(median_ft) > DEPTH_VALUE_LIMIT_FT) return null;
  if (typeof p10_ft !== 'number' || !Number.isFinite(p10_ft) || Math.abs(p10_ft) > DEPTH_VALUE_LIMIT_FT) return null;
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
