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
