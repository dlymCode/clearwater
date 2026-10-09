"""Step 5 - waterline (intertidal) DEM from tide-tagged Sentinel-2 scenes.

    python -m pipeline.waterline_dem --aoi skagit [--ndwi-threshold 0.0]

Method (PRD step 5): per scene compute NDWI = (B03 - B08) / (B03 + B08); cells flagged
water have NDWI > threshold, cloud/shadow/snow cells (SCL) are excluded. For each cell:

    h_dry = highest tide (ft MLLW) at which the cell was seen dry
    h_wet = lowest  tide                     at which it was seen wet
    elev    = (h_dry + h_wet) / 2
    bracket = h_wet - h_dry

A cell needs >= 5 usable scenes and a non-negative bracket <= 3 ft; everything else is
masked (NaN elev/bracket, DATE_NODATA date). ``n`` is always the usable-scene count so the
app can hatch low-evidence cells. The core (:class:`WaterlineAccumulator`,
:func:`waterline_dem`) is pure numpy and streams scene-by-scene.

Outputs: ``data/<aoi>/waterline/{elev,bracket,date,n}.tif``.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

from .common import DATE_NODATA, step_dir, vertical_tags

MIN_SCENES = 5
MAX_BRACKET_FT = 3.0
NDWI_THRESHOLD = 0.0
#: Sentinel-2 L2A SCL classes treated as usable: 4 vegetation, 5 not-vegetated (bare/wet sand), 6 water.
USABLE_SCL: tuple[int, ...] = (4, 5, 6)


def ndwi(green: np.ndarray, nir: np.ndarray) -> np.ndarray:
    """McFeeters NDWI; NaN where the denominator is not positive."""
    g = np.asarray(green, dtype=np.float32)
    n = np.asarray(nir, dtype=np.float32)
    s = g + n
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (g - n) / s
    return np.where(s > 0, out, np.float32(np.nan)).astype(np.float32)


def usable_mask(scl: np.ndarray, classes: Sequence[int] = USABLE_SCL) -> np.ndarray:
    return np.isin(scl, np.asarray(classes))


@dataclass
class WaterlineResult:
    elev: np.ndarray  # float32 ft MLLW, NaN = masked
    bracket: np.ndarray  # float32 ft, NaN = masked
    date: np.ndarray  # int32 days since 1970 of newest usable scene, DATE_NODATA = masked
    n: np.ndarray  # uint16 usable scenes per cell (never masked)


class WaterlineAccumulator:
    """Streaming per-cell state: highest dry tide, lowest wet tide, usable count, newest scene."""

    def __init__(self, shape: tuple[int, ...], ndwi_threshold: float = NDWI_THRESHOLD,
                 usable_classes: Sequence[int] = USABLE_SCL) -> None:
        self.ndwi_threshold = ndwi_threshold
        self.usable_classes = tuple(usable_classes)
        self.max_dry = np.full(shape, -np.inf, dtype=np.float32)
        self.min_wet = np.full(shape, np.inf, dtype=np.float32)
        self.n = np.zeros(shape, dtype=np.uint16)
        self.newest = np.full(shape, DATE_NODATA, dtype=np.int32)

    def update(self, green: np.ndarray, nir: np.ndarray, scl: np.ndarray, tide_ft: float, day: int) -> None:
        idx = ndwi(green, nir)
        ok = usable_mask(scl, self.usable_classes) & np.isfinite(idx)
        wet = ok & (idx > self.ndwi_threshold)
        dry = ok & ~wet
        t = np.float32(tide_ft)
        self.max_dry = np.where(dry, np.maximum(self.max_dry, t), self.max_dry)
        self.min_wet = np.where(wet, np.minimum(self.min_wet, t), self.min_wet)
        self.n = self.n + ok.astype(np.uint16)
        self.newest = np.where(ok, np.maximum(self.newest, np.int32(day)), self.newest)

    def finalize(self, min_scenes: int = MIN_SCENES, max_bracket_ft: float = MAX_BRACKET_FT) -> WaterlineResult:
        seen_both = np.isfinite(self.max_dry) & np.isfinite(self.min_wet)
        with np.errstate(invalid="ignore"):
            bracket = self.min_wet - self.max_dry
        good = seen_both & (self.n >= min_scenes) & (bracket >= 0) & (bracket <= max_bracket_ft)
        elev = np.where(good, (self.max_dry + self.min_wet) / 2.0, np.nan).astype(np.float32)
        br = np.where(good, bracket, np.nan).astype(np.float32)
        date = np.where(good, self.newest, np.int32(DATE_NODATA)).astype(np.int32)
        return WaterlineResult(elev, br, date, self.n.copy())


def group_passes(times_s: Sequence[float], tol_s: float = 60.0) -> list[int]:
    """Pass id per scene: scenes whose sensing times chain within ``tol_s`` seconds are one satellite
    pass (reprocessed duplicates, overlapping granules). Input order is preserved in the result."""
    order = sorted(range(len(times_s)), key=lambda i: times_s[i])
    ids = [0] * len(times_s)
    cur = -1
    last = None
    for i in order:
        if last is None or times_s[i] - last > tol_s:
            cur += 1
        ids[i] = cur
        last = times_s[i]
    return ids


def combine_pass(green: np.ndarray, nir: np.ndarray, scl: np.ndarray,
                 classes: Sequence[int] = USABLE_SCL) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Merge the scenes of ONE pass ((K,H,W) stacks): per cell the first usable scene wins, otherwise the first."""
    ok = usable_mask(scl, classes) & np.isfinite(ndwi(green, nir))
    pick = np.argmax(ok, axis=0)  # first usable layer; 0 when none is usable
    take = lambda a: np.take_along_axis(a, pick[None], axis=0)[0]  # noqa: E731
    return take(green), take(nir), take(scl)


def waterline_dem(green: np.ndarray, nir: np.ndarray, scl: np.ndarray, tide_ft: Sequence[float],
                  scene_days: Sequence[int], *, ndwi_threshold: float = NDWI_THRESHOLD,
                  min_scenes: int = MIN_SCENES, max_bracket_ft: float = MAX_BRACKET_FT,
                  pass_ids: Sequence[int] | None = None) -> WaterlineResult:
    """Stacked form: ``green``/``nir``/``scl`` are (S, H, W); ``tide_ft`` and ``scene_days`` length S.

    ``pass_ids`` (one per scene, see :func:`group_passes`) makes scenes sharing an id count as ONE
    observation, combined cell by cell before the >= ``min_scenes`` test, so duplicates of the same
    overpass can never inflate the scene count.
    """
    green = np.asarray(green)
    if green.ndim != 3 or not (len(tide_ft) == len(scene_days) == green.shape[0]):
        raise ValueError("expected (S,H,W) stacks and per-scene tide/day vectors of length S")
    acc = WaterlineAccumulator(green.shape[1:], ndwi_threshold)
    if pass_ids is None:
        for i in range(green.shape[0]):
            acc.update(green[i], nir[i], scl[i], float(tide_ft[i]), int(scene_days[i]))
        return acc.finalize(min_scenes, max_bracket_ft)
    if len(pass_ids) != green.shape[0]:
        raise ValueError("one pass id per scene required")
    nir, scl = np.asarray(nir), np.asarray(scl)
    for pid in dict.fromkeys(pass_ids):
        idx = [i for i, p in enumerate(pass_ids) if p == pid]
        g, n, c = combine_pass(green[idx], nir[idx], scl[idx])
        acc.update(g, n, c, float(tide_ft[idx[0]]), int(scene_days[idx[0]]))
    return acc.finalize(min_scenes, max_bracket_ft)


# ------------------------------------------------------------------ IO (rasterio, lazy)
def run(aoi: str, data_dir: Path, *, ndwi_threshold: float = NDWI_THRESHOLD, strip_rows: int = 1024,
        min_scenes: int = MIN_SCENES) -> None:
    """Read scenes listed in fetch/scenes.json, warp each band onto the working grid in strips, write outputs."""
    import rasterio  # lazy
    from rasterio.enums import Resampling
    from rasterio.transform import Affine
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import Window

    from .common import days_since_epoch
    from .geo import Grid

    fetch_dir = step_dir(data_dir, aoi, "fetch")
    grid = Grid.from_dict(json.loads((step_dir(data_dir, aoi, "align") / "grid.json").read_text()))
    scenes = json.loads((fetch_dir / "scenes.json").read_text())["scenes"]
    scenes = [s for s in scenes if s.get("tide_ft") is not None and len(s.get("files", {})) == 3]
    if not scenes:
        raise RuntimeError("no downloaded, tide-tagged scenes in scenes.json")

    out_dir = step_dir(data_dir, aoi, "waterline")
    out_dir.mkdir(parents=True, exist_ok=True)
    profile = dict(driver="GTiff", width=grid.ncols, height=grid.nrows, count=1, crs=grid.crs,
                   transform=Affine(*grid.transform), compress="deflate", tiled=True)
    outs = {
        "elev": rasterio.open(out_dir / "elev.tif", "w", **profile, dtype="float32", nodata=float("nan")),
        "bracket": rasterio.open(out_dir / "bracket.tif", "w", **profile, dtype="float32", nodata=float("nan")),
        "date": rasterio.open(out_dir / "date.tif", "w", **profile, dtype="int32", nodata=DATE_NODATA),
        "n": rasterio.open(out_dir / "n.tif", "w", **profile, dtype="uint16"),
    }
    try:
        import datetime as _dt

        times = [_dt.datetime.fromisoformat(s["datetime"].replace("Z", "+00:00")).timestamp() for s in scenes]
        pass_of = group_passes(times)
        srcs = []
        for s in scenes:
            vrts = {}
            for band, rel in s["files"].items():
                ds = rasterio.open(fetch_dir / rel)
                vrts[band] = WarpedVRT(ds, crs=grid.crs, transform=Affine(*grid.transform), width=grid.ncols,
                                       height=grid.nrows, resampling=Resampling.nearest)
            srcs.append((s, vrts))
        for r0 in range(0, grid.nrows, strip_rows):
            win = Window(0, r0, grid.ncols, min(strip_rows, grid.nrows - r0))
            acc = WaterlineAccumulator((int(win.height), grid.ncols), ndwi_threshold)
            for pid in dict.fromkeys(pass_of):  # one observation per satellite pass, not per scene file
                members = [srcs[i] for i, p in enumerate(pass_of) if p == pid]
                g, n, c = combine_pass(
                    np.stack([v["B03"].read(1, window=win).astype(np.float32) for _, v in members]),
                    np.stack([v["B08"].read(1, window=win).astype(np.float32) for _, v in members]),
                    np.stack([v["SCL"].read(1, window=win) for _, v in members]))
                s0 = members[0][0]
                acc.update(g, n, c, s0["tide_ft"], days_since_epoch(s0["datetime"]))
            res = acc.finalize(min_scenes)
            for key in ("elev", "bracket", "date", "n"):
                outs[key].write(getattr(res, key), 1, window=win)
        for key in ("elev", "bracket"):
            outs[key].update_tags(**vertical_tags(), WATERLINE_NDWI_THRESHOLD=str(ndwi_threshold),
                                  WATERLINE_MIN_SCENES=str(min_scenes))
        outs["date"].update_tags(SCENES=str(len(scenes)))
    finally:
        for o in outs.values():
            o.close()


def main(argv: Iterable[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--ndwi-threshold", type=float, default=NDWI_THRESHOLD)
    p.add_argument("--min-scenes", type=int, default=MIN_SCENES)
    a = p.parse_args(list(argv) if argv is not None else None)
    run(a.aoi, a.data_dir, ndwi_threshold=a.ndwi_threshold, min_scenes=a.min_scenes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
