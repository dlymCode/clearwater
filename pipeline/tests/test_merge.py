import numpy as np
import pytest

from pipeline.common import DATE_NODATA, MissingVerticalCRS, days_since_epoch
from pipeline.merge import check_vertical_crs, merge_stack

REF = days_since_epoch("2026-10-09")
NAN = np.nan


def stack(cells):
    """cells: list over columns of per-source (elev, date_str|None, unc) tuples -> (S,1,N) arrays."""
    n_src = len(cells[0])
    elev = np.full((n_src, 1, len(cells)), np.nan, dtype=np.float32)
    date = np.full((n_src, 1, len(cells)), DATE_NODATA, dtype=np.int32)
    unc = np.full((n_src, 1, len(cells)), np.nan, dtype=np.float32)
    for c, col in enumerate(cells):
        for s, (e, d, u) in enumerate(col):
            elev[s, 0, c] = e
            if d is not None:
                date[s, 0, c] = days_since_epoch(d)
            unc[s, 0, c] = u
    return elev, date, unc


HOLE = (NAN, None, NAN)


def run(cells, codes=(1, 2)):
    e, d, u = stack(cells)
    return merge_stack(e, d, u, codes, REF)


def test_newest_wins():
    r = run([[(1.0, "2020-05-01", 0.5), (2.0, "2024-05-01", 1.0)]])
    assert r.elev[0, 0] == 2.0 and r.src[0, 0] == 2
    assert r.date[0, 0] == days_since_epoch("2024-05-01") and r.unc[0, 0] == 1.0
    # order of layers must not matter
    r = run([[(2.0, "2024-05-01", 1.0), (1.0, "2020-05-01", 0.5)]], codes=(2, 1))
    assert r.elev[0, 0] == 2.0 and r.src[0, 0] == 2


def test_date_tie_goes_to_lower_uncertainty():
    r = run([[(1.0, "2021-01-01", 1.0), (2.0, "2021-01-01", 0.5)]])
    assert (r.elev[0, 0], r.src[0, 0], r.unc[0, 0]) == (2.0, 2, 0.5)
    r = run([[(1.0, "2021-01-01", 0.25), (2.0, "2021-01-01", 0.5)]])
    assert (r.elev[0, 0], r.src[0, 0]) == (1.0, 1)


def test_full_tie_is_stable_first_layer_and_nan_unc_loses():
    r = run([[(1.0, "2021-01-01", 0.5), (2.0, "2021-01-01", 0.5)]])
    assert r.src[0, 0] == 1
    r = run([[(1.0, "2021-01-01", NAN), (2.0, "2021-01-01", 3.0)]])
    assert r.src[0, 0] == 2


def test_ten_year_rule():
    cells = [
        [(1.0, "2010-01-01", 0.1), (2.0, "2024-01-01", 5.0)],  # old skipped, recent wins despite worse unc
        [(1.0, "2010-01-01", 0.1), HOLE],  # old but nothing recent: old source still used
        [(1.0, "2010-01-01", 0.1), (2.0, "2012-06-01", 0.1)],  # both old: newest old wins
    ]
    r = run(cells)
    assert list(r.src[0]) == [2, 1, 2]
    assert list(r.elev[0]) == [2.0, 1.0, 2.0]


def test_ten_year_boundary_exact_is_not_old():
    exactly = "2016-10-09"  # 3652 days before REF is the last day that is *not* older than 10 years
    assert REF - days_since_epoch(exactly) == 3652
    r = run([[(1.0, exactly, 0.1), (2.0, exactly, 0.3)]])
    assert r.src[0, 0] == 1  # tie on date -> lower unc; neither skipped


def test_holes_preserved_and_never_interpolated():
    cells = [
        [(1.0, "2020-01-01", 0.5), HOLE],
        [HOLE, HOLE],  # hole between two valid cells
        [HOLE, (3.0, "2022-01-01", 0.5)],
    ]
    r = run(cells)
    assert np.isnan(r.elev[0, 1]) and r.src[0, 1] == 0
    assert r.date[0, 1] == DATE_NODATA and np.isnan(r.unc[0, 1])
    assert list(r.src[0]) == [1, 0, 2]


def test_valid_elev_with_unknown_date_is_ignored():
    r = run([[(1.0, None, 0.5), (2.0, "2000-01-01", 0.5)]])
    assert r.src[0, 0] == 2
    r = run([[(1.0, None, 0.5), HOLE]])
    assert r.src[0, 0] == 0 and np.isnan(r.elev[0, 0])


def test_output_dtypes_and_shapes():
    r = run([[(1.0, "2020-01-01", 0.5), (2.0, "2021-01-01", 0.5)]])
    assert r.elev.dtype == np.float32 and r.src.dtype == np.uint8
    assert r.date.dtype == np.int32 and r.unc.dtype == np.float32
    assert r.elev.shape == (1, 1)


def test_bad_inputs():
    e, d, u = stack([[(1.0, "2020-01-01", 0.5), (2.0, "2021-01-01", 0.5)]])
    with pytest.raises(ValueError):
        merge_stack(e, d, u, [1], REF)
    with pytest.raises(ValueError):
        merge_stack(e, d, u, [0, 1], REF)  # code 0 reserved for holes


def test_rejects_rasters_without_vertical_crs():
    ok = {"VERTICAL_CRS": "MLLW", "VERTICAL_UNITS": "ft"}
    check_vertical_crs({"a": ok})
    with pytest.raises(MissingVerticalCRS):
        check_vertical_crs({"a": ok, "b": {}})
    with pytest.raises(MissingVerticalCRS):
        check_vertical_crs({"a": {"VERTICAL_CRS": "NAVD88", "VERTICAL_UNITS": "m"}})
    with pytest.raises(MissingVerticalCRS):
        check_vertical_crs({"a": {"VERTICAL_CRS": "MLLW"}})
