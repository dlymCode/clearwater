"""Load the merged baseline into Postgres so the server's 15 ft hold rule can fire.

    python -m pipeline.load_baseline --aoi skagit [--dry-run] [--batch-size 1000]

Run it explicitly AFTER ``publish`` (it is not part of ``make <aoi>``; ``make AOI=skagit step-load-baseline``).
It reads ``merge/merged_elev.tif`` and ``merge/merged_date.tif``, finds every H3 resolution-12 cell whose
CENTER lies inside the data coverage, samples the rasters at that center, and upserts
``(cell_id, baseline_elev_ft, source_date)`` rows into ``public.baseline_cells`` through the Supabase REST
API (service role; env ``SUPABASE_URL`` + ``SUPABASE_SERVICE_ROLE_KEY``), 1000 rows per request,
``on_conflict=cell_id``.

SIGN CONVENTION: ``baseline_elev_ft`` is ELEVATION in feet MLLW, POSITIVE UP, exactly the ``merged_elev`` value
(a cell 12 ft under water is -12). Uploaded depth is positive down, so the SERVER negates the baseline when
comparing; this loader never negates.

Like publish, it refuses to load a baseline that has not passed validation (same report checks) or that was
re-merged after its validation report. The ``h3`` library is imported lazily; the cell-sampling logic is pure
numpy plus two injected callables so it is unit-tested with fakes.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import numpy as np

from .common import AOI_SLUGS, DATE_NODATA, H3_RESOLUTION, date_from_days, step_dir
from .geo import Grid, lonlat_to_utm10, utm10_to_lonlat
from .publish import PublishRefused, check_validation_report, merge_outputs_mtime
from .supabase_rest import BATCH_SIZE, SupabaseRest

H3_CELL_RE = re.compile(r"^8c[0-9a-f]{13}$")  # the database domain h3_res12
BASELINE_RANGE_FT = (-2000.0, 2000.0)  # baseline_cells_range check constraint
#: Candidate sampling stride in pixels (2 m cells -> 8 m). An H3 res-12 hexagon contains a ~11 m square, so
#: an 8 m stride visits every cell at least once.
CANDIDATE_STRIDE_PX = 4

LatLngToCell = Callable[[float, float], str]  # (lat, lon) -> cell id at resolution 12
CellToLatLng = Callable[[str], tuple[float, float]]  # cell id -> (lat, lon) of the center


# ------------------------------------------------------------------ h3 (lazy, v3/v4 API tolerant)
def h3_functions(resolution: int = H3_RESOLUTION) -> tuple[LatLngToCell, CellToLatLng]:
    """(latlng_to_cell, cell_to_latlng) from the ``h3`` package; the import happens here, not at module load."""
    import h3  # lazy

    if hasattr(h3, "latlng_to_cell"):  # h3 >= 4
        return (lambda lat, lon: h3.latlng_to_cell(lat, lon, resolution)), (lambda c: tuple(h3.cell_to_latlng(c)))
    return (lambda lat, lon: h3.geo_to_h3(lat, lon, resolution)), (lambda c: tuple(h3.h3_to_geo(c)))  # h3 3.x


# ------------------------------------------------------------------ pure logic
def candidate_points(grid: Grid, valid: np.ndarray, stride_px: int = CANDIDATE_STRIDE_PX) -> tuple[np.ndarray, np.ndarray]:
    """Lon/lat of a sparse lattice (every ``stride_px`` pixels) covering the valid data PLUS a margin.

    A cell whose centre is valid can straddle the edge of the data, so its lattice point may sit on a no-data
    pixel; the lattice is therefore taken wherever a block is within two blocks (>= one cell circumradius) of
    valid data, including a margin beyond the grid edge. Spurious candidates are harmless: the cell centre is
    sampled afterwards and no-data centres are dropped.
    """
    pad = 2 * stride_px
    padded = np.pad(valid, pad, constant_values=False)
    rows = np.arange(0, padded.shape[0], stride_px)
    cols = np.arange(0, padded.shape[1], stride_px)
    block = np.logical_or.reduceat(np.logical_or.reduceat(padded, rows, axis=0), cols, axis=1)
    near = block.copy()
    for dr in range(-2, 3):  # dilate by two blocks
        for dc in range(-2, 3):
            shifted = np.zeros_like(block)
            src = block[max(0, -dr):block.shape[0] - max(0, dr), max(0, -dc):block.shape[1] - max(0, dc)]
            shifted[max(0, dr):max(0, dr) + src.shape[0], max(0, dc):max(0, dc) + src.shape[1]] = src
            near |= shifted
    ri, ci = np.nonzero(near)
    x, y = grid.rowcol_to_xy(rows[ri] - pad, cols[ci] - pad)
    lon, lat = utm10_to_lonlat(x, y)
    return lon, lat


def cells_from_points(lon: np.ndarray, lat: np.ndarray, latlng_to_cell: LatLngToCell) -> list[str]:
    """Sorted unique H3 cell ids containing the points."""
    cells = {latlng_to_cell(float(la), float(lo)) for lo, la in zip(lon.tolist(), lat.tolist())}
    return sorted(cells)


@dataclass(frozen=True)
class BaselineRow:
    cell_id: str
    baseline_elev_ft: float
    source_date: str | None

    def to_json(self) -> dict[str, Any]:
        return {"cell_id": self.cell_id, "baseline_elev_ft": self.baseline_elev_ft, "source_date": self.source_date}


def sample_cells(grid: Grid, elev: np.ndarray, date: np.ndarray | None, cell_ids: Iterable[str],
                 cell_to_latlng: CellToLatLng, lo: float = BASELINE_RANGE_FT[0], hi: float = BASELINE_RANGE_FT[1]) -> list[BaselineRow]:
    """Sample the merged rasters at each cell CENTER. Cells whose centre is off the grid, on a hole, or outside
    the table's range constraint are skipped ("within data coverage"). Elevation is stored as-is (positive up)."""
    ids = list(cell_ids)
    if not ids:
        return []
    for c in ids:
        if not H3_CELL_RE.match(c):
            raise ValueError(f"not an H3 resolution-12 cell id: {c!r}")
    ll = np.array([cell_to_latlng(c) for c in ids], dtype=np.float64)
    x, y = lonlat_to_utm10(ll[:, 1], ll[:, 0])
    row, col = grid.xy_to_rowcol(x, y)
    ok = grid.contains_rowcol(row, col)
    out: list[BaselineRow] = []
    for i in np.flatnonzero(ok):
        z = float(elev[row[i], col[i]])
        if not np.isfinite(z) or not (lo <= z <= hi):
            continue
        d = None
        if date is not None:
            dd = int(date[row[i], col[i]])
            d = None if dd == DATE_NODATA else date_from_days(dd).isoformat()
        out.append(BaselineRow(ids[i], round(z, 3), d))
    return out


def build_rows(grid: Grid, elev: np.ndarray, date: np.ndarray | None,
               latlng_to_cell: LatLngToCell, cell_to_latlng: CellToLatLng, stride_px: int = CANDIDATE_STRIDE_PX) -> list[BaselineRow]:
    """All baseline rows for one AOI: candidate cells from valid pixels, then centre sampling."""
    lon, lat = candidate_points(grid, np.isfinite(elev), stride_px)
    cells = cells_from_points(lon, lat, latlng_to_cell)
    return sample_cells(grid, elev, date, cells, cell_to_latlng)


# ------------------------------------------------------------------ IO
def run(aoi: str, data_dir: Path, rest: SupabaseRest | None, *, dry_run: bool = False, batch_size: int = BATCH_SIZE,
        h3_fns: tuple[LatLngToCell, CellToLatLng] | None = None) -> int:
    """Validate the report gate, sample the rasters, upsert. Returns the number of rows (sent, or would-send for a dry run)."""
    report = check_validation_report(aoi, data_dir)
    if merge_outputs_mtime(aoi, data_dir) >= report.stat().st_mtime:
        raise PublishRefused("merged rasters are newer than the validation report; rerun validate before loading the baseline")
    import rasterio  # lazy

    merge_dir = step_dir(data_dir, aoi, "merge")
    with rasterio.open(merge_dir / "merged_elev.tif") as ds:
        elev = ds.read(1).astype(np.float32)
        t = ds.transform
        grid = Grid(t.c, t.f, ds.width, ds.height, t.a)
    with rasterio.open(merge_dir / "merged_date.tif") as ds:
        date = ds.read(1).astype(np.int32)
        if date.shape != elev.shape:
            raise ValueError("merged_date grid differs from merged_elev")
    latlng_to_cell, cell_to_latlng = h3_fns or h3_functions()
    rows = build_rows(grid, elev, date, latlng_to_cell, cell_to_latlng)
    if dry_run:
        return len(rows)
    if rest is None:
        raise RuntimeError("a SupabaseRest client is required unless --dry-run")
    return rest.upsert("baseline_cells", [r.to_json() for r in rows], on_conflict="cell_id", batch_size=batch_size)


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True, choices=AOI_SLUGS)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    p.add_argument("--dry-run", action="store_true", help="count the rows; no Supabase credentials needed")
    a = p.parse_args(argv)
    rest = None if a.dry_run else SupabaseRest.from_env()
    n = run(a.aoi, a.data_dir, rest, dry_run=a.dry_run, batch_size=a.batch_size)
    print(f"{'would upsert' if a.dry_run else 'upserted'} {n} baseline_cells rows for {a.aoi}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
