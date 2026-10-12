/**
 * Resumable AOI download bookkeeping (MAP-9). The actual byte transfer lives in services/downloads.ts
 * (expo-file-system DownloadResumable); this module is the persisted state machine so that
 * "kill the app mid-download, reopen, it resumes" is decided by pure, tested logic.
 */
import type { TileLayer } from '@clearwater/shared';
import type { TilesIndexAoi } from '@clearwater/shared';
import { depthMetaPath, landPath, layersToDownload, type InstalledAoi } from './tilesIndex';

/**
 * Companion files by path convention (not in index.json; sizes unknown, listed with 0 bytes): `depth_meta` goes with
 * `depth`, `land` (OSM) with `base`. They are OPTIONAL: a 400/404 means the pipeline has not built them, and the map
 * simply runs without them.
 */
export type DownloadLayer = TileLayer | 'depth_meta' | 'land';
export const COMPANION_LAYERS: readonly DownloadLayer[] = ['depth_meta', 'land'];

export type FileStatus = 'pending' | 'partial' | 'done' | 'failed' | 'absent';

export interface DownloadFile {
  layer: DownloadLayer;
  path: string;
  bytes: number;
  status: FileStatus;
  /** Opaque resume token from DownloadResumable.savable().resumeData, persisted between launches. */
  resumeData?: string;
  /** Bytes known to be on disk for a partial file (for display). */
  bytesDone: number;
}

export interface DownloadJob {
  aoi: string;
  version: string;
  startedAt: string;
  files: DownloadFile[];
}

export function createJob(
  entry: TilesIndexAoi,
  wanted: readonly TileLayer[],
  installed: InstalledAoi | undefined,
  nowMs: number,
): DownloadJob {
  const files: DownloadFile[] = layersToDownload(entry, wanted, installed).map((layer) => {
    const f = entry.files[layer] as { path: string; bytes: number };
    return { layer, path: f.path, bytes: f.bytes, status: 'pending', bytesDone: 0 };
  });
  const meta = depthMetaPath(entry);
  if (meta && files.some((f) => f.layer === 'depth')) {
    files.push({ layer: 'depth_meta', path: meta, bytes: 0, status: 'pending', bytesDone: 0 });
  }
  const land = landPath(entry);
  if (land && files.some((f) => f.layer === 'base')) {
    files.push({ layer: 'land', path: land, bytes: 0, status: 'pending', bytesDone: 0 });
  }
  return { aoi: entry.aoi, version: entry.version, startedAt: new Date(nowMs).toISOString(), files };
}

export function nextFile(job: DownloadJob): DownloadFile | null {
  return job.files.find((f) => f.status === 'partial') ?? job.files.find((f) => f.status === 'pending' || f.status === 'failed') ?? null;
}

export function isComplete(job: DownloadJob): boolean {
  return job.files.length > 0 && job.files.every((f) => f.status === 'done' || f.status === 'absent');
}

export function totals(job: DownloadJob): { doneBytes: number; totalBytes: number; fraction: number } {
  const totalBytes = job.files.reduce((s, f) => s + f.bytes, 0);
  const doneBytes = job.files.reduce((s, f) => s + (f.status === 'done' || f.status === 'absent' ? f.bytes : Math.min(f.bytesDone, f.bytes)), 0);
  return { doneBytes, totalBytes, fraction: totalBytes === 0 ? 1 : doneBytes / totalBytes };
}

export function markProgress(job: DownloadJob, layer: DownloadLayer, bytesDone: number, resumeData?: string): DownloadJob {
  return {
    ...job,
    files: job.files.map((f) =>
      f.layer === layer && f.status !== 'done'
        ? { ...f, status: 'partial', bytesDone, ...(resumeData !== undefined ? { resumeData } : {}) }
        : f,
    ),
  };
}

export function markDone(job: DownloadJob, layer: DownloadLayer): DownloadJob {
  return { ...job, files: job.files.map((f) => (f.layer === layer ? { ...f, status: 'done', bytesDone: f.bytes } : f)) };
}

export function markAbsent(job: DownloadJob, layer: DownloadLayer): DownloadJob {
  return { ...job, files: job.files.map((f) => (f.layer === layer ? { ...f, status: 'absent', resumeData: undefined } : f)) };
}

export function markFailed(job: DownloadJob, layer: DownloadLayer): DownloadJob {
  return { ...job, files: job.files.map((f) => (f.layer === layer && f.status !== 'done' ? { ...f, status: 'failed' } : f)) };
}

/**
 * A persisted job is resumable only if the index still lists the same version. If a newer version was
 * published meanwhile, start over against it (partial files of the old version are discarded).
 */
export function canResume(job: DownloadJob, latest: TilesIndexAoi | undefined): boolean {
  return !!latest && latest.version === job.version && !isComplete(job);
}
