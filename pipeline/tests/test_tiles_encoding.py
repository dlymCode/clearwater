import datetime as dt

import numpy as np

from pipeline import tiles
from pipeline.common import DATE_NODATA, ZOOMS, days_since_epoch


def test_terrain_rgb_known_value():
    # standard Mapbox formula: v = (h + 10000) / 0.1 ; h=0 -> 100000 = 0x0186A0
    rgb = tiles.encode_terrain_rgb(np.array([[0.0]]))
    assert rgb.tolist() == [[[0x01, 0x86, 0xA0]]]
    assert tiles.decode_terrain_rgb(rgb)[0, 0] == 0.0


def test_terrain_rgb_round_trip():
    rng = np.random.default_rng(1)
    z = rng.uniform(-80, 60, size=(64, 64)).astype(np.float32)
    z[3, 3] = np.nan
    z[10, 10] = -9999.0  # near the low edge of the range still encodes
    out = tiles.decode_terrain_rgb(tiles.encode_terrain_rgb(z))
    ok = np.isfinite(z)
    assert np.abs(out[ok] - z[ok]).max() <= 0.05 + 1e-4  # half of the 0.1 ft quantum
    assert np.isnan(out[3, 3])
    assert tiles.encode_terrain_rgb(z).dtype == np.uint8


def test_terrain_rgb_nodata_and_range():
    rgb = tiles.encode_terrain_rgb(np.array([np.nan, -20000.0, 2e7]))
    assert (rgb == 0).all()
    assert np.isnan(tiles.decode_terrain_rgb(rgb)).all()


def test_source_date_pack_round_trip():
    src = np.array([[1, 7, 0, 6]], dtype=np.uint8)
    date = np.array([[days_since_epoch("2024-06-01"), days_since_epoch("1887-01-01"), DATE_NODATA,
                      days_since_epoch("2014-09-15")]], dtype=np.int32)
    unc = np.array([[0.6, 1.0, np.nan, 12.0]], dtype=np.float32)
    packed = tiles.pack_source_date(src, date, unc)
    assert packed.shape == (1, 4, 4) and packed.dtype == np.uint8
    u = tiles.unpack_source_date(packed)
    assert u["valid"].tolist() == [[True, True, False, True]]
    assert u["src"].tolist() == [[1, 7, 0, 6]]
    assert u["date"][0, [0, 1, 3]].tolist() == date[0, [0, 1, 3]].tolist()
    assert u["date"][0, 2] == DATE_NODATA
    # uncertainty rounds up to the next bucket, never down
    assert u["unc_ft"][0, 0] == 0.75 and u["unc_ft"][0, 1] == 1.0 and u["unc_ft"][0, 3] == 15.0
    assert (packed[0, 2] == 0).all()  # hole: fully transparent, RGB zeroed


def test_unknown_uncertainty_is_not_reported_as_precise():
    packed = tiles.pack_source_date(np.array([[1]], np.uint8), np.array([[20000]], np.int32), np.array([[np.nan]]))
    assert tiles.unpack_source_date(packed)["unc_ft"][0, 0] == 50.0


def test_date_epoch_shift_is_1880():
    assert tiles._DATE_EPOCH_SHIFT == (dt.date(1970, 1, 1) - dt.date(1880, 1, 1)).days == 32872


def test_command_builders_do_not_execute_and_use_nearest():
    cmds = tiles.raster_pmtiles_cmds("a.tif", "work", "out.pmtiles", "waterline")
    assert cmds[0][0] == "gdalwarp" and "near" in cmds[0] and "EPSG:3857" in cmds[0]
    zmin, zmax = ZOOMS["waterline"]
    assert f"MINZOOM={zmin}" in cmds[1] and f"MAXZOOM={zmax}" in cmds[1] and "RESAMPLING=NEAREST" in cmds[1]
    assert cmds[2] == ["pmtiles", "convert", "work/waterline.mbtiles", "out.pmtiles"]
    assert tiles.gdal2tiles_cmd("a.tif", "o", 8, 16)[:3] == ["gdal2tiles.py", "--xyz", "-r"]


def test_enc_layers_and_tippecanoe():
    assert tiles.ENC_LAYERS == ("DEPARE", "DEPCNT", "SOUNDG", "COALNE", "BOYLAT", "LIGHTS", "OBSTRN", "WRECKS", "CBLSUB")
    cmds = tiles.enc_to_geojson_cmds(["US5WA10M.000"], "out")
    assert len(cmds) == 9 and cmds[0][0] == "ogr2ogr" and cmds[0][-1] == "DEPARE"
    t = tiles.tippecanoe_cmd({"DEPARE": "d.geojson", "COALNE": "c.geojson"}, "base.pmtiles", 8, 16)
    assert t[0] == "tippecanoe" and "-Z8" in t and "-z16" in t and t.count("-L") == 2
