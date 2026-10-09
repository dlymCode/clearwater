import { latLngToCell } from 'h3-js';
import type { DepthUploadRow, OutboxKind } from '@clearwater/shared';
import { Outbox } from '../src/lib/outbox';
import type { OutboxBatch, OutboxSender } from '../src/lib/outbox';
import { InMemoryOutboxStore } from '../src/lib/outboxMemoryStore';
import { UUID_RE } from '../src/lib/uuid';

const mk = (opts: ConstructorParameters<typeof Outbox>[1] = {}) => {
  const store = new InMemoryOutboxStore();
  let n = 0;
  const outbox = new Outbox(store, { idGen: () => `id-${++n}`, now: () => Date.parse('2026-10-09T12:00:00Z'), ...opts });
  return { store, outbox };
};

const recorder = (status: number | ((b: OutboxBatch) => number) = 200) => {
  const calls: OutboxBatch[] = [];
  const send: OutboxSender = async (b) => {
    calls.push(JSON.parse(JSON.stringify(b)) as OutboxBatch);
    return { status: typeof status === 'function' ? status(b) : status };
  };
  return { calls, send };
};

const depthRow = (i: number, day = '2026-10-09', median = 10): DepthUploadRow => ({
  h3_cell: latLngToCell(48.3 + i * 0.001, -122.5, 12),
  day,
  median_ft: median,
  p10_ft: median - 1,
  n: 5,
});

describe('enqueue', () => {
  it('assigns unique, monotonically increasing seq, never reused after delete', async () => {
    const { outbox, store } = mk();
    const a = await outbox.enqueue('ping', { x: 1 });
    const b = await outbox.enqueue('ping', { x: 2 });
    expect(b.seq).toBeGreaterThan(a.seq);
    await store.delete([b.id]);
    const c = await outbox.enqueue('ping', { x: 3 });
    expect(c.seq).toBeGreaterThan(b.seq);
  });

  it('generates a UUID id by default (idempotency key) and honours a caller-supplied id', async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store);
    const r = await outbox.enqueue('message', { body: 'hi' });
    expect(r.id).toMatch(UUID_RE);
    const fixed = await outbox.enqueue('ping', {}, { id: '11111111-1111-4111-8111-111111111111' });
    expect(fixed.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('rejects depth batches that carry a uid or timestamp', async () => {
    const { outbox } = mk();
    await expect(outbox.enqueue('depth_batch', { rows: [{ ...depthRow(0), uid: 'u' }] })).rejects.toThrow(/forbidden/);
    await expect(outbox.enqueue('depth_batch', { rows: [depthRow(0)], uid: 'u' })).rejects.toThrow(/top-level/);
    await expect(outbox.enqueue('depth_batch', { rows: [depthRow(0)] })).resolves.toBeDefined();
  });

  it('rejects unknown kinds', async () => {
    const { outbox } = mk();
    await expect(outbox.enqueue('bogus' as OutboxKind, {})).rejects.toThrow();
  });
});

describe('flush ordering and marking', () => {
  it('sends pings before votes before messages before depth, one batch per kind, in seq order', async () => {
    const { outbox } = mk();
    await outbox.enqueue('message', { body: 'm1' });
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    await outbox.enqueue('vote', { v: 1 });
    await outbox.enqueue('ping', { n: 1 });
    await outbox.enqueue('ping', { n: 2 });
    const { calls, send } = recorder();
    const r = await outbox.flush(send);
    expect(calls.map((c) => c.kind)).toEqual(['ping', 'vote', 'message', 'depth_batch']);
    expect(calls[0]!.items.map((i) => (i.payload as { n: number }).n)).toEqual([1, 2]);
    expect(r.sent).toBe(5);
    expect(r.stopped).toBe(false);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('marks sent only on 2xx; on 503 rows stay pending and keep the SAME id (idempotent retry)', async () => {
    const { outbox } = mk();
    const row = await outbox.enqueue('ping', { n: 1 });
    const first = recorder(503);
    const r1 = await outbox.flush(first.send);
    expect(r1.sent).toBe(0);
    expect(r1.stopped).toBe(true);
    const pending = await outbox.pending('ping');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBe(1);
    const second = recorder(200);
    await outbox.flush(second.send);
    expect(second.calls[0]!.items[0]!.id).toBe(row.id);
    expect(first.calls[0]!.items[0]!.id).toBe(row.id);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('a network error (throw) stops everything and leaves all rows pending', async () => {
    const { outbox } = mk();
    await outbox.enqueue('ping', {});
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    const calls: string[] = [];
    const r = await outbox.flush(async (b) => {
      calls.push(b.kind);
      throw new Error('offline');
    });
    expect(calls).toEqual(['ping']);
    expect(r.stopped).toBe(true);
    expect(await outbox.pending()).toHaveLength(2);
  });

  it('a retryable ping failure blocks votes and messages but not the independent depth upload', async () => {
    const { outbox } = mk();
    await outbox.enqueue('ping', {});
    await outbox.enqueue('vote', {});
    await outbox.enqueue('message', {});
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    const { calls, send } = recorder((b) => (b.kind === 'ping' ? 500 : 200));
    const r = await outbox.flush(send);
    expect(calls.map((c) => c.kind)).toEqual(['ping', 'depth_batch']);
    expect(r.perKind.depth_batch.sent).toBe(1);
    expect((await outbox.pending()).map((x) => x.kind)).toEqual(['ping', 'vote', 'message']);
  });

  it('429 is retryable', async () => {
    const { outbox } = mk();
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    const r = await outbox.flush(recorder(429).send);
    expect(r.stopped).toBe(true);
    expect(await outbox.pending()).toHaveLength(1);
  });

  it('a 4xx poison row is isolated, marked failed (kept), and does not block its neighbours', async () => {
    const { outbox } = mk();
    await outbox.enqueue('ping', { ok: 1 });
    const bad = await outbox.enqueue('ping', { bad: true });
    await outbox.enqueue('ping', { ok: 3 });
    const { send } = recorder((b) => (b.items.some((i) => (i.payload as { bad?: boolean }).bad) ? 422 : 200));
    const r = await outbox.flush(send);
    expect(r.perKind.ping).toEqual({ sent: 2, failed: 1 });
    const failed = await outbox.failed();
    expect(failed.map((f) => f.id)).toEqual([bad.id]);
    expect(failed[0]!.lastError).toBe('HTTP 422');
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('sent rows release their payload; pruneSent deletes old ones', async () => {
    const { outbox, store } = mk();
    await outbox.enqueue('ping', { big: 'x'.repeat(100) });
    await outbox.flush(recorder().send);
    const [sent] = await store.list({ status: 'sent' });
    expect(sent!.payload).toBeNull();
    expect(sent!.bytes).toBe(0);
    expect(await outbox.pruneSent(0)).toBe(1);
    expect(await store.list()).toHaveLength(0);
  });

  it('pendingIds drives the pending-sync mark', async () => {
    const { outbox } = mk();
    const p = await outbox.enqueue('ping', {}, { id: 'ping-1' });
    expect((await outbox.pendingIds('ping')).has(p.id)).toBe(true);
    await outbox.flush(recorder().send);
    expect((await outbox.pendingIds('ping')).has(p.id)).toBe(false);
  });

  it('respects the per-kind batch size', async () => {
    const { outbox } = mk({ batchSize: { ping: 2 } });
    for (let i = 0; i < 5; i++) await outbox.enqueue('ping', { i });
    const { calls, send } = recorder();
    await outbox.flush(send);
    expect(calls[0]!.items).toHaveLength(2);
    expect(await outbox.pending('ping')).toHaveLength(3);
  });
});

describe('depth coalescing (1 batch / 15 min server limit)', () => {
  it('merges several pending depth rows into one request with deduped cell+day rows', async () => {
    const { outbox } = mk();
    await outbox.enqueue('depth_batch', { rows: [depthRow(0), depthRow(1)] });
    await outbox.enqueue('depth_batch', { rows: [depthRow(1), depthRow(2)] });
    await outbox.enqueue('depth_batch', { rows: [depthRow(3, '2026-10-10')] });
    const { calls, send } = recorder();
    await outbox.flush(send);
    const depthCalls = calls.filter((c) => c.kind === 'depth_batch');
    expect(depthCalls).toHaveLength(1);
    expect(depthCalls[0]!.items).toHaveLength(1);
    const rows = (depthCalls[0]!.items[0]!.payload as { rows: DepthUploadRow[] }).rows;
    expect(rows).toHaveLength(4); // cells 0,1(merged n=10),2 on the 9th + cell 3 on the 10th
    expect(rows.find((r) => r.h3_cell === depthRow(1).h3_cell)!.n).toBe(10);
  });
});

describe('50 MB cap policy (scaled down)', () => {
  it('merges oldest depth batches, drops nothing, never touches pings', async () => {
    const { outbox } = mk({ capBytes: 4000 });
    await outbox.enqueue('ping', { note: 'bar moved' });
    for (let d = 0; d < 12; d++) {
      // the same 6 cells every "day" batch, same day => merging collapses them
      await outbox.enqueue('depth_batch', { rows: Array.from({ length: 6 }, (_, i) => depthRow(i)) });
    }
    const before = await outbox.pendingBytes();
    expect(before).toBeGreaterThan(4000);
    const cap = await outbox.enforceCap();
    expect(cap.merges).toBeGreaterThan(0);
    expect(cap.overCap).toBe(false);
    expect(cap.totalBytes).toBeLessThanOrEqual(4000);
    expect(await outbox.pending('ping')).toHaveLength(1);
    // all soundings still accounted for: n is conserved
    const depth = await outbox.pending('depth_batch');
    const total = depth.flatMap((r) => (r.payload as { rows: DepthUploadRow[] }).rows).reduce((s, r) => s + r.n, 0);
    expect(total).toBe(12 * 6 * 5);
  });

  it('when only pings exceed the cap nothing is dropped and overCap is reported', async () => {
    const { outbox } = mk({ capBytes: 500 });
    for (let i = 0; i < 20; i++) await outbox.enqueue('ping', { i, note: 'x'.repeat(50) });
    const cap = await outbox.enforceCap();
    expect(cap.overCap).toBe(true);
    expect(cap.merges).toBe(0);
    expect(await outbox.pending('ping')).toHaveLength(20);
  });

  it('under the cap is a no-op', async () => {
    const { outbox } = mk();
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    expect(await outbox.enforceCap()).toMatchObject({ merges: 0, overCap: false });
  });

  it('merged row keeps the oldest seq (ordering preserved) and gets a fresh id', async () => {
    const { outbox } = mk({ capBytes: 1 });
    const a = await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    await outbox.enforceCap();
    const [m] = await outbox.pending('depth_batch');
    expect(m!.seq).toBe(a.seq);
    expect(m!.id).not.toBe(a.id);
  });
});

import { chunkId, chunkRows, isMergeable, soundingBatchId } from '../src/lib/outbox';
import { Mutex } from '../src/lib/mutex';
import { DEPTH_BATCH_MAX_ROWS } from '@clearwater/shared';

describe('rows that were ever attempted are never merged or re-id\'d (no double counting)', () => {
  it('coalesce at flush leaves an attempted depth row alone, with its id', async () => {
    const { outbox, store } = mk();
    const a = await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    await outbox.flush(recorder(503).send); // a is attempted (maybe the server got it)
    const b = await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    const c = await outbox.enqueue('depth_batch', { rows: [depthRow(1)] });
    const { calls, send } = recorder();
    await outbox.flush(send);
    const ids = calls.filter((x) => x.kind === 'depth_batch').map((x) => x.items[0]!.id);
    expect(ids[0]).toBe(a.id); // retried under the ORIGINAL id => server dedupes
    expect(ids).not.toContain(b.id); // b+c were merged together (never sent) under a fresh id, not into a
    expect(ids).not.toContain(c.id);
    const aRows = (calls.find((x) => x.items[0]!.id === a.id)!.items[0]!.payload as { rows: DepthUploadRow[] }).rows;
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.n).toBe(5);
    expect(await store.get(a.id)).not.toBeNull();
  });

  it('enforceCap never touches attempted rows', async () => {
    const { outbox } = mk({ capBytes: 1 });
    const a = await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    await outbox.flush(recorder(500).send);
    const b = await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    const cap = await outbox.enforceCap();
    expect(cap.merges).toBe(0); // only b is mergeable: nothing to merge it with
    expect(cap.overCap).toBe(true);
    expect((await outbox.pending('depth_batch')).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(isMergeable((await outbox.pending('depth_batch'))[0]!)).toBe(false);
  });

  it('enqueue with an explicit id is idempotent', async () => {
    const { outbox } = mk();
    const a = await outbox.enqueue('depth_batch', { rows: [depthRow(0)] }, { id: 'fixed' });
    const again = await outbox.enqueue('depth_batch', { rows: [depthRow(9)] }, { id: 'fixed' });
    expect(again.seq).toBe(a.seq);
    expect(await outbox.pending('depth_batch')).toHaveLength(1);
  });
});

describe('auth, silent votes, visible failures', () => {
  it('401 pauses flush (authRequired), leaves rows pending with NO attempt counted, nothing marked failed', async () => {
    const { outbox } = mk();
    await outbox.enqueue('ping', {});
    await outbox.enqueue('depth_batch', { rows: [depthRow(0)] });
    const { calls, send } = recorder(401);
    const r = await outbox.flush(send);
    expect(r.authRequired).toBe(true);
    expect(r.stopped).toBe(true);
    expect(calls).toHaveLength(1); // stopped at the first 401
    const pending = await outbox.pending();
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.attempts === 0 && p.status === 'pending')).toBe(true);
    expect(await outbox.failed()).toHaveLength(0);
    // after sign-in the same rows go through
    const ok = await outbox.flush(recorder(200).send);
    expect(ok.authRequired).toBe(false);
    expect(ok.sent).toBe(2);
  });

  it.each(['confirm_ineligible', 'cannot_vote_own_ping', 'ping_not_found'])('403 %s on a vote is swallowed silently', async (code) => {
    const { outbox } = mk();
    await outbox.enqueue('vote', { v: 1 });
    const r = await outbox.flush(async () => ({ status: 403, code }));
    expect(r.swallowed).toBe(1);
    expect(r.failed).toBe(0);
    expect(await outbox.pending()).toHaveLength(0);
    expect(await outbox.failed()).toHaveLength(0);
  });

  it('other 4xx become visible failures that keep the pending mark and can be retried', async () => {
    const { outbox } = mk();
    const p = await outbox.enqueue('ping', {}, { id: 'ping-x' });
    const v = await outbox.enqueue('vote', {});
    await outbox.flush(async (b) => (b.kind === 'ping' ? { status: 422 } : { status: 403, code: 'something_else' }));
    expect((await outbox.failed()).map((r) => r.id).sort()).toEqual([p.id, v.id].sort());
    expect((await outbox.pendingIds('ping')).has(p.id)).toBe(false);
    expect((await outbox.unsyncedIds('ping')).has(p.id)).toBe(true); // still shows "pending sync"
    expect(await outbox.retryFailed()).toBe(2);
    expect(await outbox.failed()).toHaveLength(0);
    const r = await outbox.flush(recorder(200).send);
    expect(r.sent).toBe(2);
  });
});

describe('depth batches over 5000 rows are chunked at send time with stable ids', () => {
  const bigRows = (n: number): DepthUploadRow[] =>
    Array.from({ length: n }, (_, i) => ({ h3_cell: latLngToCell(48 + Math.floor(i / 1000) * 0.05, -122 + (i % 1000) * 0.0005, 12), day: '2026-10-09', median_ft: 5, p10_ft: 4, n: 2 }));

  it('splits 12 000 rows into 5000/5000/2000 sequential requests; row marked sent only after all', async () => {
    const { outbox } = mk({ maxDepthRowsPerBatch: 20000 });
    const rows = bigRows(12_000);
    const unique = new Set(rows.map((r) => r.h3_cell)).size;
    const row = await outbox.enqueue('depth_batch', { rows });
    const { calls, send } = recorder();
    await outbox.flush(send);
    const depth = calls.filter((c) => c.kind === 'depth_batch');
    expect(depth.map((c) => (c.items[0]!.payload as { rows: unknown[] }).rows.length)).toEqual([5000, 5000, unique - 10_000]);
    expect(depth.every((c) => (c.items[0]!.payload as { rows: unknown[] }).rows.length <= DEPTH_BATCH_MAX_ROWS)).toBe(true);
    expect(depth[0]!.items[0]!.id).toBe(row.id);
    expect(new Set(depth.map((c) => c.items[0]!.id)).size).toBe(3);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('a mid-way failure leaves the row pending; the retry resends the SAME chunk ids', async () => {
    const { outbox } = mk({ maxDepthRowsPerBatch: 20000 });
    await outbox.enqueue('depth_batch', { rows: bigRows(6000) });
    let n = 0;
    const first: string[] = [];
    await outbox.flush(async (b) => {
      first.push(b.items[0]!.id);
      return { status: ++n === 2 ? 503 : 200 };
    });
    expect(await outbox.pending('depth_batch')).toHaveLength(1);
    const second: string[] = [];
    await outbox.flush(async (b) => {
      second.push(b.items[0]!.id);
      return { status: 200 };
    });
    expect(second).toEqual(first);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('chunk helpers', () => {
    expect(chunkRows([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkRows([], 2)).toEqual([[]]);
    expect(chunkId('abc-0000', 0)).toBe('abc-0000');
    expect(chunkId('11111111-1111-4111-8111-111111111111', 2)).toBe('11111111-1111-4111-8111-111111110002');
  });
});

describe('deterministic sounding batch ids + mutex', () => {
  const install = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('same range => same id; different range or install => different; valid UUID shape', () => {
    const a = soundingBatchId(install, 10, 500);
    expect(a).toBe(soundingBatchId(install, 10, 500));
    expect(a).not.toBe(soundingBatchId(install, 10, 501));
    expect(a).not.toBe(soundingBatchId('1f8fad5b-d9cb-469f-a165-70867728950e', 10, 500));
    expect(a).toMatch(UUID_RE);
  });
  it('Mutex serializes overlapping critical sections (no interleaving, even when one throws)', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const task = (name: string, fail = false) =>
      m.runExclusive(async () => {
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`${name}:end`);
        if (fail) throw new Error('boom');
      });
    const results = await Promise.allSettled([task('a'), task('b', true), task('c')]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
