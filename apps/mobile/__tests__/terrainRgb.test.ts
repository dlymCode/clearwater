import { buildInspectReadout, decodeMetaPixel, readoutFromPixels } from '../src/lib/inspect';
import { decodeTerrainRgb, encodeTerrainRgb, lonLatToTilePixel } from '../src/lib/terrainRgb';

describe('decodeTerrainRgb (pipeline contract: standard formula, value is FEET MLLW)', () => {
  it('(0,0,0) is the no-data sentinel', () => {
    expect(decodeTerrainRgb(0, 0, 0)).toBeNull();
  });
  it('alpha 0 is no data', () => {
    expect(decodeTerrainRgb(1, 134, 160, 0)).toBeNull();
  });
  it('code 100000 => exactly 0 ft (no metre conversion)', () => {
    // 100000 = 1*65536 + 134*256 + 160
    expect(decodeTerrainRgb(1, 134, 160)).toBeCloseTo(0, 9);
  });
  it('+0.1 ft per code step and -10000 base', () => {
    expect(decodeTerrainRgb(0, 0, 1)).toBeCloseTo(-9999.9, 9);
    expect(decodeTerrainRgb(1, 134, 160 + 100)).toBeCloseTo(10, 9);
    expect(decodeTerrainRgb(1, 134, 160 - 250)).toBeCloseTo(-25, 9);
  });
  it('matches the pipeline formula for an arbitrary pixel', () => {
    const r = 1, g = 200, b = 17;
    expect(decodeTerrainRgb(r, g, b)).toBeCloseTo(-10000 + 0.1 * (r * 65536 + g * 256 + b), 9);
  });
  it('round-trips to the 0.1 ft quantum', () => {
    for (const ft of [-120, -40, -10.5, -3, 0, 2.4, 11.4]) {
      const [r, g, b] = encodeTerrainRgb(ft);
      expect(Math.abs((decodeTerrainRgb(r, g, b) as number) - ft)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });
  it('out-of-range elevations encode as no-data', () => {
    expect(encodeTerrainRgb(-20000)).toEqual([0, 0, 0]);
    expect(encodeTerrainRgb(Number.NaN)).toEqual([0, 0, 0]);
  });
});

describe('lonLatToTilePixel', () => {
  it('matches known tile for the Skagit flats at z12', () => {
    const t = lonLatToTilePixel(-122.4, 48.3, 12);
    expect(t.z).toBe(12);
    // x = (−122.4+180)/360 * 2^12 = 655.36; y (Web Mercator) = 1418.71 (computed independently)
    expect(t.x).toBe(655);
    expect(t.y).toBe(1418);
    expect(t.px).toBe(Math.floor(0.36 * 256));
    expect(t.py).toBe(Math.floor(0.7125867 * 256));
    expect(t.px).toBeGreaterThanOrEqual(0);
    expect(t.px).toBeLessThan(256);
  });
  it('(0,0) at z1 lands on the shared corner pixel of tile (1,1)', () => {
    const t = lonLatToTilePixel(0, 0, 1);
    expect(t).toMatchObject({ x: 1, y: 1, px: 0, py: 0 });
  });
});

describe('inspect readout: never blank', () => {
  const NOW = Date.parse('2026-10-09T00:00:00Z');
  it('all unknown => explicit "unknown"', () => {
    const r = buildInspectReadout({ elevationFt: null, sourceCode: null, dateDays1970: null, uncertaintyFt: null }, NOW);
    expect(r.depth).toBe('unknown');
    expect(r.source).toBe('unknown');
    expect(r.date).toBe('unknown');
    expect(r.uncertainty).toBe('unknown');
    for (const v of [r.depth, r.source, r.date, r.age, r.uncertainty]) expect(v.trim().length).toBeGreaterThan(0);
  });
  it('depth, drying, date, age and uncertainty formatting', () => {
    const days = Date.UTC(2014, 8, 15) / 86_400_000;
    const r = buildInspectReadout({ elevationFt: -12.34, sourceCode: 7, dateDays1970: days, uncertaintyFt: 0.5 }, NOW);
    expect(r.depth).toBe('12.3 ft deep (MLLW)');
    expect(r.source).toBe('USGS CoNED Puget Sound TBDEM');
    expect(r.date).toBe('2014-09-15');
    expect(r.age).toBe('12 years old');
    expect(r.old).toBe(true);
    expect(r.uncertainty).toBe('±0.5 ft');
    expect(buildInspectReadout({ elevationFt: 2.5, sourceCode: null, dateDays1970: null, uncertaintyFt: null }, NOW).depth).toBe('Dries 2.5 ft above MLLW');
  });
  it('pre-1970 survey dates (negative days) format', () => {
    const days = Date.UTC(1950, 5, 1) / 86_400_000;
    expect(buildInspectReadout({ elevationFt: -5, sourceCode: 1, dateDays1970: days, uncertaintyFt: null }, NOW).date).toBe('1950-06-01');
  });
  it('meta pixel per pipeline/tiles.py: R=(src<<4)|unc, GB=days since 1880, A=255 valid', () => {
    const days1970 = Date.UTC(2020, 0, 1) / 86_400_000;
    const d16 = days1970 + 32872;
    const m = decodeMetaPixel({ r: (3 << 4) | 2, g: d16 >> 8, b: d16 & 255, a: 255 });
    expect(m.sourceCode).toBe(3);
    expect(m.dateDays1970).toBe(days1970);
    expect(m.uncertaintyFt).toBe(0.5); // UNC_LEVELS_FT[2]
  });
  it('meta pixel: pre-1970 survey (1887) decodes to negative days-since-1970', () => {
    const days1970 = Date.UTC(1887, 5, 1) / 86_400_000;
    const d16 = days1970 + 32872;
    const m = decodeMetaPixel({ r: (7 << 4) | 9, g: d16 >> 8, b: d16 & 255, a: 255 });
    expect(m.dateDays1970).toBe(days1970);
    expect(m.uncertaintyFt).toBe(5);
    expect(buildInspectReadout({ elevationFt: -10, ...m }, Date.parse('2026-10-09T00:00:00Z')).source).toBe('USGS CoNED Puget Sound TBDEM');
  });
  it('meta pixel: unknown uncertainty bucket (15) and holes read as unknown, never a precise number', () => {
    expect(decodeMetaPixel({ r: (1 << 4) | 15, g: 128, b: 0, a: 255 }).uncertaintyFt).toBeNull();
    expect(decodeMetaPixel({ r: 0, g: 0, b: 0, a: 0 })).toEqual({ sourceCode: null, dateDays1970: null, uncertaintyFt: null, uncertaintyOpenEnded: false });
  });
  it('uncertainty bucket 15 reads "unknown"; bucket 14 reads ">= 45 ft"', () => {
    const d16 = Date.UTC(2020, 0, 1) / 86_400_000 + 32872;
    const px = (bucket: number) => ({ r: (4 << 4) | bucket, g: d16 >> 8, b: d16 & 255, a: 255 });
    const unknown = readoutFromPixels({ r: 1, g: 134, b: 160 - 100, a: 255 }, px(15), Date.parse('2026-10-09T00:00:00Z'));
    expect(unknown.uncertainty).toBe('unknown');
    const open = readoutFromPixels({ r: 1, g: 134, b: 160 - 100, a: 255 }, px(14), Date.parse('2026-10-09T00:00:00Z'));
    expect(open.uncertainty).toBe('≥ 45 ft');
    expect(decodeMetaPixel(px(14)).uncertaintyOpenEnded).toBe(true);
    expect(decodeMetaPixel(px(13)).uncertaintyOpenEnded).toBe(false);
    expect(decodeMetaPixel(px(13)).uncertaintyFt).toBe(20);
  });
  it('readoutFromPixels with missing tiles still returns unknowns', () => {
    const r = readoutFromPixels(null, null, NOW);
    expect(r.hasData).toBe(false);
    expect(r.depth).toBe('unknown');
  });
});
