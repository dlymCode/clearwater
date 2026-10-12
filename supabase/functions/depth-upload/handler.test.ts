import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { latLngToCell } from "npm:h3-js@4.1.0";
import { handleDepthUpload, shuffle } from "./handler.ts";
import { dayRange, uploaderHash } from "../_shared/hmac.ts";
import { authed, dbError, mockDb, req } from "../_shared/testing.ts";

const SECRET = "unit-test-only-not-a-real-secret-0123456789";
const UID = "00000000-0000-0000-0000-0000000000a1";
const NOW = () => new Date("2026-10-09T12:00:00Z");
const BATCH = "11111111-2222-4333-8444-555555555555";
const ROW = { h3_cell: "8c28d1c1da823ff", day: "2026-10-08", median_ft: -12.5, p10_ft: -14, n: 40 };

const EPOCH0 = [{ epoch: 0, from: "1970-01-01" }];

const ok = {
  depth_batch_lookup: () => ({ found: false, owner: null }),
  rate_limit_consume: () => ({ allowed: true, used: 0, max_allowed: 1, retry_after_s: 0 }),
  get_salt_epochs: () => EPOCH0,
  ingest_depth_batch: () => ({ duplicate: false, accepted: 0, held: 1, released: 0 }),
};

function setup(rpc: Record<string, (a: Record<string, unknown>) => unknown> = {}) {
  const db = mockDb({ users: { tok: UID }, rpc: { ...ok, ...rpc } });
  return { db, call: (r: Request) => handleDepthUpload(r, { db, secret: SECRET, now: NOW }) };
}

Deno.test("happy path: derives per-day hashes server-side and never sends the uid inside the rows", async () => {
  const { db, call } = setup();
  const res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.duplicate, false);
  assertEquals(body.rows, 1);
  assertFalse("held" in body, "response must not reveal which rows were held");
  assertFalse("accepted" in body);

  const ingest = db.calls.find((c) => c.fn === "ingest_depth_batch")!;
  assertEquals(ingest.args.p_batch_id, BATCH);
  assertEquals(ingest.args.p_user_id, UID);
  const rows = ingest.args.p_rows as Array<Record<string, unknown>>;
  assertEquals(Object.keys(rows[0]).sort(), ["day", "h3_cell", "median_ft", "n", "p10_ft", "uploader_hash"]);
  // reference value for (SECRET, UID, 2026-10-08, epoch 0) is verified in hmac.test.ts by construction
  assert(/^[0-9a-f]{64}$/.test(rows[0].uploader_hash as string));
  assertFalse(JSON.stringify(rows).includes(UID), "uid must not appear in the stored rows");
  const self = ingest.args.p_self_hashes as string[];
  assert(self.includes(rows[0].uploader_hash as string));
  assertEquals(self.length, 181); // 2026-10-08 +/- 90 days, inclusive
});

Deno.test("401 without a user token; the service-role key is not a user token", async () => {
  const { call } = setup();
  assertEquals((await call(req("POST", { batch_id: BATCH, rows: [ROW] }))).status, 401);
  assertEquals((await call(authed("POST", "service-role-key", { batch_id: BATCH, rows: [ROW] }))).status, 401);
});

Deno.test("405 for non-POST", async () => {
  const { call } = setup();
  const res = await call(authed("GET", "tok"));
  assertEquals(res.status, 405);
});

Deno.test("400 for payloads carrying a uid or a sub-day timestamp", async () => {
  const { db, call } = setup();
  let res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [{ ...ROW, user_id: UID }] }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "identifying_field");
  res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [{ ...ROW, day: "2026-10-08T14:03:22Z" }] }));
  assertEquals((await res.json()).error, "timestamp_too_fine");
  res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [{ ...ROW, recorded_at: 1760000000 }] }));
  assertEquals((await res.json()).error, "timestamp_too_fine");
  assertEquals(db.calls.filter((c) => c.fn === "ingest_depth_batch").length, 0);
});

Deno.test("400 for invalid JSON, 413 for an oversized body", async () => {
  const { call } = setup();
  assertEquals((await call(authed("POST", "tok", "{not json"))).status, 400);
  const big = "x".repeat(1_000_001);
  assertEquals((await call(authed("POST", "tok", big))).status, 413);
});

Deno.test("idempotent: a replayed batch UUID answers 200 duplicate without rate limiting or ingesting", async () => {
  const { db, call } = setup({ depth_batch_lookup: () => ({ found: true, owner: UID }) });
  const res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).duplicate, true);
  assertEquals(db.calls.map((c) => c.fn), ["depth_batch_lookup"]);
});

Deno.test("409 when the batch UUID belongs to someone else", async () => {
  const { call } = setup({
    depth_batch_lookup: () => ({ found: true, owner: "00000000-0000-0000-0000-0000000000a2" }),
  });
  assertEquals((await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }))).status, 409);
});

Deno.test("429 when a second batch arrives inside 15 minutes", async () => {
  const { db, call } = setup({
    rate_limit_consume: () => ({ allowed: false, used: 1, max_allowed: 1, retry_after_s: 600 }),
  });
  const res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "600");
  assertEquals(db.calls.filter((c) => c.fn === "ingest_depth_batch").length, 0);
});

Deno.test("a salt-epoch change produces different hashes", async () => {
  const a = setup();
  await a.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  const b = setup({ get_salt_epochs: () => [...EPOCH0, { epoch: 1, from: "2026-10-01" }] });
  await b.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  const h = (s: ReturnType<typeof setup>) =>
    (s.db.calls.find((c) => c.fn === "ingest_depth_batch")!.args.p_rows as Array<{ uploader_hash: string }>)[0]
      .uploader_hash;
  assert(h(a) !== h(b));
});

Deno.test("database errors surface as sanitized 500s; PT errors keep their status", async () => {
  const boom = setup({ ingest_depth_batch: () => dbError("XX000", "secret internal detail") });
  const res = await boom.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 500);
  assertFalse(JSON.stringify(await res.json()).includes("secret internal detail"));

  const revoked = setup({ ingest_depth_batch: () => dbError("PT403", "account_revoked") });
  assertEquals((await revoked.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }))).status, 403);
});

Deno.test("500 when HMAC_SALT_SECRET is missing or short", async () => {
  const db = mockDb({ users: { tok: UID }, rpc: ok });
  const res = await handleDepthUpload(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }), {
    db,
    secret: "short",
    now: NOW,
  });
  assertEquals(res.status, 500);
});

Deno.test("E5: self hashes are computed per epoch only for the days that epoch was active in the +-90 day window", async () => {
  const epochs = [
    { epoch: 0, from: "1970-01-01" },
    { epoch: 1, from: "2026-09-01" },
    { epoch: 2, from: "2026-10-05" },
  ];
  const a = setup();
  await a.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  const b = setup({ get_salt_epochs: () => epochs });
  await b.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  const self = (s: ReturnType<typeof setup>) =>
    s.db.calls.find((c) => c.fn === "ingest_depth_batch")!.args.p_self_hashes as string[];
  const rowHash = (s: ReturnType<typeof setup>) =>
    (s.db.calls.find((c) => c.fn === "ingest_depth_batch")!.args.p_rows as Array<{ uploader_hash: string }>)[0]
      .uploader_hash;
  assertEquals(self(a).length, 181, "one epoch: 2026-10-08 +- 90 days");

  // window 2026-07-10 .. 2027-01-06 (181 days); boundaries between epochs belong to both
  const window = dayRange("2026-07-10", "2027-01-06");
  const expected = new Set<string>([rowHash(b)]);
  for (const [i, e] of epochs.entries()) {
    const to = i + 1 < epochs.length ? epochs[i + 1].from : "9999-12-31";
    for (const d of window) if (d >= e.from && d <= to) expected.add(await uploaderHash(SECRET, UID, d, e.epoch));
  }
  assertEquals(new Set(self(b)), expected);
  assert(self(b).includes(await uploaderHash(SECRET, UID, "2026-08-01", 0)), "epoch 0 covers August");
  assertFalse(
    self(b).includes(await uploaderHash(SECRET, UID, "2026-10-07", 0)),
    "epoch 0 was no longer active on Oct 7",
  );
  assertFalse(self(b).includes(await uploaderHash(SECRET, UID, "2026-08-01", 2)), "epoch 2 did not exist in August");
  assert(self(b).includes(rowHash(b)), "the row's own (current-epoch) hash is always included");
  assert(self(b).length < 181 * 2, "cost is bounded by the window, not by the number of rotations");
});

Deno.test("E4: a failed ingest gives the rate-limit slot back, so the retry is not blocked for 15 minutes", async () => {
  const s = setup({ ingest_depth_batch: () => dbError("XX000", "transient") });
  const res = await s.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 500);
  const fns = s.db.calls.map((c) => c.fn);
  assert(fns.indexOf("rate_limit_consume") < fns.indexOf("ingest_depth_batch"));
  const refund = s.db.calls.find((c) => c.fn === "rate_limit_refund");
  assert(refund, "refund called");
  assertEquals(refund.args, { p_user: UID, p_bucket: "depth_batch" });

  const ok2 = setup();
  await ok2.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertFalse(ok2.db.calls.some((c) => c.fn === "rate_limit_refund"), "no refund on success");
});

Deno.test("S5: rows are shuffled before they reach the database", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ...ROW,
    h3_cell: latLngToCell(48.2 + i * 0.001, -122.5, 12),
  }));
  const s = setup();
  await s.call(authed("POST", "tok", { batch_id: BATCH, rows }));
  const sent = (s.db.calls.find((c) => c.fn === "ingest_depth_batch")!.args.p_rows as Array<{ h3_cell: string }>).map((
    r,
  ) => r.h3_cell);
  assertEquals([...sent].sort(), rows.map((r) => r.h3_cell).sort(), "same rows");
  assert(sent.join() !== rows.map((r) => r.h3_cell).join(), "order differs from the client's track order");
  const sh = shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
  assertEquals([...sh].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

Deno.test("S5: a replay after the ledger row was unlinked (owner null) is a duplicate, not a conflict", async () => {
  const { db, call } = setup({ depth_batch_lookup: () => ({ found: true, owner: null }) });
  const res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).duplicate, true);
  assertEquals(db.calls.length, 1 + 0, "only the lookup ran");
});
