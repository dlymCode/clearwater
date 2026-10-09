# Clearwater (Sound Maps) — Build Plan & Shared Contracts

This document is the single source of truth for how the codebase is laid out, who owns
what, and the exact values of every cross-cutting constant. **Read `docs/PRD.md` first,
then this file.** If this file and your own judgment disagree, follow this file and flag
the disagreement in your report. If this file and the PRD disagree, the PRD wins — flag it.

Scope of this build: the full **code skeleton** of Phase 1 + fleet layer — everything in
the PRD that is code. Not in scope (needs accounts, real data, or a boat): actual data
downloads, Supabase project provisioning, EAS/TestFlight, on-water tests. Code must be
written so those steps need no refactoring, only configuration.

## Repo layout and ownership

Each part has exactly one owner. **Never create, edit, or delete files outside your own
directories.** Never run `git` commands — the orchestrator handles all commits.

| Path | Owner | Contents |
| --- | --- | --- |
| `pipeline/` | **pipeline** | Python 3.12 batch pipeline: fetch, datum, align, waterline DEM, merge, validate, tiles, Makefile, pytest suite |
| `supabase/` | **backend** | `migrations/` (SQL), `functions/` (Deno/TS edge functions), `tests/` (pgTAP), seed |
| `workers/tile-auth/` | **backend** | Cloudflare Worker: Supabase JWT → signed R2 URL, quota |
| `apps/mobile/` | **mobile** | Expo (React Native, TypeScript) app, Jest suite |
| `packages/shared/` | **mobile** | Pure-TS shared constants/types mirrored from this doc (backend edge functions may *read* it conceptually but must inline their own copies — Deno vs Node packaging is not worth coupling) |
| `.github/workflows/`, root `README.md`, `LICENSE`, `.gitignore`, `docs/*` (except PRD.md and this file) | **infra** | CI, docs, repo hygiene |

## Toolchain facts (verified on this machine)

- Node v23.7.0, npm. Python 3.12.4 with pytest. `supabase` CLI installed. **No deno** —
  write Deno tests but wire them to run in CI only.
- GDAL/rasterio/PDAL availability is unknown: pipeline **core logic must be pure
  numpy** and unit-testable without GDAL. IO wrappers import `rasterio`/`gdal` lazily
  inside functions so `pytest` passes on a machine without them.
- Mobile unit tests must not require native modules: all tested logic lives in
  `apps/mobile/src/lib/` with zero `expo-*`/`react-native` imports. It is fine to
  install only the dev deps needed to run `tsc` + Jest if a full `npm install` is slow.

## Shared contracts — exact values

These appear in more than one part. All parts must use these exact values/names.

### Geodesy & grid
- Working grid: **EPSG:32610**, 2 m cells, origin snapped to 1,000 m multiples (`-tap`).
- Output tiles: **EPSG:3857**, raster z8–z16 (waterline z10–z16, fleet z10–z16).
- Vertical: **feet, MLLW, positive up**. NAVD88 sources go through VDatum grids; a raster
  without recorded vertical CRS metadata is **rejected** by merge.
- Depth color ramp breakpoints (ft MLLW): **0, 3, 6, 10, 20, 40**.

### AOIs (canonical slugs — used in paths, Makefile targets, tiles index)
`skagit`, `port_susan`, `snohomish`, `padilla_samish`, `nisqually`.
Pipeline owns the bbox definitions in `fetch_baseline.py`.

### Merge rules (pipeline)
Newest date wins; ties → lower uncertainty; a source older than 10 years is skipped when
any source under 10 years covers the cell; **no interpolation across sources** — holes
stay holes. Outputs per AOI: `merged_elev.tif`, `merged_src.tif` (uint8), `merged_date.tif`
(int32 days since 1970), `merged_unc.tif` (float32 ft).

### Waterline DEM (pipeline)
NDWI from Sentinel-2 B03/B08, SCL cloud mask. Per cell: elevation = midpoint of (highest
tide seen dry, lowest tide seen wet); bracket = difference; require **≥5 scenes**; mask
bracket > 3 ft. Outputs: `elev.tif`, `bracket.tif`, `date.tif`, `n.tif`.

### Ping types (enum, exact strings — Postgres enum, TS union, pipeline-irrelevant)
`bar_moved, touched_bottom, log, gear, closure_line, other`

### Ping score (must produce identical numbers in SQL and TS)
```
S = R_a * (1 + Σ_i R_i * v_i * w(d_i)) * exp(-λ * (t_now - t_last))
```
- `R_a` author reputation, `R_i` voter reputation, `v_i` ∈ {+1, −1}.
- `w(d)`: 1.0 if voter within 200 m of ping in last 24 h; 0.5 within 500 m; else 0.
- `t_last` = max(created_at, latest confirm). **λ = ln(2) / 24 h** (half-life 24 h).
- Render: S < 0.25 hidden; 0.25–0.5 faded; 0.5–1.5 normal; > 1.5 solid + count.
- Confirm eligibility (FLT-2): voter must have been within **500 m** of the ping in the
  last 24 h (checked server-side from last-known position; `voter_dist_m` stored).

### Reputation (backend weekly batch)
+0.05 per ping with ≥2 confirms; −0.10 per ping with ≥2 disputes; clamp **[0.2, 3.0]**;
new accounts 1.0. Reputation < 0.3 → pings hidden from public tier, still visible in group.

### Depth logging (mobile) & upload (backend)
- Device filters: drop when SOG < 0.5 kt or > 25 kt, |Δdepth| > 10 ft in 1 s, HDOP > 5.
- Tide-correct to MLLW on device using nearest station; store station id + correction.
- Aggregate on device to **H3 resolution 12** per **UTC day** before upload.
- Upload payload rows: `{h3_cell: string, day: 'YYYY-MM-DD', median_ft, p10_ft, n}` —
  **no uid, no sub-day timestamps, no track order** anywhere in the payload.
- `uploader_hash` = HMAC(uid, daily server salt), computed **server-side** (edge
  function); salt rotates daily.
- Server hold rule: cell median differs > 15 ft from baseline and no other boat logged
  that cell in 90 days → upload held (not deleted); released if a second boat agrees
  within 30 days.
- Fleet publication: only cells with **≥ 3 distinct boats** are published to tiles
  (secrecy rule). The app style additionally hatches any fleet cell with `boats < 3`
  as defense in depth. Published value = median of uploads weighted by n, last 90 days.

### Rate limits (backend edge function)
30 pings/h, 60 votes/h, 10 messages/min, 1 depth upload batch / 15 min, per user.

### Ping decay / offline (mobile + backend agree)
Fade at 24 h, hide at 48 h unless reconfirmed; computed **client-side from timestamps**
(same formula as score). Timestamps UTC from device clock; server stores `received_at`
and rejects anything > 7 days in the future.

### Database tables (names and key columns are fixed — see PRD §Fleet reporting)
`profiles, groups, group_members, pings, ping_votes, depth_cells, depth_uploads,
messages`, plus `audit_log`, `last_positions` (uid, geom rounded 100 m, updated ≤ every
5 min, deleted after 24 h) and an `outbox`-mirror is client-side only. Check constraints
in Postgres: note ≤ 140, message ≤ 500, enum types, geometry within a Salish Sea bbox
polygon. Invite codes 8 chars, expire 7 days. Messages retained 90 days.

### RLS summary (backend; pgTAP matrix must cover owner/member/non-member/anon × CRUD)
- `profiles`: readable by all signed-in (handle, vessel, reputation); writable by owner.
- `pings`: readable where `group_id IS NULL` OR member of group; insert by author.
- `messages`: read/write group members only.
- `depth_uploads`: **insert-only** for signed-in; never client-selectable.
- `depth_cells`: readable by all signed-in.
- Group leave/remove revokes history access immediately (RLS evaluated per query).

### Tiles index (`tiles/index.json` — pipeline writes, mobile reads, infra schema-checks)
```json
{
  "updated_at": "ISO-8601",
  "aois": [{
    "aoi": "skagit",
    "version": "2026-10-09T00:00:00Z",
    "files": {
      "base":      {"path": "tiles/skagit/<version>/base.pmtiles",      "bytes": 0},
      "depth":     {"path": "tiles/skagit/<version>/depth.pmtiles",     "bytes": 0},
      "waterline": {"path": "tiles/skagit/<version>/waterline.pmtiles", "bytes": 0},
      "fleet":     {"path": "tiles/skagit/<version>/fleet.pmtiles",     "bytes": 0}
    },
    "merged_date_range": ["1887-01-01", "2026-09-30"]
  }]
}
```
Old versions kept 30 days. JSON Schema lives at `pipeline/schemas/tiles_index.schema.json`;
mobile validates shape loosely (ignore unknown fields).

### Tide predictions JSON (pipeline writes one per station, mobile caches 30 days)
`{"station_id": "9448576", "name": "...", "datum": "MLLW", "units": "ft",
"predictions": [{"t": "ISO-8601Z", "v": 3.2}, ...]}`

### NMEA (mobile)
NMEA 0183 over TCP/UDP at 1 Hz; parse **DPT, DBT, GGA, RMC, VHW**; validate checksums;
bad checksum → drop sentence, count it. Depth-under-keel = sounder depth normalized by
transducer offset (asked once, stored on device) then tide-corrected to MLLW.

### Secrecy tiers (everyone)
Public (no group_id pings, depth_cells aggregates), Group (RLS via group_members),
Private (raw tracks/soundings/waypoints — **SQLCipher on device, never uploaded**).
Last-known position: rounded to 100 m, ≤ every 5 min, foreground only, retained 24 h.

## Conventions

- TypeScript strict mode everywhere; no `any` unless justified in a comment.
- Python: type hints, `ruff`-clean if ruff is available, pure functions for logic.
- Every part ships its own tests and a short `README.md` at its root documenting how to
  run them and what is stubbed.
- Secrets: **never commit any key**. Use `.env.example` files with placeholder names
  (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `R2_*`, `HMAC_SALT_SECRET`, `SENTRY_DSN`).
- Attribution requirements (OSM ODbL, Copernicus) noted in `docs/DATA-LICENSES.md` (infra).

## Pinned contracts added during the build (addendum)

1. **Terrain-RGB encodes feet MLLW** via the standard Mapbox formula; RGB (0,0,0) = nodata.
   Hillshade exaggeration in MapLibre scaled by 0.3048 (it assumes meters).
2. **`depth_meta.pmtiles`** sits at `tiles/<aoi>/<version>/depth_meta.pmtiles` by path
   convention (not in index.json). Pixel: R = (source_code<<4) | unc_bucket;
   G,B = uint16 days since 1880-01-01 (= days-since-1970 + 32872); A = 0 means hole.
   Uncertainty bucket 15 = UNKNOWN exclusively; values ≥ 45 ft clamp to bucket 14.
   Source of truth: `pipeline/common.py`; mirrored in `packages/shared/src/pipelineEncoding.ts`.
3. **Tiles index `bytes: 0`** means the product is not available yet; clients treat it as absent.
4. **Depth upload sign convention: `median_ft` / `p10_ft` are depth BELOW MLLW, positive
   down** (what a sounder reads; `p10_ft` is the shoal-biased 10th percentile). The
   baseline rasters are elevation, positive up — any comparison (the server 15 ft hold
   rule, bias flags) must negate one side: `baseline_depth_ft = -merged_elev_ft`.
5. **Client-side score parity**: reputations come from `profiles` (readable by all
   signed-in users per RLS); clients sync profiles for authors/voters they see and use
   the server's cached `score` as fallback when a reputation is unknown (default 1.0).
6. **Votes**: clients enqueue optimistically; the server-side `cast_vote` RPC rejects
   ineligible confirms (>500 m / >24 h); rejection is not an error state in the UI.

## Definition of done per part

1. Code compiles / imports cleanly; tests pass locally where the toolchain exists
   (pytest for pipeline; tsc + Jest for mobile; SQL lints by inspection + pgTAP files
   written for CI; worker has vitest or plain node tests if feasible).
2. Acceptance criteria from the PRD that are code-testable have a test.
3. A root README per part explains run/test/deploy and lists every TODO that needs
   accounts or real data.
4. Report back: files created, test results (paste the summary), deviations from this
   doc, open questions.
