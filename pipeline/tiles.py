"""Step 8 - tiles: Terrain-RGB / source-date encoding, GDAL + tippecanoe + pmtiles wrappers.

    python -m pipeline.tiles --aoi skagit --stage raster|vector|all

Encodings (pure numpy, unit-tested)
-----------------------------------
**Depth (Terrain-RGB)** - the standard Mapbox formula::

    value = (R * 65536 + G * 256 + B)      height = -10000 + value * 0.1

**Units are FEET MLLW (positive up), not metres**: 0.1 ft resolution, range -10,000..+1.6 M ft.
(MapLibre hillshade assumes metres, so the app should scale hillshade exaggeration by 0.3048.)
``R=G=B=0`` (decodes to -10,000 ft) is reserved for "no data"; decoders return NaN for it.

**Source/date/uncertainty (RGBA, 8 bits per channel, alpha used only as a validity flag)**::

    R = (source_code << 4) | unc_index      source_code 0..15 (see common.SOURCES), unc_index 0..15
    G, B = big-endian uint16 of (days_since_1970 + 32872), i.e. days since 1880-01-01 (to 2059)
    A = 255 valid cell, 0 hole (all other channels 0)

``unc_index`` indexes ``common.UNC_LEVELS_FT`` (0..14, rounded *up* so the popup never understates
uncertainty; anything >= 45 ft clamps to 14 = "45+"). Index 15 means UNKNOWN uncertainty and nothing else. Alpha is deliberately not data: browsers premultiply alpha and would destroy RGB.

Tile resampling MUST be nearest-neighbour: averaging encoded RGB bytes is meaningless.
Subprocess wrappers (gdalwarp, gdal_translate, tippecanoe, pmtiles, ogr2ogr) only build and
run command lines; unit tests check the argument lists and never execute them.
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np

from .common import (DATE_NODATA, OUT_CRS, UNC_LEVELS_FT, UNC_UNKNOWN_INDEX, ZOOMS, clean_profile, step_dir)

# ------------------------------------------------------------------ Terrain-RGB
TERRAIN_BASE = -10000.0
TERRAIN_INTERVAL = 0.1
_TERRAIN_MAX = (1 << 24) - 1


def encode_terrain_rgb(elev_ft: np.ndarray) -> np.ndarray:
    """(H, W) float feet -> (H, W, 3) uint8 Terrain-RGB. NaN/out-of-range -> (0, 0, 0)."""
    z = np.asarray(elev_ft, dtype=np.float64)
    finite = np.isfinite(z)
    v = np.rint((np.where(finite, z, TERRAIN_BASE) - TERRAIN_BASE) / TERRAIN_INTERVAL)
    ok = finite & (v >= 1) & (v <= _TERRAIN_MAX)
    v = np.where(ok, v, 0).astype(np.uint32)
    return np.stack([(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF], axis=-1).astype(np.uint8)


def decode_terrain_rgb(rgb: np.ndarray) -> np.ndarray:
    """Inverse of :func:`encode_terrain_rgb` -> float32 feet, NaN for the reserved no-data code."""
    a = np.asarray(rgb)[..., :3].astype(np.uint32)
    v = (a[..., 0] << 16) | (a[..., 1] << 8) | a[..., 2]
    z = TERRAIN_BASE + v.astype(np.float64) * TERRAIN_INTERVAL
    return np.where(v == 0, np.nan, z).astype(np.float32)


# ------------------------------------------------------------------ source/date/unc pack
log = logging.getLogger(__name__)
_DATE_EPOCH_SHIFT = (dt.date(1970, 1, 1) - dt.date(1880, 1, 1)).days  # 32872


def encode_unc_index(unc_ft: np.ndarray) -> np.ndarray:
    """Bucket index 0..14 (round up, clamp >= 45 ft to 14); NaN/inf/negative -> 15 (unknown, used for nothing else)."""
    u = np.asarray(unc_ft, dtype=np.float64)
    known = np.isfinite(u) & (u >= 0)  # negative uncertainty is bad data, never "0 ft": treat as unknown
    levels = np.asarray(UNC_LEVELS_FT)
    idx = np.searchsorted(levels, np.where(known, u, 0.0), side="left")  # smallest level >= u
    idx = np.minimum(idx, len(levels) - 1)
    return np.where(known, idx, UNC_UNKNOWN_INDEX).astype(np.uint8)


def pack_source_date(src: np.ndarray, date: np.ndarray, unc_ft: np.ndarray) -> np.ndarray:
    """(H, W) src uint8, date int32 days-since-1970, unc float ft -> (H, W, 4) uint8 RGBA."""
    src_in = np.asarray(src)
    if src_in.size and (src_in.max() > 15 or src_in.min() < 0):  # check BEFORE the uint8 cast (256 would wrap to 0)
        raise ValueError("source codes must be 0..15 to fit in 4 bits")
    src = src_in.astype(np.uint8)
    date = np.asarray(date).astype(np.int64)
    hole = (src == 0) | (date == DATE_NODATA)
    shifted = date + _DATE_EPOCH_SHIFT
    clamped = int((~hole & ((shifted < 0) | (shifted > 65535))).sum())
    if clamped:
        log.warning("%d cell date(s) outside the packable 1880-01-01..2059-06 range were clamped", clamped)
    d16 = np.clip(shifted, 0, 65535).astype(np.uint16)
    r = ((src.astype(np.uint8) << 4) | encode_unc_index(unc_ft)).astype(np.uint8)
    out = np.stack([r, (d16 >> 8).astype(np.uint8), (d16 & 0xFF).astype(np.uint8),
                    np.where(hole, 0, 255).astype(np.uint8)], axis=-1)
    out[hole] = 0
    return out


def unpack_source_date(rgba: np.ndarray) -> dict[str, np.ndarray]:
    a = np.asarray(rgba)
    valid = a[..., 3] == 255
    d16 = (a[..., 1].astype(np.int64) << 8) | a[..., 2].astype(np.int64)
    idx = a[..., 0] & 0x0F
    known = valid & (idx != UNC_UNKNOWN_INDEX)
    levels = np.asarray(UNC_LEVELS_FT + (np.nan,), dtype=np.float32)  # index 15 -> NaN (unknown)
    return {
        "valid": valid,
        "src": np.where(valid, a[..., 0] >> 4, 0).astype(np.uint8),
        "unc_ft": np.where(known, levels[idx], np.nan).astype(np.float32),
        "unc_unknown": valid & (idx == UNC_UNKNOWN_INDEX),
        "date": np.where(valid, d16 - _DATE_EPOCH_SHIFT, DATE_NODATA).astype(np.int32),
    }


# ------------------------------------------------------------------ fleet meta (boats / newest day)
MAX_BOATS_PACKED = 255


def pack_fleet_meta(boats: np.ndarray, day: np.ndarray) -> np.ndarray:
    """(H, W) boats (0 = hole) and newest contributing day (int32 days since 1970) -> (H, W, 4) uint8 RGBA.

    R = distinct-boat count (clamped to 255), G,B = big-endian uint16 days since 1880-01-01 (same epoch as
    ``depth_meta``), A = 255 valid / 0 hole (alpha is only a validity flag; RGB zeroed in holes).
    Published cells always have boats >= 3; the app may still hatch ``boats < 3`` as defense in depth.
    """
    boats = np.asarray(boats)
    day = np.asarray(day).astype(np.int64)
    hole = (boats <= 0) | (day == DATE_NODATA)
    shifted = day + _DATE_EPOCH_SHIFT
    clamped = int((~hole & ((shifted < 0) | (shifted > 65535))).sum())
    if clamped:
        log.warning("%d fleet cell date(s) outside the packable 1880-01-01..2059-06 range were clamped", clamped)
    d16 = np.clip(shifted, 0, 65535).astype(np.uint16)
    r = np.clip(boats, 0, MAX_BOATS_PACKED).astype(np.uint8)
    out = np.stack([r, (d16 >> 8).astype(np.uint8), (d16 & 0xFF).astype(np.uint8), np.where(hole, 0, 255).astype(np.uint8)], axis=-1)
    out[hole] = 0
    return out


def unpack_fleet_meta(rgba: np.ndarray) -> dict[str, np.ndarray]:
    a = np.asarray(rgba)
    valid = a[..., 3] == 255
    d16 = (a[..., 1].astype(np.int64) << 8) | a[..., 2].astype(np.int64)
    return {"valid": valid, "boats": np.where(valid, a[..., 0], 0).astype(np.uint8),
            "day": np.where(valid, d16 - _DATE_EPOCH_SHIFT, DATE_NODATA).astype(np.int32)}


# ------------------------------------------------------------------ subprocess wrappers
def require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"{name} not found on PATH (see pipeline/README.md)")
    return path


def run(cmd: Sequence[str], env: Mapping[str, str] | None = None) -> None:
    require_tool(cmd[0])
    import os

    subprocess.run(list(cmd), check=True, env={**os.environ, **(env or {})})


def gdalwarp_3857_cmd(src: str | Path, dst: str | Path) -> list[str]:
    """Reproject to web mercator at the very end; nearest so encoded bytes survive."""
    return ["gdalwarp", "-overwrite", "-t_srs", OUT_CRS, "-r", "near", "-wo", "NUM_THREADS=ALL_CPUS",
            "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", str(src), str(dst)]


def mbtiles_cmd(src_3857: str | Path, dst_mbtiles: str | Path, zmin: int, zmax: int) -> list[str]:
    return ["gdal_translate", "-of", "MBTILES", "-co", "TILE_FORMAT=PNG", "-co", f"MINZOOM={zmin}", "-co", f"MAXZOOM={zmax}",
            "-co", "RESAMPLING=NEAREST", str(src_3857), str(dst_mbtiles)]


def pmtiles_convert_cmd(src: str | Path, dst: str | Path) -> list[str]:
    return ["pmtiles", "convert", str(src), str(dst)]


def raster_pmtiles_cmds(rgb_tif: str | Path, workdir: str | Path, out_pmtiles: str | Path, kind: str) -> list[list[str]]:
    """warp -> MBTILES -> PMTiles for one encoded raster product (``depth``/``waterline``/``fleet``/``meta``).

    ``meta`` (source/date/unc RGBA) ships as ``depth_meta.pmtiles`` next to ``depth.pmtiles``; it is
    not listed in ``tiles/index.json`` (contract has no slot for it) - the app derives its path by convention.
    """
    zmin, zmax = ZOOMS[{"meta": "depth", "fleet_meta": "fleet"}.get(kind, kind)]
    wd = Path(workdir)
    merc, mb = wd / f"{kind}_3857.tif", wd / f"{kind}.mbtiles"
    return [gdalwarp_3857_cmd(rgb_tif, merc), mbtiles_cmd(merc, mb, zmin, zmax), pmtiles_convert_cmd(mb, out_pmtiles)]


# ------------------------------------------------------------------ vector
ENC_LAYERS: tuple[str, ...] = ("DEPARE", "DEPCNT", "SOUNDG", "COALNE", "BOYLAT", "LIGHTS", "OBSTRN", "WRECKS", "CBLSUB")
S57_OPTIONS = "SPLIT_MULTIPOINT=ON,ADD_SOUNDG_DEPTH=ON,RETURN_PRIMITIVES=OFF,RETURN_LINKAGES=OFF,LNAM_REFS=ON"


def ogr2ogr_cmd(enc_cell: str | Path, layer: str, out_geojson: str | Path) -> list[str]:
    if layer not in ENC_LAYERS:
        raise ValueError(f"unexpected ENC layer {layer!r}")
    return ["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-skipfailures", str(out_geojson), str(enc_cell), layer]


def enc_to_geojson_cmds(enc_cells: Sequence[str | Path], out_dir: str | Path) -> list[list[str]]:
    """One GeoJSON per layer per cell (merge cells per layer downstream). Run with ``env={'OGR_S57_OPTIONS': S57_OPTIONS}``."""
    out = Path(out_dir)
    return [ogr2ogr_cmd(c, layer, out / f"{Path(c).stem}_{layer}.geojson") for c in enc_cells for layer in ENC_LAYERS]


def tippecanoe_cmd(layers: Mapping[str, str | Path | Sequence[str | Path]], out_pmtiles: str | Path,
                   zmin: int, zmax: int) -> list[str]:
    """``layers`` maps vector layer name -> one GeoJSON path or a list of them (one per ENC cell;
    repeated ``-L name:file`` entries with the same name are combined into a single layer)."""
    cmd = ["tippecanoe", "-o", str(out_pmtiles), "--force", f"-Z{zmin}", f"-z{zmax}", "--drop-densest-as-needed",
           "--extend-zooms-if-still-dropping", "--read-parallel"]
    for name, paths in layers.items():
        for path in ([paths] if isinstance(paths, (str, Path)) else paths):
            cmd += ["-L", f"{name}:{path}"]
    return cmd


# ------------------------------------------------------------------ IO + CLI (rasterio, lazy)
def write_rgb_geotiff(path: Path, arr: np.ndarray, grid_ref: Path) -> None:
    import rasterio  # lazy

    with rasterio.open(grid_ref) as ref:
        prof = clean_profile(ref.profile)
    bands = arr.shape[-1]
    prof.update(dtype="uint8", count=bands, nodata=None, compress="deflate",
                photometric="RGB" if bands == 3 else None)
    prof = {k: v for k, v in prof.items() if v is not None}
    with rasterio.open(path, "w", **prof) as dst:
        for i in range(bands):
            dst.write(arr[..., i], i + 1)
        if bands == 4:
            from rasterio.enums import ColorInterp

            dst.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)


def stage_raster(aoi: str, data_dir: Path) -> list[Path]:
    import rasterio  # lazy

    merge_dir = step_dir(data_dir, aoi, "merge")
    out = step_dir(data_dir, aoi, "tiles")
    out.mkdir(parents=True, exist_ok=True)
    ref = merge_dir / "merged_elev.tif"
    products: list[tuple[str, np.ndarray]] = []
    with rasterio.open(ref) as ds:
        products.append(("depth", encode_terrain_rgb(ds.read(1))))
    with rasterio.open(merge_dir / "merged_src.tif") as s, rasterio.open(merge_dir / "merged_date.tif") as d, \
            rasterio.open(merge_dir / "merged_unc.tif") as u:
        products.append(("meta", pack_source_date(s.read(1), d.read(1), u.read(1))))
    wl = step_dir(data_dir, aoi, "waterline") / "elev.tif"
    if wl.exists():
        with rasterio.open(wl) as ds:
            products.append(("waterline", encode_terrain_rgb(ds.read(1))))
    made: list[Path] = []
    for kind, arr in products:
        tif = out / f"{kind}_rgb.tif"
        write_rgb_geotiff(tif, arr, ref)
        pm = out / ("depth_meta.pmtiles" if kind == "meta" else f"{kind}.pmtiles")
        for cmd in raster_pmtiles_cmds(tif, out, pm, kind):
            run(cmd)
        made.append(pm)
    return made


#: Layers whose absence is fatal: no depth areas or shoreline means the base map is unusable.
REQUIRED_ENC_LAYERS: tuple[str, ...] = ("DEPARE", "COALNE")


def collect_layer_files(geojson_dir: Path) -> dict[str, list[Path]]:
    """Every per-cell GeoJSON for each ENC layer (all cells are tiled; WRECKS/OBSTRN are hazard layers)."""
    out = {layer: sorted(geojson_dir.glob(f"*_{layer}.geojson")) for layer in ENC_LAYERS}
    missing = [layer for layer in REQUIRED_ENC_LAYERS if not out[layer]]
    if missing:
        raise FileNotFoundError(f"required ENC layer(s) produced no output from any cell: {', '.join(missing)}")
    return {k: v for k, v in out.items() if v}


# ---- optional vector inputs (path conventions; both are manual/other-step products)
BOUNDARIES_LAYER = "boundaries"
LAND_LAYER = "land"


def boundaries_input(aoi: str, data_dir: Path) -> Path:
    """WDFW crab-region / catch-area boundaries (EPSG:4326 GeoJSON FeatureCollection), optional."""
    return step_dir(data_dir, aoi, "fetch") / "boundaries.geojson"


def land_input(aoi: str, data_dir: Path) -> Path:
    """OSM land polygons clipped to the AOI (EPSG:4326 GeoJSON), optional."""
    return step_dir(data_dir, aoi, "fetch") / "osm_land.geojson"


def check_geojson(path: Path) -> int:
    """Number of features in a GeoJSON FeatureCollection; raises ValueError if unreadable or empty."""
    import json

    try:
        gj = json.loads(Path(path).read_text())
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: not valid JSON ({exc})") from exc
    feats = gj.get("features") if isinstance(gj, dict) else None
    if not isinstance(gj, dict) or gj.get("type") != "FeatureCollection" or not isinstance(feats, list) or not feats:
        raise ValueError(f"{path}: expected a non-empty GeoJSON FeatureCollection")
    return len(feats)


def base_layers(enc_layers: Mapping[str, Sequence[Path]], boundaries: Path | None) -> dict[str, list[Path] | Path]:
    """Layers of base.pmtiles: all ENC cells per layer, plus ``boundaries`` when that input exists.
    OSM land is deliberately NOT here (ODbL share-alike must not touch ENC/boundary tiles)."""
    layers: dict[str, list[Path] | Path] = dict(enc_layers)
    if boundaries is not None and Path(boundaries).exists():
        check_geojson(boundaries)
        layers[BOUNDARIES_LAYER] = Path(boundaries)
    return layers


def land_tippecanoe_cmd(land_geojson: Path, out_pmtiles: Path) -> list[str]:
    return tippecanoe_cmd({LAND_LAYER: land_geojson}, out_pmtiles, *ZOOMS["base"])


def stage_vector(aoi: str, data_dir: Path) -> Path:
    enc_dir = step_dir(data_dir, aoi, "fetch") / "enc"
    cells = sorted(enc_dir.glob("*.000"))
    if not cells:
        raise FileNotFoundError(f"no ENC .000 cells in {enc_dir} (manual download, see README)")
    out = step_dir(data_dir, aoi, "tiles")
    gj = out / "enc_geojson"
    gj.mkdir(parents=True, exist_ok=True)
    for cmd in enc_to_geojson_cmds(cells, gj):
        try:
            run(cmd, env={"OGR_S57_OPTIONS": S57_OPTIONS})
        except subprocess.CalledProcessError:
            # A cell legitimately lacks many optional layers (no lights, no wrecks...). Only the
            # *absence across all cells* of DEPARE/COALNE is fatal (checked below).
            print(f"note: {cmd[-1]} not extracted from {cmd[-2]}", file=sys.stderr)
            Path(cmd[-3]).unlink(missing_ok=True)
    layers = base_layers(collect_layer_files(gj), boundaries_input(aoi, data_dir))
    if BOUNDARIES_LAYER not in layers:
        print(f"note: no {boundaries_input(aoi, data_dir)}; base.pmtiles will have no boundaries layer", file=sys.stderr)
    base = out / "base.pmtiles"
    run(tippecanoe_cmd(layers, base, *ZOOMS["base"]))
    land = land_input(aoi, data_dir)
    if land.exists():  # OSM (ODbL) lives in its own file, published by convention as land.pmtiles
        check_geojson(land)
        run(land_tippecanoe_cmd(land, out / "land.pmtiles"))
    return base


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--stage", choices=["raster", "vector", "all"], default="all")
    a = p.parse_args(argv)
    if a.stage in ("raster", "all"):
        stage_raster(a.aoi, a.data_dir)
    if a.stage in ("vector", "all"):
        stage_vector(a.aoi, a.data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
