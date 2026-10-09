import numpy as np
import pytest

from pipeline.common import FT_PER_M, MissingVerticalCRS, require_vertical_crs, vertical_tags
from pipeline.to_mllw import ConstantOffset, convert_array, meters_to_feet, navd88_to_mllw_ft

# (z_navd88_m, offset_m NAVD88->MLLW at that cell, hand-calculated feet MLLW)
FIVE_POINTS = [
    (0.0, 0.716, 2.3491),  # Seattle-ish: NAVD88 zero is ~2.35 ft above MLLW
    (-1.5, 0.716, -2.5722),
    (2.0, 0.730, 8.9567),
    (-10.0, 0.700, -30.5118),
    (3.5, 0.000, 11.4829),  # zero offset reduces to metres -> feet
]


@pytest.mark.parametrize("z,off,expected", FIVE_POINTS)
def test_navd88_to_mllw_ft_known_points(z, off, expected):
    assert navd88_to_mllw_ft(z, off) == pytest.approx(expected, abs=0.01)


def test_meters_to_feet():
    assert meters_to_feet(1.0) == pytest.approx(3.28084, abs=1e-5)
    assert FT_PER_M == pytest.approx(1 / 0.3048)


def test_convert_array_vectorised_matches_scalar():
    z = np.array([[p[0] for p in FIVE_POINTS]])
    off = np.array([[p[1] for p in FIVE_POINTS]])
    out = convert_array(z, "NAVD88", "m", off)
    assert out.dtype == np.float32
    assert out[0] == pytest.approx([p[2] for p in FIVE_POINTS], abs=0.01)


def test_convert_array_units_and_nodata():
    off = ConstantOffset(0.7).offsets_m(np.zeros(3), np.zeros(3))
    ft_in = convert_array(np.array([10.0, -9999.0, np.nan]), "NAVD88", "ft", off, nodata=-9999.0)
    assert ft_in[0] == pytest.approx((10 / FT_PER_M + 0.7) * FT_PER_M, abs=1e-3)
    assert np.isnan(ft_in[1]) and np.isnan(ft_in[2])
    # already MLLW: only units change
    assert convert_array(np.array([2.0]), "MLLW", "m")[0] == pytest.approx(6.5617, abs=1e-3)
    assert convert_array(np.array([2.0]), "MLLW", "ft")[0] == 2.0


def test_cells_outside_datum_grid_become_nan():
    out = convert_array(np.array([1.0, 1.0]), "NAVD88", "m", np.array([0.7, np.nan]))
    assert np.isfinite(out[0]) and np.isnan(out[1])


def test_navd88_requires_offset_and_unknown_datum_rejected():
    with pytest.raises(ValueError):
        convert_array(np.array([1.0]), "NAVD88", "m", None)
    with pytest.raises(MissingVerticalCRS):
        convert_array(np.array([1.0]), "MHW", "m")


def test_vertical_crs_metadata_required():
    assert require_vertical_crs(vertical_tags()) == ("MLLW", "ft")
    with pytest.raises(MissingVerticalCRS):
        require_vertical_crs({})
    with pytest.raises(MissingVerticalCRS):
        require_vertical_crs({"VERTICAL_CRS": "NAVD88"})  # units missing
    with pytest.raises(MissingVerticalCRS):
        require_vertical_crs({"VERTICAL_CRS": "WGS84", "VERTICAL_UNITS": "m"})
