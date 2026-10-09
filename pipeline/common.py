"""Shared constants, source registry, path helpers and the per-step manifest.

Everything here is pure Python (stdlib only) so every other module can import it
without GDAL/rasterio/pyproj being installed.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

# --------------------------------------------------------------------------
# Grid / geodesy contract (AGENT-PLAN.md "Geodesy & grid")
# --------------------------------------------------------------------------
AOI_SLUGS: tuple[str, ...] = ("skagit", "port_susan", "snohomish", "padilla_samish", "nisqually")

WORK_EPSG = 32610
WORK_CRS = "EPSG:32610"  # UTM 10N, WGS84
OUT_CRS = "EPSG:3857"  # tiles only, at the very end
CELL_M = 2.0  # working-grid cell size, metres
SNAP_M = 1000.0  # grid origin snapped to a multiple of this, metres

FT_PER_M = 3.280839895013123  # international foot
TARGET_DATUM = "MLLW"
TARGET_UNITS = "ft"

#: Depth colour ramp breakpoints (ft MLLW). Owned by the app; mirrored here for tiles QA.
DEPTH_RAMP_FT: tuple[int, ...] = (0, 3, 6, 10, 20, 40)

#: Zoom ranges per tile product (PRD step 8 / AGENT-PLAN).
ZOOMS: dict[str, tuple[int, int]] = {
    "base": (8, 16),
    "depth": (8, 16),
    "waterline": (10, 16),
    "fleet": (10, 16),
}
TILE_KINDS: tuple[str, ...] = ("base", "depth", "waterline", "fleet")

#: Expected MHHW height above MLLW (ft) near each AOI's shoreline, used by the mandatory
#: shoreline datum check in validate.py (window = value +/- SHORELINE_TOL_FT). A forgotten or
#: sign-flipped NAVD88->MLLW offset moves the shoreline by ~2x the 2.4 ft offset, far outside it.
#: TODO-verify every value against the NOAA tidal-datum benchmark sheets (S0-4); these are
#: estimates interpolated from the nearest published stations (Seattle MHHW is 11.36 ft).
AOI_MHHW_FT: dict[str, float] = {
    "skagit": 10.0,  # TODO-verify (La Conner / Skagit Bay)
    "port_susan": 10.8,  # TODO-verify (Stanwood / Port Susan)
    "snohomish": 11.4,  # TODO-verify (Everett)
    "padilla_samish": 9.0,  # TODO-verify (Padilla / Samish Bay)
    "nisqually": 13.7,  # TODO-verify (Nisqually Reach; south Sound range is larger than Seattle)
}
SHORELINE_TOL_FT = 1.5

#: Vertical-uncertainty buckets packed into the depth_meta tiles (mobile mirrors these constants).
#: Index 0..14 are the levels below (a value is rounded UP to the next level; anything >= 45 ft
#: clamps to index 14 = "45+"). Index 15 means UNKNOWN uncertainty and is used for nothing else.
UNC_LEVELS_FT: tuple[float, ...] = (0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0, 15.0, 20.0, 45.0)
UNC_UNKNOWN_INDEX = 15

# --------------------------------------------------------------------------
# Dates
# --------------------------------------------------------------------------
EPOCH = _dt.date(1970, 1, 1)
DATE_NODATA = -2147483648  # int32 min: "no date" sentinel in every date raster
TEN_YEARS_DAYS = 3652  # PRD merge rule: older than 10 years => skipped if a newer source covers the cell


def days_since_epoch(d: _dt.date | _dt.datetime | str) -> int:
    """Days since 1970-01-01 for a date, datetime or ISO string (date part used)."""
    if isinstance(d, str):
        d = _dt.date.fromisoformat(d[:10])
    if isinstance(d, _dt.datetime):
        d = d.date()
    return (d - EPOCH).days


def date_from_days(n: int) -> _dt.date:
    return EPOCH + _dt.timedelta(days=int(n))


# --------------------------------------------------------------------------
# Vertical CRS metadata (rejects rasters that do not record it)
# --------------------------------------------------------------------------
VERT_TAG = "VERTICAL_CRS"
UNITS_TAG = "VERTICAL_UNITS"
KNOWN_DATUMS = ("NAVD88", "MLLW")
KNOWN_UNITS = ("m", "ft")


class MissingVerticalCRS(ValueError):
    """Raised when a raster has no (or an unrecognised) vertical CRS metadata."""


class MixedMetaError(ValueError):
    """Files of one source disagree on date/uncertainty metadata in a way we cannot mosaic safely."""


def require_vertical_crs(tags: dict[str, str] | None, name: str = "raster") -> tuple[str, str]:
    """Return ``(datum, units)`` from raster tags or raise :class:`MissingVerticalCRS`."""
    tags = tags or {}
    datum = (tags.get(VERT_TAG) or "").strip().upper()
    units = (tags.get(UNITS_TAG) or "").strip().lower()
    if not datum:
        raise MissingVerticalCRS(f"{name}: no {VERT_TAG} tag; refusing to use a raster of unknown vertical datum")
    if datum not in KNOWN_DATUMS:
        raise MissingVerticalCRS(f"{name}: unknown vertical datum {datum!r}")
    if units not in KNOWN_UNITS:
        raise MissingVerticalCRS(f"{name}: missing/unknown {UNITS_TAG} {units!r}")
    return datum, units


def require_mllw_ft(tags: dict[str, str] | None, name: str = "raster") -> None:
    """Merge-time gate: only MLLW / ft rasters may enter the merge."""
    datum, units = require_vertical_crs(tags, name)
    if datum != TARGET_DATUM or units != TARGET_UNITS:
        raise MissingVerticalCRS(f"{name}: expected {TARGET_DATUM}/{TARGET_UNITS}, got {datum}/{units}")


def vertical_tags(datum: str = TARGET_DATUM, units: str = TARGET_UNITS, **extra: str) -> dict[str, str]:
    tags = {VERT_TAG: datum, UNITS_TAG: units}
    tags.update({k: str(v) for k, v in extra.items()})
    return tags


# --------------------------------------------------------------------------
# Source registry (PRD step 4 table). Dict order = final tie-break priority.
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class SourceSpec:
    name: str
    code: int  # uint8 code written to merged_src.tif; 0 is reserved for "no data"
    label: str
    unc_ft: float | None  # default vertical uncertainty; None = per-cell from the source
    date_policy: str  # human readable, see source_meta.py


SOURCES: dict[str, SourceSpec] = {
    s.name: s
    for s in (
        SourceSpec("bluetopo", 1, "NOAA BlueTopo", None, "per-cell survey date from BlueTopo RAT"),
        SourceSpec("ehydro", 2, "USACE eHydro", 0.5, "survey date"),
        SourceSpec("lidar_ncmp", 3, "USACE NCMP topobathy lidar 2020/21", 0.5, "flight date"),
        SourceSpec("lidar_2014", 4, "USACE/USGS topobathy lidar 2014", 0.5, "flight date"),
        SourceSpec("wa_lidar", 5, "WA DNR lidar portal", 0.5, "flight date"),
        SourceSpec("cudem", 6, "NOAA NCEI CUDEM 1/9 arc-sec", 1.0, "tile version year (Jan 1)"),
        SourceSpec("coned", 7, "USGS CoNED Puget Sound TBDEM", None, "per-cell source-survey raster"),
        SourceSpec("waterline", 8, "Sentinel-2 waterline DEM", None, "newest usable scene, bracket/2"),
    )
}
SOURCE_BY_CODE: dict[int, SourceSpec] = {s.code: s for s in SOURCES.values()}
#: Waterline is its own layer; it only joins the merge with ``--include-waterline``.
BASELINE_SOURCES: tuple[str, ...] = tuple(n for n in SOURCES if n != "waterline")


# --------------------------------------------------------------------------
# Paths and manifests
# --------------------------------------------------------------------------
def default_data_dir() -> Path:
    return Path("data")


def step_dir(data_dir: str | Path, aoi: str, step: str) -> Path:
    if aoi not in AOI_SLUGS:
        raise ValueError(f"unknown AOI {aoi!r}; expected one of {AOI_SLUGS}")
    return Path(data_dir) / aoi / step


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class ManifestEntry:
    path: str  # relative to the manifest's directory
    source_url: str | None
    download_date: str
    sha256: str
    crs: str | None
    bytes: int
    source: str | None = None  # key into SOURCES (or "sentinel2", "enc", "tides", ...)
    kind: str = "dem"  # dem | laz | scene_band | vector | other
    vertical_crs: str | None = None
    vertical_units: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class Manifest:
    """``manifest.json`` for one pipeline step of one AOI (source URL, date, checksum, CRS per file)."""

    #: kinds whose CRS is read from the file itself when the caller does not supply one
    RASTER_KINDS = ("dem", "scene_band")

    def __init__(self, directory: str | Path, aoi: str, step: str = "fetch",
                 crs_reader: Callable[[Path], str | None] | None = None) -> None:
        self.directory = Path(directory)
        self.aoi = aoi
        self.step = step
        self.entries: list[ManifestEntry] = []
        self.crs_reader = crs_reader or read_raster_crs

    @property
    def path(self) -> Path:
        return self.directory / "manifest.json"

    def _relative(self, p: Path) -> str:
        """Manifest-relative POSIX path for ``p`` (given relative to the manifest dir, or under it)."""
        if not p.is_absolute() and not p.is_relative_to(self.directory) and (self.directory / p).exists():
            return p.as_posix()
        return p.relative_to(self.directory).as_posix()

    def add_file(
        self,
        file_path: str | Path,
        *,
        source_url: str | None,
        crs: str | None = None,
        source: str | None = None,
        kind: str = "dem",
        vertical_crs: str | None = None,
        vertical_units: str | None = None,
        meta: dict[str, Any] | None = None,
        download_date: str | None = None,
    ) -> ManifestEntry:
        rel = self._relative(Path(file_path))
        full = self.directory / rel
        if crs is None and kind in self.RASTER_KINDS:
            crs = self.crs_reader(full)  # populated from the dataset after download
            if not crs:
                raise ValueError(f"{full}: raster has no CRS; refusing to record it in the manifest")
        entry = ManifestEntry(
            path=rel,
            source_url=source_url,
            download_date=download_date or utc_now_iso(),
            sha256=sha256_file(full),
            crs=crs,
            bytes=full.stat().st_size,
            source=source,
            kind=kind,
            vertical_crs=vertical_crs,
            vertical_units=vertical_units,
            meta=dict(meta or {}),
        )
        # replace an existing entry for the same path (reruns are safe)
        self.entries = [e for e in self.entries if e.path != rel] + [entry]
        return entry

    def select(self, *, source: str | None = None, kind: str | None = None) -> list[ManifestEntry]:
        return [e for e in self.entries if (source is None or e.source == source) and (kind is None or e.kind == kind)]

    def sources(self, kind: str | None = None) -> list[str]:
        seen: list[str] = []
        for e in self.entries:
            if e.source and (kind is None or e.kind == kind) and e.source not in seen:
                seen.append(e.source)
        return seen

    def to_dict(self) -> dict[str, Any]:
        return {
            "aoi": self.aoi,
            "step": self.step,
            "created_at": utc_now_iso(),
            "files": [e.__dict__ for e in sorted(self.entries, key=lambda e: e.path)],
        }

    def save(self) -> Path:
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.to_dict(), indent=2, sort_keys=True) + "\n")
        return self.path

    @classmethod
    def load(cls, directory: str | Path, aoi: str, step: str = "fetch",
             crs_reader: Callable[[Path], str | None] | None = None) -> "Manifest":
        m = cls(directory, aoi, step, crs_reader)
        if m.path.exists():
            data = json.loads(m.path.read_text())
            m.entries = [ManifestEntry(**f) for f in data.get("files", [])]
        return m


def clean_profile(profile: dict[str, Any]) -> dict[str, Any]:
    """Copy of a rasterio profile without block sizes, so forcing ``tiled=True`` cannot inherit an
    invalid strip layout (blockysize=1 etc.) from the source file."""
    out = dict(profile)
    out.pop("blockxsize", None)
    out.pop("blockysize", None)
    return out


def read_raster_crs(path: str | Path) -> str | None:
    """CRS string of a raster on disk (lazy rasterio import)."""
    import rasterio  # lazy

    with rasterio.open(path) as ds:
        return ds.crs.to_string() if ds.crs else None


def uniform_meta(entries: Iterable["ManifestEntry"]) -> dict[str, Any] | None:
    """The shared ``meta`` of manifest entries, or None when files of one source disagree
    (e.g. CUDEM tiles of different version years: dates must then be tracked per file)."""
    metas = [e.meta for e in entries]
    if not metas:
        return {}
    return metas[0] if all(m == metas[0] for m in metas[1:]) else None


def chunks(seq: Iterable[Any], n: int) -> Iterable[list[Any]]:
    buf: list[Any] = []
    for item in seq:
        buf.append(item)
        if len(buf) == n:
            yield buf
            buf = []
    if buf:
        yield buf
