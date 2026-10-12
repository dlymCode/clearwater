import {
  aoiBanner,
  aoiStaleness,
  isTideStale,
  planSync,
  pullSpecs,
} from '../src/lib/syncCursor';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('pull specs', () => {
  it('one spec per feed source with its cursor column and keyset tie-breaker', () => {
    expect(pullSpecs({})).toEqual([
      { table: 'pings', relation: 'ping_feed', cursorColumn: 'updated_at', tieColumn: 'id', gte: null },
      { table: 'messages', relation: 'messages_feed', cursorColumn: 'received_at', tieColumn: 'id', gte: null },
    ]);
    expect(pullSpecs({ pings: '2026-10-09T10:00:00Z' })[0]).toMatchObject({ table: 'pings', gte: '2026-10-09T10:00:00Z' });
  });
  it('there is no per-vote source (a vote feed de-anonymizes voters)', () => {
    expect(pullSpecs({}).map((x) => x.relation)).not.toContain('ping_votes_feed');
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
    expect(plan.pulls).toHaveLength(2);
  });
});
