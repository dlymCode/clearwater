"""Step 3 - reproject and align everything to the 2 m EPSG:32610 grid.

    python -m pipeline.align --aoi skagit --stage laz    # LAZ -> 1 m raster via PDAL (before to_mllw)
    python -m pipeline.align --aoi skagit --stage warp   # data/<aoi>/mllw/<source>/* -> align/<source>/elev.tif

The grid origin and extent are snapped to 1,000 m multiples (``geo.grid_for_lonlat_bbox``) and
passed to gdalwarp as ``-te`` together with ``-tr 2 2 -tap`` so every layer has identical
shape and transform. DEMs use bilinear, lidar point DEMs over the flats use ``-r min``
(shoalest wins on downsampling), categorical/date rasters use nearest. The command builders
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

from .common import CELL_M, WORK_CRS, Manifest, step_dir
from .geo import Grid, grid_for_lonlat_bbox

RESAMPLING = {"dem": "bilinear", "lidar": "min", "categorical": "near"}
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


def stage_laz(aoi: str, data_dir: Path) -> None:
    """Rasterize each fetched LAZ to a 1 m NAVD88 raster and register it (units m, NAVD88) for to_mllw."""
    fetch = Manifest.load(step_dir(data_dir, aoi, "fetch"), aoi, "fetch")
    for e in fetch.select(kind="laz"):
        out_tif = fetch.directory / e.source / (Path(e.path).stem + "_1m.tif")
        run_pdal(pdal_pipeline(fetch.directory / e.path, out_tif), fetch.directory / "pdal" / (Path(e.path).stem + ".json"))
        fetch.add_file(out_tif, source_url=e.source_url, crs=e.crs, source=e.source, kind="dem",
                       vertical_crs=e.vertical_crs or "NAVD88", vertical_units=e.vertical_units or "m", meta=e.meta)
    fetch.save()


def stage_warp(aoi: str, data_dir: Path) -> Manifest:
    mllw = Manifest.load(step_dir(data_dir, aoi, "mllw"), aoi, "mllw")
    out_dir = step_dir(data_dir, aoi, "align")
    grid = aoi_grid(aoi)
    out = Manifest(out_dir, aoi, "align")
    for source in mllw.sources("dem"):
        files = [mllw.directory / e.path for e in mllw.select(source=source, kind="dem")]
        dst = out_dir / source / "elev.tif"
        dst.parent.mkdir(parents=True, exist_ok=True)
        run_cmd(warp_command(files, dst, grid, RESAMPLING[kind_of(source)], nodata=float("nan")))
        out.add_file(dst, source_url=None, crs=WORK_CRS, source=source, kind="dem",
                     vertical_crs="MLLW", vertical_units="ft", meta=mllw.select(source=source)[0].meta)
        # gdalwarp keeps dataset tags only from the first input; re-assert the vertical CRS explicitly.
        _retag(dst)
    (out_dir / "grid.json").write_text(json.dumps(grid.to_dict(), indent=2))
    out.save()
    return out


def _retag(path: Path) -> None:
    import rasterio  # lazy

    from .common import vertical_tags

    with rasterio.open(path, "r+") as ds:
        ds.update_tags(**vertical_tags())


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--stage", choices=["laz", "warp"], required=True)
    a = p.parse_args(argv)
    if a.stage == "laz":
        stage_laz(a.aoi, a.data_dir)
    else:
        stage_warp(a.aoi, a.data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
