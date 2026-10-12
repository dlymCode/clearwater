/**
 * Last-known-position reporter policy (secrecy): rounded to 100 m, at most every 5 minutes,
 * foreground only, and only when the user has position sharing enabled. Server keeps it 24 h.
 */
import { LAST_POSITION, SALISH_SEA_BBOX } from '@clearwater/shared';
import { haversineM, isValidLatLon, roundPosition, type LatLon } from './geo';

/** After a failed attempt wait this long before trying again (no request storm against the 5-min window). */
export const REPORT_RETRY_BACKOFF_MS = 60_000;

export interface ReportState {
  /** Last SUCCESSFUL report (persisted across launches). */
  lastReportMs: number | null;
  /** Last attempt, successful or not. */
  lastAttemptMs?: number | null;
  inFlight?: boolean;
  /** Position the server refused as `position_out_of_range` (PT400). Do not retry until the boat has moved. */
  rejectedAt?: LatLon | null;
}

/** Moving this far from a rejected position counts as a new attempt (the "outside coverage" flag clears). */
export const REJECTED_RESUME_DISTANCE_M = 1000;

export function inCoverage(p: LatLon): boolean {
  const [w, s, e, n] = SALISH_SEA_BBOX;
  return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
}

export interface ReportContext {
  nowMs: number;
  sharingEnabled: boolean;
  appForeground: boolean;
  position: LatLon | null;
}

export type ReportDecision =
  | { report: false; reason: 'sharing_off' | 'background' | 'no_position' | 'too_soon' | 'in_flight' | 'backoff' | 'outside_coverage' }
  | { report: true; position: LatLon };

export function decidePositionReport(state: ReportState, ctx: ReportContext): ReportDecision {
  if (state.inFlight) return { report: false, reason: 'in_flight' };
  if (!ctx.sharingEnabled) return { report: false, reason: 'sharing_off' };
  if (!ctx.appForeground) return { report: false, reason: 'background' };
  if (!ctx.position || !isValidLatLon(ctx.position.lat, ctx.position.lon)) return { report: false, reason: 'no_position' };
  // Outside the Salish Sea box the server answers PT400 position_out_of_range every time: do not even ask, and after a
  // server-side rejection stay quiet until the boat has moved (the flag clears on the next in-coverage fix).
  if (!inCoverage(ctx.position)) return { report: false, reason: 'outside_coverage' };
  if (state.rejectedAt && haversineM(state.rejectedAt, ctx.position) < REJECTED_RESUME_DISTANCE_M) {
    return { report: false, reason: 'outside_coverage' };
  }
  if (state.lastReportMs !== null && ctx.nowMs - state.lastReportMs < LAST_POSITION.MIN_INTERVAL_MS) {
    return { report: false, reason: 'too_soon' };
  }
  if (state.lastAttemptMs != null && ctx.nowMs - state.lastAttemptMs < REPORT_RETRY_BACKOFF_MS) {
    return { report: false, reason: 'backoff' };
  }
  return { report: true, position: roundPosition(ctx.position) };
}
