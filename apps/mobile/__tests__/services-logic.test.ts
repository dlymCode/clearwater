import type { Ping, TideStation } from '@clearwater/shared';
import { staleVersionDirs, verifyDownload, versionDirName } from '../src/lib/downloadVerify';
import { REPORT_RETRY_BACKOFF_MS, REJECTED_RESUME_DISTANCE_M, decidePositionReport, inCoverage } from '../src/lib/positionReport';
import { optimisticVote, scoreInputsKnown, visiblePings, voteAvailability } from '../src/lib/pingModel';
import { fallbackScore } from '../src/lib/score';
import { REFERENCE_TIDE_STATIONS, mergeStationRegistry } from '../src/lib/stations';
import { nearestStation } from '../src/lib/tide';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;
const ping = (over: Partial<Ping> = {}): Ping => ({
  id: 'p1', author_id: 'a', group_id: null, type: 'log', lat: 48, lon: -122, note: null,
  created_at: new Date(NOW - 2 * H).toISOString(), expires_at: null, score: null, tide_ft: null, ...over,
});

describe('scoring uses ping_feed aggregates, never a bare 1.0', () => {
  it('author_reputation + vote_sum run the full formula (rep 2.0, vote_sum 1.5, confirmed 1 h ago)', () => {
    const p = ping({ author_reputation: 2, vote_sum: 1.5, last_confirmed_at: new Date(NOW - H).toISOString(), confirm_count: 1, dispute_count: 0 });
    const [s] = visiblePings([p], NOW);
    expect(s!.summary.score).toBeCloseTo(2 * 2.5 * Math.pow(0.5, 1 / 24), 10);
    expect(s!.scoreIsFallback).toBe(false);
    expect(s!.summary.confirms).toBe(1);
  });

  it('missing reputation => cached server score decayed since updated_at', () => {
    const p = ping({ score: 2.0, updated_at: new Date(NOW - 24 * H).toISOString(), confirm_count: 3 });
    const [s] = visiblePings([p], NOW);
    expect(s!.scoreIsFallback).toBe(true);
    expect(s!.summary.score).toBeCloseTo(1.0, 10);
    expect(s!.summary.state).toBe('normal');
    expect(s!.summary.confirms).toBe(3);
    expect(fallbackScore(2, new Date(NOW - 48 * H).toISOString(), NOW)).toBeCloseTo(0.5, 10);
  });

  it('reputation without vote_sum (or vice versa) also takes the fallback', () => {
    expect(scoreInputsKnown(ping({ author_reputation: 1 }))).toBe(false);
    expect(scoreInputsKnown(ping({ vote_sum: 0 }))).toBe(false);
    expect(scoreInputsKnown(ping({ author_reputation: 1, vote_sum: 0 }))).toBe(true);
    const p = ping({ author_reputation: 1, score: 3, updated_at: new Date(NOW).toISOString() });
    const [s] = visiblePings([p], NOW);
    expect(s!.scoreIsFallback).toBe(true);
    expect(s!.summary.score).toBeCloseTo(3, 10);
    expect(s!.summary.state).toBe('solid');
  });

  it('no reputation and no cached score => hidden unless the ping is ours and unsynced', () => {
    expect(visiblePings([ping()], NOW)).toHaveLength(0);
    const mine = visiblePings([ping()], NOW, new Set(['p1']));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.pendingSync).toBe(true);
  });

  it('old fallback-scored pings fade out', () => {
    expect(visiblePings([ping({ score: 1, updated_at: new Date(NOW - 60 * H).toISOString() })], NOW)).toHaveLength(0);
  });

  it('received_at earlier than created_at starts the decay (future-dated ping cannot stay solid)', () => {
    const p = ping({
      author_reputation: 1, vote_sum: 1,
      created_at: new Date(NOW + 10 * H).toISOString(), received_at: new Date(NOW - 24 * H).toISOString(),
    });
    const [s] = visiblePings([p], NOW);
    expect(s!.summary.score).toBeCloseTo(1 * 2 * 0.5, 10);
  });

  it('an unparsable cached timestamp never yields a solid ping', () => {
    const p = ping({ score: 5, updated_at: 'garbage', created_at: 'garbage' });
    expect(visiblePings([p], NOW)).toHaveLength(0);
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

describe('position reporter policy: backoff, in-flight guard, coverage', () => {
  const ctx = { nowMs: 10 * 60_000, sharingEnabled: true, appForeground: true, position: { lat: 48.3, lon: -122.5 } };
  it('in-flight blocks; recent failed attempt backs off; success path unaffected', () => {
    expect(decidePositionReport({ lastReportMs: null, inFlight: true }, ctx)).toEqual({ report: false, reason: 'in_flight' });
    expect(decidePositionReport({ lastReportMs: null, lastAttemptMs: ctx.nowMs - REPORT_RETRY_BACKOFF_MS + 1 }, ctx)).toEqual({ report: false, reason: 'backoff' });
    expect(decidePositionReport({ lastReportMs: null, lastAttemptMs: ctx.nowMs - REPORT_RETRY_BACKOFF_MS }, ctx).report).toBe(true);
    expect(decidePositionReport({ lastReportMs: ctx.nowMs - 60_000 }, ctx)).toEqual({ report: false, reason: 'too_soon' });
  });
  it('A6: outside the Salish Sea box it never asks; a server rejection pauses until the boat has moved', () => {
    expect(inCoverage({ lat: 48.3, lon: -122.5 })).toBe(true);
    expect(inCoverage({ lat: 40, lon: -100 })).toBe(false);
    expect(decidePositionReport({ lastReportMs: null }, { ...ctx, position: { lat: 40, lon: -100 } })).toEqual({ report: false, reason: 'outside_coverage' });
    const rejectedAt = { lat: 48.3, lon: -122.5 };
    expect(decidePositionReport({ lastReportMs: null, rejectedAt }, ctx)).toEqual({ report: false, reason: 'outside_coverage' });
    const moved = { lat: 48.3 + (REJECTED_RESUME_DISTANCE_M + 100) / 111_320, lon: -122.5 };
    expect(decidePositionReport({ lastReportMs: null, rejectedAt }, { ...ctx, position: moved }).report).toBe(true);
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
  it('stale version dirs ignore anything that is not a plain directory name (no traversal)', () => {
    expect(staleVersionDirs(['..', '../x', 'a/b', '.hidden', 'ok_dir'], 'keep')).toEqual(['ok_dir']);
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

import { isSafeAoiSlug, isSafeSegment, isSafeTilePath, safeFileName } from '../src/lib/downloadVerify';
import { retryableStatus } from '../src/lib/http';
import { canWrite, validateProfile } from '../src/lib/profile';

describe('A2: profile capture + write gate', () => {
  it('handle must match the profiles check (3-24 of [A-Za-z0-9_.-]); vessel optional, <= 60', () => {
    expect(validateProfile('Pete_K', '')).toEqual({ ok: true, value: { handle: 'Pete_K', vessel_name: null } });
    expect(validateProfile(' dockhand.7 ', ' F/V Ranger ')).toEqual({ ok: true, value: { handle: 'dockhand.7', vessel_name: 'F/V Ranger' } });
    for (const bad of ['ab', 'a'.repeat(25), 'has space', 'émile', 'semi;colon', '']) expect(validateProfile(bad, '').ok).toBe(false);
    expect(validateProfile('okhandle', 'v'.repeat(61)).ok).toBe(false);
    expect(validateProfile('okhandle', 'v'.repeat(60)).ok).toBe(true);
  });
  it('pings / votes / joins stay blocked until the profile exists, and when the account is revoked', () => {
    expect(canWrite({ profileReady: false, accountRevoked: false }).ok).toBe(false);
    expect(canWrite({ profileReady: true, accountRevoked: true }).ok).toBe(false);
    expect(canWrite({ profileReady: true, accountRevoked: false })).toEqual({ ok: true });
  });
});

describe('retryable status (single definition)', () => {
  it('timeouts, throttling and server errors retry; other 4xx are permanent', () => {
    for (const s of [408, 429, 500, 502, 503, 599, undefined]) expect(retryableStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422]) expect(retryableStatus(s)).toBe(false);
  });
});

describe('path safety (hostile index cannot reach the filesystem)', () => {
  it('segments', () => {
    for (const ok of ['v1', '2026-10-09T00:00:00Z', 'a.b_c-d']) expect(isSafeSegment(ok)).toBe(true);
    for (const bad of ['..', '../x', 'a/b', '.hidden', '', 'a\\b', 'a..b', 'x'.repeat(200), 3, null]) expect(isSafeSegment(bad)).toBe(false);
  });
  it('aoi slugs', () => {
    expect(isSafeAoiSlug('port_susan')).toBe(true);
    for (const bad of ['Skagit', '../a', 'a/b', '', '9lives', 'a b']) expect(isSafeAoiSlug(bad)).toBe(false);
  });
  it('tile paths: exactly tiles/<aoi>/<version>/<file>.(pmtiles|geojson|json)', () => {
    expect(isSafeTilePath('tiles/skagit/2026-10-09T00:00:00Z/base.pmtiles')).toBe(true);
    expect(safeFileName('tiles/skagit/v1/regions.geojson')).toBe('regions.geojson');
    for (const bad of [
      '../tiles/skagit/v1/base.pmtiles', 'tiles/skagit/../x/base.pmtiles', 'tiles/skagit/v1/../../base.pmtiles', '/tiles/skagit/v1/base.pmtiles',
      'tiles/skagit/v1/base.sh', 'tiles/skagit/v1/.pmtiles', 'tiles/skagit/v1/a/b.pmtiles', 'tiles/Skagit/v1/base.pmtiles', 'files/skagit/v1/base.pmtiles', 'tiles/skagit/v1/b\\ase.pmtiles',
    ]) {
      expect(isSafeTilePath(bad)).toBe(false);
      expect(safeFileName(bad)).toBeNull();
    }
  });
});
