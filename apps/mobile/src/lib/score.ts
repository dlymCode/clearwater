/**
 * Ping score + decay. MUST match the SQL function public.score_ping digit-for-digit:
 *
 *   S = R_a * (1 + vote_sum) * exp(-lambda * (now - t_last))
 *
 *   vote_sum = SUM_i R_i * v_i * w_i, computed ON THE SERVER, quantized to 0.25, and exposed on ping_feed together
 *              with last_confirmed_at / confirm_count / dispute_count. Per-vote rows (reputation, weight, time) never
 *              reach the client: a per-vote feed de-anonymizes voters by joining reputations back to profiles.
 *   lambda   = ln(2) / 86400 per second (half-life 24 h)
 *   t0       = least(created_at, coalesce(received_at, created_at))   (anti-gaming: a future-dated ping cannot stay solid)
 *   t_last   = max(t0, last_confirmed_at)
 *   dt       = max(0, seconds between now and t_last) as a double (clamped; no amplification by clock skew)
 *
 * Any vote bumps pings.updated_at, so the ordinary ping cursor sync delivers vote changes. The server excludes
 * future-dated votes from the aggregates, so there is no client-side filtering of feed data.
 *
 * Render: S < 0.25 hidden, S < 0.5 faded, S <= 1.5 normal, S > 1.5 solid (+ confirm count). Unparsable => hidden.
 */
import {
  CONFIRM_ELIGIBILITY_M,
  SCORE_FADED_BELOW,
  SCORE_HIDDEN_BELOW,
  SCORE_LAMBDA_PER_SECOND,
  SCORE_SOLID_ABOVE,
  VOTE_WEIGHT_FAR,
  VOTE_WEIGHT_FAR_M,
  VOTE_WEIGHT_NEAR,
  VOTE_WEIGHT_NEAR_M,
} from '@clearwater/shared';

export type RenderState = 'hidden' | 'faded' | 'normal' | 'solid';

export type Instant = string | number | Date;

export interface ScoreInput {
  authorReputation: number;
  createdAt: Instant;
  /** Server receipt time (ping_feed.received_at). Omit for locally created, unsynced pings (t0 = created_at). */
  receivedAt?: Instant | null;
  /** Server-computed, quantized vote aggregate (ping_feed.vote_sum). 0 for a ping with no votes. */
  voteSum: number;
  /** ping_feed.last_confirmed_at, or null/absent when never confirmed. */
  lastConfirmedAt?: Instant | null;
  now: Instant;
}

export function toMs(t: Instant): number {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/**
 * Client-side distance weight, used ONLY to hint whether a vote button should be enabled; the score itself uses the
 * server's vote_sum. 1.0 within 200 m, 0.5 within 500 m, else 0 (boundaries inclusive).
 */
export function distanceWeight(distM: number | null): number {
  if (distM === null || !Number.isFinite(distM) || distM < 0) return 0;
  if (distM <= VOTE_WEIGHT_NEAR_M) return VOTE_WEIGHT_NEAR;
  if (distM <= VOTE_WEIGHT_FAR_M) return VOTE_WEIGHT_FAR;
  return 0;
}

/** FLT-2: a voter may vote only if within 500 m of the ping (last-known position, last 24 h). */
export function isVoteEligible(distM: number | null): boolean {
  return distM !== null && Number.isFinite(distM) && distM >= 0 && distM <= CONFIRM_ELIGIBILITY_M;
}

/** t0 = least(created_at, coalesce(received_at, created_at)), epoch ms. */
export function decayOriginMs(createdAt: Instant, receivedAt?: Instant | null): number {
  const c = toMs(createdAt);
  if (receivedAt === null || receivedAt === undefined) return c;
  const r = toMs(receivedAt);
  return Number.isFinite(r) ? Math.min(c, r) : c;
}

/** t_last = max(t0, last_confirmed_at). Epoch ms. */
export function lastActivityMs(t0: Instant, lastConfirmedAt?: Instant | null): number {
  const t = toMs(t0);
  if (lastConfirmedAt === null || lastConfirmedAt === undefined) return t;
  const c = toMs(lastConfirmedAt);
  return Number.isFinite(c) && c > t ? c : t;
}

/** exp(-lambda * age): 1 at age 0, 0.5 at 24 h, 0.25 at 48 h. Age in HOURS (convenience for UI/tests). */
export function decayFactor(ageHours: number): number {
  return Math.exp(-SCORE_LAMBDA_PER_SECOND * Math.max(0, ageHours) * 3600);
}

export function pingScore(input: ScoreInput): number {
  const nowMs = toMs(input.now);
  const tLast = lastActivityMs(decayOriginMs(input.createdAt, input.receivedAt), input.lastConfirmedAt);
  const dtSeconds = Math.max(0, (nowMs - tLast) / 1000);
  return input.authorReputation * (1 + input.voteSum) * Math.exp(-SCORE_LAMBDA_PER_SECOND * dtSeconds);
}

/** NaN / unparsable scores are hidden (never drawn as "solid"). */
export function renderState(score: number): RenderState {
  if (!(score >= SCORE_HIDDEN_BELOW)) return 'hidden';
  if (score < SCORE_FADED_BELOW) return 'faded';
  if (score <= SCORE_SOLID_ABOVE) return 'normal';
  return 'solid';
}

export interface PingSummary {
  score: number;
  state: RenderState;
  confirms: number;
  disputes: number;
}

/** Counts come from the server (ping_feed.confirm_count / dispute_count). */
export function summarizePing(input: ScoreInput & { confirmCount?: number; disputeCount?: number }): PingSummary {
  const score = pingScore(input);
  return { score, state: renderState(score), confirms: input.confirmCount ?? 0, disputes: input.disputeCount ?? 0 };
}

/**
 * When the author's reputation or vote_sum is unavailable, NEVER assume 1.0. Use the server's cached score
 * (refreshed on every vote, `updated_at`) decayed to `now`:  S ~= cached * exp(-lambda * (now - updated_at)).
 */
export function fallbackScore(cachedScore: number | null | undefined, updatedAt: Instant | null | undefined, now: Instant): number | null {
  if (cachedScore === null || cachedScore === undefined || !Number.isFinite(cachedScore)) return null;
  if (updatedAt === null || updatedAt === undefined) return null;
  const t = toMs(updatedAt);
  if (!Number.isFinite(t)) return null;
  const dtSeconds = Math.max(0, (toMs(now) - t) / 1000);
  return cachedScore * Math.exp(-SCORE_LAMBDA_PER_SECOND * dtSeconds);
}
