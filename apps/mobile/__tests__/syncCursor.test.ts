import {
  advanceCursor,
  aoiBanner,
  aoiStaleness,
  dedupeById,
  isTideStale,
  planSync,
  pullSpecs,
} from '../src/lib/syncCursor';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('cursors', () => {
  it('advances to the newest updated_at and never moves backwards', () => {
    const rows = [{ updated_at: '2026-10-09T10:00:00Z' }, { updated_at: '2026-10-09T11:00:00Z' }, { updated_at: '2026-10-09T09:00:00Z' }];
    expect(advanceCursor(undefined, rows)).toBe('2026-10-09T11:00:00Z');
    expect(advanceCursor('2026-10-10T00:00:00Z', rows)).toBe('2026-10-10T00:00:00Z');
    expect(advanceCursor('2026-10-09T10:30:00Z', rows)).toBe('2026-10-09T11:00:00Z');
  });
  it('ignores rows with missing or garbage stamps; empty keeps previous', () => {
    expect(advanceCursor('2026-10-09T10:00:00Z', [{ updated_at: null }, { updated_at: 'nope' }, {}])).toBe('2026-10-09T10:00:00Z');
    expect(advanceCursor(undefined, [])).toBeUndefined();
  });
  it('builds one inclusive pull per table (first sync has null bounds)', () => {
    expect(pullSpecs({})).toEqual([
      { table: 'pings', updatedAtGte: null },
      { table: 'ping_votes', updatedAtGte: null },
      { table: 'messages', updatedAtGte: null },
    ]);
    expect(pullSpecs({ pings: '2026-10-09T10:00:00Z' })[0]).toEqual({ table: 'pings', updatedAtGte: '2026-10-09T10:00:00Z' });
  });
  it('dedupeById keeps the newest version of overlapping rows', () => {
    const out = dedupeById([
      { id: 'a', updated_at: '2026-10-09T10:00:00Z', v: 1 },
      { id: 'a', updated_at: '2026-10-09T11:00:00Z', v: 2 },
      { id: 'a', updated_at: '2026-10-09T10:30:00Z', v: 3 },
      { id: 'b', updated_at: '2026-10-09T10:00:00Z', v: 4 },
    ]);
    expect(out.find((r) => r.id === 'a')!.v).toBe(2);
    expect(out).toHaveLength(2);
  });
});

describe('tide staleness (> 24 h)', () => {
  it('fresh within 24 h, stale after, stale when never fetched', () => {
    expect(isTideStale(hoursAgo(23.9), NOW)).toBe(false);
    expect(isTideStale(hoursAgo(24), NOW)).toBe(false);
    expect(isTideStale(hoursAgo(24.1), NOW)).toBe(true);
    expect(isTideStale(null, NOW)).toBe(true);
    expect(isTideStale('garbage', NOW)).toBe(true);
  });
});

describe('AOI staleness banners (14 / 60 days)', () => {
  it.each([
    [0, 'fresh'],
    [14, 'fresh'],
    [14.5, 'yellow'],
    [30, 'yellow'],
    [60, 'yellow'],
    [60.5, 'red'],
    [200, 'red'],
  ])('%s days => %s', (days, level) => {
    expect(aoiStaleness(ago(days), NOW)).toBe(level);
  });
  it('unknown date is red', () => {
    expect(aoiStaleness(null, NOW)).toBe('red');
  });
  it('banner text and null when fresh', () => {
    expect(aoiBanner('Skagit', ago(3), NOW)).toBeNull();
    const y = aoiBanner('Skagit', ago(20), NOW)!;
    expect(y.level).toBe('yellow');
    expect(y.ageDays).toBe(20);
    expect(y.message).toContain('20 days');
    expect(aoiBanner('Skagit', ago(90), NOW)!.level).toBe('red');
    expect(aoiBanner('Skagit', undefined, NOW)!.ageDays).toBeNull();
  });
});

describe('planSync', () => {
  it('refreshes only stale or missing tide stations and always pulls the tiles index', () => {
    const plan = planSync({
      cursors: { pings: '2026-10-09T10:00:00Z' },
      tideFetchedAt: { '9447130': hoursAgo(2), '9444900': hoursAgo(30) },
      tideStations: ['9447130', '9444900', '9449880'],
      nowMs: NOW,
    });
    expect(plan.tideStationsToRefresh).toEqual(['9444900', '9449880']);
    expect(plan.pullTilesIndex).toBe(true);
    expect(plan.pulls).toHaveLength(3);
  });
});
