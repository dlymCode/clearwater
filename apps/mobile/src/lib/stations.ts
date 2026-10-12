/**
 * Bundled tide-station metadata so "nearest station" works offline before any prediction file is
 * cached. Coordinates are APPROXIMATE (rounded) and must be verified against the CO-OPS metadata API
 * (api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json) in Sprint 0. Subordinate stations for
 * La Conner, Stanwood, Everett and Coupeville are prediction-only and their IDs are not yet known (PRD
 * open question); add them here once pulled.
 */
import type { TidePredictions, TideStation } from '@clearwater/shared';

export const REFERENCE_TIDE_STATIONS: readonly TideStation[] = [
  { station_id: '9447130', name: 'Seattle', lat: 47.6026, lon: -122.3393 },
  { station_id: '9444900', name: 'Port Townsend', lat: 48.1129, lon: -122.7595 },
  { station_id: '9449880', name: 'Friday Harbor', lat: 48.5453, lon: -123.0125 },
  { station_id: '9449424', name: 'Cherry Point', lat: 48.8629, lon: -122.7584 },
  { station_id: '9446484', name: 'Tacoma', lat: 47.27, lon: -122.413 },
  { station_id: '9444090', name: 'Port Angeles', lat: 48.125, lon: -123.44 },
];

/**
 * Station registry for "nearest station": stations found in the cached tide JSONs (the pipeline writes lat/lon from the
 * CO-OPS metadata API) win over the bundled approximate list above; bundled stations fill any gaps so the app works
 * before the first tide download.
 */
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

