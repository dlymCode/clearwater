import { SYNC_SOURCES, SYNC_TABLES } from '@clearwater/shared';
import { pullAll, type LocalSink, type RemoteReader, type Row, type SelectQuery } from '../src/lib/pullSync';

/** Fake PostgREST that knows each relation's real columns (mirrors supabase/migrations). */
const SCHEMA: Record<string, string[]> = {
  ping_feed: ['id', 'author_id', 'author_handle', 'author_reputation', 'group_id', 'type', 'geom', 'created_at', 'received_at', 'score', 'updated_at'],
  ping_votes_feed: ['ping_id', 'vote', 'created_at', 'voter_reputation', 'weight'], // voter_id / distance NOT exposed
  ping_votes: ['ping_id', 'voter_id', 'vote', 'voter_dist_m', 'created_at'],
  messages: ['id', 'group_id', 'author_id', 'body', 'ping_id', 'created_at', 'received_at'],
};

class FakePostgrest implements RemoteReader {
  calls: Array<{ relation: string } & SelectQuery> = [];
  constructor(private readonly data: Record<string, Row[]>, private readonly failRelations: string[] = []) {}
  async select(relation: string, q: SelectQuery) {
    this.calls.push({ relation, ...q });
    if (this.failRelations.includes(relation)) return { rows: [], error: 'JWT expired' };
    const cols = SCHEMA[relation];
    if (!cols) return { rows: [], error: `relation "${relation}" does not exist` };
    if (!cols.includes(q.column)) return { rows: [], error: `column ${relation}.${q.column} does not exist` };
    if (q.eq && !cols.includes(q.eq.column)) return { rows: [], error: `column ${relation}.${q.eq.column} does not exist` };
    const rows = (this.data[relation] ?? [])
      .filter((r) => !q.eq || r[q.eq.column] === q.eq.value)
      .filter((r) => Date.parse(r[q.column] as string) >= Date.parse(q.gte))
      .sort((a, b) => Date.parse(a[q.column] as string) - Date.parse(b[q.column] as string))
      .slice(0, q.limit);
    return { rows, error: null };
  }
}

class MemorySink implements LocalSink {
  rows: Record<string, Row[]> = { pings: [], ping_votes: [], messages: [], my_votes: [] };
  async upsert(table: string, rows: Row[]) {
    this.rows[table]!.push(...rows);
  }
}

const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const data = () => ({
  ping_feed: [{ id: 'p1', updated_at: iso(3), created_at: iso(5) }, { id: 'p2', updated_at: iso(1), created_at: iso(2) }],
  ping_votes_feed: [{ ping_id: 'p1', vote: 1, created_at: iso(2), voter_reputation: 1.2, weight: 1 }],
  ping_votes: [{ ping_id: 'p1', voter_id: 'me', vote: 1, voter_dist_m: 10, created_at: iso(2) }, { ping_id: 'p2', voter_id: 'other', vote: -1, voter_dist_m: 10, created_at: iso(1) }],
  messages: [{ id: 'm1', received_at: iso(30), created_at: iso(31) }],
});

describe('contract: SYNC_SOURCES cursor columns exist on the relations they read', () => {
  it.each(SYNC_TABLES)('%s', (t) => {
    const src = SYNC_SOURCES[t];
    expect(SCHEMA[src.relation]).toContain(src.cursorColumn);
  });
  it('the fake rejects the old behaviour (updated_at on votes/messages)', async () => {
    const f = new FakePostgrest(data());
    expect((await f.select('ping_votes_feed', { column: 'updated_at', gte: iso(1), limit: 1 })).error).toMatch(/does not exist/);
    expect((await f.select('messages', { column: 'updated_at', gte: iso(1), limit: 1 })).error).toMatch(/does not exist/);
  });
});

describe('pullAll: own votes', () => {
  it('pulls only MY votes from ping_votes (voter_id = me) for reconciliation, with its own cursor', async () => {
    const remote = new FakePostgrest(data());
    const sink = new MemorySink();
    const r = await pullAll(remote, sink, {}, { nowMs: NOW, userId: 'me' });
    expect(r.errors).toEqual([]);
    expect(r.pulled.my_votes).toBe(1);
    expect(sink.rows.my_votes!.map((x) => x.ping_id)).toEqual(['p1']);
    const call = remote.calls.find((c) => c.relation === 'ping_votes')!;
    expect(call.eq).toEqual({ column: 'voter_id', value: 'me' });
    expect(r.cursors.my_votes).toBe(iso(2));
  });
  it('never asks the votes FEED for voter_id', () => {
    expect(SCHEMA.ping_votes_feed).not.toContain('voter_id');
  });
});

describe('pullAll', () => {
  it('votes and messages actually arrive, via the right relation + column', async () => {
    const remote = new FakePostgrest(data());
    const sink = new MemorySink();
    const r = await pullAll(remote, sink, {}, { nowMs: NOW });
    expect(r.errors).toEqual([]);
    expect(r.pulled).toEqual({ pings: 2, ping_votes: 1, messages: 1, my_votes: 0 });
    expect(remote.calls.map((c) => [c.relation, c.column])).toEqual([
      ['ping_feed', 'updated_at'],
      ['ping_votes_feed', 'created_at'],
      ['messages', 'received_at'],
    ]);
    expect(r.cursors).toEqual({ pings: iso(1), ping_votes: iso(2), messages: iso(30) });
  });

  it('is incremental and inclusive: second pull uses the cursor, re-sees the boundary row', async () => {
    const remote = new FakePostgrest(data());
    const sink = new MemorySink();
    const first = await pullAll(remote, sink, {}, { nowMs: NOW });
    remote.calls = [];
    const second = await pullAll(remote, sink, first.cursors, { nowMs: NOW });
    expect(remote.calls.find((c) => c.relation === 'ping_feed')!.gte).toBe(iso(1));
    expect(second.pulled.pings).toBe(1); // boundary row again (upsert by id makes it harmless)
  });

  it('first sync uses a 48 h window for pings and votes, 90 days for messages', async () => {
    const remote = new FakePostgrest(data());
    await pullAll(remote, new MemorySink(), {}, { nowMs: NOW });
    expect(Date.parse(remote.calls[0]!.gte)).toBe(NOW - 48 * 3_600_000);
    expect(Date.parse(remote.calls[2]!.gte)).toBe(NOW - 90 * 24 * 3_600_000);
  });

  it('surfaces errors per table and does not advance that cursor, but keeps pulling others', async () => {
    const remote = new FakePostgrest(data(), ['ping_votes_feed']);
    const r = await pullAll(remote, new MemorySink(), { ping_votes: iso(10) }, { nowMs: NOW });
    expect(r.errors).toEqual(['ping_votes_feed: JWT expired']);
    expect(r.cursors.ping_votes).toBe(iso(10));
    expect(r.pulled.pings).toBe(2);
    expect(r.pulled.messages).toBe(1);
  });

  it('paginates until a short page', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, updated_at: new Date(NOW - (10 - i) * 60_000).toISOString(), created_at: iso(1) }));
    const remote = new FakePostgrest({ ping_feed: many });
    const sink = new MemorySink();
    const r = await pullAll(remote, sink, {}, { nowMs: NOW, pageSize: 3 });
    expect(r.errors).toEqual([]);
    expect(sink.rows.pings!.map((x) => x.id)).toEqual(expect.arrayContaining(many.map((x) => x.id)));
    expect(remote.calls.filter((c) => c.relation === 'ping_feed').length).toBeGreaterThanOrEqual(3);
    expect(r.cursors.pings).toBe(many[6]!.updated_at);
  });

  it('reports a stuck cursor instead of looping when a full page shares one timestamp', async () => {
    const same = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, updated_at: iso(1), created_at: iso(1) }));
    const remote = new FakePostgrest({ ping_feed: same });
    const r = await pullAll(remote, new MemorySink(), { pings: iso(1) }, { nowMs: NOW, pageSize: 3, maxPages: 50 });
    expect(r.errors.some((e) => e.includes('cursor stuck'))).toBe(true);
    expect(remote.calls.filter((c) => c.relation === 'ping_feed')).toHaveLength(1);
  });
});
