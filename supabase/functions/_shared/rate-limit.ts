// Rate-limit middleware (docs/AGENT-PLAN.md: 30 pings/h, 60 votes/h, 10 msgs/min,
// 1 depth batch / 15 min, per user -> HTTP 429).
//
// Single source of truth for the counting is SQL: public.rate_limit_status(user, bucket), which the
// BEFORE INSERT triggers on pings / ping_votes / messages also call, so direct PostgREST writes are
// limited identically. Edge functions use this module for the buckets they front (depth_batch).
import { type Db, rpc } from "./db.ts";
import { json } from "./http.ts";

export const RATE_LIMITS = {
  ping: { max: 30, windowSeconds: 3600 },
  vote: { max: 60, windowSeconds: 3600 },
  message: { max: 10, windowSeconds: 60 },
  depth_batch: { max: 1, windowSeconds: 900 },
} as const;

export type Bucket = keyof typeof RATE_LIMITS;

export interface RateLimitStatus {
  allowed: boolean;
  used: number;
  max_allowed: number;
  retry_after_s: number;
}

/**
 * Pure sliding-window decision, identical in semantics to the SQL function: count events with
 * timestamp > now - window; allowed while count < max; retry-after is when the oldest in-window
 * event leaves the window. Used by tests as an executable specification of the SQL behaviour.
 */
export function slidingWindowDecision(
  eventTimesMs: readonly number[],
  nowMs: number,
  max: number,
  windowSeconds: number,
): RateLimitStatus {
  const windowMs = windowSeconds * 1000;
  const inWindow = eventTimesMs.filter((t) => t > nowMs - windowMs);
  const allowed = inWindow.length < max;
  const oldest = inWindow.length ? Math.min(...inWindow) : null;
  const retry = allowed || oldest === null ? 0 : Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
  return { allowed, used: inWindow.length, max_allowed: max, retry_after_s: retry };
}

export async function checkRateLimit(db: Db, userId: string, bucket: Bucket): Promise<RateLimitStatus> {
  const data = await rpc<RateLimitStatus | RateLimitStatus[]>(db, "rate_limit_status", {
    p_user: userId,
    p_bucket: bucket,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.allowed !== "boolean") {
    throw new Error("rate_limit_status returned an unexpected shape");
  }
  return row;
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

/** Returns a 429 Response when the user is over the limit, otherwise null. */
export async function enforceRateLimit(db: Db, userId: string, bucket: Bucket): Promise<Response | null> {
  const status = await checkRateLimit(db, userId, bucket);
  return status.allowed ? null : rateLimitResponse(status, bucket);
}
