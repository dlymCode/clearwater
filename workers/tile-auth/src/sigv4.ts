// AWS Signature V4 query-string presigning (GET), as accepted by Cloudflare R2's S3 API.
// Pure WebCrypto: runs in Workers and in Node, so it is unit-tested against the AWS reference
// vector without wrangler.

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, "0");
  return s;
}

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

/** RFC 3986 percent-encoding as required by SigV4 (unreserved characters stay). */
export function uriEncode(s: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of enc.encode(s)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function amzDate(d: Date): { date: string; datetime: string } {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20130524T000000Z
  return { date: iso.slice(0, 8), datetime: iso };
}

export interface PresignParams {
  /** e.g. "<account>.r2.cloudflarestorage.com" */
  host: string;
  /** Already-constructed absolute path, e.g. "/bucket/tiles/skagit/v1/depth.pmtiles" (un-encoded). */
  path: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "auto" for R2. */
  region: string;
  expiresSeconds: number;
  now: Date;
}

/** Returns a full https URL whose query string carries the signature. */
export async function presignGet(p: PresignParams): Promise<string> {
  if (!Number.isInteger(p.expiresSeconds) || p.expiresSeconds < 1 || p.expiresSeconds > 604800) {
    throw new RangeError("expiresSeconds must be 1..604800");
  }
  const { date, datetime } = amzDate(p.now);
  const scope = `${date}/${p.region}/s3/aws4_request`;
  const canonicalUri = uriEncode(p.path, true);

  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${p.accessKeyId}/${scope}`],
    ["X-Amz-Date", datetime],
    ["X-Amz-Expires", String(p.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  query.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = query.map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).join("&");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${p.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac("AWS4" + p.secretAccessKey, date);
  const kRegion = await hmac(kDate, p.region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `https://${p.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
