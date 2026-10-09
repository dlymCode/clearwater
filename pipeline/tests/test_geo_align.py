import numpy as np
import pytest

from pipeline import align
from pipeline.common import AOI_SLUGS
from pipeline.fetch_baseline import AOIS
from pipeline.geo import (Grid, grid_for_lonlat_bbox, lonlat_to_utm10, sample_grid, snap_bounds, utm10_to_lonlat)


def test_utm_central_meridian_and_equator():
    x, y = lonlat_to_utm10(-123.0, 0.0)
    assert x == pytest.approx(500000.0, abs=1e-6) and y == pytest.approx(0.0, abs=1e-6)
    x, y = lonlat_to_utm10(-122.0, 0.0)
    # 1 degree of longitude off the central meridian on the equator (transverse Mercator, k0 = 0.9996)
    assert x == pytest.approx(611280.65, abs=0.05)


def test_utm_round_trip_over_puget_sound():
    rng = np.random.default_rng(3)
    lon = rng.uniform(-123.2, -122.0, 500)
    lat = rng.uniform(47.0, 48.9, 500)
    lon2, lat2 = utm10_to_lonlat(*lonlat_to_utm10(lon, lat))
    assert np.abs(lon2 - lon).max() < 1e-7 and np.abs(lat2 - lat).max() < 1e-7  # < 1 cm


def test_utm_matches_pyproj_when_available():
    pyproj = pytest.importorskip("pyproj")
    t = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32610", always_xy=True)
    x, y = t.transform(-122.4, 48.3)
    x2, y2 = lonlat_to_utm10(-122.4, 48.3)
    assert abs(x - x2) < 0.01 and abs(y - y2) < 0.01


def test_snap_bounds_outward_to_1000():
    assert snap_bounds((500.5, 1999.9, 3000.1, 4000.0)) == (0.0, 1000.0, 4000.0, 4000.0)


@pytest.mark.parametrize("slug", AOI_SLUGS)
def test_aoi_grids_are_snapped_and_cover_bbox(slug):
    aoi = AOIS[slug]
    g = grid_for_lonlat_bbox(aoi.bbox)
    assert g.crs == "EPSG:32610" and g.res == 2.0
    assert g.xmin % 1000 == 0 and g.ymax % 1000 == 0 and g.xmax % 1000 == 0 and g.ymin % 1000 == 0
    assert g.ncols * 2 % 1000 == 0 and g.nrows * 2 % 1000 == 0
    w, s, e, n = aoi.bbox
    for lon, lat in ((w, s), (e, n), ((w + e) / 2, (s + n) / 2)):
        x, y = lonlat_to_utm10(lon, lat)
        assert g.xmin <= x <= g.xmax and g.ymin <= y <= g.ymax
    assert g.transform == (2.0, 0.0, g.xmin, 0.0, -2.0, g.ymax)


def test_aoi_registry_matches_canonical_slugs():
    assert tuple(AOIS) == ("skagit", "port_susan", "snohomish", "padilla_samish", "nisqually")
    for a in AOIS.values():
        w, s, e, n = a.bbox
        assert -124 < w < e < -122 and 47 < s < n < 49


def test_grid_indexing_and_sampling():
    g = Grid(1000.0, 5000.0, 10, 10, 2.0)
    arr = np.arange(100, dtype=np.float32).reshape(10, 10)
    assert tuple(int(v) for v in g.xy_to_rowcol(1001.0, 4999.0)) == (0, 0)
    out = sample_grid(arr, g, np.array([1001.0, 1019.0, 900.0]), np.array([4999.0, 4981.0, 4999.0]))
    assert out[0] == 0 and out[1] == 99 and np.isnan(out[2])
    x, y = g.rowcol_to_xy(3, 4)
    assert (float(x), float(y)) == (1009.0, 4993.0)


def test_warp_command_flags():
    g = Grid(548000.0, 5340000.0, 500, 500, 2.0)
    c = align.warp_command(["a.tif", "b.tif"], "out.tif", g, "bilinear")
    assert c[0] == "gdalwarp"
    for flag in ("-tap", "-t_srs", "EPSG:32610", "-tr", "-te", "-r", "bilinear"):
        assert flag in c
    assert c[c.index("-tr") + 1: c.index("-tr") + 3] == ["2", "2"]
    assert c[c.index("-te") + 1: c.index("-te") + 5] == ["548000", "5339000", "549000", "5340000"]
    assert c[-3:] == ["a.tif", "b.tif", "out.tif"]
    lidar = align.warp_command(["l.tif"], "o.tif", g, align.RESAMPLING[align.kind_of("lidar_2014")])
    assert lidar[lidar.index("-r") + 1] == "min"
    assert align.RESAMPLING == {"dem": "bilinear", "lidar": "min", "categorical": "near"}
    with pytest.raises(ValueError):
        align.warp_command(["a"], "b", g, "lanczos-of-doom")


def test_pdal_pipeline_classes_2_and_29_at_1m():
    p = align.pdal_pipeline("in.laz", "out.tif")["pipeline"]
    assert p[0]["type"] == "readers.las" and p[0]["filename"] == "in.laz"
    assert p[1]["type"] == "filters.range"
    assert p[1]["limits"] == "Classification[2:2],Classification[29:29]"
    assert p[2]["type"] == "writers.gdal" and p[2]["resolution"] == 1.0 and p[2]["filename"] == "out.tif"


def test_laz_requires_explicit_vertical_crs(tmp_path):
    import json

    from pipeline.common import MissingVerticalCRS

    fetch = tmp_path / "skagit" / "fetch"
    fetch.mkdir(parents=True)
    entry = dict(path="lidar_2014/a.laz", source_url="u", download_date="d", sha256="s", crs=None, bytes=1,
                 source="lidar_2014", kind="laz", vertical_crs=None, vertical_units="m", meta={})
    (fetch / "manifest.json").write_text(json.dumps({"aoi": "skagit", "step": "fetch", "files": [entry]}))
    with pytest.raises(MissingVerticalCRS, match="vertical_crs"):
        align.stage_laz("skagit", tmp_path)
    entry.update(vertical_crs="NAVD88", vertical_units=None)
    (fetch / "manifest.json").write_text(json.dumps({"aoi": "skagit", "step": "fetch", "files": [entry]}))
    with pytest.raises(MissingVerticalCRS):
        align.stage_laz("skagit", tmp_path)


def test_laz_class_override():
    assert align.parse_classes("2,29") == (2, 29) and align.parse_classes("2, 40") == (2, 40)
    p = align.pdal_pipeline("in.laz", "o.tif", classes=(2, 40))["pipeline"][1]
    assert p["limits"] == "Classification[2:2],Classification[40:40]"
    with pytest.raises(ValueError):
        align.parse_classes(" , ")


def test_clean_profile_drops_block_sizes():
    from pipeline.common import clean_profile

    p = {"blockxsize": 512, "blockysize": 1, "tiled": False, "dtype": "float32"}
    out = clean_profile(p)
    assert "blockxsize" not in out and "blockysize" not in out and out["dtype"] == "float32" and "blockxsize" in p
