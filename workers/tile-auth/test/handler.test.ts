import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COST_MB, handle, URL_TTL_SECONDS } from "../src/index.ts";
import { quotaKey } from "../src/quota.ts";
import { claims, FakeKv, fakeR2, makeEnv, makeEs256, NOW, signHs256, USER } from "./helpers.ts";

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

test("S2: a token with an undecodable segment is a 401, never a 5xx", async () => {
  for (const t of ["e30.e30.A", "A.A.A", "e30x1.e30.e30", "a.b.c"]) {
    const res = await get(PATH, t);
    assert.equal(res.status, 401, t);
  }
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

test("X1: tide prediction JSONs are signable and cost almost nothing", async () => {
  const env = makeEnv({ TILES: fakeR2({ "tides/9447130.json": 400_000 }) });
  const res = await get("tides/9447130.json", await signHs256(claims()), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(new URL(body.url).pathname, "/clearwater-tiles/tides/9447130.json");
  assert.equal(body.quota.used_mb, 1);
  assert.equal((await get("tides/9447130.pmtiles", await signHs256(claims()), env)).status, 400);
  assert.equal((await get("tides/../tiles/index.json", await signHs256(claims()), env)).status, 400);
  // without the R2 binding a tide file is still flat-rate cheap, a pmtiles archive is not
  const flat = makeEnv();
  await get("tides/9447130.json", await signHs256(claims()), flat);
  assert.equal(flat.QUOTA.store.get(quotaKey(USER, NOW)), "1");
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

test("E11/B5: DAILY_QUOTA_MB that is not a finite positive number falls back to the default", async () => {
  for (const bad of ["Infinity", "NaN", "-5", "0", "abc", ""]) {
    const env = makeEnv({ DAILY_QUOTA_MB: bad, TILES: fakeR2({ [PATH]: 2000 * MB }) });
    const t = await signHs256(claims());
    assert.equal((await get(PATH, t, env)).status, 200, bad); // 2000 MB fits in the 3000 MB default
    assert.equal((await get(PATH, t, env)).status, 429, bad); // but not twice: the limit is the default, not infinite
  }
});

test("B5: 50 parallel sign requests for the same account cannot exceed the quota", async () => {
  const env = makeEnv({ QUOTA: new FakeKv(1), TILES: fakeR2({ [PATH]: 100 * MB }), DAILY_QUOTA_MB: "1000" });
  const t = await signHs256(claims());
  const statuses = await Promise.all(Array.from({ length: 50 }, () => get(PATH, t, env).then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 200).length, 10);
  assert.equal(statuses.filter((s) => s === 429).length, 40);
});

test("B5: POST /sign bodies are capped (413)", async () => {
  const env = makeEnv();
  const t = await signHs256(claims());
  const big = JSON.stringify({ paths: [PATH], pad: "x".repeat(5000) });
  const res = await handle(new Request("https://tiles.example/sign", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: big }), env, deps);
  assert.equal(res.status, 413);
  // the declared length alone is enough to refuse
  const res2 = await handle(
    new Request("https://tiles.example/sign", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-length": "99999" }, body: "{}" }),
    env,
    deps,
  );
  assert.equal(res2.status, 413);
  assert.equal(env.QUOTA.puts.length, 0);
});

test("E11: signing keys unreachable -> 503 with Retry-After (the user stays signed in)", async () => {
  const k = await makeEs256("kid-503");
  const token = await k.sign(claims());
  const env = makeEnv({ SUPABASE_JWT_SECRET: undefined });
  const res = await handle(
    new Request(`https://tiles.example/sign?path=${encodeURIComponent(PATH)}`, { headers: { authorization: `Bearer ${token}` } }),
    env,
    { now: () => NOW, getJwks: () => Promise.reject(new Error("jwks fetch failed")) },
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
  assert.equal((await res.json()).error, "auth_unavailable");
});

test("E11: an anonymous Supabase session cannot mint tile URLs", async () => {
  assert.equal((await get(PATH, await signHs256(claims({ is_anonymous: true })))).status, 401);
});
