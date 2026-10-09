/**
 * Tide predictions cache: one JSON per station (tides/<station_id>.json), 30 days ahead, in the document directory
 * so the tide screen and the depth logger work with no network. Refresh when older than 24 h (lib/syncCursor).
 * The station registry (for nearest-station) is built from the lat/lon inside the cached JSONs plus the bundled list.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { TidePredictions, TideStation } from '@clearwater/shared';
import { REFERENCE_TIDE_STATIONS } from '../lib/stations';
import { toSeries, type TideSeries } from '../lib/tide';
import { mergeStationRegistry, type CachedStationMeta } from '../lib/tideStations';
import { verifyDownload } from '../lib/downloadVerify';
import { CONFIG } from './config';
import { kvGet, kvSet } from './db';
import { signTileUrl } from './supabase';

const dir = (): string => `${FileSystem.documentDirectory ?? ''}tides/`;
const file = (stationId: string): string => `${dir()}${stationId}.json`;
const fetchedKey = (stationId: string): string => `tides.fetchedAt.${stationId}`;

interface CacheEntry {
  series: TideSeries;
  meta: CachedStationMeta;
  /** File modification time when loaded; a newer file on disk invalidates the entry. */
  modifiedAt: number;
  checkedAt: number;
}
const cache = new Map<string, CacheEntry>();
const RECHECK_MS = 5 * 60_000;
const warned = new Set<string>();

async function readFresh(stationId: string): Promise<CacheEntry | null> {
  const info = await FileSystem.getInfoAsync(file(stationId));
  if (!info.exists) return null;
  const json = JSON.parse(await FileSystem.readAsStringAsync(file(stationId))) as TidePredictions;
  const entry: CacheEntry = {
    series: toSeries(json),
    meta: { station_id: json.station_id, name: json.name, ...(json.lat !== undefined ? { lat: json.lat } : {}), ...(json.lon !== undefined ? { lon: json.lon } : {}) },
    modifiedAt: info.modificationTime ?? 0,
    checkedAt: Date.now(),
  };
  cache.set(stationId, entry);
  return entry;
}

/**
 * Series for a station. The in-memory copy is NOT kept forever: at most every 5 minutes the file's modification time
 * is compared and the series is re-read if a daily refresh replaced it on disk.
 */
export async function loadSeries(stationId: string): Promise<TideSeries | null> {
  const hit = cache.get(stationId);
  if (hit && Date.now() - hit.checkedAt < RECHECK_MS) return hit.series;
  if (hit) {
    const info = await FileSystem.getInfoAsync(file(stationId));
    if (info.exists && (info.modificationTime ?? 0) <= hit.modifiedAt) {
      hit.checkedAt = Date.now();
      return hit.series;
    }
  }
  return (await readFresh(stationId))?.series ?? null;
}

/** Bundled stations overlaid with coordinates from every cached tide JSON. */
export async function stationRegistry(): Promise<TideStation[]> {
  const names = await FileSystem.readDirectoryAsync(dir()).catch(() => [] as string[]);
  const metas: CachedStationMeta[] = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const id = n.replace(/\.json$/, '');
    const e = cache.get(id) ?? (await readFresh(id).catch(() => null));
    if (e) metas.push(e.meta);
  }
  return mergeStationRegistry(REFERENCE_TIDE_STATIONS, metas);
}

export async function tideFetchedAt(stationId: string): Promise<string | null> {
  return kvGet<string>(fetchedKey(stationId));
}

export class TideFetchError extends Error {
  constructor(readonly stationId: string, readonly reason: string) {
    super(`tides/${stationId}.json: ${reason}`);
  }
}

/**
 * Download predictions for a station. A non-200 (400/404 while the pipeline has not published the station yet, 403,
 * ...) deletes whatever body was written, is logged ONCE per station per launch, does NOT mark the station as fetched
 * (so the next sync retries), and throws TideFetchError for the caller to count.
 */
export async function refreshTides(stationId: string): Promise<void> {
  if (!CONFIG.tileAuthUrl) throw new TideFetchError(stationId, 'TILE_AUTH_URL not configured');
  await FileSystem.makeDirectoryAsync(dir(), { intermediates: true }).catch(() => undefined);
  const tmp = `${file(stationId)}.part`;
  const fail = async (reason: string): Promise<never> => {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => undefined);
    if (!warned.has(stationId)) {
      warned.add(stationId);
      console.warn(`[tides] ${stationId}: ${reason}; will retry on the next sync`);
    }
    throw new TideFetchError(stationId, reason);
  };
  let url: string;
  try {
    url = await signTileUrl(`tides/${stationId}.json`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'could not sign url');
  }
  const res = await FileSystem.downloadAsync(url, tmp).catch((e: unknown) => fail(e instanceof Error ? e.message : 'network error'));
  const verdict = verifyDownload({ status: res.status, expectedBytes: 0, actualBytes: null });
  if (!verdict.ok) return fail(verdict.reason);
  // Validate before replacing the good copy: must parse and have predictions.
  try {
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(tmp)) as TidePredictions;
    if (!Array.isArray(parsed.predictions) || parsed.predictions.length === 0) return fail('empty predictions');
  } catch {
    return fail('not valid JSON');
  }
  await FileSystem.deleteAsync(file(stationId), { idempotent: true });
  await FileSystem.moveAsync({ from: tmp, to: file(stationId) });
  cache.delete(stationId);
  warned.delete(stationId);
  await kvSet(fetchedKey(stationId), new Date().toISOString());
}
