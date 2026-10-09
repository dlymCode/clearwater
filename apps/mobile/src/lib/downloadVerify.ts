/**
 * Verify a finished HTTP download before trusting it. expo-file-system writes ANY response body to disk (an
 * HTML/JSON error page for a 403/404 becomes a "tile file"), so status and size must be checked.
 */
export type DownloadVerdict = { ok: true } | { ok: false; reason: string; retryable: boolean };

export function verifyDownload(i: { status: number | undefined; expectedBytes: number; actualBytes: number | null }): DownloadVerdict {
  const { status, expectedBytes, actualBytes } = i;
  if (status !== 200 && status !== 206) {
    return { ok: false, reason: `HTTP ${status ?? 'unknown'}`, retryable: status === undefined || status === 408 || status === 429 || status >= 500 };
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
  return entries.map((e) => e.replace(/\/+$/, '')).filter((e) => e.length > 0 && e !== k);
}

/** Same sanitizer the downloader uses for the version directory name. */
export function versionDirName(version: string): string {
  return version.replace(/[^0-9A-Za-z_-]/g, '_');
}
