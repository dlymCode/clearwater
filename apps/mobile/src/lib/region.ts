/**
 * Point-in-polygon for boundary GeoJSON => "you are in Region 2E" readout (S4-1).
 * Ray casting; supports Polygon and MultiPolygon with holes, FeatureCollection / Feature / bare geometry.
 * Points exactly on an edge or vertex count as inside (a hard boundary line belongs to both sides'
 * ambiguity; callers that need to know can use `distanceToBoundaryM`).
 */
import { haversineM, type LatLon } from './geo';

export type Ring = ReadonlyArray<readonly [number, number]>; // [lon, lat]

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: ReadonlyArray<Ring>;
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: ReadonlyArray<ReadonlyArray<Ring>>;
}
export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface BoundaryFeature {
  type: 'Feature';
  geometry: AreaGeometry | { type: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}
export interface BoundaryCollection {
  type: 'FeatureCollection';
  features: ReadonlyArray<BoundaryFeature>;
}

const EPS = 1e-12;

function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > EPS * Math.max(1, Math.abs(bx - ax) + Math.abs(by - ay))) return false;
  return px >= Math.min(ax, bx) - EPS && px <= Math.max(ax, bx) + EPS && py >= Math.min(ay, by) - EPS && py <= Math.max(ay, by) + EPS;
}

/** Ray casting. Returns 'edge' when the point lies on the ring boundary. */
function ringContains(ring: Ring, lon: number, lat: number): boolean | 'edge' {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as readonly [number, number];
    const [xj, yj] = ring[j] as readonly [number, number];
    if (onSegment(lon, lat, xj, yj, xi, yi)) return 'edge';
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonContains(rings: ReadonlyArray<Ring>, lon: number, lat: number): boolean {
  const outer = rings[0];
  if (!outer) return false;
  const o = ringContains(outer, lon, lat);
  if (o === 'edge') return true;
  if (!o) return false;
  for (let h = 1; h < rings.length; h++) {
    const r = ringContains(rings[h] as Ring, lon, lat);
    if (r === 'edge') return true;
    if (r) return false; // inside a hole
  }
  return true;
}

let warnedMalformed = false;

/** Render-safe: a malformed geometry (bad rings, non-numeric coordinates, ...) counts as "not inside" and is logged once. */
export function geometryContains(g: BoundaryFeature['geometry'], p: LatLon): boolean {
  if (!g) return false;
  try {
    if (g.type === 'Polygon') return polygonContains((g as PolygonGeometry).coordinates, p.lon, p.lat);
    if (g.type === 'MultiPolygon') return (g as MultiPolygonGeometry).coordinates.some((poly) => polygonContains(poly, p.lon, p.lat));
  } catch (e) {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.warn(`[region] malformed boundary geometry skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return false;
}

export function featuresOf(input: BoundaryCollection | BoundaryFeature | AreaGeometry): BoundaryFeature[] {
  if (input.type === 'FeatureCollection') return Array.isArray(input.features) ? [...input.features] : [];
  if (input.type === 'Feature') return [input];
  return [{ type: 'Feature', geometry: input, properties: {} }];
}

export function featuresAt(p: LatLon, input: BoundaryCollection | BoundaryFeature | AreaGeometry): BoundaryFeature[] {
  return featuresOf(input).filter((f) => geometryContains(f.geometry, p));
}

/** Property keys tried (in order) for a feature's region id. The pipeline owner fixes the real key. */
export const REGION_ID_KEYS = ['region_id', 'region', 'REGION', 'crab_region', 'id', 'ID', 'code', 'CODE', 'name'] as const;
export const KIND_KEY = 'kind';

export function regionId(f: BoundaryFeature): string | null {
  const props = f.properties ?? {};
  for (const k of REGION_ID_KEYS) {
    const v = props[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

export interface RegionReadout {
  /** e.g. "Region 2E", or "Outside mapped regions". */
  text: string;
  regionId: string | null;
  /** All features containing the point (crab regions and catch areas may overlap). */
  featureCount: number;
}

/**
 * "You are in Region 2E". Prefers features whose `kind` is a crab region when the data distinguishes
 * them from catch areas; otherwise the first match.
 */
export function regionReadout(p: LatLon, input: BoundaryCollection | BoundaryFeature | AreaGeometry): RegionReadout {
  const hits = featuresAt(p, input);
  if (hits.length === 0) return { text: 'Outside mapped regions', regionId: null, featureCount: 0 };
  const preferred =
    hits.find((f) => typeof f.properties?.[KIND_KEY] === 'string' && /crab/i.test(String(f.properties?.[KIND_KEY]))) ?? hits[0];
  const id = preferred ? regionId(preferred) : null;
  return {
    text: id ? (/^region\b/i.test(id) ? id : `Region ${id}`) : 'In a mapped area (region id unknown)',
    regionId: id,
    featureCount: hits.length,
  };
}

/** Distance (m) from a point to the nearest vertex-to-vertex segment of the feature rings (approximate). */
export function distanceToBoundaryM(p: LatLon, g: AreaGeometry): number {
  const rings: ReadonlyArray<Ring> = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  let best = Number.POSITIVE_INFINITY;
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i] as readonly [number, number];
      const [bx, by] = ring[i + 1] as readonly [number, number];
      // Project to a local flat frame (lon scaled by cos lat) for the nearest-point-on-segment parameter.
      const dx = (bx - ax) * cosLat;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : (((p.lon - ax) * cosLat) * dx + (p.lat - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = haversineM(p, { lat: ay + (by - ay) * t, lon: ax + (bx - ax) * t });
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * regionReadout for the live map: NEVER throws. Malformed regions.geojson (wrong shapes, nulls) yields null (the caller
 * shows nothing) and is logged once, so a bad data file cannot crash MapScreen.
 */
export function safeRegionReadout(p: LatLon, input: BoundaryCollection | BoundaryFeature | AreaGeometry | null | undefined): RegionReadout | null {
  if (!input || typeof input !== 'object') return null;
  try {
    return regionReadout(p, input);
  } catch (e) {
    if (!warnedMalformed) {
      warnedMalformed = true;
      console.warn(`[region] readout failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}
