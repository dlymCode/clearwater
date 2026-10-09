/**
 * tiles/index.json: parse/validate (lenient to unknown fields), size estimates, version diffs.
 * Shape per docs/AGENT-PLAN.md; JSON Schema lives in pipeline/schemas/tiles_index.schema.json.
 */
import { DEPTH_META_FILENAME, TILE_LAYERS, type TileLayer, type TilesIndex, type TilesIndexAoi, type TilesIndexFile } from '@clearwater/shared';

/** Layers needed for the map to be usable offline; waterline and fleet are optional extras. */
export const REQUIRED_LAYERS: readonly TileLayer[] = ['base', 'depth'];
export const DEFAULT_DOWNLOAD_LAYERS: readonly TileLayer[] = ['base', 'depth', 'waterline', 'fleet'];

export type ParseResult =
  | { ok: true; index: TilesIndex; issues: string[] }
  | { ok: false; errors: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isDateStr = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));

/**
 * A file entry with bytes == 0 means "product not available yet" (e.g. fleet layer in Phase 1): treated
 * as absent by the download screen and layer toggles.
 */
function parseFile(x: unknown): TilesIndexFile | null {
  if (!isObj(x)) return null;
  if (typeof x.path !== 'string' || x.path.length === 0) return null;
  if (typeof x.bytes !== 'number' || !Number.isFinite(x.bytes) || x.bytes <= 0) return null;
  return { path: x.path, bytes: x.bytes };
}

function isNotAvailableYet(x: unknown): boolean {
  return isObj(x) && x.bytes === 0;
}

export function parseTilesIndex(json: unknown): ParseResult {
  if (!isObj(json)) return { ok: false, errors: ['index is not an object'] };
  const errors: string[] = [];
  if (!isDateStr(json.updated_at)) errors.push('updated_at missing or not a date');
  if (!Array.isArray(json.aois)) errors.push('aois missing or not an array');
  if (errors.length) return { ok: false, errors };

  const issues: string[] = [];
  const aois: TilesIndexAoi[] = [];
  (json.aois as unknown[]).forEach((raw, i) => {
    if (!isObj(raw)) {
      issues.push(`aois[${i}] is not an object; skipped`);
      return;
    }
    if (typeof raw.aoi !== 'string' || raw.aoi.length === 0) {
      issues.push(`aois[${i}].aoi missing; skipped`);
      return;
    }
    if (typeof raw.version !== 'string' || raw.version.length === 0) {
      issues.push(`aois[${i}] (${raw.aoi}) version missing; skipped`);
      return;
    }
    if (!isObj(raw.files)) {
      issues.push(`aois[${i}] (${raw.aoi}) files missing; skipped`);
      return;
    }
    const files: Partial<Record<TileLayer, TilesIndexFile>> = {};
    for (const layer of TILE_LAYERS) {
      const f = parseFile(raw.files[layer]);
      if (f) files[layer] = f;
      else if (raw.files[layer] !== undefined && !isNotAvailableYet(raw.files[layer])) issues.push(`aois[${i}] (${raw.aoi}) files.${layer} invalid; ignored`);
    }
    const missing = REQUIRED_LAYERS.filter((l) => !files[l]);
    if (missing.length) {
      issues.push(`aois[${i}] (${raw.aoi}) missing required layer(s) ${missing.join(',')}; skipped`);
      return;
    }
    const entry: TilesIndexAoi = { aoi: raw.aoi, version: raw.version, files };
    const r = raw.merged_date_range;
    if (Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && typeof r[1] === 'string') {
      entry.merged_date_range = [r[0], r[1]];
    }
    aois.push(entry);
  });
  return { ok: true, index: { updated_at: json.updated_at as string, aois }, issues };
}

/** The index may list several versions per AOI (old ones kept 30 days); newest version string wins. */
export function latestByAoi(index: TilesIndex): Map<string, TilesIndexAoi> {
  const m = new Map<string, TilesIndexAoi>();
  for (const a of index.aois) {
    const cur = m.get(a.aoi);
    if (!cur || versionNewer(a.version, cur.version)) m.set(a.aoi, a);
  }
  return m;
}

/** Versions are ISO-8601 timestamps; compare by time, fall back to lexical. */
export function versionNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb;
  return a > b;
}

export function layerBytes(entry: TilesIndexAoi, layers: readonly TileLayer[] = DEFAULT_DOWNLOAD_LAYERS): number {
  let n = 0;
  for (const l of layers) n += entry.files[l]?.bytes ?? 0;
  return n;
}

/** Bytes still to fetch: layers whose installed version differs (or that are not installed). */
export function downloadSizeBytes(
  entry: TilesIndexAoi,
  layers: readonly TileLayer[] = DEFAULT_DOWNLOAD_LAYERS,
  installed?: InstalledAoi,
  resumedBytes = 0,
): number {
  const needed = layersToDownload(entry, layers, installed);
  return Math.max(0, layerBytes(entry, needed) - resumedBytes);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

export interface InstalledAoi {
  version: string;
  /** Layers present on disk at that version. Default: all that the version had. */
  layers?: readonly TileLayer[];
  downloadedAt?: string;
}

export type InstalledMap = Readonly<Record<string, InstalledAoi>>;

/** Layers that must be (re)downloaded for `entry` given what is installed. */
export function layersToDownload(
  entry: TilesIndexAoi,
  wanted: readonly TileLayer[],
  installed?: InstalledAoi,
): TileLayer[] {
  return wanted.filter((l) => {
    if ((entry.files[l]?.bytes ?? 0) <= 0) return false;
    if (!installed || installed.version !== entry.version) return true;
    return !(installed.layers ?? TILE_LAYERS).includes(l);
  });
}

export type AoiUpdateStatus = 'new' | 'update' | 'current';

export interface AoiDiff {
  aoi: string;
  status: AoiUpdateStatus;
  installedVersion?: string;
  latestVersion: string;
  bytesToDownload: number;
}

/** Which AOIs need (re)downloading? Uses the newest version per AOI. Drives the re-download prompt. */
export function diffInstalled(index: TilesIndex, installed: InstalledMap, layers: readonly TileLayer[] = DEFAULT_DOWNLOAD_LAYERS): AoiDiff[] {
  const out: AoiDiff[] = [];
  for (const [aoi, entry] of latestByAoi(index)) {
    const inst = installed[aoi];
    const status: AoiUpdateStatus = !inst ? 'new' : inst.version === entry.version ? 'current' : 'update';
    out.push({
      aoi,
      status,
      ...(inst ? { installedVersion: inst.version } : {}),
      latestVersion: entry.version,
      bytesToDownload: status === 'current' ? 0 : downloadSizeBytes(entry, layers, inst),
    });
  }
  return out.sort((a, b) => a.aoi.localeCompare(b.aoi));
}

/** Join an R2 base URL and an index path without doubling slashes. */
export function resolveTilePath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Layers actually available for this AOI (bytes > 0): drives the download screen and layer toggles. */
export function availableLayers(entry: TilesIndexAoi): TileLayer[] {
  return TILE_LAYERS.filter((l) => (entry.files[l]?.bytes ?? 0) > 0);
}

/**
 * Per-cell source/date/uncertainty is a separate archive by path convention (NOT in index.json):
 * tiles/<aoi>/<version>/depth_meta.pmtiles, next to depth.pmtiles. Its size is not in the index.
 */
export function depthMetaPath(entry: TilesIndexAoi): string | null {
  const d = entry.files.depth?.path;
  if (!d) return null;
  const slash = d.lastIndexOf('/');
  return `${slash >= 0 ? d.slice(0, slash + 1) : ''}${DEPTH_META_FILENAME}`;
}
