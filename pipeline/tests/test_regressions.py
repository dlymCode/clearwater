"""Regression tests for bugs found by the battle-test fuzzing wave (each test names the bug it pins)."""

import copy
import datetime as dt
import hashlib
import json
import os

import numpy as np
import pytest

from pipeline import coops, fetch_baseline as fb, fetch_tides, publish, source_meta as sm, tiles
from pipeline import to_mllw, validate as V, waterline_dem as W
from pipeline.common import (DATE_NODATA, ELEV_MAX_FT, ELEV_MIN_FT, REQUIRED_CHECKS, TEN_YEARS_DAYS, ChecksumMismatch, Manifest,
                             days_since_epoch)
from pipeline.geo import Grid, lonlat_to_utm10, sample_grid, utm10_to_lonlat
from pipeline.merge import _layer_unc, merge_stack

UTC = dt.timezone.utc
NAN = np.nan
NOW = dt.datetime(2026, 10, 9, tzinfo=UTC)


# =========================================================================== merge (C1, C2)
def _one(e, d, u, codes=None, ref=20000):
    e = np.array(e, np.float32).reshape(-1, 1, 1)
    d = np.array(d, np.int32).reshape(-1, 1, 1)
    u = np.array(u, np.float32).reshape(-1, 1, 1)
    return merge_stack(e, d, u, codes or list(range(1, len(e) + 1)), ref)


def test_c1_hole_plus_valid_nan_uncertainty_layer_is_not_a_hole():
    r = _one([NAN, 7.0], [19000, 19000], [1.0, NAN])
    assert r.elev.item() == 7.0 and r.src.item() == 2 and r.date.item() == 19000  # was: elev NaN with src 2


def test_c1_newer_nan_uncertainty_beats_older_layer():
    r = _one([1.0, 7.0], [18000, 19000], [0.5, NAN])
    assert (r.elev.item(), r.src.item(), r.date.item()) == (7.0, 2, 19000)


def test_c1_three_layers_nodata_date_hole_and_two_nan_unc():
    r = _one([1.0, 7.0, 9.0], [DATE_NODATA, 19000, 19000], [1.0, NAN, NAN])
    assert (r.elev.item(), r.src.item()) == (7.0, 2)  # tied NaN-unc candidates: stable first layer


def test_c1_never_emits_src_without_elevation():
    rng = np.random.default_rng(5)
    for _ in range(200):
        s, h, w = int(rng.integers(1, 6)), 3, 3
        e = rng.normal(0, 5, (s, h, w)).astype(np.float32)
        e[rng.random(e.shape) < 0.4] = NAN
        d = rng.integers(10000, 20000, (s, h, w)).astype(np.int32)
        d[rng.random(d.shape) < 0.1] = DATE_NODATA
        u = rng.integers(0, 4, (s, h, w)).astype(np.float32)
        u[rng.random(u.shape) < 0.5] = NAN
        r = merge_stack(e, d, u, list(range(1, s + 1)), 20000)
        assert np.array_equal(np.isnan(r.elev), r.src == 0)
        assert np.array_equal(r.date == DATE_NODATA, r.src == 0)


def _oracle(e, d, u, ref):
    """Slow per-cell reference implementation of the merge rules (ported from the fuzz harness)."""
    s, h, w = e.shape
    out = {}
    for i in range(h):
        for j in range(w):
            c = [k for k in range(s) if ELEV_MIN_FT <= e[k, i, j] <= ELEV_MAX_FT and d[k, i, j] != DATE_NODATA]
            if not c:
                out[i, j] = None
                continue
            rec = [k for k in c if ref - int(d[k, i, j]) <= TEN_YEARS_DAYS]
            pool = rec or c
            best = max(int(d[k, i, j]) for k in pool)
            pool = [k for k in pool if int(d[k, i, j]) == best]
            out[i, j] = min(pool, key=lambda k: (np.inf if np.isnan(u[k, i, j]) else float(u[k, i, j]), k))
    return out


def test_c1_matches_oracle_on_randomized_stacks():
    rng = np.random.default_rng(11)
    for _ in range(400):
        s = int(rng.integers(1, 7))
        h = w = int(rng.integers(1, 5))
        e = rng.normal(0, 5, (s, h, w)).astype(np.float32)
        e[rng.random(e.shape) < 0.3] = NAN
        e[rng.random(e.shape) < 0.05] = 1e30  # implausible values are holes for the oracle too
        d = rng.integers(10000, 20000, (s, h, w)).astype(np.int32)
        d[rng.random(d.shape) < 0.1] = DATE_NODATA
        u = rng.integers(0, 4, (s, h, w)).astype(np.float32)
        u[rng.random(u.shape) < 0.2] = NAN
        ref = int(rng.integers(15000, 30000))
        r = merge_stack(e, d, u, list(range(1, s + 1)), ref)
        for (i, j), win in _oracle(e, d, u, ref).items():
            if win is None:
                assert np.isnan(r.elev[i, j]) and r.src[i, j] == 0
            else:
                assert r.src[i, j] == win + 1 and r.elev[i, j] == e[win, i, j]


def test_c2_implausible_elevations_become_holes_and_are_counted():
    # 1e30, an unlabeled -9999 m sentinel (= -32808 ft), +inf: all newer than a sane older source
    e = [[1e30, -32808.4, np.inf, 3.0]]
    older = [[2.0, 2.0, 2.0, 2.0]]
    r = merge_stack(np.array([e, older], np.float32).reshape(2, 1, 4),
                    np.array([[[19000] * 4], [[18000] * 4]], np.int32),
                    np.ones((2, 1, 4), np.float32), [1, 2], 20000)
    assert r.elev[0].tolist() == [2.0, 2.0, 2.0, 3.0]  # sentinels never win by date
    assert r.src[0].tolist() == [2, 2, 2, 1]
    assert r.implausible.tolist() == [3, 0] and r.covered.tolist() == [4, 4]
    only = _one([1e30], [19000], [1.0])
    assert np.isnan(only.elev.item()) and only.src.item() == 0 and only.implausible.tolist() == [1]


def test_c2_window_is_configurable_and_edges_inclusive():
    r = merge_stack(np.array([[[ELEV_MIN_FT, ELEV_MAX_FT, ELEV_MAX_FT + 0.01]]], np.float32),
                    np.full((1, 1, 3), 19000, np.int32), np.ones((1, 1, 3), np.float32), [1], 20000)
    assert r.src.ravel().tolist() == [1, 1, 0]
    r = merge_stack(np.full((1, 1, 1), 100.0, np.float32), np.full((1, 1, 1), 19000, np.int32),
                    np.ones((1, 1, 1), np.float32), [1], 20000, elev_max=50.0)
    assert r.src.item() == 0


def test_waterline_uncertainty_floor():
    out = _layer_unc(np.array([0.0, 0.2, 2.0, np.nan], np.float32), True)
    assert out[:3].tolist() == pytest.approx([0.3, 0.3, 1.0]) and np.isnan(out[3])
    assert _layer_unc(np.array([0.1], np.float32), False).tolist() == [pytest.approx(0.1)]


# =========================================================================== validate (C2, B1, B2, E17)
def _grid():
    return Grid(xmin=548000.0, ymax=5340000.0, ncols=400, nrows=400, res=2.0)


def test_b1_duplicate_points_in_one_cell_cannot_pass_the_sample_gate():
    grid = _grid()
    merged = np.full(grid.shape, -10.0, np.float32)
    lon, lat = utm10_to_lonlat(np.array([grid.xmin + 301.0]), np.array([grid.ymax - 301.0]))
    runs = [V.TruthPoints(np.repeat(lon, 10), np.repeat(lat, 10), np.full(10, -10.0), np.full(10, 1.0)) for _ in range(3)]
    r = V.validate(V.concat_truth(runs), grid, merged, np.full(grid.shape, 6, np.uint8), merged.copy(), None)
    wl = r.checks["waterline"]
    assert not wl["passed"] and wl["n_samples"] == 30 and wl["n_cells"] == 1
    assert "unique waterline cells" in wl["reason"]


def test_b1_load_run_csv_drops_duplicate_rows_nan_speed_and_handles_bom(tmp_path):
    p = tmp_path / "r.csv"
    p.write_text("﻿time,lat,lon,depth,speed,tide_ft\n"
                 "0,48.3,-122.5,10,3,\n0,48.3,-122.5,10,3,\n0,48.3,-122.5,10,3,\n"  # exact duplicates
                 "1,48.3,-122.5,10,nan,\n"  # NaN speed: `nan < 0.5` is False, must still be dropped
                 "2,48.3,-122.5,10,3,inf\n"  # non-finite tide
                 "3,48.3,-122.6,10,3,\n", encoding="utf-8")
    t = V.load_run_csv(p)
    assert len(t.lon) == 2 and t.lon.tolist() == [-122.5, -122.6]
    p.write_text("Time,Lat,Lon,Depth,Speed\n0,48.3,-122.5,10,3\n")  # header case is normalised
    assert len(V.load_run_csv(p).lon) == 1


def test_truth_points_length_mismatch_rejected():
    with pytest.raises(ValueError):
        V.TruthPoints(np.zeros(3), np.zeros(3), np.zeros(3), np.zeros(3), run_id=np.zeros(2, np.int64))
    with pytest.raises(ValueError):
        V.TruthPoints(np.zeros(3), np.zeros(2), np.zeros(3), np.zeros(3))


def test_e17_nan_comparisons_fail_closed():
    stats = {"n": 60, "n_cells": 60, "p90_abs": float("nan")}
    assert not V.evaluate_waterline(stats, [20, 20, 20], 3)["passed"]
    assert not V.evaluate_bias({"cudem": {"n": 50, "n_cells": 50, "bias": float("nan")}})["passed"]
    # old-style stats without unique-cell counts cannot satisfy the gate
    assert not V.evaluate_waterline({"n": 99, "p90_abs": 0.1}, [30, 30, 30], 3)["passed"]


def _shore(dem_fn, n=80):
    grid = _grid()
    dem = np.full(grid.shape, 8.0, np.float32)
    rows = np.arange(50, 50 + n)
    cols = np.full(n, 200)
    dem_fn(dem, rows, cols)
    lon, lat = utm10_to_lonlat(*grid.rowcol_to_xy(rows, cols))
    return grid, dem, lon, lat


def test_e17_shoreline_spikes_cannot_pull_a_low_dem_into_the_window():
    """The old 3x3 neighbourhood MAX turned an 8 ft shoreline with one 10 ft spike per patch into 10 ft."""
    def spikes(dem, rows, cols):
        dem[rows + 1, cols + 1] = 10.0

    grid, dem, lon, lat = _shore(spikes)
    chk = V.shoreline_datum_check(grid, dem, lon, lat, 10.0)
    assert not chk["passed"] and chk["median_ft"] == pytest.approx(8.0)


def test_b1_shoreline_counts_unique_cells():
    grid, dem, lon, lat = _shore(lambda d, r, c: d.fill(10.0), n=80)
    assert V.shoreline_datum_check(grid, dem, lon, lat, 10.0)["passed"]
    rep = V.shoreline_datum_check(grid, dem, np.repeat(lon[:1], 100), np.repeat(lat[:1], 100), 10.0)
    assert not rep["passed"] and rep["n"] == 1


def test_b2_dev_overrides_are_recorded_in_the_report():
    truth, grid, merged, src, wl = _build_case()
    r = V.validate(truth, grid, merged, src, wl, enforce_waterline=False)
    assert r.passed  # exit code stays 0 for dev runs ...
    d = r.to_dict()
    assert d["dev_overrides"] == ["skip-waterline-gate"] and d["gate"]["dev_overrides"] == ["skip-waterline-gate"]
    assert d["gate"]["checks"]["waterline"]["skipped"] is True  # ... but the report says so, and publish refuses it
    r.override("skip-shoreline-check")
    assert r.to_dict()["dev_overrides"] == ["skip-waterline-gate", "skip-shoreline-check"]


def test_c2_plausibility_check():
    ok = V.evaluate_plausibility({"sources": {"cudem": {"covered": 100000, "implausible": 50}}})
    assert ok["passed"] and ok["masked_total"] == 50  # 0.05 % <= 0.1 %
    bad = V.evaluate_plausibility({"sources": {"cudem": {"covered": 1000, "implausible": 600}}})
    assert not bad["passed"] and "cudem" in bad["offenders"]
    assert not V.evaluate_plausibility({"sources": {"x": {"covered": 0, "implausible": 3}}})["passed"]
    assert not V.evaluate_plausibility(None)["passed"] and not V.evaluate_plausibility({})["passed"]
    clean = V.evaluate_plausibility({"sources": {"cudem": {"covered": 10, "implausible": 0}}})
    assert clean["passed"] and clean["masked_total"] == 0


def test_report_json_has_no_nan_tokens():
    r = V.ValidationResult()
    r.per_source["merged"] = {"n": 0, "rmse": None, "p90_abs": float("nan"), "bias": None, "max_abs": None, "coverage": float("inf")}
    r._finalize()
    json.dumps(r.to_dict(), allow_nan=False)  # raises on NaN/inf tokens


def _build_case(n_pts=400):
    grid = _grid()
    rng = np.random.default_rng(0)
    flat = rng.choice(390 * 390, size=n_pts, replace=False)
    rows, cols = flat // 390 + 5, flat % 390 + 5
    lon, lat = utm10_to_lonlat(*grid.rowcol_to_xy(rows, cols))
    truth_elev = np.linspace(-5, 8, n_pts)
    merged = np.full(grid.shape, np.nan, np.float32)
    wl = merged.copy()
    merged[rows, cols] = truth_elev + 0.3
    wl[rows, cols] = truth_elev
    src = np.zeros(grid.shape, np.uint8)
    src[rows, cols] = 1
    truth = V.TruthPoints(lon, lat, truth_elev, np.full(n_pts, 4.0), run_id=np.arange(n_pts) % 3, n_runs=3)
    return truth, grid, merged, src, wl


def _full_passing_result():
    truth, grid, merged, src, wl = _build_case()
    decoded = tiles.decode_terrain_rgb(tiles.encode_terrain_rgb(merged))
    stats = {"sources": {"bluetopo": {"covered": 1000, "implausible": 0}}}
    r = V.validate(truth, grid, merged, src, wl, decoded, merge_stats=stats)
    r.add_check("shoreline_datum", True, "ok")
    return r


def test_b2_full_check_set_is_what_publish_requires(tmp_path):
    r = _full_passing_result()
    assert r.passed and set(REQUIRED_CHECKS) <= set(r.checks)
    report = {"aoi": "skagit", **r.to_dict()}
    _tree(tmp_path, report)
    publish.check_publish_gates("skagit", tmp_path, list((tmp_path / "skagit" / "tiles").glob("*.pmtiles")))


# =========================================================================== publish (B2-B4, E13-E16)
def _tree(root, report, aoi="skagit", tiles_extra=()):
    t = root / aoi / "tiles"
    m = root / aoi / "merge"
    v = root / aoi / "validate"
    for d in (t, m, v):
        d.mkdir(parents=True, exist_ok=True)
    for n in publish.MERGED_RASTERS:
        (m / n).write_bytes(b"m")
        os.utime(m / n, (1_700_000_000,) * 2)
    for n in ("depth.pmtiles", "base.pmtiles", "depth_meta.pmtiles", *tiles_extra):
        (t / n).write_bytes(b"t")
        os.utime(t / n, (1_700_000_100,) * 2)
    rp = v / "report.json"
    rp.write_text(report if isinstance(report, str) else json.dumps(report))
    os.utime(rp, (1_700_000_200,) * 2)
    return t


def _good():
    r = {"aoi": "skagit", "gate": {"passed": True, "reason": "ok", "dev_overrides": [],
                                   "checks": {n: {"passed": True, "reason": "ok"} for n in REQUIRED_CHECKS}}, "dev_overrides": []}
    return r


def _mut(fn):
    r = copy.deepcopy(_good())
    fn(r)
    return r


BAD_REPORTS = {
    "missing aoi": _mut(lambda r: r.pop("aoi")),
    "null aoi": _mut(lambda r: r.update(aoi=None)),
    "list aoi": _mut(lambda r: r.update(aoi=["skagit"])),
    "wrong-case aoi": _mut(lambda r: r.update(aoi="Skagit")),
    "other aoi": _mut(lambda r: r.update(aoi="nisqually")),
    "no gate": _mut(lambda r: r.pop("gate")),
    "gate list": _mut(lambda r: r.update(gate=[True])),
    "gate string": _mut(lambda r: r.update(gate="passed")),
    "gate null": _mut(lambda r: r.update(gate=None)),
    "passed string": _mut(lambda r: r["gate"].update(passed="true")),
    "passed 1": _mut(lambda r: r["gate"].update(passed=1)),
    "top-level dev override": _mut(lambda r: r.update(dev_overrides=["skip-waterline-gate"])),
    "gate-level dev override": _mut(lambda r: r["gate"].update(dev_overrides=["skip-shoreline-check"])),
    "skipped check": _mut(lambda r: r["gate"]["checks"]["waterline"].update(skipped=True)),
    "missing check": _mut(lambda r: r["gate"]["checks"].pop("shoreline_datum")),
    "failed check": _mut(lambda r: r["gate"]["checks"]["bias"].update(passed=False)),
    "extra failed check": _mut(lambda r: r["gate"]["checks"].update(extra={"passed": False})),
    "empty checks": _mut(lambda r: r["gate"].update(checks={})),
    "no checks": _mut(lambda r: r["gate"].pop("checks")),
    "checks list": _mut(lambda r: r["gate"].update(checks=[])),
    "report list": [1, 2],
    "report null": "null",
    "report string": '"ok"',
    "invalid json": "{nope",
}


@pytest.mark.parametrize("name", sorted(BAD_REPORTS))
def test_b2_b3_e15_malformed_or_overridden_reports_are_refused(tmp_path, name):
    t = _tree(tmp_path, BAD_REPORTS[name])
    with pytest.raises(publish.PublishRefused):  # never AttributeError/TypeError
        publish.check_publish_gates("skagit", tmp_path, list(t.glob("*.pmtiles")))


def test_good_report_baseline_is_accepted(tmp_path):
    t = _tree(tmp_path, _good())
    publish.check_publish_gates("skagit", tmp_path, list(t.glob("*.pmtiles")))


def test_e16_required_tiles_and_all_merged_rasters_gate(tmp_path):
    t = _tree(tmp_path, _good())
    (t / "base.pmtiles").unlink()
    with pytest.raises(FileNotFoundError, match="base.pmtiles"):
        publish.publish_aoi("skagit", tmp_path, _Store(), now=NOW, date_range=("2000-01-01", "2001-01-01"))
    t = _tree(tmp_path, _good())
    (t / "depth_meta.pmtiles").unlink()
    with pytest.raises(FileNotFoundError, match="depth_meta"):
        publish.publish_aoi("skagit", tmp_path, _Store(), now=NOW, date_range=("2000-01-01", "2001-01-01"))
    t = _tree(tmp_path, _good())
    newer = 1_700_000_150  # merged_unc rebuilt after the tiles, before the report
    os.utime(tmp_path / "skagit" / "merge" / "merged_unc.tif", (newer, newer))
    with pytest.raises(publish.PublishRefused, match="older than the merged rasters"):
        publish.check_publish_gates("skagit", tmp_path, list(t.glob("*.pmtiles")))
    (tmp_path / "skagit" / "merge" / "merged_date.tif").unlink()
    with pytest.raises(publish.PublishRefused, match="missing merge output"):
        publish.check_publish_gates("skagit", tmp_path, list(t.glob("*.pmtiles")))
    t = _tree(tmp_path, _good())
    (t / "depth.pmtiles").write_bytes(b"")
    with pytest.raises(publish.PublishRefused, match="zero-byte"):
        publish.publish_aoi("skagit", tmp_path, _Store(), now=NOW, date_range=("2000-01-01", "2001-01-01"))


class _Store:
    def __init__(self, index=None):
        self.index, self.events = index, []

    def upload_file(self, local, key):
        self.events.append(("up", key))

    def put_json(self, key, payload):
        self.events.append(("put", key))
        self.index = payload

    def get_json(self, key):
        return self.index


def test_land_pmtiles_is_uploaded_ungated_and_kept_out_of_the_index(tmp_path):
    t = _tree(tmp_path, _good(), tiles_extra=("land.pmtiles",))
    os.utime(t / "land.pmtiles", (1_700_000_900,) * 2)  # newer than the validation report: OSM land is not validated
    s = _Store()
    idx = publish.publish_aoi("skagit", tmp_path, s, version="2026-10-09T00:00:00Z", now=NOW,
                              date_range=("2000-01-01", "2001-01-01"))
    assert ("up", "tiles/skagit/2026-10-09T00:00:00Z/land.pmtiles") in s.events
    assert "land" not in json.dumps(idx)
    s2 = _Store()
    _tree(tmp_path, _good())  # no land file: simply not uploaded
    (tmp_path / "skagit" / "tiles" / "land.pmtiles").unlink()
    publish.publish_aoi("skagit", tmp_path, s2, version="2026-10-09T00:00:00Z", now=NOW, date_range=("2000-01-01", "2001-01-01"))
    assert not any("land" in k for _, k in s2.events)


class _Err(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        if code is not None:
            self.response = {"Error": {"Code": code}}


class _Body:
    def __init__(self, b):
        self.b = b

    def read(self):
        return self.b


class _C:
    def __init__(self, exc=None, body=b"{}"):
        self.exc, self.body = exc, body

    def get_object(self, Bucket, Key):  # noqa: N803 - boto3 signature
        if self.exc:
            raise self.exc
        return {"Body": _Body(self.body)}


def test_b4_get_json_only_treats_missing_key_as_none():
    get = lambda exc: publish.R2Store("b", client=_C(exc=exc)).get_json("tiles/index.json")  # noqa: E731
    assert get(_Err("x", "NoSuchKey")) is None and get(_Err("x", "404")) is None
    # AccessDenied whose request id contains "404", a hostname with 404, a bare message: all must raise
    for exc in (_Err("AccessDenied RequestId 8A4046F2", "AccessDenied"), _Err("InternalError req 140432", "InternalError"),
                _Err("Max retries host r2-1404.example"), _Err("An error occurred (404)")):
        with pytest.raises(Exception):  # noqa: B017 - the point is that nothing is swallowed
            get(exc)
    assert publish.R2Store("b", client=_C(body=b'{"aois": []}')).get_json("k") == {"aois": []}
    with pytest.raises(json.JSONDecodeError):
        publish.R2Store("b", client=_C(body=b"")).get_json("k")


def test_b4_malformed_or_unknown_existing_index_never_silently_wiped():
    entry = publish.build_aoi_entry("skagit", "2026-10-09T00:00:00Z", {"depth": 1}, ("2000-01-01", "2001-01-01"))
    for bad in ({"aois": "x"}, {"aois": [{"nope": 1}]}, {"aois": [None]}, [], "x", {}):
        with pytest.raises(ValueError, match="malformed"):
            publish.update_index(bad, entry, NOW)
    keep = {"updated_at": "x", "aois": [{"aoi": "mystery", "version": "v"}]}
    out = publish.update_index(keep, entry, NOW)
    assert [a["aoi"] for a in out["aois"]] == ["skagit", "mystery"]  # preserved, not dropped ...
    assert publish.validate_index(out)  # ... and the schema check then fails loudly
    assert publish.update_index(None, entry, NOW)["aois"] == [entry]


@pytest.mark.parametrize("v", ["2026-10-09T00:00:00Z\n", "2026-13-45T99:99:99Z", "../../x", "2026-10-09T00:00:00Z/../..", ""])
def test_e14_versions_are_validated_strictly(tmp_path, v):
    with pytest.raises(ValueError):
        publish.parse_version(v)
    _tree(tmp_path, _good())
    with pytest.raises(ValueError):
        publish.publish_aoi("skagit", tmp_path, _Store(), version=v, now=NOW, date_range=("2000-01-01", "2001-01-01"))


def test_prune_and_listing_ignore_stray_names():
    assert publish.versions_to_prune({"skagit": ["garbage", "tmp", "2025-01-01T00:00:00Z", "2025-06-01T00:00:00Z", "2026-10-09T00:00:00Z"]},
                                     {"skagit": "2026-10-09T00:00:00Z"}, NOW) == [("skagit", "2025-01-01T00:00:00Z")]

    class C:
        def list_objects_v2(self, **k):
            return {"CommonPrefixes": [{"Prefix": "tiles/skagit/2026-01-01T00:00:00Z/"}, {"Prefix": "tiles/skagit/tmp/"}]}

    assert publish.R2Store("b", client=C()).list_versions("skagit") == ["2026-01-01T00:00:00Z"]


def _tide(sid="9447130", **over):
    preds = [{"t": (NOW + dt.timedelta(minutes=30 * i)).strftime("%Y-%m-%dT%H:%M:%SZ"), "v": 1.0} for i in range(30 * 48 + 1)]
    d = {"station_id": sid, "name": "x", "datum": "MLLW", "units": "ft", "lat": 47.6, "lon": -122.3, "predictions": preds}
    d.update(over)
    return d


@pytest.mark.parametrize("over,msg", [
    ({"lat": None}, "lat/lon"), ({"lon": "x"}, "lat/lon"), ({"lat": float("nan")}, "lat/lon"), ({"lat": 123.0}, "lat/lon"),
    ({"lat": True}, "lat/lon"), ({"predictions": "nope"}, "predictions"), ({"predictions": []}, "predictions"),
    ({"predictions": [{"t": "2026-10-09T00:00:00Z"}]}, "malformed"),
    ({"predictions": [{"t": "2026-10-09T00:00:00Z", "v": float("nan")}]}, "malformed"),
    ({"predictions": [{"t": "garbage", "v": 1.0}]}, "malformed"), ({"predictions": [1, 2]}, "malformed"),
])
def test_e13_malformed_tide_files_rejected(tmp_path, over, msg):
    (tmp_path / "9447130.json").write_text(json.dumps(_tide(**over)))
    with pytest.raises(ValueError, match=msg):
        publish.load_tide_files(tmp_path, NOW)


def test_e13_unsorted_and_non_object_tide_files_rejected(tmp_path):
    d = _tide()
    d["predictions"][5], d["predictions"][6] = d["predictions"][6], d["predictions"][5]
    (tmp_path / "9447130.json").write_text(json.dumps(d))
    with pytest.raises(ValueError, match="time-ordered"):
        publish.load_tide_files(tmp_path, NOW)
    (tmp_path / "9447130.json").write_text("[1, 2]")
    with pytest.raises(ValueError, match="object"):
        publish.load_tide_files(tmp_path, NOW)
    (tmp_path / "9447130.json").write_text(json.dumps(_tide()))
    assert list(publish.load_tide_files(tmp_path, NOW)) == ["9447130"]


# =========================================================================== manifest (B5)
def _manifest(tmp_path):
    return Manifest(tmp_path / "fetch", "skagit", "fetch", lambda p: "EPSG:4269")


def test_b5_verify_detects_tampering_missing_and_empty(tmp_path):
    m = _manifest(tmp_path)
    (m.directory / "a").mkdir(parents=True)
    f = m.directory / "a" / "t.tif"
    f.write_bytes(b"AAAA")
    m.add_file(f, source_url="u", source="cudem")
    m.save()
    m2 = Manifest.load(m.directory, "skagit", "fetch", lambda p: "EPSG:4269")
    m2.verify()  # intact
    assert m2.is_intact(f)
    f.write_bytes(b"CORRUPT")
    with pytest.raises(ChecksumMismatch, match="differs"):
        m2.verify()
    assert not m2.is_intact(f)
    f.write_bytes(b"")
    with pytest.raises(ChecksumMismatch):
        m2.verify()
    f.unlink()
    with pytest.raises(ChecksumMismatch, match="missing"):
        m2.verify()
    m2.verify(kinds=["laz"])  # kind filter: nothing selected


def test_b5_manifest_of_another_aoi_or_step_is_rejected_and_save_is_atomic(tmp_path):
    m = _manifest(tmp_path)
    m.directory.mkdir(parents=True)
    m.save()
    assert not list(m.directory.glob("*.part"))
    with pytest.raises(ValueError, match="belongs to"):
        Manifest.load(m.directory, "nisqually", "fetch")
    with pytest.raises(ValueError, match="belongs to"):
        Manifest.load(m.directory, "skagit", "mllw")


def test_b5_cudem_rerun_redownloads_corrupt_and_zero_byte_files_but_skips_intact(tmp_path):
    tile = fb.TileRecord("a_2023v1.tif", "http://x/a_2023v1.tif", (-122.6, 48.2, -122.3, 48.5))
    calls = []

    def dl(url, dest):
        calls.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"GOOD")

    out = tmp_path / "skagit" / "fetch"
    crs = lambda p: "EPSG:4269"  # noqa: E731

    def run():
        m = Manifest.load(out, "skagit", "fetch", crs)
        fb.CudemFetcher(tile_index=[tile], download=dl).fetch(fb.AOIS["skagit"], out, m)
        m.save()
        return m

    run()
    assert len(calls) == 1
    run()
    assert len(calls) == 1  # intact: skipped
    f = out / "cudem" / "a_2023v1.tif"
    f.write_bytes(b"TRUNCATED")
    m = run()
    assert len(calls) == 2 and f.read_bytes() == b"GOOD"
    assert m.entries[0].sha256 == hashlib.sha256(b"GOOD").hexdigest()  # corrupt hash never recorded as truth
    f.write_bytes(b"")
    run()
    assert len(calls) == 3 and f.read_bytes() == b"GOOD"


def test_bluetopo_wrapper_matches_0_5_0_api(tmp_path):
    seen = {}

    def fake_main(project_dir, desired_area_filename=None, **kw):
        seen["dir"], seen["area"] = project_dir, desired_area_filename
        (tmp_path / "bt" / "BlueTopo").mkdir(parents=True, exist_ok=True)
        (tmp_path / "bt" / "BlueTopo" / "BC25M123.tiff").write_bytes(b"bt")
        return (["BC25M123"], [])

    m = Manifest(tmp_path / "bt", "skagit", "fetch", lambda p: "EPSG:32610")
    fb.BlueTopoFetcher(fetch_fn=fake_main).fetch(fb.AOIS["skagit"], tmp_path / "bt", m)
    assert os.path.isabs(seen["dir"]) and seen["area"].endswith("aoi.geojson")  # 0.5.0 requires an absolute project_dir
    assert m.entries[0].vertical_crs == "MLLW"
    failing = lambda d, **k: ([], ["BC25M999"])  # noqa: E731
    with pytest.raises(RuntimeError, match="BC25M999"):
        fb.BlueTopoFetcher(fetch_fn=failing).fetch(fb.AOIS["skagit"], tmp_path / "bt", m)


# =========================================================================== waterline (B6, E5)
def test_b6_non_finite_or_implausible_tide_raises():
    acc = W.WaterlineAccumulator((2, 2))
    g = np.full((2, 2), 0.3, np.float32)
    s = np.full((2, 2), 4, np.uint8)
    for bad in (float("nan"), float("inf"), -10.5, 20.5, -9999.0):
        with pytest.raises(ValueError, match="tide"):
            acc.update(g, g * 0.1, s, bad, 19000)
    acc.update(g, g * 0.1, s, 3.0, 19000)  # a sane tide still works afterwards
    with pytest.raises(ValueError):
        W.waterline_dem(np.stack([g] * 2), np.stack([g] * 2), np.stack([s] * 2), [1.0, float("nan")], [1, 2])


def test_e5_zero_width_bracket_is_masked():
    tides = [1.0, 2.0, 2.0, 3.0, 4.0, 5.0]  # a cell dry at 2.0 and wet at 2.0 (different scenes): bracket == 0
    z = np.array([[2.0]], np.float32)
    g, n, s = [], [], []
    for i, t in enumerate(tides):
        wet = (t > 2.0) or (i == 2)  # force the second 2.0 scene to read wet
        g.append(np.full(z.shape, 0.3 if wet else 0.1))
        n.append(np.full(z.shape, 0.05 if wet else 0.3))
        s.append(np.full(z.shape, 4, np.uint8))
    r = W.waterline_dem(np.stack(g).astype(np.float32), np.stack(n).astype(np.float32), np.stack(s), tides, list(range(6)))
    assert np.isnan(r.elev).all()


# =========================================================================== tiles (E1, E2, boundaries/land)
def test_e1_source_code_guard_runs_before_the_uint8_cast():
    for bad in (16, 255, 256, 257, -1):
        with pytest.raises(ValueError, match="0..15"):
            tiles.pack_source_date(np.array([[bad]], np.int64), np.array([[19000]], np.int32), np.array([[1.0]]))


def test_e2_negative_or_nonfinite_uncertainty_is_unknown_not_zero():
    idx = tiles.encode_unc_index(np.array([-1.0, -0.001, np.nan, np.inf, 0.0]))
    assert idx.tolist() == [15, 15, 15, 15, 0]


def test_boundaries_layer_is_added_to_base_only_when_the_input_exists(tmp_path):
    enc = {"DEPARE": [tmp_path / "a_DEPARE.geojson"], "COALNE": [tmp_path / "a_COALNE.geojson"]}
    assert tiles.BOUNDARIES_LAYER not in tiles.base_layers(enc, tmp_path / "missing.geojson")
    assert tiles.BOUNDARIES_LAYER not in tiles.base_layers(enc, None)
    b = tmp_path / "boundaries.geojson"
    b.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"region": "2E"}, "geometry": {"type": "LineString", "coordinates": [[-122.5, 48.3], [-122.4, 48.3]]}}]}))
    layers = tiles.base_layers(enc, b)
    assert layers[tiles.BOUNDARIES_LAYER] == b and "land" not in layers  # OSM never inside base (ODbL)
    cmd = tiles.tippecanoe_cmd(layers, tmp_path / "base.pmtiles", 8, 16)
    assert f"boundaries:{b}" in cmd
    b.write_text('{"type": "FeatureCollection", "features": []}')
    with pytest.raises(ValueError, match="non-empty"):
        tiles.base_layers(enc, b)
    b.write_text("[1]")
    with pytest.raises(ValueError):
        tiles.check_geojson(b)
    b.write_text("{bad")
    with pytest.raises(ValueError, match="not valid JSON"):
        tiles.check_geojson(b)


def test_osm_land_goes_to_its_own_pmtiles_by_convention(tmp_path):
    cmd = tiles.land_tippecanoe_cmd(tmp_path / "osm_land.geojson", tmp_path / "land.pmtiles")
    assert cmd[cmd.index("-o") + 1].endswith("land.pmtiles") and cmd.count("-L") == 1 and "land:" in " ".join(cmd)
    assert tiles.land_input("skagit", tmp_path).name == "osm_land.geojson"
    assert tiles.boundaries_input("skagit", tmp_path).name == "boundaries.geojson"


# =========================================================================== source_meta (E4), to_mllw (E19)
ELEV = np.ones((1, 1), np.float32)


@pytest.mark.parametrize("fn,arg", [
    (sm.lidar_meta, True), (sm.lidar_meta, 20140915), (sm.lidar_meta, 2014), (sm.lidar_meta, 1.5),
    (sm.lidar_meta, "2206-01-01"), (sm.lidar_meta, "1850-06-01"), (sm.lidar_meta, "1989-12-31"), (sm.lidar_meta, "garbage"),
    (sm.ehydro_meta, True), (sm.ehydro_meta, "2999-01-01"),
])
def test_e4_implausible_or_confused_manifest_dates_rejected(fn, arg):
    with pytest.raises(ValueError):
        fn(ELEV, arg)


def test_e4_cudem_version_year_validation():
    for bad in (True, "2023", 2023.0, 10000, 0, 1850, dt.date.today().year + 5):
        with pytest.raises(ValueError):
            sm.cudem_meta(ELEV, bad)
    assert sm.cudem_meta(ELEV, 2023)[0][0, 0] == days_since_epoch("2023-01-01")
    d = sm.lidar_meta(ELEV, "1990-01-01")[0][0, 0]
    assert d == days_since_epoch("1990-01-01")
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    assert sm.ehydro_meta(ELEV, tomorrow)[0][0, 0] == days_since_epoch(tomorrow)


def test_e4_table_values_bool_and_day_like_ints_rejected_but_old_surveys_allowed():
    ids = np.array([[1]])
    for bad in (True, 20140915, "2014-09", 0):
        with pytest.raises(ValueError):
            sm.dates_from_ids(ids, {1: bad})
    assert sm.dates_from_ids(ids, {1: "1887-01-01"}).item() == days_since_epoch("1887-01-01")  # CoNED bathymetry
    assert sm.dates_from_ids(ids, {1: 1950}).item() == days_since_epoch("1950-01-01")


def test_e4_bluetopo_negative_uncertainty_is_unknown():
    _, u = sm.bluetopo_meta(np.ones((1, 3), np.float32), np.array([[1, 1, 1]]), {1: "2014-09-15"}, np.array([[1.0, -2.0, np.inf]]))
    assert u[0, 0] > 0 and np.isnan(u[0, 1]) and np.isnan(u[0, 2])


def test_uncertainties_come_from_the_single_registry():
    from pipeline.common import SOURCES

    for name in ("lidar_2014", "lidar_ncmp", "wa_lidar"):
        assert sm.lidar_meta(ELEV, "2014-09-15", name)[1][0, 0] == SOURCES[name].unc_ft
    assert sm.ehydro_meta(ELEV, "2024-01-01")[1][0, 0] == SOURCES["ehydro"].unc_ft
    assert sm.cudem_meta(ELEV, 2023)[1][0, 0] == SOURCES["cudem"].unc_ft
    assert not any(hasattr(sm, n) for n in ("LIDAR_UNC_FT", "EHYDRO_UNC_FT", "CUDEM_UNC_FT"))


@pytest.mark.parametrize("units", ["M", "meters", "FT", "feet", "", None])
def test_e19_unknown_units_rejected(units):
    with pytest.raises(ValueError, match="units"):
        to_mllw.convert_array(np.array([1.0]), "MLLW", units)


# =========================================================================== geo (E9, E10)
def test_e9_nan_coordinates_never_alias_real_cells():
    g = Grid(0.0, 1000.0, 10, 10, 2.0)
    arr = np.arange(100, dtype=np.float64).reshape(10, 10)
    out = sample_grid(arr, g, np.array([np.nan, 1.0, np.inf, 1.0]), np.array([999.0, np.nan, 999.0, 999.0]))
    assert np.isnan(out[:3]).all() and out[3] == 0.0
    row, col = g.xy_to_rowcol(np.array([np.nan]), np.array([np.nan]))
    assert not g.contains_rowcol(row, col).any()


def test_e10_utm_range_is_enforced_but_nan_passes_through():
    for lon, lat in ((-123.0, 85.0), (-123.0, -90.0), (-60.0, 48.0), (10.0, 48.0)):
        with pytest.raises(ValueError):
            lonlat_to_utm10(lon, lat)
    x, y = lonlat_to_utm10(np.array([np.nan, -122.5]), np.array([48.0, 48.0]))
    assert np.isnan(x[0]) and np.isfinite(x[1])
    lonlat_to_utm10(-132.0, 60.0)  # edge of the allowed +-9 degrees


# =========================================================================== coops (E11), fetch_tides (E12)
def _t(h, day=1):
    return dt.datetime(2026, 10, day, h, tzinfo=UTC)


EV = [(_t(0), 0.0), (_t(6), 10.0), (_t(12), 0.0), (_t(18), 10.0)]


def test_e11_unsorted_events_raise_instead_of_silently_misbehaving():
    with pytest.raises(ValueError, match="out of order"):
        coops.cosine_interpolate([EV[2], EV[0], EV[3], EV[1]], _t(3))


def test_e11_duplicates_collapse_but_conflicts_raise():
    dup = [EV[0], EV[1], EV[1], EV[2]]
    assert coops.cosine_interpolate(dup, _t(9)) == pytest.approx(coops.cosine_interpolate(EV, _t(9)))
    with pytest.raises(ValueError, match="conflicting"):
        coops.cosine_interpolate([EV[0], (_t(6), 10.0), (_t(6), 9.0), EV[2]], _t(3))


def test_e11_non_finite_values_and_naive_datetimes_raise():
    with pytest.raises(ValueError, match="non-finite"):
        coops.cosine_interpolate([(_t(0), float("nan")), (_t(6), 1.0)], _t(3))
    with pytest.raises(ValueError, match="timezone"):
        coops.cosine_interpolate(EV, dt.datetime(2026, 10, 1, 3))
    with pytest.raises(ValueError, match="timezone"):
        coops.normalize_events([(dt.datetime(2026, 10, 1), 1.0)])


def test_e11_missing_event_gap_guard():
    gap = [(_t(0), 0.0), (_t(6), 10.0), (_t(18), 10.0)]  # the low in between was dropped
    assert coops.cosine_interpolate(gap, _t(3)) > 0  # a bracket below the limit is fine
    with pytest.raises(ValueError, match="more than"):
        coops.cosine_interpolate(gap, _t(12))
    with pytest.raises(ValueError, match="more than"):
        coops.cosine_interpolate([(_t(0), 0.0), (_t(0, 5), 10.0)], _t(0, 3))


def test_e11_densify_rejects_non_positive_step_instead_of_hanging():
    for step in (0, -15):
        with pytest.raises(ValueError, match="step_min"):
            coops.densify(EV, _t(0), _t(6), step)


def test_e11_nearest_station_rejects_nan():
    with pytest.raises(ValueError):
        coops.nearest_station(float("nan"), 48.0, coops.REFERENCE_STATIONS)


def test_e12_one_failing_station_does_not_abort_the_rest(tmp_path):
    def getter(url):
        if "mdapi" in url:
            return json.dumps({"stations": [{"id": "9447130", "lat": 47.6, "lng": -122.3},
                                            {"id": "9444900", "lat": 48.1, "lng": -122.7}]}).encode()
        if "9444900" in url:
            return json.dumps({"error": {"message": "No Predictions data was found"}}).encode()
        rows = [{"t": (dt.datetime(2026, 10, 1, tzinfo=UTC) + i * dt.timedelta(hours=6)).strftime("%Y-%m-%d %H:%M"),
                 "v": "9.0" if i % 2 == 0 else "-1.0"} for i in range(0, 4 * 12)]
        return json.dumps({"predictions": rows}).encode()

    failures = []
    written = fetch_tides.fetch_all(tmp_path, now=dt.datetime(2026, 10, 2, tzinfo=UTC), days=3,
                                    stations=coops.REFERENCE_STATIONS[:2], http_get=getter, failures=failures)
    assert [p.name for p in written] == ["9447130.json"]
    assert len(failures) == 1 and failures[0][0] == "9444900" and "No Predictions" in failures[0][1]
    assert not list(tmp_path.glob("*.part"))


def test_e12_main_exits_nonzero_listing_failures(monkeypatch, capsys, tmp_path):
    def fake(out, *, failures=None, **kw):
        failures.append(("9444900", "boom"))
        return [tmp_path / "x.json"]

    monkeypatch.setattr(fetch_tides, "fetch_all", fake)
    assert fetch_tides.main(["--out", str(tmp_path)]) == 1
    assert "FAILED 9444900: boom" in capsys.readouterr().err
    monkeypatch.setattr(fetch_tides, "fetch_all", lambda out, **kw: [tmp_path / "x.json"])
    assert fetch_tides.main(["--out", str(tmp_path)]) == 0


# =========================================================================== redundancy removals / constants
def test_dead_code_removed_and_single_iso_format():
    from pipeline import align, common

    for name in ("WORK_EPSG", "default_data_dir", "chunks"):
        assert not hasattr(common, name)
    assert "categorical" not in align.RESAMPLING
    assert not hasattr(V, "expected_shoreline_window")
    assert not hasattr(publish, "ISO_FORMAT_LOCAL") and publish.iso_z is common_iso_z()
    assert common_iso_z()(NOW) == "2026-10-09T00:00:00Z"
    assert publish.parse_version("2026-10-09T00:00:00Z") == NOW


def common_iso_z():
    from pipeline.common import iso_z

    return iso_z
