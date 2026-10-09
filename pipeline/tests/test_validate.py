import numpy as np
import pytest

from pipeline import tiles
from pipeline import validate as V
from pipeline.common import AOI_MHHW_FT, SOURCES
from pipeline.geo import Grid, utm10_to_lonlat


def make_grid_and_truth(n_pts=400, seed=0):
    grid = Grid(xmin=548000.0, ymax=5340000.0, ncols=400, nrows=400, res=2.0)
    rng = np.random.default_rng(seed)
    flat = rng.choice(390 * 390, size=n_pts, replace=False)  # unique cells
    rows, cols = flat // 390 + 5, flat % 390 + 5
    x, y = grid.rowcol_to_xy(rows, cols)
    lon, lat = utm10_to_lonlat(x, y)
    return grid, rows, cols, lon, lat


def build_case(wl_error_fn, n_runs=3, cudem_bias=0.3, n_pts=400):
    grid, rows, cols, lon, lat = make_grid_and_truth(n_pts)
    truth_elev = np.linspace(-5, 8, len(rows))
    merged = np.full(grid.shape, np.nan, dtype=np.float32)
    wl = np.full(grid.shape, np.nan, dtype=np.float32)
    src = np.zeros(grid.shape, dtype=np.uint8)
    merged[rows, cols] = truth_elev + 0.3
    src[rows, cols] = SOURCES["bluetopo"].code
    src[rows[::2], cols[::2]] = SOURCES["cudem"].code
    merged[rows[::2], cols[::2]] = truth_elev[::2] + cudem_bias
    wl[rows, cols] = truth_elev + wl_error_fn(len(rows))
    run_id = np.arange(len(rows)) % n_runs
    truth = V.TruthPoints(lon, lat, truth_elev, np.full(len(rows), 4.0), run_id=run_id, n_runs=n_runs)
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
    assert r.checks["waterline"]["per_run_samples"] and min(r.checks["waterline"]["per_run_samples"]) >= 1


def test_gate_fails_when_waterline_p90_exceeds_1p5():
    def err(n):
        e = np.full(n, 0.5)
        e[: n // 5] = 2.0  # 20 % of cells 2 ft off -> p90 = 2.0
        return e

    r = V.validate(*build_case(err))
    assert not r.gate["passed"] and V.exit_code(r) == 1
    assert r.gate["waterline_p90_ft"] == pytest.approx(2.0) and "1.5" in r.gate["reason"]


def test_gate_boundary_near_1p5():
    assert V.validate(*build_case(lambda n: np.full(n, 1.49))).gate["passed"]
    assert not V.validate(*build_case(lambda n: np.full(n, 1.51))).gate["passed"]


def test_gate_fails_closed_without_waterline_samples():
    truth, grid, merged, src, _ = build_case(lambda n: np.zeros(n))
    r = V.validate(truth, grid, merged, src, None)
    assert V.exit_code(r) == 1 and "fails closed" in r.gate["reason"]
    r = V.validate(truth, grid, merged, src, np.full(grid.shape, np.nan, np.float32))
    assert V.exit_code(r) == 1
    r = V.validate(truth, grid, merged, src, None, enforce_waterline=False)
    assert V.exit_code(r) == 0


def test_gate_cannot_pass_on_a_single_sample():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    keep = np.isfinite(wl)
    first = tuple(np.argwhere(keep)[0])
    wl2 = np.full(grid.shape, np.nan, dtype=np.float32)
    wl2[first] = wl[first]  # one perfect sample
    r = V.validate(truth, grid, merged, src, wl2)
    assert not r.passed and "only 1 waterline samples" in r.gate["reason"]


def test_gate_needs_30_samples_total():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    idx = np.argwhere(np.isfinite(wl))
    wl2 = np.full(grid.shape, np.nan, dtype=np.float32)
    for r_, c_ in idx[:29]:
        wl2[r_, c_] = wl[r_, c_]
    assert "29 waterline samples" in V.validate(truth, grid, merged, src, wl2).gate["reason"]
    wl3 = np.full(grid.shape, np.nan, dtype=np.float32)
    for r_, c_ in idx[:60]:
        wl3[r_, c_] = wl[r_, c_]
    assert V.validate(truth, grid, merged, src, wl3).passed


def test_gate_needs_a_sample_from_every_run():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    x, y = V.lonlat_to_utm10(truth.lon, truth.lat)
    rows, cols = grid.xy_to_rowcol(x, y)
    wl2 = wl.copy()
    for i in np.flatnonzero(truth.run_id == 2):  # run 2 gets no waterline prediction at all
        wl2[rows[i], cols[i]] = np.nan
    r = V.validate(truth, grid, merged, src, wl2)
    assert not r.passed and "run(s) [2] have no waterline sample" in r.gate["reason"]
    assert r.checks["waterline"]["per_run_samples"][2] == 0


def test_gate_needs_three_runs():
    r = V.validate(*build_case(lambda n: np.zeros(n), n_runs=2))
    assert not r.passed and "only 2 ground-truth run" in r.gate["reason"]


def test_bias_gate_flags_navd88_source_with_constant_offset():
    r = V.validate(*build_case(lambda n: np.zeros(n), cudem_bias=2.4))  # forgot the datum shift
    assert not r.passed and not r.checks["bias"]["passed"]
    assert "cudem" in r.checks["bias"]["offenders"] and "datum" in r.gate["reason"]
    ok = V.validate(*build_case(lambda n: np.zeros(n), cudem_bias=1.4))
    assert ok.checks["bias"]["passed"]
    # bluetopo is MLLW-native: a large bias there is not a datum-conversion signature
    stats = {"bluetopo": {"n": 100, "bias": 3.0}, "cudem": {"n": 5, "bias": 9.0}}
    assert V.evaluate_bias(stats)["passed"]  # cudem has too few samples to judge


def test_per_source_breakdown_and_coverage():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    r = V.validate(truth, grid, merged, src, wl)
    assert {"merged", "bluetopo", "cudem", "waterline"} <= set(r.per_source)
    assert r.per_source["bluetopo"]["n"] + r.per_source["cudem"]["n"] == r.per_source["merged"]["n"]
    assert r.per_source["cudem"]["rmse"] == pytest.approx(0.3, abs=1e-5)
    assert r.per_source["merged"]["coverage"] == pytest.approx(1.0)
    assert r.per_source["cudem"]["coverage"] == pytest.approx(0.5) and r.per_source["bluetopo"]["coverage"] == pytest.approx(0.5)
    wl2 = wl.copy()
    flat = np.flatnonzero(np.isfinite(wl2))
    wl2.flat[flat[: len(flat) // 2]] = np.nan
    assert V.validate(truth, grid, merged, src, wl2).per_source["waterline"]["coverage"] == pytest.approx(0.5)


def test_points_outside_grid_are_ignored():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    truth.lon[:10] += 5.0  # far outside
    r = V.validate(truth, grid, merged, src, wl)
    assert r.per_source["waterline"]["n"] == len(truth.lon) - 10


def test_encode_consistency_check():
    truth, grid, merged, src, wl = build_case(lambda n: np.zeros(n))
    good = tiles.decode_terrain_rgb(tiles.encode_terrain_rgb(merged))
    r = V.validate(truth, grid, merged, src, wl, good)
    assert r.passed and r.checks["encode_consistency"]["passed"] and not r.warnings
    bad = good + np.float32(0.5)  # an encode bug shifting everything half a foot
    r = V.validate(truth, grid, merged, src, wl, bad)
    assert not r.passed and "decoded depth tiles" in r.gate["reason"]
    # absent decoded raster: warning only
    assert V.validate(truth, grid, merged, src, wl).warnings


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
    both = V.concat_truth([t, V.load_run_csv(q)])
    assert len(both.lon) == 3 and both.run_id.tolist() == [0, 0, 1] and both.n_runs == 2


# ------------------------------------------------------------------ shoreline datum check
def shoreline_case(shore_ft):
    grid = Grid(xmin=548000.0, ymax=5340000.0, ncols=300, nrows=300, res=2.0)
    elev = np.full(grid.shape, 4.0, dtype=np.float32)
    elev[:, 150:] = shore_ft
    rows = np.arange(50, 250)
    lon, lat = utm10_to_lonlat(*grid.rowcol_to_xy(rows, np.full(200, 151)))
    return grid, elev, lon, lat


def test_shoreline_datum_check_passes_at_expected_mhhw():
    grid, elev, lon, lat = shoreline_case(AOI_MHHW_FT["skagit"])
    ok = V.shoreline_datum_check(grid, elev, lon, lat, AOI_MHHW_FT["skagit"])
    assert ok["passed"] and ok["median_ft"] == pytest.approx(10.0)
    assert V.expected_shoreline_window("skagit") == (8.5, 11.5)


@pytest.mark.parametrize("aoi", sorted(AOI_MHHW_FT))
def test_sign_flipped_datum_offset_fails_shoreline_check(aoi):
    """A NAVD88->MLLW offset applied with the wrong sign moves the shoreline by 2 x 2.35 ft."""
    mhhw = AOI_MHHW_FT[aoi]
    offset = 2.35
    correct = mhhw  # shoreline as published when the offset is applied correctly
    navd88_value = correct - offset  # what the NAVD88 DEM reads at the shoreline
    flipped = navd88_value - offset  # sign-flipped conversion
    forgot = navd88_value  # offset never applied
    grid, elev, lon, lat = shoreline_case(correct)
    assert V.shoreline_datum_check(grid, elev, lon, lat, mhhw)["passed"]
    for wrong in (flipped, forgot):
        grid, elev, lon, lat = shoreline_case(wrong)
        bad = V.shoreline_datum_check(grid, elev, lon, lat, mhhw)
        assert not bad["passed"] and "VDatum" in bad["reason"]


def test_shoreline_check_fails_closed_without_cells():
    grid, elev, lon, lat = shoreline_case(10.0)
    none = V.shoreline_datum_check(grid, np.full(grid.shape, np.nan, np.float32), lon, lat, 10.0)
    assert not none["passed"] and none["n"] == 0 and "fails closed" in none["reason"]
    few = V.shoreline_datum_check(grid, elev, lon[:20], lat[:20], 10.0)
    assert not few["passed"]


def test_failed_shoreline_check_flips_overall_gate():
    r = V.validate(*build_case(lambda n: np.zeros(n)))
    assert r.passed
    r.add_check("shoreline_datum", False, "median shoreline 6.0 ft MLLW outside 8.5..11.5")
    assert not r.passed and V.exit_code(r) == 1 and "shoreline_datum" in r.gate["reason"]
    r2 = V.validate(*build_case(lambda n: np.zeros(n)))
    r2.add_check("shoreline_datum", True, "ok")
    assert r2.passed


def test_aoi_mhhw_table_covers_all_aois():
    from pipeline.common import AOI_SLUGS

    assert set(AOI_MHHW_FT) == set(AOI_SLUGS) and all(8 < v < 15 for v in AOI_MHHW_FT.values())


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
    assert "FAIL" in html and "&lt;b&gt;" in html and "bluetopo" in html and "coverage" in html
    ok = V.validate(*build_case(lambda n: np.zeros(n)))
    page = V.render_report_html(ok)
    assert "PASS" in page and "Checks" in page and "Warnings" in page  # no decoded raster -> warning shown
