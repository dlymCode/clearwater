// Consumer test: every path the PIPELINE publishes must be signable. Reads the pipeline's own example
// index (pinned by pipeline/schemas/tiles_index.schema.json and publish.py) so a naming change on either
// side breaks a test instead of every download. This is the regression for "version directories contain
// ':' and the validator rejected all of them".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateTilePath } from "../src/paths.ts";

const FIXTURE = new URL("../../../pipeline/tests/fixtures/tiles_index.example.json", import.meta.url);
const index = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  aois: Array<{ aoi: string; version: string; files: Record<string, { path: string }> }>;
};

test("the fixture is non-trivial and its versions are ISO timestamps with colons", () => {
  assert.ok(index.aois.length >= 2);
  for (const a of index.aois) assert.match(a.version, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("every file path in tiles/index.json validates", () => {
  let n = 0;
  for (const a of index.aois) {
    for (const [kind, f] of Object.entries(a.files)) {
      assert.equal(validateTilePath(f.path), f.path, `${a.aoi}/${kind}: ${f.path}`);
      n++;
    }
  }
  assert.ok(n >= 8);
});

test("the extra files publish.py uploads next to the index entries validate too (depth_meta, land)", () => {
  for (const a of index.aois) {
    for (const name of ["depth_meta.pmtiles", "land.pmtiles"]) {
      const p = `tiles/${a.aoi}/${a.version}/${name}`;
      assert.equal(validateTilePath(p), p, p);
    }
  }
});

test("the index itself and a tide JSON validate", () => {
  assert.equal(validateTilePath("tiles/index.json"), "tiles/index.json");
  assert.equal(validateTilePath("tides/9447130.json"), "tides/9447130.json");
});
