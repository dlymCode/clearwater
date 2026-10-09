// Clearwater tile-auth Worker.
//
//   GET  /sign?path=tiles/skagit/<version>/depth.pmtiles
//   POST /sign   {"paths": ["tiles/index.json", "tiles/skagit/<version>/base.pmtiles", ...]}   (max 8)
//   GET  /health
//
// Signable paths: tiles/**/*.pmtiles, tiles/index.json, tides/<station_id>.json.
// Flow: verify the caller's Supabase JWT (401) -> validate each path (400) -> confirm the object
// exists and learn its size via the optional R2 binding (404) -> charge the per-account daily quota
// in KV (429) -> return 24-hour SigV4 presigned R2 URLs. The app then range-reads R2 directly with
// the URL; the Worker is not in the data path.
import { AuthError, verifySupabaseJwt, type JwtConfig } from "./jwt.ts";
import { validateTilePath } from "./paths.ts";
import { consumeQuota, type KvLike } from "./quota.ts";
import { presignGet } from "./sigv4.ts";

export const URL_TTL_SECONDS = 24 * 60 * 60;
export const MAX_PATHS_PER_REQUEST = 8;
export const DEFAULT_DAILY_QUOTA_MB = 3000;
/** Charged when the object size is unknown (no R2 binding configured). */
export const DEFAULT_COST_MB = 250;

export interface R2Like {
  head(key: string): Promise<{ size: number } | null>;
}

export interface Env {
  SUPABASE_URL: string;
  /** Optional legacy HS256 secret (wrangler secret). */
  SUPABASE_JWT_SECRET?: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** KV namespace used for the daily quota counters. */
  QUOTA: KvLike;
  /** Optional R2 binding for existence checks and exact sizes. */
  TILES?: R2Like;
  DAILY_QUOTA_MB?: string;
}

export interface Deps {
  now: () => Date;
  getJwks?: JwtConfig["getJwks"];
}

const defaultDeps: Deps = { now: () => new Date() };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function unauthorized(message: string): Response {
  return json(401, { error: "unauthenticated", message }, { "www-authenticate": 'Bearer realm="clearwater-tiles"' });
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return m ? m[1] : null;
}

function configured(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.QUOTA);
}

export async function handle(req: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return req.method === "GET" || req.method === "HEAD" ? json(200, { ok: true }) : json(405, { error: "method_not_allowed" });
  }
  if (url.pathname !== "/sign") return json(404, { error: "not_found" });
  if (req.method !== "GET" && req.method !== "POST") {
    return json(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
  }
  if (!configured(env)) {
    console.error("tile-auth is missing configuration");
    return json(500, { error: "misconfigured" });
  }

  // 1. authenticate -------------------------------------------------------------------------
  const token = bearer(req);
  if (!token) return unauthorized("Missing bearer token.");
  let userId: string;
  try {
    const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
    const v = await verifySupabaseJwt(token, {
      supabaseUrl,
      jwtSecret: env.SUPABASE_JWT_SECRET || undefined,
      getJwks: deps.getJwks,
      nowSeconds: Math.floor(deps.now().getTime() / 1000),
    });
    userId = v.sub;
  } catch (e) {
    if (e instanceof AuthError) return unauthorized("Invalid or expired token.");
    console.error("jwt verification failed unexpectedly");
    return json(502, { error: "auth_unavailable" });
  }

  // 2. which paths ------------------------------------------------------------------------------
  let requested: unknown[];
  if (req.method === "GET") {
    requested = [url.searchParams.get("path")];
  } else {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const paths = (body as { paths?: unknown } | null)?.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS_PER_REQUEST) {
      return json(400, { error: "invalid_paths", message: `Provide 1-${MAX_PATHS_PER_REQUEST} paths.` });
    }
    requested = paths;
  }
  const valid: string[] = [];
  for (const raw of requested) {
    const p = validateTilePath(raw);
    if (!p) return json(400, { error: "invalid_path", message: "Only tiles/**/*.pmtiles, tiles/index.json and tides/<station>.json can be signed." });
    if (!valid.includes(p)) valid.push(p);
  }

  // 3. existence + cost ---------------------------------------------------------------------------
  let costMb = 0;
  const sizes = new Map<string, number | undefined>();
  for (const p of valid) {
    if (env.TILES) {
      const head = await env.TILES.head(p);
      if (!head) return json(404, { error: "not_found", message: "No such archive." });
      sizes.set(p, head.size);
      costMb += Math.max(1, Math.ceil(head.size / (1024 * 1024)));
    } else {
      sizes.set(p, undefined);
      costMb += p.endsWith(".pmtiles") ? DEFAULT_COST_MB : 1;
    }
  }

  // 4. quota -----------------------------------------------------------------------------------------
  const now = deps.now();
  const limitMb = Number(env.DAILY_QUOTA_MB) > 0 ? Number(env.DAILY_QUOTA_MB) : DEFAULT_DAILY_QUOTA_MB;
  const quota = await consumeQuota(env.QUOTA, userId, now, costMb, limitMb);
  if (!quota.allowed) {
    return json(
      429,
      { error: "quota_exceeded", message: "Daily download quota reached.", used_mb: quota.usedMb, limit_mb: quota.limitMb },
      { "retry-after": String(quota.resetsInSeconds) },
    );
  }

  // 5. sign -----------------------------------------------------------------------------------------------
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const expiresAt = new Date(now.getTime() + URL_TTL_SECONDS * 1000).toISOString();
  const urls = [];
  for (const p of valid) {
    const signed = await presignGet({
      host,
      path: `/${env.R2_BUCKET}/${p}`,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      region: "auto",
      expiresSeconds: URL_TTL_SECONDS,
      now,
    });
    urls.push({ path: p, url: signed, expires_at: expiresAt, bytes: sizes.get(p) ?? null });
  }
  // GET (one path) also returns {url, expires_at} at the top level: the shape the mobile client reads.
  const single = req.method === "GET" ? { url: urls[0].url, expires_at: urls[0].expires_at } : {};
  return json(200, {
    ...single,
    urls,
    quota: { used_mb: quota.usedMb, limit_mb: quota.limitMb, remaining_mb: quota.remainingMb, resets_in_seconds: quota.resetsInSeconds },
  });
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
