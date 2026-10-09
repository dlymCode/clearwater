/** Optimistic local rows so queued pings/messages appear immediately (the cursor pull upserts the server copy by id). */
import type { MessagePayload, PingPayload } from '../lib/pingModel';
import { pingFromPayload } from '../lib/pingModel';
import { getDb } from './db';

export async function saveLocalPing(p: PingPayload): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO pings (id, json, created_at, updated_at) VALUES (?,?,?,NULL) ON CONFLICT(id) DO NOTHING',
    p.id, JSON.stringify(pingFromPayload(p)), p.created_at,
  );
}

export async function saveLocalMessage(m: MessagePayload): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO messages (id, group_id, json, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
    m.id, m.group_id, JSON.stringify({ ...m, author_id: '', author_handle: 'me' }), m.created_at,
  );
}

export async function loadLocalPings(): Promise<unknown[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM pings ORDER BY created_at DESC LIMIT 500');
  return rows.map((r) => JSON.parse(r.json) as unknown);
}

export async function loadLocalVotes(): Promise<Array<Record<string, unknown>>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM ping_votes');
  return rows.map((r) => JSON.parse(r.json) as Record<string, unknown>);
}
