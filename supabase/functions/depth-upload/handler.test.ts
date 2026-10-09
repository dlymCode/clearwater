import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { handleDepthUpload } from "./handler.ts";
import { authed, dbError, mockDb, req } from "../_shared/testing.ts";

const SECRET = "unit-test-only-not-a-real-secret-0123456789";
const UID = "00000000-0000-0000-0000-0000000000a1";
const NOW = () => new Date("2026-10-09T12:00:00Z");
const BATCH = "11111111-2222-4333-8444-555555555555";
const ROW = { h3_cell: "8c2a1072b59ffff", day: "2026-10-08", median_ft: -12.5, p10_ft: -14, n: 40 };

const ok = {
  depth_batch_owner: () => null,
  rate_limit_status: () => ({ allowed: true, used: 0, max_allowed: 1, retry_after_s: 0 }),
  get_salt_epoch: () => 0,
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
  const { db, call } = setup({ depth_batch_owner: () => UID });
  const res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).duplicate, true);
  assertEquals(db.calls.map((c) => c.fn), ["depth_batch_owner"]);
});

Deno.test("409 when the batch UUID belongs to someone else", async () => {
  const { call } = setup({ depth_batch_owner: () => "00000000-0000-0000-0000-0000000000a2" });
  assertEquals((await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }))).status, 409);
});

Deno.test("429 when a second batch arrives inside 15 minutes", async () => {
  const { db, call } = setup({
    rate_limit_status: () => ({ allowed: false, used: 1, max_allowed: 1, retry_after_s: 600 }),
  });
  const res = await call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "600");
  assertEquals(db.calls.filter((c) => c.fn === "ingest_depth_batch").length, 0);
});

Deno.test("a salt-epoch change produces different hashes", async () => {
  const a = setup();
  await a.call(authed("POST", "tok", { batch_id: BATCH, rows: [ROW] }));
  const b = setup({ get_salt_epoch: () => 1 });
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
