"""Step 7 - ground-truth check (Gate 1) plus publish-time sanity checks.

    python -m pipeline.validate --aoi skagit --runs run1.csv run2.csv run3.csv [--coalne coalne.geojson]

* Compares merged (per source) and waterline elevation against tide-corrected sounder logs.
  Reports RMSE and 90th-percentile absolute error per source; writes an HTML report.
* **Exit code 1 if the waterline p90 absolute error exceeds 1.5 ft** (or if there are no
  waterline samples at all - the gate fails closed; override with ``--skip-waterline-gate``).
* :func:`shoreline_datum_check`: ENC COALNE cells must sit about +9..+13 ft MLLW in the
  merged raster (MHHW is ~ +11.4 ft at Seattle) - catches VDatum sign/offset errors.
* :func:`regression_shallower`: cells that rose by more than 3 ft versus the last published
  merged raster, listed for manual review.

Run CSV columns: ``time,lat,lon,depth,speed`` (+ optional ``tide_ft``). ``depth`` is feet
below the surface at ``time``; with a ``tide_ft`` column truth elevation = tide_ft - depth,
otherwise ``depth`` is taken as already tide-corrected (below MLLW), elevation = -depth.
``speed`` is knots; rows under 0.5 kt are dropped (same physical filter as the app).
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np

from .common import SOURCE_BY_CODE, step_dir
from .geo import Grid, lonlat_to_utm10, sample_grid

P90_GATE_FT = 1.5
MIN_SPEED_KT = 0.5
SHORELINE_RANGE_FT = (9.0, 13.0)


@dataclass
class TruthPoints:
    lon: np.ndarray
    lat: np.ndarray
    elev_ft: np.ndarray  # ft MLLW, positive up
    speed_kt: np.ndarray


def load_run_csv(path: str | Path, min_speed_kt: float = MIN_SPEED_KT) -> TruthPoints:
    lon: list[float] = []
    lat: list[float] = []
    elev: list[float] = []
    spd: list[float] = []
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            try:
                depth = float(row["depth"])
                speed = float(row["speed"])
                la, lo = float(row["lat"]), float(row["lon"])
                tide = float(row["tide_ft"]) if row.get("tide_ft") not in (None, "") else None
            except (KeyError, ValueError):
                continue
            if speed < min_speed_kt or not np.isfinite([depth, la, lo]).all():
                continue
            lon.append(lo)
            lat.append(la)
            elev.append((tide - depth) if tide is not None else -depth)
            spd.append(speed)
    return TruthPoints(np.array(lon), np.array(lat), np.array(elev), np.array(spd))


def concat_truth(runs: Sequence[TruthPoints]) -> TruthPoints:
    return TruthPoints(*(np.concatenate([getattr(r, f) for r in runs]) for f in ("lon", "lat", "elev_ft", "speed_kt")))


def error_stats(err: np.ndarray) -> dict:
    """RMSE / p90 |error| / bias for ``err = predicted - truth`` (finite values only)."""
    e = np.asarray(err, dtype=np.float64)
    e = e[np.isfinite(e)]
    if e.size == 0:
        return {"n": 0, "rmse": None, "p90_abs": None, "bias": None, "max_abs": None}
    return {"n": int(e.size), "rmse": float(np.sqrt(np.mean(e**2))), "p90_abs": float(np.percentile(np.abs(e), 90)),
            "bias": float(e.mean()), "max_abs": float(np.abs(e).max())}


@dataclass
class ValidationResult:
    per_source: dict[str, dict] = field(default_factory=dict)
    gate: dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return bool(self.gate.get("passed"))

    def to_dict(self) -> dict:
        return {"per_source": self.per_source, "gate": self.gate}


def evaluate_gate(waterline_stats: dict | None, threshold: float = P90_GATE_FT, enforce: bool = True) -> dict:
    if waterline_stats is None or not waterline_stats.get("n"):
        ok = not enforce
        return {"passed": ok, "threshold_ft": threshold, "waterline_p90_ft": None,
                "reason": "no waterline samples (gate fails closed)" if enforce else "waterline gate skipped"}
    p90 = waterline_stats["p90_abs"]
    ok = p90 <= threshold or not enforce
    return {"passed": ok, "threshold_ft": threshold, "waterline_p90_ft": p90,
            "reason": "ok" if p90 <= threshold else f"waterline p90 {p90:.2f} ft > {threshold} ft"}


def validate(truth: TruthPoints, grid: Grid, merged_elev: np.ndarray, merged_src: np.ndarray | None = None,
             waterline_elev: np.ndarray | None = None, *, threshold: float = P90_GATE_FT,
             enforce_waterline: bool = True) -> ValidationResult:
    x, y = lonlat_to_utm10(truth.lon, truth.lat)
    res = ValidationResult()
    pred = sample_grid(merged_elev, grid, x, y)
    err = pred - truth.elev_ft
    res.per_source["merged"] = error_stats(err)
    if merged_src is not None:
        codes = sample_grid(merged_src.astype(np.float64), grid, x, y, fill=0.0).astype(int)
        for code in sorted(set(codes.tolist()) - {0}):
            name = SOURCE_BY_CODE[code].name if code in SOURCE_BY_CODE else f"code_{code}"
            res.per_source[name] = error_stats(err[codes == code])
    wl_stats = None
    if waterline_elev is not None:
        wl_stats = error_stats(sample_grid(waterline_elev, grid, x, y) - truth.elev_ft)
        res.per_source["waterline"] = wl_stats
    res.gate = evaluate_gate(wl_stats, threshold, enforce_waterline)
    return res


def exit_code(result: ValidationResult) -> int:
    return 0 if result.passed else 1


# ------------------------------------------------------------------ sanity checks
def densify_lines(lines: Sequence[Sequence[tuple[float, float]]], spacing_deg: float = 0.0001):
    """Points along lon/lat polylines at roughly ``spacing_deg`` (≈10 m) spacing."""
    lon: list[float] = []
    lat: list[float] = []
    for line in lines:
        for (x0, y0), (x1, y1) in zip(line[:-1], line[1:]):
            n = max(1, int(np.ceil(max(abs(x1 - x0), abs(y1 - y0)) / spacing_deg)))
            t = np.arange(n) / n
            lon.extend((x0 + (x1 - x0) * t).tolist())
            lat.extend((y0 + (y1 - y0) * t).tolist())
        lon.append(line[-1][0])
        lat.append(line[-1][1])
    return np.array(lon), np.array(lat)


def coalne_lines_from_geojson(gj: dict) -> list[list[tuple[float, float]]]:
    lines: list[list[tuple[float, float]]] = []
    for f in gj.get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") == "LineString":
            lines.append([(c[0], c[1]) for c in g["coordinates"]])
        elif g.get("type") == "MultiLineString":
            lines.extend([(c[0], c[1]) for c in part] for part in g["coordinates"])
    return lines


def shoreline_datum_check(grid: Grid, merged_elev: np.ndarray, lon: np.ndarray, lat: np.ndarray,
                          expected: tuple[float, float] = SHORELINE_RANGE_FT, min_cells: int = 10,
                          search_radius_cells: int = 1) -> dict:
    """Median merged elevation at ENC COALNE shoreline cells must fall inside ``expected`` (ft MLLW).

    Each shoreline point looks at its (2r+1)^2 cell neighbourhood and takes the neighbourhood
    maximum, since the charted shoreline can fall a cell or two off the DEM's own waterline.
    """
    x, y = lonlat_to_utm10(lon, lat)
    row, col = grid.xy_to_rowcol(x, y)
    vals = []
    r = search_radius_cells
    for rr, cc in zip(row.tolist(), col.tolist()):
        if rr - r < 0 or cc - r < 0 or rr + r >= grid.nrows or cc + r >= grid.ncols:
            continue
        patch = merged_elev[rr - r:rr + r + 1, cc - r:cc + r + 1]
        if np.isfinite(patch).any():
            vals.append(float(np.nanmax(patch)))
    n = len(vals)
    if n < min_cells:
        return {"passed": False, "n": n, "median_ft": None, "expected_ft": list(expected),
                "reason": f"only {n} shoreline cells with data (< {min_cells})"}
    med = float(np.median(vals))
    ok = expected[0] <= med <= expected[1]
    return {"passed": ok, "n": n, "median_ft": med, "expected_ft": list(expected),
            "reason": "ok" if ok else f"median shoreline {med:.1f} ft MLLW outside {expected} - check VDatum offset/sign"}


def regression_shallower(new: np.ndarray, old: np.ndarray, threshold_ft: float = 3.0) -> np.ndarray:
    """Boolean mask of cells whose elevation rose (got shallower) by more than ``threshold_ft``."""
    with np.errstate(invalid="ignore"):
        return np.isfinite(new) & np.isfinite(old) & ((new - old) > threshold_ft)


# ------------------------------------------------------------------ report
def render_report_html(result: ValidationResult, title: str = "Clearwater validation", extras: Mapping[str, dict] | None = None) -> str:
    def f(v: float | None) -> str:
        return "n/a" if v is None else f"{v:.2f}"

    rows = "".join(
        f"<tr><td>{html.escape(name)}</td><td>{s['n']}</td><td>{f(s['rmse'])}</td><td>{f(s['p90_abs'])}</td><td>{f(s['bias'])}</td></tr>"
        for name, s in result.per_source.items()
    )
    g = result.gate
    status = "PASS" if result.passed else "FAIL"
    extra_html = "".join(
        f"<h2>{html.escape(k)}</h2><pre>{html.escape(json.dumps(v, indent=2))}</pre>" for k, v in (extras or {}).items()
    )
    return (
        f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
        "<style>body{font:14px system-ui;margin:2em}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px;text-align:right}"
        "td:first-child,th:first-child{text-align:left}.PASS{color:#060}.FAIL{color:#b00}</style></head><body>"
        f"<h1>{html.escape(title)}</h1><p class='{status}'><b>Gate 1: {status}</b> - {html.escape(str(g.get('reason')))} "
        f"(waterline p90 {f(g.get('waterline_p90_ft'))} ft, limit {g.get('threshold_ft')} ft)</p>"
        "<table><tr><th>source</th><th>n</th><th>RMSE (ft)</th><th>p90 |err| (ft)</th><th>bias (ft)</th></tr>"
        f"{rows}</table>{extra_html}</body></html>"
    )


# ------------------------------------------------------------------ CLI (rasterio, lazy)
def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--runs", type=Path, nargs="+", required=True, help="ground-truth CSVs (time,lat,lon,depth,speed)")
    p.add_argument("--coalne", type=Path, help="ENC COALNE GeoJSON for the datum sanity check")
    p.add_argument("--skip-waterline-gate", action="store_true")
    a = p.parse_args(argv)

    import rasterio  # lazy

    merge_dir = step_dir(a.data_dir, a.aoi, "merge")
    wl_path = step_dir(a.data_dir, a.aoi, "waterline") / "elev.tif"
    with rasterio.open(merge_dir / "merged_elev.tif") as ds:
        merged = ds.read(1)
        t = ds.transform
        grid = Grid(t.c, t.f, ds.width, ds.height, t.a)
    with rasterio.open(merge_dir / "merged_src.tif") as ds:
        src = ds.read(1)
    wl = None
    if wl_path.exists():
        with rasterio.open(wl_path) as ds:
            wl = ds.read(1)
    truth = concat_truth([load_run_csv(r) for r in a.runs])
    result = validate(truth, grid, merged, src, wl, enforce_waterline=not a.skip_waterline_gate)

    extras: dict[str, dict] = {}
    if a.coalne:
        lines = coalne_lines_from_geojson(json.loads(a.coalne.read_text()))
        lon, lat = densify_lines(lines)
        extras["shoreline datum check"] = shoreline_datum_check(grid, merged, lon, lat)
        if not extras["shoreline datum check"]["passed"]:
            result.gate["passed"] = False
            result.gate["reason"] += "; shoreline datum check failed"

    out = step_dir(a.data_dir, a.aoi, "validate")
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.html").write_text(render_report_html(result, f"Clearwater validation - {a.aoi}", extras))
    (out / "report.json").write_text(json.dumps({**result.to_dict(), **extras}, indent=2))
    print(result.gate["reason"])
    return exit_code(result)


if __name__ == "__main__":
    sys.exit(main())
