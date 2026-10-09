/**
 * Last-known-position reporter policy (secrecy): rounded to 100 m, at most every 5 minutes,
 * foreground only, and only when the user has position sharing enabled. Server keeps it 24 h.
 */
import { LAST_POSITION } from '@clearwater/shared';
import { isValidLatLon, roundPosition, type LatLon } from './geo';

/** After a failed attempt wait this long before trying again (no request storm against the 5-min window). */
export const REPORT_RETRY_BACKOFF_MS = 60_000;

export interface ReportState {
  /** Last SUCCESSFUL report (persisted across launches). */
  lastReportMs: number | null;
  /** Last attempt, successful or not. */
  lastAttemptMs?: number | null;
  inFlight?: boolean;
}

export interface ReportContext {
  nowMs: number;
  sharingEnabled: boolean;
  appForeground: boolean;
  position: LatLon | null;
}

export type ReportDecision =
  | { report: false; reason: 'sharing_off' | 'background' | 'no_position' | 'too_soon' | 'in_flight' | 'backoff' }
  | { report: true; position: LatLon };

export function decidePositionReport(state: ReportState, ctx: ReportContext): ReportDecision {
  if (state.inFlight) return { report: false, reason: 'in_flight' };
  if (!ctx.sharingEnabled) return { report: false, reason: 'sharing_off' };
  if (!ctx.appForeground) return { report: false, reason: 'background' };
  if (!ctx.position || !isValidLatLon(ctx.position.lat, ctx.position.lon)) return { report: false, reason: 'no_position' };
  if (state.lastReportMs !== null && ctx.nowMs - state.lastReportMs < LAST_POSITION.MIN_INTERVAL_MS) {
    return { report: false, reason: 'too_soon' };
  }
  if (state.lastAttemptMs != null && ctx.nowMs - state.lastAttemptMs < REPORT_RETRY_BACKOFF_MS) {
    return { report: false, reason: 'backoff' };
  }
  return { report: true, position: roundPosition(ctx.position) };
}
