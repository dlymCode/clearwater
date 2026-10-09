/**
 * Ping score + decay. MUST match the SQL function digit-for-digit (docs/AGENT-PLAN.md):
 *
 *   S = R_a * (1 + SUM_i R_i * v_i * w(d_i)) * exp(-lambda * (t_now - t_last))
 *
 *   lambda = ln(2) / 24 h
 *   w      = the SERVER-PRECOMPUTED weight in {1.0, 0.5, 0} exposed by ping_votes_feed (1.0 within 200 m, 0.5 within
 *            500 m, else 0). The feed does not expose voter ids or distances (trilateration risk), so the client
 *            never recomputes w from a distance. distanceWeight() below exists only for the vote-button hint.
 *   t0     = least(created_at, coalesce(received_at, created_at))   (anti-gaming: a future-dated ping cannot stay solid)
 *   t_last = max(t0, latest confirm)   (confirm = vote of +1)
 *
 * Render: S < 0.25 hidden, S < 0.5 faded, S <= 1.5 normal, S > 1.5 solid (+ confirm count).
 *
 * Parity with supabase public.score_ping (migration 4), operation for operation:
 *  - lambda = ln(2) / 86400 per SECOND; dt = max(0, seconds between now and t_last) as a double;
 *  - votes are summed in created_at ascending order (voter_id is not available client-side; ties differ from SQL at
 *    most by floating-point associativity, well inside the 1e-12 tolerance), each term (rep * vote) * w;
 *  - votes created after `now` are ignored;
 *  - no clamp on S itself (net-disputed can go <= 0 => hidden).
 */
import {
  SCORE_FADED_BELOW,
  SCORE_HIDDEN_BELOW,
  SCORE_LAMBDA_PER_SECOND,
  SCORE_SOLID_ABOVE,
  VOTE_WEIGHT_FAR,
  VOTE_WEIGHT_FAR_M,
  VOTE_WEIGHT_NEAR,
  VOTE_WEIGHT_NEAR_M,
  CONFIRM_ELIGIBILITY_M,
} from '@clearwater/shared';

export type RenderState = 'hidden' | 'faded' | 'normal' | 'solid';

export type Instant = string | number | Date;

export interface ScoreVote {
  /** +1 confirm, -1 dispute. */
  vote: 1 | -1;
  voterReputation: number;
  /** Server-precomputed w(d) from ping_votes_feed. */
  weight: number;
  createdAt: Instant;
}

export interface ScoreInput {
  authorReputation: number;
  createdAt: Instant;
  /** Server receipt time (ping_feed.received_at). Omit for locally created, unsynced pings (t0 = created_at). */
  receivedAt?: Instant | null;
  votes: readonly ScoreVote[];
  now: Instant;
}


export function toMs(t: Instant): number {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/** w(d): 1.0 within 200 m, 0.5 within 500 m, else 0. Boundaries are inclusive ("within"). */
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

/** t_last = max(t0, latest confirm). Returns epoch ms. */
export function lastActivityMs(t0: Instant, votes: readonly ScoreVote[]): number {
  let t = toMs(t0);
  for (const v of votes) {
    if (v.vote === 1) {
      const vt = toMs(v.createdAt);
      if (vt > t) t = vt;
    }
  }
  return t;
}

/** exp(-lambda * age): 1 at age 0, 0.5 at 24 h, 0.25 at 48 h. Age in HOURS (convenience for UI/tests). */
export function decayFactor(ageHours: number): number {
  return Math.exp(-SCORE_LAMBDA_PER_SECOND * Math.max(0, ageHours) * 3600);
}

export function pingScore(input: ScoreInput): number {
  const nowMs = toMs(input.now);
  const votes = input.votes
    .filter((v) => toMs(v.createdAt) <= nowMs)
    .slice()
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt)); // stable: ties keep feed order
  const tLast = lastActivityMs(decayOriginMs(input.createdAt, input.receivedAt), votes);
  const dtSeconds = Math.max(0, (nowMs - tLast) / 1000);
  let sum = 0;
  for (const v of votes) sum += v.voterReputation * v.vote * v.weight;
  return input.authorReputation * (1 + sum) * Math.exp(-SCORE_LAMBDA_PER_SECOND * dtSeconds);
}

export function renderState(score: number): RenderState {
  if (score < SCORE_HIDDEN_BELOW) return 'hidden';
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

export function summarizePing(input: ScoreInput): PingSummary {
  const score = pingScore(input);
  let confirms = 0;
  let disputes = 0;
  for (const v of input.votes) {
    if (v.vote === 1) confirms++;
    else disputes++;
  }
  return { score, state: renderState(score), confirms, disputes };
}

/**
 * When reputations are unavailable (feed row without author_reputation / voter_reputation), NEVER assume 1.0.
 * Use the server's cached score (refreshed on every vote, `updated_at`) decayed to `now`:
 *   S ~= cached * exp(-lambda * (now - updated_at))
 * This is exact for an unvoted ping and a close lower bound otherwise (decay since the last server refresh).
 */
export function fallbackScore(cachedScore: number | null | undefined, updatedAt: Instant | null | undefined, now: Instant): number | null {
  if (cachedScore === null || cachedScore === undefined || !Number.isFinite(cachedScore)) return null;
  if (updatedAt === null || updatedAt === undefined) return null;
  const t = toMs(updatedAt);
  if (!Number.isFinite(t)) return null;
  const dtSeconds = Math.max(0, (toMs(now) - t) / 1000);
  return cachedScore * Math.exp(-SCORE_LAMBDA_PER_SECOND * dtSeconds);
}
