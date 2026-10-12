# Sound Maps (Clearwater)

**Not for navigation.** Sound Maps is a situational-awareness overlay for Puget Sound
commercial fishermen. It is not a navigation device and not a chart. It shows where
the bars, flats and channels are today, not where the chart said they were at the
last survey. It combines public survey data (USGS, NOAA,
USACE) into an offline-first baseline, adds a waterline elevation map built from
tide-tagged Sentinel-2 passes, and layers a fleet depth and hazard reporting system
with explicit secrecy tiers: hazards are shared, measurements are shared without
identity, and spots are never shared. Owner: David Lym (LYMLY). Proprietary; see
[LICENSE](LICENSE).

## Repository layout

| Path | Contents |
| --- | --- |
| `pipeline/` | Python 3.12 batch pipeline: fetch, datum conversion, alignment, waterline DEM, merge, validate, tiles |
| `apps/mobile/` | Expo (React Native, TypeScript) app with a Jest suite |
| `packages/shared/` | Pure TypeScript constants and types mirrored from the shared contracts |
| `supabase/` | Postgres migrations, Deno edge functions, pgTAP tests |
| `workers/tile-auth/` | Cloudflare Worker: Supabase JWT to signed R2 tile URL, quota |
| `.github/workflows/` | CI (pipeline, mobile, backend) and security scans |
| `docs/` | PRD, build plan, data licenses, runbook |

## Quickstart

Each part is tested independently. CI runs the same commands on every push that
touches its directory.

**Pipeline (Python)**

```sh
cd pipeline
pip install -r requirements-dev.txt
pytest tests -q
```

**Mobile (Expo / TypeScript)**

```sh
cd apps/mobile
npm ci
npx tsc --noEmit
npx jest --ci
```

**Backend (Supabase)**

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli) and Docker.

```sh
supabase start
supabase db reset
supabase test db
```

**Tile auth worker (Cloudflare Worker)**

```sh
cd workers/tile-auth
npm ci
npm test
```

## Documentation

- [docs/PRD.md](docs/PRD.md): product requirements, data catalog, architecture, security, legal checklist
- [docs/AGENT-PLAN.md](docs/AGENT-PLAN.md): repo layout, ownership, shared contracts
- [docs/DATA-LICENSES.md](docs/DATA-LICENSES.md): every data source and its attribution requirement
- [docs/RUNBOOK.md](docs/RUNBOOK.md): pipeline reruns, tile publish and rollback, key rotation, account revocation

## Data attribution

- Depth and elevation data from USGS, NOAA and USACE are US federal works in the public domain. Sources are cited in the app's data page.
- Washington State DNR data (CoNED MLLW conversion, Washington Lidar Portal projects) is not federal and carries its own terms; see docs/DATA-LICENSES.md.
- Contains modified Copernicus Sentinel data [2026]. Sentinel-2 imagery is provided under the Copernicus license.
- Map data &copy; OpenStreetMap contributors, available under the Open Database License (ODbL).

See [docs/DATA-LICENSES.md](docs/DATA-LICENSES.md) for the full list.
