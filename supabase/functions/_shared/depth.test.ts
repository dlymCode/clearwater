import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { MAX_ROWS, parseDepthBatch } from "./depth.ts";
import { HttpError } from "./http.ts";

const NOW = new Date("2026-10-09T12:00:00Z");
const BATCH = "11111111-2222-4333-8444-555555555555";
const row = (over: Record<string, unknown> = {}) => ({
  h3_cell: "8c2a1072b59ffff",
  day: "2026-10-08",
  median_ft: -12.5,
  p10_ft: -14,
  n: 40,
  ...over,
});

function code(fn: () => unknown): string {
  const e = assertThrows(fn, HttpError);
  assertEquals((e as HttpError).status, 400);
  return (e as HttpError).code;
}

Deno.test("accepts the exact AGENT-PLAN row shape in an object body", () => {
  const p = parseDepthBatch({ batch_id: BATCH, rows: [row()] }, null, NOW);
  assertEquals(p.batchId, BATCH);
  assertEquals(p.rows, [row()]);
});

Deno.test("accepts a bare array when the batch UUID comes from Idempotency-Key", () => {
  assertEquals(parseDepthBatch([row()], BATCH, NOW).batchId, BATCH);
  assertEquals(code(() => parseDepthBatch([row()], null, NOW)), "invalid_batch_id");
  assertEquals(
    code(() => parseDepthBatch({ batch_id: BATCH, rows: [row()] }, "99999999-2222-4333-8444-555555555555", NOW)),
    "invalid_batch_id",
  );
});

Deno.test("rejects anything that identifies the boat or orders the track", () => {
  for (const k of ["uid", "user_id", "boat_id", "uploader_hash", "device_id", "lat", "lon", "seq", "track", "handle"]) {
    assertEquals(
      code(() => parseDepthBatch({ batch_id: BATCH, rows: [row({ [k]: "x" })] }, null, NOW)),
      "identifying_field",
      k,
    );
  }
  assertEquals(
    code(() => parseDepthBatch({ batch_id: BATCH, uid: "x", rows: [row()] }, null, NOW)),
    "identifying_field",
  );
});

Deno.test("rejects timestamps finer than a day", () => {
  for (const k of ["t", "ts", "timestamp", "created_at", "recorded_at", "hour"]) {
    assertEquals(
      code(() => parseDepthBatch({ batch_id: BATCH, rows: [row({ [k]: 1 })] }, null, NOW)),
      "timestamp_too_fine",
      k,
    );
  }
  assertEquals(
    code(() => parseDepthBatch({ batch_id: BATCH, rows: [row({ day: "2026-10-08T14:03:22Z" })] }, null, NOW)),
    "timestamp_too_fine",
  );
  assertEquals(
    code(() => parseDepthBatch({ batch_id: BATCH, rows: [row({ day: "2026-10-08 14:03" })] }, null, NOW)),
    "timestamp_too_fine",
  );
});

Deno.test("rejects unknown fields (allow-list)", () => {
  assertEquals(
    code(() => parseDepthBatch({ batch_id: BATCH, rows: [row({ colour: "red" })] }, null, NOW)),
    "unknown_field",
  );
});

Deno.test("field validation", () => {
  const bad = (over: Record<string, unknown>) =>
    code(() => parseDepthBatch({ batch_id: BATCH, rows: [row(over)] }, null, NOW));
  assertEquals(bad({ h3_cell: "8C2A1072B59FFFF" }), "invalid_cell");
  assertEquals(bad({ h3_cell: "892a1072b59ffff" }), "invalid_cell"); // res 9, not 12
  assertEquals(bad({ day: "2026-02-30" }), "invalid_day");
  assertEquals(bad({ day: "2026-10-11" }), "invalid_day"); // more than one day ahead
  assertEquals(bad({ day: "2026-03-01" }), "invalid_day"); // older than 180 days
  assertEquals(bad({ median_ft: Number.NaN }), "invalid_value");
  assertEquals(bad({ median_ft: "3" }), "invalid_value");
  assertEquals(bad({ p10_ft: 5000 }), "invalid_value");
  assertEquals(bad({ n: 0 }), "invalid_value");
  assertEquals(bad({ n: 1.5 }), "invalid_value");
  assertEquals(bad({ n: 86401 }), "invalid_value");
});

Deno.test("rows: required, bounded, one per cell and day", () => {
  assertEquals(code(() => parseDepthBatch({ batch_id: BATCH, rows: [] }, null, NOW)), "invalid_rows");
  assertEquals(code(() => parseDepthBatch({ batch_id: BATCH }, null, NOW)), "invalid_rows");
  assertEquals(code(() => parseDepthBatch({ batch_id: BATCH, rows: [row(), row()] }, null, NOW)), "duplicate_row");
  assertEquals(code(() => parseDepthBatch({ batch_id: BATCH, rows: ["x"] }, null, NOW)), "invalid_rows");
  const many = Array.from({ length: MAX_ROWS + 1 }, () => row());
  assertEquals(code(() => parseDepthBatch({ batch_id: BATCH, rows: many }, null, NOW)), "invalid_rows");
  assertEquals(code(() => parseDepthBatch("nope", null, NOW)), "invalid_body");
});

Deno.test("boundary days are accepted", () => {
  parseDepthBatch({ batch_id: BATCH, rows: [row({ day: "2026-10-10" })] }, null, NOW); // today + 1
  parseDepthBatch({ batch_id: BATCH, rows: [row({ day: "2026-04-12" })] }, null, NOW); // today - 180
});
