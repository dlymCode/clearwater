import { OWN_VOTES_SOURCE, SYNC_SOURCES, SYNC_TABLES } from '@clearwater/shared';
import { pullAll, type LocalSink, type RemoteReader, type Row, type SelectQuery } from '../src/lib/pullSync';
import type { CursorKey } from '../src/lib/syncCursor';

/** Fake PostgREST that knows each relation's real columns (mirrors supabase/migrations) and implements keyset paging. */
const SCHEMA: Record<string, string[]> = {
  ping_feed: ['id', 'author_id', 'author_handle', 'author_reputation', 'group_id', 'type', 'geom', 'created_at', 'received_at', 'score', 'updated_at', 'vote_sum', 'last_confirmed_at', 'confirm_count', 'dispute_count'],
  messages_feed: ['id', 'group_id', 'author_id', 'author_handle', 'body', 'ping_id', 'created_at', 'received_at'],
  ping_votes: ['ping_id', 'voter_id', 'vote', 'voter_dist_m', 'created_at'],
};

const t = (r: Row, c: string) => Date.parse(r[c] as string);

class FakePostgrest implements RemoteReader {
  calls: Array<{ relation: string } & SelectQuery> = [];
  constructor(private readonly data: Record<string, Row[]>, private readonly opts: { fail?: string[]; failOnCall?: number; maxRows?: number; shuffle?: boolean } = {}) {}
  async select(relation: string, q: SelectQuery) {
    this.calls.push({ relation, ...q });
    if (this.opts.fail?.includes(relation)) return { rows: [], error: 'JWT expired' };
    if (this.opts.failOnCall === this.calls.length) return { rows: [], error: '500 boom' };
    const cols = SCHEMA[relation];
    if (!cols) return { rows: [], error: `relation "${relation}" does not exist` };
    for (const c of [q.column, q.tiebreak.column, q.eq?.column].filter((x): x is string => !!x)) {
      if (!cols.includes(c)) return { rows: [], error: `column ${relation}.${c} does not exist` };
    }
    const gteMs = Date.parse(q.gte);
    let rows = (this.data[relation] ?? []).filter((r) => !q.eq || r[q.eq.column] === q.eq.value);
    rows = rows.filter((r) => {
      const v = t(r, q.column);
      if (q.tiebreak.after === null) return v >= gteMs;
      return v > gteMs || (v === gteMs && String(r[q.tiebreak.column]) > q.tiebreak.after);
    });
    if (this.opts.shuffle) rows = [...rows].sort(() => Math.random() - 0.5); // server order must not matter: we sort below
    rows.sort((a, b) => t(a, q.column) - t(b, q.column) || String(a[q.tiebreak.column]).localeCompare(String(b[q.tiebreak.column])));
    return { rows: rows.slice(0, Math.min(q.limit, this.opts.maxRows ?? Infinity)), error: null };
  }
}

class MemorySink implements LocalSink {
  rows: Record<string, Row[]> = { pings: [], messages: [], my_votes: [] };
  failOn: CursorKey | null = null;
  async upsert(table: CursorKey, rows: Row[]) {
    if (this.failOn === table) throw new Error('sqlite busy');
    this.rows[table]!.push(...rows);
  }
  ids(table: string): string[] {
    return [...new Set(this.rows[table]!.map((r) => String(r.id ?? r.ping_id)))];
  }
}

const NOW = Date.parse('2026-10-09T12:00:00Z');
const iso = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const isoMs = (ms: number) => new Date(NOW + ms).toISOString();

const data = () => ({
  ping_feed: [{ id: 'p1', updated_at: iso(3), created_at: iso(5) }, { id: 'p2', updated_at: iso(1), created_at: iso(2) }],
  messages_feed: [{ id: 'm1', received_at: iso(30), created_at: iso(31) }],
  ping_votes: [
    { ping_id: 'p1', voter_id: 'me', vote: 1, voter_dist_m: 10, created_at: iso(2) },
    { ping_id: 'p2', voter_id: 'other', vote: -1, voter_dist_m: 10, created_at: iso(1) },
  ],
});

describe('contract: sources read columns that exist', () => {
  it.each(SYNC_TABLES)('%s: cursor + tie columns exist on the relation', (tbl) => {
    const src = SYNC_SOURCES[tbl];
    expect(SCHEMA[src.relation]).toContain(src.cursorColumn);
    expect(SCHEMA[src.relation]).toContain(src.tieColumn);
  });
  it('own votes source: cursor + tie + voter_id filter columns exist', () => {
    expect(SCHEMA[OWN_VOTES_SOURCE.relation]).toEqual(expect.arrayContaining([OWN_VOTES_SOURCE.cursorColumn, OWN_VOTES_SOURCE.tieColumn, 'voter_id']));
  });
  it('the fake rejects the old behaviour (updated_at on messages)', async () => {
    const f = new FakePostgrest(data());
    expect((await f.select('messages_feed', { column: 'updated_at', gte: iso(1), limit: 1, tiebreak: { column: 'id', after: null } })).error).toMatch(/does not exist/);
  });
});

describe('pullAll basics', () => {
  it('pings and messages arrive via the right relation, column and tie-breaker', async () => {
    const remote = new FakePostgrest(data());
    const sink = new MemorySink();
    const r = await pullAll(remote, sink, {}, { nowMs: NOW });
    expect(r.errors).toEqual([]);
    expect(r.pulled).toEqual({ pings: 2, messages: 1, my_votes: 0 });
    expect(remote.calls.map((c) => [c.relation, c.column, c.tiebreak.column])).toEqual([
      ['ping_feed', 'updated_at', 'id'],
      ['messages_feed', 'received_at', 'id'],
    ]);
    expect(r.cursors).toEqual({ pings: iso(1), messages: iso(30) });
    expect(r.keys).toEqual({ pings: 'p2', messages: 'm1' });
  });

  it('is strictly incremental: the second pull starts after the (cursor, key) pair and sees nothing new', async () => {
    const remote = new FakePostgrest(data());
    const sink = new MemorySink();
    const first = await pullAll(remote, sink, {}, { nowMs: NOW });
    remote.calls = [];
    const second = await pullAll(remote, sink, first.cursors, { nowMs: NOW, keys: first.keys });
    expect(remote.calls[0]!.tiebreak.after).toBe('p2');
    expect(remote.calls[0]!.gte).toBe(iso(1));
    expect(second.pulled).toEqual({ pings: 0, messages: 0, my_votes: 0 });
  });

  it('first sync window: 48 h for pings, 90 days for messages', async () => {
    const remote = new FakePostgrest(data());
    await pullAll(remote, new MemorySink(), {}, { nowMs: NOW });
    expect(Date.parse(remote.calls[0]!.gte)).toBe(NOW - 48 * 3_600_000);
    expect(remote.calls[0]!.tiebreak.after).toBeNull();
    expect(Date.parse(remote.calls[1]!.gte)).toBe(NOW - 90 * 24 * 3_600_000);
  });

  it('surfaces errors per source, does not advance that cursor, and keeps pulling the others', async () => {
    const remote = new FakePostgrest(data(), { fail: ['ping_feed'] });
    const r = await pullAll(remote, new MemorySink(), { pings: iso(10) }, { nowMs: NOW, keys: { pings: 'a' } });
    expect(r.errors).toEqual(['ping_feed: JWT expired']);
    expect(r.cursors.pings).toBe(iso(10));
    expect(r.keys.pings).toBe('a');
    expect(r.pulled.messages).toBe(1);
  });

  it('pulls only MY votes (voter_id = me) for reconciliation, with its own cursor', async () => {
    const remote = new FakePostgrest(data());
    const sink = new MemorySink();
    const r = await pullAll(remote, sink, {}, { nowMs: NOW, userId: 'me' });
    expect(r.errors).toEqual([]);
    expect(sink.ids('my_votes')).toEqual(['p1']);
    expect(remote.calls.find((c) => c.relation === 'ping_votes')!.eq).toEqual({ column: 'voter_id', value: 'me' });
    expect(r.cursors.my_votes).toBe(iso(2));
  });
});

describe('B2: keyset pagination drains tie groups of any size (battle 7b)', () => {
  const build = (K: number) => {
    const rows: Row[] = [];
    for (let i = 0; i < 50; i++) rows.push({ id: `a${String(i).padStart(3, '0')}`, updated_at: isoMs(-5000 + i), created_at: iso(1) });
    for (let i = 0; i < K; i++) rows.push({ id: `t${String(i).padStart(5, '0')}`, updated_at: isoMs(-1000), created_at: iso(1) }); // one transaction timestamp
    for (let i = 0; i < 50; i++) rows.push({ id: `z${String(i).padStart(3, '0')}`, updated_at: isoMs(-500 + i), created_at: iso(1) });
    return rows;
  };

  it.each([
    [30, 100], [99, 100], [100, 100], [101, 100], [250, 100], [1500, 1000], [1000, 1000], [1001, 1000],
  ])('K=%i tied rows, pageSize=%i: nothing missing, no false "stuck", completes in ONE sync', async (K, pageSize) => {
    const rows = build(K);
    const sink = new MemorySink();
    const r = await pullAll(new FakePostgrest({ ping_feed: rows }, { shuffle: true }), sink, {}, { nowMs: NOW, pageSize, maxPages: 100 });
    expect(r.errors).toEqual([]);
    expect(sink.ids('pings').sort()).toEqual(rows.map((x) => String(x.id)).sort());
    expect(r.keys.pings).toBe('z049');
  });

  it('a page boundary inside a tie group resumes at the next key, not the next timestamp', async () => {
    const rows = build(250);
    const remote = new FakePostgrest({ ping_feed: rows });
    const sink = new MemorySink();
    // two syncs of ONE page each: the cursor must carry the tie key across syncs
    let res = await pullAll(remote, sink, {}, { nowMs: NOW, pageSize: 100, maxPages: 1 });
    const seen = new Set<string>();
    for (let i = 0; i < 20 && sink.ids('pings').length < rows.length; i++) {
      res = await pullAll(remote, sink, res.cursors, { nowMs: NOW, pageSize: 100, maxPages: 1, keys: res.keys });
      for (const id of sink.ids('pings')) seen.add(id);
    }
    expect(sink.ids('pings')).toHaveLength(rows.length);
  });

  it('server max_rows below pageSize still drains (short pages continue only when full; documented limit)', async () => {
    const rows = build(10);
    const sink = new MemorySink();
    let res = await pullAll(new FakePostgrest({ ping_feed: rows }, { maxRows: 25 }), sink, {}, { nowMs: NOW, pageSize: 25, maxPages: 100 });
    expect(res.errors).toEqual([]);
    expect(sink.ids('pings')).toHaveLength(rows.length);
  });
});

describe('failure isolation (battle 7c)', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `id${String(i).padStart(3, '0')}`, updated_at: isoMs(i * 1000), created_at: iso(1) }));

  it('error on page 2: cursor stays at the last stored row', async () => {
    const sink = new MemorySink();
    const r = await pullAll(new FakePostgrest({ ping_feed: many }, { failOnCall: 2 }), sink, {}, { nowMs: NOW - 1e9, pageSize: 100 });
    expect(r.errors).toEqual(['ping_feed: 500 boom']);
    expect(r.cursors.pings).toBe(many[99]!.updated_at);
    expect(r.keys.pings).toBe('id099');
    expect(sink.ids('pings')).toHaveLength(100);
  });

  it('a throwing local sink is reported, does not advance the cursor past unsaved rows, and does not stop other sources', async () => {
    const sink = new MemorySink();
    sink.failOn = 'pings';
    const r = await pullAll(new FakePostgrest(data()), sink, {}, { nowMs: NOW });
    expect(r.errors[0]).toContain('local write failed: sqlite busy');
    expect(r.cursors.pings).toBeUndefined();
    expect(r.pulled.messages).toBe(1); // other source unaffected
  });

  it('a reader that throws is isolated per source too', async () => {
    const reader: RemoteReader = { select: async (rel) => { if (rel === 'ping_feed') throw new Error('socket hang up'); return { rows: [], error: null }; } };
    const r = await pullAll(reader, new MemorySink(), {}, { nowMs: NOW });
    expect(r.errors).toEqual(['ping_feed: socket hang up']);
  });

  it('a last row without a usable cursor value is reported and the cursor is not corrupted', async () => {
    const reader: RemoteReader = { select: async (rel) => ({ rows: rel === 'ping_feed' ? [{ id: 'x', updated_at: 'garbage', created_at: iso(1) }] : [], error: null }) };
    const r = await pullAll(reader, new MemorySink(), {}, { nowMs: NOW });
    expect(r.cursors.pings).toBeUndefined();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
