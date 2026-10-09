/**
 * Ping score + decay. MUST match the SQL function digit-for-digit (docs/AGENT-PLAN.md):
 *
 *   S = R_a * (1 + SUM_i R_i * v_i * w(d_i)) * exp(-lambda * (t_now - t_last))
 *
 *   lambda = ln(2) / 24 h, t measured in hours
 *   w(d)   = 1.0 if d <= 200 m, 0.5 if d <= 500 m, else 0   (d = voter's distance to the ping)
 *   t_last = max(created_at, latest confirm)   (confirm = vote of +1)
 *
 * Render: S < 0.25 hidden, S < 0.5 faded, S <= 1.5 normal, S > 1.5 solid (+ confirm count).
 *
 * Parity with supabase public.score_ping (migration 4), operation for operation:
 *  - lambda = ln(2) / 86400 per SECOND; dt = max(0, seconds between now and t_last) as a double;
 *  - votes are summed in (created_at, voter_id) ascending order, each term (rep * vote) * w(d);
 *  - votes created after `now` are ignored;
 *  - a missing distance (null) has weight 0; no clamp on S itself (net-disputed can go <= 0 => hidden).
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
  /** Tie-break for the summation order (matches SQL ORDER BY created_at, voter_id). */
  voterId?: string;
  /** Distance of the voter's last-known position to the ping, metres; null = unknown. */
  voterDistM: number | null;
  createdAt: Instant;
}

export interface ScoreInput {
  authorReputation: number;
  createdAt: Instant;
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

/** t_last = max(created_at, latest confirm). Returns epoch ms. */
export function lastActivityMs(createdAt: Instant, votes: readonly ScoreVote[]): number {
  let t = toMs(createdAt);
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
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt) || (a.voterId ?? '').localeCompare(b.voterId ?? ''));
  const tLast = lastActivityMs(input.createdAt, votes);
  const dtSeconds = Math.max(0, (nowMs - tLast) / 1000);
  let sum = 0;
  for (const v of votes) sum += v.voterReputation * v.vote * distanceWeight(v.voterDistM);
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
