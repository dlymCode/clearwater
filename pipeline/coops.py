"""NOAA CO-OPS helpers: station registry, hi/lo prediction client, tide interpolation.

Network access goes through an injectable ``http_get`` callable so everything is
unit-testable offline. Subordinate stations only publish hi/lo predictions, so the
whole pipeline uses hi/lo events plus cosine interpolation between them (error is
typically a few tenths of a foot; documented in the README).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, replace
from typing import Callable, Sequence

from .geo import haversine_km

DATAGETTER = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
MDAPI_STATIONS = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"
APPLICATION = "clearwater-pipeline"

HttpGet = Callable[[str], bytes]


def default_http_get(url: str, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": APPLICATION})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https only, fixed hosts)
        return resp.read()


@dataclass(frozen=True)
class Station:
    id: str | None  # None => resolve from the CO-OPS metadata API by ``search_name``
    name: str
    lat: float  # approximate; used only for nearest-station choice
    lon: float
    reference: bool
    search_name: str | None = None


#: The six reference stations with live obs (PRD Data catalog). Coordinates approximate.
REFERENCE_STATIONS: tuple[Station, ...] = (
    Station("9447130", "Seattle", 47.6026, -122.3393, True),
    Station("9444900", "Port Townsend", 48.1129, -122.7595, True),
    Station("9449880", "Friday Harbor", 48.5453, -123.0125, True),
    Station("9449424", "Cherry Point", 48.8631, -122.7589, True),
    Station("9446484", "Tacoma", 47.2700, -122.4133, True),
    Station("9444090", "Port Angeles", 48.1250, -123.4400, True),
)

#: Prediction-only subordinate stations; IDs must be pulled from the metadata API (PRD open question 1).
#: IDs are deliberately NOT hard-coded: they are resolved by name at runtime.
#:
#: TODO(S0, LOUD): the Nisqually AOI currently falls back to the Tacoma reference station
#: (9446484) because no nearer station is registered here. Tide timing/range differ at the
#: Nisqually delta, so a nearer subordinate station (e.g. one in Nisqually Reach / Olympia
#: area) must be selected from the CO-OPS metadata API in S0 and added below before the
#: Nisqually waterline DEM is trusted.
SUBORDINATE_STATIONS: tuple[Station, ...] = (
    Station(None, "La Conner", 48.3917, -122.4950, False, "La Conner"),
    Station(None, "Stanwood", 48.2400, -122.3700, False, "Stanwood"),
    Station(None, "Everett", 47.9833, -122.2167, False, "Everett"),
    Station(None, "Coupeville", 48.2200, -122.6867, False, "Coupeville"),
)

ALL_STATIONS: tuple[Station, ...] = REFERENCE_STATIONS + SUBORDINATE_STATIONS


def match_station(metadata: dict, search_name: str, state: str = "WA") -> Station | None:
    """Pick a station from an mdapi ``stations.json`` payload by (case-insensitive) name and state."""
    needle = search_name.lower()
    best = None
    for s in metadata.get("stations", []):
        if state and (s.get("state") or "").upper() != state.upper():
            continue
        name = (s.get("name") or "").lower()
        if needle in name:
            # prefer the shortest (most specific-to-the-query) name
            if best is None or len(name) < len((best.get("name") or "")):
                best = s
    if best is None:
        return None
    return Station(str(best["id"]), best["name"], float(best["lat"]), float(best["lng"]), False, search_name)


def resolve_stations(
    stations: Sequence[Station], http_get: HttpGet = default_http_get
) -> tuple[list[Station], list[Station]]:
    """Fill in missing IDs and take every station's lat/lon from the CO-OPS metadata API.

    Returns (resolved, unresolved). Stations with a known id that the metadata API does not list
    keep their approximate registry coordinates (and a warning is printed).
    """
    url = MDAPI_STATIONS + "?" + urllib.parse.urlencode({"type": "tidepredictions"})
    meta = json.loads(http_get(url))
    by_id = {str(m["id"]): m for m in meta.get("stations", [])}
    resolved: list[Station] = []
    unresolved: list[Station] = []
    for s in stations:
        if s.id is not None:
            m = by_id.get(s.id)
            if m is None:
                print(f"warning: station {s.id} ({s.name}) not in CO-OPS metadata; using approximate coordinates", file=sys.stderr)
                resolved.append(s)
            else:
                resolved.append(replace(s, lat=float(m["lat"]), lon=float(m["lng"])))
            continue
        hit = match_station(meta, s.search_name or s.name)
        if hit is None:
            unresolved.append(s)
        else:
            resolved.append(replace(s, id=hit.id, lat=hit.lat, lon=hit.lon))
    return resolved, unresolved


def nearest_station(lon: float, lat: float, stations: Sequence[Station]) -> Station:
    usable = [s for s in stations if s.id is not None]
    if not usable:
        raise ValueError("no stations with resolved IDs")
    d = [float(haversine_km(lon, lat, s.lon, s.lat)) for s in usable]
    return usable[d.index(min(d))]


# ---------------------------------------------------------------- hi/lo events
Event = tuple[dt.datetime, float]  # (UTC time, height ft MLLW)


def parse_hilo(payload: dict) -> list[Event]:
    """Parse a CO-OPS ``interval=hilo`` predictions payload (time_zone=gmt) into UTC events."""
    if "error" in payload:
        raise ValueError(f"CO-OPS error: {payload['error'].get('message', payload['error'])}")
    out: list[Event] = []
    for row in payload.get("predictions", []):
        t = dt.datetime.strptime(row["t"], "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc)
        out.append((t, float(row["v"])))
    out.sort(key=lambda e: e[0])
    return out


def cosine_interpolate(events: Sequence[Event], t: dt.datetime) -> float:
    """Height at ``t`` by half-cosine interpolation between the surrounding hi/lo events."""
    if len(events) < 2:
        raise ValueError("need at least two hi/lo events")
    lo, hi = 0, len(events) - 1
    if t < events[0][0] or t > events[-1][0]:
        raise ValueError(f"{t.isoformat()} outside event range {events[0][0].isoformat()}..{events[-1][0].isoformat()}")
    while hi - lo > 1:  # binary search for bracketing pair
        mid = (lo + hi) // 2
        if events[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, v0), (t1, v1) = events[lo], events[hi]
    span = (t1 - t0).total_seconds()
    f = 0.0 if span <= 0 else (t - t0).total_seconds() / span
    return v0 + (v1 - v0) * (1.0 - math.cos(math.pi * f)) / 2.0


def densify(events: Sequence[Event], start: dt.datetime, end: dt.datetime, step_min: int = 15) -> list[Event]:
    """Regular grid between start and end (inclusive) plus the exact hi/lo extremes, time-sorted."""
    pts: dict[dt.datetime, float] = {}
    t = start
    step = dt.timedelta(minutes=step_min)
    while t <= end:
        pts[t] = cosine_interpolate(events, t)
        t += step
    for et, ev in events:
        if start <= et <= end:
            pts[et] = ev
    return sorted(pts.items())


class CoopsClient:
    """Thin CO-OPS predictions client. hi/lo only, heights in feet MLLW, UTC."""

    MAX_DAYS = 360  # API caps hilo requests at one year

    def __init__(self, http_get: HttpGet = default_http_get) -> None:
        self._get = http_get

    def hilo(self, station_id: str, begin: dt.datetime, end: dt.datetime) -> list[Event]:
        events: dict[dt.datetime, float] = {}
        cur = begin
        while cur < end:
            nxt = min(cur + dt.timedelta(days=self.MAX_DAYS), end)
            q = {
                "product": "predictions",
                "application": APPLICATION,
                "begin_date": cur.strftime("%Y%m%d %H:%M"),
                "end_date": nxt.strftime("%Y%m%d %H:%M"),
                "datum": "MLLW",
                "station": station_id,
                "time_zone": "gmt",
                "units": "english",
                "interval": "hilo",
                "format": "json",
            }
            payload = json.loads(self._get(DATAGETTER + "?" + urllib.parse.urlencode(q)))
            events.update(dict(parse_hilo(payload)))
            cur = nxt
        return sorted(events.items())
