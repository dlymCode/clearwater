import type { BoundaryCollection } from '../src/lib/region';
import { distanceToBoundaryM, featuresAt, regionReadout, safeRegionReadout } from '../src/lib/region';

const sq = (x0: number, y0: number, x1: number, y1: number) =>
  [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

const fc: BoundaryCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { region_id: '2E', kind: 'crab_region' }, geometry: { type: 'Polygon', coordinates: sq(-123, 48, -122, 49) } },
    {
      type: 'Feature',
      properties: { region_id: '2W', kind: 'crab_region' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [sq(-124, 48, -123, 49), sq(-124, 47, -123, 47.5)],
      },
    },
    {
      // donut: hole in the middle of a 3x3 area
      type: 'Feature',
      properties: { region_id: 'donut' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[10, 10], [13, 10], [13, 13], [10, 13], [10, 10]],
          [[11, 11], [12, 11], [12, 12], [11, 12], [11, 11]],
        ],
      },
    },
  ],
};

describe('regionReadout', () => {
  it('inside polygon => "Region 2E"', () => {
    const r = regionReadout({ lat: 48.5, lon: -122.5 }, fc);
    expect(r.text).toBe('Region 2E');
    expect(r.regionId).toBe('2E');
  });
  it('MultiPolygon: either part matches', () => {
    expect(regionReadout({ lat: 48.5, lon: -123.5 }, fc).text).toBe('Region 2W');
    expect(regionReadout({ lat: 47.2, lon: -123.5 }, fc).text).toBe('Region 2W');
    expect(regionReadout({ lat: 47.8, lon: -123.5 }, fc).text).toBe('Outside mapped regions');
  });
  it('outside everything', () => {
    const r = regionReadout({ lat: 40, lon: -100 }, fc);
    expect(r.text).toBe('Outside mapped regions');
    expect(r.featureCount).toBe(0);
  });
  it('holes are excluded; ring between hole and outer is inside', () => {
    expect(featuresAt({ lat: 11.5, lon: 11.5 }, fc)).toHaveLength(0);
    expect(featuresAt({ lat: 10.5, lon: 10.5 }, fc)).toHaveLength(1);
  });
  it('points on an edge or vertex count as inside', () => {
    expect(featuresAt({ lat: 48.5, lon: -122 }, fc)).toHaveLength(1);
    expect(featuresAt({ lat: 49, lon: -122 }, fc)).toHaveLength(1);
  });
  it('handles three test points across the 2E/2W seam (S4-1)', () => {
    expect(regionReadout({ lat: 48.5, lon: -122.99 }, fc).regionId).toBe('2E');
    expect(regionReadout({ lat: 48.5, lon: -123.01 }, fc).regionId).toBe('2W');
    expect(regionReadout({ lat: 48.5, lon: -123.0 }, fc).featureCount).toBe(2); // on the shared line
  });
  it('prefers a crab region over a catch area when both contain the point', () => {
    const both: BoundaryCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { region_id: '24A', kind: 'catch_area' }, geometry: { type: 'Polygon', coordinates: sq(0, 0, 2, 2) } },
        { type: 'Feature', properties: { region_id: '2E', kind: 'crab_region' }, geometry: { type: 'Polygon', coordinates: sq(0, 0, 2, 2) } },
      ],
    };
    expect(regionReadout({ lat: 1, lon: 1 }, both).regionId).toBe('2E');
  });
  it('feature without an id property still reads sensibly; non-polygon geometry ignored', () => {
    const odd: BoundaryCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: sq(0, 0, 2, 2) } },
        { type: 'Feature', properties: { region_id: 'X' }, geometry: { type: 'LineString', coordinates: [] } },
        { type: 'Feature', properties: { region_id: 'Y' }, geometry: null },
      ],
    };
    expect(regionReadout({ lat: 1, lon: 1 }, odd).text).toContain('region id unknown');
    expect(regionReadout({ lat: 1, lon: 1 }, odd).featureCount).toBe(1);
  });
  it('distanceToBoundaryM is ~0 on the line and ~111 km per degree away', () => {
    const g = fc.features[0]!.geometry as Parameters<typeof distanceToBoundaryM>[1];
    expect(distanceToBoundaryM({ lat: 48.5, lon: -122 }, g)).toBeLessThan(1);
    const d = distanceToBoundaryM({ lat: 48.5, lon: -121 }, g);
    expect(d).toBeGreaterThan(70_000);
    expect(d).toBeLessThan(80_000);
  });
});

describe('E: malformed regions.geojson can never crash the map', () => {
  const bad = (g: unknown) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { region_id: 'X' }, geometry: g }] }) as unknown as Parameters<typeof safeRegionReadout>[1];
  const p = { lat: 1, lon: 1 };
  it.each([
    ['rings not arrays', { type: 'Polygon', coordinates: 'oops' }],
    ['null coordinates', { type: 'Polygon', coordinates: null }],
    ['vertices not pairs', { type: 'Polygon', coordinates: [[1, 2, 3]] }],
    ['string vertices', { type: 'Polygon', coordinates: [[['a', 'b'], ['c', 'd'], ['e', 'f']]] }],
    ['multi with null part', { type: 'MultiPolygon', coordinates: [null] }],
    ['empty ring', { type: 'Polygon', coordinates: [[]] }],
  ])('%s => no throw', (_n, g) => {
    expect(() => safeRegionReadout(p, bad(g))).not.toThrow();
  });
  it('features that are not an array, null input, non-object input', () => {
    expect(safeRegionReadout(p, { type: 'FeatureCollection', features: 'x' } as never)).toEqual({ text: 'Outside mapped regions', regionId: null, featureCount: 0 });
    expect(safeRegionReadout(p, null)).toBeNull();
    expect(safeRegionReadout(p, undefined)).toBeNull();
    expect(safeRegionReadout(p, 'str' as never)).toBeNull();
  });
  it('a malformed feature does not hide a good one next to it', () => {
    const ok = { type: 'Feature', properties: { region_id: '2E' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } };
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: 'oops' } }, ok] } as never;
    expect(safeRegionReadout(p, fc)?.regionId).toBe('2E');
  });
});
