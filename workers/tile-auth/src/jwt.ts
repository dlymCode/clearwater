// Supabase access-token verification with WebCrypto only.
//
// Accepts:
//   HS256  - legacy shared secret (SUPABASE_JWT_SECRET)
//   ES256 / RS256 - asymmetric signing keys, verified against the project's JWKS
// Rejects everything else, including alg "none", and never lets a token choose a key type that
// was not configured (no HS256-with-public-key confusion: HS256 requires the secret to be set).

const enc = new TextEncoder();
const dec = new TextDecoder();

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface VerifiedToken {
  sub: string;
  role: string;
  exp: number;
}

export interface JwtConfig {
  /** e.g. https://abcd.supabase.co (no trailing slash) */
  supabaseUrl: string;
  /** Legacy HS256 secret. Omit when the project only uses asymmetric keys. */
  jwtSecret?: string;
  /** Returns the project's JWKS keys. Defaults to fetching <supabaseUrl>/auth/v1/.well-known/jwks.json. */
  getJwks?: () => Promise<JsonWebKey[]>;
  /** Unix seconds; injectable for tests. */
  nowSeconds?: number;
}

const CLOCK_SKEW_SECONDS = 5;

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError("malformed token");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    // e.g. a length of 4n+1 is not valid base64: a malformed token is a 401, never a 5xx
    throw new AuthError("malformed token");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseJsonPart(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(dec.decode(b64urlToBytes(s)));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AuthError("malformed token");
}

// ---- JWKS cache (per isolate) --------------------------------------------------------------
let jwksCache: { url: string; keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MISS_REFETCH_MS = 30 * 1000;

async function defaultGetJwks(supabaseUrl: string, force: boolean): Promise<JsonWebKey[]> {
  const url = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  const now = Date.now();
  if (jwksCache && jwksCache.url === url) {
    const age = now - jwksCache.fetchedAt;
    if (age < JWKS_TTL_MS && (!force || age < JWKS_MISS_REFETCH_MS)) return jwksCache.keys;
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AuthError("cannot load signing keys");
  const body = (await res.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { url, keys, fetchedAt: now };
  return keys;
}

/** Test hook. */
export function resetJwksCache(): void {
  jwksCache = null;
}

async function verifyHs256(signingInput: string, sig: Uint8Array<ArrayBuffer>, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, sig, enc.encode(signingInput));
}

async function verifyAsymmetric(
  alg: "ES256" | "RS256",
  jwk: JsonWebKey,
  signingInput: string,
  sig: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const { key_ops: _ops, use: _use, alg: _alg, ...publicJwk } = jwk as JsonWebKey & { use?: string };
  if (alg === "ES256") {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new AuthError("key type mismatch");
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, enc.encode(signingInput));
  }
  if (jwk.kty !== "RSA") throw new AuthError("key type mismatch");
  const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, enc.encode(signingInput));
}

export async function verifySupabaseJwt(token: string, cfg: JwtConfig): Promise<VerifiedToken> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new AuthError("malformed token");
  const [h, p, s] = parts;
  const header = parseJsonPart(h);
  const payload = parseJsonPart(p);
  const sig = b64urlToBytes(s);
  const signingInput = `${h}.${p}`;

  const alg = header.alg;
  let valid = false;
  if (alg === "HS256") {
    if (!cfg.jwtSecret) throw new AuthError("unsupported algorithm");
    valid = await verifyHs256(signingInput, sig, cfg.jwtSecret);
  } else if (alg === "ES256" || alg === "RS256") {
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const load = async (force: boolean) =>
      cfg.getJwks ? await cfg.getJwks() : await defaultGetJwks(cfg.supabaseUrl, force);
    const pick = (keys: JsonWebKey[]) =>
      keys.find((k) => (kid ? (k as { kid?: string }).kid === kid : true) && (k.kty === (alg === "ES256" ? "EC" : "RSA")));
    let jwk = pick(await load(false));
    if (!jwk && kid) jwk = pick(await load(true)); // key rotation: refetch once
    if (!jwk) throw new AuthError("unknown signing key");
    valid = await verifyAsymmetric(alg, jwk, signingInput, sig);
  } else {
    throw new AuthError("unsupported algorithm");
  }
  if (!valid) throw new AuthError("bad signature");

  const now = cfg.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new AuthError("missing exp");
  if (exp + CLOCK_SKEW_SECONDS <= now) throw new AuthError("token expired");
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > now) throw new AuthError("token not yet valid");
  if (payload.iss !== `${cfg.supabaseUrl}/auth/v1`) throw new AuthError("wrong issuer");
  const aud = payload.aud;
  if (!(aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated")))) throw new AuthError("wrong audience");
  // The anon key is also a valid Supabase JWT (role "anon"); it must never mint tile URLs.
  if (payload.role !== "authenticated") throw new AuthError("not a signed-in user");
  if (typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub)) throw new AuthError("missing subject");

  return { sub: payload.sub.toLowerCase(), role: payload.role, exp };
}
