import copy
import datetime as dt
import json
import os
from pathlib import Path

import numpy as np
import pytest

from pipeline import publish
from pipeline.common import AOI_SLUGS, DATE_NODATA, REQUIRED_CHECKS, days_since_epoch
from pipeline.jsonschema_lite import validate

FIXTURE = Path(__file__).parent / "fixtures" / "tiles_index.example.json"
NOW = dt.datetime(2026, 10, 9, tzinfo=dt.timezone.utc)


class FakeStore:
    def __init__(self, index=None):
        self.index = index
        self.events = []

    def upload_file(self, local, key):
        self.events.append(("upload", key))

    def put_json(self, key, payload):
        self.events.append(("put_json", key))
        self.index = payload

    def get_json(self, key):
        return self.index


FULL_CHECKS = {n: {"passed": True, "reason": "ok"} for n in REQUIRED_CHECKS}


def good_report(aoi="skagit", **over):
    r = {"aoi": aoi, "gate": {"passed": True, "reason": "ok", "checks": copy.deepcopy(FULL_CHECKS), "dev_overrides": []},
         "dev_overrides": []}
    r.update(over)
    return r


def make_tree(root, passed=True, aoi="skagit", report_aoi=None, report=None, with_meta=True):
    """Tiles newer than every merged raster, older than the validation report."""
    tiles = root / aoi / "tiles"
    tiles.mkdir(parents=True, exist_ok=True)
    (root / aoi / "merge").mkdir(parents=True, exist_ok=True)
    (root / aoi / "validate").mkdir(parents=True, exist_ok=True)
    merged = root / aoi / "merge" / "merged_elev.tif"
    for name in publish.MERGED_RASTERS:
        (root / aoi / "merge" / name).write_bytes(b"m")
    files = {"depth.pmtiles": b"d" * 10, "base.pmtiles": b"b" * 4}
    if with_meta:
        files["depth_meta.pmtiles"] = b"m"
    for name, data in files.items():
        (tiles / name).write_bytes(data)
    rep = report if report is not None else good_report(report_aoi or aoi)
    if report is None and not passed:
        rep["gate"]["passed"] = False
        rep["gate"]["reason"] = "p90 too high"
    report_path = root / aoi / "validate" / "report.json"
    report_path.write_text(json.dumps(rep))
    t0 = 1_700_000_000
    for name in publish.MERGED_RASTERS:
        os.utime(root / aoi / "merge" / name, (t0, t0))
    for name in files:
        os.utime(tiles / name, (t0 + 100, t0 + 100))
    os.utime(report_path, (t0 + 200, t0 + 200))
    return tiles, merged, report_path


def test_fixture_validates_against_schema():
    idx = json.loads(FIXTURE.read_text())
    assert publish.validate_index(idx) == []


def test_fixture_validates_with_real_jsonschema_if_installed():
    jsonschema = pytest.importorskip("jsonschema")
    schema = publish.load_schema()
    jsonschema.Draft7Validator.check_schema(schema)
    jsonschema.validate(json.loads(FIXTURE.read_text()), schema)


def test_schema_rejects_bad_indexes():
    good = json.loads(FIXTURE.read_text())
    cases = []
    bad = copy.deepcopy(good)
    del bad["aois"][0]["files"]["fleet"]
    cases.append(bad)
    bad = copy.deepcopy(good)
    bad["aois"][0]["aoi"] = "puget"
    cases.append(bad)
    bad = copy.deepcopy(good)
    bad["aois"][0]["merged_date_range"] = ["1887-01-01"]
    cases.append(bad)
    bad = copy.deepcopy(good)
    bad["aois"][0]["files"]["base"]["bytes"] = -1
    cases.append(bad)
    bad = copy.deepcopy(good)
    bad["updated_at"] = "yesterday"
    cases.append(bad)
    bad = copy.deepcopy(good)
    del bad["aois"][0]["version"]
    cases.append(bad)
    for c in cases:
        assert publish.validate_index(c), c


def test_schema_ignores_unknown_fields():
    good = json.loads(FIXTURE.read_text())
    good["future_field"] = 1
    good["aois"][0]["notes"] = "x"
    assert publish.validate_index(good) == []


def test_build_entry_matches_agent_plan_shape():
    e = publish.build_aoi_entry("skagit", "2026-10-09T00:00:00Z", {"base": 1, "depth": 2}, ("1887-01-01", "2026-09-30"))
    assert set(e) == {"aoi", "version", "files", "merged_date_range"}
    assert list(e["files"]) == ["base", "depth", "waterline", "fleet"]
    assert e["files"]["depth"] == {"path": "tiles/skagit/2026-10-09T00:00:00Z/depth.pmtiles", "bytes": 2}
    assert e["files"]["fleet"]["bytes"] == 0
    idx = publish.update_index(None, e, NOW)
    assert idx["updated_at"] == "2026-10-09T00:00:00Z" and publish.validate_index(idx) == []


def test_update_index_replaces_one_aoi_and_keeps_canonical_order():
    idx = None
    for slug in ("nisqually", "skagit", "padilla_samish"):
        idx = publish.update_index(idx, publish.build_aoi_entry(slug, "2026-01-01T00:00:00Z", {"depth": 5}, ("2014-01-01", "2020-01-01")), NOW)
    assert [a["aoi"] for a in idx["aois"]] == ["skagit", "padilla_samish", "nisqually"]
    newer = publish.build_aoi_entry("skagit", "2026-10-09T00:00:00Z", {"depth": 9}, ("2014-01-01", "2026-01-01"))
    idx2 = publish.update_index(idx, newer, NOW)
    assert len(idx2["aois"]) == 3 and idx2["aois"][0]["version"] == "2026-10-09T00:00:00Z"
    assert idx2["aois"][1:] == idx["aois"][1:]


def test_date_range_from_days_ignores_nodata():
    d = np.array([[DATE_NODATA, days_since_epoch("1887-01-01")], [days_since_epoch("2026-09-30"), DATE_NODATA]], dtype=np.int32)
    assert publish.date_range_from_days(d) == ("1887-01-01", "2026-09-30")
    with pytest.raises(ValueError):
        publish.date_range_from_days(np.full((2, 2), DATE_NODATA, dtype=np.int32))


def test_publish_aoi_uploads_data_before_index(tmp_path):
    make_tree(tmp_path)
    store = FakeStore()
    idx = publish.publish_aoi("skagit", tmp_path, store, version="2026-10-09T00:00:00Z", now=NOW,
                              date_range=("2014-09-15", "2026-09-30"))
    assert publish.validate_index(idx) == []
    kinds = [e[0] for e in store.events]
    assert kinds[-1] == "put_json" and store.events[-1][1] == "tiles/index.json"
    assert ("upload", "tiles/skagit/2026-10-09T00:00:00Z/depth.pmtiles") in store.events
    assert ("upload", "tiles/skagit/2026-10-09T00:00:00Z/depth_meta.pmtiles") in store.events
    assert idx["aois"][0]["files"]["depth"]["bytes"] == 10
    assert idx["aois"][0]["files"]["waterline"]["bytes"] == 0  # absent product listed, not uploaded
    assert json.loads((tmp_path / "tiles" / "index.json").read_text()) == idx


def test_publish_dry_run_and_missing_depth(tmp_path):
    tiles, _, _ = make_tree(tmp_path)
    (tiles / "depth.pmtiles").unlink()
    with pytest.raises(FileNotFoundError):
        publish.publish_aoi("skagit", tmp_path, FakeStore(), now=NOW, date_range=("2014-01-01", "2015-01-01"))
    make_tree(tmp_path)
    s = FakeStore()
    publish.publish_aoi("skagit", tmp_path, s, now=NOW, date_range=("2014-01-01", "2015-01-01"), dry_run=True)
    assert s.events == []


def test_publish_refuses_without_or_with_failed_validation(tmp_path):
    _, _, report = make_tree(tmp_path)
    report.unlink()
    store = FakeStore()
    with pytest.raises(publish.PublishRefused, match="missing"):
        publish.publish_aoi("skagit", tmp_path, store, now=NOW, date_range=("2014-01-01", "2015-01-01"))
    make_tree(tmp_path, passed=False)
    with pytest.raises(publish.PublishRefused, match="gate did not pass"):
        publish.publish_aoi("skagit", tmp_path, store, now=NOW, date_range=("2014-01-01", "2015-01-01"))
    make_tree(tmp_path, report_aoi="nisqually")
    with pytest.raises(publish.PublishRefused, match="AOI"):
        publish.publish_aoi("skagit", tmp_path, store, now=NOW, date_range=("2014-01-01", "2015-01-01"))
    make_tree(tmp_path, report={"aoi": "skagit", "gate": {"passed": "yes"}})
    with pytest.raises(publish.PublishRefused):  # only literal true counts
        publish.publish_aoi("skagit", tmp_path, store, now=NOW, date_range=("2014-01-01", "2015-01-01"))
    assert store.events == []


def test_publish_refuses_when_tiles_changed_after_validation(tmp_path):
    tiles, _, report = make_tree(tmp_path)
    later = report.stat().st_mtime + 50
    os.utime(tiles / "depth.pmtiles", (later, later))
    with pytest.raises(publish.PublishRefused, match="after validation"):
        publish.publish_aoi("skagit", tmp_path, FakeStore(), now=NOW, date_range=("2014-01-01", "2015-01-01"))


def test_publish_refuses_stale_tiles_older_than_merged_elev(tmp_path):
    tiles, merged, report = make_tree(tmp_path)
    newer = merged.stat().st_mtime + 1000  # merged raster rebuilt after the tiles (and the report)
    os.utime(merged, (newer, newer))
    os.utime(report, (newer + 10, newer + 10))
    with pytest.raises(publish.PublishRefused, match="older than the merged rasters"):
        publish.publish_aoi("skagit", tmp_path, FakeStore(), now=NOW, date_range=("2014-01-01", "2015-01-01"))


def test_direct_cli_has_no_bypass_flag():
    import inspect

    src = inspect.getsource(publish.main)
    assert "skip" not in src and "force" not in src


def test_r2_store_requires_env_and_uses_injected_client():
    with pytest.raises(RuntimeError):
        publish.R2Store.from_env({})

    class C:
        calls = []

        def upload_file(self, *a, **k):
            self.calls.append(("upload", a))

        def put_object(self, **k):
            self.calls.append(("put", k["Key"]))

    c = C()
    st = publish.R2Store("bucket", client=c)
    st.upload_file(Path("x.pmtiles"), "tiles/a/b/x.pmtiles")
    st.put_json("tiles/index.json", {"a": 1})
    assert c.calls[0][1][1:3] == ("bucket", "tiles/a/b/x.pmtiles") and c.calls[1] == ("put", "tiles/index.json")


def test_versions_to_prune_counts_from_when_superseded():
    # published 100 days ago but replaced only 19 days ago: still inside its 30-day grace period
    listing = {"skagit": ["2026-07-01T00:00:00Z", "2026-09-20T00:00:00Z", "2026-10-09T00:00:00Z"],
               "nisqually": ["2026-01-01T00:00:00Z"]}
    current = {"skagit": "2026-10-09T00:00:00Z", "nisqually": "2026-01-01T00:00:00Z"}
    assert publish.versions_to_prune(listing, current, NOW) == []
    # superseded 100 days ago -> prunable; its successor (superseded 19 days ago) is kept
    listing = {"skagit": ["2026-05-01T00:00:00Z", "2026-07-01T00:00:00Z", "2026-09-20T00:00:00Z"]}
    assert publish.versions_to_prune(listing, {"skagit": "2026-09-20T00:00:00Z"}, NOW) == [("skagit", "2026-05-01T00:00:00Z")]
    # the current version is never pruned, however old
    assert publish.versions_to_prune({"skagit": ["2025-01-01T00:00:00Z"]}, {"skagit": "2025-01-01T00:00:00Z"}, NOW) == []


def test_lite_validator_matches_schema_enum():
    assert set(publish.load_schema()["definitions"]["aoi"]["properties"]["aoi"]["enum"]) == set(AOI_SLUGS)
    assert validate({"a": 1}, {"type": "object", "required": ["b"]}) == ["$: missing required 'b'"]


def tide_payload(sid, days=30, start=NOW):
    preds = [{"t": (start + dt.timedelta(minutes=30 * i)).strftime("%Y-%m-%dT%H:%M:%SZ"), "v": 1.0} for i in range(0, days * 48 + 1)]
    return {"station_id": sid, "name": "x", "datum": "MLLW", "units": "ft", "lat": 47.6, "lon": -122.3, "predictions": preds}


def write_tides(d, ids=("9447130", "9448576"), **kw):
    d.mkdir(parents=True, exist_ok=True)
    for sid in ids:
        (d / f"{sid}.json").write_text(json.dumps(tide_payload(sid, **kw)))


def test_publish_tides_flat_keys_and_not_in_index(tmp_path):
    write_tides(tmp_path / "tides")
    store = FakeStore()
    keys = publish.publish_tides(tmp_path / "tides", store, now=NOW)
    assert keys == ["tides/9447130.json", "tides/9448576.json"]
    assert store.events == [("put_json", k) for k in keys]
    # tides never enter tiles/index.json
    make_tree(tmp_path)
    idx = publish.publish_aoi("skagit", tmp_path, FakeStore(), now=NOW, date_range=("2014-01-01", "2015-01-01"))
    assert "tides" not in json.dumps(idx)


def test_publish_tides_dry_run_uploads_nothing_and_validates(tmp_path):
    write_tides(tmp_path / "tides")
    store = FakeStore()
    assert len(publish.publish_tides(tmp_path / "tides", store, now=NOW, dry_run=True)) == 2 and store.events == []


def test_publish_tides_rejects_stale_or_malformed(tmp_path):
    write_tides(tmp_path / "stale", days=3)
    with pytest.raises(ValueError, match="stale"):
        publish.publish_tides(tmp_path / "stale", FakeStore(), now=NOW)
    write_tides(tmp_path / "ok")
    bad = tmp_path / "ok" / "1234567.json"
    bad.write_text(json.dumps(tide_payload("9999999")))  # station_id does not match the file name
    with pytest.raises(ValueError, match="file name"):
        publish.publish_tides(tmp_path / "ok", FakeStore(), now=NOW)
    with pytest.raises(FileNotFoundError):
        publish.publish_tides(tmp_path / "empty", FakeStore(), now=NOW)


def test_r2_tides_are_compact_json():
    class C:
        body = None

        def put_object(self, **k):
            C.body = k["Body"]

    st = publish.R2Store("b", client=C())
    st.put_json("tides/9447130.json", {"a": [1, 2]})
    assert C.body == b'{"a":[1,2]}'
