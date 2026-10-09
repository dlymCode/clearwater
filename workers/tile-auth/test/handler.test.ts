import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COST_MB, handle, URL_TTL_SECONDS } from "../src/index.ts";
import { quotaKey } from "../src/quota.ts";
import { claims, fakeR2, makeEnv, NOW, signHs256, USER } from "./helpers.ts";

const deps = { now: () => NOW };
const PATH = "tiles/skagit/v1/depth.pmtiles";
const MB = 1024 * 1024;

async function get(path: string | null, token?: string, env = makeEnv()) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const url = `https://tiles.example/sign${path === null ? "" : `?path=${encodeURIComponent(path)}`}`;
  return await handle(new Request(url, { headers }), env, deps);
}

test("401 when unauthenticated, with a Bearer challenge", async () => {
  const res = await get(PATH);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal((await get(PATH, "garbage")).status, 401);
  assert.equal((await get(PATH, await signHs256(claims({ exp: 1 })))).status, 401);
  assert.equal((await get(PATH, await signHs256(claims({ role: "anon" })))).status, 401);
});

test("401 happens before any R2 or KV access", async () => {
  const env = makeEnv({ TILES: { head: () => assert.fail("must not reach R2") } });
  assert.equal((await get(PATH, undefined, env)).status, 401);
  assert.equal(env.QUOTA.puts.length, 0);
});

test("signs a 24 h URL for a PMTiles path and charges the quota by size", async () => {
  const env = makeEnv({ TILES: fakeR2({ [PATH]: 120 * MB + 1 }) });
  const res = await get(PATH, await signHs256(claims()), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.urls.length, 1);
  assert.equal(body.url, body.urls[0].url, "GET exposes {url} at the top level");
  assert.equal(body.expires_at, body.urls[0].expires_at);
  const u = new URL(body.urls[0].url);
  assert.equal(u.host, "acct123.r2.cloudflarestorage.com");
  assert.equal(u.pathname, "/clearwater-tiles/tiles/skagit/v1/depth.pmtiles");
  assert.equal(u.searchParams.get("X-Amz-Expires"), String(URL_TTL_SECONDS));
  assert.equal(URL_TTL_SECONDS, 86400);
  assert.equal(body.urls[0].expires_at, new Date(NOW.getTime() + 86400_000).toISOString());
  assert.equal(body.urls[0].bytes, 120 * MB + 1);
  assert.equal(body.quota.used_mb, 121);
  assert.equal(env.QUOTA.store.get(quotaKey(USER, NOW)), "121");
  // the secret must never be echoed
  assert.ok(!JSON.stringify(body).includes("placeholder-secret"));
});

test("path validation: 400, and nothing is charged", async () => {
  const env = makeEnv();
  const t = await signHs256(claims());
  for (const p of ["tiles/../x.pmtiles", "private/x.pmtiles", "tiles/skagit/v1/depth.tif", "https://evil/x.pmtiles", ""]) {
    assert.equal((await get(p, t, env)).status, 400, p);
  }
  assert.equal((await get(null, t, env)).status, 400);
  assert.equal(env.QUOTA.puts.length, 0);
});

test("404 for an archive that does not exist (R2 binding present), nothing charged", async () => {
  const env = makeEnv({ TILES: fakeR2({}) });
  assert.equal((await get(PATH, await signHs256(claims()), env)).status, 404);
  assert.equal(env.QUOTA.puts.length, 0);
});

test("429 with Retry-After once the daily quota is spent", async () => {
  const env = makeEnv({ TILES: fakeR2({ [PATH]: 1000 * MB }), DAILY_QUOTA_MB: "2500" });
  const t = await signHs256(claims());
  assert.equal((await get(PATH, t, env)).status, 200);
  assert.equal((await get(PATH, t, env)).status, 200);
  const res = await get(PATH, t, env);
  assert.equal(res.status, 429);
  const secs = Number(res.headers.get("retry-after"));
  assert.ok(secs > 0 && secs <= 86400);
  assert.equal((await res.json()).error, "quota_exceeded");
});

test("quota is per account", async () => {
  const env = makeEnv({ TILES: fakeR2({ [PATH]: 3000 * MB }), DAILY_QUOTA_MB: "3000" });
  const a = await signHs256(claims());
  const b = await signHs256(claims({ sub: "00000000-0000-0000-0000-0000000000b2" }));
  assert.equal((await get(PATH, a, env)).status, 200);
  assert.equal((await get(PATH, a, env)).status, 429);
  assert.equal((await get(PATH, b, env)).status, 200);
});

test("without the R2 binding the flat default cost applies, and index.json is nearly free", async () => {
  const env = makeEnv({ DAILY_QUOTA_MB: String(DEFAULT_COST_MB + 1) });
  const t = await signHs256(claims());
  assert.equal((await get("tiles/index.json", t, env)).status, 200);
  assert.equal((await get(PATH, t, env)).status, 200);
  assert.equal((await get(PATH, t, env)).status, 429);
});

test("POST batch signs several paths, all-or-nothing on quota", async () => {
  const objects = { "tiles/index.json": 1000, [PATH]: 200 * MB, "tiles/skagit/v1/base.pmtiles": 100 * MB };
  const env = makeEnv({ TILES: fakeR2(objects), DAILY_QUOTA_MB: "350" });
  const t = await signHs256(claims());
  const post = (paths: unknown) =>
    handle(new Request("https://tiles.example/sign", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: JSON.stringify({ paths }) }), env, deps);

  let res = await post(["tiles/index.json", PATH, PATH, "tiles/skagit/v1/base.pmtiles"]);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).urls.length, 3, "duplicates collapse");
  res = await post([PATH]); // would exceed 350 MB (301 used + 200)
  assert.equal(res.status, 429);
  assert.equal(env.QUOTA.store.get(quotaKey(USER, NOW)), "301", "refused charge leaves the counter untouched");
  assert.equal((await post([])).status, 400);
  assert.equal((await post(Array.from({ length: 9 }, () => PATH))).status, 400);
  assert.equal((await post("tiles/index.json")).status, 400);
  assert.equal((await post([PATH, "../x"])).status, 400);
});

test("routing: health is open, unknown paths 404, other methods 405", async () => {
  const env = makeEnv();
  assert.equal((await handle(new Request("https://t/health"), env, deps)).status, 200);
  assert.equal((await handle(new Request("https://t/anything"), env, deps)).status, 404);
  assert.equal((await handle(new Request("https://t/sign", { method: "DELETE" }), env, deps)).status, 405);
});

test("misconfiguration fails closed with a generic 500", async () => {
  const env = makeEnv({ R2_SECRET_ACCESS_KEY: "" });
  const res = await get(PATH, await signHs256(claims()), env);
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes("R2_"));
});
