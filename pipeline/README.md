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
make tides                                        # daily: 30-day tide predictions, one JSON per station
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
| 7 validate | `validate` | `validate/report.{html,json}`; **exit 1 if waterline p90 > 1.5 ft** |
| 8 tiles | `tiles` | `tiles/{depth,depth_meta,waterline,base}.pmtiles` |
| 9 publish | `publish` | R2 `tiles/<aoi>/<version>/...` + `tiles/index.json` (schema: `schemas/tiles_index.schema.json`) |

`merged_src` codes (uint8, `common.SOURCES`): 1 bluetopo, 2 ehydro, 3 lidar_ncmp, 4 lidar_2014,
5 wa_lidar, 6 cudem, 7 coned, 8 waterline (only joins the merge with `--include-waterline`); 0 = hole.
Layer order in that table is also the final tie-break priority.

## Contracts worth knowing

* **Terrain-RGB is in feet**, standard Mapbox formula (`-10000 + 0.1 * (R*65536 + G*256 + B)`),
  `RGB = (0,0,0)` reserved for no-data. MapLibre hillshade assumes metres, so scale exaggeration by ~0.3048.
* **`depth_meta.pmtiles`** (source/date/uncertainty) is shipped next to `depth.pmtiles` but is *not* in
  `tiles/index.json` (the agreed schema has no slot). Encoding (4-bit source | 4-bit uncertainty bucket in R,
  uint16 days-since-1880 in G/B, alpha = validity flag) is documented at the top of `tiles.py`.
* **Index entries for products that do not exist yet** (e.g. `fleet` in Phase 1) are listed with `bytes: 0`
  and are not uploaded.
* **Gate fails closed**: no waterline samples under the ground-truth runs = exit 1.
* Merge input rasters must carry `VERTICAL_CRS=MLLW` + `VERTICAL_UNITS=ft`; anything else is rejected.
* `waterline` masks cells with fewer than 5 usable scenes, but `n.tif` keeps the raw count.

## Tests (numpy + pytest only)

All rasterio/GDAL/PDAL/pyproj/pystac/boto3 imports are lazy (inside functions) and a test
(`test_all_modules_import_without_geo_stack`) imports every module with those packages blocked.
Covered: merge rules (newest wins, tie-break, 10-year rule, holes), waterline DEM on a synthetic
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
* **Ground truth**: three sounder-run CSVs (`time,lat,lon,depth,speed[,tide_ft]`) in `data/ground_truth/<aoi>/` are required before `make <aoi>` will publish.
* Regression diff (`validate.regression_shallower`) is a function, not yet wired into the CLI.
