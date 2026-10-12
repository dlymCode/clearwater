/**
 * Inbound pull, with the network and the local store injected so the contract is testable with a fake PostgREST.
 * Reads ping_feed / messages_feed (plus the user's own votes) with each source's cursor column, paginates with
 * KEYSET pagination, and SURFACES errors (a failed source keeps its cursor and is retried next sync).
 *
 * Keyset pagination: rows are ordered by (cursorColumn, tieColumn) and the cursor is the (value, tie) of the last row
 * received. Many rows can share one timestamp (a bulk UPDATE stamps one transaction time), so a timestamp alone cannot
 * address a position: a page full of equal timestamps would never advance. With the tie-breaker every page moves
 * strictly forward and a group of ties of any size drains completely.
 *
 * Known limit (documented, not handled): a row whose transaction commits late with an updated_at older than the
 * cursor is skipped. Vote changes bump pings.updated_at server-side, so they arrive with their ping.
 */
import { MESSAGE_RETENTION_DAYS, MS_PER_HOUR, OWN_VOTES_SOURCE, PING_VISIBLE_HOURS } from '@clearwater/shared';
import { pullSpecs, type CursorKey, type PullSpec, type SyncCursors, type TieKeys } from './syncCursor';

export type Row = Record<string, unknown>;

export interface SelectQuery {
  column: string;
  /** Position to read from. With `tiebreak.after == null` the bound is inclusive (>=), otherwise keyset-strict. */
  gte: string;
  limit: number;
  /** Optional equality filter. */
  eq?: { column: string; value: string };
  /**
   * Keyset tie-breaker. Rows are ordered by (column, tiebreak.column). When `after` is set the query returns only rows
   * strictly after the pair (gte, after): column > gte OR (column = gte AND tiebreak.column > after).
   */
  tiebreak: { column: string; after: string | null };
}

export interface RemoteReader {
  /** Rows ordered by (column, tiebreak.column) ascending. `error` set => no rows. */
  select(relation: string, q: SelectQuery): Promise<{ rows: Row[]; error: string | null }>;
}

export interface LocalSink {
  /** Upsert by primary key (pings: id; messages: id; my_votes: ping_id). */
  upsert(table: CursorKey, rows: Row[]): Promise<void>;
}

export interface PullOptions {
  nowMs: number;
  pageSize?: number;
  maxPages?: number;
  /** Signed-in user id: also pulls the user's own votes (ping_votes where voter_id = me) for reconciliation. */
  userId?: string | null;
  /** Last tie-break key per source (persisted next to the cursors). */
  keys?: TieKeys;
}

export interface PullResult {
  pulled: Record<CursorKey, number>;
  errors: string[];
  cursors: SyncCursors;
  keys: TieKeys;
}

/** First-sync window per source (no cursor yet). */
export function firstSyncStart(table: CursorKey, nowMs: number): string {
  const hours = table === 'messages' ? MESSAGE_RETENTION_DAYS * 24 : PING_VISIBLE_HOURS;
  return new Date(nowMs - hours * MS_PER_HOUR).toISOString();
}

interface Ctx {
  nowMs: number;
  pageSize: number;
  maxPages: number;
}

async function pullOne(spec: PullSpec, reader: RemoteReader, sink: LocalSink, cursors: SyncCursors, keys: TieKeys, ctx: Ctx, errors: string[]): Promise<number> {
  let total = 0;
  let cursor = cursors[spec.table];
  let key = keys[spec.table] ?? null;
  for (let page = 0; page < ctx.maxPages; page++) {
    const gte = cursor ?? firstSyncStart(spec.table, ctx.nowMs);
    const { rows, error } = await reader.select(spec.relation, {
      column: spec.cursorColumn,
      gte,
      limit: ctx.pageSize,
      ...(spec.eq ? { eq: spec.eq } : {}),
      tiebreak: { column: spec.tieColumn, after: cursor === undefined ? null : key },
    });
    if (error) {
      errors.push(`${spec.relation}: ${error}`);
      return total;
    }
    if (rows.length > 0) {
      try {
        await sink.upsert(spec.table, rows);
      } catch (e) {
        // A failing local write must not advance the cursor past rows we did not store, nor abort other sources.
        errors.push(`${spec.relation}: local write failed: ${e instanceof Error ? e.message : String(e)}`);
        return total;
      }
      const last = rows[rows.length - 1] as Row;
      const ts = last[spec.cursorColumn];
      const tie = last[spec.tieColumn];
      if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts)) || (typeof tie !== 'string' && typeof tie !== 'number')) {
        errors.push(`${spec.relation}: last row lacks a usable ${spec.cursorColumn}/${spec.tieColumn}; cursor not advanced`);
        return total + rows.length;
      }
      cursor = ts;
      key = String(tie);
      cursors[spec.table] = cursor;
      keys[spec.table] = key;
    }
    total += rows.length;
    if (rows.length < ctx.pageSize) return total;
  }
  return total;
}

export async function pullAll(reader: RemoteReader, sink: LocalSink, cursorsIn: SyncCursors, opts: PullOptions): Promise<PullResult> {
  const ctx: Ctx = { nowMs: opts.nowMs, pageSize: opts.pageSize ?? 1000, maxPages: opts.maxPages ?? 20 };
  const cursors: SyncCursors = { ...cursorsIn };
  const keys: TieKeys = { ...(opts.keys ?? {}) };
  const errors: string[] = [];
  const pulled: Record<CursorKey, number> = { pings: 0, messages: 0, my_votes: 0 };
  const specs: PullSpec[] = pullSpecs(cursors);
  if (opts.userId) {
    specs.push({
      table: 'my_votes',
      ...OWN_VOTES_SOURCE,
      eq: { column: 'voter_id', value: opts.userId },
      gte: cursors.my_votes ?? null,
    });
  }
  for (const spec of specs) {
    try {
      pulled[spec.table] = await pullOne(spec, reader, sink, cursors, keys, ctx, errors);
    } catch (e) {
      errors.push(`${spec.relation}: ${e instanceof Error ? e.message : String(e)}`); // one source failing never stops the others
    }
  }
  return { pulled, errors, cursors, keys };
}
