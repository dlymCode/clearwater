# tile-auth (Cloudflare Worker)

The R2 bucket is private. This Worker is the only way in: it checks a Supabase session and hands the
app a short-lived signed URL for a PMTiles archive. The app then range-reads R2 directly with that
URL; the Worker never proxies tile bytes.

```
app --Bearer <supabase access token>--> GET /sign?path=tiles/skagit/<version>/depth.pmtiles
    <-- 200 {"url": "https://<acct>.r2.cloudflarestorage.com/...&X-Amz-Expires=86400&X-Amz-Signature=...",
             "expires_at": "...", "urls": [...], "quota": {...}}
```

## API

| Request | Result |
| --- | --- |
| `GET /sign?path=<tiles/...>` | `200 {url, expires_at, urls:[{path,url,expires_at,bytes}], quota}` |
| `POST /sign` `{"paths":[...]}` (1-8 paths) | `200 {urls:[...], quota}`, all-or-nothing against the quota |
| `GET /health` | `200 {ok:true}` (no auth, no data) |

Errors: `401` missing/invalid/expired token (with `WWW-Authenticate: Bearer`), `400` bad path or body,
`404` archive not in R2 (only when the `TILES` binding is configured), `429` daily quota spent (with
`Retry-After` = seconds to UTC midnight), `405`, `500` misconfigured (generic body).

**Allowed paths:** `tiles/**/*.pmtiles` and exactly `tiles/index.json`; segments `[A-Za-z0-9_-][A-Za-z0-9._-]*`
only. No dot segments, `//`, percent escapes, backslashes, query strings or unicode.

**Auth:** the token must be a Supabase access token for a signed-in user: signature (HS256 with
`SUPABASE_JWT_SECRET`, or ES256/RS256 against `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, cached
10 min, refetched once on an unknown `kid`), `exp`/`nbf` (5 s skew), `iss = <SUPABASE_URL>/auth/v1`,
`aud = authenticated`, `role = authenticated` (so the anon and service keys are refused), `sub` a UUID.
`alg: none` and unconfigured algorithms are refused. HS256 is rejected outright unless a secret is set.
An account revoked by an admin keeps a valid JWT for at most its remaining lifetime (1 h by
`config.toml`), after which the ban stops refresh.

**Signing:** AWS SigV4 query-string presign (region `auto`, service `s3`, `host` signed header,
`UNSIGNED-PAYLOAD`), `X-Amz-Expires=86400`. Implemented with WebCrypto and checked against the AWS
documentation example vector.

**Quota:** each signing is charged against `DAILY_QUOTA_MB` (default 3000) per account per UTC day, in
Workers KV (`quota:<uid>:<yyyymmdd>`). Cost is the object size in MB when the `TILES` R2 binding is
present (`head()`), else a flat 250 MB (1 MB for `index.json`). Limits: it meters URLs issued rather
than bytes transferred (a URL can be reused for 24 h), and KV is eventually consistent so parallel
bursts can overshoot slightly. For a hard cap, put the counter in a Durable Object behind the same
`consumeQuota()` signature.

## Develop and test

```sh
npm install
npm test            # node --test with TypeScript type-stripping; no wrangler, no network
npm run typecheck   # tsc --noEmit
```

Tests (33) cover the SigV4 reference vector, path validation, quota maths, JWT verification (HS256, ES256
via JWKS, rotation, expiry, issuer, audience, anon-key refusal, alg confusion) and the full request flow
with fake KV/R2. Node >= 22.6 is required (`--experimental-strip-types`; unflagged on 23.6+).

## Deploy (needs accounts; nothing here is done yet)

1. `wrangler kv namespace create QUOTA` and put the id in `wrangler.toml`.
2. Fill the `[vars]` placeholders (`SUPABASE_URL`, `R2_ACCOUNT_ID`, `R2_BUCKET`).
3. Create an R2 API token with **read** access to the tiles bucket only (the pipeline uses a separate
   write token scoped to `tiles/`), then `wrangler secret put R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY`. If the project still uses the legacy JWT secret, also
   `wrangler secret put SUPABASE_JWT_SECRET`.
4. Add a route on your tiles hostname (see the comment in `wrangler.toml`), then `npm run deploy`.
5. Point the app at `https://<tiles-host>/sign`.

`.dev.vars.example` lists the variable names for `wrangler dev`. Never commit `.dev.vars`.
