/** Small geodesy helpers. Pure TS; no native imports. */
import { GPS_STALE_MS, LAST_POSITION } from '@clearwater/shared';

const EARTH_RADIUS_M = 6_371_008.8;
const M_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_M;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great-circle distance in metres (haversine). */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Snap a position to a ~100 m grid (secrecy: last-known position is rounded to 100 m).
 * Latitude steps are a constant 100 m; longitude steps are 100 m at that latitude.
 * Deterministic: the same input always yields the same grid point.
 */
export function roundPosition(p: LatLon, gridM: number = LAST_POSITION.ROUND_M): LatLon {
  const latStep = gridM / M_PER_DEG_LAT;
  const lat = Math.round(p.lat / latStep) * latStep;
  const lonStep = gridM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(toRad(lat))));
  const lon = Math.round(p.lon / lonStep) * lonStep;
  // 6 decimals ~ 0.1 m: strips float noise without changing the grid.
  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** MAP-5: a GPS fix older than 5 s is stale (the dot greys). A missing fix is stale. */
export function isGpsStale(lastFixMs: number | null | undefined, nowMs: number, thresholdMs: number = GPS_STALE_MS): boolean {
  return lastFixMs === null || lastFixMs === undefined || nowMs - lastFixMs > thresholdMs;
}

/** Map re-render throttle (battery): true when at least `minIntervalMs` has passed (default 500 ms = 2 Hz). */
export function shouldRender(lastRenderMs: number, nowMs: number, minIntervalMs = 500): boolean {
  return nowMs - lastRenderMs >= minIntervalMs;
}
