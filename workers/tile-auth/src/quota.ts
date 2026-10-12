// Per-account daily download quota, counted in "MB signed" and stored in Workers KV.
//
// Honest limits of this design (also in the README):
//  * It meters signed URLs issued, not bytes actually transferred. A URL is valid for 24 h and supports
//    range requests, so one signing legitimately covers re-reads of the same archive.
//  * KV has no atomic increment and is eventually consistent. Within ONE Worker isolate the
//    read-modify-write is serialised per user (withUserLock) and verified by a read-back after the write,
//    so a burst that lands on a single isolate cannot overshoot. A burst spread over several isolates /
//    colos can: each of them may pass the pre-read before any write is visible, so the overshoot is
//    bounded by (number of parallel isolates x cost of one signing), not by the request count.
//    TODO: a Durable Object per account (single-threaded, strongly consistent) removes the bound
//    entirely; consumeQuota()'s contract stays the same.

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface QuotaResult {
  allowed: boolean;
  usedMb: number;
  limitMb: number;
  remainingMb: number;
  /** Seconds until the counter resets (next UTC midnight). */
  resetsInSeconds: number;
}

export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export function quotaKey(userId: string, now: Date): string {
  return `quota:${userId.toLowerCase()}:${utcDayKey(now)}`;
}

export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call with the same key has finished (per isolate). */
function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/**
 * All-or-nothing charge: if `costMb` would push the account over
 * `limitMb`, nothing is recorded and allowed is false.
 */
export function consumeQuota(
  kv: KvLike,
  userId: string,
  now: Date,
  costMb: number,
  limitMb: number,
): Promise<QuotaResult> {
  const key = quotaKey(userId, now);
  return withUserLock(key, async () => {
    const parse = (raw: string | null) => {
      const n = raw === null ? 0 : Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const used = parse(await kv.get(key));
    const reset = secondsUntilUtcMidnight(now);
    const deny = (usedMb: number): QuotaResult => ({
      allowed: false,
      usedMb,
      limitMb,
      remainingMb: Math.max(0, limitMb - usedMb),
      resetsInSeconds: reset,
    });

    // pre-check: refuse when this charge would not fit
    if (!Number.isFinite(costMb) || used + costMb > limitMb) return deny(used);

    // write first (KV requires expirationTtl >= 60; keep the key a little past midnight, the day in the
    // key makes a stale value harmless anyway) ...
    const next = used + costMb;
    const ttl = { expirationTtl: Math.max(60, reset + 3600) };
    await kv.put(key, String(next), ttl);

    // ... then check: if what we read back is over the limit, someone else's write landed in between.
    // Undo our charge on a best-effort basis and refuse.
    const seen = parse(await kv.get(key));
    if (seen > limitMb) {
      await kv.put(key, String(Math.max(0, seen - costMb)), ttl);
      return deny(Math.max(0, seen - costMb));
    }
    return { allowed: true, usedMb: next, limitMb, remainingMb: limitMb - next, resetsInSeconds: reset };
  });
}
