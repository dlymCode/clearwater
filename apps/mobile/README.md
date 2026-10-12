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

**Dependency route:** the full real install (`expo ~57`, `react-native 0.87`, `@maplibre/maplibre-react-native 11.5`,
`expo-sqlite`, `expo-location`, `react-native-tcp-socket`, `react-native-udp`, supabase-js, zustand, ...), so screens and
services are type-checked against the real native packages' types. No ambient `declare module` stubs.
`@clearwater/shared` is resolved by tsconfig `paths` (+ Jest `moduleNameMapper`, + `metro.config.js` for the bundler)
rather than an npm workspace, because the repo has no root `package.json` (infra owns the root).

## Architecture rule

Everything unit-tested lives in `src/lib/**` with **zero** imports of `expo-*`, `react-native` or `@maplibre/*`
(Jest runs under plain node). `src/services/**`, `src/screens/**`, `src/components/**` and `App.tsx` import native
modules, are type-checked, and are **not** executed by Jest. Anything in a service that needs a decision gets pulled into
`lib` behind an injected interface (e.g. `lib/pullSync.ts` takes a `RemoteReader` and a `LocalSink`, so the PostgREST
contract is tested with a fake server).

| Module (`src/lib`) | What |
| --- | --- |
| `nmea.ts` | NMEA 0183 DPT/DBT/GGA/RMC/VHW, checksum (bad => null + counter), resync on glued sentences, ft/m/fathoms, knots, HDOP, TCP/UDP line buffer, fix tracker |
| `score.ts` | `S = R_a * (1 + vote_sum) * exp(-lambda * (now - max(t0, last_confirmed_at)))`, `t0 = least(created_at, received_at)`; render states; decayed-server-score fallback |
| `pingModel.ts` | Ping / vote / message payloads, `ping_feed` row normalization, visibility, vote-button availability |
| `tide.ts`, `stations.ts` | Linear interpolation of cached predictions (explicit-UTC timestamps only), MLLW correction, nearest station, bundled + cached station registry |
| `depthFilter.ts` | SOG, jump, HDOP filters; NaN/range guards; first-reading baseline confirmation |
| `aggregate.ts` | H3 res 12 per UTC day => `{h3_cell, day, median_ft, p10_ft, n}`; complete-day re-aggregation (`reaggregateTouched`); type-level + runtime anonymity guard |
| `outbox.ts`, `outboxMemoryStore.ts` | Queue model (UUID, monotonic seq, in-order per kind, 2xx => sent, 50 MB merge-never-drop, chunking, 401 pause, silent vote failures) |
| `pullSync.ts`, `syncCursor.ts` | Keyset-paginated inbound pull, staleness rules, sync plan |
| `tilesIndex.ts`, `downloadState.ts`, `downloadVerify.ts` | tiles/index.json parsing (lenient, path-safe), sizes, version diff, resumable job state (optional companions), download + path verification |
| `terrainRgb.ts`, `inspect.ts` | Terrain-RGB (feet) + depth_meta pixel decode, never-blank inspect readout |
| `region.ts` | Point-in-polygon => "Region 2E"; `safeRegionReadout` never throws |
| `mapStyle.ts` | MapLibre style JSON: hard-band ramp matching the legend (no-data transparent), toggles, fleet raster + low-confidence wash, optional sources |
| `groups.ts`, `profile.ts`, `settings.ts`, `positionReport.ts`, `retention.ts`, `geo.ts`, `uuid.ts`, `mutex.ts`, `http.ts`, `num.ts` | Invite codes, profile capture + write gate, settings, position-report policy, local retention cutoffs, geometry, ids, async mutex, `retryableStatus`, `round2` |

## Value conventions (read before touching depth / score code)

* Terrain-RGB depth tiles are **feet MLLW, positive up** (`elev_ft = -10000 + 0.1*(R*65536 + G*256 + B)`; RGB 0,0,0 = no data).
  MapLibre assumes metres, so colour-ramp stops are raw feet and hillshade exaggeration is scaled by `METERS_PER_FOOT`.
* **`fleet.pmtiles` is raster Terrain-RGB decoded exactly like `depth.pmtiles`** (feet, positive up). The pipeline negates depth to
  elevation before encoding, so 12 ft of water decodes as -12 and a drying hump at depth -2 decodes as +2; the map uses the same ramp and
  the popup shows depth = -decoded. **`fleet_meta.pmtiles`** (by path convention, not in `index.json`): R = boats (clamped 255), G/B =
  newest contributing day as uint16 days since 1880-01-01, A = 255 valid / 0 hole (`decodeFleetMetaPixel` in shared mirrors
  `pipeline/tiles.py` `pack_fleet_meta`). Cells with fewer than 3 boats are washed out on the map: the meta archive is read as terrain
  (code = boats*65536 + day) and one elevation threshold selects `boats < 3`; raster data cannot carry a hatch pattern, so this is a
  colour wash, not stripes. The fleet inspect popup shows depth, boat count and newest day from the two archives.
* Per-cell source/date/uncertainty is `tiles/<aoi>/<version>/depth_meta.pmtiles` and OSM land is `.../land.pmtiles`; neither is
  in `index.json`. All companions (`depth_meta`, `land`, `fleet_meta`) are optional: a 400/404 marks them absent and the map runs without them. Encodings
  mirror `pipeline/common.py` / `pipeline/tiles.py` in `packages/shared/src/pipelineEncoding.ts`.
* An index file entry with `bytes == 0` means "not available yet" and is treated as absent. Index paths are validated
  (`tiles/<aoi>/<version>/<file>.(pmtiles|geojson|json)`, safe segments) before they can touch the filesystem.
* **Uploaded depth values are charted depth in ft below MLLW, positive down**, `p10_ft` = 10th percentile of depth (shoal side).
* **Every depth upload is the COMPLETE UTC-day aggregate of each touched cell** (server upsert-replace): the logger
  re-aggregates all of the day's stored soundings for cells touched since the last batch. Outbox merges therefore keep the
  LATER row for the same (cell, day), never a sum. Raw soundings are kept 7 days after aggregation for this.
* **Ping score:** the server exposes per-ping aggregates on `ping_feed` (`author_reputation`, `vote_sum` quantized to
  0.25, `last_confirmed_at`, `confirm_count`, `dispute_count`, `received_at`). There is no per-vote feed (it would
  de-anonymize voters). Any vote bumps `pings.updated_at`, so the ping cursor delivers vote changes. When a reputation or
  `vote_sum` is missing the server's cached `score` decayed since `updated_at` is used, never a default 1.0.
* Depth batches are queued as `{ rows: DepthUploadRow[] }` and sent to the `depth-upload` edge function as
  `{ batch_id, rows }` (chunked to <= 5000 rows with stable chunk ids).
* Pings are inserted with the minimal return (never `RETURNING *`: `author_id` is column-revoked for clients).

## Backend contract this app relies on

`ping_feed` (columns above), `messages_feed` (messages + `author_handle`, cursor `received_at`), `ping_votes` (own rows only;
read as `voter_id = me`), RPCs `cast_vote`, `join_group` (returns NULL for a bad / expired code), `rotate_invite_code` and
`get_invite_code` (owner; `groups.invite_code` is not a selectable column), `report_position(p_lat, p_lon)` (PT400
`position_out_of_range` is permanent for that position), tables `profiles` (own row upsert: id, handle, vessel_name), `groups`
(insert id, name, owner_id; read id, name, owner_id, invite_expires_at, created_at), `pings`/`messages` inserts. Edge function
`depth-upload`. Tile-auth worker `GET TILE_AUTH_URL?path=...` with a Bearer JWT => `{url}` (400/404 = product absent).

## Needs a real build / accounts (not done)

Run `npx expo prebuild` / `eas build` (EAS project, Apple Developer account, bundle id in `app.config.ts`), then:

* `.env` from `.env.example` (Supabase URL + anon key, tile-auth worker URL).
* Supabase project with `supabase/migrations` applied; Sign in with Apple (`expo-apple-authentication`; only phone OTP exists).
  Deep-link scheme is `soundmaps` (`soundmaps://auth-callback`, matches the backend config).
* Device verification of `pmtiles://file://...` sources in MapLibre Native (SQLCipher + PMTiles need a dev build, not Expo Go).
* **TODO (deliberately removed until needed):** certificate pinning (`NSPinnedDomains` via `expo-build-properties` with real options),
  background fetch / background task for sync and downloads (`expo-background-task` or `expo-background-fetch` + `UIBackgroundModes`),
  Sentry, app lock (Face ID).

## Stubs and TODOs

| Where | Status |
| --- | --- |
| `services/tileSampler.ts` | **Stub**: returns null, so tap-to-inspect shows "unknown". Needs a PMTiles local-file reader + PNG decoder (lib decode is done and tested). |
| `services/regions.ts` | Reads `regions.geojson` from the AOI folder; the pipeline does not produce WDFW/WAC polygons yet, so the readout shows nothing until it does. Property names: `region_id`, `kind`. |
| Waterline hatching (MAP-4) | **TODO(pipeline)**: needs a per-cell scene count as its own archive (a PMTiles file holds one tile type); today the pipeline masks cells with < 5 scenes entirely. Fleet: see the contract above (`fleet.pmtiles` + `fleet_meta.pmtiles`). |
| Base-layer source-layer names | `DEPARE, DEPCNT, SOUNDG, COALNE, BOYLAT, LIGHTS, OBSTRN, WRECKS, CBLSUB, boundaries` in `base.pmtiles`; `land` in `land.pmtiles`. Region labels need local glyphs (`glyphs` option) for offline text; not bundled. |
| `services/downloads.ts` | File-level resume works; a file killed mid-flight restarts from byte 0. No background continuation. |
| Sync triggers | Foreground, connectivity, auth and a 15 min timer only; no OS background task. `flush` sends one batch per kind per pass (loop until empty for long backlogs). |
| Late-committing rows | A row committed with an `updated_at` older than the cursor is skipped (documented in `lib/pullSync.ts`). |
| Ping placement | Long-press on the map to move the pin (marker dragging not relied on). |
| Background depth logging | Foreground only; iOS background location + background TCP need S7-1 work. |
| Phone-GPS fallback (TODO) | Sounder-only gateways send no GGA/RMC, so every reading is dropped today; join the phone fix into the snapshot. Also warn about the DPT offset field (`services/depthLogger.ts`). |
| Group UI (TODO) | Group-tier ping creation, remove-member UI, an "Inspect unavailable" message while `tileSampler` is a stub, MAP-4 scene-count display. |
| Auth | Phone OTP only; no account-deletion UI (S5-2). Handle / vessel capture exists (`ProfileScreen`); pings, votes, messages and joins are blocked until the `profiles` row exists. |
| Subordinate tide stations | La Conner / Stanwood / Everett / Coupeville ids unknown; `lib/stations.ts` bundles the six reference stations (approximate coordinates), cached tide JSON lat/lon overrides them. |
| Component tests (RNTL), Maestro flows | Not in this pass. |
| `app.config.ts` | Bundle id `com.lymly.soundmaps` and EAS project id are placeholders. |

## Sync, retention, failure behaviour

* Position reporting: RPC `report_position`; client rounds to 100 m, persists the last report time, guards in-flight calls,
  backs off 60 s after a failure, never asks outside the Salish Sea box, and pauses after a server `position_out_of_range`
  until the boat has moved 1 km. Foreground only; sharing defaults OFF and is chosen at onboarding.
* Outbox: 401 pauses sending (silent token refresh, else the sign-in screen); `account_revoked` stops sending and shows a banner;
  silent vote failures are exactly 403 `confirm_ineligible`, 403 `cannot_vote_own_ping`, 404 `ping_not_found`; other 4xx rows become
  visible `failed` rows (Settings > Sync, with Retry) that keep the pending mark; rows ever attempted are never merged or re-id'd.
* Retention (every sync): sent outbox rows after 24 h, pings past the 48 h horizon (unsynced ones kept), messages after 90 days,
  aggregated soundings after 7 days.

## Layout

```
App.tsx, index.ts, app.config.ts, babel/metro/jest/tsconfig, .env.example
src/lib        pure logic (unit-tested)         __tests__/  Jest (node)
src/services   NMEA socket, GPS, SQLCipher, Supabase, sync, downloads, depth logger, retention, profile
src/screens    Map, Ping sheet, Inspect, Tide, Download, Groups, Channel, Settings, Onboarding, Auth, Profile
src/components Button, Banner, DepthLegend, DepthNumeral, PingDetail, theme
src/state      Zustand store
```
