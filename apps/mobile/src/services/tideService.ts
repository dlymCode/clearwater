/**
 * Tide predictions cache: one JSON per station, 30 days ahead, written to the document directory so the
 * tide screen and the depth logger work with no network. Refresh when older than 24 h (lib/syncCursor).
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { TidePredictions } from '@clearwater/shared';
import { toSeries, type TideSeries } from '../lib/tide';
import { kvGet, kvSet } from './db';
import { CONFIG } from './config';
import { signTileUrl } from './supabase';

const dir = (): string => `${FileSystem.documentDirectory ?? ''}tides/`;
const file = (stationId: string): string => `${dir()}${stationId}.json`;
const fetchedKey = (stationId: string): string => `tides.fetchedAt.${stationId}`;

export async function loadSeries(stationId: string): Promise<TideSeries | null> {
  const info = await FileSystem.getInfoAsync(file(stationId));
  if (!info.exists) return null;
  const json = JSON.parse(await FileSystem.readAsStringAsync(file(stationId))) as TidePredictions;
  return toSeries(json);
}

export async function tideFetchedAt(stationId: string): Promise<string | null> {
  return kvGet<string>(fetchedKey(stationId));
}

/**
 * Download predictions for a station. ASSUMPTION: pipeline publishes tides/<station_id>.json on R2 next to
 * tiles/ and the tile-auth worker signs any path. Confirm the path with the pipeline/worker owners.
 */
export async function refreshTides(stationId: string): Promise<void> {
  if (!CONFIG.tileAuthUrl) throw new Error('TILE_AUTH_URL not configured');
  await FileSystem.makeDirectoryAsync(dir(), { intermediates: true }).catch(() => undefined);
  const url = await signTileUrl(`tides/${stationId}.json`);
  const res = await FileSystem.downloadAsync(url, file(stationId));
  if (res.status !== 200) throw new Error(`tide download ${res.status}`);
  await kvSet(fetchedKey(stationId), new Date().toISOString());
}
