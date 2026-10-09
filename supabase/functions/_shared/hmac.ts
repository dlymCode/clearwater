// Server-side uploader hash for the fleet depth layer (PRD "Secrecy and privacy").
//
//   salt(day, epoch) = HMAC_SHA256(key = HMAC_SALT_SECRET, msg = "clearwater-depth-salt:v1:<epoch>:<day>")
//   uploader_hash    = hex(HMAC_SHA256(key = salt(day, epoch), msg = lowercase uid))
//
// The salt is per UTC *day of the sounding*, so a boat's hash differs on every day: the server can
// count distinct boats per cell per day and cannot join a boat across days from the stored rows.
// `epoch` is app_config.hmac_salt_epoch, bumped by the admin "rotate_salt" action.
const enc = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += b.toString(16).padStart(2, "0");
  return s;
}

// Keys and results are ArrayBuffer / BufferSource (not Uint8Array) so this type-checks on every
// Deno/TypeScript version, including those where Uint8Array became generic over its buffer.
export async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export async function dailySalt(secret: string, day: string, epoch: number): Promise<ArrayBuffer> {
  return await hmacSha256(enc.encode(secret), `clearwater-depth-salt:v1:${epoch}:${day}`);
}

export async function uploaderHash(secret: string, uid: string, day: string, epoch: number): Promise<string> {
  const salt = await dailySalt(secret, day, epoch);
  return toHex(await hmacSha256(salt, uid.toLowerCase()));
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD that is also a real calendar date. */
export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`bad day ${day}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

/** Inclusive list of days from `from` to `to`. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
