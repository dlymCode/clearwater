// Which objects the worker will ever sign. Anything else is rejected before touching R2.
//
// Rules: lives under tiles/, ends in .pmtiles (or is exactly tiles/index.json), only
// [A-Za-z0-9._-] segments separated by single slashes, no dot-segments, no percent escapes,
// bounded length. The strictness is the point: a signed URL is a bearer capability.

const MAX_PATH_LENGTH = 200;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function validateTilePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH) return null;
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
