import copy
import datetime as dt
import json
from pathlib import Path

import numpy as np
import pytest

from pipeline import publish
from pipeline.common import AOI_SLUGS, DATE_NODATA, days_since_epoch
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
    tiles = tmp_path / "skagit" / "tiles"
    tiles.mkdir(parents=True)
    (tiles / "depth.pmtiles").write_bytes(b"d" * 10)
    (tiles / "base.pmtiles").write_bytes(b"b" * 4)
    (tiles / "depth_meta.pmtiles").write_bytes(b"m")
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
    tiles = tmp_path / "skagit" / "tiles"
    tiles.mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        publish.publish_aoi("skagit", tmp_path, FakeStore(), now=NOW, date_range=("2014-01-01", "2015-01-01"))
    (tiles / "depth.pmtiles").write_bytes(b"x")
    s = FakeStore()
    publish.publish_aoi("skagit", tmp_path, s, now=NOW, date_range=("2014-01-01", "2015-01-01"), dry_run=True)
    assert s.events == []


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


def test_versions_to_prune_keeps_current_and_recent():
    listing = {"skagit": ["2026-07-01T00:00:00Z", "2026-09-20T00:00:00Z", "2026-10-09T00:00:00Z"],
               "nisqually": ["2026-01-01T00:00:00Z"]}
    current = {"skagit": "2026-10-09T00:00:00Z", "nisqually": "2026-01-01T00:00:00Z"}
    assert publish.versions_to_prune(listing, current, NOW) == [("skagit", "2026-07-01T00:00:00Z")]


def test_lite_validator_matches_schema_enum():
    assert set(publish.load_schema()["definitions"]["aoi"]["properties"]["aoi"]["enum"]) == set(AOI_SLUGS)
    assert validate({"a": 1}, {"type": "object", "required": ["b"]}) == ["$: missing required 'b'"]
