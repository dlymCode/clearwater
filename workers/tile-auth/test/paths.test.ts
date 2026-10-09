import assert from "node:assert/strict";
import { test } from "node:test";
import { validateTilePath } from "../src/paths.ts";

test("accepts PMTiles archives and the index under tiles/", () => {
  for (const p of [
    "tiles/index.json",
    "tiles/skagit/2026-10-09T00:00:00Z/base.pmtiles".replace(/:/g, "-"),
    "tiles/skagit/v1/depth.pmtiles",
    "tiles/sound/lowzoom.pmtiles".replace("sound/", "sound/x/"),
    "tides/9447130.json",
    "tides/ps_9447130-v2.json",
  ]) {
    assert.equal(validateTilePath(p), p);
  }
});

test("rejects everything else", () => {
  for (const p of [
    "",
    "index.json",
    "tiles/",
    "tiles/skagit/v1/depth.tif",
    "tiles/skagit/v1/depth.pmtiles.bak",
    "tiles/../secrets/x.pmtiles",
    "tiles/skagit/../x.pmtiles",
    "tiles//skagit/x.pmtiles",
    "tiles/skagit//x.pmtiles",
    "tiles/skagit/%2e%2e/x.pmtiles",
    "tiles/skagit/v1/x.pmtiles?x=1",
    "tiles/skagit\\v1\\x.pmtiles",
    "tiles/skagit/ v1/x.pmtiles",
    "tiles/skagit/.hidden/x.pmtiles",
    "tiles/x.pmtiles",
    "/tiles/skagit/v1/x.pmtiles",
    "private/skagit/v1/x.pmtiles",
    "tiles/index.json/",
    "tiles/" + "a/".repeat(120) + "x.pmtiles",
    "tiles/skagit/v1/ünï.pmtiles",
    "tides/",
    "tides/index.json/",
    "tides/9447130.pmtiles",
    "tides/9447130.json.bak",
    "tides/sub/9447130.json",
    "tides/../tiles/index.json",
    "tides/.json",
    "tides/%2e%2e.json",
    "tides/" + "9".repeat(33) + ".json",
    "tides//9447130.json",
    "/tides/9447130.json",
    "Tides/9447130.json",
  ]) {
    assert.equal(validateTilePath(p), null, JSON.stringify(p));
  }
  assert.equal(validateTilePath(null), null);
  assert.equal(validateTilePath(42), null);
  assert.equal(validateTilePath(undefined), null);
});
