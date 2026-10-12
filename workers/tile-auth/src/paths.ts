// Which objects the worker will ever sign. Anything else is rejected before touching R2.
//
// Allowed shapes (nothing else):
//   tiles/index.json                       the archive index
//   tiles/<aoi>/<version>/<name>.pmtiles   PMTiles archives (>= 1 directory level). Version directories are
//                                          ISO-8601 timestamps with colons, e.g. 2026-10-09T00:00:00Z
//   tides/<station_id>.json                tide predictions, published flat by the pipeline
// Only [A-Za-z0-9._-] segments separated by single slashes, no dot-segments, no percent escapes,
// bounded length. The strictness is the point: a signed URL is a bearer capability.

const MAX_PATH_LENGTH = 200;
const FILE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
// Directory segments may also carry ':' (the pipeline names version directories after an ISO timestamp,
// pinned by publish.py and tiles_index.schema.json). Never allowed in the file name.
const DIR_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/;
const TIDE_FILE = /^tides\/[A-Za-z0-9_-]{1,32}\.json$/;

export function validateTilePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH) return null;
  if (TIDE_FILE.test(raw)) return raw;
  if (!raw.startsWith("tiles/")) return null;
  if (raw === "tiles/index.json") return raw;
  if (!raw.endsWith(".pmtiles")) return null;
  const segments = raw.split("/");
  if (segments.length < 3) return null; // tiles/<something>.pmtiles at minimum nested one level
  const last = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const re = i === last ? FILE_SEGMENT : DIR_SEGMENT;
    if (!re.test(segments[i])) return null; // rejects "", "..", ".", "%2e", "\\", spaces, unicode
  }
  return raw;
}
