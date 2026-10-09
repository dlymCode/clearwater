import numpy as np
import pytest

from pipeline import validate as V
from pipeline.common import SOURCES
from pipeline.geo import Grid, utm10_to_lonlat


def make_grid_and_truth(n_pts=400, seed=0):
    grid = Grid(xmin=548000.0, ymax=5340000.0, ncols=400, nrows=400, res=2.0)
    rng = np.random.default_rng(seed)
    flat = rng.choice(390 * 390, size=n_pts, replace=False)  # unique cells
    rows, cols = flat // 390 + 5, flat % 390 + 5
    x, y = grid.rowcol_to_xy(rows, cols)
    lon, lat = utm10_to_lonlat(x, y)
    return grid, rows, cols, lon, lat


def build_case(wl_error_fn):
    grid, rows, cols, lon, lat = make_grid_and_truth()
    truth_elev = np.linspace(-5, 8, len(rows))
    merged = np.full(grid.shape, np.nan, dtype=np.float32)
    wl = np.full(grid.shape, np.nan, dtype=np.float32)
    src = np.zeros(grid.shape, dtype=np.uint8)
    merged[rows, cols] = truth_elev + 0.3
    src[rows, cols] = SOURCES["bluetopo"].code
    src[rows[::2], cols[::2]] = SOURCES["cudem"].code
    wl[rows, cols] = truth_elev + wl_error_fn(len(rows))
    truth = V.TruthPoints(lon, lat, truth_elev, np.full(len(rows), 4.0))
    return truth, grid, merged, src, wl


def test_error_stats_rmse_and_p90():
    err = np.concatenate([np.full(90, 1.0), np.full(10, -3.0)])
    s = V.error_stats(err)
    assert s["n"] == 100 and s["rmse"] == pytest.approx(np.sqrt((90 * 1 + 10 * 9) / 100))
    assert s["p90_abs"] == pytest.approx(np.percentile(np.abs(err), 90))
    assert s["bias"] == pytest.approx(0.6)
    assert V.error_stats(np.array([np.nan]))["n"] == 0


def test_gate_passes_when_waterline_p90_within_limit():
    # 95 % of cells off by 0.5 ft, 5 % badly off: p90 is still 0.5 ft
    def err(n):
        e = np.full(n, 0.5)
        e[: n // 20] = 4.0
        return e

    r = V.validate(*build_case(err))
    assert r.gate["passed"] and V.exit_code(r) == 0
    assert r.per_source["waterline"]["p90_abs"] == pytest.approx(0.5)


def test_gate_fails_when_waterline_p90_exceeds_1p5():
    def err(n):
        e = np.full(n, 0.5)
        e[: n // 5] = 2.0  # 20 % of cells 2 ft off -> p90 = 2.0
        return e

    r = V.validate(*build_case(err))
    assert not r.gate["passed"] and V.exit_code(r) == 1
    assert r.gate["waterline_p90_ft"] == pytest.approx(2.0) and "1.5" in r.gate["reason"]


def test_gate_boundary_near_1p5():
    r = V.validate(*build_case(lambda n: np.full(n, 1.49)))
    assert r.gate["passed"]
    r = V.validate(*build_case(lambda n: np.full(n, 1.51)))
    assert not r.gate["passed"]


def test_gate_fails_closed_without_waterline_samples():
    truth, grid, merged, src, _ = build_case(lambda n: np.zeros(n))
    r = V.validate(truth, grid, merged, src, None)
    assert V.exit_code(r) == 1 and "fails closed" in r.gate["reason"]
    r = V.validate(truth, grid, merged, src, np.full(grid.shape, np.nan, np.float32))
    assert V.exit_code(r) == 1
    r = V.validate(truth, grid, merged, src, None, enforce_waterline=False)
    assert V.exit_code(r) == 0


def test_per_source_breakdown():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    r = V.validate(truth, grid, merged, src, wl)
    assert {"merged", "bluetopo", "cudem", "waterline"} <= set(r.per_source)
    assert r.per_source["bluetopo"]["n"] + r.per_source["cudem"]["n"] == r.per_source["merged"]["n"]
    assert r.per_source["cudem"]["rmse"] == pytest.approx(0.3, abs=1e-5)


def test_points_outside_grid_are_ignored():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    truth.lon[:10] += 5.0  # far outside
    r = V.validate(truth, grid, merged, src, wl)
    assert r.per_source["waterline"]["n"] == len(truth.lon) - 10


def test_load_run_csv_filters_and_tide_correction(tmp_path):
    p = tmp_path / "run.csv"
    p.write_text("time,lat,lon,depth,speed\n"
                 "2026-01-01T00:00:00Z,48.3,-122.5,10.0,5.0\n"
                 "2026-01-01T00:00:01Z,48.3,-122.5,12.0,0.1\n"  # sitting still: dropped
                 "2026-01-01T00:00:02Z,48.3,-122.5,bad,5.0\n"  # unparsable: dropped
                 "2026-01-01T00:00:03Z,48.3,-122.5,6.0,3.0\n")
    t = V.load_run_csv(p)
    assert t.elev_ft.tolist() == [-10.0, -6.0]
    q = tmp_path / "run2.csv"
    q.write_text("time,lat,lon,depth,speed,tide_ft\n2026-01-01T00:00:00Z,48.3,-122.5,10.0,5.0,4.0\n")
    assert V.load_run_csv(q).elev_ft.tolist() == [-6.0]  # tide 4 ft - depth 10 ft
    assert len(V.concat_truth([t, V.load_run_csv(q)]).lon) == 3


def test_shoreline_datum_sanity_check():
    grid = Grid(xmin=548000.0, ymax=5340000.0, ncols=300, nrows=300, res=2.0)
    elev = np.full(grid.shape, 4.0, dtype=np.float32)
    elev[:, 150:] = 11.0  # land at ~MHHW
    cols = np.full(200, 151)
    rows = np.arange(50, 250)
    lon, lat = utm10_to_lonlat(*grid.rowcol_to_xy(rows, cols))
    ok = V.shoreline_datum_check(grid, elev, lon, lat)
    assert ok["passed"] and 9 <= ok["median_ft"] <= 13
    # forgot the NAVD88->MLLW offset (-2.4 ft) -> shoreline reads ~8.6 ft -> flagged
    bad = V.shoreline_datum_check(grid, elev - 2.4, lon, lat)
    assert not bad["passed"] and "VDatum" in bad["reason"]
    none = V.shoreline_datum_check(grid, np.full(grid.shape, np.nan, np.float32), lon, lat)
    assert not none["passed"] and none["n"] == 0


def test_coalne_geojson_and_densify():
    gj = {"features": [{"geometry": {"type": "LineString", "coordinates": [[-122.5, 48.3], [-122.49, 48.3]]}},
                       {"geometry": {"type": "MultiLineString", "coordinates": [[[-122.4, 48.3], [-122.4, 48.31]]]}}]}
    lines = V.coalne_lines_from_geojson(gj)
    assert len(lines) == 2
    lon, lat = V.densify_lines(lines, spacing_deg=0.001)
    assert len(lon) >= 20 and lon.min() == pytest.approx(-122.5)


def test_regression_shallower_lists_cells_rising_over_3ft():
    old = np.array([[0.0, 0.0, np.nan, 5.0]])
    new = np.array([[3.5, 2.9, 10.0, 1.0]])
    assert V.regression_shallower(new, old).tolist() == [[True, False, False, False]]


def test_report_html():
    r = V.validate(*build_case(lambda n: np.full(n, 2.0)))
    html = V.render_report_html(r, "t <b>")
    assert "FAIL" in html and "&lt;b&gt;" in html and "bluetopo" in html
    ok = V.validate(*build_case(lambda n: np.zeros(n)))
    assert "PASS" in V.render_report_html(ok)
