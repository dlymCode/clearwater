/**
 * Outbound queue model (PRD §Offline and sync — Outbound queue).
 *
 *  - Every row has a client-generated UUID (idempotency key; server inserts are idempotent on it) and a
 *    monotonically increasing sequence number that is never reused, even after deletes.
 *  - Kinds: ping, vote, message, depth_batch. Sent in dependency order (pings before the votes and
 *    messages that may reference them), one batch per kind per flush, in `seq` order, marked sent on 2xx.
 *  - Depth batches are already aggregated on device (one row per touched H3 cell per day). Pending depth
 *    rows are coalesced into a single request per flush, because the server allows 1 depth batch / 15 min.
 *  - 50 MB cap: when exceeded, the OLDEST pending depth batches are merged further (same cell+day rows
 *    collapse). Depth data is never dropped, and pings/votes/messages are never dropped.
 *  - Storage is behind OutboxStore: SQLite in the app (services/outboxSqlite.ts), in-memory in tests.
 */
import { OUTBOX_CAP_BYTES, OUTBOX_KINDS, type DepthUploadRow, type OutboxKind } from '@clearwater/shared';
import { assertAnonymousUploadPayload, mergeUploadRows, sanitizeUploadRows } from './aggregate';
import { uuidv4, type IdGenerator } from './uuid';

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export interface OutboxRow {
  /** Client UUID = idempotency key. */
  id: string;
  /** Monotonic, unique, never reused. */
  seq: number;
  kind: OutboxKind;
  /** JSON-serializable. Cleared (null) once sent to free space. */
  payload: unknown;
  bytes: number;
  createdAt: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}

export interface OutboxStore {
  /** Next sequence number; persisted so it survives restarts and deletes. */
  nextSeq(): Promise<number>;
  insert(row: OutboxRow): Promise<void>;
  /** Rows ordered by seq ascending. */
  list(filter?: { status?: OutboxStatus; kind?: OutboxKind }): Promise<OutboxRow[]>;
  update(
    id: string,
    patch: Partial<Pick<OutboxRow, 'status' | 'attempts' | 'lastError' | 'payload' | 'bytes'>>,
  ): Promise<void>;
  delete(ids: readonly string[]): Promise<void>;
  /** Run several writes atomically (SQLite transaction). */
  atomic<T>(fn: () => Promise<T>): Promise<T>;
}

export interface OutboxItem {
  /** Idempotency key for this item. */
  id: string;
  seq: number;
  payload: unknown;
  createdAt: string;
}

export interface OutboxBatch {
  kind: OutboxKind;
  items: OutboxItem[];
}

/** HTTP-like status; the app's sender maps Supabase responses to this. Throw for network errors. */
export interface SendResult {
  status: number;
}
export type OutboxSender = (batch: OutboxBatch) => Promise<SendResult>;

export interface OutboxOptions {
  capBytes?: number;
  idGen?: IdGenerator;
  now?: () => number;
  /** Max items per request by kind (depth_batch is coalesced to one item). */
  batchSize?: Partial<Record<OutboxKind, number>>;
  /** Max depth rows coalesced into one request. */
  maxDepthRowsPerBatch?: number;
}

export interface FlushResult {
  sent: number;
  failed: number;
  /** A retryable error stopped some or all sending; rows remain pending. */
  stopped: boolean;
  perKind: Record<OutboxKind, { sent: number; failed: number }>;
}

export interface CapResult {
  totalBytes: number;
  merges: number;
  /** Still above the cap after merging everything mergeable (only pings etc. remain). Nothing is dropped. */
  overCap: boolean;
}

const DEFAULT_BATCH: Record<OutboxKind, number> = { ping: 50, vote: 100, message: 100, depth_batch: 1 };
const ROW_OVERHEAD_BYTES = 128;

/** Dependency chain: votes/messages reference pings, so a failure here stops the later members. */
const CHAIN: readonly OutboxKind[] = ['ping', 'vote', 'message'];

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // surrogate pair
    } else n += 3;
  }
  return n;
}

export function estimateBytes(payload: unknown): number {
  return utf8Length(JSON.stringify(payload) ?? 'null') + ROW_OVERHEAD_BYTES;
}

export interface DepthBatchPayload {
  rows: DepthUploadRow[];
}

function isDepthPayload(p: unknown): p is DepthBatchPayload {
  return typeof p === 'object' && p !== null && Array.isArray((p as { rows?: unknown }).rows);
}

export class Outbox {
  private readonly cap: number;
  private readonly idGen: IdGenerator;
  private readonly now: () => number;
  private readonly batchSize: Record<OutboxKind, number>;
  private readonly maxDepthRows: number;

  constructor(
    private readonly store: OutboxStore,
    opts: OutboxOptions = {},
  ) {
    this.cap = opts.capBytes ?? OUTBOX_CAP_BYTES;
    this.idGen = opts.idGen ?? uuidv4;
    this.now = opts.now ?? Date.now;
    this.batchSize = { ...DEFAULT_BATCH, ...(opts.batchSize ?? {}) };
    this.maxDepthRows = opts.maxDepthRowsPerBatch ?? 5000;
  }

  /**
   * Queue an item. Returns the row (its `id` is the idempotency key the server dedupes on).
   * Pass `id` when the same UUID must also be the domain primary key (ping.id, message.id, ...).
   */
  async enqueue(kind: OutboxKind, payload: unknown, opts: { id?: string } = {}): Promise<OutboxRow> {
    if (!(OUTBOX_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown outbox kind: ${kind}`);
    if (kind === 'depth_batch') assertAnonymousUploadPayload(payload);
    const row: OutboxRow = {
      id: opts.id ?? this.idGen(),
      seq: await this.store.nextSeq(),
      kind,
      payload,
      bytes: estimateBytes(payload),
      createdAt: new Date(this.now()).toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
    };
    await this.store.insert(row);
    return row;
  }

  async pending(kind?: OutboxKind): Promise<OutboxRow[]> {
    return this.store.list({ status: 'pending', ...(kind ? { kind } : {}) });
  }

  async pendingBytes(): Promise<number> {
    return (await this.pending()).reduce((s, r) => s + r.bytes, 0);
  }

  /** ids still waiting to sync: drives the "pending sync" mark on pings/votes/messages. */
  async pendingIds(kind: OutboxKind): Promise<Set<string>> {
    return new Set((await this.pending(kind)).map((r) => r.id));
  }

  /** Free space held by already-sent rows older than `olderThanMs`. */
  async pruneSent(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const sent = await this.store.list({ status: 'sent' });
    const old = sent.filter((r) => Date.parse(r.createdAt) <= cutoff).map((r) => r.id);
    if (old.length) await this.store.delete(old);
    return old.length;
  }

  /**
   * Merge the oldest pending depth batches further until under the cap. Never deletes data:
   * merging only collapses rows that share (h3_cell, day).
   */
  async enforceCap(): Promise<CapResult> {
    let merges = 0;
    for (;;) {
      const total = await this.pendingBytes();
      if (total <= this.cap) return { totalBytes: total, merges, overCap: false };
      const depth = await this.pending('depth_batch');
      if (depth.length < 2) return { totalBytes: total, merges, overCap: true };
      // Merge the two oldest pending depth rows into the older one.
      const [a, b] = depth as [OutboxRow, OutboxRow];
      const mergedRows = mergeUploadRows([...this.rowsOf(a), ...this.rowsOf(b)]);
      const payload: DepthBatchPayload = { rows: mergedRows };
      const bytes = estimateBytes(payload);
      await this.store.atomic(async () => {
        // New UUID: neither original is in flight (pending only), so no idempotency collision.
        await this.store.delete([a.id, b.id]);
        await this.store.insert({ ...a, id: this.idGen(), payload, bytes, attempts: 0, lastError: null });
      });
      merges++;
    }
  }

  private rowsOf(r: OutboxRow): DepthUploadRow[] {
    return isDepthPayload(r.payload) ? sanitizeUploadRows(r.payload.rows).rows : [];
  }

  /** Coalesce pending depth rows (up to maxDepthRows output rows) into one outbox row before sending. */
  private async coalesceDepth(): Promise<void> {
    const depth = await this.pending('depth_batch');
    if (depth.length < 2) return;
    const take: OutboxRow[] = [];
    let rows: DepthUploadRow[] = [];
    for (const r of depth) {
      const merged = mergeUploadRows([...rows, ...this.rowsOf(r)]);
      if (take.length > 0 && merged.length > this.maxDepthRows) break;
      rows = merged;
      take.push(r);
    }
    if (take.length < 2) return;
    const payload: DepthBatchPayload = { rows };
    const first = take[0] as OutboxRow;
    await this.store.atomic(async () => {
      await this.store.delete(take.map((r) => r.id));
      await this.store.insert({ ...first, id: this.idGen(), payload, bytes: estimateBytes(payload), attempts: 0, lastError: null });
    });
  }

  /**
   * Send everything that is pending, one request per kind per call, in dependency order.
   * 2xx => sent. Network error / 408 / 429 / 5xx => retry later (rows stay pending, kind stops).
   * Other 4xx => the server will never accept the row: marked `failed` (kept, surfaced to the user,
   * not blocking the queue). A multi-item batch rejected with 4xx is retried item by item to isolate it.
   */
  async flush(send: OutboxSender): Promise<FlushResult> {
    const result: FlushResult = {
      sent: 0,
      failed: 0,
      stopped: false,
      perKind: {
        ping: { sent: 0, failed: 0 },
        vote: { sent: 0, failed: 0 },
        message: { sent: 0, failed: 0 },
        depth_batch: { sent: 0, failed: 0 },
      },
    };
    await this.coalesceDepth();
    let chainBlocked = false;

    for (const kind of OUTBOX_KINDS) {
      if (CHAIN.includes(kind) && chainBlocked) continue;
      const rows = (await this.pending(kind)).slice(0, this.batchSize[kind]);
      if (rows.length === 0) continue;
      const outcome = await this.sendRows(kind, rows, send, result);
      if (outcome === 'network') {
        result.stopped = true;
        break; // offline: nothing else will succeed either
      }
      if (outcome === 'retry') {
        result.stopped = true;
        if (CHAIN.includes(kind)) chainBlocked = true;
      }
    }
    return result;
  }

  private async sendRows(
    kind: OutboxKind,
    rows: OutboxRow[],
    send: OutboxSender,
    result: FlushResult,
  ): Promise<'ok' | 'retry' | 'network'> {
    const batch: OutboxBatch = {
      kind,
      items: rows.map((r) => ({ id: r.id, seq: r.seq, payload: r.payload, createdAt: r.createdAt })),
    };
    if (kind === 'depth_batch') {
      for (const it of batch.items) assertAnonymousUploadPayload(it.payload);
    }
    let status: number;
    try {
      status = (await send(batch)).status;
    } catch (e) {
      await this.noteAttempt(rows, e instanceof Error ? e.message : 'network error');
      return 'network';
    }
    if (status >= 200 && status < 300) {
      await this.markSent(rows, kind, result);
      return 'ok';
    }
    const retryable = status === 408 || status === 429 || status >= 500;
    if (retryable) {
      await this.noteAttempt(rows, `HTTP ${status}`);
      return 'retry';
    }
    if (rows.length > 1) {
      // Isolate the poison row(s): resend one by one, stop at the first retryable problem.
      for (const r of rows) {
        const o = await this.sendRows(kind, [r], send, result);
        if (o !== 'ok') return o;
      }
      return 'ok';
    }
    const only = rows[0] as OutboxRow;
    await this.store.update(only.id, { status: 'failed', attempts: only.attempts + 1, lastError: `HTTP ${status}` });
    result.failed++;
    result.perKind[kind].failed++;
    return 'ok';
  }

  private async markSent(rows: OutboxRow[], kind: OutboxKind, result: FlushResult): Promise<void> {
    await this.store.atomic(async () => {
      for (const r of rows) await this.store.update(r.id, { status: 'sent', payload: null, bytes: 0, lastError: null });
    });
    result.sent += rows.length;
    result.perKind[kind].sent += rows.length;
  }

  private async noteAttempt(rows: OutboxRow[], error: string): Promise<void> {
    for (const r of rows) await this.store.update(r.id, { attempts: r.attempts + 1, lastError: error });
  }

  /** Rows the server permanently rejected: shown to the user, never silently dropped. */
  async failed(): Promise<OutboxRow[]> {
    return this.store.list({ status: 'failed' });
  }
}

/** Stable ordering helper for tests and stores. */
export const bySeq = (a: OutboxRow, b: OutboxRow): number => a.seq - b.seq;
