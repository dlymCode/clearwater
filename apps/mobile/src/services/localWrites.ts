/** Optimistic local rows so queued pings/messages appear immediately (the cursor pull upserts the server copy by id). */
import type { MessagePayload, PingPayload } from '../lib/pingModel';
import { pingFromPayload } from '../lib/pingModel';
import type { MyVote } from '@clearwater/shared';
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
    m.id, m.group_id, JSON.stringify({ ...m, author_id: null, author_handle: 'me' }), m.created_at,
  );
}

export async function loadLocalPings(): Promise<unknown[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM pings ORDER BY created_at DESC LIMIT 500');
  return rows.map((r) => JSON.parse(r.json) as unknown);
}

/** ping ids the signed-in user already voted on (queued or synced). */
export async function loadMyVotedPingIds(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ ping_id: string }>('SELECT ping_id FROM my_votes');
  return new Set(rows.map((r) => r.ping_id));
}

/** The user's own vote, recorded when queued; the server row (ping_votes where voter_id = me) reconciles it on pull. */
export async function saveLocalVote(v: MyVote): Promise<void> {
  const db = await getDb();
  await db.runAsync('INSERT INTO my_votes (ping_id, vote, created_at) VALUES (?,?,?) ON CONFLICT(ping_id) DO NOTHING', v.ping_id, v.vote, v.created_at);
}
