// Rate-limit middleware (docs/AGENT-PLAN.md: 30 pings/h, 60 votes/h, 10 msgs/min,
// 1 depth batch / 15 min, per user -> HTTP 429).
//
// SQL is the single authority: the append-only public.rate_events ledger with rate_limit_consume()
// (check + record, serialised per user+bucket) and rate_limit_refund(). The BEFORE INSERT triggers on
// pings / ping_votes / messages / groups call the same functions, so direct PostgREST writes are
// limited identically; limits and windows live in rate_limit_params(). This module only fronts the
// bucket that goes through an edge function (depth_batch) and turns a refusal into an HTTP 429.
import { type Db, rpc } from "./db.ts";
import { json } from "./http.ts";

export type Bucket = "depth_batch";

export interface RateLimitStatus {
  allowed: boolean;
  used: number;
  max_allowed: number;
  retry_after_s: number;
}

/** Check and, when allowed, record one event atomically (race-free per user and bucket). */
export async function consumeRateLimit(db: Db, userId: string, bucket: Bucket): Promise<RateLimitStatus> {
  const fn = "rate_limit_consume";
  const data = await rpc<RateLimitStatus | RateLimitStatus[]>(db, fn, {
    p_user: userId,
    p_bucket: bucket,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== "boolean") {
    throw new Error(`${fn} returned an unexpected shape`);
  }
  return row;
}

/** Give the newest event back (the operation failed after consuming its slot). */
export async function refundRateLimit(db: Db, userId: string, bucket: Bucket): Promise<void> {
  await rpc(db, "rate_limit_refund", { p_user: userId, p_bucket: bucket });
}

export function rateLimitResponse(status: RateLimitStatus, bucket: Bucket): Response {
  return json(
    429,
    {
      error: "rate_limited",
      message: `Too many ${bucket} requests. Retry in ${status.retry_after_s}s.`,
      retry_after_s: status.retry_after_s,
    },
    { "retry-after": String(Math.max(1, status.retry_after_s)) },
  );
}

/** Consumes one event; returns a 429 Response when the user is over the limit, otherwise null. */
export async function enforceRateLimit(db: Db, userId: string, bucket: Bucket): Promise<Response | null> {
  const status = await consumeRateLimit(db, userId, bucket);
  return status.allowed ? null : rateLimitResponse(status, bucket);
}
