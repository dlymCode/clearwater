/**
 * AOI download manager (MAP-9): resumable (expo-file-system DownloadResumable + persisted resume data),
 * driven by the pure state machine in lib/downloadState.ts. Layout: <documentDirectory>tiles/<aoi>/<version>/<file>.
 * LIMITS (README): files that finished are never re-downloaded after a kill; a file that was mid-flight restarts
 * from byte 0 unless the OS handed back resume data (only on pause/cancel). TODO: HTTP Range resume + background continuation.
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { TilesIndexAoi } from '@clearwater/shared';
import {
  canResume, createJob, isComplete, markDone, markFailed, markProgress, nextFile, totals,
  type DownloadJob,
} from '../lib/downloadState';
import { staleVersionDirs, verifyDownload, versionDirName } from '../lib/downloadVerify';
import type { InstalledAoi } from '../lib/tilesIndex';
import { kvGet, kvSet } from './db';
import { signTileUrl } from './supabase';

const jobKey = (aoi: string): string => `download.job.${aoi}`;
const installedKey = (aoi: string): string => `download.installed.${aoi}`;

const aoiDir = (aoi: string): string => `${FileSystem.documentDirectory ?? ''}tiles/${aoi}/`;
export const tilesDir = (aoi: string, version: string): string => `${aoiDir(aoi)}${versionDirName(version)}/`;

export const localFileUri = (aoi: string, version: string, fileName: string): string => `${tilesDir(aoi, version)}${fileName}`;

export async function getInstalled(aoi: string): Promise<InstalledAoi | undefined> {
  return (await kvGet<InstalledAoi>(installedKey(aoi))) ?? undefined;
}

export interface DownloadProgress {
  fraction: number;
  doneBytes: number;
  totalBytes: number;
}

/** Start or resume. Safe to call again after the app was killed: partial files continue from resumeData. */
export async function runDownload(
  entry: TilesIndexAoi,
  wanted: Parameters<typeof createJob>[1],
  onProgress: (p: DownloadProgress) => void,
  signal: { cancelled: boolean } = { cancelled: false },
): Promise<'done' | 'cancelled' | 'failed'> {
  const installed = await getInstalled(entry.aoi);
  let job = await kvGet<DownloadJob>(jobKey(entry.aoi));
  if (!job || !canResume(job, entry)) job = createJob(entry, wanted, installed, Date.now());
  await FileSystem.makeDirectoryAsync(tilesDir(entry.aoi, entry.version), { intermediates: true }).catch(() => undefined);

  for (let f = nextFile(job); f; f = nextFile(job)) {
    if (signal.cancelled) return 'cancelled';
    const name = f.path.split('/').pop() as string;
    const dest = localFileUri(entry.aoi, entry.version, name);
    try {
      const url = await signTileUrl(f.path);
      const dl = FileSystem.createDownloadResumable(url, dest, {}, async (p) => {
        job = markProgress(job as DownloadJob, f.layer, p.totalBytesWritten);
        onProgress(totals(job));
        await kvSet(jobKey(entry.aoi), job);
      }, f.resumeData);
      const res = await dl.downloadAsync();
      if (!res) return 'cancelled';
      // expo-file-system writes ANY response body to disk: check the status and (when the index knows it) the size
      // before trusting the file. A bad file is deleted and the layer marked failed so the next run restarts it.
      const info = await FileSystem.getInfoAsync(dest);
      const verdict = verifyDownload({
        status: res.status,
        expectedBytes: f.bytes,
        actualBytes: info.exists && 'size' in info ? info.size : null,
      });
      if (!verdict.ok) {
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
        job = markFailed({ ...job, files: job.files.map((x) => (x.layer === f.layer ? { ...x, resumeData: undefined, bytesDone: 0 } : x)) }, f.layer);
        await kvSet(jobKey(entry.aoi), job);
        return 'failed';
      }
      job = markDone(job, f.layer);
    } catch {
      // Persist resume data so the next launch continues this file.
      job = markFailed(job, f.layer);
      await kvSet(jobKey(entry.aoi), job);
      return 'failed';
    }
    await kvSet(jobKey(entry.aoi), job);
    onProgress(totals(job));
  }
  if (isComplete(job)) {
    const layers = job.files.map((x) => x.layer).filter((l) => l !== 'depth_meta');
    await kvSet(installedKey(entry.aoi), {
      version: entry.version,
      layers: [...new Set([...(installed?.version === entry.version ? (installed.layers ?? []) : []), ...layers])],
      downloadedAt: new Date().toISOString(),
    } satisfies InstalledAoi);
    await kvSet(jobKey(entry.aoi), null);
    await deleteOldVersions(entry.aoi, entry.version);
  }
  return 'done';
}

/** After a complete install, drop every other version directory of this AOI (hundreds of MB each). */
async function deleteOldVersions(aoi: string, keepVersion: string): Promise<void> {
  const entries = await FileSystem.readDirectoryAsync(aoiDir(aoi)).catch(() => [] as string[]);
  for (const stale of staleVersionDirs(entries, versionDirName(keepVersion))) {
    await FileSystem.deleteAsync(`${aoiDir(aoi)}${stale}`, { idempotent: true }).catch(() => undefined);
  }
}
