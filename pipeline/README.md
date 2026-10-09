# Clearwater data pipeline

Python 3.12 batch pipeline that turns public bathymetry/imagery into the tiles the app reads.
Every step is file-in/file-out under `data/<aoi>/<step>/` with a `manifest.json` (source URL,
download date, SHA-256, CRS) and is safe to rerun. AOIs run independently:
`skagit`, `port_susan`, `snohomish`, `padilla_samish`, `nisqually`.

Working grid: EPSG:32610, 2 m cells, origin snapped to 1,000 m. Vertical: feet, MLLW, positive up.
Tiles are reprojected to EPSG:3857 only at the very end.

## Run

```bash
pip install -r pipeline/requirements-dev.txt     # tests only: numpy + pytest (+ jsonschema, ruff)
python3 -m pytest pipeline/tests -q               # from the repo root (or `pytest tests -q` inside pipeline/)

cd pipeline
make test                                         # same suite
make skagit                                       # fetch -> laz -> mllw -> align -> meta -> waterline -> merge -> tiles -> validate -> publish
make AOI=skagit step-merge                        # any single step
make tides                                        # daily: 30-day tide predictions, one JSON per station (data/tides/)
```

Steps are modules: `python -m pipeline.<module> --aoi <slug> [--data-dir data]`.

| Step | Module | Output (under `data/<aoi>/`) |
| --- | --- | --- |
| 1 fetch | `fetch_baseline` | `fetch/manifest.json`, `fetch/scenes.json` (each scene tagged with nearest-station tide + station id) |
| 2 datum | `to_mllw` | `mllw/<source>/*_mllw_ft.tif` (tags `VERTICAL_CRS=MLLW`, `VERTICAL_UNITS=ft`) |
| 3 align | `align` (`--stage laz`, `--stage warp`) | `align/<source>/elev.tif`, `align/grid.json` |
| 4 meta | `source_meta` | `align/<source>/date.tif` (int32 days since 1970), `unc.tif` (float32 ft) |
| 5 waterline | `waterline_dem` | `waterline/{elev,bracket,date,n}.tif` |
| 6 merge | `merge` | `merge/merged_{elev,src,date,unc}.tif` |
| 7 validate | `validate` | `validate/report.{html,json}`; **exit 1 unless every gate below passes** |
| 8 tiles | `tiles` | `tiles/{depth,depth_meta,waterline,base}.pmtiles` |
| 9 publish | `publish` | R2 `tiles/<aoi>/<version>/...` + `tiles/index.json` (schema: `schemas/tiles_index.schema.json`), plus flat `tides/<station_id>.json` |

`merged_src` codes (uint8, `common.SOURCES`): 1 bluetopo, 2 ehydro, 3 lidar_ncmp, 4 lidar_2014,
5 wa_lidar, 6 cudem, 7 coned, 8 waterline (only joins the merge with `--include-waterline`); 0 = hole.
Layer order in that table is also the final tie-break priority.

## Tides on R2

`make <aoi>` runs `step-tides` (fetch_tides) before `step-publish`; publish then uploads **every** station JSON in
`data/tides/` to R2 as `tides/<station_id>.json` - flat and unversioned (overwritten daily; the app downloads them through the
signed-URL worker). They are not listed in `tiles/index.json`. All stations are uploaded, not just those near one AOI, because
the app picks the nearest station by distance from the lat/lon in each file and the whole set is ~0.5 MB. Each file is checked
before upload (station_id matches the file name, MLLW/ft, predictions reach at least 7 days ahead); stale or malformed files
abort the publish. In CI/cron the daily job is just `make tides` + `python -m pipeline.publish --aoi <x>`; for tides only, run
`fetch_tides` and call `publish.publish_tides(...)`.

## Gates (all fail closed)

`validate` writes `validate/report.json`; `gate.passed` is true only if all of these pass:

* **Waterline gate** - p90 absolute error <= 1.5 ft from >= 30 waterline samples in total, >= 1 sample from
  *every* ground-truth run, and >= 3 runs (`make` also insists on >= 3 CSVs). A gate that can pass on one
  lucky point is worthless, so fewer samples = failure. Per-source `coverage` (fraction of truth points
  with a prediction) is in the report.
* **Shoreline datum check (mandatory)** - median merged elevation at ENC COALNE cells must be within
  +/- 1.5 ft of the AOI's expected MHHW (`common.AOI_MHHW_FT`). No COALNE file or < 50 shoreline cells = failure.
  **The MHHW table values are estimates marked TODO-verify against the NOAA benchmark sheets (S0-4).**
  Dev-only overrides: `--skip-waterline-gate`, `--skip-shoreline-check` (via `make VALIDATE_FLAGS=...`).
* **Bias gate** - any NAVD88-derived source (cudem, coned, lidar_*) with |mean bias| > 1.5 ft vs. the runs (>= 30 samples).
* **Encode consistency** - if `tiles/depth_rgb.tif` exists, the decoded Terrain-RGB at the truth points must match
  `merged_elev` within 0.06 ft (warning only when the file is absent).

`publish` re-checks independently (also for a direct `python -m pipeline.publish`, no bypass flag): the report must
exist, name the AOI, say `gate.passed: true`, be **newer than every tile file**, and no tile may be **older than
`merge/merged_elev.tif`**.

## Contracts worth knowing

* **Terrain-RGB is in feet**, standard Mapbox formula (`-10000 + 0.1 * (R*65536 + G*256 + B)`),
  `RGB = (0,0,0)` reserved for no-data. MapLibre hillshade assumes metres, so scale exaggeration by ~0.3048.
* **`depth_meta.pmtiles`** (source/date/uncertainty) is shipped next to `depth.pmtiles` but is *not* in
  `tiles/index.json` (the agreed schema has no slot). Encoding (4-bit source | 4-bit uncertainty bucket in R,
  uint16 days-since-1880 in G/B, alpha = validity flag) is documented at the top of `tiles.py`. Uncertainty buckets
  (`common.UNC_LEVELS_FT`): indices 0..14 are 0, .25, .5, .75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 45+ ft (rounded up,
  >= 45 clamps to 14); **index 15 means UNKNOWN and nothing else**. Dates outside 1880..2059 are clamped with a logged warning.
* **Index entries for products that do not exist yet** (e.g. `fleet` in Phase 1) are listed with `bytes: 0`
  and are not uploaded.
* **Tide JSON** (`data/tides/<station_id>.json`): `station_id, name, datum, units, lat, lon, predictions`; lat/lon come from the
  CO-OPS metadata API.
* Merge input rasters must carry `VERTICAL_CRS=MLLW` + `VERTICAL_UNITS=ft`; anything else is rejected. LAZ files need an
  explicit vertical datum and units in the manifest (no defaults).
* `waterline` masks cells with fewer than 5 usable scenes, but `n.tif` keeps the raw count. Scenes within 60 s of each
  other count as ONE satellite pass (duplicates / overlapping granules are combined per cell before counting).
* Files of one source with different dates (e.g. CUDEM `2023v1` + `2024v1` tiles) are warped separately and mosaicked
  together with their own per-cell dates; mixed metadata is never collapsed into one date.

## Known spec issues flagged to the PRD owner

* **The 10-year rule is redundant as specified.** "Skip a source older than 10 years if a source under 10 years covers the
  cell" can never change a newest-wins result: an older-than-10-year source can only win if no younger source covers the cell.
  The rule is implemented to match the PRD text, and `test_ten_year_rule_never_changes_newest_wins_outcomes` asserts the
  equivalence on randomized stacks so the intent survives future changes. If the intent was different (e.g. prefer lower
  uncertainty from a recent source over a newer-but-uncertain one), the PRD needs to say so.
* PRD MAP-4 (hatch cells with < 5 scenes) conflicts with step 5 (require >= 5 scenes); this pipeline follows step 5.

## Tests (numpy + pytest only)

All rasterio/GDAL/PDAL/pyproj/pystac/boto3 imports are lazy (inside functions) and a test
(`test_all_modules_import_without_geo_stack`) imports every module with those packages blocked.
Covered: merge rules (newest wins, tie-break, 10-year rule + equivalence property, holes), waterline DEM on a synthetic
12-scene tide ramp (< 1 ft error), Terrain-RGB and source/date round trips, datum arithmetic on 5 points,
UTM 10N math and AOI grid snapping, gdalwarp/PDAL/ogr2ogr/tippecanoe command builders (never executed),
tiles-index schema, R2 publish ordering (data before index) with a fake client, `validate.py` p90 gate,
shoreline datum check, CO-OPS parsing/interpolation and the fetch orchestration with injected fakes.

## What is stubbed / needs accounts, tools or data (TODO)

* **Real downloads were never run.** `fetch_baseline` network code is unit-tested through injected fakes only.
  * CUDEM needs NOAA's tile index converted to GeoJSON (`--cudem-index`); URL layout unverified.
  * BlueTopo: wrapper calls `nbs.bluetopo.fetch_tiles(dir, desired_area_filename=...)` - confirm the signature for the pinned version.
  * Sentinel-2: Planetary Computer STAC search + COG window read implemented, untested against the live service.
* **Manual downloads** (register with `fetch_baseline --register FILE --source NAME --vertical-crs NAVD88 --units m --meta '{"flight_date": "2014-09-15"}'`):
  CoNED tiles, 2014 and 2020/21 lidar DEMs/LAZ, eHydro XYZ rasterized to a DEM, ENC `.000` cells in `fetch/enc/`, VDatum GTX grid.
* **LAZ classes**: the PRD says classes 2 + 29, but ASPRS-style bathymetric bottom is often **class 40**. Verify against the
  real LAZ in S0 and pass `align --stage laz --classes 2,40` if needed.
* **Nisqually tide station (LOUD TODO)**: Nisqually scenes are tagged from the Tacoma reference station because no nearer
  station is registered. A nearer subordinate station must be selected from the CO-OPS metadata API in S0 (see `coops.py`);
  until then the Nisqually waterline DEM should not be trusted. A warning prints during the fetch.
* **VDatum**: `to_mllw.GtxOffset` uses pyproj `vgridshift`; the grid sign convention must be verified against the NOAA Seattle
  benchmark (S0-4) - flip `--multiplier -1` if needed. `--constant-offset-m` exists for tests only and must not be used to publish.
* **BlueTopo RAT / CoNED source-survey decode**: arrays are decoded in pure numpy, but `read_bluetopo_rat` (GDAL) and the aligned
  `contributor.tif` / `uncertainty.tif` / `rat.json` inputs are not produced automatically yet. CoNED per-cell uncertainty is a 1 ft placeholder.
* **Tide tagging** uses hi/lo predictions with cosine interpolation (subordinate stations publish nothing else): expect a few
  tenths of a foot of error. Subordinate station IDs (La Conner, Stanwood, Everett, Coupeville) are resolved at runtime from the
  CO-OPS metadata API by name; coordinates in `coops.py` are approximate.
* **Tiles**: GDAL (MBTILES driver), `tippecanoe` and the `pmtiles` CLI must be on PATH. `stage_vector` only emits ENC layers - WDFW boundaries,
  OSM land (separate PMTiles file for ODbL) and the Sound-wide low-zoom file are not built yet. The fleet layer (Phase 2) is not built.
* **Publish**: needs `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (scoped to `tiles/`). `--dry-run` works without them.
* **Ground truth**: at least three sounder-run CSVs (`time,lat,lon,depth,speed[,tide_ft]`) in `data/ground_truth/<aoi>/` are required before `make <aoi>` will publish; the Skagit runs need waterline coverage on each run.
* Regression diff (`validate.regression_shallower`) is a function, not yet wired into the CLI.
