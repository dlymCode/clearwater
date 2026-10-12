"""Step 6 - merge: newest wins, ties to lower uncertainty, 10-year rule, no interpolation.

    python -m pipeline.merge --aoi skagit [--include-waterline]

Rules per cell (PRD step 6 / AGENT-PLAN "Merge rules"):
  0. Elevations outside the plausible window (``common.ELEV_MIN_FT..ELEV_MAX_FT``, default -1500..+500 ft
     MLLW) are masked to holes first: a 1e30 value or an unlabeled -9999 m sentinel must never win by date.
     The per-source count of masked cells is returned (and written to ``merge_stats.json``) and validate.py
     fails when it is too high.
  1. Only sources that cover the cell (plausible finite elevation, known date) compete.
  2. A source older than 10 years (``ref_date - date > 3652`` days) is skipped if *any*
     source under 10 years covers the cell.
  3. Among the remaining sources the newest date wins.
  4. Date ties go to the lower uncertainty. Unknown (NaN) uncertainty ranks below any known value but
     still above a source that is not a candidate at all, so a tied candidate always beats a hole or an
     older layer.
  5. Remaining ties go to the earlier source in stack order (stable priority).
  6. A cell no source covers stays a hole: NaN elevation, src 0, DATE_NODATA, NaN uncertainty.
Nothing is ever interpolated across sources.

The core, :func:`merge_stack`, is pure numpy on stacked ``(S, H, W)`` arrays with parallel
date/uncertainty stacks. Inputs missing a recorded MLLW/ft vertical CRS are rejected.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

from .common import (BASELINE_SOURCES, DATE_NODATA, ELEV_MAX_FT, ELEV_MIN_FT, SOURCES, TEN_YEARS_DAYS,
                     WATERLINE_MIN_UNC_FT, Manifest, MissingVerticalCRS, days_since_epoch, require_mllw_ft, step_dir,
                     vertical_tags)


@dataclass
class MergeResult:
    elev: np.ndarray  # float32 ft MLLW (NaN = hole)
    src: np.ndarray  # uint8 source code (0 = hole)
    date: np.ndarray  # int32 days since 1970 (DATE_NODATA = hole)
    unc: np.ndarray  # float32 ft (NaN = hole or unknown)
    implausible: np.ndarray | None = None  # per layer: cells masked as outside the plausible elevation window
    covered: np.ndarray | None = None  # per layer: cells with a non-NaN elevation (denominator for the above)


_UNKNOWN_UNC_KEY = np.float32(np.finfo(np.float32).max)  # ranks below every finite uncertainty, above "not a candidate"


def merge_stack(elev: np.ndarray, date: np.ndarray, unc: np.ndarray, codes: Sequence[int], ref_date: int,
                max_age_days: int = TEN_YEARS_DAYS, elev_min: float = ELEV_MIN_FT,
                elev_max: float = ELEV_MAX_FT) -> MergeResult:
    """Merge ``S`` aligned sources. ``elev``/``date``/``unc`` are (S, H, W); ``codes`` has length S."""
    elev = np.asarray(elev, dtype=np.float32)
    date = np.asarray(date, dtype=np.int32)
    unc = np.asarray(unc, dtype=np.float32)
    if elev.ndim != 3 or date.shape != elev.shape or unc.shape != elev.shape:
        raise ValueError("elev/date/unc must be identically shaped (S,H,W) stacks")
    s = elev.shape[0]
    if len(codes) != s:
        raise ValueError("one source code per stack layer required")
    if any(c <= 0 or c > 255 for c in codes):
        raise ValueError("source codes must be in 1..255 (0 is reserved for holes)")

    not_nan = ~np.isnan(elev)
    plausible = (elev >= elev_min) & (elev <= elev_max)  # False for +-inf as well
    implausible = not_nan & ~plausible
    valid = plausible & (date != DATE_NODATA)
    age = np.int64(ref_date) - date.astype(np.int64)
    old = age > max_age_days
    has_recent = (valid & ~old).any(axis=0)
    cand = valid & ~(old & has_recent[None])

    d64 = date.astype(np.int64)
    best_date = np.where(cand, d64, np.iinfo(np.int64).min).max(axis=0)
    tied = cand & (d64 == best_date[None])
    # Unknown (NaN) uncertainty must rank below any known one yet above non-candidates (key inf),
    # otherwise argmin can pick a hole or an older layer.
    unc_key = np.where(tied, np.where(np.isfinite(unc), unc, _UNKNOWN_UNC_KEY), np.float32(np.inf))
    winner = unc_key.argmin(axis=0)  # first minimum => earlier layer wins remaining ties
    has_any = cand.any(axis=0)

    take = lambda a: np.take_along_axis(a, winner[None], axis=0)[0]  # noqa: E731
    out_elev = np.where(has_any, take(elev), np.float32(np.nan)).astype(np.float32)
    out_src = np.where(has_any, np.asarray(codes, dtype=np.uint8)[winner], np.uint8(0)).astype(np.uint8)
    out_date = np.where(has_any, take(date), np.int32(DATE_NODATA)).astype(np.int32)
    out_unc = np.where(has_any, take(unc), np.float32(np.nan)).astype(np.float32)
    return MergeResult(out_elev, out_src, out_date, out_unc,
                       implausible.sum(axis=(1, 2)).astype(np.int64), not_nan.sum(axis=(1, 2)).astype(np.int64))


def check_vertical_crs(tags_by_name: dict[str, dict[str, str]]) -> None:
    """Reject the whole merge if any input lacks MLLW/ft vertical CRS metadata."""
    for name, tags in tags_by_name.items():
        require_mllw_ft(tags, name)


def _layer_unc(raw: np.ndarray, is_bracket: bool) -> np.ndarray:
    """Uncertainty for the merge: the waterline layer uses half its bracket, floored at 0.3 ft."""
    raw = raw.astype(np.float32)
    return np.maximum(raw / 2.0, np.float32(WATERLINE_MIN_UNC_FT)) if is_bracket else raw


# ------------------------------------------------------------------ IO (rasterio, lazy)
def run(aoi: str, data_dir: Path, *, include_waterline: bool = False, strip_rows: int = 1024,
        ref_date: int | None = None) -> None:
    import rasterio  # lazy
    from rasterio.windows import Window

    align_dir = step_dir(data_dir, aoi, "align")
    layers: list[tuple[str, Path, Path, Path | None, bool]] = []  # name, elev, date, unc, unc_is_bracket
    for name in BASELINE_SOURCES:
        sdir = align_dir / name
        if (sdir / "elev.tif").exists():
            for f in ("date.tif", "unc.tif"):
                if not (sdir / f).exists():
                    raise FileNotFoundError(f"{sdir / f} missing; run source_meta first")
            layers.append((name, sdir / "elev.tif", sdir / "date.tif", sdir / "unc.tif", False))
    if include_waterline:
        wdir = step_dir(data_dir, aoi, "waterline")
        layers.append(("waterline", wdir / "elev.tif", wdir / "date.tif", wdir / "bracket.tif", True))
    if not layers:
        raise FileNotFoundError(f"no aligned sources under {align_dir}")

    align_manifest = Manifest.load(align_dir, aoi, "align")
    align_manifest.verify(kinds=["dem"])  # elevation files must still match what align recorded
    handles = [(n, rasterio.open(e), rasterio.open(d), rasterio.open(u), br) for n, e, d, u, br in layers]
    try:
        check_vertical_crs({n: dict(e.tags()) for n, e, *_ in handles})
        ref = handles[0][1]
        for n, e, d, u, _ in handles:
            for what, ds in (("elev", e), ("date", d), ("unc", u)):
                if (ds.height, ds.width, ds.transform, ds.crs) != (ref.height, ref.width, ref.transform, ref.crs):
                    raise ValueError(f"{n}/{what}: grid differs from {handles[0][0]}/elev; rerun align")
        codes = [SOURCES[n].code for n, *_ in handles]
        today = ref_date if ref_date is not None else days_since_epoch(dt.date.today())
        out_dir = step_dir(data_dir, aoi, "merge")
        out_dir.mkdir(parents=True, exist_ok=True)
        base = dict(driver="GTiff", width=ref.width, height=ref.height, count=1, crs=ref.crs, transform=ref.transform,
                    compress="deflate", tiled=True)
        outs = {
            "merged_elev": rasterio.open(out_dir / "merged_elev.tif", "w", **base, dtype="float32", nodata=float("nan")),
            "merged_src": rasterio.open(out_dir / "merged_src.tif", "w", **base, dtype="uint8", nodata=0),
            "merged_date": rasterio.open(out_dir / "merged_date.tif", "w", **base, dtype="int32", nodata=DATE_NODATA),
            "merged_unc": rasterio.open(out_dir / "merged_unc.tif", "w", **base, dtype="float32", nodata=float("nan")),
        }
        stats = {n: {"covered": 0, "implausible": 0} for n, *_ in handles}
        try:
            for r0 in range(0, ref.height, strip_rows):
                win = Window(0, r0, ref.width, min(strip_rows, ref.height - r0))
                e_stack = np.stack([e.read(1, window=win) for _, e, *_ in handles]).astype(np.float32)
                d_stack = np.stack([d.read(1, window=win) for _, _, d, *_ in handles]).astype(np.int32)
                u_stack = np.stack([_layer_unc(u.read(1, window=win), br) for _, _, _, u, br in handles]).astype(np.float32)
                res = merge_stack(e_stack, d_stack, u_stack, codes, today)
                for (n, *_), cov, bad in zip(handles, res.covered, res.implausible):
                    stats[n]["covered"] += int(cov)
                    stats[n]["implausible"] += int(bad)
                outs["merged_elev"].write(res.elev, 1, window=win)
                outs["merged_src"].write(res.src, 1, window=win)
                outs["merged_date"].write(res.date, 1, window=win)
                outs["merged_unc"].write(res.unc, 1, window=win)
            outs["merged_elev"].update_tags(**vertical_tags(), SOURCES=",".join(n for n, *_ in handles))
            (out_dir / "merge_stats.json").write_text(json.dumps(
                {"elev_window_ft": [ELEV_MIN_FT, ELEV_MAX_FT], "sources": stats}, indent=2))
        finally:
            for o in outs.values():
                o.close()
    finally:
        for _, e, d, u, _ in handles:
            e.close()
            d.close()
            u.close()


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--include-waterline", action="store_true",
                   help="let the waterline DEM compete in the merge (default: it stays its own layer)")
    a = p.parse_args(argv)
    try:
        run(a.aoi, a.data_dir, include_waterline=a.include_waterline)
    except MissingVerticalCRS as exc:
        print(f"REJECTED: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
