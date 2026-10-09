import numpy as np

from pipeline.common import DATE_NODATA
from pipeline.waterline_dem import combine_pass, group_passes, ndwi, usable_mask, waterline_dem

W, H = 60, 3
TRUE = np.tile(np.linspace(0.2, 7.8, W, dtype=np.float32), (H, 1))  # known tidal ramp, ft MLLW
TIDES = np.linspace(-0.5, 8.5, 12)  # 12 scenes spanning the ramp
DAYS = 19000 + np.arange(12) * 10


def scene_bands(tide, cloud=False):
    wet = tide > TRUE  # cell is under water when the tide is above its elevation
    green = np.where(wet, 0.30, 0.10).astype(np.float32)
    nir = np.where(wet, 0.05, 0.30).astype(np.float32)
    scl = np.full(TRUE.shape, 4, dtype=np.uint8)
    if cloud:  # garbage spectra flagged as cloud must never influence the result
        green = np.where(wet, 0.10, 0.30).astype(np.float32)
        nir = np.where(wet, 0.30, 0.05).astype(np.float32)
        scl[:] = 9
    return green, nir, scl


def build(tides=TIDES, days=DAYS, cloudy=()):
    g, n, s = zip(*(scene_bands(t, i in cloudy) for i, t in enumerate(tides)))
    return np.stack(g), np.stack(n), np.stack(s), list(tides), list(days)


def test_ndwi_basics():
    v = ndwi(np.array([0.3, 0.1, 0.0]), np.array([0.05, 0.3, 0.0]))
    assert v[0] > 0.5 and v[1] < -0.4 and np.isnan(v[2])
    assert usable_mask(np.array([4, 5, 6, 3, 8, 9, 10, 11, 0])).tolist() == [True, True, True, False] + [False] * 5


def test_ramp_error_below_one_foot():
    r = waterline_dem(*build())
    assert np.isfinite(r.elev).all()  # ramp lies inside the tide range -> every cell bracketed
    err = np.abs(r.elev - TRUE)
    assert err.max() < 1.0
    assert err.max() <= (TIDES[1] - TIDES[0]) / 2 + 1e-3  # midpoint error <= half the tide step
    assert (r.bracket <= TIDES[1] - TIDES[0] + 1e-4).all() and (r.bracket >= 0).all()
    assert (r.n == 12).all()
    assert (r.date == DAYS[-1]).all()
    assert r.elev.dtype == np.float32 and r.date.dtype == np.int32


def test_cloud_scene_is_ignored():
    clean = waterline_dem(*build(TIDES[np.arange(12) != 5], DAYS[np.arange(12) != 5]))
    g, n, s, t, d = build(cloudy={5})
    cloudy = waterline_dem(g, n, s, t, d)
    assert np.array_equal(clean.elev, cloudy.elev, equal_nan=True)
    assert (cloudy.n == 11).all()


def test_fewer_than_five_scenes_masked_but_n_reported():
    g, n, s, t, d = build(TIDES[::3], DAYS[::3])  # 4 scenes
    r = waterline_dem(g, n, s, t, d)
    assert np.isnan(r.elev).all() and (r.date == DATE_NODATA).all()
    assert (r.n == 4).all()
    # lowering the requirement shows the data was there
    assert np.isfinite(waterline_dem(g, n, s, t, d, min_scenes=4).elev).any()


def test_bracket_over_three_feet_masked():
    tides = np.array([-1.0, 3.0, 7.0, 11.0, 15.0])  # 4 ft steps -> brackets of 4 ft
    ramp_cells = np.tile(np.linspace(0.0, 14.0, 20, dtype=np.float32), (1, 1))
    g = np.stack([np.where(t > ramp_cells, 0.3, 0.1) for t in tides]).astype(np.float32)
    n = np.stack([np.where(t > ramp_cells, 0.05, 0.3) for t in tides]).astype(np.float32)
    s = np.full(g.shape, 4, dtype=np.uint8)
    r = waterline_dem(g, n, s, tides, np.arange(5) + 100)
    assert np.isnan(r.elev).all()
    r2 = waterline_dem(g, n, s, tides, np.arange(5) + 100, max_bracket_ft=4.5)
    assert np.isfinite(r2.elev).any() and np.nanmax(r2.bracket) <= 4.5


def test_always_wet_or_always_dry_cells_masked():
    tides = np.linspace(2.0, 3.0, 6)
    z = np.array([[-5.0, 2.5, 20.0]], dtype=np.float32)  # always wet, bracketed, always dry
    g = np.stack([np.where(t > z, 0.3, 0.1) for t in tides]).astype(np.float32)
    n = np.stack([np.where(t > z, 0.05, 0.3) for t in tides]).astype(np.float32)
    s = np.full(g.shape, 4, dtype=np.uint8)
    r = waterline_dem(g, n, s, tides, np.arange(6))
    assert np.isnan(r.elev[0, 0]) and np.isnan(r.elev[0, 2])
    assert abs(r.elev[0, 1] - 2.5) < 0.2


def test_group_passes_chains_close_timestamps():
    t = [0.0, 10.0, 5000.0, 5030.0, 99999.0]
    assert group_passes(t) == [0, 0, 1, 1, 2]
    assert group_passes([5030.0, 0.0, 5000.0]) == [1, 0, 1]  # input order preserved
    assert group_passes([]) == []


def test_combine_pass_first_usable_wins():
    g = np.array([[[0.1]], [[0.3]]], dtype=np.float32)
    n = np.array([[[0.3]], [[0.05]]], dtype=np.float32)
    scl = np.array([[[9]], [[4]]], dtype=np.uint8)  # first layer cloudy, second usable
    gg, nn, ss = combine_pass(g, n, scl)
    assert (gg[0, 0], nn[0, 0], ss[0, 0]) == (np.float32(0.3), np.float32(0.05), 4)


def test_duplicate_scenes_of_one_pass_do_not_inflate_scene_count():
    g, n, s, t, d = build(TIDES[:4], DAYS[:4])  # 4 distinct passes: below the 5-scene minimum
    assert np.isnan(waterline_dem(g, n, s, t, d).elev).all()
    # re-processed duplicates of passes 0 and 1 (same sensing time) would make 6 "scenes"
    g2 = np.concatenate([g, g[:2]])
    n2 = np.concatenate([n, n[:2]])
    s2 = np.concatenate([s, s[:2]])
    t2, d2 = t + t[:2], list(d) + list(d[:2])
    naive = waterline_dem(g2, n2, s2, t2, d2)
    assert np.isfinite(naive.elev).any() and (naive.n == 6).all()  # without de-duplication the count is inflated
    deduped = waterline_dem(g2, n2, s2, t2, d2, pass_ids=[0, 1, 2, 3, 0, 1])
    assert np.isnan(deduped.elev).all() and (deduped.n == 4).all()


def test_pass_ids_do_not_change_clean_results():
    g, n, s, t, d = build()
    a = waterline_dem(g, n, s, t, d)
    b = waterline_dem(g, n, s, t, d, pass_ids=list(range(12)))
    assert np.array_equal(a.elev, b.elev, equal_nan=True) and np.array_equal(a.n, b.n)
