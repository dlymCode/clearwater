// Test helpers: mint Supabase-shaped JWTs with WebCrypto and fake KV / R2.
import type { Env, R2Like } from "../src/index.ts";
import type { KvLike } from "../src/quota.ts";

const enc = new TextEncoder();

export const SUPABASE_URL = "https://testref.supabase.co";
export const USER = "00000000-0000-0000-0000-0000000000a1";
export const NOW_SECONDS = 1_790_000_000; // 2026-09-21T...Z, fixed for determinism
export const NOW = new Date(NOW_SECONDS * 1000);
// Unit-test-only value, not a secret.
export const HS_SECRET = "unit-test-only-jwt-secret-0123456789abcdef";

export function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `${SUPABASE_URL}/auth/v1`,
    aud: "authenticated",
    role: "authenticated",
    sub: USER,
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    ...over,
  };
}

export async function signHs256(payload: Record<string, unknown>, secret = HS_SECRET, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", ...header }));
  const p = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

export interface EcKeys {
  jwk: JsonWebKey & { kid: string };
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function makeEs256(kid = "key-1"): Promise<EcKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    jwk: { ...pub, kid, use: "sig", alg: "ES256" },
    async sign(payload, header = {}) {
      const h = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid, ...header }));
      const p = b64url(JSON.stringify(payload));
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, enc.encode(`${h}.${p}`));
      return `${h}.${p}.${b64url(sig)}`; // WebCrypto already emits raw r||s, which is what JWS wants
    },
  };
}

export class FakeKv implements KvLike {
  store = new Map<string, string>();
  puts: Array<{ key: string; value: string; ttl?: number }> = [];
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, ttl: options?.expirationTtl });
    return Promise.resolve();
  }
}

export function fakeR2(objects: Record<string, number>): R2Like {
  return { head: (key) => Promise.resolve(key in objects ? { size: objects[key] } : null) };
}

export function makeEnv(over: Partial<Env> = {}): Env & { QUOTA: FakeKv } {
  return {
    SUPABASE_URL,
    SUPABASE_JWT_SECRET: HS_SECRET,
    R2_ACCOUNT_ID: "acct123",
    R2_BUCKET: "clearwater-tiles",
    R2_ACCESS_KEY_ID: "AKIDEXAMPLEPLACEHOLDER",
    R2_SECRET_ACCESS_KEY: "placeholder-secret-for-unit-tests-only",
    QUOTA: new FakeKv(),
    ...over,
  } as Env & { QUOTA: FakeKv };
}
