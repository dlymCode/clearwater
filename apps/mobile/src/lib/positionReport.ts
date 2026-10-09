/**
 * Last-known-position reporter policy (secrecy): rounded to 100 m, at most every 5 minutes,
 * foreground only, and only when the user has position sharing enabled. Server keeps it 24 h.
 */
import { LAST_POSITION } from '@clearwater/shared';
import { isValidLatLon, roundPosition, type LatLon } from './geo';

export interface ReportState {
  lastReportMs: number | null;
}

export interface ReportContext {
  nowMs: number;
  sharingEnabled: boolean;
  appForeground: boolean;
  position: LatLon | null;
}

export type ReportDecision =
  | { report: false; reason: 'sharing_off' | 'background' | 'no_position' | 'too_soon' }
  | { report: true; position: LatLon };

export function decidePositionReport(state: ReportState, ctx: ReportContext): ReportDecision {
  if (!ctx.sharingEnabled) return { report: false, reason: 'sharing_off' };
  if (!ctx.appForeground) return { report: false, reason: 'background' };
  if (!ctx.position || !isValidLatLon(ctx.position.lat, ctx.position.lon)) return { report: false, reason: 'no_position' };
  if (state.lastReportMs !== null && ctx.nowMs - state.lastReportMs < LAST_POSITION.MIN_INTERVAL_MS) {
    return { report: false, reason: 'too_soon' };
  }
  return { report: true, position: roundPosition(ctx.position) };
}
