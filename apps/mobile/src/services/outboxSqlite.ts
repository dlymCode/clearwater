import type { OutboxKind } from '@clearwater/shared';
import type { OutboxRow, OutboxStatus, OutboxStore } from '../lib/outbox';
import { getDb, runTx } from './db';

interface Raw {
  id: string;
  seq: number;
  kind: OutboxKind;
  payload: string | null;
  bytes: number;
  created_at: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
}

const toRow = (r: Raw): OutboxRow => ({
  id: r.id,
  seq: r.seq,
  kind: r.kind,
  payload: r.payload === null ? null : (JSON.parse(r.payload) as unknown),
  bytes: r.bytes,
  createdAt: r.created_at,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
});

const SEQ_KEY = 'outbox.seq';

/** SQLite OutboxStore. The sequence counter is persisted in `kv` so it never repeats after deletes. */
export class SqliteOutboxStore implements OutboxStore {
  /** One atomic statement (no transaction): safe to call inside or outside runTx. */
  async nextSeq(): Promise<number> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ v: string }>(
      `INSERT INTO kv (k, v) VALUES (?, '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
       RETURNING v`,
      SEQ_KEY,
    );
    if (!row) throw new Error('outbox seq counter failed');
    return Number(row.v);
  }

  async get(id: string): Promise<OutboxRow | null> {
    const db = await getDb();
    const r = await db.getFirstAsync<Raw>('SELECT * FROM outbox WHERE id = ?', id);
    return r ? toRow(r) : null;
  }

  async insert(row: OutboxRow): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      'INSERT INTO outbox (id, seq, kind, payload, bytes, created_at, status, attempts, last_error) VALUES (?,?,?,?,?,?,?,?,?)',
      row.id, row.seq, row.kind, row.payload === null ? null : JSON.stringify(row.payload), row.bytes, row.createdAt, row.status, row.attempts, row.lastError,
    );
  }

  async list(filter: { status?: OutboxStatus; kind?: OutboxKind } = {}): Promise<OutboxRow[]> {
    const db = await getDb();
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    if (filter.kind) { where.push('kind = ?'); args.push(filter.kind); }
    const rows = await db.getAllAsync<Raw>(`SELECT * FROM outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC`, args);
    return rows.map(toRow);
  }

  async update(id: string, patch: Partial<Pick<OutboxRow, 'status' | 'attempts' | 'lastError' | 'payload' | 'bytes'>>): Promise<void> {
    const db = await getDb();
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status); }
    if (patch.attempts !== undefined) { sets.push('attempts = ?'); args.push(patch.attempts); }
    if (patch.lastError !== undefined) { sets.push('last_error = ?'); args.push(patch.lastError); }
    if (patch.payload !== undefined) { sets.push('payload = ?'); args.push(patch.payload === null ? null : JSON.stringify(patch.payload)); }
    if (patch.bytes !== undefined) { sets.push('bytes = ?'); args.push(patch.bytes); }
    if (sets.length === 0) return;
    await db.runAsync(`UPDATE outbox SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  }

  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    await db.runAsync(`DELETE FROM outbox WHERE id IN (${ids.map(() => '?').join(',')})`, [...ids]);
  }

  /** Serialized transaction. Do not nest runTx / atomic inside each other. */
  async atomic<T>(fn: () => Promise<T>): Promise<T> {
    return runTx(() => fn());
  }
}
