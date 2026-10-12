"""Step 4 - per-source ``date.tif`` (int32 days since 1970) and ``unc.tif`` (float32 ft).

    python -m pipeline.source_meta --aoi skagit

Per the PRD table: BlueTopo per-cell from its RAT (decode stubbed behind a lazy import),
CoNED from its source-survey raster, lidar = flight date @ 0.5 ft, eHydro = survey date
@ 0.5 ft, CUDEM = tile version year @ 1 ft. All array builders are pure numpy; a cell is
"covered" iff the aligned ``elev.tif`` is finite there, and uncovered cells get
``DATE_NODATA`` / NaN.

Per-source inputs live next to the aligned elevation (``align/<source>/``):
  * ``contributor.tif``  (BlueTopo band 3 / CoNED source-survey id, nearest-resampled)
  * ``uncertainty.tif``  (BlueTopo band 2, metres, aligned) - optional
  * ``rat.json``         (BlueTopo RAT dumped by :func:`read_bluetopo_rat`, or a CoNED id->date table)
The date/uncertainty of single-date sources comes from the fetch manifest ``meta``
(``survey_date`` / ``flight_date`` / ``version_year``).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from .common import (DATE_NODATA, FT_PER_M, SOURCES, Manifest, MixedMetaError, clean_profile, days_since_epoch,
                     step_dir)

#: Dates recorded in the fetch manifest (flight/survey/version) must be believable for these sources.
META_MIN_DATE = dt.date(1990, 1, 1)
#: Per-cell tables (BlueTopo RAT, CoNED source surveys) legitimately reach back to the 1800s bathymetry
#: but cannot be packed into the tiles before 1880.
TABLE_MIN_DATE = dt.date(1880, 1, 1)


def parse_meta_date(value: Any, name: str, min_date: dt.date = META_MIN_DATE) -> int:
    """Days since 1970 for an ISO date string / date, rejecting bool/int/float confusion and implausible dates."""
    if isinstance(value, bool) or isinstance(value, (int, float)):
        raise ValueError(f"{name}: expected an ISO date string like '2014-09-15', got {type(value).__name__} {value!r}")
    if isinstance(value, dt.datetime):
        value = value.date()
    if isinstance(value, str):
        try:
            value = dt.date.fromisoformat(value[:10]) if len(value) >= 10 else dt.date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"{name}: {value!r} is not an ISO date (YYYY-MM-DD)") from exc
    if not isinstance(value, dt.date):
        raise ValueError(f"{name}: unsupported date value {value!r}")
    latest = dt.date.today() + dt.timedelta(days=1)
    if not (min_date <= value <= latest):
        raise ValueError(f"{name}: {value.isoformat()} outside {min_date.isoformat()}..{latest.isoformat()}")
    return days_since_epoch(value)


def covered(elev: np.ndarray) -> np.ndarray:
    return np.isfinite(elev)


def constant_meta(elev: np.ndarray, day: int, unc_ft: float) -> tuple[np.ndarray, np.ndarray]:
    m = covered(elev)
    date = np.where(m, np.int32(day), np.int32(DATE_NODATA)).astype(np.int32)
    unc = np.where(m, np.float32(unc_ft), np.float32(np.nan)).astype(np.float32)
    return date, unc


def lidar_meta(elev: np.ndarray, flight_date: str | dt.date, source: str = "lidar_2014") -> tuple[np.ndarray, np.ndarray]:
    return constant_meta(elev, parse_meta_date(flight_date, "flight_date"), SOURCES[source].unc_ft)


def ehydro_meta(elev: np.ndarray, survey_date: str | dt.date) -> tuple[np.ndarray, np.ndarray]:
    return constant_meta(elev, parse_meta_date(survey_date, "survey_date"), SOURCES["ehydro"].unc_ft)


def cudem_meta(elev: np.ndarray, version_year: int) -> tuple[np.ndarray, np.ndarray]:
    """Tile version year -> Jan 1 of that year (month unknown; conservative), uncertainty from SOURCES."""
    if isinstance(version_year, bool) or not isinstance(version_year, int):
        raise ValueError(f"version_year: expected an int year like 2023, got {type(version_year).__name__} {version_year!r}")
    day = parse_meta_date(dt.date(version_year, 1, 1) if 1 <= version_year <= 9999 else version_year, "version_year")
    return constant_meta(elev, day, SOURCES["cudem"].unc_ft)


def _date_lookup(table: Mapping[Any, Any]) -> dict[int, int]:
    """id -> days since epoch from values that are ISO dates or bare 4-digit years (int or str)."""
    out: dict[int, int] = {}
    for k, v in table.items():
        name = f"table[{k}]"
        if isinstance(v, bool):
            raise ValueError(f"{name}: bool is not a date")
        if isinstance(v, int) or (isinstance(v, str) and v.isdigit() and len(v) == 4):
            year = int(v)
            if not (1 <= year <= 9999):
                raise ValueError(f"{name}: {v!r} is not a year (an int must be a 4-digit year, not e.g. 20140915)")
            out[int(k)] = parse_meta_date(dt.date(year, 1, 1), name, TABLE_MIN_DATE)
        else:
            out[int(k)] = parse_meta_date(v, name, TABLE_MIN_DATE)
    return out


def dates_from_ids(ids: np.ndarray, table: Mapping[Any, Any]) -> np.ndarray:
    """Map an integer id raster to int32 days via ``table``; unknown ids -> DATE_NODATA."""
    lut = _date_lookup(table)
    out = np.full(ids.shape, DATE_NODATA, dtype=np.int32)
    for k, day in lut.items():
        out[ids == k] = day
    return out


def bluetopo_meta(elev: np.ndarray, contributor: np.ndarray, rat: Mapping[Any, Any],
                  uncertainty_m: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """BlueTopo per-cell date (RAT ``survey_date_end`` by contributor id) and uncertainty (m -> ft)."""
    m = covered(elev)
    dates = dates_from_ids(contributor, rat)
    dates = np.where(m, dates, np.int32(DATE_NODATA)).astype(np.int32)
    if uncertainty_m is None:
        unc = np.full(elev.shape, np.nan, dtype=np.float32)
    else:
        unc = (np.asarray(uncertainty_m, dtype=np.float64) * FT_PER_M).astype(np.float32)
        unc = np.where(m & np.isfinite(unc) & (unc >= 0), unc, np.float32(np.nan)).astype(np.float32)  # negative = bad data
    return dates, unc


def coned_meta(elev: np.ndarray, source_survey: np.ndarray, survey_dates: Mapping[Any, Any],
               unc_ft: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """CoNED: date from the shipped source-survey raster. Uncertainty is not published per cell;
    ``unc_ft`` is a placeholder (TODO: derive from each contributing survey's reported accuracy)."""
    m = covered(elev)
    dates = np.where(m, dates_from_ids(source_survey, survey_dates), np.int32(DATE_NODATA)).astype(np.int32)
    unc = np.where(m, np.float32(unc_ft), np.float32(np.nan)).astype(np.float32)
    return dates, unc


def read_bluetopo_rat(path: str | Path) -> dict[int, str]:
    """Decode the BlueTopo contributor RAT -> ``{contributor_id: survey_date_end}`` (lazy GDAL import).

    TODO(S0-3): verify RAT column names against a real tile (``value``/``survey_date_end``).
    """
    from osgeo import gdal  # lazy

    ds = gdal.Open(str(path))
    band = ds.GetRasterBand(3)
    rat = band.GetDefaultRAT()
    if rat is None:
        raise ValueError(f"{path}: no raster attribute table on band 3")
    cols = {rat.GetNameOfCol(i).lower(): i for i in range(rat.GetColumnCount())}
    id_col = cols.get("value", 0)
    date_col = cols.get("survey_date_end") if "survey_date_end" in cols else cols.get("survey_date")
    if date_col is None:
        raise ValueError(f"{path}: RAT has no survey date column ({sorted(cols)})")
    return {int(rat.GetValueAsInt(r, id_col)): rat.GetValueAsString(r, date_col)[:10] for r in range(rat.GetRowCount())}


def build_arrays(source: str, elev: np.ndarray, meta: Mapping[str, Any],
                 contributor: np.ndarray | None = None, uncertainty_m: np.ndarray | None = None,
                 table: Mapping[Any, Any] | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Dispatch on source name (see :data:`pipeline.common.SOURCES`)."""
    if source not in SOURCES:
        raise ValueError(f"unknown source {source!r}")
    if source in ("lidar_2014", "lidar_ncmp", "wa_lidar"):
        return lidar_meta(elev, _need(meta, "flight_date", source), source)
    if source == "ehydro":
        return ehydro_meta(elev, _need(meta, "survey_date", source))
    if source == "cudem":
        return cudem_meta(elev, _need(meta, "version_year", source))
    if source == "bluetopo":
        if contributor is None or table is None:
            raise ValueError("bluetopo needs contributor raster and RAT table")
        return bluetopo_meta(elev, contributor, table, uncertainty_m)
    if source == "coned":
        if contributor is None or table is None:
            raise ValueError("coned needs source-survey raster and id->date table")
        return coned_meta(elev, contributor, table)
    raise ValueError(f"no date/uncertainty policy for {source!r}")


#: Sources whose dates/uncertainty are per-cell rasters shipped with the data: they cannot be rebuilt per file.
PER_CELL_SOURCES = ("bluetopo", "coned")


def mosaic_with_dates(source: str, elevs: Sequence[np.ndarray], metas: Sequence[Mapping[str, Any]],
                      ref_date: int | None = None):
    """Combine several separately warped files of ONE source whose per-file metadata differ
    (e.g. CUDEM tiles of different version years) while keeping each file's own date and
    uncertainty per cell. Overlaps resolve exactly like the cross-source merge (newest wins,
    ties to lower uncertainty, then file order). Returns ``(elev, date, unc)``.

    A single mosaic with one date per source would silently stamp the wrong date on some cells
    and make newest-wins pick the wrong source, so mixed metadata is never collapsed.
    """
    from .merge import merge_stack  # local: merge imports common only, avoids import-time coupling

    if source in PER_CELL_SOURCES:
        raise MixedMetaError(f"{source}: per-cell date rasters cannot be rebuilt per file; "
                             "provide contributor/uncertainty rasters instead of per-file meta")
    if not 1 <= len(elevs) <= 255 or len(elevs) != len(metas):
        raise ValueError("need 1..255 files with one meta dict each")
    dates, uncs = zip(*(build_arrays(source, e, m) for e, m in zip(elevs, metas)))
    ref = ref_date if ref_date is not None else days_since_epoch(dt.date.today())
    res = merge_stack(np.stack(elevs), np.stack(dates), np.stack(uncs), list(range(1, len(elevs) + 1)), ref)
    return res.elev, res.date, res.unc


def _need(meta: Mapping[str, Any], key: str, source: str) -> Any:
    if key not in meta:
        raise ValueError(f"{source}: manifest meta lacks {key!r} (register with --meta '{{\"{key}\": ...}}')")
    return meta[key]


def run(aoi: str, data_dir: Path) -> None:
    import rasterio  # lazy

    align_dir = step_dir(data_dir, aoi, "align")
    manifest = Manifest.load(align_dir, aoi, "align")
    manifest.verify(kinds=["dem"])
    for source in manifest.sources("dem"):
        sdir = align_dir / source
        meta = manifest.select(source=source)[0].meta
        if meta.get("per_file_meta"):  # align already wrote date.tif/unc.tif per file
            for f in ("date.tif", "unc.tif"):
                if not (sdir / f).exists():
                    raise FileNotFoundError(f"{sdir / f} missing; rerun `align --stage warp`")
            continue
        with rasterio.open(sdir / "elev.tif") as ds:
            elev = ds.read(1).astype(np.float32)
            profile = clean_profile(ds.profile)
        contributor = unc_m = table = None
        if (sdir / "contributor.tif").exists():
            with rasterio.open(sdir / "contributor.tif") as c:
                contributor = c.read(1)
        if (sdir / "uncertainty.tif").exists():
            with rasterio.open(sdir / "uncertainty.tif") as u:
                unc_m = u.read(1).astype(np.float32)
        if (sdir / "rat.json").exists():
            table = json.loads((sdir / "rat.json").read_text())
        date, unc = build_arrays(source, elev, meta, contributor, unc_m, table)
        for name, arr, dtype, nodata in (("date", date, "int32", DATE_NODATA), ("unc", unc, "float32", float("nan"))):
            prof = dict(profile)
            prof.update(tiled=True, dtype=dtype, nodata=nodata, count=1, compress="deflate")
            with rasterio.open(sdir / f"{name}.tif", "w", **prof) as dst:
                dst.write(arr, 1)


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    a = p.parse_args(argv)
    run(a.aoi, a.data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
