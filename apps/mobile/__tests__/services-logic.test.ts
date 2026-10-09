import type { Ping, PingVote, TideStation } from '@clearwater/shared';
import { staleVersionDirs, verifyDownload, versionDirName } from '../src/lib/downloadVerify';
import { REPORT_RETRY_BACKOFF_MS, decidePositionReport } from '../src/lib/positionReport';
import { optimisticVote, normalizeVoteRow, reputationsKnown, voteRowKey, visiblePings, voteAvailability } from '../src/lib/pingModel';
import { fallbackScore } from '../src/lib/score';
import { REFERENCE_TIDE_STATIONS } from '../src/lib/stations';
import { mergeStationRegistry } from '../src/lib/tideStations';
import { nearestStation } from '../src/lib/tide';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;
const ping = (over: Partial<Ping> = {}): Ping => ({
  id: 'p1', author_id: 'a', group_id: null, type: 'log', lat: 48, lon: -122, note: null,
  created_at: new Date(NOW - 2 * H).toISOString(), expires_at: null, score: null, tide_ft: null, ...over,
});
const vote = (over: Partial<PingVote> = {}): PingVote => ({
  ping_id: 'p1', vote: 1, created_at: new Date(NOW - H).toISOString(), ...over,
});

describe('scoring uses feed reputations, never a bare 1.0', () => {
  it('with author + voter reputations the full formula runs (rep 2.0 author, confirm from rep 1.5 voter 100 m away)', () => {
    const p = ping({ author_reputation: 2 });
    const [s] = visiblePings([p], new Map([['p1', [vote({ voter_reputation: 1.5, weight: 1 })]]]), NOW);
    // t_last = vote at -1h; S = 2 * (1 + 1.5) * 2^(-1/24)
    expect(s!.summary.score).toBeCloseTo(2 * 2.5 * Math.pow(0.5, 1 / 24), 10);
    expect(s!.scoreIsFallback).toBe(false);
    expect(s!.summary.confirms).toBe(1);
  });

  it('missing reputation => cached server score decayed since updated_at', () => {
    const p = ping({ score: 2.0, updated_at: new Date(NOW - 24 * H).toISOString() });
    const [s] = visiblePings([p], new Map(), NOW);
    expect(s!.scoreIsFallback).toBe(true);
    expect(s!.summary.score).toBeCloseTo(1.0, 10); // 2.0 * 0.5
    expect(s!.summary.state).toBe('normal');
    expect(fallbackScore(2, new Date(NOW - 48 * H).toISOString(), NOW)).toBeCloseTo(0.5, 10);
  });

  it('a vote without the server weight also triggers the fallback', () => {
    const p = ping({ author_reputation: 1, score: 3, updated_at: new Date(NOW).toISOString() });
    expect(reputationsKnown(p, [vote({ voter_reputation: 1 })])).toBe(false);
    expect(reputationsKnown(p, [vote({ voter_reputation: 1, weight: 0.5 })])).toBe(true);
  });

  it('the feed weight is used as-is (0.5), and received_at earlier than created_at starts the decay', () => {
    const p = ping({ author_reputation: 1, created_at: new Date(NOW + 10 * H).toISOString(), received_at: new Date(NOW - 24 * H).toISOString() });
    const [s] = visiblePings([p], new Map([['p1', [vote({ voter_reputation: 2, weight: 0.5, created_at: new Date(NOW - 24 * H).toISOString() })]]]), NOW);
    expect(s!.summary.score).toBeCloseTo(1 * (1 + 2 * 0.5) * 0.5, 10);
  });

  it('a voter without reputation also triggers the fallback (author rep alone is not enough)', () => {
    const p = ping({ author_reputation: 1, score: 3, updated_at: new Date(NOW).toISOString() });
    expect(reputationsKnown(p, [vote()])).toBe(false);
    const [s] = visiblePings([p], new Map([['p1', [vote()]]]), NOW);
    expect(s!.scoreIsFallback).toBe(true);
    expect(s!.summary.score).toBeCloseTo(3, 10);
    expect(s!.summary.state).toBe('solid');
  });

  it('no reputation and no cached score => hidden unless the ping is ours and unsynced (not shown at 1.0 by default)', () => {
    expect(visiblePings([ping()], new Map(), NOW)).toHaveLength(0);
    const mine = visiblePings([ping()], new Map(), NOW, new Set(['p1']));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.pendingSync).toBe(true);
  });

  it('old fallback-scored pings fade out (decay applies to the cached value)', () => {
    const p = ping({ score: 1, updated_at: new Date(NOW - 60 * H).toISOString() });
    expect(visiblePings([p], new Map(), NOW)).toHaveLength(0);
  });

  it('vote rows normalize with voter_reputation from ping_votes_feed', () => {
    const row = normalizeVoteRow({ ping_id: 'p', vote: -1, created_at: 'x', voter_reputation: 0.7, weight: 0.5, voter_id: 'leak', voter_dist_m: 12 })!;
    expect(row).toEqual({ ping_id: 'p', vote: -1, created_at: 'x', voter_reputation: 0.7, weight: 0.5 }); // identity/distance never kept
    expect(normalizeVoteRow({ ping_id: 'p', vote: 2, created_at: 'x' })).toBeNull();
    expect(voteRowKey({ ping_id: 'p', created_at: 'x', vote: 1, voter_reputation: 1, weight: 1 })).not.toBe(voteRowKey({ ping_id: 'p', created_at: 'x', vote: -1, voter_reputation: 1, weight: 1 }));
  });
});

describe('vote availability + optimistic vote', () => {
  it('no voting on own ping or unsynced ping or twice; confirm needs <= 500 m; dispute always allowed', () => {
    const base = { isOwn: false, pendingSync: false, alreadyVoted: false, distanceToPingM: 120 };
    expect(voteAvailability(base)).toEqual({ confirm: true, dispute: true, reason: null });
    expect(voteAvailability({ ...base, isOwn: true })).toMatchObject({ confirm: false, dispute: false });
    expect(voteAvailability({ ...base, pendingSync: true })).toMatchObject({ confirm: false, dispute: false });
    expect(voteAvailability({ ...base, alreadyVoted: true })).toMatchObject({ confirm: false, dispute: false });
    expect(voteAvailability({ ...base, distanceToPingM: 501 })).toMatchObject({ confirm: false, dispute: true });
    expect(voteAvailability({ ...base, distanceToPingM: null })).toMatchObject({ confirm: false, dispute: true });
  });
  it('optimistic own-vote row carries only ping, vote and time (no distance, no voter id)', () => {
    const v = optimisticVote('p1', 1, NOW);
    expect(v).toEqual({ ping_id: 'p1', vote: 1, created_at: new Date(NOW).toISOString() });
  });
});

describe('position reporter policy: backoff and in-flight guard', () => {
  const ctx = { nowMs: 10 * 60_000, sharingEnabled: true, appForeground: true, position: { lat: 48.3, lon: -122.5 } };
  it('in-flight blocks; recent failed attempt backs off; success path unaffected', () => {
    expect(decidePositionReport({ lastReportMs: null, inFlight: true }, ctx)).toEqual({ report: false, reason: 'in_flight' });
    expect(decidePositionReport({ lastReportMs: null, lastAttemptMs: ctx.nowMs - REPORT_RETRY_BACKOFF_MS + 1 }, ctx)).toEqual({ report: false, reason: 'backoff' });
    expect(decidePositionReport({ lastReportMs: null, lastAttemptMs: ctx.nowMs - REPORT_RETRY_BACKOFF_MS }, ctx).report).toBe(true);
    expect(decidePositionReport({ lastReportMs: ctx.nowMs - 60_000 }, ctx)).toEqual({ report: false, reason: 'too_soon' });
  });
});

describe('download verification', () => {
  it('rejects HTTP error bodies even though the file was written', () => {
    expect(verifyDownload({ status: 403, expectedBytes: 100, actualBytes: 100 })).toMatchObject({ ok: false, reason: 'HTTP 403', retryable: false });
    expect(verifyDownload({ status: 404, expectedBytes: 0, actualBytes: 20 })).toMatchObject({ ok: false });
    expect(verifyDownload({ status: 503, expectedBytes: 0, actualBytes: 20 })).toMatchObject({ ok: false, retryable: true });
    expect(verifyDownload({ status: undefined, expectedBytes: 0, actualBytes: null })).toMatchObject({ ok: false, retryable: true });
  });
  it('accepts 200/206 and checks size when the index knows it', () => {
    expect(verifyDownload({ status: 200, expectedBytes: 100, actualBytes: 100 })).toEqual({ ok: true });
    expect(verifyDownload({ status: 206, expectedBytes: 100, actualBytes: 100 })).toEqual({ ok: true });
    expect(verifyDownload({ status: 200, expectedBytes: 100, actualBytes: 99 })).toMatchObject({ ok: false });
    expect(verifyDownload({ status: 200, expectedBytes: 100, actualBytes: null })).toMatchObject({ ok: false });
    expect(verifyDownload({ status: 200, expectedBytes: 0, actualBytes: 12345 })).toEqual({ ok: true }); // depth_meta: size unknown
  });
  it('stale version dirs exclude the installed one', () => {
    const keep = versionDirName('2026-10-09T00:00:00Z');
    expect(keep).toBe('2026-10-09T00_00_00Z');
    expect(staleVersionDirs(['2026-09-01T00_00_00Z/', keep, '2026-08-01T00_00_00Z'], keep)).toEqual(['2026-09-01T00_00_00Z', '2026-08-01T00_00_00Z']);
  });
});

describe('tide station registry from cached JSON lat/lon', () => {
  it('cached coordinates win over bundled approximations; extra cached stations are pickable', () => {
    const reg = mergeStationRegistry(REFERENCE_TIDE_STATIONS, [
      { station_id: '9447130', name: 'Seattle', lat: 47.0, lon: -122.0 },
      { station_id: 'LACONNER', name: 'La Conner', lat: 48.3911, lon: -122.4985 },
      { station_id: 'NOCOORDS', name: 'No coords' },
    ]);
    expect(reg.find((s: TideStation) => s.station_id === '9447130')!.lat).toBe(47.0);
    expect(reg.find((s) => s.station_id === 'NOCOORDS')).toBeUndefined();
    expect(nearestStation(reg, { lat: 48.33, lon: -122.5 })!.station.station_id).toBe('LACONNER');
    expect(mergeStationRegistry(REFERENCE_TIDE_STATIONS, [])).toHaveLength(REFERENCE_TIDE_STATIONS.length);
  });
});
