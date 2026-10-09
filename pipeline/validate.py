"""Step 7 - ground-truth check (Gate 1) plus publish-time sanity checks.

    python -m pipeline.validate --aoi skagit --runs run1.csv run2.csv run3.csv --coalne enc/*_COALNE.geojson

Everything below must pass for ``report.json`` to say ``gate.passed: true`` (publish.py refuses
otherwise). All checks fail closed:

* **Waterline gate** - p90 absolute error vs. the sounder runs must be <= 1.5 ft, from >= 30 waterline
  samples in total, >= 1 sample from *each* run, and >= 3 runs (PRD: 3 known runs).
  ``--skip-waterline-gate`` is a dev override.
* **Shoreline datum check (mandatory)** - merged elevation at ENC COALNE shoreline cells must sit within
  +/- 1.5 ft of the AOI's expected MHHW (``common.AOI_MHHW_FT``). No COALNE file or too few shoreline
  cells = failure. ``--skip-shoreline-check`` is a dev override. Catches a forgotten/sign-flipped VDatum offset.
* **Bias gate** - any NAVD88-derived source (CUDEM, CoNED, lidar) with |mean bias| > 1.5 ft against the
  runs fails (a constant bias is the signature of a datum error).
* **Encode consistency** - when ``tiles/depth_rgb.tif`` exists, the *decoded* Terrain-RGB raster sampled
  at the truth points must match the merged raster (catches encode bugs); absent = warning only.

Run CSV columns: ``time,lat,lon,depth,speed`` (+ optional ``tide_ft``). ``depth`` is feet
below the surface at ``time``; with a ``tide_ft`` column truth elevation = tide_ft - depth,
otherwise ``depth`` is taken as already tide-corrected (below MLLW), elevation = -depth.
``speed`` is knots; rows under 0.5 kt are dropped (same physical filter as the app).
Per-source ``coverage`` = fraction of truth points that have a prediction from that source.
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

from .common import AOI_MHHW_FT, SHORELINE_TOL_FT, SOURCE_BY_CODE, step_dir, utc_now_iso
from .geo import Grid, lonlat_to_utm10, sample_grid

P90_GATE_FT = 1.5
MIN_SPEED_KT = 0.5
MIN_WATERLINE_SAMPLES = 30
MIN_RUNS = 3
BIAS_GATE_FT = 1.5
MIN_BIAS_SAMPLES = 30
SHORELINE_MIN_CELLS = 50
ENCODE_TOL_FT = 0.06  # half the 0.1 ft Terrain-RGB quantum plus float slack
#: Sources whose raw data are NAVD88 and therefore pass through the VDatum conversion.
NAVD88_DERIVED = ("cudem", "coned", "lidar_2014", "lidar_ncmp", "wa_lidar")


@dataclass
class TruthPoints:
    lon: np.ndarray
    lat: np.ndarray
    elev_ft: np.ndarray  # ft MLLW, positive up
    speed_kt: np.ndarray
    run_id: np.ndarray | None = None  # which ground-truth run each point came from
    n_runs: int | None = None

    def __post_init__(self) -> None:
        if self.run_id is None:
            self.run_id = np.zeros(len(self.lon), dtype=np.int64)
        if self.n_runs is None:
            self.n_runs = int(self.run_id.max()) + 1 if len(self.run_id) else 0


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
    ids = np.concatenate([np.full(len(r.lon), i, dtype=np.int64) for i, r in enumerate(runs)]) if runs else np.zeros(0, np.int64)
    return TruthPoints(*(np.concatenate([getattr(r, f) for r in runs]) for f in ("lon", "lat", "elev_ft", "speed_kt")),
                       run_id=ids, n_runs=len(runs))


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
    checks: dict[str, dict] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return bool(self.gate.get("passed"))

    def add_check(self, name: str, passed: bool, reason: str, **detail) -> None:
        self.checks[name] = {"passed": bool(passed), "reason": reason, **detail}
        self._finalize()

    def _finalize(self) -> None:
        failures = [f"{n}: {c['reason']}" for n, c in self.checks.items() if not c["passed"]]
        self.gate["passed"] = not failures and bool(self.checks)
        self.gate["reason"] = "ok" if self.gate["passed"] else "; ".join(failures) or "no checks ran"
        self.gate["checks"] = self.checks

    def to_dict(self) -> dict:
        return {"per_source": self.per_source, "gate": self.gate, "warnings": self.warnings}


def evaluate_waterline(stats: dict | None, per_run_counts: Sequence[int], n_runs: int, *,
                       threshold: float = P90_GATE_FT, enforce: bool = True,
                       min_samples: int = MIN_WATERLINE_SAMPLES, min_runs: int = MIN_RUNS) -> dict:
    """The Gate-1 check. Fails closed on too few runs, too few samples or a run with no sample."""
    base = {"threshold_ft": threshold, "waterline_p90_ft": None if not stats else stats.get("p90_abs"),
            "n_samples": 0 if not stats else stats.get("n", 0), "per_run_samples": list(per_run_counts)}
    if not enforce:
        return {**base, "passed": True, "reason": "waterline gate skipped"}
    if not stats or not stats.get("n"):
        return {**base, "passed": False, "reason": "no waterline samples (gate fails closed)"}
    problems = []
    if n_runs < min_runs:
        problems.append(f"only {n_runs} ground-truth run(s) (< {min_runs})")
    if stats["n"] < min_samples:
        problems.append(f"only {stats['n']} waterline samples (< {min_samples})")
    empty = [i for i, c in enumerate(per_run_counts) if c < 1]
    if empty:
        problems.append(f"run(s) {empty} have no waterline sample")
    if stats["p90_abs"] > threshold:
        problems.append(f"waterline p90 {stats['p90_abs']:.2f} ft > {threshold} ft")
    return {**base, "passed": not problems, "reason": "; ".join(problems) or "ok"}


def evaluate_bias(per_source: Mapping[str, dict], limit: float = BIAS_GATE_FT,
                  min_samples: int = MIN_BIAS_SAMPLES) -> dict:
    """|mean bias| of every NAVD88-derived source must stay within ``limit`` (needs >= min_samples)."""
    offenders = {n: s["bias"] for n, s in per_source.items()
                 if n in NAVD88_DERIVED and s["n"] >= min_samples and abs(s["bias"]) > limit}
    checked = [n for n, s in per_source.items() if n in NAVD88_DERIVED and s["n"] >= min_samples]
    reason = "ok" if not offenders else "constant bias (datum error?): " + ", ".join(f"{n} {b:+.2f} ft" for n, b in offenders.items())
    return {"passed": not offenders, "reason": reason, "limit_ft": limit, "sources_checked": checked, "offenders": offenders}


def validate(truth: TruthPoints, grid: Grid, merged_elev: np.ndarray, merged_src: np.ndarray | None = None,
             waterline_elev: np.ndarray | None = None, depth_decoded: np.ndarray | None = None, *,
             threshold: float = P90_GATE_FT, enforce_waterline: bool = True, min_runs: int = MIN_RUNS,
             min_waterline_samples: int = MIN_WATERLINE_SAMPLES) -> ValidationResult:
    x, y = lonlat_to_utm10(truth.lon, truth.lat)
    total = max(len(truth.lon), 1)
    res = ValidationResult()
    pred = sample_grid(merged_elev, grid, x, y)
    err = pred - truth.elev_ft
    res.per_source["merged"] = {**error_stats(err), "coverage": float(np.isfinite(pred).sum()) / total}
    if merged_src is not None:
        codes = sample_grid(merged_src.astype(np.float64), grid, x, y, fill=0.0).astype(int)
        for code in sorted(set(codes.tolist()) - {0}):
            name = SOURCE_BY_CODE[code].name if code in SOURCE_BY_CODE else f"code_{code}"
            sel = codes == code
            res.per_source[name] = {**error_stats(err[sel]), "coverage": float(sel.sum()) / total}
    wl_stats = None
    per_run = [0] * (truth.n_runs or 0)
    if waterline_elev is not None:
        wl_pred = sample_grid(waterline_elev, grid, x, y)
        wl_stats = {**error_stats(wl_pred - truth.elev_ft), "coverage": float(np.isfinite(wl_pred).sum()) / total}
        res.per_source["waterline"] = wl_stats
        per_run = np.bincount(truth.run_id[np.isfinite(wl_pred)], minlength=truth.n_runs or 0).tolist()
    wl = evaluate_waterline(wl_stats, per_run, truth.n_runs or 0, threshold=threshold, enforce=enforce_waterline,
                            min_samples=min_waterline_samples, min_runs=min_runs)
    res.gate.update(threshold_ft=threshold, waterline_p90_ft=wl["waterline_p90_ft"])
    res.checks["waterline"] = wl
    res.checks["bias"] = evaluate_bias(res.per_source)
    if depth_decoded is not None:
        dec = sample_grid(depth_decoded, grid, x, y)
        res.per_source["depth_tiles_decoded"] = {**error_stats(dec - truth.elev_ft), "coverage": float(np.isfinite(dec).sum()) / total}
        both = np.isfinite(pred)
        mismatch = both & (~np.isfinite(dec) | (np.abs(np.nan_to_num(dec) - np.nan_to_num(pred)) > ENCODE_TOL_FT))
        res.checks["encode_consistency"] = {
            "passed": not mismatch.any(), "n_checked": int(both.sum()), "n_mismatch": int(mismatch.sum()),
            "reason": "ok" if not mismatch.any() else f"{int(mismatch.sum())} truth points differ between merged_elev and decoded depth tiles"}
    else:
        res.warnings.append("tiles/depth_rgb.tif not found: Terrain-RGB encode consistency was not checked")
    res._finalize()
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


def expected_shoreline_window(aoi: str, tol_ft: float = SHORELINE_TOL_FT) -> tuple[float, float]:
    mhhw = AOI_MHHW_FT[aoi]
    return (mhhw - tol_ft, mhhw + tol_ft)


def shoreline_datum_check(grid: Grid, merged_elev: np.ndarray, lon: np.ndarray, lat: np.ndarray,
                          expected_mhhw_ft: float, tol_ft: float = SHORELINE_TOL_FT,
                          min_cells: int = SHORELINE_MIN_CELLS, search_radius_cells: int = 1) -> dict:
    """Median merged elevation at ENC COALNE shoreline cells must be within ``tol_ft`` of the AOI's MHHW.

    Each shoreline point looks at its (2r+1)^2 cell neighbourhood and takes the neighbourhood
    maximum, since the charted shoreline can fall a cell or two off the DEM's own waterline.
    Fewer than ``min_cells`` shoreline cells with data is a failure (fail closed).
    """
    expected = (expected_mhhw_ft - tol_ft, expected_mhhw_ft + tol_ft)
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
    base = {"n": n, "expected_mhhw_ft": expected_mhhw_ft, "expected_ft": list(expected)}
    if n < min_cells:
        return {**base, "passed": False, "median_ft": None,
                "reason": f"only {n} shoreline cells with data (< {min_cells}); gate fails closed"}
    med = float(np.median(vals))
    ok = expected[0] <= med <= expected[1]
    return {**base, "passed": ok, "median_ft": med,
            "reason": "ok" if ok else f"median shoreline {med:.1f} ft MLLW outside {expected[0]:.1f}..{expected[1]:.1f} - check VDatum offset/sign"}


def regression_shallower(new: np.ndarray, old: np.ndarray, threshold_ft: float = 3.0) -> np.ndarray:
    """Boolean mask of cells whose elevation rose (got shallower) by more than ``threshold_ft``."""
    with np.errstate(invalid="ignore"):
        return np.isfinite(new) & np.isfinite(old) & ((new - old) > threshold_ft)


# ------------------------------------------------------------------ report
def render_report_html(result: ValidationResult, title: str = "Clearwater validation", extras: Mapping[str, dict] | None = None) -> str:
    def f(v: float | None) -> str:
        return "n/a" if v is None else f"{v:.2f}"

    rows = "".join(
        f"<tr><td>{html.escape(name)}</td><td>{s['n']}</td><td>{f(s['rmse'])}</td><td>{f(s['p90_abs'])}</td>"
        f"<td>{f(s['bias'])}</td><td>{f(s.get('coverage'))}</td></tr>"
        for name, s in result.per_source.items()
    )
    check_rows = "".join(
        f"<tr><td>{html.escape(n)}</td><td class='{'PASS' if c['passed'] else 'FAIL'}'>{'PASS' if c['passed'] else 'FAIL'}</td>"
        f"<td style='text-align:left'>{html.escape(str(c['reason']))}</td></tr>"
        for n, c in result.checks.items()
    )
    warn = "".join(f"<li>{html.escape(w)}</li>" for w in result.warnings)
    g = result.gate
    status = "PASS" if result.passed else "FAIL"
    extra_html = "".join(
        f"<h2>{html.escape(k)}</h2><pre>{html.escape(json.dumps(v, indent=2))}</pre>" for k, v in (extras or {}).items()
    )
    return (
        f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
        "<style>body{font:14px system-ui;margin:2em}table{border-collapse:collapse;margin-bottom:1em}td,th{border:1px solid #999;padding:4px 10px;text-align:right}"
        "td:first-child,th:first-child{text-align:left}.PASS{color:#060}.FAIL{color:#b00}</style></head><body>"
        f"<h1>{html.escape(title)}</h1><p class='{status}'><b>Gate 1: {status}</b> - {html.escape(str(g.get('reason')))} "
        f"(waterline p90 {f(g.get('waterline_p90_ft'))} ft, limit {g.get('threshold_ft')} ft)</p>"
        f"<h2>Checks</h2><table><tr><th>check</th><th>result</th><th>detail</th></tr>{check_rows}</table>"
        f"<h2>Per source</h2><table><tr><th>source</th><th>n</th><th>RMSE (ft)</th><th>p90 |err| (ft)</th><th>bias (ft)</th><th>coverage</th></tr>"
        f"{rows}</table>{('<h2>Warnings</h2><ul>' + warn + '</ul>') if warn else ''}{extra_html}</body></html>"
    )


# ------------------------------------------------------------------ CLI (rasterio, lazy)
def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--runs", type=Path, nargs="+", required=True, help="ground-truth CSVs (time,lat,lon,depth,speed); >= 3")
    p.add_argument("--coalne", type=Path, nargs="*", default=[], help="ENC COALNE GeoJSON file(s) for the mandatory datum check")
    p.add_argument("--skip-waterline-gate", action="store_true", help="dev only")
    p.add_argument("--skip-shoreline-check", action="store_true", help="dev only")
    a = p.parse_args(argv)

    import rasterio  # lazy

    from .tiles import decode_terrain_rgb

    merge_dir = step_dir(a.data_dir, a.aoi, "merge")
    wl_path = step_dir(a.data_dir, a.aoi, "waterline") / "elev.tif"
    rgb_path = step_dir(a.data_dir, a.aoi, "tiles") / "depth_rgb.tif"
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
    decoded = None
    if rgb_path.exists():
        with rasterio.open(rgb_path) as ds:
            decoded = decode_terrain_rgb(np.moveaxis(ds.read([1, 2, 3]), 0, -1))
    else:
        print(f"warning: {rgb_path} not found; skipping encode-consistency check", file=sys.stderr)
    truth = concat_truth([load_run_csv(r) for r in a.runs])
    result = validate(truth, grid, merged, src, wl, decoded, enforce_waterline=not a.skip_waterline_gate)

    extras: dict[str, dict] = {}
    if a.skip_shoreline_check:
        result.warnings.append("shoreline datum check skipped (--skip-shoreline-check)")
        result.add_check("shoreline_datum", True, "skipped")
    elif not a.coalne:
        result.add_check("shoreline_datum", False, "no COALNE GeoJSON supplied; the datum check is mandatory (gate fails closed)")
    else:
        lines: list = []
        for f in a.coalne:
            lines += coalne_lines_from_geojson(json.loads(Path(f).read_text()))
        lon, lat = densify_lines(lines) if lines else (np.zeros(0), np.zeros(0))
        chk = shoreline_datum_check(grid, merged, lon, lat, AOI_MHHW_FT[a.aoi])
        extras["shoreline datum check"] = chk
        result.add_check("shoreline_datum", chk["passed"], chk["reason"], median_ft=chk["median_ft"], n=chk["n"],
                         expected_mhhw_ft=chk["expected_mhhw_ft"])
    result._finalize()

    out = step_dir(a.data_dir, a.aoi, "validate")
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.html").write_text(render_report_html(result, f"Clearwater validation - {a.aoi}", extras))
    (out / "report.json").write_text(json.dumps({"aoi": a.aoi, "generated_at": utc_now_iso(), **result.to_dict()}, indent=2))
    print(result.gate["reason"])
    return exit_code(result)


if __name__ == "__main__":
    sys.exit(main())
