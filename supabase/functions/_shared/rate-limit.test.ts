import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkRateLimit, enforceRateLimit, RATE_LIMITS, slidingWindowDecision } from "./rate-limit.ts";
import { dbError, mockDb } from "./testing.ts";

Deno.test("limits match docs/AGENT-PLAN.md", () => {
  assertEquals(RATE_LIMITS.ping, { max: 30, windowSeconds: 3600 });
  assertEquals(RATE_LIMITS.vote, { max: 60, windowSeconds: 3600 });
  assertEquals(RATE_LIMITS.message, { max: 10, windowSeconds: 60 });
  assertEquals(RATE_LIMITS.depth_batch, { max: 1, windowSeconds: 900 });
});

Deno.test("30 pings/hour: the 31st is refused", () => {
  const now = 1_000_000_000;
  const events = Array.from({ length: 30 }, (_, i) => now - i * 60_000); // 30 pings in the last 30 min
  const d = slidingWindowDecision(events, now, 30, 3600);
  assertEquals(d.allowed, false);
  assertEquals(d.used, 30);
  assert(d.retry_after_s > 0 && d.retry_after_s <= 3600);
  assertEquals(slidingWindowDecision(events.slice(1), now, 30, 3600).allowed, true); // 29 used -> 30th ok
});

Deno.test("window slides: events older than the window do not count", () => {
  const now = 10_000_000;
  const events = Array.from({ length: 30 }, () => now - 3_601_000);
  assertEquals(slidingWindowDecision(events, now, 30, 3600).allowed, true);
  assertEquals(slidingWindowDecision(events, now, 30, 3600).used, 0);
});

Deno.test("10 messages/minute and retry-after points at the oldest event leaving the window", () => {
  const now = 5_000_000;
  const events = [now - 59_000, ...Array.from({ length: 9 }, () => now - 1000)];
  const d = slidingWindowDecision(events, now, 10, 60);
  assertEquals(d.allowed, false);
  assertEquals(d.retry_after_s, 1); // oldest is 59 s old: leaves the 60 s window in 1 s
});

Deno.test("1 depth batch / 15 min", () => {
  const now = 2_000_000;
  assertEquals(slidingWindowDecision([now - 14 * 60_000], now, 1, 900).allowed, false);
  assertEquals(slidingWindowDecision([now - 15 * 60_000], now, 1, 900).allowed, true);
});

Deno.test("checkRateLimit unwraps a row or a single-element array from rpc", async () => {
  const row = { allowed: true, used: 0, max_allowed: 1, retry_after_s: 0 };
  assertEquals(await checkRateLimit(mockDb({ rpc: { rate_limit_status: () => row } }), "u", "depth_batch"), row);
  assertEquals(await checkRateLimit(mockDb({ rpc: { rate_limit_status: () => [row] } }), "u", "depth_batch"), row);
});

Deno.test("enforceRateLimit: null when allowed, 429 + Retry-After when not", async () => {
  const ok = mockDb({
    rpc: { rate_limit_status: () => ({ allowed: true, used: 0, max_allowed: 1, retry_after_s: 0 }) },
  });
  assertEquals(await enforceRateLimit(ok, "u", "depth_batch"), null);

  const no = mockDb({
    rpc: { rate_limit_status: () => ({ allowed: false, used: 1, max_allowed: 1, retry_after_s: 421 }) },
  });
  const res = await enforceRateLimit(no, "u", "depth_batch");
  assert(res);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "421");
  assertEquals((await res.json()).error, "rate_limited");
  assertEquals(no.calls[0].args, { p_user: "u", p_bucket: "depth_batch" });
});

Deno.test("a database failure is not swallowed as 'allowed'", async () => {
  const db = mockDb({ rpc: { rate_limit_status: () => dbError("XX000", "boom") } });
  let threw = false;
  try {
    await enforceRateLimit(db, "u", "depth_batch");
  } catch {
    threw = true;
  }
  assert(threw);
});
