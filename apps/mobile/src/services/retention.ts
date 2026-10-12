/** Applies lib/retention.ts cutoffs to the private store. Runs at the end of every sync; cheap and idempotent. */
import { retentionCutoffs } from '../lib/retention';
import type { Outbox } from '../lib/outbox';
import { runTx } from './db';

export async function applyRetention(outbox: Outbox, nowMs: number = Date.now()): Promise<void> {
  const c = retentionCutoffs(nowMs);
  await outbox.pruneSent(c.sentOutboxMaxAgeMs);
  // Pings still waiting to sync (queued or rejected) are kept even when old: their payload is the user's data.
  const unsynced = [...(await outbox.unsyncedIds('ping'))];
  await runTx(async (db) => {
    const keep = unsynced.length ? `AND id NOT IN (${unsynced.map(() => '?').join(',')})` : '';
    await db.runAsync(`DELETE FROM pings WHERE COALESCE(updated_at, created_at) < ? ${keep}`, c.pingsBefore, ...unsynced);
    await db.runAsync('DELETE FROM my_votes WHERE ping_id NOT IN (SELECT id FROM pings)');
    await db.runAsync('DELETE FROM messages WHERE created_at < ?', c.messagesBefore);
    await db.runAsync('DELETE FROM soundings WHERE aggregated = 1 AND t_ms < ?', c.aggregatedSoundingsBeforeMs);
  });
}
