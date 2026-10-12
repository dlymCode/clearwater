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
 *  - Rows that were ever attempted (attempts > 0 or lastError) are NEVER merged or re-id'd: the server may already
 *    hold them under their id, and a fresh id would double count. Only never-sent rows are merged.
 *  - 401 pauses sending (authRequired) instead of failing rows; other permanent 4xx rows become `failed`, stay
 *    visible (unsyncedIds / failed()) and can be retried with retryFailed(). Vote 403s that mean "you cannot vote
 *    on this" (confirm_ineligible, cannot_vote_own_ping, ...) are swallowed silently.
 *  - Depth rows over 5000 are split into stably-id'd chunks at send time (server rejects > 5000 per batch).
 *  - TODO(multi-batch drain): flush sends one batch per kind per call; a long offline backlog drains one
 *    batch per sync pass. Loop until empty (respecting the 15 min depth limit) when this matters.
 *  - Storage is behind OutboxStore: SQLite in the app (services/outboxSqlite.ts), in-memory in tests.
 */
import { DEPTH_BATCH_MAX_ROWS, OUTBOX_CAP_BYTES, OUTBOX_KINDS, type DepthUploadRow, type OutboxKind } from '@clearwater/shared';
import { assertAnonymousUploadPayload, mergeUploadRows, sanitizeUploadRows } from './aggregate';
import { retryableStatus } from './http';
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
  get(id: string): Promise<OutboxRow | null>;
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
  /** Server error identifier when known (e.g. PostgREST message 'confirm_ineligible'). */
  code?: string;
}

/**
 * Vote failures that are expected user situations, not errors: dropped silently. cast_vote raises
 * confirm_ineligible / cannot_vote_own_ping as PT403 and ping_not_found as PT404 (status AND code must match).
 */
export const SILENT_VOTE_FAILURES: ReadonlyArray<{ status: number; code: string }> = [
  { status: 403, code: 'confirm_ineligible' },
  { status: 403, code: 'cannot_vote_own_ping' },
  { status: 404, code: 'ping_not_found' },
];

export function isSilentVoteFailure(status: number, code: string | undefined): boolean {
  return !!code && SILENT_VOTE_FAILURES.some((f) => f.status === status && f.code === code);
}

/** 403 account_revoked: not retryable and not the row's fault; the account itself is blocked. */
export function isAccountRevoked(status: number, code: string | undefined): boolean {
  return status === 403 && code === 'account_revoked';
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
  /** Votes the server refused for expected reasons (marked done, nothing shown). */
  swallowed: number;
  /** A 401 paused sending; refresh the session / sign in, then flush again. Rows stay pending. */
  authRequired: boolean;
  /** The server refused the account (account_revoked). Rows stay pending; show a blocking notice. */
  accountRevoked: boolean;
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

/** Only never-sent rows may be merged or re-id'd. */
export function isMergeable(r: OutboxRow): boolean {
  return r.status === 'pending' && r.attempts === 0 && r.lastError === null;
}

/** Stable id for chunk `index` of a split depth batch (index 0 keeps the row id). */
export function chunkId(id: string, index: number): string {
  if (index === 0) return id;
  return `${id.slice(0, id.length - 4)}${index.toString(16).padStart(4, '0').slice(-4)}`;
}

export function chunkRows<T>(rows: readonly T[], size: number = DEPTH_BATCH_MAX_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out.length ? out : [[]];
}

/**
 * Deterministic batch id for "aggregate soundings id range [first,last]" so a retry after a crash produces the same
 * id (idempotent) instead of a new batch. `installId` is a random per-install UUID, so ids never collide across boats.
 */
export function soundingBatchId(installId: string, firstId: number, lastId: number): string {
  const hex = installId.replace(/-/g, '').toLowerCase().padEnd(32, '0');
  const f = (firstId >>> 0).toString(16).padStart(6, '0').slice(-6);
  const l = (lastId >>> 0).toString(16).padStart(6, '0').slice(-6);
  const body = `${hex.slice(0, 20)}${f}${l}`;
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-4${body.slice(13, 16)}-8${body.slice(17, 20)}-${body.slice(20, 32)}`;
}

export interface DepthBatchPayload {
  rows: DepthUploadRow[];
}

function isDepthPayload(p: unknown): p is DepthBatchPayload {
  return typeof p === 'object' && p !== null && Array.isArray((p as { rows?: unknown }).rows);
}

type Outcome = 'ok' | 'retry' | 'network' | 'auth' | 'revoked';

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
    this.maxDepthRows = opts.maxDepthRowsPerBatch ?? DEPTH_BATCH_MAX_ROWS;
  }

  /**
   * Queue an item. Returns the row (its `id` is the idempotency key the server dedupes on).
   * Pass `id` when the same UUID must also be the domain primary key (ping.id, message.id, ...).
   */
  async enqueue(kind: OutboxKind, payload: unknown, opts: { id?: string } = {}): Promise<OutboxRow> {
    if (!(OUTBOX_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown outbox kind: ${kind}`);
    if (kind === 'depth_batch') assertAnonymousUploadPayload(payload);
    if (opts.id) {
      const existing = await this.store.get(opts.id);
      if (existing) {
        // Idempotent for a true replay only. The same id with a different kind or payload is a caller bug (or a
        // collision) and silently returning the old row would drop the new data.
        if (existing.kind !== kind || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
          throw new Error(`outbox id ${opts.id} already exists with a different ${existing.kind !== kind ? 'kind' : 'payload'}`);
        }
        return existing;
      }
    }
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

  /** Pending PLUS rejected-and-not-retried rows: both are "not on the server yet", so both keep the pending mark. */
  async unsyncedIds(kind: OutboxKind): Promise<Set<string>> {
    const [p, f] = await Promise.all([this.pending(kind), this.failed()]);
    return new Set([...p, ...f.filter((r) => r.kind === kind)].map((r) => r.id));
  }

  /** User-initiated retry of rows the server rejected. They stay unmergeable (attempts > 0). */
  async retryFailed(): Promise<number> {
    const failed = await this.failed();
    for (const r of failed) await this.store.update(r.id, { status: 'pending', lastError: null });
    return failed.length;
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
      const depth = (await this.pending('depth_batch')).filter(isMergeable);
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
    const depth = (await this.pending('depth_batch')).filter(isMergeable);
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
      swallowed: 0,
      authRequired: false,
      accountRevoked: false,
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
      if (outcome === 'network' || outcome === 'auth' || outcome === 'revoked') {
        result.stopped = true;
        if (outcome === 'auth') result.authRequired = true;
        if (outcome === 'revoked') result.accountRevoked = true;
        break; // offline / signed out: nothing else will succeed either
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
  ): Promise<Outcome> {
    if (kind === 'depth_batch') return this.sendDepth(rows, send, result);
    const batch: OutboxBatch = {
      kind,
      items: rows.map((r) => ({ id: r.id, seq: r.seq, payload: r.payload, createdAt: r.createdAt })),
    };
    const out = await this.dispatch(batch, send);
    if (out.type === 'network') {
      await this.noteAttempt(rows, out.message);
      return 'network';
    }
    return this.settle(kind, rows, out.result, send, result);
  }

  /** Send one batch; a thrown error means offline. */
  private async dispatch(
    batch: OutboxBatch,
    send: OutboxSender,
  ): Promise<{ type: 'network'; message: string } | { type: 'http'; result: SendResult }> {
    try {
      return { type: 'http', result: await send(batch) };
    } catch (e) {
      return { type: 'network', message: e instanceof Error ? e.message : 'network error' };
    }
  }

  /** Interpret an HTTP-like result for `rows` (already sent as one batch). */
  private async settle(
    kind: OutboxKind,
    rows: OutboxRow[],
    res: SendResult,
    send: OutboxSender,
    result: FlushResult,
  ): Promise<Outcome> {
    const status = res.status;
    if (status >= 200 && status < 300) {
      await this.markSent(rows, kind, result);
      return 'ok';
    }
    // 401: the session expired. Not the row's fault: leave everything pending (no attempt counted) and pause.
    if (status === 401) return 'auth';
    if (isAccountRevoked(status, res.code)) return 'revoked';
    if (retryableStatus(status)) {
      await this.noteAttempt(rows, `HTTP ${status}`);
      return 'retry';
    }
    if (rows.length > 1) {
      // Isolate the poison row(s): resend one by one, stop at the first retryable problem.
      for (const r of rows) {
        const one: OutboxBatch = { kind, items: [{ id: r.id, seq: r.seq, payload: r.payload, createdAt: r.createdAt }] };
        const out = await this.dispatch(one, send);
        if (out.type === 'network') {
          await this.noteAttempt([r], out.message);
          return 'network';
        }
        const o = await this.settle(kind, [r], out.result, send, result);
        if (o !== 'ok') return o;
      }
      return 'ok';
    }
    const only = rows[0] as OutboxRow;
    if (kind === 'vote' && isSilentVoteFailure(status, res.code)) {
      // Expected: not near the ping, own ping, ping gone. Nothing to show or retry.
      await this.store.update(only.id, { status: 'sent', payload: null, bytes: 0, lastError: null });
      result.swallowed++;
      return 'ok';
    }
    await this.store.update(only.id, {
      status: 'failed',
      attempts: only.attempts + 1,
      lastError: `HTTP ${status}${res.code ? ` ${res.code}` : ''}`,
    });
    result.failed++;
    result.perKind[kind].failed++;
    return 'ok';
  }

  /**
   * Depth: one outbox row per request, but a row with more than 5000 rows is split into chunks, each with a
   * stable id (chunkId), sent in order. The row is marked sent only after every chunk is accepted; a retry
   * resends the same chunk ids, which the server dedupes.
   */
  private async sendDepth(rows: OutboxRow[], send: OutboxSender, result: FlushResult): Promise<Outcome> {
    for (const r of rows) {
      assertAnonymousUploadPayload(r.payload);
      const chunks = chunkRows((r.payload as DepthBatchPayload).rows);
      for (let i = 0; i < chunks.length; i++) {
        const batch: OutboxBatch = {
          kind: 'depth_batch',
          items: [{ id: chunkId(r.id, i), seq: r.seq, payload: { rows: chunks[i] }, createdAt: r.createdAt }],
        };
        const out = await this.dispatch(batch, send);
        if (out.type === 'network') {
          await this.noteAttempt([r], out.message);
          return 'network';
        }
        const status = out.result.status;
        if (status >= 200 && status < 300) continue;
        if (i > 0 || chunks.length > 1) {
          // Partial progress: earlier chunks are ALREADY committed on the server under their ids. Whatever happens
          // next, this row must become non-mergeable (attempts > 0) BEFORE we return, or enforceCap/coalesce could
          // re-id it and the replay would double count. Chunk ids are stable, so retrying is safe.
          if (i > 0 || status !== 401) await this.noteAttempt([r], `HTTP ${status} (chunk ${i + 1}/${chunks.length})`);
          if (status === 401) return 'auth';
          if (isAccountRevoked(status, out.result.code)) return 'revoked';
          if (retryableStatus(status)) return 'retry';
          await this.store.update(r.id, { status: 'failed', attempts: r.attempts + 1, lastError: `HTTP ${status} (chunk ${i + 1}/${chunks.length})` });
          result.failed++;
          result.perKind.depth_batch.failed++;
          return 'ok';
        }
        return this.settle('depth_batch', [r], out.result, send, result);
      }
      await this.markSent([r], 'depth_batch', result);
    }
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
