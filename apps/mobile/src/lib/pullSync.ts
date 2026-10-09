/**
 * Inbound pull, with the network and the local store injected so the contract is testable with a fake
 * PostgREST. Reads ping_feed / ping_votes_feed / messages with each table's own cursor column, paginates,
 * and SURFACES errors (a failed table keeps its cursor and is retried next sync; it is never swallowed).
 */
import { MESSAGE_RETENTION_DAYS, PING_VISIBLE_HOURS } from '@clearwater/shared';
import { advanceCursor, pullSpecs, type CursorKey, type PullSpec, type SyncCursors } from './syncCursor';

export type Row = Record<string, unknown>;

export interface SelectQuery {
  column: string;
  /** Inclusive lower bound on `column` (ISO). */
  gte: string;
  limit: number;
  /** Optional equality filter. */
  eq?: { column: string; value: string };
}

export interface RemoteReader {
  /** Rows ordered by `column` ascending. `error` set => no rows. */
  select(relation: string, q: SelectQuery): Promise<{ rows: Row[]; error: string | null }>;
}

export interface LocalSink {
  /** Upsert by primary key (pings: id; ping_votes: ping_id+voter_id; messages: id). */
  upsert(table: CursorKey, rows: Row[]): Promise<void>;
}

export interface PullOptions {
  nowMs: number;
  pageSize?: number;
  maxPages?: number;
  /** Signed-in user id: also pulls the user's own votes (ping_votes where voter_id = me) for reconciliation. */
  userId?: string | null;
}

export interface PullResult {
  pulled: Record<CursorKey, number>;
  errors: string[];
  cursors: SyncCursors;
}

/** First-sync window per table (no cursor yet). */
export function firstSyncStart(table: CursorKey, nowMs: number): string {
  const hours = table === 'messages' ? MESSAGE_RETENTION_DAYS * 24 : PING_VISIBLE_HOURS;
  return new Date(nowMs - hours * 3_600_000).toISOString();
}

async function pullOne(spec: PullSpec, reader: RemoteReader, sink: LocalSink, cursors: SyncCursors, o: { nowMs: number; pageSize: number; maxPages: number }, errors: string[]): Promise<number> {
  let total = 0;
  let cursor = cursors[spec.table];
  for (let page = 0; page < o.maxPages; page++) {
    const gte = cursor ?? firstSyncStart(spec.table, o.nowMs);
    const { rows, error } = await reader.select(spec.relation, { column: spec.cursorColumn, gte, limit: o.pageSize, ...(spec.eq ? { eq: spec.eq } : {}) });
    if (error) {
      errors.push(`${spec.relation}: ${error}`);
      return total;
    }
    if (rows.length > 0) await sink.upsert(spec.table, rows);
    total += rows.length;
    const next = advanceCursor(cursor, rows, spec.cursorColumn);
    if (next) cursors[spec.table] = next;
    if (rows.length < o.pageSize) return total;
    if (next === cursor) {
      // A full page that all share the cursor timestamp: inclusive pulls cannot move past it.
      errors.push(`${spec.relation}: page of ${rows.length} rows at a single ${spec.cursorColumn}; cursor stuck`);
      return total;
    }
    cursor = next;
  }
  return total;
}

export async function pullAll(reader: RemoteReader, sink: LocalSink, cursorsIn: SyncCursors, opts: PullOptions): Promise<PullResult> {
  const o = { nowMs: opts.nowMs, pageSize: opts.pageSize ?? 1000, maxPages: opts.maxPages ?? 20 };
  const cursors: SyncCursors = { ...cursorsIn };
  const errors: string[] = [];
  const pulled: Record<CursorKey, number> = { pings: 0, ping_votes: 0, messages: 0, my_votes: 0 };
  const specs: PullSpec[] = pullSpecs(cursors);
  if (opts.userId) {
    specs.push({
      table: 'my_votes',
      relation: 'ping_votes',
      cursorColumn: 'created_at',
      eq: { column: 'voter_id', value: opts.userId },
      gte: cursors.my_votes ?? null,
    });
  }
  for (const spec of specs) pulled[spec.table] = await pullOne(spec, reader, sink, cursors, o, errors);
  return { pulled, errors, cursors };
}
