import type { TidePredictions } from '@clearwater/shared';
import { REFERENCE_TIDE_STATIONS } from '../src/lib/stations';
import {
  coverageEndMs,
  correctToMllw,
  daysCachedAhead,
  interpolateTide,
  nearestStation,
  tideCurve,
  toSeries,
} from '../src/lib/tide';

const preds: TidePredictions = {
  station_id: '9447130',
  name: 'Seattle',
  datum: 'MLLW',
  units: 'ft',
  predictions: [
    { t: '2026-10-09T00:00:00Z', v: 2 },
    { t: '2026-10-09T01:00:00Z', v: 4 },
    { t: '2026-10-09T02:00:00Z', v: 3 },
    { t: '2026-10-09T08:00:00Z', v: -1 },
  ],
};
const at = (iso: string) => Date.parse(iso);

describe('interpolateTide', () => {
  const s = toSeries(preds);
  it('returns exact values at sample times', () => {
    expect(interpolateTide(s, at('2026-10-09T01:00:00Z'))).toBe(4);
  });
  it('interpolates linearly between samples', () => {
    expect(interpolateTide(s, at('2026-10-09T00:30:00Z'))).toBeCloseTo(3, 12);
    expect(interpolateTide(s, at('2026-10-09T01:15:00Z'))).toBeCloseTo(3.75, 12);
  });
  it('returns null outside the cached range', () => {
    expect(interpolateTide(s, at('2026-10-08T23:59:00Z'))).toBeNull();
    expect(interpolateTide(s, at('2026-10-09T08:00:01Z'))).toBeNull();
  });
  it('last point is valid', () => {
    expect(interpolateTide(s, at('2026-10-09T08:00:00Z'))).toBe(-1);
  });
  it('refuses to interpolate across a gap wider than maxGap', () => {
    expect(interpolateTide(s, at('2026-10-09T05:00:00Z'))).toBeCloseTo(1, 12); // 6 h gap < 7 h default
    expect(interpolateTide(s, at('2026-10-09T05:00:00Z'), { maxGapMs: 3_600_000 })).toBeNull();
  });
  it('empty series and NaN are null', () => {
    expect(interpolateTide(toSeries({ ...preds, predictions: [] }), 0)).toBeNull();
    expect(interpolateTide(s, Number.NaN)).toBeNull();
  });
  it('sorts unsorted input, drops junk, dedupes timestamps', () => {
    const u = toSeries({
      ...preds,
      predictions: [
        { t: '2026-10-09T01:00:00Z', v: 4 },
        { t: 'garbage', v: 1 },
        { t: '2026-10-09T00:00:00Z', v: 2 },
        { t: '2026-10-09T01:00:00Z', v: 5 },
      ],
    });
    expect(u.tMs).toHaveLength(2);
    expect(interpolateTide(u, at('2026-10-09T01:00:00Z'))).toBe(5);
  });
});

describe('curve and coverage', () => {
  const s = toSeries(preds);
  it('samples the window with nulls outside coverage', () => {
    const c = tideCurve(s, at('2026-10-08T23:00:00Z'), at('2026-10-09T01:00:00Z'), 30);
    expect(c.map((p) => p.v)).toEqual([null, null, 2, 3, 4]);
  });
  it('coverage helpers', () => {
    expect(coverageEndMs(s)).toBe(at('2026-10-09T08:00:00Z'));
    expect(daysCachedAhead(s, at('2026-10-09T00:00:00Z'))).toBeCloseTo(8 / 24, 12);
    expect(daysCachedAhead(s, at('2026-10-12T00:00:00Z'))).toBe(0);
  });
});

describe('correctToMllw', () => {
  it('10 ft of water under a 2 ft transducer at +4 ft tide is 8 ft charted depth', () => {
    const c = correctToMllw({ rawDepthFt: 10, transducerDepthFt: 2, keelDepthFt: 4, tideFt: 4 });
    expect(c.depthBelowSurfaceFt).toBe(12);
    expect(c.mllwDepthFt).toBe(8);
    expect(c.elevationFtMllw).toBe(-8);
    expect(c.underKeelFt).toBe(8); // 12 - 4
  });
  it('a bar that dries: 2 ft at +5 ft tide => bottom at +3 ft MLLW (elevation positive up)', () => {
    const c = correctToMllw({ rawDepthFt: 2, transducerDepthFt: 0, keelDepthFt: 0, tideFt: 5 });
    expect(c.elevationFtMllw).toBe(3);
    expect(c.mllwDepthFt).toBe(-3);
  });
  it('negative tide (below MLLW) makes charted depth greater than the water column', () => {
    const c = correctToMllw({ rawDepthFt: 10, transducerDepthFt: 0, keelDepthFt: 0, tideFt: -1.5 });
    expect(c.mllwDepthFt).toBe(11.5);
  });
});

describe('nearestStation', () => {
  it('picks La Conner area boats => Friday Harbor/Seattle/Port Townsend by distance', () => {
    const skagitBay = { lat: 48.3, lon: -122.5 };
    const r = nearestStation(REFERENCE_TIDE_STATIONS, skagitBay)!;
    expect(r.station.name).toBe('Port Townsend');
    expect(r.distanceM).toBeGreaterThan(20_000);
    expect(r.distanceM).toBeLessThan(60_000);
  });
  it('near Tacoma picks Tacoma', () => {
    expect(nearestStation(REFERENCE_TIDE_STATIONS, { lat: 47.25, lon: -122.44 })!.station.station_id).toBe('9446484');
  });
  it('respects maxDistance and empty lists', () => {
    expect(nearestStation(REFERENCE_TIDE_STATIONS, { lat: 40, lon: -100 }, 100_000)).toBeNull();
    expect(nearestStation([], { lat: 48, lon: -122 })).toBeNull();
  });
});

describe('E: explicit UTC markers and curve guards', () => {
  const mk = (t: string): TidePredictions => ({ ...preds, predictions: [{ t, v: 1 }, { t: '2026-10-09T09:00:00Z', v: 2 }] });
  it('accepts Z and +00:00 / +0000 markers', () => {
    expect(toSeries(mk('2026-10-09T08:00:00Z')).tMs).toHaveLength(2);
    expect(toSeries(mk('2026-10-09T08:00:00+00:00')).tMs).toHaveLength(2);
    expect(toSeries(mk('2026-10-09T08:00:00+0000')).tMs).toHaveLength(2);
    expect(toSeries(mk('2026-10-09T08:00:00.000Z')).tMs).toHaveLength(2);
  });
  it('rejects ambiguous local-time strings and non-UTC offsets (they would shift the whole curve)', () => {
    expect(toSeries(mk('2026-10-09T08:00:00')).tMs).toHaveLength(1);
    expect(toSeries(mk('2026-10-09 08:00:00')).tMs).toHaveLength(1);
    expect(toSeries(mk('2026-10-09T08:00:00-07:00')).tMs).toHaveLength(1);
    expect(toSeries(mk('2026-10-09')).tMs).toHaveLength(1);
  });
  it('tideCurve refuses a non-positive step or non-finite bounds instead of looping forever', () => {
    const s = toSeries(preds);
    expect(() => tideCurve(s, 0, 1000, 0)).toThrow(RangeError);
    expect(() => tideCurve(s, 0, 1000, -5)).toThrow(RangeError);
    expect(() => tideCurve(s, 0, 1000, Number.NaN)).toThrow(RangeError);
    expect(() => tideCurve(s, 0, Infinity, 10)).toThrow(RangeError);
    expect(() => tideCurve(s, Number.NaN, 1000, 10)).toThrow(RangeError);
    expect(tideCurve(s, 0, 0, 10)).toHaveLength(1);
  });
});
