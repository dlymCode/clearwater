"""Step 1 - fetch: per-AOI baseline downloads.

    python -m pipeline.fetch_baseline --aoi skagit [--dry-run]

Pulls CUDEM tiles intersecting the AOI, BlueTopo tiles, Sentinel-2 B03/B08/SCL windows
(<15 % cloud, last 3 years) and tags every scene with the CO-OPS tide height at its
timestamp from the *nearest* station (not Seattle). Writes
``data/<aoi>/fetch/manifest.json`` and ``data/<aoi>/fetch/scenes.json``.

Importing this module never touches the network or GDAL; each external service sits
behind a small class whose heavy imports happen inside methods, so tests inject fakes.

Manual (once per AOI, then ``--register``): CoNED tiles, 2014 and 2020/21 lidar from the
Digital Coast DAV, eHydro XYZ, ENC cells, VDatum grids.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from . import coops
from .common import AOI_SLUGS, Manifest, step_dir

BBox = tuple[float, float, float, float]  # (west, south, east, north) lon/lat


@dataclass(frozen=True)
class AOI:
    slug: str
    name: str
    bbox: BBox  # lon/lat WGS84


#: The five beta AOIs (PRD "AOIs for the beta"). Boxes are generous around the tidal flats.
AOIS: dict[str, AOI] = {
    a.slug: a
    for a in (
        AOI("skagit", "Skagit Bay and flats", (-122.60, 48.26, -122.36, 48.42)),
        AOI("port_susan", "Port Susan and the Stillaguamish", (-122.50, 48.12, -122.25, 48.28)),
        AOI("snohomish", "Snohomish delta", (-122.30, 47.93, -122.14, 48.06)),
        AOI("padilla_samish", "Padilla and Samish Bay", (-122.60, 48.44, -122.40, 48.62)),
        AOI("nisqually", "Nisqually delta", (-122.76, 47.05, -122.62, 47.14)),
    )
}
assert tuple(AOIS) == AOI_SLUGS

CUDEM_BASE_URL = "https://chs.coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/wash_pugetsound/"
STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
S2_COLLECTION = "sentinel-2-l2a"
S2_BANDS = ("B03", "B08", "SCL")
MAX_CLOUD_PCT = 15.0
S2_YEARS = 3


# ------------------------------------------------------------------ geometry helpers
def bbox_intersects(a: BBox, b: BBox) -> bool:
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def bbox_of_coords(coords: Any) -> BBox:
    xs: list[float] = []
    ys: list[float] = []

    def walk(c: Any) -> None:
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            xs.append(float(c[0]))
            ys.append(float(c[1]))
        else:
            for item in c:
                walk(item)

    walk(coords)
    return (min(xs), min(ys), max(xs), max(ys))


# ------------------------------------------------------------------ CUDEM
@dataclass(frozen=True)
class TileRecord:
    name: str
    url: str
    bbox: BBox


def parse_version_year(name: str) -> int | None:
    """CUDEM tile names carry a version like ``2023v1`` -> 2023."""
    m = re.search(r"(20\d{2})v\d+", name)
    return int(m.group(1)) if m else None


def tiles_from_geojson(index: dict, base_url: str = CUDEM_BASE_URL) -> list[TileRecord]:
    """Tile index as GeoJSON (``ogr2ogr -f GeoJSON -t_srs EPSG:4326`` of NOAA's tileindex shapefile)."""
    out: list[TileRecord] = []
    for f in index.get("features", []):
        props = f.get("properties") or {}
        name = props.get("url") or props.get("location") or props.get("tile") or props.get("name")
        if not name or not f.get("geometry"):
            continue
        url = name if name.startswith("http") else base_url + Path(name).name
        out.append(TileRecord(Path(name).name, url, bbox_of_coords(f["geometry"]["coordinates"])))
    return out


def select_tiles(tiles: Iterable[TileRecord], bbox: BBox) -> list[TileRecord]:
    return sorted((t for t in tiles if bbox_intersects(t.bbox, bbox)), key=lambda t: t.name)


def http_download(url: str, dest: Path, timeout: float = 300.0) -> None:
    """Atomic download: stream to ``<dest>.part`` and rename on success, so an interrupted run
    never leaves a truncated file that a rerun would mistake for a finished download."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "clearwater-pipeline"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(part, "wb") as fh:  # noqa: S310
            shutil.copyfileobj(resp, fh)
        os.replace(part, dest)
    finally:
        if part.exists():
            part.unlink()


class CudemFetcher:
    """CUDEM 1/9 arc-second tiles from the NOAA Digital Coast bulk folder."""

    def __init__(self, tile_index: list[TileRecord] | None = None, index_path: Path | None = None,
                 download: Callable[[str, Path], None] = http_download) -> None:
        self._tiles = tile_index
        self._index_path = index_path
        self._download = download

    def tile_index(self) -> list[TileRecord]:
        if self._tiles is None:
            if self._index_path is None:
                raise RuntimeError(
                    "CUDEM tile index not provided. Convert NOAA's tileindex shapefile with "
                    "`ogr2ogr -f GeoJSON -t_srs EPSG:4326 tileindex.geojson <tileindex.shp>` and pass --cudem-index."
                )
            self._tiles = tiles_from_geojson(json.loads(Path(self._index_path).read_text()))
        return self._tiles

    def plan(self, aoi: AOI) -> list[TileRecord]:
        return select_tiles(self.tile_index(), aoi.bbox)

    def fetch(self, aoi: AOI, out_dir: Path, manifest: Manifest) -> list[Path]:
        paths: list[Path] = []
        for t in self.plan(aoi):
            dest = out_dir / "cudem" / t.name
            if not dest.exists():  # reruns are safe
                self._download(t.url, dest)
            vy = parse_version_year(t.name)
            manifest.add_file(dest, source_url=t.url, source="cudem", kind="dem",
                              vertical_crs="NAVD88", vertical_units="m",
                              meta={"version_year": vy} if vy else {})
            paths.append(dest)
        return paths


# ------------------------------------------------------------------ BlueTopo
class BlueTopoFetcher:
    """Wrapper around the NOAA ``BlueTopo`` package (``pip install BlueTopo``, import ``nbs.bluetopo``).

    The package import is lazy and the callable is injectable so this is mockable. The
    exact ``fetch_tiles`` signature should be confirmed against the pinned BlueTopo
    version in S0-3 (TODO: not verifiable offline).
    """

    def __init__(self, fetch_fn: Callable[..., Any] | None = None) -> None:
        self._fetch_fn = fetch_fn

    def _fn(self) -> Callable[..., Any]:
        if self._fetch_fn is None:
            from nbs.bluetopo import fetch_tiles  # lazy: heavy GDAL-dependent package

            self._fetch_fn = fetch_tiles
        return self._fetch_fn

    @staticmethod
    def aoi_geojson(aoi: AOI) -> dict:
        w, s, e, n = aoi.bbox
        ring = [[w, s], [e, s], [e, n], [w, n], [w, s]]
        return {"type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {"name": aoi.slug},
                              "geometry": {"type": "Polygon", "coordinates": [ring]}}]}

    def fetch(self, aoi: AOI, out_dir: Path, manifest: Manifest) -> list[Path]:
        root = out_dir / "bluetopo"
        root.mkdir(parents=True, exist_ok=True)
        area = root / "aoi.geojson"
        area.write_text(json.dumps(self.aoi_geojson(aoi)))
        self._fn()(str(root), desired_area_filename=str(area))
        found = sorted(root.rglob("*.tiff")) + sorted(root.rglob("*.tif"))
        for p in found:
            # BlueTopo tiles are MLLW metres; the fetcher verifies published checksums itself.
            manifest.add_file(p, source_url="s3://noaa-ocs-nationalbathymetry-pds/BlueTopo/",
                              source="bluetopo", kind="dem", vertical_crs="MLLW", vertical_units="m")
        return found


# ------------------------------------------------------------------ tides
class TideTagger:
    """Tide height (ft MLLW) at an instant from the nearest CO-OPS station, via hi/lo cosine interpolation."""

    def __init__(self, client: coops.CoopsClient | None = None, stations: Sequence[coops.Station] = coops.ALL_STATIONS,
                 http_get: coops.HttpGet = coops.default_http_get) -> None:
        self.client = client or coops.CoopsClient(http_get)
        self._http_get = http_get
        self._stations_in = tuple(stations)
        self._stations: list[coops.Station] | None = None
        self._events: dict[str, list[coops.Event]] = {}

    @property
    def stations(self) -> list[coops.Station]:
        if self._stations is None:
            resolved, unresolved = coops.resolve_stations(self._stations_in, self._http_get)
            for s in unresolved:
                print(f"warning: could not resolve CO-OPS station {s.name!r}; skipped", file=sys.stderr)
            self._stations = resolved
        return self._stations

    def station_for(self, aoi: AOI) -> coops.Station:
        w, s, e, n = aoi.bbox
        return coops.nearest_station((w + e) / 2, (s + n) / 2, self.stations)

    def height(self, station: coops.Station, when: dt.datetime, window: tuple[dt.datetime, dt.datetime]) -> float:
        assert station.id
        if station.id not in self._events:
            pad = dt.timedelta(days=2)
            self._events[station.id] = self.client.hilo(station.id, window[0] - pad, window[1] + pad)
        return coops.cosine_interpolate(self._events[station.id], when)


# ------------------------------------------------------------------ Sentinel-2
@dataclass
class SceneRecord:
    id: str
    datetime: str  # ISO-8601 UTC
    cloud_cover: float
    bbox: list[float]
    assets: dict[str, str]  # band -> href (signed at search time for Planetary Computer)
    station_id: str | None = None
    tide_ft: float | None = None
    files: dict[str, str] = field(default_factory=dict)  # band -> path relative to fetch/ once downloaded


def scene_window(today: dt.date | None = None, years: int = S2_YEARS) -> str:
    """STAC datetime interval covering the last ``years`` years."""
    today = today or dt.date.today()
    try:
        start = today.replace(year=today.year - years)
    except ValueError:  # Feb 29
        start = today.replace(year=today.year - years, day=28)
    return f"{start.isoformat()}/{today.isoformat()}"


def parse_item(item: dict) -> SceneRecord | None:
    """Convert a STAC item (dict form) to a SceneRecord; None if a required band is missing."""
    assets = item.get("assets", {})
    if not all(b in assets for b in S2_BANDS):
        return None
    props = item.get("properties", {})
    return SceneRecord(
        id=item["id"],
        datetime=props["datetime"],
        cloud_cover=float(props.get("eo:cloud_cover", 100.0)),
        bbox=list(item.get("bbox", [])),
        assets={b: assets[b]["href"] for b in S2_BANDS},
    )


class Sentinel2Searcher:
    """STAC search (Planetary Computer) and windowed band download."""

    def __init__(self, client_factory: Callable[[], Any] | None = None) -> None:
        self._client_factory = client_factory

    def _client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory()
        import planetary_computer  # lazy
        from pystac_client import Client  # lazy

        return Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)

    def search(self, aoi: AOI, interval: str, max_cloud: float = MAX_CLOUD_PCT) -> list[SceneRecord]:
        search = self._client().search(
            collections=[S2_COLLECTION], bbox=list(aoi.bbox), datetime=interval,
            query={"eo:cloud_cover": {"lt": max_cloud}},
        )
        scenes = [s for s in (parse_item(i.to_dict()) for i in search.items()) if s]
        return sorted(scenes, key=lambda s: s.datetime)

    def download(self, scene: SceneRecord, aoi: AOI, out_dir: Path, manifest: Manifest) -> None:
        """Read the AOI window of each band COG and write a local GeoTIFF."""
        import rasterio  # lazy
        from rasterio.warp import transform_bounds
        from rasterio.windows import from_bounds

        for band, href in scene.assets.items():
            dest = out_dir / "s2" / scene.id / f"{band}.tif"
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                with rasterio.open(href) as src:
                    b = transform_bounds("EPSG:4326", src.crs, *aoi.bbox)
                    win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
                    # boundless: an AOI window that spills over the scene edge is padded with 0
                    # (SCL 0 = no data; B03/B08 0 are excluded by the NDWI denominator test)
                    data = src.read(1, window=win, boundless=True, fill_value=0)
                    profile = dict(src.profile)
                    profile.update(driver="GTiff", height=data.shape[0], width=data.shape[1],
                                   transform=src.window_transform(win), compress="deflate")
                    for k in ("blockxsize", "blockysize", "tiled"):
                        profile.pop(k, None)
                part = dest.with_name(dest.name + ".part")
                with rasterio.open(part, "w", **profile) as dst:
                    dst.write(data, 1)
                os.replace(part, dest)
            manifest.add_file(dest, source_url=href.split("?")[0], source="sentinel2", kind="scene_band")
            scene.files[band] = dest.relative_to(out_dir).as_posix()


# ------------------------------------------------------------------ orchestration
def tag_scenes(scenes: list[SceneRecord], aoi: AOI, tagger: TideTagger, window: tuple[dt.datetime, dt.datetime]) -> None:
    station = tagger.station_for(aoi)
    if aoi.slug == "nisqually" and station.id == "9446484":
        print("warning: nisqually scenes are tide-tagged from Tacoma (9446484); select a nearer subordinate "
              "station from the CO-OPS metadata API (S0 TODO, see coops.py)", file=sys.stderr)
    for s in scenes:
        when = dt.datetime.fromisoformat(s.datetime.replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=dt.timezone.utc)
        s.station_id = station.id
        s.tide_ft = round(tagger.height(station, when, window), 3)


def write_scenes_json(path: Path, aoi: AOI, scenes: list[SceneRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"aoi": aoi.slug, "scenes": [asdict(s) for s in scenes]}
    path.write_text(json.dumps(payload, indent=2) + "\n")


def plan_text(aoi: AOI, interval: str, cudem_tiles: list[TileRecord] | None) -> str:
    lines = [f"AOI {aoi.slug} ({aoi.name}) bbox={aoi.bbox}",
             f"  sentinel-2: {S2_COLLECTION} cloud<{MAX_CLOUD_PCT:g}% {interval} bands={','.join(S2_BANDS)}",
             "  bluetopo: nbs.bluetopo fetch_tiles for AOI polygon"]
    if cudem_tiles is None:
        lines.append("  cudem: tile index not loaded")
    else:
        lines.append(f"  cudem: {len(cudem_tiles)} tiles " + ", ".join(t.name for t in cudem_tiles))
    return "\n".join(lines)


def run(aoi_slug: str, data_dir: Path, *, skip: set[str] | None = None, today: dt.date | None = None,
        cudem: CudemFetcher | None = None, bluetopo: BlueTopoFetcher | None = None,
        s2: Sentinel2Searcher | None = None, tagger: TideTagger | None = None,
        download_scenes: bool = True, crs_reader=None) -> Manifest:
    skip = skip or set()
    aoi = AOIS[aoi_slug]
    out = step_dir(data_dir, aoi_slug, "fetch")
    out.mkdir(parents=True, exist_ok=True)
    manifest = Manifest.load(out, aoi_slug, "fetch", crs_reader)
    today = today or dt.date.today()
    interval = scene_window(today)

    if "cudem" not in skip:
        (cudem or CudemFetcher()).fetch(aoi, out, manifest)
    if "bluetopo" not in skip:
        (bluetopo or BlueTopoFetcher()).fetch(aoi, out, manifest)
    if "s2" not in skip:
        searcher = s2 or Sentinel2Searcher()
        scenes = searcher.search(aoi, interval)
        start, end = (dt.datetime.fromisoformat(x).replace(tzinfo=dt.timezone.utc) for x in interval.split("/"))
        tag_scenes(scenes, aoi, tagger or TideTagger(), (start, end + dt.timedelta(days=1)))
        if download_scenes:
            for sc in scenes:
                searcher.download(sc, aoi, out, manifest)
        write_scenes_json(out / "scenes.json", aoi, scenes)
    manifest.save()
    return manifest


def register_manual(aoi_slug: str, data_dir: Path, file_path: Path, *, source: str, source_url: str | None,
                    vertical_crs: str | None, vertical_units: str | None, kind: str = "dem",
                    meta: dict[str, Any] | None = None, crs_reader=None) -> Manifest:
    """Record a manually downloaded file (CoNED, lidar, eHydro, ...) in the fetch manifest."""
    out = step_dir(data_dir, aoi_slug, "fetch")
    out.mkdir(parents=True, exist_ok=True)
    dest = out / source / file_path.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if file_path.resolve() != dest.resolve():
        shutil.copy2(file_path, dest)
    manifest = Manifest.load(out, aoi_slug, "fetch", crs_reader)
    manifest.add_file(dest, source_url=source_url, source=source, kind=kind, vertical_crs=vertical_crs,
                      vertical_units=vertical_units, meta=meta)
    manifest.save()
    return manifest


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True, choices=AOI_SLUGS)
    p.add_argument("--data-dir", default="data", type=Path)
    p.add_argument("--skip", default="", help="comma list of: cudem,bluetopo,s2")
    p.add_argument("--cudem-index", type=Path, help="CUDEM tile index as GeoJSON")
    p.add_argument("--no-scene-download", action="store_true", help="search + tide-tag only")
    p.add_argument("--dry-run", action="store_true", help="print the plan; no network access for downloads")
    reg = p.add_argument_group("register a manually downloaded file")
    reg.add_argument("--register", type=Path)
    reg.add_argument("--source")
    reg.add_argument("--source-url")
    reg.add_argument("--vertical-crs", choices=["NAVD88", "MLLW"])
    reg.add_argument("--units", choices=["m", "ft"])
    reg.add_argument("--kind", default="dem", choices=["dem", "laz", "vector", "other"])
    reg.add_argument("--meta", default="{}", help='JSON, e.g. \'{"survey_date": "2014-09-15"}\'')
    a = p.parse_args(argv)

    if a.register:
        if not a.source:
            p.error("--register requires --source")
        register_manual(a.aoi, a.data_dir, a.register, source=a.source, source_url=a.source_url,
                        vertical_crs=a.vertical_crs, vertical_units=a.units, kind=a.kind, meta=json.loads(a.meta))
        return 0

    aoi = AOIS[a.aoi]
    cudem = CudemFetcher(index_path=a.cudem_index)
    if a.dry_run:
        tiles = None
        if a.cudem_index:
            tiles = cudem.plan(aoi)
        print(plan_text(aoi, scene_window(), tiles))
        return 0
    run(a.aoi, a.data_dir, skip={s for s in a.skip.split(",") if s}, cudem=cudem,
        download_scenes=not a.no_scene_download)
    return 0


if __name__ == "__main__":
    sys.exit(main())
