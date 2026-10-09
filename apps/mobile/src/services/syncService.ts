/**
 * Sync worker: flush the outbox and pull inbound rows. Runs on app foreground, on network change and every
 * 15 min in the background (TODO: register the background task, see README). Inbound pulls use inclusive
 * `updated_at >= cursor` + upsert-by-id (lib/syncCursor.ts).
 */
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { SYNC_TABLES, type SyncTable } from '@clearwater/shared';
import { Outbox } from '../lib/outbox';
import { advanceCursor, planSync, type SyncCursors } from '../lib/syncCursor';
import { REFERENCE_TIDE_STATIONS } from '../lib/stations';
import { parseTilesIndex, type ParseResult } from '../lib/tilesIndex';
import { useAppStore } from '../state/store';
import { CONFIG, isBackendConfigured } from './config';
import { getDb, kvGet, kvSet } from './db';
import { SqliteOutboxStore } from './outboxSqlite';
import { getSupabase, sendOutboxBatch, signTileUrl } from './supabase';
import { refreshTides, tideFetchedAt } from './tideService';

export const outbox = new Outbox(new SqliteOutboxStore());

const CURSOR_KEY = 'sync.cursors';
const PING_WINDOW_MS = 48 * 3_600_000;

let running = false;

async function pullTable(table: SyncTable, cursors: SyncCursors): Promise<void> {
  const sb = getSupabase();
  const gte = cursors[table] ?? new Date(Date.now() - PING_WINDOW_MS).toISOString();
  const { data, error } = await sb.from(table).select('*').gte('updated_at', gte).order('updated_at', { ascending: true }).limit(1000);
  if (error || !data) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const r of data as Array<Record<string, unknown> & { id?: string; updated_at?: string }>) {
      const json = JSON.stringify(r);
      if (table === 'pings') {
        await db.runAsync('INSERT INTO pings (id, json, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at', String(r.id), json, String(r.created_at), r.updated_at ?? null);
      } else if (table === 'ping_votes') {
        await db.runAsync('INSERT INTO ping_votes (ping_id, voter_id, json, updated_at) VALUES (?,?,?,?) ON CONFLICT(ping_id, voter_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at', String(r.ping_id), String(r.voter_id), json, r.updated_at ?? null);
      } else {
        await db.runAsync('INSERT INTO messages (id, group_id, json, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', String(r.id), String(r.group_id), json, String(r.created_at));
      }
    }
  });
  const next = advanceCursor(cursors[table], data as Array<{ updated_at?: string | null }>);
  if (next) cursors[table] = next;
  useAppStore.getState().bumpData();
}

/** One full sync pass. Safe to call concurrently (second call is a no-op). */
export async function syncNow(): Promise<{ flushed: number; indexIssues: string[] }> {
  if (running || !isBackendConfigured()) return { flushed: 0, indexIssues: [] };
  const net = await NetInfo.fetch();
  if (!net.isConnected) return { flushed: 0, indexIssues: [] };
  running = true;
  try {
    await outbox.enforceCap();
    const flush = await outbox.flush(sendOutboxBatch);
    const cursors = (await kvGet<SyncCursors>(CURSOR_KEY)) ?? {};
    for (const table of SYNC_TABLES) await pullTable(table, cursors).catch(() => undefined);
    await kvSet(CURSOR_KEY, cursors);

    const fetchedAt: Record<string, string | null> = {};
    for (const s of REFERENCE_TIDE_STATIONS) fetchedAt[s.station_id] = await tideFetchedAt(s.station_id);
    const plan = planSync({ cursors, tideFetchedAt: fetchedAt, tideStations: REFERENCE_TIDE_STATIONS.map((s) => s.station_id), nowMs: Date.now() });
    for (const id of plan.tideStationsToRefresh) await refreshTides(id).catch(() => undefined);

    const issues = await pullTilesIndex().then((r) => (r.ok ? r.issues : r.errors)).catch(() => []);
    return { flushed: flush.sent, indexIssues: issues };
  } finally {
    running = false;
  }
}

/** Fetch and cache tiles/index.json (behind the tile-auth worker). */
export async function pullTilesIndex(): Promise<ParseResult> {
  if (!CONFIG.tileAuthUrl) return { ok: false, errors: ['TILE_AUTH_URL not configured'] };
  const url = await signTileUrl('tiles/index.json');
  const res = await fetch(url);
  if (!res.ok) return { ok: false, errors: [`index.json HTTP ${res.status}`] };
  const parsed = parseTilesIndex(await res.json());
  if (parsed.ok) await kvSet('tiles.index', parsed.index);
  return parsed;
}

/** Wire foreground + connectivity triggers. Returns an unsubscribe function. */
export function startSyncTriggers(): () => void {
  const app = AppState.addEventListener('change', (s) => {
    if (s === 'active') void syncNow();
  });
  const net = NetInfo.addEventListener((state) => {
    if (state.isConnected) void syncNow();
  });
  const interval = setInterval(() => void syncNow(), 15 * 60 * 1000); // foreground cadence; background task is a TODO
  void syncNow();
  return () => {
    app.remove();
    net();
    clearInterval(interval);
  };
}
