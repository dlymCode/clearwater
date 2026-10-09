/**
 * Station registry for "nearest station": stations found in the cached tide JSONs (the pipeline writes lat/lon
 * from the CO-OPS metadata API) win over the bundled approximate list; bundled stations fill any gaps so the
 * app works before the first tide download.
 */
import type { TidePredictions, TideStation } from '@clearwater/shared';

export type CachedStationMeta = Pick<TidePredictions, 'station_id' | 'name'> & { lat?: number; lon?: number };

export function mergeStationRegistry(bundled: readonly TideStation[], cached: readonly CachedStationMeta[]): TideStation[] {
  const byId = new Map<string, TideStation>(bundled.map((s) => [s.station_id, s]));
  for (const c of cached) {
    if (typeof c.lat === 'number' && typeof c.lon === 'number' && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      byId.set(c.station_id, { station_id: c.station_id, name: c.name, lat: c.lat, lon: c.lon });
    }
  }
  return [...byId.values()];
}

/** Station ids that have a cached file but no usable coordinates anywhere (cannot be picked by distance). */
export function stationsWithoutCoordinates(registry: readonly TideStation[], cachedIds: readonly string[]): string[] {
  const known = new Set(registry.map((s) => s.station_id));
  return cachedIds.filter((id) => !known.has(id));
}
