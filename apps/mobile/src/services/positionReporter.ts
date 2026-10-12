/**
 * Last-known position reporter: rounded to 100 m client-side (defense in depth), at most every 5 min, foreground only
 * (lib/positionReport.ts). Sent through the `report_position(p_lat, p_lon)` RPC: the server snaps to 100 m again and
 * enforces the 5-minute window SILENTLY (no 429 storm). Uses getSession() (local, no network round trip).
 */
import { AppState } from 'react-native';
import { decidePositionReport } from '../lib/positionReport';
import { useAppStore } from '../state/store';
import { kvGet, kvSet } from './db';
import { getSupabase } from './supabase';

const LAST_REPORT_KEY = 'position.lastReportMs';
let lastReportMs: number | null = null;
let lastAttemptMs: number | null = null;
let inFlight = false;
/** Position the server refused as out of range; we stay quiet until the boat moves (lib/positionReport). */
let rejectedAt: { lat: number; lon: number } | null = null;
let loaded = false;

/** Call on every GPS fix (cheap: the policy short-circuits). */
export async function maybeReportPosition(): Promise<void> {
  if (!loaded) {
    loaded = true;
    lastReportMs = await kvGet<number>(LAST_REPORT_KEY); // survives relaunch: no report burst on every app start
  }
  const { settings, gps } = useAppStore.getState();
  const decision = decidePositionReport(
    { lastReportMs, lastAttemptMs, inFlight, rejectedAt },
    {
      nowMs: Date.now(),
      sharingEnabled: settings.sharePosition,
      appForeground: AppState.currentState === 'active',
      position: gps ? { lat: gps.lat, lon: gps.lon } : null,
    },
  );
  if (!decision.report) return;
  inFlight = true;
  lastAttemptMs = Date.now();
  try {
    const sb = getSupabase();
    const { data } = await sb.auth.getSession();
    if (!data.session) return;
    const { error } = await sb.rpc('report_position', { p_lat: decision.position.lat, p_lon: decision.position.lon });
    if (!error) {
      lastReportMs = Date.now();
      rejectedAt = null;
      await kvSet(LAST_REPORT_KEY, lastReportMs);
    } else if (error.code === 'PT400' || /position_out_of_range/.test(error.message)) {
      // Permanent for this position: drop the report ("outside coverage") instead of retrying forever. It resumes when
      // the boat has moved (decidePositionReport clears the flag implicitly).
      rejectedAt = decision.position;
    } else if (/account_revoked/.test(error.message)) {
      useAppStore.getState().setAccountRevoked(true);
    }
  } finally {
    inFlight = false;
  }
}
