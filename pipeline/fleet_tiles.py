"""Nightly fleet-layer rebuild (FLT-6): published depth cells -> Terrain-RGB raster -> fleet.pmtiles -> R2.

    python -m pipeline.fleet_tiles --aoi skagit [--dry-run]        # make AOI=skagit step-fleet

Pulls ``depth_cells`` through the Supabase REST API with the SERVICE ROLE key (which bypasses RLS), so the
publication rule is applied EXPLICITLY here, mirroring the server: only daily rows with ``boats >= 3`` from
the last 90 days. A cell with fewer than 3 boats never reaches a pixel; a cell seen by two boats on each of
several days is still unpublished (distinct boats across days is not knowable by design, so ``boats`` is the
per-day maximum, never a sum).

Per cell: median = n-weighted median of the daily medians, boats = max daily ``boats``, newest = latest day.

CONVENTIONS (the app decodes the fleet layer exactly like the depth layer)
* ``depth_cells.median_ft`` is DEPTH positive down; it is NEGATED to ELEVATION ft MLLW (positive up) before
  Terrain-RGB encoding, so a decoder written for ``depth.pmtiles`` reads ``fleet.pmtiles`` unchanged
  (12 ft of water decodes as -12; a drying cell at depth -2 decodes as +2).
* ``fleet_meta.pmtiles`` (RGBA, see ``tiles.pack_fleet_meta``) carries the boats count in R and the newest
  contributing day in G/B (same 1880 epoch as ``depth_meta``). Like ``depth_meta`` it is not listed in
  ``tiles/index.json``; the app derives its path from ``fleet.pmtiles``.
* One H3 res-12 cell paints a disc of radius 8.14 m (the hexagon's inradius, so neighbours never overlap)
  centred on the cell centre; overlaps, if any, resolve to the later cell id.

Published under the AOI's CURRENT version directory (``tiles/<aoi>/<version>/fleet.pmtiles``); only that AOI's
``fleet`` entry in ``tiles/index.json`` changes. No published cells tonight => ``bytes: 0``, nothing uploaded.
Everything heavy (h3, rasterio, GDAL, tippecanoe/pmtiles, boto3) is imported lazily or runs as a subprocess.
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import numpy as np

from . import tiles
from .common import AOI_SLUGS, DATE_NODATA, days_since_epoch, step_dir
from .geo import Grid, lonlat_to_utm10
from .publish import FLEET_FILES, R2Store, publish_fleet
from .supabase_rest import SupabaseRest

PUBLISH_MIN_BOATS = 3  # secrecy rule: a cell renders only with >= 3 distinct boats
WINDOW_DAYS = 90
H3_CELL_RE = re.compile(r"^8c[0-9a-f]{13}$")
DEPTH_RANGE_FT = (-2000.0, 2000.0)  # depth_cells_median_range
#: Inradius of an H3 res-12 hexagon (edge ~9.416 m * sqrt(3)/2): the largest disc that cannot spill into a neighbour.
FOOTPRINT_RADIUS_M = 8.14


# ------------------------------------------------------------------ explicit publication rule
def published_rows(rows: Iterable[Mapping[str, Any]], today: dt.date, *, min_boats: int = PUBLISH_MIN_BOATS,
                   window_days: int = WINDOW_DAYS) -> tuple[list[dict], int]:
    """Keep only rows the server would publish: well-formed, ``boats >= min_boats``, ``today-window <= day <= today``.
    Returns (kept rows with parsed ``day``, number dropped). Malformed rows are dropped, never repaired."""
    earliest = today - dt.timedelta(days=window_days)
    kept: list[dict] = []
    dropped = 0
    for r in rows:
        try:
            cell, boats, n, med = r["cell_id"], r["boats"], r["n"], r["median_ft"]
            day = dt.date.fromisoformat(str(r["day"])[:10])
            ok = (isinstance(cell, str) and H3_CELL_RE.match(cell)
                  and isinstance(boats, int) and not isinstance(boats, bool) and boats >= min_boats
                  and isinstance(n, int) and not isinstance(n, bool) and n > 0
                  and isinstance(med, (int, float)) and not isinstance(med, bool) and math.isfinite(med)
                  and DEPTH_RANGE_FT[0] <= med <= DEPTH_RANGE_FT[1]
                  and earliest <= day <= today)
        except (KeyError, ValueError, TypeError):
            ok = False
        if ok:
            kept.append({"cell_id": cell, "day": day, "median_ft": float(med), "n": n, "boats": boats})
        else:
            dropped += 1
    return kept, dropped


def weighted_median(values: Sequence[float], weights: Sequence[float]) -> float:
    """Lowest value whose cumulative weight reaches half the total (ties broken by value)."""
    order = sorted(range(len(values)), key=lambda i: (values[i], weights[i]))
    half = sum(weights) / 2.0
    acc = 0.0
    for i in order:
        acc += weights[i]
        if acc >= half:
            return float(values[i])
    return float(values[order[-1]])


@dataclass(frozen=True)
class FleetCell:
    cell_id: str
    depth_ft: float  # positive down, as stored
    boats: int
    n: int
    day: int  # newest contributing day, days since 1970


def aggregate_cells(rows: Sequence[Mapping[str, Any]]) -> list[FleetCell]:
    """Collapse the (already filtered) daily rows to one record per cell, sorted by cell id."""
    by_cell: dict[str, list[Mapping[str, Any]]] = {}
    for r in rows:
        by_cell.setdefault(r["cell_id"], []).append(r)
    out = []
    for cell in sorted(by_cell):
        rs = by_cell[cell]
        out.append(FleetCell(cell, weighted_median([r["median_ft"] for r in rs], [r["n"] for r in rs]),
                             max(r["boats"] for r in rs), sum(r["n"] for r in rs),
                             max(days_since_epoch(r["day"]) for r in rs)))
    return out


# ------------------------------------------------------------------ rasterization (pure numpy)
def disc_offsets(res_m: float, radius_m: float = FOOTPRINT_RADIUS_M) -> tuple[np.ndarray, np.ndarray]:
    k = int(math.ceil(radius_m / res_m))
    dr, dc = np.mgrid[-k:k + 1, -k:k + 1]
    m = (dr**2 + dc**2) * res_m**2 <= radius_m**2
    return dr[m].ravel(), dc[m].ravel()


@dataclass
class FleetRasters:
    elev_ft: np.ndarray  # float32, ELEVATION positive up (= -depth), NaN = hole
    boats: np.ndarray  # uint8 (clamped to 255), 0 = hole
    day: np.ndarray  # int32 days since 1970, DATE_NODATA = hole
    n_cells: int  # cells whose centre fell on the grid
    n_pixels: int

    @property
    def rgb(self) -> np.ndarray:
        return tiles.encode_terrain_rgb(self.elev_ft)

    @property
    def meta(self) -> np.ndarray:
        return tiles.pack_fleet_meta(self.boats, self.day)


def rasterize_cells(grid: Grid, cells: Sequence[FleetCell], centers_lonlat: np.ndarray,
                    radius_m: float = FOOTPRINT_RADIUS_M, chunk: int = 50_000) -> FleetRasters:
    """Paint each cell's disc onto the grid. ``centers_lonlat`` is (N, 2) lon/lat aligned with ``cells``."""
    elev = np.full(grid.shape, np.nan, dtype=np.float32)
    boats = np.zeros(grid.shape, dtype=np.uint8)
    day = np.full(grid.shape, DATE_NODATA, dtype=np.int32)
    if len(cells) != len(centers_lonlat):
        raise ValueError("one centre per cell required")
    n_on = 0
    if len(cells):
        x, y = lonlat_to_utm10(centers_lonlat[:, 0], centers_lonlat[:, 1])
        row, col = grid.xy_to_rowcol(x, y)
        on = grid.contains_rowcol(row, col)
        idx = np.flatnonzero(on)
        n_on = int(idx.size)
        dr, dc = disc_offsets(grid.res, radius_m)
        vals_e = np.array([-c.depth_ft for c in cells], dtype=np.float32)  # depth (down) -> elevation (up)
        vals_b = np.array([min(c.boats, 255) for c in cells], dtype=np.uint8)
        vals_d = np.array([c.day for c in cells], dtype=np.int32)
        for s in range(0, n_on, chunk):
            sel = idx[s:s + chunk]
            rr = (row[sel][:, None] + dr[None, :])
            cc = (col[sel][:, None] + dc[None, :])
            inb = (rr >= 0) & (rr < grid.nrows) & (cc >= 0) & (cc < grid.ncols)
            k = np.broadcast_to(np.arange(len(sel))[:, None], rr.shape)[inb]
            # numpy assigns repeated indices in order, so a later cell id wins any overlap deterministically
            elev[rr[inb], cc[inb]] = vals_e[sel][k]
            boats[rr[inb], cc[inb]] = vals_b[sel][k]
            day[rr[inb], cc[inb]] = vals_d[sel][k]
    return FleetRasters(elev, boats, day, n_on, int(np.isfinite(elev).sum()))


def build_fleet(rows: Iterable[Mapping[str, Any]], grid: Grid, today: dt.date,
                cell_to_latlng: Callable[[str], tuple[float, float]]) -> tuple[FleetRasters, dict]:
    """Filter -> aggregate -> centres -> raster. Returns (rasters, stats)."""
    rows = list(rows)
    kept, dropped = published_rows(rows, today)
    cells = aggregate_cells(kept)
    ll = np.array([cell_to_latlng(c.cell_id) for c in cells], dtype=np.float64).reshape(-1, 2)[:, ::-1]  # (lat,lon)->(lon,lat)
    fr = rasterize_cells(grid, cells, ll)
    return fr, {"rows_in": len(rows), "rows_published": len(kept), "rows_dropped": dropped, "cells": len(cells),
                "cells_on_grid": fr.n_cells, "pixels": fr.n_pixels}


# ------------------------------------------------------------------ orchestration (IO)
def fetch_rows(rest: SupabaseRest, today: dt.date) -> list[dict]:
    """depth_cells rows with boats >= 3 in the last 90 days (filtered again client-side by published_rows)."""
    since = (today - dt.timedelta(days=WINDOW_DAYS)).isoformat()
    return rest.select_all("depth_cells", [("select", "cell_id,day,median_ft,n,boats"), ("boats", f"gte.{PUBLISH_MIN_BOATS}"),
                                           ("day", f"gte.{since}"), ("order", "cell_id.asc,day.asc")])


def run(aoi: str, data_dir: Path, rest: SupabaseRest | None, store: Any | None, *, today: dt.date | None = None,
        now: dt.datetime | None = None, dry_run: bool = False,
        cell_to_latlng: Callable[[str], tuple[float, float]] | None = None,
        run_cmd: Callable[[Sequence[str]], None] = tiles.run) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    today = today or now.date()
    if rest is None:
        raise RuntimeError("a SupabaseRest client is required")
    if cell_to_latlng is None:
        from .load_baseline import h3_functions  # lazy h3

        cell_to_latlng = h3_functions()[1]
    import json

    grid = Grid.from_dict(json.loads((step_dir(data_dir, aoi, "align") / "grid.json").read_text()))
    fr, stats = build_fleet(fetch_rows(rest, today), grid, today, cell_to_latlng)
    out = step_dir(data_dir, aoi, "tiles")
    out.mkdir(parents=True, exist_ok=True)
    for name in FLEET_FILES:  # never leave last night's tiles around to be published by mistake
        (out / name).unlink(missing_ok=True)
    if fr.n_pixels == 0:
        stats["published"] = "none (no published cells on this AOI's grid)"
    elif dry_run:
        stats["published"] = "dry run"
    else:
        ref = step_dir(data_dir, aoi, "merge") / "merged_elev.tif"
        for kind, arr, pm in (("fleet", fr.rgb, out / FLEET_FILES[0]), ("fleet_meta", fr.meta, out / FLEET_FILES[1])):
            tif = out / f"{kind}_rgb.tif"
            tiles.write_rgb_geotiff(tif, arr, ref)
            for cmd in tiles.raster_pmtiles_cmds(tif, out, pm, kind):
                run_cmd(cmd)
    if not dry_run:
        if store is None:
            raise RuntimeError("an object store is required unless --dry-run")
        publish_fleet(aoi, out, store, now=now)
        stats["published"] = stats.get("published") or "uploaded"
    return stats


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True, choices=AOI_SLUGS)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--dry-run", action="store_true", help="fetch + aggregate + report counts; build and upload nothing")
    a = p.parse_args(argv)
    rest = SupabaseRest.from_env()
    store = None if a.dry_run else R2Store.from_env()
    stats = run(a.aoi, a.data_dir, rest, store, dry_run=a.dry_run)
    print(f"{a.aoi}: " + ", ".join(f"{k}={v}" for k, v in stats.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
