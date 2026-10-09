"""Step 9 - publish: upload to R2 under ``tiles/<aoi>/<version>/`` and write ``tiles/index.json``.

    python -m pipeline.publish --aoi skagit [--version 2026-10-09T00:00:00Z] [--dry-run]

Environment (never on disk): ``R2_ACCOUNT_ID``, ``R2_ACCESS_KEY_ID``, ``R2_SECRET_ACCESS_KEY``,
``R2_BUCKET``. The R2 token should be scoped to write ``tiles/`` only.

The index follows AGENT-PLAN.md exactly and validates against
``pipeline/schemas/tiles_index.schema.json``. Products that do not exist yet (e.g. the fleet
layer before Phase 2, or the waterline layer for an AOI without scenes) are listed with
``bytes: 0`` and are NOT uploaded; the app treats ``bytes == 0`` as "not available".
Old versions are kept for 30 days (:func:`versions_to_prune`).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

import numpy as np

from .common import AOI_SLUGS, DATE_NODATA, TILE_KINDS, date_from_days, step_dir
from .jsonschema_lite import validate as validate_schema

SCHEMA_PATH = Path(__file__).parent / "schemas" / "tiles_index.schema.json"
RETENTION_DAYS = 30
INDEX_KEY = "tiles/index.json"


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def validate_index(index: Mapping[str, Any]) -> list[str]:
    """Errors against the tiles-index JSON Schema (empty = valid)."""
    return validate_schema(index, load_schema())


def iso_z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def update_index(existing: Mapping[str, Any] | None, entry: dict, now: dt.datetime) -> dict:
    """Replace/insert one AOI entry; AOIs stay in canonical order. Other AOIs untouched."""
    by_aoi = {a["aoi"]: a for a in (existing or {}).get("aois", [])}
    by_aoi[entry["aoi"]] = entry
    aois = [by_aoi[s] for s in AOI_SLUGS if s in by_aoi]
    return {"updated_at": iso_z(now), "aois": aois}


def parse_version(key_part: str) -> dt.datetime:
    return dt.datetime.strptime(key_part, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def versions_to_prune(listing: Mapping[str, Sequence[str]], current: Mapping[str, str], now: dt.datetime,
                      keep_days: int = RETENTION_DAYS) -> list[tuple[str, str]]:
    """``listing`` = {aoi: [versions on R2]}; ``current`` = {aoi: version in the index}.

    A non-current version is pruned once it is older than ``keep_days`` (age measured from
    the version stamp, a conservative proxy for when it was superseded).
    """
    out: list[tuple[str, str]] = []
    for aoi, versions in listing.items():
        for v in versions:
            if v == current.get(aoi):
                continue
            if now - parse_version(v) > dt.timedelta(days=keep_days):
                out.append((aoi, v))
    return sorted(out)


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
        self.client.put_object(Bucket=self.bucket, Key=key, Body=json.dumps(payload, indent=2).encode(),
                               ContentType="application/json", CacheControl="no-cache")

    def get_json(self, key: str) -> dict | None:
        try:
            body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except Exception as exc:  # noqa: BLE001 - botocore ClientError without importing botocore
            if "NoSuchKey" in str(exc) or "404" in str(exc):
                return None
            raise
        return json.loads(body)

    def list_versions(self, aoi: str) -> list[str]:
        resp = self.client.list_objects_v2(Bucket=self.bucket, Prefix=f"tiles/{aoi}/", Delimiter="/")
        return sorted(p["Prefix"].split("/")[2] for p in resp.get("CommonPrefixes", []))

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


#: Extra files shipped next to the four indexed products (not in the index schema).
EXTRA_FILES = ("depth_meta.pmtiles",)


def publish_aoi(aoi: str, data_dir: Path, store: ObjectStore, *, version: str | None = None,
                now: dt.datetime | None = None, date_range: tuple[str, str] | None = None,
                dry_run: bool = False) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    version = version or iso_z(now)
    tiles_dir = step_dir(data_dir, aoi, "tiles")
    sizes: dict[str, int] = {}
    uploads: list[tuple[Path, str]] = []
    for kind in TILE_KINDS:
        p = tiles_dir / f"{kind}.pmtiles"
        if p.exists():
            sizes[kind] = p.stat().st_size
            uploads.append((p, f"tiles/{aoi}/{version}/{kind}.pmtiles"))
    for name in EXTRA_FILES:
        p = tiles_dir / name
        if p.exists():
            uploads.append((p, f"tiles/{aoi}/{version}/{name}"))
    if not sizes.get("depth"):
        raise FileNotFoundError(f"{tiles_dir}/depth.pmtiles missing: nothing to publish")
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


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--aoi", required=True, choices=AOI_SLUGS)
    p.add_argument("--data-dir", type=Path, default=Path("data"))
    p.add_argument("--version")
    p.add_argument("--dry-run", action="store_true", help="build and validate the index locally; upload nothing")
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
    if a.prune and not a.dry_run:
        now = dt.datetime.now(dt.timezone.utc)
        current = {x["aoi"]: x["version"] for x in index["aois"]}
        for aoi, v in versions_to_prune({k: s.list_versions(k) for k in current}, current, now):
            s.delete_version(aoi, v)
    return 0


if __name__ == "__main__":
    sys.exit(main())
