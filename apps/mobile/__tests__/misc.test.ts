import { haversineM, roundPosition } from '../src/lib/geo';
import { checkInviteCode, inviteStatusText, isInviteExpired, isValidInviteCode, normalizeInviteCode } from '../src/lib/groups';
import { buildMapStyle, colorReliefExpression, depthLegend, DEFAULT_TOGGLES, layersForToggle, rampColorAtDepth } from '../src/lib/mapStyle';
import {
  buildMessagePayload,
  buildPingPayload,
  buildVotePayload,
  canSubmitPing,
  validateMessageBody,
  validateNote,
  visiblePings,
} from '../src/lib/pingModel';
import type { Ping } from '@clearwater/shared';
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
  const exp = '2026-10-16T00:00:00.000Z';
  it('normalizes and validates 8-char codes from the server alphabet [A-HJ-NP-Z2-9]', () => {
    expect(normalizeInviteCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(isValidInviteCode('abcd-2345')).toBe(true);
    expect(isValidInviteCode('ABC234')).toBe(false);
    expect(isValidInviteCode('ABCD23456')).toBe(false);
    expect(isValidInviteCode('ABCD234!')).toBe(false);
  });
  it.each(['0', '1', 'O', 'I'])('rejects the ambiguous symbol %s with a message that names it', (c) => {
    const r = checkInviteCode(`ABCD234${c}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(c);
    expect(isValidInviteCode(`ABCD234${c}`)).toBe(false);
  });
  it('every alphabet symbol is accepted', () => {
    expect(checkInviteCode('ABCDEFGH')).toEqual({ ok: true, code: 'ABCDEFGH' });
    expect(checkInviteCode('JKLMNPQR').ok).toBe(true);
    expect(checkInviteCode('STUVWXYZ').ok).toBe(true);
    expect(checkInviteCode('23456789').ok).toBe(true);
  });
  it('expiry text', () => {
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
    const withAgg = (p: Ping, over: Partial<Ping> = {}): Ping => ({ ...p, vote_sum: 0, confirm_count: 0, dispute_count: 0, ...over });
    // 'old' is 60 h old but was confirmed 2 h ago by a rep-1 voter at weight 1 (vote_sum 1)
    const old = withAgg(ping('old', 60), { vote_sum: 1, confirm_count: 1, last_confirmed_at: new Date(NOW - 2 * 3_600_000).toISOString() });
    const out = visiblePings(
      [withAgg(ping('fresh', 1)), withAgg(ping('day', 30)), withAgg(ping('gone', 60)), old, withAgg(ping('mine', 60))],
      NOW,
      new Set(['mine']),
    );
    const byId = Object.fromEntries(out.map((s) => [s.ping.id, s]));
    expect(byId.fresh!.summary.state).toBe('normal');
    expect(byId.day!.summary.state).toBe('faded');
    expect(byId.gone).toBeUndefined();
    expect(byId.old!.summary.state).not.toBe('hidden');
    expect(byId.old!.summary.confirms).toBe(1);
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
  it('fleet hatch is for <3 boats; no waterline hatch until the pipeline ships counts (TODO)', () => {
    const s = buildMapStyle(urls);
    expect(s.layers.find((l) => l.id === 'waterline-hatch')).toBeUndefined();
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
    expect(minimal.layers.some((l) => l.id === 'land')).toBe(false);
    expect(minimal.layers.some((l) => l.id.startsWith('fleet'))).toBe(false);
  });
  it('the map draws what the legend says: every legend band mid-point renders in the legend colour', () => {
    const legend = depthLegend();
    const mid = (depthFt: number, i: number) => {
      const next = legend[i + 1]?.depthFt;
      return next === undefined ? depthFt + 10 : (depthFt + next) / 2;
    };
    legend.forEach((stop, i) => {
      if (stop.label === 'Dries') expect(rampColorAtDepth(-1.5)).toBe(stop.color);
      else expect(rampColorAtDepth(mid(stop.depthFt, i))).toBe(stop.color);
    });
    // breakpoints are hard: just either side of 10 ft changes colour, not a gradient
    expect(rampColorAtDepth(9.9)).not.toBe(rampColorAtDepth(10.1));
    expect(rampColorAtDepth(200)).toBe(legend[legend.length - 1]!.color);
  });
  it('a PMTiles archive holds one tile type: no source reuses another source\'s URL with a different type', () => {
    const style = buildMapStyle({ ...urls, land: 'pmtiles://land' });
    const byUrl = new Map<string, string>();
    for (const [id, src] of Object.entries(style.sources)) {
      const prev = byUrl.get(src.url);
      expect(prev === undefined || prev === src.type).toBe(true);
      byUrl.set(src.url, src.type);
      void id;
    }
    expect(style.sources.waterline_meta).toBeUndefined();
  });
  it('land is its own archive and every layer references only declared sources', () => {
    for (const u of [{ base: 'b', depth: 'd' }, { ...urls }, { ...urls, land: 'l' }, { base: 'b', depth: 'd', land: 'l' }]) {
      const style = buildMapStyle(u);
      for (const l of style.layers) if (l.source) expect(Object.keys(style.sources)).toContain(l.source);
    }
    const withLand = buildMapStyle({ ...urls, land: 'pmtiles://land' });
    expect(withLand.sources.land).toMatchObject({ type: 'vector', url: 'pmtiles://land' });
    expect(withLand.layers.find((l) => l.id === 'land')!.source).toBe('land');
    expect(buildMapStyle(urls).layers.some((l) => l.id === 'land')).toBe(false);
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
  it('reads the ping_feed vote aggregates and rejects unparsable timestamps', () => {
    const p = normalizePingRow({ ...base, lat: 48, lon: -122, author_reputation: 1.2, vote_sum: 1.25, last_confirmed_at: '2026-10-09T01:00:00Z', confirm_count: 2, dispute_count: 1, received_at: '2026-10-09T00:00:05Z' })!;
    expect(p).toMatchObject({ author_reputation: 1.2, vote_sum: 1.25, confirm_count: 2, dispute_count: 1, last_confirmed_at: '2026-10-09T01:00:00Z', received_at: '2026-10-09T00:00:05Z' });
    expect(normalizePingRow({ ...base, created_at: 'not a date', lat: 1, lon: 2 })).toBeNull();
    expect(normalizePingRow({ ...base, author_id: null, lat: 1, lon: 2 })!.author_id).toBeNull(); // anonymous
  });
  it('queued payload becomes a local ping', () => {
    const payload = buildPingPayload({ type: 'log', lat: 48.3, lon: -122.5, groupId: null }, { id: 'p9', nowMs: 0, tideFt: null });
    expect(pingFromPayload(payload).id).toBe('p9');
  });
});
