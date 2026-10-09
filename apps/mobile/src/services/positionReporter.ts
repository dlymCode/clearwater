/** Last-known position reporter: rounded to 100 m, <= every 5 min, foreground only (lib/positionReport.ts). */
import { AppState } from 'react-native';
import { decidePositionReport } from '../lib/positionReport';
import { useAppStore } from '../state/store';
import { getSupabase } from './supabase';

let lastReportMs: number | null = null;

/** Call on every GPS fix (cheap: the policy short-circuits). */
export async function maybeReportPosition(): Promise<void> {
  const { settings, gps } = useAppStore.getState();
  const decision = decidePositionReport(
    { lastReportMs },
    {
      nowMs: Date.now(),
      sharingEnabled: settings.sharePosition,
      appForeground: AppState.currentState === 'active',
      position: gps ? { lat: gps.lat, lon: gps.lon } : null,
    },
  );
  if (!decision.report) return;
  const sb = getSupabase();
  const { data } = await sb.auth.getUser();
  if (!data.user) return;
  const { position } = decision;
  // The server snaps to the 100 m grid again and throttles (tg_last_positions_before_write); we send already-rounded values.
  const { error } = await sb
    .from('last_positions')
    .upsert({ user_id: data.user.id, geom: `SRID=4326;POINT(${position.lon} ${position.lat})` }, { onConflict: 'user_id' });
  if (!error) lastReportMs = Date.now();
}
