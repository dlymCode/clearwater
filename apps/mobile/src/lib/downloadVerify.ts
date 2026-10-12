/**
 * Verify a finished HTTP download before trusting it. expo-file-system writes ANY response body to disk (an
 * HTML/JSON error page for a 403/404 becomes a "tile file"), so status and size must be checked.
 */
import { retryableStatus } from './http';

export type DownloadVerdict = { ok: true } | { ok: false; reason: string; retryable: boolean };

export function verifyDownload(i: { status: number | undefined; expectedBytes: number; actualBytes: number | null }): DownloadVerdict {
  const { status, expectedBytes, actualBytes } = i;
  if (status !== 200 && status !== 206) {
    return { ok: false, reason: `HTTP ${status ?? 'unknown'}`, retryable: retryableStatus(status) };
  }
  // expectedBytes <= 0 means the size is unknown (depth_meta is not in the index): status check only.
  if (expectedBytes > 0) {
    if (actualBytes === null) return { ok: false, reason: 'file missing after download', retryable: true };
    if (actualBytes !== expectedBytes) {
      return { ok: false, reason: `size mismatch: got ${actualBytes} bytes, index says ${expectedBytes}`, retryable: true };
    }
  }
  return { ok: true };
}

/** Directories under tiles/<aoi>/ other than the installed version's (names are sanitized versions). */
export function staleVersionDirs(entries: readonly string[], keep: string): string[] {
  const k = keep.replace(/\/+$/, '');
  // Only plain directory names ever reach deleteAsync: anything with separators / dots-only is ignored.
  return entries.map((e) => e.replace(/\/+$/, '')).filter((e) => e.length > 0 && e !== k && /^[A-Za-z0-9_-]+$/.test(e));
}

/** Same sanitizer the downloader uses for the version directory name. */
export function versionDirName(version: string): string {
  return version.replace(/[^0-9A-Za-z_-]/g, '_');
}

// --- Path safety: tile paths come from a remote index and become filesystem paths ----------------------------------
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(pmtiles|geojson|json)$/;

/** One path segment: no separators, no leading dot, no "..", bounded length. */
export function isSafeSegment(s: unknown): s is string {
  return typeof s === 'string' && SEGMENT.test(s) && !s.includes('..');
}

export function isSafeAoiSlug(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(s);
}

/** tiles/<aoi>/<version>/<file>.(pmtiles|geojson|json) and nothing else. */
export function isSafeTilePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  const parts = p.split('/');
  return (
    parts.length === 4 && parts[0] === 'tiles' && isSafeAoiSlug(parts[1]) && isSafeSegment(parts[2]) && FILE_NAME.test(parts[3] as string)
  );
}

/** Final component of a safe tile path, or null. */
export function safeFileName(p: string): string | null {
  return isSafeTilePath(p) ? (p.split('/')[3] as string) : null;
}
