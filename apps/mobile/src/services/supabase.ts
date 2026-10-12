import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import type { OutboxBatch, OutboxSender, SendResult } from '../lib/outbox';
import { assertAnonymousUploadPayload } from '../lib/aggregate';
import { CONFIG, isBackendConfigured } from './config';

/** Session tokens live in the iOS Keychain (SecureStore), not AsyncStorage. SecureStore values are limited
 *  in size on some platforms; supabase-js sessions fit on iOS. TODO: chunk if Android is added (P1-6). */
const secureStorage = {
  getItem: (k: string) => SecureStore.getItemAsync(k),
  setItem: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  removeItem: (k: string) => SecureStore.deleteItemAsync(k),
};

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!isBackendConfigured()) throw new Error('Supabase is not configured (see .env.example).');
  client ??= createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: { storage: secureStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
  return client;
}

interface PgError {
  code?: string;
  message?: string;
}

/** PostgREST maps SQLSTATE 'PTnnn' to HTTP nnn; supabase-js surfaces it as error.code 'PTnnn' (and status). */
function statusOf(error: PgError | null, httpStatus?: number): number {
  if (!error) return httpStatus && httpStatus >= 200 ? httpStatus : 200;
  // Unique-violation on a retry means the row already exists: idempotent success. Must be checked BEFORE the
  // HTTP status fallback, because PostgREST reports it as HTTP 409.
  if (error.code === '23505') return 200;
  const m = /^PT(\d{3})$/.exec(error.code ?? '');
  if (m) return Number(m[1]);
  if (httpStatus && httpStatus >= 400) return httpStatus;
  return 500;
}

/** status + the SQL error identifier (error.message) so the outbox can tell silent vote failures from real ones. */
function result(error: PgError | null, httpStatus?: number): SendResult {
  const status = statusOf(error, httpStatus);
  return status >= 300 && error?.message ? { status, code: error.message } : { status };
}

const ewkt = (lat: number, lon: number): string => `SRID=4326;POINT(${lon} ${lat})`;

/**
 * Maps one outbox batch to Supabase calls. Server inserts are idempotent on the client UUID
 * (pings/messages: upsert on id with ignoreDuplicates; votes: cast_vote RPC, unique on (ping, voter);
 * depth: batch_id = outbox row id => edge function / ingest_depth_batch dedupes).
 * Network failures throw (=> OutboxSender treats as offline).
 */
export const sendOutboxBatch: OutboxSender = async (batch: OutboxBatch): Promise<SendResult> => {
  const sb = getSupabase();
  switch (batch.kind) {
    case 'ping': {
      const rows = batch.items.map((i) => {
        const p = i.payload as { id: string; group_id: string | null; type: string; lat: number; lon: number; note: string | null; created_at: string; tide_ft: number | null; anonymous: boolean };
        return { id: p.id, group_id: p.group_id, type: p.type, geom: ewkt(p.lat, p.lon), note: p.note, created_at: p.created_at, tide_ft: p.tide_ft, anonymous: p.anonymous };
      });
      // Minimal response on purpose: NEVER chain .select() / RETURNING * here. pings.author_id is column-revoked for
      // clients, so a RETURNING * would fail with 42501. supabase-js sends `Prefer: return=minimal` when no select().
      const { error, status } = await sb.from('pings').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
      return result(error, status);
    }
    case 'message': {
      const rows = batch.items.map((i) => i.payload as Record<string, unknown>);
      const { error, status } = await sb.from('messages').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
      return result(error, status);
    }
    case 'vote': {
      // cast_vote is one-vote-per-call; stop at the first non-2xx so order is preserved.
      for (const i of batch.items) {
        const v = i.payload as { ping_id: string; vote: 1 | -1 };
        const { error, status } = await sb.rpc('cast_vote', { p_ping_id: v.ping_id, p_vote: v.vote });
        const r = result(error, status);
        // error.message carries the SQL identifier: 'confirm_ineligible' / 'cannot_vote_own_ping' (PT403),
        // 'ping_not_found' (PT404), 'account_revoked' (PT403).
        if (r.status >= 300) return r;
      }
      return { status: 200 };
    }
    case 'depth_batch': {
      const item = batch.items[0];
      if (!item) return { status: 200 };
      assertAnonymousUploadPayload(item.payload); // last line of defence: no uid / timestamps leave the device
      // ASSUMPTION: edge function `depth-upload` (backend) takes {batch_id, rows}; uploader_hash is added server-side.
      const { error, response } = await sb.functions.invoke('depth-upload', { body: { batch_id: item.id, rows: item.payload.rows } });
      if (!error) return { status: 200 };
      const httpStatus = (error as { context?: { status?: number } }).context?.status ?? response?.status;
      return { status: httpStatus ?? 500 };
    }
  }
};

/** tile-auth refused or failed. `status` lets callers treat 400/404 as "that product does not exist (yet)". */
export class TileAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Exchanges the Supabase JWT for a signed R2 URL via the tile-auth worker (TILE_AUTH_URL). */
export async function signTileUrl(path: string): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new TileAuthError(401, 'Sign in to download tiles.');
  const res = await fetch(`${CONFIG.tileAuthUrl}?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new TileAuthError(res.status, `tile-auth ${res.status} for ${path}`);
  const json = (await res.json()) as { url?: string };
  if (!json.url) throw new TileAuthError(502, 'tile-auth returned no url');
  return json.url;
}
