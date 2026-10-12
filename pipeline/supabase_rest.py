"""Minimal Supabase REST (PostgREST) client for the pipeline: plain HTTPS, no SDK, stdlib only.

Used with the SERVICE ROLE key (it bypasses RLS), so callers must apply every access rule
explicitly (e.g. the fleet exporter filters ``boats >= 3`` itself). Environment (never on disk,
never logged): ``SUPABASE_URL`` (https) and ``SUPABASE_SERVICE_ROLE_KEY``.

The HTTP transport is injectable (``http=callable(method, url, headers, body) -> (status, bytes)``)
so everything is unit-testable offline.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence

Http = Callable[[str, str, Mapping[str, str], bytes | None], tuple[int, bytes]]

BATCH_SIZE = 1000  # PostgREST's default max-rows is 1000, and it keeps request bodies small
PAGE_SIZE = 1000


class SupabaseError(RuntimeError):
    """A REST call failed. The message never contains the API key."""


def default_http(method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float = 120.0) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https enforced by the client)
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def batched(rows: Sequence[Any], size: int = BATCH_SIZE) -> Iterator[Sequence[Any]]:
    """Consecutive slices of at most ``size`` rows (size must be >= 1)."""
    if size < 1:
        raise ValueError("batch size must be >= 1")
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


class SupabaseRest:
    def __init__(self, url: str, service_key: str, http: Http = default_http) -> None:
        if not url.startswith("https://"):
            raise ValueError("SUPABASE_URL must be an https:// URL")
        if not service_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is empty")
        self._base = url.rstrip("/") + "/rest/v1/"
        self._key = service_key
        self._http = http

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, http: Http = default_http) -> "SupabaseRest":
        e = env if env is not None else os.environ
        missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not e.get(k)]
        if missing:
            raise RuntimeError(f"missing environment variables: {', '.join(missing)}")
        return cls(e["SUPABASE_URL"], e["SUPABASE_SERVICE_ROLE_KEY"], http)

    def _headers(self, extra: Mapping[str, str] | None = None) -> dict[str, str]:
        h = {"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        h.update(extra or {})
        return h

    def _check(self, status: int, body: bytes, what: str) -> None:
        if not 200 <= status < 300:
            raise SupabaseError(f"{what}: HTTP {status}: {body[:300].decode('utf-8', 'replace')}")

    def upsert(self, table: str, rows: Sequence[Mapping[str, Any]], on_conflict: str, batch_size: int = BATCH_SIZE) -> int:
        """POST rows in batches with ``on_conflict`` merge-duplicates. Returns the number of rows sent."""
        url = f"{self._base}{urllib.parse.quote(table)}?on_conflict={urllib.parse.quote(on_conflict)}"
        headers = self._headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
        sent = 0
        for chunk in batched(list(rows), batch_size):
            status, body = self._http("POST", url, headers, json.dumps(list(chunk), allow_nan=False).encode())
            self._check(status, body, f"upsert into {table} (rows {sent}..{sent + len(chunk) - 1})")
            sent += len(chunk)
        return sent

    def select_all(self, table: str, params: Mapping[str, str] | Iterable[tuple[str, str]], page_size: int = PAGE_SIZE) -> list[dict]:
        """GET every row matching PostgREST ``params`` (e.g. ``{"boats": "gte.3"}``), paging with offset/limit."""
        items = list(params.items()) if isinstance(params, Mapping) else list(params)
        out: list[dict] = []
        offset = 0
        while True:
            q = urllib.parse.urlencode(items + [("limit", str(page_size)), ("offset", str(offset))])
            status, body = self._http("GET", f"{self._base}{urllib.parse.quote(table)}?{q}", self._headers(), None)
            self._check(status, body, f"select from {table}")
            page = json.loads(body)
            if not isinstance(page, list):
                raise SupabaseError(f"select from {table}: expected a JSON array")
            out.extend(page)
            if len(page) < page_size:
                return out
            offset += page_size
