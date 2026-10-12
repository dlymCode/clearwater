import { assert, assertEquals } from "jsr:@std/assert@1";
import { consumeRateLimit, enforceRateLimit, rateLimitResponse, refundRateLimit } from "./rate-limit.ts";
import { dbError, mockDb } from "./testing.ts";

// The limits themselves (30 pings/h, 60 votes/h, 10 messages/min, 1 depth batch / 15 min, ...) live in SQL
// (rate_limit_params) and are covered by supabase/tests/database/23_rate_limits.test.sql. This module only
// maps the database's answer to HTTP.

const OK = { allowed: true, used: 0, max_allowed: 1, retry_after_s: 0 };
const NO = { allowed: false, used: 1, max_allowed: 1, retry_after_s: 421 };

Deno.test("consumeRateLimit unwraps a row or a single-element array from rpc", async () => {
  assertEquals(await consumeRateLimit(mockDb({ rpc: { rate_limit_consume: () => OK } }), "u", "depth_batch"), OK);
  assertEquals(await consumeRateLimit(mockDb({ rpc: { rate_limit_consume: () => [OK] } }), "u", "depth_batch"), OK);
});

Deno.test("enforceRateLimit: null when allowed, 429 + Retry-After when not", async () => {
  assertEquals(await enforceRateLimit(mockDb({ rpc: { rate_limit_consume: () => OK } }), "u", "depth_batch"), null);

  const no = mockDb({ rpc: { rate_limit_consume: () => NO } });
  const res = await enforceRateLimit(no, "u", "depth_batch");
  assert(res);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "421");
  assertEquals((await res.json()).error, "rate_limited");
  assertEquals(no.calls[0].fn, "rate_limit_consume");
  assertEquals(no.calls[0].args, { p_user: "u", p_bucket: "depth_batch" });
});

Deno.test("rateLimitResponse never advertises a zero Retry-After", () => {
  assertEquals(rateLimitResponse({ ...NO, retry_after_s: 0 }, "depth_batch").headers.get("retry-after"), "1");
});

Deno.test("refundRateLimit calls the refund RPC for the same user and bucket", async () => {
  const db = mockDb();
  await refundRateLimit(db, "u", "depth_batch");
  assertEquals(db.calls, [{ fn: "rate_limit_refund", args: { p_user: "u", p_bucket: "depth_batch" } }]);
});

Deno.test("a database failure is not swallowed as 'allowed'", async () => {
  const db = mockDb({ rpc: { rate_limit_consume: () => dbError("XX000", "boom") } });
  let threw = false;
  try {
    await enforceRateLimit(db, "u", "depth_batch");
  } catch {
    threw = true;
  }
  assert(threw);
});
