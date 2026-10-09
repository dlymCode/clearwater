"""Pure-numpy geodesy and working-grid math (no pyproj / GDAL needed).

The UTM 10N projection uses the Kruger n-series (sub-millimetre inside a zone),
so grid definition, ground-truth sampling and tests work on a bare Python install.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .common import CELL_M, SNAP_M, WORK_CRS

# WGS84
_A = 6378137.0
_F = 1.0 / 298.257223563
_K0 = 0.9996
_E0 = 500000.0
_LON0 = -123.0  # UTM zone 10 central meridian

_N = _F / (2.0 - _F)
_AA = _A / (1.0 + _N) * (1.0 + _N**2 / 4.0 + _N**4 / 64.0)
_ALPHA = (
    _N / 2.0 - 2.0 * _N**2 / 3.0 + 5.0 * _N**3 / 16.0,
    13.0 * _N**2 / 48.0 - 3.0 * _N**3 / 5.0,
    61.0 * _N**3 / 240.0,
)
_BETA = (
    _N / 2.0 - 2.0 * _N**2 / 3.0 + 37.0 * _N**3 / 96.0,
    _N**2 / 48.0 + _N**3 / 15.0,
    17.0 * _N**3 / 480.0,
)
_DELTA = (
    2.0 * _N - 2.0 * _N**2 / 3.0 - 2.0 * _N**3,
    7.0 * _N**2 / 3.0 - 8.0 * _N**3 / 5.0,
    56.0 * _N**3 / 15.0,
)


def lonlat_to_utm10(lon, lat):
    """WGS84 lon/lat (deg) -> EPSG:32610 easting/northing (m). Accepts scalars or arrays."""
    lon = np.asarray(lon, dtype=np.float64)
    lat = np.asarray(lat, dtype=np.float64)
    phi = np.radians(lat)
    dlam = np.radians(lon - _LON0)
    c = 2.0 * math.sqrt(_N) / (1.0 + _N)
    t = np.sinh(np.arctanh(np.sin(phi)) - c * np.arctanh(c * np.sin(phi)))
    xi_p = np.arctan2(t, np.cos(dlam))
    eta_p = np.arctanh(np.sin(dlam) / np.sqrt(1.0 + t * t))
    xi = xi_p.copy()
    eta = eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi = xi + a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta = eta + a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    return _E0 + _K0 * _AA * eta, _K0 * _AA * xi


def utm10_to_lonlat(x, y):
    """EPSG:32610 easting/northing (m) -> WGS84 lon/lat (deg)."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    xi = y / (_K0 * _AA)
    eta = (x - _E0) / (_K0 * _AA)
    xi_p = xi.copy()
    eta_p = eta.copy()
    for j, b in enumerate(_BETA, start=1):
        xi_p = xi_p - b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta_p = eta_p - b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    phi = chi.copy()
    for j, d in enumerate(_DELTA, start=1):
        phi = phi + d * np.sin(2 * j * chi)
    lam = np.radians(_LON0) + np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    return np.degrees(lam), np.degrees(phi)


@dataclass(frozen=True)
class Grid:
    """North-up working grid: upper-left origin, square cells, EPSG:32610."""

    xmin: float
    ymax: float
    ncols: int
    nrows: int
    res: float = CELL_M
    crs: str = WORK_CRS

    @property
    def xmax(self) -> float:
        return self.xmin + self.ncols * self.res

    @property
    def ymin(self) -> float:
        return self.ymax - self.nrows * self.res

    @property
    def shape(self) -> tuple[int, int]:
        return (self.nrows, self.ncols)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        """(xmin, ymin, xmax, ymax)."""
        return (self.xmin, self.ymin, self.xmax, self.ymax)

    @property
    def transform(self) -> tuple[float, float, float, float, float, float]:
        """Affine coefficients (a, b, c, d, e, f) as used by rasterio.Affine(*t)."""
        return (self.res, 0.0, self.xmin, 0.0, -self.res, self.ymax)

    def to_dict(self) -> dict:
        return {"xmin": self.xmin, "ymax": self.ymax, "ncols": self.ncols, "nrows": self.nrows, "res": self.res, "crs": self.crs}

    @classmethod
    def from_dict(cls, d: dict) -> "Grid":
        return cls(float(d["xmin"]), float(d["ymax"]), int(d["ncols"]), int(d["nrows"]), float(d.get("res", CELL_M)), d.get("crs", WORK_CRS))

    def xy_to_rowcol(self, x, y):
        """Cell indices (row, col) containing UTM points; floats so callers can range-check."""
        col = np.floor((np.asarray(x, dtype=np.float64) - self.xmin) / self.res)
        row = np.floor((self.ymax - np.asarray(y, dtype=np.float64)) / self.res)
        return row.astype(np.int64), col.astype(np.int64)

    def rowcol_to_xy(self, row, col):
        """Cell-centre coordinates."""
        x = self.xmin + (np.asarray(col, dtype=np.float64) + 0.5) * self.res
        y = self.ymax - (np.asarray(row, dtype=np.float64) + 0.5) * self.res
        return x, y

    def contains_rowcol(self, row, col):
        row = np.asarray(row)
        col = np.asarray(col)
        return (row >= 0) & (row < self.nrows) & (col >= 0) & (col < self.ncols)


def snap_bounds(
    bounds: tuple[float, float, float, float], snap: float = SNAP_M
) -> tuple[float, float, float, float]:
    """Expand (xmin, ymin, xmax, ymax) outward to multiples of ``snap`` metres."""
    xmin, ymin, xmax, ymax = bounds
    return (
        math.floor(xmin / snap) * snap,
        math.floor(ymin / snap) * snap,
        math.ceil(xmax / snap) * snap,
        math.ceil(ymax / snap) * snap,
    )


def lonlat_bbox_to_utm_bounds(bbox: tuple[float, float, float, float], samples: int = 25):
    """UTM bounds enclosing a (west, south, east, north) lon/lat box (edges densified)."""
    w, s, e, n = bbox
    t = np.linspace(0.0, 1.0, samples)
    lons = np.concatenate([w + (e - w) * t, w + (e - w) * t, np.full(samples, w), np.full(samples, e)])
    lats = np.concatenate([np.full(samples, s), np.full(samples, n), s + (n - s) * t, s + (n - s) * t])
    x, y = lonlat_to_utm10(lons, lats)
    return float(x.min()), float(y.min()), float(x.max()), float(y.max())


def grid_for_lonlat_bbox(bbox: tuple[float, float, float, float], res: float = CELL_M, snap: float = SNAP_M) -> Grid:
    """The 2 m, 1000 m-snapped EPSG:32610 grid for an AOI lon/lat box.

    Origin (xmin, ymax) and extent are multiples of ``snap`` (which is a multiple of
    ``res``), so every layer in every step has identical shape and transform.
    """
    if snap % res:
        raise ValueError("snap must be a multiple of the cell size")
    xmin, ymin, xmax, ymax = snap_bounds(lonlat_bbox_to_utm_bounds(bbox), snap)
    return Grid(xmin=xmin, ymax=ymax, ncols=int(round((xmax - xmin) / res)), nrows=int(round((ymax - ymin) / res)), res=res)


def sample_grid(arr: np.ndarray, grid: Grid, x, y, fill=np.nan) -> np.ndarray:
    """Nearest-cell sample of a (rows, cols) array at UTM points; out-of-grid -> ``fill``."""
    row, col = grid.xy_to_rowcol(x, y)
    ok = grid.contains_rowcol(row, col)
    out = np.full(row.shape, fill, dtype=np.float64)
    out[ok] = arr[row[ok], col[ok]]
    return out


def haversine_km(lon1, lat1, lon2, lat2):
    r = 6371.0088
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = p2 - p1
    dlmb = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlmb / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))
