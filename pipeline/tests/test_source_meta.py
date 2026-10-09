import numpy as np
import pytest

from pipeline import source_meta as sm
from pipeline.common import DATE_NODATA, FT_PER_M, days_since_epoch

ELEV = np.array([[1.0, np.nan], [3.0, 4.0]], dtype=np.float32)


def test_lidar_ehydro_cudem_constants():
    d, u = sm.lidar_meta(ELEV, "2014-09-15")
    assert d.dtype == np.int32 and u.dtype == np.float32
    assert d[0, 0] == days_since_epoch("2014-09-15") and d[0, 1] == DATE_NODATA
    assert u[0, 0] == 0.5 and np.isnan(u[0, 1])
    d, u = sm.ehydro_meta(ELEV, "2025-03-02")
    assert d[1, 1] == days_since_epoch("2025-03-02") and u[1, 1] == 0.5
    d, u = sm.cudem_meta(ELEV, 2023)
    assert d[1, 0] == days_since_epoch("2023-01-01") and u[1, 0] == 1.0


def test_bluetopo_rat_decode_and_unc_conversion():
    contributor = np.array([[1, 2], [2, 9]])
    rat = {1: "2019-05-30", 2: "2023-08-01"}  # id 9 unknown
    unc_m = np.array([[0.5, 0.5], [1.0, 1.0]], dtype=np.float32)
    d, u = sm.bluetopo_meta(ELEV, contributor, rat, unc_m)
    assert d[0, 0] == days_since_epoch("2019-05-30") and d[1, 0] == days_since_epoch("2023-08-01")
    assert d[0, 1] == DATE_NODATA  # not covered
    assert d[1, 1] == DATE_NODATA  # covered but contributor id not in RAT -> unknown date
    assert u[1, 0] == pytest.approx(1.0 * FT_PER_M, abs=1e-4)
    assert np.isnan(u[0, 1])


def test_coned_uses_source_survey_raster_with_year_or_date():
    ids = np.array([[10, 10], [11, 12]])
    d, u = sm.coned_meta(ELEV, ids, {10: 2005, 11: "2014-09-15", 12: "2017"})
    assert d[0, 0] == days_since_epoch("2005-01-01") and d[1, 0] == days_since_epoch("2014-09-15")
    assert d[1, 1] == days_since_epoch("2017-01-01")


def test_build_arrays_dispatch_and_missing_meta():
    d, _ = sm.build_arrays("lidar_2014", ELEV, {"flight_date": "2014-09-15"})
    assert d[0, 0] == days_since_epoch("2014-09-15")
    with pytest.raises(ValueError):
        sm.build_arrays("ehydro", ELEV, {})
    with pytest.raises(ValueError):
        sm.build_arrays("bluetopo", ELEV, {})
    with pytest.raises(ValueError):
        sm.build_arrays("nope", ELEV, {})
