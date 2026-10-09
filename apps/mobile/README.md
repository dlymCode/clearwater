# Clearwater mobile (Sound Maps)

Expo (React Native, TypeScript), iOS first. Offline-first map with fleet reporting. Spec: `docs/PRD.md`,
contracts: `docs/AGENT-PLAN.md`. Shared constants/types live in `packages/shared` (`@clearwater/shared`).

## Run the checks (no device needed)

```bash
cd apps/mobile
npm install            # .npmrc sets legacy-peer-deps=true (expo / react-native peer ranges); Node >= 22.13 recommended
npx tsc --noEmit       # strict type-check of everything: lib, services, screens, components, tests
npx jest               # plain-node Jest: only src/lib/** is executed

cd ../../packages/shared
npm install && npx tsc --noEmit && npx jest
```

**Dependency route taken:** the full real install (`expo ~57`, `react-native 0.87`, `@maplibre/maplibre-react-native 11.5`,
`expo-sqlite`, `expo-location`, `react-native-tcp-socket`, `react-native-udp`, supabase-js, ...) installed in seconds, so
screens and services are type-checked against the real native packages' types. No ambient `declare module` stubs are used.
`@clearwater/shared` is resolved by tsconfig `paths` (+ Jest `moduleNameMapper`, + `metro.config.js` for the bundler)
rather than an npm workspace, because the repo has no root `package.json` (infra owns the root).

## Architecture rule

Everything unit-tested lives in `src/lib/**` with **zero** imports of `expo-*`, `react-native` or `@maplibre/*`
(enforced by review/grep; Jest runs under plain node). `src/services/**`, `src/screens/**`, `src/components/**` and
`App.tsx` import native modules, are type-checked, and are **not** executed by Jest in this pass.

| Module (`src/lib`) | What |
| --- | --- |
| `nmea.ts` | NMEA 0183 DPT/DBT/GGA/RMC/VHW, checksum (bad => null + counter), ft/m/fathoms, knots, HDOP, TCP/UDP line buffer, fix tracker |
| `score.ts` | Ping score + decay, same operation order as `public.score_ping` in Supabase; render states |
| `tide.ts`, `stations.ts` | Linear interpolation of cached predictions, MLLW correction, nearest station |
| `depthFilter.ts` | SOG < 0.5 / > 25 kt, jump > 10 ft/s, HDOP > 5 (stateful) |
| `aggregate.ts` | H3 res 12 per UTC day => `{h3_cell, day, median_ft, p10_ft, n}`; type-level + runtime anonymity guard |
| `outbox.ts`, `outboxMemoryStore.ts` | Queue model (UUID, monotonic seq, in-order per kind, 2xx => sent, 50 MB merge-never-drop) |
| `syncCursor.ts` | Inbound cursors, tide > 24 h stale, AOI banners 14 / 60 days |
| `tilesIndex.ts`, `downloadState.ts` | tiles/index.json parsing (lenient), sizes, version diff, resumable job state |
| `terrainRgb.ts`, `inspect.ts` | Terrain-RGB (feet) + depth_meta pixel decode, never-blank inspect readout |
| `region.ts` | Point-in-polygon => "Region 2E" |
| `mapStyle.ts` | MapLibre style JSON: ramp, hatching (< 5 scenes, < 3 boats), toggles, legend |
| `pingModel.ts`, `groups.ts`, `settings.ts`, `positionReport.ts`, `geo.ts`, `uuid.ts` | Ping/vote/message payloads + visibility, invite codes, settings validation, 100 m / 5 min reporter policy, stale GPS, ids |

## Value conventions (read this before touching depth code)

* Terrain-RGB depth tiles are **feet MLLW, positive up** (`elev_ft = -10000 + 0.1*(R*65536 + G*256 + B)`; RGB 0,0,0 = no data).
  MapLibre assumes metres, so colour-ramp stops are raw feet and hillshade exaggeration is scaled by 0.3048.
* Per-cell source/date/uncertainty is `tiles/<aoi>/<version>/depth_meta.pmtiles` (not in `index.json`); the download
  job fetches it alongside `depth`. Codes mirror `pipeline/common.py` / `pipeline/tiles.py` in `packages/shared/src/pipelineEncoding.ts`.
* An index file entry with `bytes == 0` means "not available yet" and is treated as absent.
* **Uploaded depth values are charted depth in ft below MLLW, positive down** (`depth = raw + transducer draft - tide`),
  and `p10_ft` is the 10th percentile of depth (shoal-biased). The server baseline comparison (`merged_elev`, positive up)
  must negate. Open question: confirm with backend.
* Depth batches are queued as `{ rows: DepthUploadRow[] }` and sent to the `depth-upload` edge function as
  `{ batch_id: <outbox row id>, rows }` (assumed contract; the function did not exist yet).

## Needs a real build / accounts (not done)

Run `npx expo prebuild` / `eas build` (EAS project, Apple Developer account, bundle id in `app.config.ts`), then:

* `.env` from `.env.example` (Supabase URL + anon key, tile-auth worker URL, tiles index URL).
* Supabase project with the `supabase/migrations` applied; Sign in with Apple (`expo-apple-authentication`; only phone OTP exists).
* Cloudflare tile-auth worker deployed; **its request/response shape is assumed** in `services/supabase.ts signTileUrl`
  (`GET TILE_AUTH_URL?path=...` with a Bearer JWT => `{url}`).
* Device verification of `pmtiles://file://...` sources in MapLibre Native (SQLCipher + PMTiles both need a dev build, not Expo Go).
* Certificate pinning (`NSPinnedDomains`), Sentry, app lock (Face ID).

## Stubs and TODOs (every one)

| Where | Status |
| --- | --- |
| `services/tileSampler.ts` | **Stub**: returns null, so tap-to-inspect shows "unknown". Needs a PMTiles local-file reader + PNG decoder to read `depth` / `depth_meta` pixels (lib decode is done and tested). |
| `services/regions.ts` | Reads `regions.geojson` from the AOI folder; the pipeline does not produce WDFW/WAC polygons yet, so the readout shows nothing until it does. Property names: `region_id`, `kind` (see `lib/region.ts REGION_ID_KEYS`). |
| `lib/mapStyle.ts` waterline hatch | **TODO**: rule is implemented (`n < 5` on vector layer `waterline_scenes`) but the pipeline masks cells with < 5 scenes entirely, so there is nothing to hatch yet. Fleet hatch (`boats < 3`) assumes a vector `fleet` layer with `boats`. |
| Base-layer source-layer names | Assumed: `land, DEPARE, DEPCNT, SOUNDG, COALNE, BOYLAT, LIGHTS, OBSTRN, WRECKS, CBLSUB, boundaries`. Region labels need local glyphs (`glyphs` option) for offline text; not bundled. |
| `services/downloads.ts` | File-level resume works; a file killed mid-flight restarts from byte 0 (OS resume data exists only after pause). No background continuation (`expo-background-fetch` / `expo-task-manager` installed, not wired). |
| `services/syncService.ts` | Foreground, connectivity and 15 min timer triggers only; no registered background task. |
| Pull sync | Reads `ping_feed` (cursor `updated_at`, has `author_reputation`, `received_at`, hides the author of anonymous pings), `ping_votes_feed` (cursor `created_at`; columns ping_id, vote, created_at, voter_reputation, weight; no voter id or distance) and `messages` (cursor `received_at`), plus the user's own votes from `ping_votes` where `voter_id = me`. Scores use the feed reputations and the server-precomputed `weight`; if a reputation/weight is missing the server's cached `score` decayed by `exp(-lambda * (now - updated_at))` is used, never a default 1.0. Decay starts at `least(created_at, received_at)`. Errors are surfaced in Settings > Sync. |
| Auth | Phone OTP screen only. No account deletion UI (S5-2), no handle/vessel onboarding. |
| Ping drag-to-place | Implemented as long-press on the map to move the pin (MapLibre RN marker dragging not relied on). |
| Position upload | `last_positions` upsert directly; server re-snaps to 100 m and throttles to 1 per 5 min. |
| Background depth logging | Foreground only; iOS background location + background TCP need S7-1 work (`isIosBackgroundLocationEnabled`). |
| TanStack Query | Installed per the stack table, not used yet (state is Zustand + local SQLite). |
| Item 18 (TODO) | Phone-GPS fallback for sounder-only gateways (no GGA/RMC => every reading is dropped today) and a warning for the DPT offset field; comment in `services/depthLogger.ts`. |
| Item 19 (TODO) | Group-tier ping creation UI, remove-member UI, an "Inspect unavailable" message while `tileSampler` is a stub, MAP-4 scene-count display; comments in `MapScreen.tsx` / `GroupsScreen.tsx`. |
| Outbox drain (TODO) | `flush` sends one batch per kind per pass; loop until empty for long backlogs (comment in `lib/outbox.ts`). |
| Position reporting | Uses RPC `report_position(p_lat, p_lon)` (backend adding it); client rounds to 100 m too, persists the last report time, guards in-flight calls and backs off 60 s after a failure. Location is foreground-only: `UIBackgroundModes` is just `fetch`. Sharing defaults OFF and is chosen at onboarding. |
| Outbox semantics | 401 pauses sending (session refresh, else the sign-in screen); vote 403s `confirm_ineligible` / `cannot_vote_own_ping` / `ping_not_found` are swallowed; other 4xx rows become visible `failed` rows (Settings > Sync, Retry); rows ever attempted are never merged or re-id'd; depth rows over 5000 are chunked at send time with stable chunk ids; depth batches are enqueued with a deterministic id in the same SQLite transaction that marks soundings aggregated. Pings are inserted without RETURNING (author_id is revoked for clients). |
| Component tests (RNTL), Maestro flows | Not in this pass. |
| Subordinate tide stations | La Conner / Stanwood / Everett / Coupeville ids unknown; `stations.ts` has the six reference stations with approximate coordinates. |
| `app.config.ts` | Bundle id `com.lymly.soundmaps` and EAS project id are placeholders. |

## Layout

```
App.tsx, index.ts, app.config.ts, babel/metro/jest/tsconfig, .env.example
src/lib        pure logic (unit-tested)         __tests__/  Jest (node)
src/services   NMEA socket, GPS, SQLCipher, Supabase, sync, downloads, depth logger
src/screens    Map, Ping sheet, Inspect, Tide, Download, Groups, Channel, Settings, Onboarding, Auth
src/components Button, Banner, DepthLegend, DepthNumeral, PingDetail, theme
src/state      Zustand store
assets/hatch.png  hatching pattern for low-confidence cells
```
