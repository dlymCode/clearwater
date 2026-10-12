"""Step 3 - reproject and align everything to the 2 m EPSG:32610 grid.

    python -m pipeline.align --aoi skagit --stage laz    # LAZ -> 1 m raster via PDAL (before to_mllw)
    python -m pipeline.align --aoi skagit --stage warp   # data/<aoi>/mllw/<source>/* -> align/<source>/elev.tif

The grid origin and extent are snapped to 1,000 m multiples (``geo.grid_for_lonlat_bbox``) and
passed to gdalwarp as ``-te`` together with ``-tr 2 2 -tap`` so every layer has identical
shape and transform. DEMs use bilinear, lidar point DEMs over the flats use ``-r min``
(shoalest wins on downsampling). The command builders
are pure and unit-tested; the subprocess calls need GDAL/PDAL on PATH.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Sequence

from .common import (CELL_M, WORK_CRS, Manifest, MissingVerticalCRS, require_mllw_ft, step_dir, uniform_meta,
                     vertical_tags)
from .geo import Grid, grid_for_lonlat_bbox

RESAMPLING = {"dem": "bilinear", "lidar": "min"}
LIDAR_SOURCES = ("lidar_2014", "lidar_ncmp", "wa_lidar")
GROUND_CLASS = 2
BATHY_CLASS = 29  # LAS 1.4 "bathymetric point" (bathy bottom)
LAZ_RASTER_RES_M = 1.0


def kind_of(source: str) -> str:
    return "lidar" if source in LIDAR_SOURCES else "dem"


def _num(v: float) -> str:
    """Plain decimal (never scientific notation) for gdalwarp numeric arguments."""
    if v != v:
        return "nan"
    return format(v, "f").rstrip("0").rstrip(".") or "0"


def warp_command(srcs: Sequence[str | Path], dst: str | Path, grid: Grid, resampling: str = "bilinear",
                 nodata: float | None = None, dtype: str = "Float32") -> list[str]:
    """``gdalwarp -t_srs EPSG:32610 -tr 2 2 -tap -r <method>`` onto the snapped AOI grid."""
    if resampling not in {"bilinear", "min", "near", "cubic", "average"}:
        raise ValueError(f"unsupported resampling {resampling!r}")
    xmin, ymin, xmax, ymax = grid.bounds
    cmd = ["gdalwarp", "-overwrite", "-t_srs", WORK_CRS, "-tr", _num(grid.res), _num(grid.res), "-tap",
           "-te", _num(xmin), _num(ymin), _num(xmax), _num(ymax), "-r", resampling, "-ot", dtype]
    if nodata is not None:
        cmd += ["-dstnodata", _num(nodata)]
    cmd += ["-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER"]
    cmd += [str(s) for s in srcs] + [str(dst)]
    return cmd


def pdal_pipeline(laz_path: str | Path, out_tif: str | Path, *, resolution: float = LAZ_RASTER_RES_M,
                  classes: Sequence[int] = (GROUND_CLASS, BATHY_CLASS), output_type: str = "mean") -> dict:
    """PDAL pipeline: keep classes 2 (ground) and 29 (bathy bottom), rasterize at 1 m.

    ``output_type`` is the per-cell statistic; "mean" for the raw 1 m DEM, since the shoal-side
    bias is applied later by the ``-r min`` warp. Z stays in the LAZ's vertical datum (NAVD88, m).
    """
    rng = ",".join(f"Classification[{c}:{c}]" for c in classes)
    return {
        "pipeline": [
            {"type": "readers.las", "filename": str(laz_path)},
            {"type": "filters.range", "limits": rng},
            {"type": "writers.gdal", "filename": str(out_tif), "resolution": resolution, "output_type": output_type,
             "dimension": "Z", "gdaldriver": "GTiff", "nodata": -9999,
             "gdalopts": "COMPRESS=DEFLATE,TILED=YES", "data_type": "float32"},
        ]
    }


def _require(tool: str) -> str:
    path = shutil.which(tool)
    if not path:
        raise RuntimeError(f"{tool} not found on PATH (install GDAL/PDAL; see pipeline/README.md)")
    return path


def run_cmd(cmd: Sequence[str]) -> None:
    _require(cmd[0])
    subprocess.run(list(cmd), check=True)


def run_pdal(pipeline: dict, pipeline_json: Path) -> None:
    pipeline_json.parent.mkdir(parents=True, exist_ok=True)
    pipeline_json.write_text(json.dumps(pipeline, indent=2))
    run_cmd(["pdal", "pipeline", str(pipeline_json)])


def aoi_grid(aoi: str) -> Grid:
    from .fetch_baseline import AOIS

    return grid_for_lonlat_bbox(AOIS[aoi].bbox, CELL_M)


def parse_classes(text: str) -> tuple[int, ...]:
    classes = tuple(int(c) for c in text.split(",") if c.strip())
    if not classes:
        raise ValueError("no LAZ classes given")
    return classes


def stage_laz(aoi: str, data_dir: Path, classes: Sequence[int] = (GROUND_CLASS, BATHY_CLASS)) -> None:
    """Rasterize each fetched LAZ to a 1 m raster and register it for to_mllw.

    The LAZ's vertical datum and units must be recorded explicitly in the fetch manifest
    (``--vertical-crs`` / ``--units`` at registration); there are no defaults, because a guessed
    datum is exactly the kind of silent 2.4 ft error the pipeline exists to prevent.
    """
    fetch = Manifest.load(step_dir(data_dir, aoi, "fetch"), aoi, "fetch")
    fetch.verify(kinds=["laz"])
    for e in fetch.select(kind="laz"):
        if not e.vertical_crs or not e.vertical_units:
            raise MissingVerticalCRS(f"{e.path}: LAZ manifest entry lacks vertical_crs/vertical_units; "
                                     "re-register it with --vertical-crs and --units")
        out_tif = fetch.directory / e.source / (Path(e.path).stem + "_1m.tif")
        run_pdal(pdal_pipeline(fetch.directory / e.path, out_tif, classes=classes),
                 fetch.directory / "pdal" / (Path(e.path).stem + ".json"))
        fetch.add_file(out_tif, source_url=e.source_url, source=e.source, kind="dem",
                       vertical_crs=e.vertical_crs, vertical_units=e.vertical_units, meta=e.meta)
    fetch.save()


def verify_inputs_mllw(files: Sequence[Path]) -> None:
    """Every warp input must itself be tagged MLLW/ft (to_mllw wrote it); never re-tag blindly."""
    import rasterio  # lazy

    for f in files:
        with rasterio.open(f) as ds:
            require_mllw_ft(dict(ds.tags()), str(f))


def stage_warp(aoi: str, data_dir: Path) -> Manifest:
    mllw = Manifest.load(step_dir(data_dir, aoi, "mllw"), aoi, "mllw")
    mllw.verify()
    out_dir = step_dir(data_dir, aoi, "align")
    grid = aoi_grid(aoi)
    out = Manifest(out_dir, aoi, "align")
    for source in mllw.sources("dem"):
        entries = mllw.select(source=source, kind="dem")
        files = [mllw.directory / e.path for e in entries]
        verify_inputs_mllw(files)
        dst = out_dir / source / "elev.tif"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shared = uniform_meta(entries)
        if shared is not None:
            run_cmd(warp_command(files, dst, grid, RESAMPLING[kind_of(source)], nodata=float("nan")))
            meta = shared
        else:
            # Files of one source carry different dates/uncertainty: warp each alone and mosaic
            # elevation + per-file date + unc together (never one date for the whole source).
            _warp_per_file(source, entries, files, dst, grid)
            meta = {"per_file_meta": True}
        out.add_file(dst, source_url=None, crs=WORK_CRS, source=source, kind="dem",
                     vertical_crs="MLLW", vertical_units="ft", meta=meta)
        _retag(dst)  # inputs verified above; gdalwarp only keeps tags from its first input
    (out_dir / "grid.json").write_text(json.dumps(grid.to_dict(), indent=2))
    out.save()
    return out


def _warp_per_file(source: str, entries, files: Sequence[Path], dst: Path, grid: Grid,
                   strip_rows: int = 1024) -> None:
    import numpy as np
    import rasterio  # lazy
    from rasterio.windows import Window

    from .common import DATE_NODATA, clean_profile
    from .source_meta import mosaic_with_dates

    tmp_dir = dst.parent / "_perfile"
    tmp_dir.mkdir(exist_ok=True)
    warped: list[Path] = []
    for f in files:
        w = tmp_dir / f.name
        run_cmd(warp_command([f], w, grid, RESAMPLING[kind_of(source)], nodata=float("nan")))
        warped.append(w)
    metas = [e.meta for e in entries]
    handles = [rasterio.open(w) for w in warped]
    try:
        prof = clean_profile(handles[0].profile)
        prof.update(count=1, compress="deflate", tiled=True)
        outs = {
            "elev": rasterio.open(dst, "w", **{**prof, "dtype": "float32", "nodata": float("nan")}),
            "date": rasterio.open(dst.with_name("date.tif"), "w", **{**prof, "dtype": "int32", "nodata": DATE_NODATA}),
            "unc": rasterio.open(dst.with_name("unc.tif"), "w", **{**prof, "dtype": "float32", "nodata": float("nan")}),
        }
        try:
            h, wd = handles[0].height, handles[0].width
            for r0 in range(0, h, strip_rows):
                win = Window(0, r0, wd, min(strip_rows, h - r0))
                elevs = [hd.read(1, window=win).astype(np.float32) for hd in handles]
                e, d, u = mosaic_with_dates(source, elevs, metas)
                outs["elev"].write(e, 1, window=win)
                outs["date"].write(d, 1, window=win)
                outs["unc"].write(u, 1, window=win)
        finally:
            for o in outs.values():
                o.close()
    finally:
        for hd in handles:
            hd.close()


def _retag(path: Path) -> None:
    import rasterio  # lazy

    with rasterio.open(path, "r+") as ds:
        ds.update_tags(**vertical_tags())


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--stage", choices=["laz", "warp"], required=True)
    p.add_argument("--classes", default="2,29",
                   help="LAZ classification codes to keep (PRD: 2 ground + 29 bathy bottom). ASPRS bathymetry is "
                        "often class 40; verify against the real LAZ in S0.")
    a = p.parse_args(argv)
    if a.stage == "laz":
        stage_laz(a.aoi, a.data_dir, parse_classes(a.classes))
    else:
        stage_warp(a.aoi, a.data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
