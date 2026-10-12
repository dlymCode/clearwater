/**
 * Sync worker: flush the outbox and pull inbound rows. Runs on app foreground, on network change and every
 * 15 min while foregrounded (TODO: register an OS background task, see README). Inbound pulls read ping_feed /
 * messages_feed with keyset pagination (lib/pullSync.ts) and SURFACE their errors.
 */
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { Outbox } from '../lib/outbox';
import { pullAll, type LocalSink, type RemoteReader, type Row } from '../lib/pullSync';
import { planSync, type CursorKey, type SyncCursors, type TieKeys } from '../lib/syncCursor';
import { parseTilesIndex, type ParseResult } from '../lib/tilesIndex';
import { useAppStore } from '../state/store';
import { SYNC_BACKGROUND_INTERVAL_MIN } from '@clearwater/shared';
import { CONFIG, isBackendConfigured } from './config';
import { applyRetention } from './retention';
import { kvGet, kvSet, runTx } from './db';
import { SqliteOutboxStore } from './outboxSqlite';
import { getSupabase, sendOutboxBatch, signTileUrl } from './supabase';
import { refreshTides, stationRegistry, tideFetchedAt } from './tideService';

export const outbox = new Outbox(new SqliteOutboxStore());

const CURSOR_KEY = 'sync.cursors';
const KEYS_KEY = 'sync.keys';

/** PostgREST reader over supabase-js, with keyset pagination on (cursor column, tie column). */
const reader: RemoteReader = {
  async select(relation, q) {
    let query = getSupabase().from(relation).select(READ_COLUMNS[relation] ?? '*');
    const { column: c, gte } = q;
    const tie = q.tiebreak;
    if (tie.after === null) query = query.gte(c, gte);
    else query = query.or(`${c}.gt.${gte},and(${c}.eq.${gte},${tie.column}.gt.${tie.after})`);
    if (q.eq) query = query.eq(q.eq.column, q.eq.value);
    const { data, error, status } = await query.order(c, { ascending: true }).order(tie.column, { ascending: true }).limit(q.limit);
    if (error) return { rows: [], error: `${status} ${error.message}` };
    return { rows: (data ?? []) as unknown as Row[], error: null };
  },
};

/**
 * Explicit column lists (column grants: `select *` on a restricted relation is a 42501). ping_feed and messages_feed are
 * views that expose everything the app needs; ping_votes (own votes) is limited to what is readable.
 */
const READ_COLUMNS: Record<string, string> = {
  ping_feed:
    'id,author_id,author_handle,author_reputation,group_id,type,geom,note,created_at,received_at,expires_at,score,tide_ft,anonymous,updated_at,vote_sum,last_confirmed_at,confirm_count,dispute_count',
  messages_feed: 'id,group_id,author_id,author_handle,body,ping_id,created_at,received_at',
  ping_votes: 'ping_id,vote,created_at',
};

/** SQLite sink: upsert by primary key inside one serialized transaction. */
const sink: LocalSink = {
  async upsert(table: CursorKey, rows: Row[]) {
    await runTx(async (db) => {
      for (const r of rows) {
        const json = JSON.stringify(r);
        if (table === 'pings') {
          await db.runAsync(
            'INSERT INTO pings (id, json, created_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at',
            String(r.id), json, String(r.created_at), (r.updated_at as string | undefined) ?? null,
          );
        } else if (table === 'my_votes') {
          await db.runAsync(
            'INSERT INTO my_votes (ping_id, vote, created_at) VALUES (?,?,?) ON CONFLICT(ping_id) DO UPDATE SET vote=excluded.vote, created_at=excluded.created_at',
            String(r.ping_id), Number(r.vote), String(r.created_at),
          );
        } else {
          await db.runAsync(
            'INSERT INTO messages (id, group_id, json, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
            String(r.id), String(r.group_id), json, String(r.created_at),
          );
        }
      }
    });
    useAppStore.getState().bumpData();
  },
};

export interface SyncReport {
  flushed: number;
  swallowedVotes: number;
  failedRows: number;
  pulled: Record<CursorKey, number>;
  errors: string[];
  authRequired: boolean;
}

let running = false;
let lastReport: SyncReport | null = null;
export const getLastSyncReport = (): SyncReport | null => lastReport;

/** One full sync pass. Safe to call concurrently (second call is a no-op). Errors are returned, not swallowed. */
export async function syncNow(): Promise<SyncReport | null> {
  if (running || !isBackendConfigured()) return null;
  const net = await NetInfo.fetch();
  if (!net.isConnected) return null;
  running = true;
  const errors: string[] = [];
  const report: SyncReport = { flushed: 0, swallowedVotes: 0, failedRows: 0, pulled: { pings: 0, messages: 0, my_votes: 0 }, errors, authRequired: false };
  try {
    await outbox.enforceCap();
    const flush = await outbox.flush(sendOutboxBatch);
    report.flushed = flush.sent;
    report.swallowedVotes = flush.swallowed;
    report.failedRows = flush.failed;
    if (flush.accountRevoked) {
      useAppStore.getState().setAccountRevoked(true);
      errors.push('account blocked by the server');
    }
    if (flush.authRequired) {
      // Try a silent token refresh once; if that fails the user must sign in again.
      const { error } = await getSupabase().auth.refreshSession();
      if (error) {
        report.authRequired = true;
        useAppStore.getState().setAuthRequired(true);
        errors.push(`auth: ${error.message}`);
        lastReport = report;
        return report;
      }
      const retry = await outbox.flush(sendOutboxBatch);
      report.flushed += retry.sent;
      report.swallowedVotes += retry.swallowed;
      report.failedRows += retry.failed;
    }
    useAppStore.getState().bumpData();

    const cursors = (await kvGet<SyncCursors>(CURSOR_KEY)) ?? {};
    const keys = (await kvGet<TieKeys>(KEYS_KEY)) ?? {};
    const pull = await pullAll(reader, sink, cursors, { nowMs: Date.now(), userId: useAppStore.getState().userId, keys });
    await kvSet(CURSOR_KEY, pull.cursors);
    await kvSet(KEYS_KEY, pull.keys);
    report.pulled = pull.pulled;
    errors.push(...pull.errors);
    if (pull.errors.some((e) => /\b401\b|JWT/i.test(e))) {
      report.authRequired = true;
      useAppStore.getState().setAuthRequired(true);
    }

    const registry = await stationRegistry();
    const fetchedAt: Record<string, string | null> = {};
    for (const s of registry) fetchedAt[s.station_id] = await tideFetchedAt(s.station_id);
    const plan = planSync({ cursors: pull.cursors, tideFetchedAt: fetchedAt, tideStations: registry.map((s) => s.station_id), nowMs: Date.now() });
    for (const id of plan.tideStationsToRefresh) {
      await refreshTides(id).catch((e: unknown) => errors.push(e instanceof Error ? e.message : String(e)));
    }

    await pullTilesIndex().then((r) => { if (r.ok) errors.push(...r.issues); else errors.push(...r.errors); }).catch((e: unknown) => errors.push(`tiles index: ${e instanceof Error ? e.message : String(e)}`));
    await applyRetention(outbox).catch((e: unknown) => errors.push(`retention: ${e instanceof Error ? e.message : String(e)}`));
    lastReport = report;
    return report;
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

/** Fire-and-forget sync that can never produce an unhandled rejection. */
export function runSync(): void {
  syncNow().catch((e: unknown) => console.warn(`[sync] ${e instanceof Error ? e.message : String(e)}`));
}

/** Wire foreground + connectivity + auth triggers. Returns an unsubscribe function. */
export function startSyncTriggers(): () => void {
  const app = AppState.addEventListener('change', (s) => {
    if (s === 'active') runSync();
  });
  const net = NetInfo.addEventListener((state) => {
    if (state.isConnected) runSync();
  });
  const { data: authSub } = getSupabase().auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
      useAppStore.getState().setAuthRequired(false);
      useAppStore.getState().setUserId(session.user.id);
      runSync();
    }
    if (event === 'SIGNED_OUT') useAppStore.getState().setUserId(null);
  });
  const interval = setInterval(runSync, SYNC_BACKGROUND_INTERVAL_MIN * 60 * 1000); // foreground cadence; background task is a TODO
  runSync();
  return () => {
    app.remove();
    net();
    authSub.subscription.unsubscribe();
    clearInterval(interval);
  };
}
