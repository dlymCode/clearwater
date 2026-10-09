// Which objects the worker will ever sign. Anything else is rejected before touching R2.
//
// Allowed shapes (nothing else):
//   tiles/index.json                       the archive index
//   tiles/<segments>/<name>.pmtiles        PMTiles archives (at least one directory level)
//   tides/<station_id>.json                tide predictions, published flat by the pipeline
// Only [A-Za-z0-9._-] segments separated by single slashes, no dot-segments, no percent escapes,
// bounded length. The strictness is the point: a signed URL is a bearer capability.

const MAX_PATH_LENGTH = 200;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
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
  for (const seg of segments) {
    if (!SEGMENT.test(seg)) return null; // rejects "", "..", ".", "%2e", "\\", spaces, unicode
  }
  return raw;
}
