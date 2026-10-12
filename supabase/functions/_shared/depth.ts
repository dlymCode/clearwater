// Validation for the depth-upload payload (docs/AGENT-PLAN.md "Depth logging & upload").
//
// Wire format (either form):
//   { "batch_id": "<uuid>", "rows": [ { h3_cell, day, median_ft, p10_ft, n }, ... ] }
//   [ { h3_cell, day, median_ft, p10_ft, n }, ... ]   + header  Idempotency-Key: <uuid>
//
// Sign convention (docs/AGENT-PLAN.md addendum): median_ft and p10_ft are DEPTH BELOW MLLW in feet,
// POSITIVE DOWN (sounder convention; 12 = twelve feet of water). p10_ft is the shoal-biased 10th
// percentile (so p10_ft <= median_ft). The pipeline baseline is elevation positive up, so the SQL
// hold rule compares median_ft with -baseline_elev_ft. Intertidal cells that dry therefore have
// negative values here.
//
// Privacy rule (FLT-5): the payload must carry no uid / boat id / track order and nothing finer
// than a UTC day. This is enforced as an ALLOW-LIST: any field outside the five below is rejected,
// and fields that look identifying get a specific error so a misbehaving client is easy to spot.
import { cellToLatLng, getResolution, isValidCell } from "npm:h3-js@4.1.0";
import { addDays, isIsoDay, utcDay } from "./hmac.ts";
import { HttpError, isUuid } from "./http.ts";

export const MAX_ROWS = 5000;
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_AGE_DAYS = 180;
export const MAX_FUTURE_DAYS = 1;

export interface DepthRow {
  h3_cell: string;
  day: string;
  median_ft: number;
  p10_ft: number;
  n: number;
}

export interface ParsedBatch {
  batchId: string;
  rows: DepthRow[];
}

const ROW_KEYS = new Set(["h3_cell", "day", "median_ft", "p10_ft", "n"]);
const BODY_KEYS = new Set(["batch_id", "rows"]);

const IDENTIFYING =
  /^(uid|user_?id|user|boat(_?id)?|vessel(_?id)?|device(_?id)?|uploader(_?hash)?|author(_?id)?|handle|email|phone|lat|lon|lng|latitude|longitude|geom|position|track|seq|sequence|order|idx|index)$/i;
const TIMEY =
  /^(t|ts|time|timestamp|datetime|date_?time|created_?at|recorded_?at|received_?at|updated_?at|hour|minute|second|epoch)$/i;

const H3_RES12 = /^8c[0-9a-f]{13}$/;
const DEPTH_LIMIT_FT = 2000;

// Salish Sea box, the same one the database CHECKs use (supabase/migrations/..._extensions_types.sql).
const SALISH = { minLon: -124.0, maxLon: -121.9, minLat: 46.9, maxLat: 49.1 };

/** A real H3 cell at resolution 12 whose centre lies inside the Salish Sea box. */
export function isSalishCell(cell: string): boolean {
  if (!H3_RES12.test(cell)) return false;
  try {
    if (!isValidCell(cell) || getResolution(cell) !== 12) return false;
    const [lat, lon] = cellToLatLng(cell);
    return lon >= SALISH.minLon && lon <= SALISH.maxLon && lat >= SALISH.minLat && lat <= SALISH.maxLat;
  } catch {
    return false;
  }
}

function fail(code: string, message: string): never {
  throw new HttpError(400, code, message);
}

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(obj)) {
    if (allowed.has(k)) continue;
    if (IDENTIFYING.test(k)) {
      fail("identifying_field", `${where}: field "${k}" is not allowed (uploads must be anonymous).`);
    }
    if (TIMEY.test(k)) {
      fail("timestamp_too_fine", `${where}: field "${k}" is not allowed (nothing finer than the day).`);
    }
    fail("unknown_field", `${where}: unexpected field "${k}".`);
  }
}

function finiteInRange(v: unknown, name: string, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail("invalid_value", `${where}: ${name} must be a finite number.`);
  if (v < -DEPTH_LIMIT_FT || v > DEPTH_LIMIT_FT) fail("invalid_value", `${where}: ${name} is out of range.`);
  return v;
}

export function parseDepthBatch(body: unknown, idempotencyKey: string | null, now: Date): ParsedBatch {
  let batchId: string | null = null;
  let rawRows: unknown;

  if (Array.isArray(body)) {
    rawRows = body;
  } else if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    checkKeys(o, BODY_KEYS, "body");
    batchId = typeof o.batch_id === "string" ? o.batch_id : null;
    rawRows = o.rows;
  } else {
    fail("invalid_body", "Body must be an object with `rows` or an array of rows.");
  }

  batchId = (batchId ?? idempotencyKey ?? "").toLowerCase();
  if (!isUuid(batchId)) fail("invalid_batch_id", "A client batch UUID is required (body.batch_id or Idempotency-Key).");
  if (idempotencyKey && idempotencyKey.toLowerCase() !== batchId) {
    fail("invalid_batch_id", "Idempotency-Key and body.batch_id disagree.");
  }

  if (!Array.isArray(rawRows) || rawRows.length === 0) fail("invalid_rows", "`rows` must be a non-empty array.");
  if (rawRows.length > MAX_ROWS) fail("invalid_rows", `At most ${MAX_ROWS} rows per batch.`);

  const today = utcDay(now);
  const oldest = addDays(today, -MAX_AGE_DAYS);
  const newest = addDays(today, MAX_FUTURE_DAYS);
  const seen = new Set<string>();
  const rows: DepthRow[] = [];

  rawRows.forEach((r, i) => {
    const where = `rows[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) fail("invalid_rows", `${where} must be an object.`);
    const o = r as Record<string, unknown>;
    checkKeys(o, ROW_KEYS, where);

    const cell = o.h3_cell;
    if (typeof cell !== "string" || !H3_RES12.test(cell)) {
      fail("invalid_cell", `${where}: h3_cell must be a lowercase H3 resolution-12 index.`);
    }
    if (!isSalishCell(cell)) {
      fail("invalid_cell", `${where}: h3_cell is not a valid cell inside the Salish Sea.`);
    }
    const day = o.day;
    if (typeof day !== "string") fail("invalid_day", `${where}: day must be a YYYY-MM-DD string.`);
    if (!isIsoDay(day)) {
      // A full timestamp such as 2026-10-01T14:03:22Z lands here: report it as the privacy violation it is.
      if (/^\d{4}-\d{2}-\d{2}[T ]/.test(day)) fail("timestamp_too_fine", `${where}: day must not carry a time of day.`);
      fail("invalid_day", `${where}: day must be a valid YYYY-MM-DD date.`);
    }
    if (day < oldest || day > newest) fail("invalid_day", `${where}: day is outside the accepted window.`);

    const median = finiteInRange(o.median_ft, "median_ft", where);
    const p10 = finiteInRange(o.p10_ft, "p10_ft", where);
    // depth is positive down and p10 is the shoal-biased percentile, so it can never exceed the median
    if (p10 > median) fail("invalid_value", `${where}: p10_ft must not be deeper than median_ft.`);
    const n = o.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 86400) {
      fail("invalid_value", `${where}: n must be an integer between 1 and 86400.`);
    }

    const key = `${cell}|${day}`;
    if (seen.has(key)) fail("duplicate_row", `${where}: one row per cell and day.`);
    seen.add(key);
    rows.push({ h3_cell: cell, day, median_ft: median, p10_ft: p10, n });
  });

  return { batchId, rows };
}
