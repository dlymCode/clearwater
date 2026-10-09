// Per-account daily download quota, counted in "MB signed" and stored in Workers KV.
//
// Honest limits of this design (also in the README):
//  * It meters signed URLs issued, not bytes actually transferred. A URL is valid for 24 h and
//    supports range requests, so one signing legitimately covers re-reads of the same archive.
//  * KV is eventually consistent and read-modify-write is not atomic, so a burst of parallel
//    requests can overshoot the limit slightly. For a hard cap, move the counter to a Durable
//    Object; the consumeQuota() contract stays the same.

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

/**
 * Atomic-from-the-caller's-view all-or-nothing charge: if `costMb` would push the account over
 * `limitMb`, nothing is recorded and allowed is false.
 */
export async function consumeQuota(
  kv: KvLike,
  userId: string,
  now: Date,
  costMb: number,
  limitMb: number,
): Promise<QuotaResult> {
  const key = quotaKey(userId, now);
  const raw = await kv.get(key);
  const parsed = raw === null ? 0 : Number(raw);
  const used = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const reset = secondsUntilUtcMidnight(now);

  if (used + costMb > limitMb) {
    return { allowed: false, usedMb: used, limitMb, remainingMb: Math.max(0, limitMb - used), resetsInSeconds: reset };
  }
  const next = used + costMb;
  // KV requires expirationTtl >= 60. Keep the key a little past midnight; the day in the key makes
  // a stale value harmless anyway.
  await kv.put(key, String(next), { expirationTtl: Math.max(60, reset + 3600) });
  return { allowed: true, usedMb: next, limitMb, remainingMb: limitMb - next, resetsInSeconds: reset };
}
