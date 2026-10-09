import { haversineM, roundPosition } from '../src/lib/geo';
import { inviteStatusText, isInviteExpired, isValidInviteCode, normalizeInviteCode, inviteExpiryFrom } from '../src/lib/groups';
import { buildMapStyle, colorReliefExpression, depthLegend, DEFAULT_TOGGLES, layersForToggle } from '../src/lib/mapStyle';
import {
  buildMessagePayload,
  buildPingPayload,
  buildVotePayload,
  canSubmitPing,
  validateMessageBody,
  validateNote,
  visiblePings,
} from '../src/lib/pingModel';
import type { Ping, PingVote } from '@clearwater/shared';
import { UUID_RE, uuidv4 } from '../src/lib/uuid';

describe('geo', () => {
  it('haversine: 0.01 deg of latitude ~ 1112 m', () => {
    expect(haversineM({ lat: 48, lon: -122 }, { lat: 48.01, lon: -122 })).toBeGreaterThan(1100);
    expect(haversineM({ lat: 48, lon: -122 }, { lat: 48.01, lon: -122 })).toBeLessThan(1125);
    expect(haversineM({ lat: 48, lon: -122 }, { lat: 48, lon: -122 })).toBe(0);
  });
  it('roundPosition snaps within ~71 m (half-diagonal of a 100 m cell) and is deterministic', () => {
    const p = { lat: 48.30837, lon: -122.50421 };
    const r = roundPosition(p);
    expect(haversineM(p, r)).toBeLessThan(75);
    expect(roundPosition(r)).toEqual(r);
    expect(roundPosition({ lat: p.lat + 0.00001, lon: p.lon + 0.00001 })).toEqual(r);
  });
  it('two positions 30 m apart in the same cell round to the same point (no track leakage)', () => {
    const a = roundPosition({ lat: 48.3084, lon: -122.5042 });
    const b = roundPosition({ lat: 48.30845, lon: -122.50425 });
    expect(a).toEqual(b);
  });
});

describe('uuid', () => {
  it('produces RFC4122 v4 ids that differ', () => {
    const a = uuidv4();
    expect(a).toMatch(UUID_RE);
    expect(uuidv4()).not.toBe(a);
  });
});

describe('groups', () => {
  const NOW = Date.parse('2026-10-09T00:00:00Z');
  it('normalizes and validates 8-char codes', () => {
    expect(normalizeInviteCode(' abcd-1234 ')).toBe('ABCD1234');
    expect(isValidInviteCode('abcd-1234')).toBe(true);
    expect(isValidInviteCode('ABC123')).toBe(false);
    expect(isValidInviteCode('ABCD12345')).toBe(false);
    expect(isValidInviteCode('ABCD123!')).toBe(false);
  });
  it('expires 7 days after creation', () => {
    const exp = inviteExpiryFrom(NOW);
    expect(exp).toBe('2026-10-16T00:00:00.000Z');
    expect(isInviteExpired(exp, NOW + 6 * 86_400_000)).toBe(false);
    expect(isInviteExpired(exp, NOW + 7 * 86_400_000)).toBe(true);
    expect(isInviteExpired(null, NOW)).toBe(true);
    expect(inviteStatusText(exp, NOW)).toBe('Expires in 7 days');
    expect(inviteStatusText(exp, NOW + 7 * 86_400_000)).toBe('Expired');
  });
});

describe('ping model', () => {
  const base = { type: 'bar_moved' as const, lat: 48.3, lon: -122.5, groupId: null };
  it('note limits: 140 chars ok, 141 rejected, emoji counted as one char, newlines rejected', () => {
    expect(validateNote('x'.repeat(140)).ok).toBe(true);
    expect(validateNote('x'.repeat(141)).ok).toBe(false);
    expect(validateNote('🦀'.repeat(140)).ok).toBe(true);
    expect(validateNote('a\nb').ok).toBe(false);
    expect(validateNote('   ')).toEqual({ ok: true, note: null });
    expect(validateNote(undefined)).toEqual({ ok: true, note: null });
  });
  it('requires a type and a valid position; anonymous only on the public tier', () => {
    expect(canSubmitPing({ ...base, type: null }).ok).toBe(false);
    expect(canSubmitPing({ ...base, lat: Number.NaN }).ok).toBe(false);
    expect(canSubmitPing({ ...base, groupId: 'g1', anonymous: true }).ok).toBe(false);
    expect(canSubmitPing({ ...base, anonymous: true }).ok).toBe(true);
  });
  it('builds the outbox payload with UTC created_at and tide', () => {
    const p = buildPingPayload({ ...base, note: ' sand moved ' }, { id: 'p1', nowMs: Date.parse('2026-10-09T12:00:00Z'), tideFt: 3.456 });
    expect(p).toEqual({
      id: 'p1',
      group_id: null,
      type: 'bar_moved',
      lat: 48.3,
      lon: -122.5,
      note: 'sand moved',
      created_at: '2026-10-09T12:00:00.000Z',
      tide_ft: 3.46,
      anonymous: false,
    });
    expect(() => buildPingPayload({ ...base, type: null }, { id: 'p', nowMs: 0, tideFt: null })).toThrow();
  });
  it('vote and message payloads', () => {
    expect(buildVotePayload('p1', 1, 0)).toEqual({ ping_id: 'p1', vote: 1, created_at: '1970-01-01T00:00:00.000Z' });
    expect(() => buildVotePayload('p1', 0 as 1, 0)).toThrow();
    expect(validateMessageBody('  ').ok).toBe(false);
    expect(validateMessageBody('x'.repeat(500)).ok).toBe(true);
    expect(validateMessageBody('x'.repeat(501)).ok).toBe(false);
    expect(buildMessagePayload('g1', ' hi ', { id: 'm1', nowMs: 0, pingId: 'p1' })).toMatchObject({ body: 'hi', ping_id: 'p1', group_id: 'g1' });
  });

  const NOW = Date.parse('2026-10-09T12:00:00Z');
  const ping = (id: string, hoursOld: number, rep = 1): Ping => ({
    id,
    author_id: 'a',
    group_id: null,
    type: 'log',
    lat: 48,
    lon: -122,
    note: null,
    created_at: new Date(NOW - hoursOld * 3_600_000).toISOString(),
    expires_at: null,
    score: null,
    tide_ft: null,
    author_reputation: rep,
  });
  it('visiblePings: fades at 24 h, hides at 48 h+, reconfirmation revives, pending always shown', () => {
    const vote: PingVote = { ping_id: 'old', voter_id: 'v', vote: 1, voter_dist_m: 100, created_at: new Date(NOW - 2 * 3_600_000).toISOString(), voter_reputation: 1 };
    const out = visiblePings(
      [ping('fresh', 1), ping('day', 30), ping('gone', 60), ping('old', 60), ping('mine', 60)],
      new Map([['old', [vote]]]),
      NOW,
      new Set(['mine']),
    );
    const byId = Object.fromEntries(out.map((s) => [s.ping.id, s]));
    expect(byId.fresh!.summary.state).toBe('normal');
    expect(byId.day!.summary.state).toBe('faded');
    expect(byId.gone).toBeUndefined();
    expect(byId.old!.summary.state).not.toBe('hidden');
    expect(byId.mine!.pendingSync).toBe(true);
  });
});

describe('mapStyle', () => {
  const urls = { base: 'pmtiles://base', depth: 'pmtiles://depth', waterline: 'pmtiles://wl', fleet: 'pmtiles://fleet' };
  it('legend has the fixed ramp stops 0,3,6,10,20,40 plus a drying band', () => {
    const l = depthLegend();
    expect(l.map((s) => s.depthFt)).toEqual([-3, 0, 3, 6, 10, 20, 40]);
    expect(new Set(l.map((s) => s.color)).size).toBe(l.length);
  });
  it('color-relief stops are raw FEET (tiles carry feet), ascend, and cover 40 ft deep up to drying', () => {
    const e = colorReliefExpression();
    const stops = e.slice(3).filter((_, i) => i % 2 === 0) as number[];
    expect([...stops].sort((a, b) => a - b)).toEqual(stops);
    expect(stops).toContain(-40);
    expect(stops).toContain(0);
  });
  it('waterline hatch is for <5 scenes and fleet hatch for <3 boats', () => {
    const s = buildMapStyle(urls);
    expect(s.layers.find((l) => l.id === 'waterline-hatch')!.filter).toEqual(['<', ['get', 'n'], 5]);
    expect(s.layers.find((l) => l.id === 'fleet-hatch')!.filter).toEqual(['<', ['get', 'boats'], 3]);
    expect(s.layers.find((l) => l.id === 'fleet-solid')!.filter).toEqual(['>=', ['get', 'boats'], 3]);
  });
  it('toggles control visibility; optional layers are omitted without URLs', () => {
    const off = buildMapStyle(urls, { ...DEFAULT_TOGGLES, waterline: false, fleet: false });
    for (const l of layersForToggle(off, 'waterline')) expect(l.layout!.visibility).toBe('none');
    for (const l of layersForToggle(off, 'fleet')) expect(l.layout!.visibility).toBe('none');
    const on = buildMapStyle(urls, { ...DEFAULT_TOGGLES, fleet: true });
    for (const l of layersForToggle(on, 'fleet')) expect(l.layout!.visibility).toBe('visible');
    const minimal = buildMapStyle({ base: 'pmtiles://b', depth: 'pmtiles://d' });
    expect(Object.keys(minimal.sources)).toEqual(['base', 'depth']);
    expect(minimal.layers.some((l) => l.id.startsWith('fleet'))).toBe(false);
  });
  it('hillshade exaggeration is scaled by 0.3048 because the tiles are feet', () => {
    const s = buildMapStyle(urls);
    expect(s.layers.find((l) => l.id === 'depth-hillshade')!.paint!['hillshade-exaggeration']).toBeCloseTo(0.4 * 0.3048, 12);
  });
  it('boundaries are drawn as hard lines with region labels', () => {
    const s = buildMapStyle(urls);
    expect(s.layers.find((l) => l.id === 'boundaries')!.type).toBe('line');
    expect(s.layers.find((l) => l.id === 'boundary-labels')!.layout!['text-field']).toEqual(['get', 'region_id']);
  });
});

import { normalizePingRow, pingFromPayload, pointOf } from '../src/lib/pingModel';

describe('ping row normalization', () => {
  const base = { id: 'p1', author_id: 'a', group_id: null, type: 'gear', created_at: '2026-10-09T00:00:00Z', note: null, tide_ft: 2.1 };
  it('reads PostgREST GeoJSON geometry (lon,lat order)', () => {
    const p = normalizePingRow({ ...base, geom: { type: 'Point', coordinates: [-122.5, 48.3] } })!;
    expect(p.lat).toBe(48.3);
    expect(p.lon).toBe(-122.5);
    expect(p.type).toBe('gear');
  });
  it('also reads lat/lon rows and rejects undrawable rows', () => {
    expect(normalizePingRow({ ...base, lat: 48, lon: -122 })!.lat).toBe(48);
    expect(normalizePingRow({ ...base })).toBeNull();
    expect(normalizePingRow({ ...base, type: 'nope', lat: 1, lon: 2 })).toBeNull();
    expect(normalizePingRow(null)).toBeNull();
    expect(pointOf({ geom: { coordinates: ['x', 1] } })).toBeNull();
  });
  it('queued payload becomes a local ping', () => {
    const payload = buildPingPayload({ type: 'log', lat: 48.3, lon: -122.5, groupId: null }, { id: 'p9', nowMs: 0, tideFt: null });
    expect(pingFromPayload(payload).id).toBe('p9');
  });
});
