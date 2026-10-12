"""Tests for the two server-feeding producers: load_baseline (baseline_cells) and fleet_tiles (FLT-6)."""

import copy
import datetime as dt
import json
import os
from pathlib import Path

import numpy as np
import pytest

from pipeline import fleet_tiles as F
from pipeline import load_baseline as LB
from pipeline import publish, tiles
from pipeline.common import DATE_NODATA, REQUIRED_CHECKS, ZOOMS, days_since_epoch
from pipeline.geo import Grid, lonlat_to_utm10, utm10_to_lonlat
from pipeline.supabase_rest import SupabaseError, SupabaseRest, batched

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 9, 12, tzinfo=UTC)
TODAY = NOW.date()


# ----------------------------------------------------------------------------- fake H3 (10 m square cells)
_DLAT = 10.0 / 111_320.0
_DLON = 10.0 / (111_320.0 * np.cos(np.radians(48.3)))


def fake_latlng_to_cell(lat, lon):
    i, j = int(np.floor((lat + 90.0) / _DLAT)), int(np.floor((lon + 180.0) / _DLON))
    return f"8c{i:06x}{j:07x}"


def fake_cell_to_latlng(cell):
    i, j = int(cell[2:8], 16), int(cell[8:], 16)
    return ((i + 0.5) * _DLAT - 90.0, (j + 0.5) * _DLON - 180.0)


def make_grid(n=400):
    return Grid(xmin=548000.0, ymax=5340000.0, ncols=n, nrows=n, res=2.0)


# ----------------------------------------------------------------------------- fake HTTP transport
class FakeHttp:
    def __init__(self, status=200, pages=None):
        self.calls, self.status, self.pages = [], status, list(pages or [])

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), body))
        if method == "GET":
            return self.status, json.dumps(self.pages.pop(0) if self.pages else []).encode()
        return self.status, b""


KEY = "service-role-secret-key"


def client(http):
    return SupabaseRest("https://proj.supabase.co", KEY, http)


# ============================================================================= supabase_rest
def test_batched_slices():
    assert [len(c) for c in batched(list(range(2500)), 1000)] == [1000, 1000, 500]
    assert list(batched([], 1000)) == []
    with pytest.raises(ValueError):
        list(batched([1], 0))


def test_upsert_posts_batches_with_on_conflict_and_auth_headers():
    http = FakeHttp()
    rows = [{"cell_id": f"8c{i:013x}", "baseline_elev_ft": -1.0, "source_date": None} for i in range(2500)]
    assert client(http).upsert("baseline_cells", rows, on_conflict="cell_id") == 2500
    assert [m for m, *_ in http.calls] == ["POST"] * 3
    method, url, headers, body = http.calls[0]
    assert url == "https://proj.supabase.co/rest/v1/baseline_cells?on_conflict=cell_id"
    assert headers["apikey"] == KEY and headers["Authorization"] == f"Bearer {KEY}"
    assert "resolution=merge-duplicates" in headers["Prefer"]
    assert len(json.loads(body)) == 1000 and len(json.loads(http.calls[2][3])) == 500


def test_errors_never_leak_the_key_and_nan_is_refused():
    with pytest.raises(SupabaseError) as e:
        client(FakeHttp(status=401)).upsert("baseline_cells", [{"cell_id": "x"}], on_conflict="cell_id")
    assert "401" in str(e.value) and KEY not in str(e.value)
    with pytest.raises(ValueError):
        client(FakeHttp()).upsert("baseline_cells", [{"v": float("nan")}], on_conflict="cell_id")


def test_select_all_pages_until_short_page():
    http = FakeHttp(pages=[[{"a": 1}, {"a": 2}], [{"a": 3}, {"a": 4}], [{"a": 5}]])
    rows = client(http).select_all("depth_cells", [("boats", "gte.3")], page_size=2)
    assert [r["a"] for r in rows] == [1, 2, 3, 4, 5] and len(http.calls) == 3
    assert "boats=gte.3" in http.calls[0][1] and "offset=2" in http.calls[1][1] and "limit=2" in http.calls[0][1]
    assert http.calls[0][0] == "GET"


def test_client_construction_rules():
    with pytest.raises(ValueError, match="https"):
        SupabaseRest("http://x", KEY)
    with pytest.raises(ValueError):
        SupabaseRest("https://x", "")
    with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_ROLE_KEY"):
        SupabaseRest.from_env({"SUPABASE_URL": "https://x"})
    assert SupabaseRest.from_env({"SUPABASE_URL": "https://x", "SUPABASE_SERVICE_ROLE_KEY": "k"}) is not None


# ============================================================================= load_baseline
def baseline_world():
    grid = make_grid()
    elev = np.full(grid.shape, -12.0, np.float32)  # 12 ft of water: stored NEGATIVE (elevation, positive up)
    elev[:, 300:] = np.nan  # no-data strip
    elev[100:140, 100:140] = 3.5  # a bar that dries
    date = np.full(grid.shape, days_since_epoch("2023-06-01"), np.int32)
    date[:, :50] = DATE_NODATA
    return grid, elev, date


def brute_force_cells(grid, elev):
    """Every fake cell whose centre lies on a valid pixel (independent of the stride logic)."""
    lon0, lat0 = utm10_to_lonlat(np.array([grid.xmin, grid.xmax]), np.array([grid.ymin, grid.ymax]))
    out = set()
    i0, i1 = int((lat0.min() + 90) / _DLAT) - 1, int((lat0.max() + 90) / _DLAT) + 2
    j0, j1 = int((lon0.min() + 180) / _DLON) - 1, int((lon0.max() + 180) / _DLON) + 2
    for i in range(i0, i1):
        for j in range(j0, j1):
            cell = f"8c{i:06x}{j:07x}"
            lat, lon = fake_cell_to_latlng(cell)
            x, y = lonlat_to_utm10(lon, lat)
            r, c = grid.xy_to_rowcol(x, y)
            if grid.contains_rowcol(r, c) and np.isfinite(elev[r, c]):
                out.add(cell)
    return out


def test_baseline_rows_cover_exactly_the_valid_cells_with_unchanged_elevation_sign():
    grid, elev, date = baseline_world()
    rows = LB.build_rows(grid, elev, date, fake_latlng_to_cell, fake_cell_to_latlng)
    ids = [r.cell_id for r in rows]
    assert len(ids) == len(set(ids)) and set(ids) == brute_force_cells(grid, elev)
    by = {r.cell_id: r for r in rows}
    # sample one cell in open water and one on the dry bar: values are merged_elev as-is (NOT negated)
    wet = next(r for r in rows if r.baseline_elev_ft == -12.0)
    dry = next(r for r in rows if r.baseline_elev_ft == 3.5)
    assert wet.source_date in ("2023-06-01", None) and dry.cell_id in by
    assert all(LB.H3_CELL_RE.match(i) for i in ids)


def test_baseline_dates_nodata_becomes_null_and_off_grid_or_hole_cells_are_skipped():
    grid, elev, date = baseline_world()
    rows = {r.cell_id: r for r in LB.build_rows(grid, elev, date, fake_latlng_to_cell, fake_cell_to_latlng)}
    dated = [r for r in rows.values() if r.source_date == "2023-06-01"]
    undated = [r for r in rows.values() if r.source_date is None]
    assert dated and undated  # the NODATA strip yields cells with a null source_date
    # centre in the no-data strip -> skipped; centre off the grid -> skipped
    x, y = grid.rowcol_to_xy(np.array([200]), np.array([350]))
    lon, lat = utm10_to_lonlat(x, y)
    hole_cell = fake_latlng_to_cell(float(lat[0]), float(lon[0]))
    far_cell = fake_latlng_to_cell(40.0, -120.0)
    assert LB.sample_cells(grid, elev, date, [hole_cell, far_cell], fake_cell_to_latlng) == []


def test_baseline_range_constraint_and_bad_ids():
    grid, elev, date = baseline_world()
    elev2 = elev.copy()
    elev2[:] = 5000.0  # violates baseline_cells_range (-2000..2000)
    cells = [fake_latlng_to_cell(*utm_to_latlng(grid, 200, 200))]
    assert LB.sample_cells(grid, elev2, date, cells, fake_cell_to_latlng) == []
    with pytest.raises(ValueError, match="H3 resolution-12"):
        LB.sample_cells(grid, elev, date, ["not-a-cell"], fake_cell_to_latlng)
    assert LB.sample_cells(grid, elev, None, [], fake_cell_to_latlng) == []
    r = LB.sample_cells(grid, elev, None, cells, fake_cell_to_latlng)[0]
    assert r.source_date is None


def utm_to_latlng(grid, row, col):
    x, y = grid.rowcol_to_xy(np.array([row]), np.array([col]))
    lon, lat = utm10_to_lonlat(x, y)
    return float(lat[0]), float(lon[0])


def test_baseline_upload_uses_the_documented_columns_and_1000_row_batches():
    grid, elev, date = baseline_world()
    rows = LB.build_rows(grid, elev, date, fake_latlng_to_cell, fake_cell_to_latlng)
    assert len(rows) > 2000  # enough for several batches
    http = FakeHttp()
    n = client(http).upsert("baseline_cells", [r.to_json() for r in rows], on_conflict="cell_id")
    assert n == len(rows) and len(http.calls) == -(-len(rows) // 1000)
    body = json.loads(http.calls[0][3])
    assert set(body[0]) == {"cell_id", "baseline_elev_ft", "source_date"} and len(body) == 1000
    assert "on_conflict=cell_id" in http.calls[0][1] and "/baseline_cells?" in http.calls[0][1]


def test_candidate_stride_visits_every_cell_even_on_sparse_lattice():
    grid, elev, _ = baseline_world()
    lon, lat = LB.candidate_points(grid, np.isfinite(elev), stride_px=4)
    assert len(lon) < np.isfinite(elev).sum() / 5
    found = set(LB.cells_from_points(lon, lat, fake_latlng_to_cell))
    # every brute-force cell must be reachable from at least one lattice point
    assert brute_force_cells(grid, elev) <= found | set()


def test_h3_import_is_lazy_and_missing_h3_gives_a_clear_error():
    try:
        import h3  # noqa: F401
    except ImportError:
        with pytest.raises(ImportError):
            LB.h3_functions()


def test_load_baseline_refuses_without_a_passing_validation_report(tmp_path):
    with pytest.raises(publish.PublishRefused, match="missing"):
        LB.run("skagit", tmp_path, None, dry_run=True)
    vdir = tmp_path / "skagit" / "validate"
    mdir = tmp_path / "skagit" / "merge"
    vdir.mkdir(parents=True)
    mdir.mkdir(parents=True)
    report = {"aoi": "skagit", "dev_overrides": [], "gate": {"passed": True, "dev_overrides": [],
                                                              "checks": {n: {"passed": True} for n in REQUIRED_CHECKS}}}
    (vdir / "report.json").write_text(json.dumps(report))
    for n in publish.MERGED_RASTERS:
        (mdir / n).write_bytes(b"m")
    os.utime(vdir / "report.json", (1_700_000_000,) * 2)
    for n in publish.MERGED_RASTERS:
        os.utime(mdir / n, (1_700_000_500,) * 2)  # re-merged after validation
    with pytest.raises(publish.PublishRefused, match="newer than the validation report"):
        LB.run("skagit", tmp_path, None, dry_run=True)
    report["gate"]["passed"] = False
    (vdir / "report.json").write_text(json.dumps(report))
    with pytest.raises(publish.PublishRefused, match="did not pass"):
        LB.run("skagit", tmp_path, None, dry_run=True)


# ============================================================================= fleet: publication rule
def row(cell, day, boats, med=12.0, n=50):
    return {"cell_id": cell, "day": day.isoformat() if hasattr(day, "isoformat") else day, "median_ft": med, "n": n, "boats": boats}


def cell_at(grid, r, c):
    return fake_latlng_to_cell(*utm_to_latlng(grid, r, c))


def test_cells_with_fewer_than_three_boats_are_never_published():
    grid = make_grid()
    a, b, c = cell_at(grid, 100, 100), cell_at(grid, 100, 200), cell_at(grid, 100, 300)
    rows = [row(a, TODAY, 2), row(b, TODAY, 3), row(c, TODAY - dt.timedelta(days=1), 2),
            row(c, TODAY - dt.timedelta(days=2), 2)]  # two boats on each of two days is STILL two boats
    kept, dropped = F.published_rows(rows, TODAY)
    assert [r["cell_id"] for r in kept] == [b] and dropped == 3
    fr, stats = F.build_fleet(rows, grid, TODAY, fake_cell_to_latlng)
    assert stats["cells"] == 1
    for cell in (a, c):  # no pixel anywhere near the unpublished cells
        r_, c_ = grid.xy_to_rowcol(*lonlat_to_utm10(*fake_cell_to_latlng(cell)[::-1]))
        assert np.isnan(fr.elev_ft[r_ - 6:r_ + 7, c_ - 6:c_ + 7]).all() and (fr.boats[r_ - 6:r_ + 7, c_ - 6:c_ + 7] == 0).all()
    r_, c_ = grid.xy_to_rowcol(*lonlat_to_utm10(*fake_cell_to_latlng(b)[::-1]))
    assert np.isfinite(fr.elev_ft[r_, c_]) and fr.boats[r_, c_] == 3


def test_published_rows_window_and_malformed_rows():
    cell = "8c" + "0" * 13
    ok = lambda **kw: F.published_rows([{**row(cell, TODAY, 3), **kw}], TODAY)[0]  # noqa: E731
    assert ok() and ok(day=(TODAY - dt.timedelta(days=90)).isoformat())
    assert not ok(day=(TODAY - dt.timedelta(days=91)).isoformat())
    assert not ok(day=(TODAY + dt.timedelta(days=1)).isoformat())  # future
    assert not ok(boats=2) and not ok(boats=True) and not ok(boats="3") and not ok(boats=None)
    assert not ok(cell_id="8c123") and not ok(cell_id=None)
    assert not ok(median_ft=float("nan")) and not ok(median_ft=5000.0) and not ok(median_ft="12")
    assert not ok(n=0) and not ok(day="garbage")
    assert F.published_rows([{"cell_id": cell}], TODAY) == ([], 1)  # missing columns
    assert F.published_rows([], TODAY, min_boats=1) == ([], 0)


def test_aggregation_weighted_median_max_boats_newest_day():
    cell = "8c" + "1" * 13
    d1, d2, d3 = TODAY - dt.timedelta(days=5), TODAY - dt.timedelta(days=2), TODAY
    rows, _ = F.published_rows([row(cell, d1, 3, 10.0, 10), row(cell, d2, 5, 14.0, 100), row(cell, d3, 4, 20.0, 10)], TODAY)
    (agg,) = F.aggregate_cells(rows)
    assert agg.depth_ft == 14.0  # n-weighted: the 100-sounding day dominates
    assert agg.boats == 5 and agg.n == 120 and agg.day == days_since_epoch(d3)
    assert F.weighted_median([1.0, 2.0], [1, 1]) == 1.0 and F.weighted_median([5.0], [3]) == 5.0


# ============================================================================= fleet: raster / encoding
def test_depth_is_negated_to_elevation_and_decodes_like_the_depth_layer():
    grid = make_grid()
    wet, dry = cell_at(grid, 100, 100), cell_at(grid, 100, 250)
    rows = [row(wet, TODAY, 4, med=12.0), row(dry, TODAY, 3, med=-2.0)]  # 12 ft of water; a drying cell at depth -2
    fr, _ = F.build_fleet(rows, grid, TODAY, fake_cell_to_latlng)
    dec = tiles.decode_terrain_rgb(fr.rgb)
    rw, cw = grid.xy_to_rowcol(*lonlat_to_utm10(*fake_cell_to_latlng(wet)[::-1]))
    rd, cd = grid.xy_to_rowcol(*lonlat_to_utm10(*fake_cell_to_latlng(dry)[::-1]))
    assert dec[rw, cw] == pytest.approx(-12.0, abs=0.05)  # same sign convention as depth.pmtiles
    assert dec[rd, cd] == pytest.approx(2.0, abs=0.05)
    assert np.isnan(dec[0, 0]) and (fr.rgb[0, 0] == 0).all()


def test_meta_band_carries_boats_and_newest_day():
    grid = make_grid()
    cell = cell_at(grid, 150, 150)
    day = TODAY - dt.timedelta(days=3)
    fr, _ = F.build_fleet([row(cell, day, 7)], grid, TODAY, fake_cell_to_latlng)
    u = tiles.unpack_fleet_meta(fr.meta)
    r_, c_ = grid.xy_to_rowcol(*lonlat_to_utm10(*fake_cell_to_latlng(cell)[::-1]))
    assert u["valid"][r_, c_] and u["boats"][r_, c_] == 7 and u["day"][r_, c_] == days_since_epoch(day)
    assert not u["valid"][0, 0] and u["day"][0, 0] == DATE_NODATA and fr.meta[0, 0].tolist() == [0, 0, 0, 0]


def test_footprint_is_a_disc_clipped_at_the_grid_edge_and_off_grid_cells_are_ignored():
    grid = make_grid(60)
    cell = F.FleetCell("8c" + "2" * 13, 10.0, 3, 5, 20000)
    centre = utm10_to_lonlat(*grid.rowcol_to_xy(np.array([30]), np.array([30])))
    fr = F.rasterize_cells(grid, [cell], np.array([[centre[0][0], centre[1][0]]]))
    painted = np.argwhere(np.isfinite(fr.elev_ft))
    d = np.hypot(painted[:, 0] - 30, painted[:, 1] - 30) * grid.res
    assert fr.n_pixels == len(painted) and 40 < len(painted) < 120 and d.max() <= F.FOOTPRINT_RADIUS_M + 2.0
    edge = utm10_to_lonlat(*grid.rowcol_to_xy(np.array([0]), np.array([0])))
    fr2 = F.rasterize_cells(grid, [cell], np.array([[edge[0][0], edge[1][0]]]))
    assert 0 < fr2.n_pixels < fr.n_pixels  # clipped, no crash
    off = F.rasterize_cells(grid, [cell], np.array([[-120.0, 40.0 + 8.0]]))
    assert off.n_cells == 0 and off.n_pixels == 0
    with pytest.raises(ValueError):
        F.rasterize_cells(grid, [cell], np.zeros((0, 2)))


def test_overlap_resolves_to_the_later_cell_deterministically():
    grid = make_grid(60)
    x, y = grid.rowcol_to_xy(np.array([30, 30]), np.array([30, 31]))
    lon, lat = utm10_to_lonlat(x, y)
    cells = [F.FleetCell("8c" + "0" * 13, 5.0, 3, 1, 20000), F.FleetCell("8c" + "0" * 12 + "1", 9.0, 4, 1, 20001)]
    fr = F.rasterize_cells(grid, cells, np.stack([lon, lat], axis=1))
    assert fr.elev_ft[30, 31] == pytest.approx(-9.0) and fr.boats[30, 31] == 4  # second cell wins its own centre


def test_fleet_meta_pack_roundtrip_clamp_and_zoom_mapping():
    boats = np.array([[3, 300, 0]])
    day = np.array([[days_since_epoch("2026-10-01"), days_since_epoch("2026-10-02"), DATE_NODATA]], np.int32)
    p = tiles.pack_fleet_meta(boats, day)
    u = tiles.unpack_fleet_meta(p)
    assert u["boats"].tolist() == [[3, 255, 0]] and u["valid"].tolist() == [[True, True, False]]
    assert u["day"][0, 0] == days_since_epoch("2026-10-01") and (p[0, 2] == 0).all()
    cmds = tiles.raster_pmtiles_cmds("a.tif", "work", "fleet_meta.pmtiles", "fleet_meta")
    assert f"MINZOOM={ZOOMS['fleet'][0]}" in cmds[1] and f"MAXZOOM={ZOOMS['fleet'][1]}" in cmds[1]
    assert ZOOMS["fleet"] == (10, 16)


# ============================================================================= fleet: REST fetch + publish
def test_fetch_rows_filters_server_side_and_orders():
    http = FakeHttp(pages=[[row("8c" + "0" * 13, TODAY, 3)]])
    rows = F.fetch_rows(client(http), TODAY)
    url = http.calls[0][1]
    assert "/rest/v1/depth_cells?" in url and "boats=gte.3" in url and f"day=gte.{TODAY - dt.timedelta(days=90)}" in url
    assert "order=cell_id.asc%2Cday.asc" in url and len(rows) == 1


class Store:
    def __init__(self, index=None):
        self.index, self.events = index, []

    def upload_file(self, local, key):
        self.events.append(("up", key))

    def put_json(self, key, payload):
        self.events.append(("put", key))
        self.index = payload

    def get_json(self, key):
        return self.index


def live_index(aoi="skagit", version="2026-10-01T00:00:00Z"):
    def entry(a, v):
        return {"aoi": a, "version": v, "merged_date_range": ["2014-01-01", "2026-09-01"],
                "files": {k: {"path": f"tiles/{a}/{v}/{k}.pmtiles", "bytes": 5 if k != "fleet" else 0}
                          for k in ("base", "depth", "waterline", "fleet")}}
    return {"updated_at": "2026-10-01T00:00:00Z", "aois": [entry(aoi, version), entry("nisqually", "2026-09-15T00:00:00Z")]}


def test_publish_fleet_updates_only_the_fleet_entry_under_the_current_version(tmp_path):
    (tmp_path / "fleet.pmtiles").write_bytes(b"f" * 77)
    (tmp_path / "fleet_meta.pmtiles").write_bytes(b"m" * 9)
    live = live_index()
    before = copy.deepcopy(live)
    s = Store(live)
    idx = publish.publish_fleet("skagit", tmp_path, s, now=NOW)
    assert s.events == [("up", "tiles/skagit/2026-10-01T00:00:00Z/fleet.pmtiles"),
                        ("up", "tiles/skagit/2026-10-01T00:00:00Z/fleet_meta.pmtiles"), ("put", "tiles/index.json")]
    sk = idx["aois"][0]
    assert sk["files"]["fleet"] == {"path": "tiles/skagit/2026-10-01T00:00:00Z/fleet.pmtiles", "bytes": 77}
    assert sk["files"]["depth"] == before["aois"][0]["files"]["depth"] and sk["version"] == "2026-10-01T00:00:00Z"
    assert idx["aois"][1] == before["aois"][1] and idx["updated_at"] == "2026-10-09T12:00:00Z"
    assert publish.validate_index(idx) == []


def test_publish_fleet_without_tiles_sets_bytes_zero_and_uploads_nothing(tmp_path):
    live = live_index()
    live["aois"][0]["files"]["fleet"]["bytes"] = 123
    s = Store(live)
    idx = publish.publish_fleet("skagit", tmp_path, s, now=NOW)
    assert idx["aois"][0]["files"]["fleet"]["bytes"] == 0 and s.events == [("put", "tiles/index.json")]


def test_publish_fleet_refusals(tmp_path):
    with pytest.raises(publish.PublishRefused, match="no live"):
        publish.publish_fleet("skagit", tmp_path, Store(None), now=NOW)
    with pytest.raises(publish.PublishRefused, match="not in the live index"):
        publish.publish_fleet("padilla_samish", tmp_path, Store(live_index()), now=NOW)
    with pytest.raises(ValueError, match="malformed"):
        publish.publish_fleet("skagit", tmp_path, Store({"aois": "x"}), now=NOW)
    bad = live_index(version="2026-10-01T00:00:00Z\n")
    with pytest.raises(ValueError):
        publish.publish_fleet("skagit", tmp_path, Store(bad), now=NOW)
    (tmp_path / "fleet.pmtiles").write_bytes(b"f")
    with pytest.raises(publish.PublishRefused, match="fleet_meta"):
        publish.publish_fleet("skagit", tmp_path, Store(live_index()), now=NOW)
    (tmp_path / "fleet_meta.pmtiles").write_bytes(b"")
    with pytest.raises(publish.PublishRefused, match="zero-byte"):
        publish.publish_fleet("skagit", tmp_path, Store(live_index()), now=NOW)
    s = Store(live_index())
    assert s.events == []


# ============================================================================= fleet: orchestration with fakes
def setup_run_dir(tmp_path, grid):
    d = tmp_path / "skagit" / "align"
    d.mkdir(parents=True)
    (d / "grid.json").write_text(json.dumps(grid.to_dict()))


def test_run_end_to_end_builds_tiles_and_publishes_under_current_version(tmp_path, monkeypatch):
    grid = make_grid()
    setup_run_dir(tmp_path, grid)
    good, two = cell_at(grid, 120, 120), cell_at(grid, 120, 220)
    http = FakeHttp(pages=[[row(good, TODAY, 3), row(two, TODAY, 2)]])  # the boats=2 row slips through the server filter
    written = []
    monkeypatch.setattr(tiles, "write_rgb_geotiff", lambda path, arr, ref: written.append((Path(path).name, arr.shape)))
    cmds = []

    def fake_cmd(cmd):
        cmds.append(cmd[0])
        if cmd[0] == "pmtiles":
            Path(cmd[-1]).write_bytes(b"pm" * 10)

    s = Store(live_index())
    stats = F.run("skagit", tmp_path, client(http), s, today=TODAY, now=NOW, cell_to_latlng=fake_cell_to_latlng, run_cmd=fake_cmd)
    assert stats["rows_in"] == 2 and stats["rows_published"] == 1 and stats["cells"] == 1
    assert [w[0] for w in written] == ["fleet_rgb.tif", "fleet_meta_rgb.tif"] and written[0][1] == (*grid.shape, 3) and written[1][1] == (*grid.shape, 4)
    assert cmds.count("gdalwarp") == 2 and cmds.count("pmtiles") == 2
    assert ("up", "tiles/skagit/2026-10-01T00:00:00Z/fleet.pmtiles") in s.events and s.events[-1] == ("put", "tiles/index.json")
    assert s.index["aois"][0]["files"]["fleet"]["bytes"] == 20


def test_run_with_only_unpublishable_cells_builds_nothing_and_zeroes_the_index_entry(tmp_path, monkeypatch):
    grid = make_grid()
    setup_run_dir(tmp_path, grid)
    (tmp_path / "skagit" / "tiles").mkdir(parents=True)
    (tmp_path / "skagit" / "tiles" / "fleet.pmtiles").write_bytes(b"old")  # last night's tile must not survive
    (tmp_path / "skagit" / "tiles" / "fleet_meta.pmtiles").write_bytes(b"old")
    http = FakeHttp(pages=[[row(cell_at(grid, 100, 100), TODAY, 2)]])
    monkeypatch.setattr(tiles, "write_rgb_geotiff", lambda *a: pytest.fail("no tiles should be built"))
    live = live_index()
    live["aois"][0]["files"]["fleet"]["bytes"] = 999
    s = Store(live)
    stats = F.run("skagit", tmp_path, client(http), s, today=TODAY, now=NOW, cell_to_latlng=fake_cell_to_latlng,
                  run_cmd=lambda c: pytest.fail("no commands should run"))
    assert stats["cells"] == 0 and s.index["aois"][0]["files"]["fleet"]["bytes"] == 0
    assert not (tmp_path / "skagit" / "tiles" / "fleet.pmtiles").exists() and s.events == [("put", "tiles/index.json")]


def test_run_dry_run_touches_nothing(tmp_path, monkeypatch):
    grid = make_grid()
    setup_run_dir(tmp_path, grid)
    http = FakeHttp(pages=[[row(cell_at(grid, 100, 100), TODAY, 3)]])
    stats = F.run("skagit", tmp_path, client(http), None, today=TODAY, now=NOW, dry_run=True,
                  cell_to_latlng=fake_cell_to_latlng, run_cmd=lambda c: pytest.fail("dry run must not run commands"))
    assert stats["cells"] == 1 and stats["published"] == "dry run"
    with pytest.raises(RuntimeError, match="SupabaseRest"):
        F.run("skagit", tmp_path, None, None, today=TODAY, now=NOW)
