import datetime as dt
import json
import urllib.parse

import pytest

from pipeline import coops, fetch_baseline as fb, fetch_tides
from pipeline.common import Manifest

UTC = dt.timezone.utc
ANCHOR = dt.datetime(2020, 1, 1, tzinfo=UTC)
STEP = dt.timedelta(hours=6, minutes=12)

MDAPI = {"stations": [
    {"id": "9448576", "name": "La Conner", "state": "WA", "lat": 48.3917, "lng": -122.4950},
    {"id": "9448794", "name": "Stanwood", "state": "WA", "lat": 48.2400, "lng": -122.3700},
    {"id": "9447659", "name": "Everett", "state": "WA", "lat": 47.9833, "lng": -122.2167},
    {"id": "9447855", "name": "Coupeville", "state": "WA", "lat": 48.2200, "lng": -122.6867},
    {"id": "1111111", "name": "La Conner, Oregon", "state": "OR", "lat": 44.0, "lng": -123.0},
    {"id": "9447130", "name": "Seattle", "state": "WA", "lat": 47.60264, "lng": -122.33931},
    {"id": "9444900", "name": "Port Townsend", "state": "WA", "lat": 48.11286, "lng": -122.75950},
    {"id": "9449880", "name": "Friday Harbor", "state": "WA", "lat": 48.54530, "lng": -123.01250},
    {"id": "9449424", "name": "Cherry Point", "state": "WA", "lat": 48.86310, "lng": -122.75890},
    {"id": "9446484", "name": "Tacoma", "state": "WA", "lat": 47.26867, "lng": -122.41333},
    {"id": "9444090", "name": "Port Angeles", "state": "WA", "lat": 48.12500, "lng": -123.44000},
]}


def fake_crs(path):
    return "EPSG:4269"


def fake_http_get(url):
    if "mdapi" in url:
        return json.dumps(MDAPI).encode()
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert q["interval"] == ["hilo"] and q["datum"] == ["MLLW"] and q["units"] == ["english"]
    begin = dt.datetime.strptime(q["begin_date"][0], "%Y%m%d %H:%M").replace(tzinfo=UTC)
    end = dt.datetime.strptime(q["end_date"][0], "%Y%m%d %H:%M").replace(tzinfo=UTC)
    k = int((begin - ANCHOR) / STEP)
    rows = []
    while True:
        t = ANCHOR + k * STEP
        k += 1
        if t < begin:
            continue
        if t > end:
            break
        rows.append({"t": t.strftime("%Y-%m-%d %H:%M"), "v": "9.000" if (k - 1) % 2 == 0 else "-1.000",
                     "type": "H" if (k - 1) % 2 == 0 else "L"})
    return json.dumps({"predictions": rows}).encode()


# ---------------------------------------------------------------- geometry & tiles
def test_bbox_intersection_and_tile_selection():
    assert fb.bbox_intersects((0, 0, 2, 2), (1, 1, 3, 3))
    assert not fb.bbox_intersects((0, 0, 1, 1), (2, 2, 3, 3))
    index = {"features": [
        {"properties": {"url": "ninth_Topobathy_n48x50_w122x75_2023v1.tif"},
         "geometry": {"type": "Polygon", "coordinates": [[[-122.75, 48.25], [-122.5, 48.25], [-122.5, 48.5], [-122.75, 48.5], [-122.75, 48.25]]]}},
        {"properties": {"url": "ninth_Topobathy_n47x00_w122x75_2024v1.tif"},
         "geometry": {"type": "Polygon", "coordinates": [[[-122.75, 46.75], [-122.5, 46.75], [-122.5, 47.0], [-122.75, 47.0], [-122.75, 46.75]]]}},
    ]}
    tiles = fb.tiles_from_geojson(index)
    hit = fb.select_tiles(tiles, fb.AOIS["skagit"].bbox)
    assert [t.name for t in hit] == ["ninth_Topobathy_n48x50_w122x75_2023v1.tif"]
    assert hit[0].url.startswith(fb.CUDEM_BASE_URL)
    assert fb.parse_version_year(hit[0].name) == 2023


def test_scene_window_three_years():
    assert fb.scene_window(dt.date(2026, 10, 9)) == "2023-10-09/2026-10-09"
    assert fb.scene_window(dt.date(2028, 2, 29)) == "2025-02-28/2028-02-29"


def test_parse_item_requires_all_bands():
    item = {"id": "S2A_x", "bbox": [1, 2, 3, 4], "properties": {"datetime": "2025-07-01T19:00:00Z", "eo:cloud_cover": 3.0},
            "assets": {b: {"href": f"https://x/{b}.tif"} for b in fb.S2_BANDS}}
    s = fb.parse_item(item)
    assert s and s.id == "S2A_x" and s.assets["B08"].endswith("B08.tif")
    del item["assets"]["SCL"]
    assert fb.parse_item(item) is None


def test_all_modules_import_without_geo_stack():
    """Every module must import with rasterio/pyproj/gdal/pdal/pystac unavailable (CI has no GDAL)."""
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    code = (
        "import sys\n"
        "for n in ('rasterio','pyproj','osgeo','pdal','pystac_client','planetary_computer','nbs','boto3'):\n"
        "    sys.modules[n] = None\n"
        "import importlib\n"
        "for m in ('common','geo','coops','jsonschema_lite','fetch_baseline','fetch_tides','to_mllw','align','source_meta',"
        "'waterline_dem','merge','validate','tiles','publish'):\n"
        "    importlib.import_module('pipeline.' + m)\n"
        "print('ok')\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout.strip() == "ok", out.stderr


# ---------------------------------------------------------------- manifest
def test_manifest_round_trip(tmp_path):
    d = tmp_path / "skagit" / "fetch"
    (d / "cudem").mkdir(parents=True)
    f = d / "cudem" / "t.tif"
    f.write_bytes(b"hello")
    m = Manifest(d, "skagit", crs_reader=fake_crs)
    m.add_file(f, source_url="https://example/t.tif", source="cudem", vertical_crs="NAVD88", vertical_units="m")
    m.add_file("cudem/t.tif", source_url="https://example/t.tif", source="cudem")  # re-add replaces
    m.save()
    data = json.loads((d / "manifest.json").read_text())
    (e,) = data["files"]
    assert e["path"] == "cudem/t.tif" and e["source_url"] == "https://example/t.tif"
    assert e["sha256"] == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    assert e["download_date"].endswith("Z") and e["bytes"] == 5
    assert e["crs"] == "EPSG:4269"  # populated from the dataset, never left null
    again = Manifest.load(d, "skagit", crs_reader=fake_crs)
    assert again.select(source="cudem")[0].sha256 == e["sha256"]


def test_manifest_rejects_raster_without_crs(tmp_path):
    f = tmp_path / "x.tif"
    f.write_bytes(b"x")
    m = Manifest(tmp_path, "skagit", crs_reader=lambda p: None)
    with pytest.raises(ValueError, match="no CRS"):
        m.add_file(f, source_url="u", source="cudem")
    # non-raster kinds are not read
    m.add_file(f, source_url="u", source="enc", kind="other")


def test_http_download_is_atomic(tmp_path):
    src = tmp_path / "remote.bin"
    src.write_bytes(b"payload")
    dest = tmp_path / "out" / "f.tif"
    fb.http_download(src.as_uri(), dest)
    assert dest.read_bytes() == b"payload" and not list(dest.parent.glob("*.part"))
    bad = tmp_path / "out" / "g.tif"
    with pytest.raises(Exception):
        fb.http_download((tmp_path / "missing.bin").as_uri(), bad)
    assert not bad.exists() and not list(bad.parent.glob("g.tif*"))


# ---------------------------------------------------------------- tides
def test_cosine_interpolation():
    ev = [(ANCHOR, 9.0), (ANCHOR + STEP, -1.0), (ANCHOR + 2 * STEP, 9.0)]
    assert coops.cosine_interpolate(ev, ANCHOR) == 9.0
    assert coops.cosine_interpolate(ev, ANCHOR + STEP) == -1.0
    assert coops.cosine_interpolate(ev, ANCHOR + STEP / 2) == pytest.approx(4.0)
    assert coops.cosine_interpolate(ev, ANCHOR + STEP / 4) == pytest.approx(9.0 - 10 * (1 - 0.70710678) / 2, abs=1e-5)
    with pytest.raises(ValueError):
        coops.cosine_interpolate(ev, ANCHOR - dt.timedelta(hours=1))


def test_densify_keeps_extremes():
    ev = [(ANCHOR, 9.0), (ANCHOR + STEP, -1.0), (ANCHOR + 2 * STEP, 9.0)]
    pts = coops.densify(ev, ANCHOR, ANCHOR + 2 * STEP, 15)
    ts = [t for t, _ in pts]
    assert ts == sorted(ts) and (ANCHOR + STEP) in ts
    assert min(v for _, v in pts) == -1.0


def test_station_resolution_and_nearest():
    resolved, unresolved = coops.resolve_stations(coops.ALL_STATIONS, fake_http_get)
    assert not unresolved and len(resolved) == 10
    ids = {s.name: s.id for s in resolved}
    assert ids["La Conner"] == "9448576" and ids["Seattle"] == "9447130"
    assert {"9447130", "9444900", "9449880", "9449424", "9446484", "9444090"} <= set(ids.values())
    skagit = fb.AOIS["skagit"]
    c = ((skagit.bbox[0] + skagit.bbox[2]) / 2, (skagit.bbox[1] + skagit.bbox[3]) / 2)
    assert coops.nearest_station(*c, resolved).name == "La Conner"  # not Seattle
    nis = fb.AOIS["nisqually"]
    assert coops.nearest_station((nis.bbox[0] + nis.bbox[2]) / 2, (nis.bbox[1] + nis.bbox[3]) / 2, resolved).name == "Tacoma"


def test_match_station_filters_state():
    s = coops.match_station(MDAPI, "La Conner")
    assert s and s.id == "9448576"
    assert coops.match_station(MDAPI, "Nowhere") is None


# ---------------------------------------------------------------- run() with fakes
def test_run_writes_manifest_and_scenes_with_tide_tags(tmp_path):
    index = [fb.TileRecord("tile_2023v1.tif", "https://example/tile_2023v1.tif", (-122.7, 48.2, -122.4, 48.5))]

    def dl(url, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"cudem-bytes")

    bt_calls = []

    def bt_fetch(outdir, **kw):
        bt_calls.append((outdir, kw))
        (tmp_path / "skagit" / "fetch" / "bluetopo" / "BlueTopo_BC25M123_20250101.tiff").write_bytes(b"bt")

    class FakeItem:
        def __init__(self, i, when, cloud):
            self.d = {"id": f"S2_{i}", "bbox": [-122.6, 48.2, -122.3, 48.5],
                      "properties": {"datetime": when, "eo:cloud_cover": cloud},
                      "assets": {b: {"href": f"https://x/{i}/{b}.tif?sig=abc"} for b in fb.S2_BANDS}}

        def to_dict(self):
            return self.d

    class FakeClient:
        def search(self, **kw):
            assert kw["collections"] == ["sentinel-2-l2a"] and kw["query"] == {"eo:cloud_cover": {"lt": 15.0}}
            assert kw["datetime"] == "2023-10-09/2026-10-09"
            return type("S", (), {"items": lambda self: [FakeItem(1, "2025-07-01T19:00:00Z", 2.0), FakeItem(0, "2024-06-01T19:00:00Z", 1.0)]})()

    tagger = fb.TideTagger(stations=coops.ALL_STATIONS, http_get=fake_http_get)
    m = fb.run("skagit", tmp_path, today=dt.date(2026, 10, 9), cudem=fb.CudemFetcher(tile_index=index, download=dl),
               bluetopo=fb.BlueTopoFetcher(fetch_fn=bt_fetch), s2=fb.Sentinel2Searcher(client_factory=FakeClient),
               tagger=tagger, download_scenes=False, crs_reader=fake_crs)
    assert bt_calls and "desired_area_filename" in bt_calls[0][1]
    mf = json.loads((tmp_path / "skagit" / "fetch" / "manifest.json").read_text())
    by_src = {f["source"]: f for f in mf["files"]}
    assert by_src["cudem"]["meta"] == {"version_year": 2023} and by_src["cudem"]["vertical_crs"] == "NAVD88"
    assert by_src["bluetopo"]["vertical_crs"] == "MLLW"
    for f in mf["files"]:
        assert f["sha256"] and f["source_url"] and f["download_date"]
        assert f["crs"] == "EPSG:4269"  # CRS recorded for every raster file
    scenes = json.loads((tmp_path / "skagit" / "fetch" / "scenes.json").read_text())["scenes"]
    assert [s["id"] for s in scenes] == ["S2_0", "S2_1"]  # sorted by time
    for s in scenes:
        assert s["station_id"] == "9448576" and -1.0 <= s["tide_ft"] <= 9.0
    assert m.select(source="cudem")


def test_main_dry_run_prints_plan(capsys):
    assert fb.main(["--aoi", "nisqually", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "nisqually" in out and "sentinel-2-l2a" in out and "B03,B08,SCL" in out


# ---------------------------------------------------------------- tide JSON files
def test_fetch_tides_exact_shape(tmp_path):
    now = dt.datetime(2026, 10, 9, 5, 30, tzinfo=UTC)
    paths = fetch_tides.fetch_all(tmp_path, now=now, days=30, http_get=fake_http_get)
    assert len(paths) == 10
    d = json.loads((tmp_path / "9447130.json").read_text())
    assert list(d) == ["station_id", "name", "datum", "units", "lat", "lon", "predictions"]
    assert d["station_id"] == "9447130" and d["name"] == "Seattle" and d["datum"] == "MLLW" and d["units"] == "ft"
    assert d["lat"] == pytest.approx(47.60264) and d["lon"] == pytest.approx(-122.33931)  # from the metadata API
    lc = json.loads((tmp_path / "9448576.json").read_text())
    assert lc["lat"] == pytest.approx(48.3917) and lc["lon"] == pytest.approx(-122.4950)
    p = d["predictions"]
    assert p[0]["t"] == "2026-10-09T05:00:00Z" and p[-1]["t"] == "2026-11-08T05:00:00Z"
    assert set(p[0]) == {"t", "v"} and isinstance(p[0]["v"], float)
    assert len(p) >= 1440 and sum(f.stat().st_size for f in paths) < 1_000_000  # PRD: under 1 MB
    assert (tmp_path / "9448576.json").exists()  # subordinate resolved through the metadata API
