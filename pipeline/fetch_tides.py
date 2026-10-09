"""Tide predictions: 30 days ahead, one JSON per station (run once a day).

    python -m pipeline.fetch_tides [--out data/tides] [--days 30]

Output shape (AGENT-PLAN.md, mobile caches it for 30 days)::

    {"station_id": "9447130", "name": "Seattle", "datum": "MLLW", "units": "ft",
     "lat": 47.6026, "lon": -122.3393,
     "predictions": [{"t": "2026-10-09T00:00:00Z", "v": 3.2}, ...]}

``lat``/``lon`` come from the CO-OPS metadata API (the app picks the nearest station by distance).

Predictions are on a regular 30-minute grid (cosine-interpolated between CO-OPS hi/lo
events, which is all subordinate stations publish) with the exact hi/lo extremes
inserted, so ~1,500 points per station and about 0.5 MB for all stations (PRD: under 1 MB).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Sequence

from . import coops

STEP_MIN = 30


def build_payload(station: coops.Station, events: Sequence[coops.Event], start: dt.datetime, end: dt.datetime,
                  step_min: int = STEP_MIN) -> dict:
    if station.id is None:
        raise ValueError(f"station {station.name!r} has no resolved id")
    pts = coops.densify(events, start, end, step_min)
    return {
        "station_id": station.id,
        "name": station.name,
        "datum": "MLLW",
        "units": "ft",
        "lat": round(station.lat, 5),
        "lon": round(station.lon, 5),
        "predictions": [{"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "v": round(v, 3)} for t, v in pts],
    }


def fetch_all(out_dir: Path, *, now: dt.datetime | None = None, days: int = 30,
              stations: Sequence[coops.Station] = coops.ALL_STATIONS,
              http_get: coops.HttpGet = coops.default_http_get) -> list[Path]:
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now
    end = now + dt.timedelta(days=days)
    client = coops.CoopsClient(http_get)
    resolved, unresolved = coops.resolve_stations(stations, http_get)
    for s in unresolved:
        print(f"warning: no CO-OPS id found for {s.name!r}; skipped", file=sys.stderr)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for s in resolved:
        # pad so the grid edges fall inside the hi/lo event range
        events = client.hilo(s.id, start - dt.timedelta(days=1), end + dt.timedelta(days=1))
        payload = build_payload(s, events, start, end)
        path = out_dir / f"{s.id}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
        written.append(path)
    return written


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", type=Path, default=Path("data/tides"))
    p.add_argument("--days", type=int, default=30)
    a = p.parse_args(argv)
    paths = fetch_all(a.out, days=a.days)
    print(f"wrote {len(paths)} station files to {a.out}")
    return 0 if paths else 1


if __name__ == "__main__":
    sys.exit(main())
