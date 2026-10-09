import assert from "node:assert/strict";
import { test } from "node:test";
import { amzDate, presignGet, uriEncode } from "../src/sigv4.ts";

// The worked example from the AWS docs, "Authenticating Requests: Using Query Parameters (AWS
// Signature Version 4)". These are AWS's published example credentials, not secrets.
test("presignGet reproduces the AWS documentation example signature", async () => {
  const url = await presignGet({
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    expiresSeconds: 86400,
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z" +
      "&X-Amz-Expires=86400" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("R2-style URL: path-style bucket, region auto, 24 h expiry", async () => {
  const url = new URL(
    await presignGet({
      host: "acct123.r2.cloudflarestorage.com",
      path: "/clearwater-tiles/tiles/skagit/2026-10-09T00:00:00Z/depth.pmtiles",
      accessKeyId: "AKIDEXAMPLEPLACEHOLDER",
      secretAccessKey: "placeholder-secret-for-unit-tests-only",
      region: "auto",
      expiresSeconds: 86400,
      now: new Date("2026-10-09T12:34:56.789Z"),
    }),
  );
  assert.equal(url.host, "acct123.r2.cloudflarestorage.com");
  assert.equal(url.pathname, "/clearwater-tiles/tiles/skagit/2026-10-09T00%3A00%3A00Z/depth.pmtiles");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "86400");
  assert.equal(url.searchParams.get("X-Amz-Date"), "20261009T123456Z");
  assert.equal(url.searchParams.get("X-Amz-Credential"), "AKIDEXAMPLEPLACEHOLDER/20261009/auto/s3/aws4_request");
  assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
});

test("signature depends on the key, the time and the secret", async () => {
  const base = {
    host: "h.example",
    path: "/b/tiles/a.pmtiles",
    accessKeyId: "AK",
    secretAccessKey: "s1",
    region: "auto",
    expiresSeconds: 60,
    now: new Date("2026-01-01T00:00:00Z"),
  };
  const sig = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");
  const a = sig(await presignGet(base));
  assert.notEqual(a, sig(await presignGet({ ...base, path: "/b/tiles/b.pmtiles" })));
  assert.notEqual(a, sig(await presignGet({ ...base, secretAccessKey: "s2" })));
  assert.notEqual(a, sig(await presignGet({ ...base, now: new Date("2026-01-01T00:00:01Z") })));
  assert.equal(a, sig(await presignGet(base)));
});

test("expiry bounds", async () => {
  const p = { host: "h", path: "/b/k", accessKeyId: "a", secretAccessKey: "s", region: "auto", now: new Date() };
  await assert.rejects(presignGet({ ...p, expiresSeconds: 0 }), RangeError);
  await assert.rejects(presignGet({ ...p, expiresSeconds: 604801 }), RangeError);
});

test("helpers", () => {
  assert.equal(uriEncode("a b/c~d", true), "a%20b/c~d");
  assert.equal(uriEncode("a/b", false), "a%2Fb");
  assert.deepEqual(amzDate(new Date("2013-05-24T00:00:00Z")), { date: "20130524", datetime: "20130524T000000Z" });
});
