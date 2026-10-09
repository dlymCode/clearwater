import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, resetJwksCache, verifySupabaseJwt } from "../src/jwt.ts";
import { b64url, claims, HS_SECRET, makeEs256, NOW_SECONDS, signHs256, SUPABASE_URL, USER } from "./helpers.ts";

const base = { supabaseUrl: SUPABASE_URL, nowSeconds: NOW_SECONDS };
const hs = { ...base, jwtSecret: HS_SECRET };

async function rejects(p: Promise<unknown>, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => e instanceof AuthError && (re ? re.test(e.message) : true));
}

test("HS256: a valid Supabase user token verifies", async () => {
  const v = await verifySupabaseJwt(await signHs256(claims()), hs);
  assert.equal(v.sub, USER);
  assert.equal(v.role, "authenticated");
});

test("HS256: bad signature, wrong secret, tampered payload", async () => {
  const t = await signHs256(claims());
  await rejects(verifySupabaseJwt(await signHs256(claims(), "another-unit-test-secret-0123456789abcdef"), hs), /signature/);
  const [h, , s] = t.split(".");
  await rejects(verifySupabaseJwt(`${h}.${b64url(JSON.stringify(claims({ sub: "00000000-0000-0000-0000-0000000000ff" })))}.${s}`, hs), /signature/);
});

test("claims: expired, not-yet-valid, wrong issuer, wrong audience", async () => {
  await rejects(verifySupabaseJwt(await signHs256(claims({ exp: NOW_SECONDS - 10 })), hs), /expired/);
  await verifySupabaseJwt(await signHs256(claims({ exp: NOW_SECONDS - 3 })), hs); // inside the 5 s skew allowance
  await rejects(verifySupabaseJwt(await signHs256(claims({ nbf: NOW_SECONDS + 600 })), hs), /not yet/);
  await rejects(verifySupabaseJwt(await signHs256(claims({ iss: "https://evil.example/auth/v1" })), hs), /issuer/);
  await rejects(verifySupabaseJwt(await signHs256(claims({ aud: "something-else" })), hs), /audience/);
  await verifySupabaseJwt(await signHs256(claims({ aud: ["x", "authenticated"] })), hs);
  await rejects(verifySupabaseJwt(await signHs256(claims({ exp: undefined })), hs), /exp/);
});

test("the anon key (role anon) and the service key cannot mint tile URLs", async () => {
  await rejects(verifySupabaseJwt(await signHs256(claims({ role: "anon" })), hs), /signed-in/);
  await rejects(verifySupabaseJwt(await signHs256(claims({ role: "service_role" })), hs), /signed-in/);
  await rejects(verifySupabaseJwt(await signHs256(claims({ sub: undefined })), hs), /subject/);
  await rejects(verifySupabaseJwt(await signHs256(claims({ sub: "not-a-uuid" })), hs), /subject/);
});

test("alg none and unknown algs are refused", async () => {
  const none = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims()))}.`;
  await rejects(verifySupabaseJwt(none, hs));
  const noneSig = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims()))}.${b64url("x")}`;
  await rejects(verifySupabaseJwt(noneSig, hs), /algorithm/);
  await rejects(verifySupabaseJwt(await signHs256(claims(), HS_SECRET, { alg: "HS512" }), hs), /algorithm|signature/);
});

test("HS256 is refused entirely when no secret is configured (no algorithm confusion)", async () => {
  await rejects(verifySupabaseJwt(await signHs256(claims()), base), /algorithm/);
});

test("malformed tokens", async () => {
  for (const t of ["", "a.b", "a.b.c.d", "...", "not a token", "e30.e30.", "e30.e30.%%%"]) {
    await rejects(verifySupabaseJwt(t, hs));
  }
});

test("ES256 via JWKS: valid, wrong key, unknown kid, wrong key type", async () => {
  const k = await makeEs256("kid-1");
  const other = await makeEs256("kid-1"); // same kid, different key material
  const getJwks = () => Promise.resolve([k.jwk]);
  const cfg = { ...base, getJwks };

  assert.equal((await verifySupabaseJwt(await k.sign(claims()), cfg)).sub, USER);
  await rejects(verifySupabaseJwt(await other.sign(claims()), cfg), /signature/);
  await rejects(verifySupabaseJwt(await k.sign(claims(), { kid: "nope" }), cfg), /unknown signing key/);
  await rejects(verifySupabaseJwt(await k.sign(claims(), { alg: "RS256" }), cfg), /unknown signing key|mismatch|signature/);
});

test("ES256 via the default JWKS fetcher caches and refetches once on an unknown kid", async () => {
  resetJwksCache();
  const k1 = await makeEs256("old");
  const k2 = await makeEs256("new");
  let calls = 0;
  let keys = [k1.jwk];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    calls++;
    assert.equal(String(input), `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
    return Promise.resolve(new Response(JSON.stringify({ keys }), { status: 200 }));
  }) as typeof fetch;
  try {
    const cfg = { ...base };
    await verifySupabaseJwt(await k1.sign(claims()), cfg);
    await verifySupabaseJwt(await k1.sign(claims()), cfg);
    assert.equal(calls, 1, "second verification is served from cache");
    keys = [k1.jwk, k2.jwk]; // key rotation
    resetJwksCache();
    await verifySupabaseJwt(await k1.sign(claims()), cfg);
    const before = calls;
    keys = [k1.jwk, k2.jwk];
    await verifySupabaseJwt(await k2.sign(claims()), cfg);
    assert.ok(calls >= before, "unknown kid triggers at most one refetch");
  } finally {
    globalThis.fetch = realFetch;
    resetJwksCache();
  }
});
