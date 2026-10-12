"""Step 9 - publish: upload to R2 under ``tiles/<aoi>/<version>/`` and write ``tiles/index.json``.

    python -m pipeline.publish --aoi skagit [--version 2026-10-09T00:00:00Z] [--dry-run]

Environment (never on disk): ``R2_ACCOUNT_ID``, ``R2_ACCESS_KEY_ID``, ``R2_SECRET_ACCESS_KEY``,
``R2_BUCKET``. The R2 token should be scoped to write ``tiles/`` AND ``tides/`` only.

The index follows AGENT-PLAN.md exactly and validates against
``pipeline/schemas/tiles_index.schema.json``. Products that do not exist yet (e.g. the fleet
layer before Phase 2, or the waterline layer for an AOI without scenes) are listed with
``bytes: 0`` and are NOT uploaded; the app treats ``bytes == 0`` as "not available".
Tide predictions (``data/tides/<station_id>.json`` from ``fetch_tides``) are uploaded flat to
``tides/<station_id>.json`` (unversioned: they refresh daily) and are NOT listed in ``tiles/index.json``.
Old versions are kept for 30 days *after they are superseded* (:func:`versions_to_prune`).

Safety gates (always on, also for a direct ``python -m pipeline.publish``; the CLI has no skip flag):
  * ``data/<aoi>/validate/report.json`` must be a JSON object whose ``aoi`` equals this AOI exactly, with
    ``gate.passed is True``, every check in ``common.REQUIRED_CHECKS`` present, ``passed is True`` and not
    skipped, and no ``dev_overrides`` (a report produced with ``--skip-*`` flags is never publishable);
  * the report must be NEWER than every gated tile file (validation ran on exactly these tiles);
  * no gated tile may be OLDER than any ``merge/merged_*.tif`` (stale-output guard);
  * ``base``, ``depth`` and ``depth_meta`` must exist (``waterline`` / ``fleet`` are optional).
  ``land.pmtiles`` (OSM, ODbL, separate file) is uploaded when present, outside the index and the freshness gates.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

import numpy as np

from .common import AOI_SLUGS, DATE_NODATA, REQUIRED_CHECKS, TILE_KINDS, date_from_days, iso_z, parse_iso_z, step_dir
from .jsonschema_lite import validate as validate_schema

SCHEMA_PATH = Path(__file__).parent / "schemas" / "tiles_index.schema.json"
RETENTION_DAYS = 30
INDEX_KEY = "tiles/index.json"


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def validate_index(index: Mapping[str, Any]) -> list[str]:
    """Errors against the tiles-index JSON Schema (empty = valid)."""
    return validate_schema(index, load_schema())


def date_range_from_days(days: np.ndarray) -> tuple[str, str]:
    """(oldest, newest) ISO dates present in a merged_date array (DATE_NODATA ignored)."""
    d = np.asarray(days)
    d = d[d != DATE_NODATA]
    if d.size == 0:
        raise ValueError("merged_date has no valid cells")
    return date_from_days(int(d.min())).isoformat(), date_from_days(int(d.max())).isoformat()


def build_aoi_entry(aoi: str, version: str, sizes: Mapping[str, int], date_range: tuple[str, str]) -> dict:
    if aoi not in AOI_SLUGS:
        raise ValueError(f"unknown AOI {aoi!r}")
    return {
        "aoi": aoi,
        "version": version,
        "files": {k: {"path": f"tiles/{aoi}/{version}/{k}.pmtiles", "bytes": int(sizes.get(k, 0))} for k in TILE_KINDS},
        "merged_date_range": [date_range[0], date_range[1]],
    }


def check_existing_index(existing: Any) -> dict:
    """The live index must be a well-formed object; otherwise refuse (overwriting it would wipe other AOIs)."""
    if not isinstance(existing, dict) or not isinstance(existing.get("aois"), list):
        raise ValueError("live tiles/index.json is malformed (expected an object with an 'aois' list); refusing to overwrite it")
    for a in existing["aois"]:
        if not isinstance(a, dict) or not isinstance(a.get("aoi"), str):
            raise ValueError("live tiles/index.json has a malformed AOI entry; refusing to overwrite it")
    return existing


def update_index(existing: Mapping[str, Any] | None, entry: dict, now: dt.datetime) -> dict:
    """Replace/insert one AOI entry; known AOIs stay in canonical order and other AOIs are untouched.
    Entries with an unknown slug are preserved (appended), never silently dropped - the schema check
    in :func:`publish_aoi` then fails loudly instead."""
    by_aoi = {a["aoi"]: a for a in check_existing_index(existing)["aois"]} if existing is not None else {}
    by_aoi[entry["aoi"]] = entry
    aois = [by_aoi[s] for s in AOI_SLUGS if s in by_aoi] + [a for k, a in by_aoi.items() if k not in AOI_SLUGS]
    return {"updated_at": iso_z(now), "aois": aois}


def parse_version(key_part: str) -> dt.datetime:
    """Strict version stamp ``YYYY-MM-DDTHH:MM:SSZ`` (no trailing newline, real calendar date)."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", key_part):
        raise ValueError(f"invalid version {key_part!r}; expected YYYY-MM-DDTHH:MM:SSZ")
    return parse_iso_z(key_part)


def valid_versions(versions: Sequence[str]) -> list[str]:
    """Only well-formed version names (stray prefixes such as ``tmp/`` are ignored, never pruned)."""
    out = []
    for v in versions:
        try:
            parse_version(v)
            out.append(v)
        except ValueError:
            pass
    return out


def versions_to_prune(listing: Mapping[str, Sequence[str]], current: Mapping[str, str], now: dt.datetime,
                      keep_days: int = RETENTION_DAYS) -> list[tuple[str, str]]:
    """``listing`` = {aoi: [versions on R2]}; ``current`` = {aoi: version in the index}.

    "Old versions stay for 30 days" counts from the moment a version was *superseded*, i.e. from
    the stamp of the next-newer version, not from its own stamp: a version published 40 days ago
    but replaced yesterday must still be kept. The current version is never pruned.
    """
    out: list[tuple[str, str]] = []
    for aoi, versions in listing.items():
        ordered = sorted(valid_versions(versions), key=parse_version)
        for i, v in enumerate(ordered):
            if v == current.get(aoi) or i + 1 >= len(ordered):
                continue
            superseded_at = parse_version(ordered[i + 1])
            if now - superseded_at > dt.timedelta(days=keep_days):
                out.append((aoi, v))
    return sorted(out)


class PublishRefused(RuntimeError):
    """A safety gate blocked the publish."""


MERGED_RASTERS = ("merged_elev.tif", "merged_src.tif", "merged_date.tif", "merged_unc.tif")


def check_validation_report(aoi: str, data_dir: Path) -> Path:
    """Raise :class:`PublishRefused` unless ``validate/report.json`` is a complete, passing, override-free
    report for exactly this AOI. Returns the report path."""
    report_path = step_dir(data_dir, aoi, "validate") / "report.json"
    if not report_path.exists():
        raise PublishRefused(f"{report_path} missing: run `validate` before publishing")
    try:
        report = json.loads(report_path.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PublishRefused(f"{report_path} is not valid JSON: {exc}") from exc
    if not isinstance(report, dict):
        raise PublishRefused(f"{report_path} is not a JSON object")
    if report.get("aoi") != aoi:
        raise PublishRefused(f"{report_path} is for AOI {report.get('aoi')!r}, not {aoi!r}")
    gate = report.get("gate")
    if not isinstance(gate, dict):
        raise PublishRefused(f"{report_path} has no gate object")
    if gate.get("passed") is not True:
        raise PublishRefused(f"validation gate did not pass: {gate.get('reason', 'no reason in report')}")
    overrides = list(report.get("dev_overrides") or []) + list(gate.get("dev_overrides") or [])
    if overrides:
        raise PublishRefused(f"report was produced with dev overrides ({', '.join(map(str, overrides))}); rerun validate without them")
    checks = gate.get("checks")
    if not isinstance(checks, dict):
        raise PublishRefused("report has no checks; rerun validate")
    problems = []
    for name in REQUIRED_CHECKS:
        c = checks.get(name)
        if not isinstance(c, dict):
            problems.append(f"{name}: missing")
        elif c.get("passed") is not True:
            problems.append(f"{name}: did not pass")
        elif c.get("skipped"):
            problems.append(f"{name}: skipped")
    failing = [n for n, c in checks.items() if not isinstance(c, dict) or c.get("passed") is not True]
    problems += [f"{n}: did not pass" for n in failing if n not in REQUIRED_CHECKS]
    if problems:
        raise PublishRefused("validation report incomplete: " + "; ".join(problems))
    return report_path


def merge_outputs_mtime(aoi: str, data_dir: Path) -> float:
    """Newest mtime among the four merged rasters; raises :class:`PublishRefused` if any is missing."""
    merge_dir = step_dir(data_dir, aoi, "merge")
    missing = [n for n in MERGED_RASTERS if not (merge_dir / n).exists()]
    if missing:
        raise PublishRefused(f"missing merge output(s): {', '.join(missing)}")
    return max((merge_dir / n).stat().st_mtime for n in MERGED_RASTERS)


def check_publish_gates(aoi: str, data_dir: Path, tile_files: Sequence[Path]) -> None:
    """Raise :class:`PublishRefused` unless validation passed on exactly these (fresh) tiles."""
    report_path = check_validation_report(aoi, data_dir)
    report_mtime = report_path.stat().st_mtime
    stale_report = [p.name for p in tile_files if p.stat().st_mtime >= report_mtime]
    if stale_report:
        raise PublishRefused(f"tiles changed after validation ({', '.join(stale_report)}); rerun validate")
    newest_merge = merge_outputs_mtime(aoi, data_dir)
    stale_tiles = [p.name for p in tile_files if p.stat().st_mtime < newest_merge]
    if stale_tiles:
        raise PublishRefused(f"tiles older than the merged rasters ({', '.join(stale_tiles)}); rerun tiles")


class ObjectStore(Protocol):
    def upload_file(self, local: Path, key: str) -> None: ...
    def put_json(self, key: str, payload: Mapping[str, Any]) -> None: ...
    def get_json(self, key: str) -> dict | None: ...


class R2Store:
    """Cloudflare R2 through its S3-compatible API (boto3 imported lazily; injectable client)."""

    def __init__(self, bucket: str, client: Any = None, env: Mapping[str, str] | None = None) -> None:
        self.bucket = bucket
        self._client = client
        self._env = env if env is not None else os.environ

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "R2Store":
        e = env if env is not None else os.environ
        missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not e.get(k)]
        if missing:
            raise RuntimeError(f"missing environment variables: {', '.join(missing)}")
        return cls(e["R2_BUCKET"], env=e)

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3  # lazy

            self._client = boto3.client(
                "s3", endpoint_url=f"https://{self._env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                aws_access_key_id=self._env["R2_ACCESS_KEY_ID"], aws_secret_access_key=self._env["R2_SECRET_ACCESS_KEY"],
                region_name="auto")
        return self._client

    def upload_file(self, local: Path, key: str) -> None:
        self.client.upload_file(str(local), self.bucket, key, ExtraArgs={"ContentType": "application/octet-stream"})

    def put_json(self, key: str, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")) if key.startswith("tides/") else json.dumps(payload, indent=2)
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body.encode(),
                               ContentType="application/json", CacheControl="no-cache")

    def get_json(self, key: str) -> dict | None:
        try:
            body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except Exception as exc:  # noqa: BLE001 - botocore ClientError is detected structurally (no botocore import)
            code = str(((getattr(exc, "response", None) or {}).get("Error") or {}).get("Code", ""))
            if code in ("NoSuchKey", "404"):  # ONLY a genuinely missing key means "no index yet"
                return None
            raise  # AccessDenied, InternalError, network errors ... must never look like an empty bucket
        return json.loads(body)

    def list_versions(self, aoi: str) -> list[str]:
        resp = self.client.list_objects_v2(Bucket=self.bucket, Prefix=f"tiles/{aoi}/", Delimiter="/")
        return sorted(valid_versions([p["Prefix"].split("/")[2] for p in resp.get("CommonPrefixes", [])]))

    def delete_version(self, aoi: str, version: str) -> None:
        prefix = f"tiles/{aoi}/{version}/"
        resp = self.client.list_objects_v2(Bucket=self.bucket, Prefix=prefix)
        keys = [{"Key": o["Key"]} for o in resp.get("Contents", [])]
        if keys:
            self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})


class NullStore:
    """Offline stand-in used for credential-less dry runs."""

    def upload_file(self, local: Path, key: str) -> None:
        pass

    def put_json(self, key: str, payload: Mapping[str, Any]) -> None:
        pass

    def get_json(self, key: str) -> dict | None:
        return None


#: Extra files shipped next to the four indexed products (not in the index schema; mobile finds them by path).
#: ``depth_meta`` is derived from the merge and is freshness-gated; ``land`` (OSM, ODbL) is optional and exempt.
GATED_EXTRA_FILES = ("depth_meta.pmtiles",)
UNGATED_EXTRA_FILES = ("land.pmtiles",)
REQUIRED_TILES = ("base", "depth")  # + depth_meta; waterline and fleet are optional


def publish_aoi(aoi: str, data_dir: Path, store: ObjectStore, *, version: str | None = None,
                now: dt.datetime | None = None, date_range: tuple[str, str] | None = None,
                dry_run: bool = False) -> dict:
    """Validate gates, build the index, upload tiles then the index (dry-run: gates + index only)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    version = iso_z(now) if version is None else version
    parse_version(version)  # strict: no path tricks, no month 13, no trailing newline
    tiles_dir = step_dir(data_dir, aoi, "tiles")
    sizes: dict[str, int] = {}
    gated: list[tuple[Path, str]] = []
    for kind in TILE_KINDS:
        p = tiles_dir / f"{kind}.pmtiles"
        if p.exists():
            sizes[kind] = p.stat().st_size
            gated.append((p, f"tiles/{aoi}/{version}/{kind}.pmtiles"))
    for name in GATED_EXTRA_FILES:
        p = tiles_dir / name
        if p.exists():
            gated.append((p, f"tiles/{aoi}/{version}/{name}"))
    required = [f"{k}.pmtiles" for k in REQUIRED_TILES] + list(GATED_EXTRA_FILES)
    missing = [n for n in required if not (tiles_dir / n).exists()]
    if missing:
        raise FileNotFoundError(f"{tiles_dir}: required tile file(s) missing: {', '.join(missing)} (waterline/fleet are optional)")
    empty = [p.name for p, _ in gated if p.stat().st_size == 0]
    if empty:
        raise PublishRefused(f"zero-byte tile file(s): {', '.join(empty)}")
    check_publish_gates(aoi, data_dir, [local for local, _ in gated])
    ungated = [(tiles_dir / n, f"tiles/{aoi}/{version}/{n}") for n in UNGATED_EXTRA_FILES if (tiles_dir / n).exists()]
    uploads = gated + ungated
    if date_range is None:
        import rasterio  # lazy

        with rasterio.open(step_dir(data_dir, aoi, "merge") / "merged_date.tif") as ds:
            date_range = date_range_from_days(ds.read(1))
    entry = build_aoi_entry(aoi, version, sizes, date_range)
    index = update_index(store.get_json(INDEX_KEY), entry, now)
    errors = validate_index(index)
    if errors:
        raise ValueError("tiles index failed schema validation: " + "; ".join(errors))
    local_index = Path(data_dir) / "tiles" / "index.json"
    local_index.parent.mkdir(parents=True, exist_ok=True)
    local_index.write_text(json.dumps(index, indent=2) + "\n")
    if not dry_run:
        for local, key in uploads:  # data first, index last: the app never sees a dangling version
            store.upload_file(local, key)
        store.put_json(INDEX_KEY, index)
    return index


FLEET_FILES = ("fleet.pmtiles", "fleet_meta.pmtiles")


def publish_fleet(aoi: str, tiles_dir: Path, store: ObjectStore, *, now: dt.datetime | None = None,
                  dry_run: bool = False) -> dict:
    """Publish the nightly fleet layer under the AOI's CURRENT version directory and update only that AOI's
    ``fleet`` entry in the live ``tiles/index.json`` (other AOIs and the baseline files are untouched).

    No ``fleet.pmtiles`` in ``tiles_dir`` (no published cells tonight) sets ``bytes: 0`` in the index - the app
    treats that as "not available" - and uploads nothing. The index is read-modify-written, so avoid running it
    at the same instant as a baseline publish of the same AOI.
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    live = store.get_json(INDEX_KEY)
    if live is None:
        raise PublishRefused("no live tiles/index.json: publish the baseline before the fleet layer")
    index = copy.deepcopy(check_existing_index(live))
    entry = next((a for a in index["aois"] if a.get("aoi") == aoi), None)
    if entry is None:
        raise PublishRefused(f"AOI {aoi!r} is not in the live index: publish its baseline first")
    version = entry.get("version")
    parse_version(version if isinstance(version, str) else "")  # the CURRENT version directory, strictly validated
    fleet, meta = Path(tiles_dir) / FLEET_FILES[0], Path(tiles_dir) / FLEET_FILES[1]
    uploads: list[tuple[Path, str]] = []
    size = 0
    if fleet.exists():
        if not meta.exists():
            raise PublishRefused("fleet.pmtiles without fleet_meta.pmtiles: refusing a half-built fleet layer")
        size = fleet.stat().st_size
        if size == 0 or meta.stat().st_size == 0:
            raise PublishRefused("zero-byte fleet tile file")
        uploads = [(fleet, f"tiles/{aoi}/{version}/{FLEET_FILES[0]}"), (meta, f"tiles/{aoi}/{version}/{FLEET_FILES[1]}")]
    files = entry.get("files")
    if not isinstance(files, dict):
        raise PublishRefused(f"live index entry for {aoi} has no files object")
    files["fleet"] = {"path": f"tiles/{aoi}/{version}/{FLEET_FILES[0]}", "bytes": int(size)}
    index["updated_at"] = iso_z(now)
    errors = validate_index(index)
    if errors:
        raise ValueError("tiles index failed schema validation: " + "; ".join(errors))
    if not dry_run:
        for local, key in uploads:  # data first, index last
            store.upload_file(local, key)
        store.put_json(INDEX_KEY, index)
    return index


TIDES_PREFIX = "tides"
MIN_TIDE_DAYS_AHEAD = 7  # refuse to publish a stale tide file that no longer covers the next week


def _finite_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v)


def load_tide_files(tides_dir: Path, now: dt.datetime, min_days_ahead: int = MIN_TIDE_DAYS_AHEAD) -> dict[str, dict]:
    """Read and sanity-check every ``<station_id>.json`` in ``tides_dir`` -> {station_id: payload}."""
    files = sorted(Path(tides_dir).glob("*.json"))
    if not files:
        raise FileNotFoundError(f"no tide JSON in {tides_dir}: run fetch_tides first")
    out: dict[str, dict] = {}
    for f in files:
        d = json.loads(f.read_text())
        if not isinstance(d, dict):
            raise ValueError(f"{f}: top-level JSON must be an object")
        problems = []
        if d.get("station_id") != f.stem:
            problems.append(f"station_id {d.get('station_id')!r} != file name")
        if d.get("datum") != "MLLW" or d.get("units") != "ft":
            problems.append("expected datum MLLW / units ft")
        lat, lon = d.get("lat"), d.get("lon")
        if not (_finite_number(lat) and _finite_number(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            problems.append(f"lat/lon must be finite numbers in range, got {lat!r}, {lon!r}")
        preds = d.get("predictions")
        if not isinstance(preds, list) or not preds:
            problems.append("predictions must be a non-empty list")
        else:
            times = []
            for p in preds:
                try:
                    if not isinstance(p, dict) or not _finite_number(p.get("v")):
                        raise ValueError
                    times.append(parse_iso_z(p["t"]))
                except (ValueError, KeyError, TypeError):
                    problems.append(f"malformed prediction {p!r}")
                    break
            else:
                if any(b <= a for a, b in zip(times, times[1:])):
                    problems.append("predictions are not strictly time-ordered")
                elif times[-1] < now + dt.timedelta(days=min_days_ahead):
                    problems.append(f"predictions end {preds[-1]['t']}, less than {min_days_ahead} days ahead (stale)")
        if problems:
            raise ValueError(f"{f}: " + "; ".join(problems))
        out[f.stem] = d
    return out


def publish_tides(tides_dir: Path, store: ObjectStore, *, now: dt.datetime | None = None, dry_run: bool = False) -> list[str]:
    """Upload every station JSON to ``tides/<station_id>.json`` (flat, overwritten daily). Returns the keys."""
    payloads = load_tide_files(tides_dir, now or dt.datetime.now(dt.timezone.utc))
    keys = [f"{TIDES_PREFIX}/{sid}.json" for sid in payloads]
    if not dry_run:
        for sid, payload in payloads.items():
            store.put_json(f"{TIDES_PREFIX}/{sid}.json", payload)
    return keys


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True, choices=AOI_SLUGS)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--version")
    p.add_argument("--dry-run", action="store_true", help="build and validate the index locally; upload nothing")
    p.add_argument("--tides-dir", type=Path, help="tide JSON directory (default: <data-dir>/tides)")
    p.add_argument("--prune", action="store_true", help="delete non-current versions older than 30 days")
    a = p.parse_args(argv)
    s: Any
    try:
        s = R2Store.from_env()
    except RuntimeError:
        if not a.dry_run:
            raise
        s = NullStore()  # dry run without credentials: nothing is read from or written to R2
    index = publish_aoi(a.aoi, a.data_dir, s, version=a.version, dry_run=a.dry_run)
    keys = publish_tides(a.tides_dir or a.data_dir / "tides", s, dry_run=a.dry_run)
    print(f"tides: {'would upload' if a.dry_run else 'uploaded'} {len(keys)} station files under {TIDES_PREFIX}/")
    if a.prune and not a.dry_run:
        now = dt.datetime.now(dt.timezone.utc)
        current = {x["aoi"]: x["version"] for x in index["aois"]}
        for aoi, v in versions_to_prune({k: s.list_versions(k) for k in current}, current, now):
            s.delete_version(aoi, v)
    return 0


if __name__ == "__main__":
    sys.exit(main())
