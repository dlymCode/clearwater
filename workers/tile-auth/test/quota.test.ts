import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeQuota, quotaKey, secondsUntilUtcMidnight } from "../src/quota.ts";
import { FakeKv } from "./helpers.ts";

const T = new Date("2026-10-09T10:00:00Z");

test("charges until the daily limit, then refuses without recording", async () => {
  const kv = new FakeKv();
  let r = await consumeQuota(kv, "U1", T, 1000, 3000);
  assert.deepEqual([r.allowed, r.usedMb, r.remainingMb], [true, 1000, 2000]);
  r = await consumeQuota(kv, "U1", T, 2000, 3000);
  assert.deepEqual([r.allowed, r.usedMb, r.remainingMb], [true, 3000, 0]);
  r = await consumeQuota(kv, "U1", T, 1, 3000);
  assert.equal(r.allowed, false);
  assert.equal(r.usedMb, 3000);
  assert.equal(kv.puts.length, 2, "a refused charge must not write");
});

test("an over-limit single charge is refused whole (all-or-nothing)", async () => {
  const kv = new FakeKv();
  await consumeQuota(kv, "u1", T, 2500, 3000);
  const r = await consumeQuota(kv, "u1", T, 600, 3000);
  assert.equal(r.allowed, false);
  assert.equal(kv.store.get(quotaKey("u1", T)), "2500");
});

test("accounts are independent and user ids are case-insensitive", async () => {
  const kv = new FakeKv();
  await consumeQuota(kv, "AAAA", T, 3000, 3000);
  assert.equal((await consumeQuota(kv, "bbbb", T, 10, 3000)).allowed, true);
  assert.equal((await consumeQuota(kv, "aaaa", T, 10, 3000)).allowed, false);
});

test("the counter resets on the next UTC day", async () => {
  const kv = new FakeKv();
  await consumeQuota(kv, "u1", T, 3000, 3000);
  assert.equal((await consumeQuota(kv, "u1", new Date("2026-10-10T00:00:01Z"), 100, 3000)).allowed, true);
  assert.notEqual(quotaKey("u1", T), quotaKey("u1", new Date("2026-10-10T00:00:00Z")));
});

test("resets-in seconds and KV ttl are sane", async () => {
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-09T23:59:00Z")), 60);
  assert.equal(secondsUntilUtcMidnight(new Date("2026-10-09T00:00:00Z")), 86400);
  const kv = new FakeKv();
  const r = await consumeQuota(kv, "u1", new Date("2026-10-09T23:59:30Z"), 1, 10);
  assert.equal(r.resetsInSeconds, 30);
  assert.ok((kv.puts[0].ttl ?? 0) >= 60, "KV rejects ttl < 60");
});

test("a corrupt stored value is treated as zero rather than locking the user out", async () => {
  const kv = new FakeKv();
  kv.store.set(quotaKey("u1", T), "not-a-number");
  assert.equal((await consumeQuota(kv, "u1", T, 5, 10)).allowed, true);
});

test("B5: 50 parallel requests on one isolate cannot overshoot the limit (per-user lock + read-back)", async () => {
  const kv = new FakeKv(2); // every KV call takes 2 ms, so the requests genuinely interleave
  const results = await Promise.all(Array.from({ length: 50 }, () => consumeQuota(kv, "racer", T, 100, 1000)));
  assert.equal(results.filter((r) => r.allowed).length, 10, "exactly limit / cost requests pass");
  assert.equal(kv.store.get(quotaKey("racer", T)), "1000");
});

test("B5: the lock is per account: one user's burst does not serialise another's", async () => {
  const kv = new FakeKv(2);
  const [a, b] = await Promise.all([
    Promise.all(Array.from({ length: 20 }, () => consumeQuota(kv, "aaa", T, 100, 500))),
    Promise.all(Array.from({ length: 20 }, () => consumeQuota(kv, "bbb", T, 100, 500))),
  ]);
  assert.equal(a.filter((r) => r.allowed).length, 5);
  assert.equal(b.filter((r) => r.allowed).length, 5);
});

test("B5: write-then-check - if a write from elsewhere landed in between, the overshoot is detected and undone", async () => {
  const kv = new FakeKv();
  // another isolate bumps the counter between our write and our read-back
  const realGet = kv.get.bind(kv);
  let reads = 0;
  kv.get = async (k: string) => {
    reads++;
    if (reads === 2) kv.store.set(k, "1050"); // concurrent writers pushed it past the limit
    return realGet(k);
  };
  const r = await consumeQuota(kv, "u9", T, 100, 1000);
  assert.equal(r.allowed, false, "refused");
  assert.equal(kv.store.get(quotaKey("u9", T)), "950", "our own 100 MB charge was rolled back");
});

test("a non-finite cost is refused rather than poisoning the counter", async () => {
  const kv = new FakeKv();
  assert.equal((await consumeQuota(kv, "u1", T, Number.NaN, 1000)).allowed, false);
  assert.equal((await consumeQuota(kv, "u1", T, Number.POSITIVE_INFINITY, 1000)).allowed, false);
  assert.equal(kv.puts.length, 0);
});
