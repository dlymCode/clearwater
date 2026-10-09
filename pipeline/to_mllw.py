"""Step 2 - datum conversion: NAVD88 (m) -> MLLW (ft), vertical CRS written to metadata.

    python -m pipeline.to_mllw --aoi skagit [--gtx path/to/puget_navd88_mllw.gtx | --constant-offset-m 0.716]

Arithmetic (pure numpy)::

    z_mllw_ft = (z_navd88_m + offset_m) * 3.28084      # offset from the VDatum grid at that cell

where ``offset_m`` is the height of the NAVD88 zero plane above MLLW (~ +0.72 m / 2.4 ft at
Seattle). Sources already on MLLW (BlueTopo, eHydro) only get metres -> feet.

A raster with no recorded vertical datum/units is rejected (``MissingVerticalCRS``); the
fetch manifest or the raster's own tags must declare them.

TODO(S0-4): confirm the sign convention of the Puget Sound GTX against the NOAA Seattle
benchmark sheet; flip ``--multiplier`` to -1 if needed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

from .common import (FT_PER_M, TARGET_DATUM, TARGET_UNITS, Manifest, MissingVerticalCRS, require_vertical_crs,
                     step_dir, vertical_tags)


def meters_to_feet(z_m):
    return np.asarray(z_m, dtype=np.float64) * FT_PER_M


def navd88_to_mllw_ft(z_navd88_m, offset_m):
    """NAVD88 metres + grid offset (m, NAVD88 -> MLLW) -> feet MLLW."""
    return (np.asarray(z_navd88_m, dtype=np.float64) + np.asarray(offset_m, dtype=np.float64)) * FT_PER_M


def convert_array(z, src_datum: str, src_units: str, offset_m=None, nodata: float | None = None) -> np.ndarray:
    """Convert an elevation array to float32 feet MLLW (NaN where nodata / outside the datum grid)."""
    src_datum = src_datum.upper()
    z = np.asarray(z, dtype=np.float64)
    bad = ~np.isfinite(z)
    if nodata is not None:
        bad |= z == nodata
    if src_datum == "NAVD88":
        if offset_m is None:
            raise ValueError("NAVD88 input needs a datum offset (VDatum grid or constant)")
        off = np.asarray(offset_m, dtype=np.float64)
        bad = bad | ~np.isfinite(off)
        z_m = z if src_units == "m" else z / FT_PER_M
        out = (z_m + off) * FT_PER_M
    elif src_datum == "MLLW":
        out = z * FT_PER_M if src_units == "m" else z.copy()
    else:
        raise MissingVerticalCRS(f"cannot convert from datum {src_datum!r}")
    out = np.where(bad, np.nan, out)
    return out.astype(np.float32)


class OffsetProvider(Protocol):
    def offsets_m(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray: ...


class ConstantOffset:
    """Flat offset in metres: unit tests, or a rough single-benchmark fallback (not for publishing)."""

    def __init__(self, offset_m: float) -> None:
        self.offset_m = float(offset_m)

    def offsets_m(self, lon, lat):
        return np.full(np.shape(lon), self.offset_m, dtype=np.float64)


class GtxOffset:
    """VDatum GTX grid through pyproj ``vgridshift`` (pyproj imported lazily)."""

    def __init__(self, gtx_path: str | Path, multiplier: float = 1.0) -> None:
        self.gtx_path = str(gtx_path)
        self.multiplier = multiplier
        self._tf = None

    def _transformer(self):
        if self._tf is None:
            from pyproj import Transformer  # lazy

            self._tf = Transformer.from_pipeline(
                f"+proj=pipeline +step +proj=vgridshift +grids={self.gtx_path} +multiplier={self.multiplier}"
            )
        return self._tf

    def offsets_m(self, lon, lat):
        lon = np.asarray(lon, dtype=np.float64)
        lat = np.asarray(lat, dtype=np.float64)
        _, _, z = self._transformer().transform(lon, lat, np.zeros_like(lon), errcheck=False)
        z = np.asarray(z, dtype=np.float64)
        z[~np.isfinite(z)] = np.nan
        return z


def convert_raster(src_path: str | Path, dst_path: str | Path, provider: OffsetProvider | None,
                   src_datum: str | None = None, src_units: str | None = None, block_rows: int = 512) -> dict:
    """Convert one raster (any CRS) to a float32 ft-MLLW GeoTIFF carrying the vertical CRS tags."""
    import rasterio  # lazy
    from rasterio.windows import Window

    with rasterio.open(src_path) as src:
        tags = dict(src.tags())
        if src_datum:
            tags.setdefault("VERTICAL_CRS", src_datum)
        if src_units:
            tags.setdefault("VERTICAL_UNITS", src_units)
        datum, units = require_vertical_crs(tags, str(src_path))  # rejects untagged rasters
        profile = dict(src.profile)
        profile.update(dtype="float32", nodata=float("nan"), count=1, compress="deflate", tiled=True)
        tf = None
        if datum == "NAVD88":
            if provider is None:
                raise ValueError("NAVD88 raster but no offset provider (--gtx / --constant-offset-m)")
            from pyproj import Transformer  # lazy

            tf = Transformer.from_crs(src.crs, "EPSG:4326", always_xy=True)
        with rasterio.open(dst_path, "w", **profile) as dst:
            for r0 in range(0, src.height, block_rows):
                win = Window(0, r0, src.width, min(block_rows, src.height - r0))
                z = src.read(1, window=win).astype(np.float64)
                off = None
                if tf is not None:
                    rows, cols = np.mgrid[r0:r0 + win.height, 0:src.width]
                    xs, ys = rasterio.transform.xy(src.transform, rows.ravel(), cols.ravel(), offset="center")
                    lon, lat = tf.transform(np.asarray(xs), np.asarray(ys))
                    off = provider.offsets_m(lon, lat).reshape(z.shape)
                dst.write(convert_array(z, datum, units, off, src.nodata), 1, window=win)
            dst.update_tags(**vertical_tags(TARGET_DATUM, TARGET_UNITS, SOURCE_VERTICAL_CRS=datum,
                                            SOURCE_VERTICAL_UNITS=units,
                                            DATUM_GRID=getattr(provider, "gtx_path", type(provider).__name__)))
    return {"src": str(src_path), "dst": str(dst_path), "src_datum": datum, "src_units": units}


def run(aoi: str, data_dir: Path, provider: OffsetProvider | None) -> Manifest:
    fetch = Manifest.load(step_dir(data_dir, aoi, "fetch"), aoi, "fetch")
    out_dir = step_dir(data_dir, aoi, "mllw")
    out = Manifest(out_dir, aoi, "mllw")
    for e in fetch.select(kind="dem"):
        if not e.source:
            raise MissingVerticalCRS(f"{e.path}: manifest entry has no source name")
        dst = out_dir / e.source / (Path(e.path).stem + "_mllw_ft.tif")
        dst.parent.mkdir(parents=True, exist_ok=True)
        convert_raster(fetch.directory / e.path, dst, provider, e.vertical_crs, e.vertical_units)
        out.add_file(dst, source_url=e.source_url, crs=e.crs, source=e.source, kind="dem",
                     vertical_crs=TARGET_DATUM, vertical_units=TARGET_UNITS, meta=e.meta)
    out.save()
    return out


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    g = p.add_mutually_exclusive_group()
    g.add_argument("--gtx", type=Path, help="VDatum NAVD88->MLLW GTX grid for the Salish Sea")
    g.add_argument("--constant-offset-m", type=float, help="flat offset (testing only)")
    p.add_argument("--multiplier", type=float, default=1.0)
    a = p.parse_args(argv)
    provider: OffsetProvider | None = None
    if a.gtx:
        provider = GtxOffset(a.gtx, a.multiplier)
    elif a.constant_offset_m is not None:
        provider = ConstantOffset(a.constant_offset_m)
    run(a.aoi, a.data_dir, provider)
    return 0


if __name__ == "__main__":
    sys.exit(main())
