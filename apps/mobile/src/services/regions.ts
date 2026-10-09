/**
 * Boundary polygons for the "you are in Region 2E" readout (S4-1). Loaded from a local GeoJSON file shipped with
 * the AOI download. TODO(pipeline): the pipeline does not yet emit WDFW/WAC polygons (README: boundaries not built).
 * Expected file: <tiles dir>/regions.geojson, FeatureCollection of Polygon/MultiPolygon with properties
 * { region_id, kind: 'crab_region' | 'catch_area' } (override the id key list in lib/region.ts REGION_ID_KEYS).
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { BoundaryCollection } from '../lib/region';
import { localFileUri } from './downloads';

export async function loadRegions(aoi: string, version: string): Promise<BoundaryCollection | null> {
  const uri = localFileUri(aoi, version, 'regions.geojson');
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return null;
  const json = JSON.parse(await FileSystem.readAsStringAsync(uri)) as BoundaryCollection;
  return json.type === 'FeatureCollection' ? json : null;
}
