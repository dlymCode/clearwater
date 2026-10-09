# Sound Maps PRD

Oct 8, 2026 · @no

## Summary

Sound Maps is a navigation app for Puget Sound commercial fishermen that shows where the bars, flats and channels actually are today, not where the chart said they were when it was surveyed. Phase 1 builds the best possible baseline from public data. Phase 2 keeps it current with depth logged from the fleet's own sounders and Waze-style hazard reports.

**The problem.** NOAA charts for the Sound's shallow water are built on surveys that are years to decades old. River deltas (Skagit, Stillaguamish, Snohomish, Nisqually) and the Swinomish approach move every winter. Garmin and Navionics crowdsourced layers help, but they are recreational, they do not show survey date or source per cell, and they carry none of the commercial context (crab regions, closures, fleet comms).

**What works in Alaska.** [Bristol Maps](https://apps.apple.com/us/app/id1608263684) solved this for Bristol Bay with curated low-tide satellite images layered over NOAA charts, offline tide tables, and a private group chat, for $150/year. It had around 520 users in the 2024 season. Satellite imagery alone will not carry over: most of the Sound is deep, and the problem is concentrated in a handful of shallow areas.

**What we build.** One map, offline-first, with three layers stacked by freshness:

1. **Baseline.** USGS CoNED 1 m topobathy, NOAA CUDEM and BlueTopo, USACE topobathy lidar and channel condition surveys, all converted to feet MLLW, merged by newest-wins, with source and date visible per cell.
2. **Waterline DEM.** Sentinel-2 passes tagged with the tide height at acquisition, stacked into an intertidal elevation map that refreshes with every clear pass.
3. **Fleet layer.** Tide-corrected depth logged passively from sounders over NMEA, plus hazard pings, scored by a trust model and shared under explicit secrecy tiers.

Plus the commercial context: WDFW crab management region boundaries (WAC 220-320-110), NOAA tides and SSCOFS currents, and private group channels.

**Working name:** Sound Maps. **Owner:** David Lym (LYMLY). **Status:** PRD draft, pre-build.

## Goals and non-goals

**Goals**

1. A shoal map for the Sound's shallow hotspots that beats the NOAA chart on freshness and tells the user how fresh each cell is.
2. Fully usable offline for a selected area, including tides, boundaries and the last synced fleet layer.
3. A fleet layer that stays accurate with no moderator, through passive sounder logging and a trust score.
4. Secrecy a working fisherman will accept: hazards shared, spots never.
5. Ship a beta to 12 boats in one area (Skagit Bay / Port Susan) before expanding.

**Non-goals (v1)**

- Replacing the chartplotter. The app is an overlay and a second screen, not a primary navigation device.
- Our own hydrodynamic model. We ingest NOAA SSCOFS currents; we do not model water movement.
- Catch reporting, fish tickets, or processor integration.
- Android before iOS. The beta fleet is on iPad and iPhone.
- Coverage outside the Salish Sea.

**Success metrics**

| Metric | Target | When |
| --- | --- | --- |
| Waterline DEM error vs. own sounder logs on known runs | within 1.5 ft on 90% of intertidal cells | end of Sprint 2 |
| Baseline merge covers the five hotspot AOIs with a source date per cell | 100% of cells | end of Sprint 2 |
| Beta boats actively using the app on fishing days | 10 of 12 | 4 weeks after TestFlight |
| Depth logs uploaded per fishing day per boat | 1,000+ soundings | 4 weeks after TestFlight |
| Hazard pings confirmed by a second boat within 24 h | 60% | 8 weeks after TestFlight |
| Crash-free sessions | 99.5% | ongoing |
| Map loads with no network, selected area cached | under 2 s | ongoing |

## Users and use cases

The beta user is a commercial crabber or gillnetter running a 28 to 58 ft boat in the north Sound, with a Garmin plotter and sounder on NMEA 2000, an iPad at the helm, and spotty LTE on the water.

| Persona | What they need | What they will not tolerate |
| --- | --- | --- |
| Skipper | Know before a run whether the bar has moved; see the legal region line while setting gear | Anything that needs attention while running; a map that lies with confidence |
| Deckhand / second | Drop a hazard ping in two taps with gloves on; read the group channel | Typing; small tap targets |
| Fleet lead / tender | See every boat's hazard pings in one place; push a notice to the group | Having to re-explain the app to every new boat |
| Admin (David) | Rebuild tiles when new data lands; see trust-score outliers; revoke a bad account | Manual moderation as a daily chore |

**Core use cases, in priority order**

1. Pre-run check (dock, on WiFi): pick an area, cache it, see the newest bar positions and today's tide curve.
2. Underway (no network): own position on the merged depth map with tide-corrected depth under the keel from the sounder, region boundaries drawn as hard lines.
3. Hazard found: two-tap ping (touched bottom, bar moved, log, gear in channel, closure line), queued offline, synced later.
4. Passive contribution: depth logs recorded from the sounder all day with zero user action, uploaded when back in coverage.
5. Group comms: fleet channel with pings and short messages, visible only to members.
6. Back at the dock: review which pings got confirmed, see what changed on the map since last trip.

## Product requirements

P0 ships in the beta. P1 follows once 10 boats are active. P2 is after the first season.

**P0: map and baseline**

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| MAP-1 | Vector base map with NOAA ENC-derived chart features (shoreline, depth areas, buoys, lights) | ENC S-57 layers rendered from our own tiles; no third-party chart subscription |
| MAP-2 | Merged depth raster, ft MLLW, hillshaded, with color ramp fixed at 0, 3, 6, 10, 20, 40 ft | Ramp identical online and offline; legend always visible |
| MAP-3 | Tap any cell to see depth, source dataset, survey or image date, and vertical uncertainty | Popup within 300 ms; fields never blank (show "unknown" explicitly) |
| MAP-4 | Waterline DEM layer toggle, with scene count and tide bracket per cell | Cells with fewer than 5 scenes render hatched, not solid |
| MAP-5 | Own position, heading, COG/SOG from device GPS at 1 Hz | Position dot updates smoothly; stale GPS (over 5 s) greys the dot |
| MAP-6 | Depth under keel from the sounder, tide-corrected to MLLW, shown as a large numeral | Updates at NMEA rate; shows "no sounder" when the feed is absent |
| MAP-7 | WDFW Salish Sea crab management regions and Marine Fish-Shellfish Catch Areas as hard boundary lines, with the region ID labeled | Boundaries from the WAC 220-320-110 coordinates, not traced from the PDF |
| MAP-8 | Tide curve for the nearest NOAA station, 48 h window, with current height marked | Works offline from cached predictions for 30 days ahead |
| MAP-9 | Offline area download: user draws or picks an AOI; app caches base, depth, boundaries, tides | Download size shown before confirm; resumable |

**P0: fleet layer**

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FLT-1 | Hazard ping in two taps: type (bar moved, touched bottom, log/deadhead, gear in channel, closure line, other) plus optional 1-line note | Works with no network; queued and synced |
| FLT-2 | Confirm or dispute someone else's ping in one tap | Confirmation requires the confirming boat to have been within 500 m of the ping in the last 24 h |
| FLT-3 | Pings decay: fade at 24 h, hidden at 48 h unless reconfirmed | Decay computed client-side from timestamps so it works offline |
| FLT-4 | Passive depth logging from NMEA 0183 over TCP/UDP (WiFi gateway) at 1 Hz, tide-corrected, stored locally | 8 h run produces under 5 MB; battery impact under 5% per hour on iPad |
| FLT-5 | Depth upload is anonymized before leaving the device (see Secrecy) | No boat ID, no timestamp finer than the day, in any upload payload |
| FLT-6 | Fleet depth shown as a separate layer: cell = median of uploads in the last 90 days, with count | Cells with under 3 contributing boats render hatched |
| FLT-7 | Groups: create, invite by code, leave; group channel with text and pings | Invite codes expire in 7 days; group owner can remove members |

**P1**

| ID | Requirement |
| --- | --- |
| P1-1 | NMEA 2000 direct via Yacht Devices / Actisense gateway (depth, water temp, heading) |
| P1-2 | SSCOFS currents layer: arrows at nowcast plus forecast time slider, 72 h |
| P1-3 | WDFW emergency rule and closure feed parsed into map notices |
| P1-4 | Route check: draw a line, get minimum depth along it at a chosen tide height |
| P1-5 | Export own tracks and depth logs as GPX/CSV |
| P1-6 | Android build |

**P2**

| ID | Requirement |
| --- | --- |
| P2-1 | AIS overlay from own receiver via the same NMEA feed |
| P2-2 | Garmin Quickdraw import so existing community data seeds the fleet layer |
| P2-3 | Weather: NWS marine zone forecasts and NDBC buoy observations |
| P2-4 | Tender and processor accounts with read-only fleet view |
| P2-5 | Expansion to Grays Harbor and Willapa Bay |

## Data catalog

Everything below is free. All US federal data is public domain; Sentinel-2 is free under the Copernicus license with attribution. Vertical datum is the trap: lidar and CoNED are NAVD88, charts and tides are MLLW, and the difference is about 2 to 3 ft in the Sound (NAVD88 sits roughly 2.4 ft above MLLW at Seattle). Everything gets converted to MLLW with VDatum before it is merged.

**Depth and elevation**

| Dataset | What it gives | Where | Format | Res. | Datum | Date | Refresh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [USGS CoNED Puget Sound TBDEM](https://www.sciencebase.gov/catalog/item/5d72b5dfe4b0c4f70cffa775) | Integrated topobathy from 186 sources (lidar, NOAA, USACE, PSLC, WA DNR). The best single baseline. | USGS ScienceBase; also [NOAA Digital Coast](https://www.fisheries.noaa.gov/inport/item/59971) | GeoTIFF tiles | 1 m | NAVD88, UTM 10N NAD83(2011) | Compiled 2020; topo 2005–2017, bathy 1887–2017 | Static |
| WA DNR CoNED MLLW conversion | Same model already converted NAVD88 to MLLW with VDatum 4.6.1, clipped above +10 m | WA DNR GIS (Nearshore Habitat Program), "Washington State USGS CoNED MLLW Bathymetric DEM" | Raster tiles, contours | 1 m | MLLW, SPCS WA South | 2023 conversion | Static |
| [NOAA NCEI CUDEM 1/9"](https://chs.coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/wash_pugetsound/index.html) | Continuously updated topobathy tiles; 21 tiles, 4.2 GB for Puget Sound. Also `wash_bellingham` and `wash_juandefuca` subfolders. | NOAA Digital Coast bulk download | GeoTIFF | \~3 m | NAVD88 | 2023v1 / 2024v1 | As new surveys land |
| [NOAA BlueTopo](https://www.fisheries.noaa.gov/inport/item/75311) | Best-available charted bathymetry with per-cell uncertainty, source survey ID and survey date | S3 `noaa-ocs-nationalbathymetry-pds/BlueTopo/`; [Python fetcher](https://pypi.org/project/BlueTopo/0.5.0) | Multiband GeoTIFF + RAT | 2–16 m by tile | MLLW (confirm per tile) | Rolling | Continuous |
| [2014 USACE/USGS Topobathy Lidar: Puget Sound](https://www.fisheries.noaa.gov/inport/item/50183) | CZMIL lidar for Edmonds, Nisqually, Padilla-Fidalgo, Port Susan, Port Gamble, Seahurst, Skagit, Suquamish, Whidbey | NOAA Digital Coast DAV; [DEM version](https://www.fisheries.noaa.gov/inport/item/49470) | LAZ points + 1 m DEM | 1 m | NAVD88 | Sept 2014 | Static |
| [USACE NCMP Topobathy Lidar: Washington, 2020](https://www.fisheries.noaa.gov/inport/item/72573) and [2021](https://fisheries.noaa.gov/inport/item/72562) | CZMIL lidar along the WA coast; check the DAV footprint for how far into the Sound it reaches | NOAA Digital Coast DAV | LAZ + 1 m DEM | 1 m | NAVD88 | 2020, 2021 | NCMP flies roughly every 5 years |
| [Washington Lidar Portal](https://lidarportal.dnr.wa.gov/) | State topobathy projects (e.g. Nooksack 2022); check for Skagit, Stillaguamish, Snohomish delta flights | WA DNR | LAZ, DEM | 1 m | NAVD88 | Varies | Per project |
| USACE eHydro (Seattle District) | Federal channel condition and after-dredge surveys: Swinomish Channel, Everett, Olympia, Tacoma, Grays Harbor | `navigation.usace.army.mil/Survey/Hydro`; ArcGIS feature service (confirm URL) | XYZ, GDB, PDF plots | Survey lines | MLLW | Rolling | After each survey or dredge |
| [NOAA ENC](https://charts.noaa.gov/ENCs/ENCs.shtml) | Chart features: shoreline, depth areas, soundings, buoys, lights, cables. Base map source. | NOAA Chart Downloader; [ENC Direct to GIS](https://www.NauticalCharts.NOAA.gov/learn/encdirect/) for GIS extracts | S-57 .000 cells | US5/US6 harbor scale | MLLW | Rolling | Weekly |
| [NOAA 1/3" Puget Sound DEM](https://catalog-beta.data.gov/dataset/puget-sound-1-3-arc-second-mhw-coastal-digital-elevation-model) | Older NTHMP tsunami DEM; fallback only | NCEI | GeoTIFF | \~10 m | MHW | Pre-2015 | Static |

**Imagery**

| Dataset | What it gives | Where | Format | Res. | Date | Refresh |
| --- | --- | --- | --- | --- | --- | --- |
| Sentinel-2 L2A | Green (B03) and NIR (B08) bands for NDWI water masks; the waterline DEM input | [Planetary Computer STAC](https://planetarycomputer.microsoft.com/api/stac/v1), collection `sentinel-2-l2a`; or AWS Earth Search `earth-search.aws.element84.com/v1` | COG | 10 m | 2017 to now | \~5 day revisit, more with S2C |
| Landsat 8/9 C2 L2 | Longer history for the same method | Same STACs, `landsat-c2-l2` | COG | 30 m | 2013 to now | 8 day |

**Water level, currents, context**

| Dataset | What it gives | Where | Format | Refresh |
| --- | --- | --- | --- | --- |
| NOAA CO-OPS tides | Predictions and observed water level, MLLW. Reference stations with live obs: Seattle 9447130, Port Townsend 9444900, Friday Harbor 9449880, Cherry Point 9449424, Tacoma 9446484, Port Angeles 9444090. Subordinate stations for La Conner, Stanwood, Everett, Coupeville: prediction-only (pull IDs from the metadata API) | `api.tidesandcurrents.noaa.gov/api/prod/datagetter`; station list at `api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json` | JSON, CSV | 6 min obs; predictions years ahead |
| [NOAA SSCOFS](https://tidesandcurrents.noaa.gov/ofs/sscofs/sscofs_info.html) | Water level, currents, temperature, salinity: 6 h nowcast plus 72 h forecast, FVCOM unstructured grid | NOMADS and AWS NODD (`noaa-ofs-pds` last 30 days, `noaa-nos-ofs-pds` archive; [bucket layout](https://docs.opendata.aws/noaa-ofs-pds/readme.html); confirm `sscofs` prefix is published) | NetCDF | 4 cycles/day (00, 06, 12, 18 UTC) |
| [NOAA VDatum](https://vdatum.noaa.gov/) | NAVD88 to MLLW transformation grids for the Salish Sea | VDatum download; `vdatum` CLI or `pyproj` with the grids | GTX grids | Per release |
| [WDFW Marine Areas](https://geodataservices.wdfw.wa.gov/arcgis/rest/services/FP_Projects/Recreational_Marine_Area/MapServer) | Marine Area boundaries (layers 0 marker, 1 boundary, 2 code); Marine Fish-Shellfish Catch Areas (20A–29) under WAC 220-301-030; commercial crab regions in WAC 220-320-110 are unions of those catch areas | WDFW ArcGIS REST; [PSMFC MarineAreaPolygonSegments](https://gis.psmfc.org/server/rest/services/Hosted/MarineAreaPolygonSegments/FeatureServer) as cross-check | GeoJSON via REST | Rarely; re-check each season |
| WAC 220-320-110 text | The legal coordinates and landmarks for each crab region (e.g. Ediz Hook Light, Point Wilson, Foulweather Bluff, Possession Point, Brace Point to the ferry dock) | `app.leg.wa.gov/wac/default.aspx?cite=220-320-110` | HTML | On rule change |
| WDFW commercial crab notices | Season openings, closures, emergency rules | `wdfw.wa.gov/fishing/commercial/crab` news releases; no API, scrape | HTML | Per notice |
| OpenStreetMap | Land, roads, place names for the base map | Protomaps or Geofabrik WA extract | PMTiles / PBF | Weekly |

**What we cannot get**

- Garmin Quickdraw and Navionics SonarChart community depth: no public download. Users can export their own Quickdraw data from an SD card (P2 import).
- Live AIS without our own receiver: commercial feeds cost money; P2 via the boat's own receiver.
- Bristol Maps' curated imagery: proprietary. We rebuild the method, not the data.

## Architecture and tech stack

&#91;embedded content: system architecture · 6 components\]

The heavy work (datum conversion, merging, tiling) runs in a batch pipeline, not on request. The app reads static tiles from object storage and talks to one backend for auth, pings, groups and depth uploads. There is no tile server to keep alive.

| Layer | Choice | Why |
| --- | --- | --- |
| Mobile app | Expo (React Native, TypeScript), `@maplibre/maplibre-react-native`, `expo-sqlite` with SQLCipher, `expo-location`, `expo-task-manager`, `react-native-tcp-socket` and UDP for NMEA, Zustand, TanStack Query | One TypeScript codebase; MapLibre is open source and renders PMTiles offline; Expo gives background location and OTA updates |
| Map tiles | PMTiles archives on Cloudflare R2 (vector: ENC features, OSM land, boundaries; raster: depth as Terrain-RGB, waterline DEM, fleet layer) | PMTiles serve with HTTP range requests straight from R2: no server, free egress, and the same file is what the app caches offline |
| Pipeline | Python 3.12, GDAL 3.9, rasterio, PDAL, pyproj with VDatum grids, numpy, xarray, pystac-client, tippecanoe, pmtiles CLI; orchestrated by a Makefile and GitHub Actions on a schedule; runs on one Hetzner CX32 or a local box | All open source; every step is a file in, file out, so reruns are cheap and diffs are inspectable |
| Backend | Supabase: Postgres 16 with PostGIS, Auth (Apple Sign-In and phone OTP), Row Level Security, Edge Functions (Deno/TS), Realtime for group channels | RLS enforces the secrecy tiers in the database, not in app code; realtime and auth come built in for a solo dev |
| Observability | Sentry (app and edge functions), Supabase logs, Better Stack uptime on the R2 tile index | Crash-free rate is a success metric |
| CI/CD | GitHub Actions, EAS Build and Submit, TestFlight for beta | Reproducible builds; no Mac needed for CI |

**Run cost at beta scale (12 to 50 boats):** Supabase Pro $25/mo, R2 under $5/mo, Hetzner $10/mo, Apple Developer $99/yr, EAS free tier. Roughly $50/mo. Bristol Maps charges $150/year, so 5 paying boats cover it.

## Data pipeline spec

Every step reads files and writes files under `data/<aoi>/<step>/`, with a `manifest.json` recording source URL, download date, checksum and CRS. A rerun of any step is safe. The whole pipeline runs per AOI so a bad delta rebuild never touches the others.

**Working grid.** EPSG:32610 (UTM 10N, WGS84), 2 m cells, origin snapped to a 1,000 m multiple so every layer aligns cell-for-cell. Vertical: feet, MLLW, positive up (so a bar at +3 ft dries at a 3 ft tide). Output tiles are reprojected to EPSG:3857 at the end only.

**AOIs for the beta** (lon/lat boxes, all five in `fetch_baseline.py`): Skagit Bay and flats, Port Susan and the Stillaguamish, Snohomish delta, Padilla and Samish Bay, Nisqually delta.

**Steps**

1. **Fetch.** `fetch_baseline.py --aoi <name>` pulls CUDEM tiles that intersect the box, BlueTopo tiles via the `nbs.bluetopo` fetcher, Sentinel-2 B03/B08 windows under 15% cloud for the last 3 years via STAC, and the tide height at each scene's timestamp from CO-OPS. Manual once: CoNED tiles from ScienceBase, 2014 and 2020/21 lidar DEMs from the Digital Coast DAV, eHydro XYZ for Swinomish, ENC cells for the AOI, VDatum grids.
2. **Datum conversion.** Every NAVD88 raster goes through VDatum to MLLW: `vdatum` CLI or `pyproj` with the Puget Sound GTX grids, then meters to feet. BlueTopo and eHydro are already MLLW. Record the vertical CRS in each output's metadata; a raster with no recorded vertical CRS is rejected by the merge step.
3. **Reproject and align.** `gdalwarp -t_srs EPSG:32610 -tr 2 2 -tap -r bilinear` for DEMs, `-r min` for lidar point DEMs over the flats (shoalest value wins when downsampling). Lidar LAZ goes through PDAL: filter class 2 (ground) and 29 (bathy bottom), rasterize at 1 m, then warp.
4. **Per-source date and uncertainty rasters.** For each source, write a `date.tif` (days since 1970, int32) and `unc.tif` (ft, float32). BlueTopo carries both per cell in its RAT. CoNED: use the source-survey raster that ships with it. Lidar: flight date, 0.5 ft. eHydro: survey date, 0.5 ft. CUDEM: tile version year, 1 ft.
5. **Waterline DEM.** `waterline_dem.py` computes NDWI from B03/B08 per scene, then for each cell takes the highest tide at which it was dry and the lowest at which it was wet; elevation = midpoint, bracket = difference. Requires 5 or more usable scenes per cell. Output `elev.tif`, `bracket.tif`, `date.tif` (newest scene), `n.tif`. Mask cells where the bracket exceeds 3 ft.
6. **Merge.** For each cell pick the source with the newest date; ties go to the lower uncertainty. Exception: a source older than 10 years is skipped if any source under 10 years covers the cell. Output `merged_elev.tif`, `merged_src.tif` (uint8 source code), `merged_date.tif`, `merged_unc.tif`. Nothing is interpolated across sources; a hole stays a hole and renders as "no data".
7. **Ground-truth check.** Compare merged elevation against David's own tide-corrected sounder logs along 3 known runs. Report RMSE and the 90th percentile absolute error per source. The build fails if the 90th percentile exceeds 1.5 ft on the waterline layer. This is the gate for Sprint 2.
8. **Tiles.** Raster: encode `merged_elev` as Terrain-RGB and `merged_src` + `merged_date` as a second RGBA band set, `gdal2tiles` or `rio-tiler` to z8–z16, then `pmtiles convert`. Vector: ENC S-57 to GeoJSON with `ogr2ogr` (layers DEPARE, DEPCNT, SOUNDG, COALNE, BOYLAT, LIGHTS, OBSTRN, WRECKS, CBLSUB), WDFW boundaries, OSM land from a Geofabrik WA extract, then `tippecanoe` to one PMTiles per AOI plus one Sound-wide low-zoom file.
9. **Publish.** Upload to R2 under `tiles/<aoi>/<version>/`, write `tiles/index.json` listing versions, sizes and the merged-date range. The app reads the index to decide what to download; old versions stay for 30 days.
10. **Fleet rebuild (nightly, Phase 2).** Pull anonymized depth cells from Postgres (median, count, last 90 days), rasterize, and publish as its own PMTiles. It is never merged into the baseline; it is its own layer so a bad upload cannot corrupt the baseline.

**Currents and tides.** A scheduled job pulls SSCOFS nowcast and forecast NetCDF four times a day, extracts surface u/v on a 500 m grid for the AOIs, and writes 72 hourly GeoJSON frames to R2 (P1). Tide predictions for every station in the AOI list are fetched 30 days ahead once a day and written as one JSON per station.

**Imagery refresh.** A weekly job searches STAC for new Sentinel-2 scenes, reruns step 5 and, if any cell changed by more than 1 ft, reruns steps 6 to 9 for that AOI.

## Fleet reporting and trust model

Two inputs, scored differently: a sounder log is a measurement and gets high trust by default; a ping is an opinion and earns trust through confirmation. Nobody moderates. Scores do all the work.

**Data model (Postgres)**

| Table | Key columns | Notes |
| --- | --- | --- |
| `profiles` | `id` (auth uid), `handle`, `vessel_name`, `reputation` float default 1.0, `created_at` | No real name required; handle is what others see |
| `groups` | `id`, `name`, `owner_id`, `invite_code`, `invite_expires_at` | Invite code is 8 chars, expires in 7 days |
| `group_members` | `group_id`, `user_id`, `role` (owner, member), `joined_at` |  |
| `pings` | `id`, `author_id`, `group_id` nullable, `type` enum, `geom` point 4326, `note` text 140, `created_at`, `expires_at`, `score` float, `tide_ft` | `group_id` null = public tier. `type`: bar\_moved, touched\_bottom, log, gear, closure\_line, other |
| `ping_votes` | `ping_id`, `voter_id`, `vote` (+1 confirm, -1 dispute), `voter_dist_m`, `created_at` | Unique on (ping\_id, voter\_id). `voter_dist_m` from the voter's last position |
| `depth_cells` | `cell_id` (H3 res 12, \~8 m), `day`, `median_ft`, `p10_ft`, `n`, `boats` | Aggregated server-side; raw soundings are never stored |
| `depth_uploads` | `id`, `uploader_hash`, `cell_id`, `day`, `median_ft`, `n` | `uploader_hash` = HMAC(uid, daily server salt); salt rotates daily so cells cannot be joined across days per boat |
| `messages` | `id`, `group_id`, `author_id`, `body` 500, `ping_id` nullable, `created_at` | Group channel. Retained 90 days |

**Ping score.** Computed on read, so decay works offline from timestamps alone:

```latex
S = R_a \cdot \left(1 + \sum_{i} R_i \cdot v_i \cdot w(d_i)\right) \cdot e^{-\lambda (t_{now} - t_{last})}
```

- `R_a` is the author's reputation; `R_i` each voter's reputation; `v_i` is +1 or -1.
- `w(d)` is a distance weight: 1.0 if the voter was within 200 m of the ping in the last 24 h, 0.5 within 500 m, 0 otherwise. A vote from the dock counts for nothing.
- `t_last` is the latest of creation and last confirmation. Lambda is set so a ping with no confirmations falls to half strength at 24 h and is hidden under 0.25 at 48 h.
- Display: `S` under 0.5 renders faded; 0.5 to 1.5 normal; above 1.5 solid with a confirmation count.

**Reputation update.** Weekly batch. For each author: +0.05 per ping that got 2 or more confirmations, -0.10 per ping that got 2 or more disputes, clamped to \[0.2, 3.0\]. New accounts start at 1.0, so one bad actor cannot outvote two honest boats. An account with reputation under 0.3 has its pings hidden from the public tier but still visible to its own group, so the group can see and deal with it.

**Depth log trust.** Soundings are measurements, so the filters are physical, not social:

1. On device: drop readings where SOG is under 0.5 kt (boat sitting, transducer may be aerated) or over 25 kt, where depth jumps more than 10 ft in 1 s, or where GPS HDOP exceeds 5.
2. On device: tide-correct each reading to MLLW using the nearest station's observed or predicted height at that minute. Store the station ID and the correction used.
3. On device: aggregate per H3 cell per day to median and 10th percentile before upload. Upload carries no timestamps finer than the day and no boat ID.
4. Server: reject an upload where a cell's median differs from the baseline by more than 15 ft and no other boat has logged that cell within 90 days. The upload is held, not deleted, and released if a second boat agrees within 30 days.
5. Server: `depth_cells.median_ft` is the median across uploads weighted by `n`; `boats` counts distinct `uploader_hash` values that day. The map hatches any cell with fewer than 3 boats.

**Transducer offset.** The app asks once for the transducer depth below the waterline and keel offset, and stores it on device. Every reading is normalized to depth below the surface before correction. A wrong offset is the most likely source of systematic error, so the ground-truth check compares each boat's uploads against the baseline and flags a constant bias over 1 ft to that user only.

**What a ping looks like to the user.** Two taps: type, then confirm. Note is optional. The ping lands at the boat's current position, or at a long-pressed point if the user drags it before confirming. It is queued locally and shows immediately with a "pending sync" mark.

## Secrecy and privacy

The rule: hazards are shared, measurements are shared without identity, spots are never shared. A fisherman who cannot be sure of this will turn logging off, and then the fleet layer dies.

| Tier | What is in it | Who can see it | Where it lives |
| --- | --- | --- | --- |
| Public | Hazard pings with no `group_id`; aggregated depth cells (`depth_cells`); confirmation counts | Every signed-in user | Postgres, RLS policy `tier = public` |
| Group | Pings with a `group_id`; group messages; which members are online | Members of that group only | Postgres, RLS policy joins `group_members` on `auth.uid()` |
| Private | Raw tracks, raw soundings with timestamps, waypoints, catch notes, transducer offsets | The device owner only | On-device SQLite (SQLCipher), key in the iOS Keychain. Never uploaded |

**What leaves the device, exactly**

- A ping: type, point, note, tide height, author uid, group id or null. The author is visible to viewers as a handle. A user can post a ping anonymously to the public tier; it then carries the author's reputation but not the handle.
- A depth upload: list of (H3 cell, day, median, p10, n). No boat id, no time of day, no track order. The `uploader_hash` is an HMAC with a daily server-side salt; the server can count distinct boats per cell per day, and nothing else, and cannot link a boat across days.
- Own position: sent to the server only as the last-known point, rounded to 100 m, updated at most every 5 minutes, and only while the app is foregrounded. It exists so confirmation distance can be checked and so group members can see each other. Retained 24 hours, then deleted. A user can turn it off and lose the ability to confirm pings.
- Nothing else. No track history, no speed profile, no soak times, no gear positions.

**Group boundaries**

- Group pings never leak to the public tier, even when confirmed. Promotion to public is an explicit action by the author.
- A member who leaves a group loses access to its history immediately (RLS evaluates on every query).
- Group owners can remove members and rotate the invite code. There is no "admin sees all groups" role in the app; the only superuser is the database owner, and that access is logged.

**Aggregation thresholds**

- A depth cell renders in the fleet layer only with 3 or more distinct boats. Below that the cell exists in the database but is not published to tiles, so one boat's route cannot be reconstructed from the map.
- Daily cells are rolled into 90-day medians for publication; the per-day rows are deleted after 180 days.

**Data retention**

| Data | Retained | Then |
| --- | --- | --- |
| Pings | 48 h visible, 1 year in database | Deleted |
| Ping votes | 1 year | Deleted |
| Depth daily cells | 180 days | Rolled into 90-day aggregates only |
| Last-known position | 24 h | Deleted |
| Group messages | 90 days | Deleted |
| Account | Until deleted by user | Account deletion removes profile, pings, votes, messages within 24 h; aggregated depth cells remain because they cannot be attributed |

**Legal exposure to the user.** Because raw tracks never leave the device, there is nothing on the server that could be subpoenaed to show where a boat fished. That is a feature, and the app's privacy page says so in plain words.

## Security

**Threat model.** Who would attack this and what they want:

| Threat | What they want | Control |
| --- | --- | --- |
| Competing boat or fleet | Where others fish; to poison the hazard map near their gear | Private tier never uploaded; k-of-3 aggregation; reputation-weighted votes with distance checks; held uploads that disagree with the baseline |
| Scraper (another app, a data broker) | The merged depth tiles and the fleet layer in bulk | Tiles on R2 behind a signed-URL edge worker; URLs expire in 24 h and are issued only to authenticated app sessions; per-account download quota |
| Account takeover | Post as a trusted skipper, read a group channel | Apple Sign-In or phone OTP, no passwords; session tokens in Keychain; sign-out everywhere on password reset; device count shown in settings |
| Malicious group member | Leak group pings, spam the channel | Owner removal; rate limits; a removed member's token is revoked on next request |
| Compromised backend | Tracks and spots | There are none on the server by design; what exists is pings, handles, aggregated cells |
| Lost or stolen iPad | Private tracks and waypoints | SQLCipher database, key in Keychain protected by device passcode; app lock option with Face ID |
| Spoofed NMEA data | Bad depth into the fleet layer | Physical filters (SOG, jump, HDOP), baseline disagreement hold, per-boat bias flag |

**Authentication and authorization**

- Supabase Auth with Sign in with Apple (required for App Store when offering social login) and phone OTP as the second option. No email/password.
- Every table has RLS enabled. Policies: `profiles` readable by all signed-in users (handle, vessel, reputation only), writable by owner. `pings` readable where `group_id is null` or `group_id in (select group_id from group_members where user_id = auth.uid())`. `messages` readable and writable by group members. `depth_uploads` insert-only by signed-in users; never selectable by clients. `depth_cells` readable by all signed-in users.
- Service-role key lives only in Edge Functions and the pipeline runner, never in the app bundle. The app ships only the anon key.
- Admin actions (revoke account, hold or release an upload, rotate the HMAC salt) run through Edge Functions that check a hard-coded admin uid list and write to an `audit_log` table.

**Transport and storage**

- TLS 1.2+ everywhere; certificate pinning for the API host in the app (Expo `expo-build-properties` with `networkSecurityConfig` on Android, `NSPinnedDomains` on iOS).
- Postgres encrypted at rest (Supabase default). Daily backups with point-in-time recovery enabled on the Pro plan.
- R2 bucket is private. A Cloudflare Worker validates a Supabase JWT and returns a signed URL for the PMTiles archive. Range requests go straight to R2 with that URL.
- On device: `expo-sqlite` with SQLCipher for the private store; the fleet and base caches are plain files because they contain nothing private.

**App security**

- Input limits enforced in Postgres `check` constraints, not only in the client: note 140 chars, message 500, ping types from the enum, geometry inside a Salish Sea bounding polygon.
- Rate limits in an Edge Function: 30 pings/hour, 60 votes/hour, 10 messages/minute, 1 depth upload batch/15 minutes per user.
- No third-party analytics SDK. Sentry only, with PII scrubbing on and `sendDefaultPii` off.
- Dependencies pinned; `npm audit` and `pip-audit` in CI; Dependabot on.
- Secrets in GitHub Actions environments and EAS secrets; `.env` never committed; a pre-commit hook with `gitleaks`.

**Pipeline security**

- The pipeline only reads from the listed public sources over HTTPS and verifies checksums where the source publishes them (BlueTopo does).
- Downloaded archives are extracted into a clean directory and never executed. Scripts live outside the data directory.
- The runner has a scoped R2 token (write to `tiles/` only) and the Supabase service key in environment variables, nothing on disk.

**Incident and account controls**

- A user can delete their account in-app (App Store requirement). Deletion runs as an Edge Function within 24 h and is logged.
- A security contact email is listed in the app and the privacy page.
- If the HMAC salt or service key leaks: rotate, invalidate all sessions, and the exposure is limited to 24 h of last-known positions and handles. Tracks are not on the server, so the worst case is bounded.

## Offline and sync

The app must work for a full day with no network. Everything the map needs is on the device before the boat leaves the dock; everything the boat produces is queued and sent when a connection comes back.

**Cached per AOI (downloaded on WiFi)**

| Item | Format | Size for Skagit AOI (est.) | Refresh |
| --- | --- | --- | --- |
| Base vector tiles z8–z16 (ENC features, land, boundaries) | PMTiles | 40 MB | When `tiles/index.json` shows a new version |
| Depth raster z8–z16 (elevation, source, date) | PMTiles | 120 MB | Same |
| Waterline DEM z10–z16 | PMTiles | 30 MB | Weekly |
| Fleet depth layer z10–z16 | PMTiles | 10 MB | Nightly |
| Tide predictions, all stations in AOI, 30 days | JSON | under 1 MB | Daily |
| Public and group pings, last 48 h | SQLite rows | under 1 MB | On every sync |
| SSCOFS current frames, 72 h (P1) | GeoJSON | 15 MB | 4x daily |

The download screen shows the total before confirming. Downloads are resumable (HTTP range) and run in the background with `expo-background-fetch`. An AOI older than 14 days shows a yellow banner; older than 60 days, a red one.

**Outbound queue**

- Pings, votes, messages and depth batches are written to a local `outbox` table with a client-generated UUID and a monotonically increasing sequence number.
- A sync worker runs on app foreground, on network change, and every 15 minutes in the background. It sends the outbox in order, one batch per table, and marks rows sent on a 2xx. Server inserts are idempotent on the client UUID, so a retry after a dropped connection never duplicates.
- Depth batches are aggregated on device before they enter the outbox, so an 8-hour day is one row per touched H3 cell, not 28,800 soundings.
- If the outbox exceeds 50 MB (weeks offline), the oldest depth batches are merged further, never dropped; pings are never dropped.

**Inbound sync**

- On connect: pull pings and votes updated since the last sync cursor (server `updated_at`), pull group messages since cursor, pull the tiles index, pull tide JSON if older than 24 h.
- Conflicts cannot happen on pings (append-only) or votes (unique on ping and voter; server wins). Profile edits: last write wins.
- Realtime (WebSocket) is used only while online for group messages and new pings in view; it is additive to the cursor sync, never relied on.

**Clock and position when offline**

- All timestamps come from the device clock in UTC; the server records `received_at` separately and rejects anything more than 7 days in the future.
- Ping decay is computed on the device from `created_at` and the newest vote it knows about, so a two-day-old ping fades correctly with no network.
- Tide correction uses cached predictions; when the station's observed level is available later, uploads are not re-corrected (the difference is small and the simplicity is worth it).

**Battery.** Location at 1 Hz with `expo-location` in `Balanced` accuracy while the sounder feed is active, `Lowest` otherwise; NMEA socket reads are buffered and parsed every second; no map re-render on every GPS fix (throttled to 2 Hz). Target: under 5% per hour on an iPad Air with screen on.

## Sprint plan

Nine two-week sprints starting Monday Oct 19, 2026, sized for one developer at about 12 hours a week. Two gates decide whether the next sprint starts. A second developer on the app from Sprint 3 pulls the beta forward about four weeks. Hours are estimates; the "done when" column is the acceptance test.

&#91;embedded content: sprint timeline · 9 sprints, 2 gates, beta Feb 22 2027\]

Data comes first because Gate 1 proves the method works before any app code exists. If the waterline DEM fails the ground-truth check, the app is still worth building on the baseline alone, but the pitch changes.

**Sprint 0: setup and downloads (Oct 19 to Nov 1)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S0-1 | Accounts: Apple Developer, Supabase project, Cloudflare R2 bucket, GitHub repo, Sentry, EAS | 2 | All logins in a password manager; repo has README and license |
| S0-2 | Monorepo: `apps/mobile` (Expo), `pipeline/` (Python), `supabase/` (migrations), CI with lint and test jobs | 3 | `npm test` and `pytest` run green in GitHub Actions on an empty suite |
| S0-3 | Download the Skagit AOI baseline: run `fetch_baseline.py`; manually pull CoNED tiles, 2014 lidar DEM, ENC cells, VDatum grids | 4 | `manifest.json` lists every file with URL, date, checksum |
| S0-4 | Install VDatum and verify one NAVD88 to MLLW point against the NOAA Seattle benchmark sheet | 2 | Difference matches the published datum offset within 0.1 ft |
| S0-5 | Ground-truth plan: pick 3 runs, export last season's Garmin tracks with depth (HomePort or Quickdraw export) | 3 | 3 CSVs of (time, lat, lon, depth, speed) |
| S0-6 | Interview 10 fishermen: bars vs. boundaries vs. currents; which plotter and NMEA gear they run | 6 | Notes doc; gateway inventory for the beta fleet |
| S0-7 | Order a WiFi NMEA gateway (Yacht Devices YDWG-02 or Actisense W2K-1) for the test boat | 1 | On order |

**Sprint 1: datum conversion and merge (Nov 2 to Nov 15)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S1-1 | `to_mllw.py`: convert every NAVD88 raster with VDatum grids, meters to feet, write vertical CRS metadata | 4 | 5 spot-check points match a hand calculation within 0.1 ft |
| S1-2 | Align all layers to the 2 m UTM 10N grid; PDAL pipeline for 2014 lidar LAZ (classes 2 and 29) | 4 | Every layer has identical shape and transform |
| S1-3 | Per-source `date.tif` and `unc.tif` rasters, including BlueTopo RAT decode | 3 | Each source directory has elev, date, unc |
| S1-4 | `merge.py`: newest wins, ties to lower uncertainty, 10-year rule, no interpolation | 4 | Unit tests pass on synthetic stacks; outputs `merged_elev`, `merged_src`, `merged_date`, `merged_unc` |
| S1-5 | ENC to GeoJSON with `ogr2ogr` for DEPARE, DEPCNT, SOUNDG, COALNE, BOYLAT, LIGHTS, OBSTRN, WRECKS, CBLSUB | 3 | One GeoJSON per layer per AOI |
| S1-6 | Boundaries: pull WDFW Marine Areas from the REST service; digitize WAC 220-320-110 crab regions from the legal text; cross-check against PSMFC segments | 4 | GeoJSON with region id, catch area ids, and a citation per feature |
| S1-7 | eHydro Swinomish survey XYZ to raster, added to the merge | 2 | Swinomish channel cells show eHydro as source |

**Sprint 2: waterline DEM and tiles (Nov 16 to Nov 29). Gate 1.**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S2-1 | Run `waterline_dem.py` on real Skagit scenes; mask clouds with the SCL band; tune the NDWI threshold | 5 | Elevation raster covers the flats; bracket under 3 ft on 80% of cells |
| S2-2 | Tide tagging uses the nearest station with NOAA offsets, not Seattle | 2 | Station id stored per scene in `scenes.json` |
| S2-3 | `validate.py`: RMSE and p90 error per source against the 3 ground-truth runs, HTML report | 4 | Report generated in CI on every pipeline run |
| S2-4 | Terrain-RGB encoding, raster PMTiles z8 to z16; vector PMTiles with tippecanoe; Sound-wide low-zoom file | 5 | Tiles render in the MapLibre web demo |
| S2-5 | R2 upload, `tiles/index.json`, Makefile targets for the whole pipeline | 3 | `make skagit` runs end to end from a clean checkout |
| S2-6 | Run fetch, merge and tiles for the other 4 AOIs | 3 | 5 AOIs in the index |
| Gate 1 | Waterline layer p90 error at or under 1.5 ft on Skagit |  | Pass: start S3. Fail: one extra week on thresholds, then decide baseline-only |

**Sprint 3: app shell and offline map (Nov 30 to Dec 13)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S3-1 | Expo app in TypeScript, MapLibre with the PMTiles protocol, large-type helm mode, light and dark | 5 | Map pans at 60 fps on an iPad Air |
| S3-2 | Depth layer renderer: Terrain-RGB to the fixed color ramp, hillshade, legend | 4 | Ramp identical online and offline |
| S3-3 | Tap-to-inspect popup: depth, source, date, uncertainty from the second band set | 3 | Popup under 300 ms; no blank fields |
| S3-4 | AOI download screen: size estimate, resumable, background with `expo-background-fetch` | 5 | Kill the app mid-download, reopen, it resumes |
| S3-5 | GPS position, heading, COG and SOG, stale indicator | 2 | Dot greys after 5 s without a fix |
| S3-6 | Sentry, crash reporting, EAS dev build on David's iPad | 2 | A forced crash shows in Sentry with a stack trace |
| S3-7 | Waterline DEM toggle with hatching under 5 scenes | 2 | Toggle persists across restarts |

**Sprint 4: boundaries, tides, NMEA (Dec 14 to Dec 27). Gate 2.**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S4-1 | Boundary lines and labels from vector tiles; "you are in Region 2E" readout | 3 | Readout matches the WAC coordinates at 3 test points |
| S4-2 | Tide screen: nearest station, 48 h curve, current height; predictions cached 30 days | 4 | Works in airplane mode |
| S4-3 | NMEA 0183 client over TCP and UDP: parse DPT, DBT, GGA, RMC, VHW; connection settings screen | 5 | Depth updates at 1 Hz from the gateway |
| S4-4 | Depth-under-keel numeral with transducer offset and tide correction | 3 | Within 0.5 ft of the plotter on the test boat |
| S4-5 | On-boat test: run the Skagit flats on a low tide, compare app to plotter, note every surprise | 4 | Notes and screenshots in the repo |
| Gate 2 | Full day offline, no crash, depth numeral within 0.5 ft of the plotter |  | Pass: start S5 |

**Sprint 5: backend, auth, groups (Dec 28 to Jan 10)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S5-1 | Schema migrations for every table in the data model; RLS policies; check constraints | 5 | Migrations apply from zero in CI |
| S5-2 | Sign in with Apple and phone OTP; session in Keychain; in-app account deletion | 5 | Deleted account cannot sign in; its pings are gone within 24 h |
| S5-3 | Groups: create, invite code, join, leave, remove; realtime channel; messages | 6 | Two devices see each other's messages within 2 s |
| S5-4 | Cloudflare Worker: validate Supabase JWT, issue signed R2 URL, per-account quota | 4 | Unauthenticated tile request returns 401 |
| S5-5 | RLS test matrix with pgTAP: owner, member, non-member, anon for every table | 3 | Matrix passes in CI |

**Sprint 6: pings, votes, trust (Jan 11 to Jan 24)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S6-1 | Ping UI: two taps, drag to place, 6 types, optional note, pending-sync mark | 5 | A ping with gloves on in under 3 s |
| S6-2 | Outbox and sync worker for pings, votes, messages; idempotent on client UUID | 5 | Airplane mode for an hour, reconnect, everything lands once |
| S6-3 | Score function in SQL and on the client; decay; three render states | 4 | Same ping scores identically on server and device |
| S6-4 | Confirm and dispute with distance weighting; last-known position rounded to 100 m every 5 min | 4 | A vote from 2 km away has zero weight |
| S6-5 | Weekly reputation batch as a cron Edge Function; `audit_log` | 3 | Batch runs on a test dataset and writes the expected deltas |
| S6-6 | Rate limits in an Edge Function | 2 | The 31st ping in an hour returns 429 |

**Sprint 7: depth logging and fleet layer (Jan 25 to Feb 7)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S7-1 | Background depth logger: SOG, jump and HDOP filters; tide correction; SQLCipher store | 5 | 8 h run stored under 5 MB |
| S7-2 | On-device H3 res 12 aggregation and upload batches; HMAC uploader hash issued by an Edge Function | 4 | Upload payload inspected: no uid, no time of day |
| S7-3 | Server hold rule for 15 ft baseline disagreement; release on a second boat | 3 | Test fixture holds and releases correctly |
| S7-4 | Nightly fleet rebuild to PMTiles on R2; app layer with hatching under 3 boats | 5 | Layer appears the morning after a logged run |
| S7-5 | Per-boat constant-bias flag shown only to that user | 2 | A 1.5 ft offset error triggers the notice |
| S7-6 | Battery and storage test over an 8 h run | 3 | Under 5% per hour on an iPad Air |

**Sprint 8: hardening and TestFlight (Feb 8 to Feb 21)**

| ID | Task | Hours | Done when |
| --- | --- | --- | --- |
| S8-1 | Security review against the Security section; certificate pinning; gitleaks; dependency audit | 4 | Every row of the threat model has a verified control |
| S8-2 | Privacy page, terms, "not for navigation" on first launch and on the map; App Store privacy labels | 3 | Legal copy reviewed by a lawyer or at minimum a template adapted and read twice |
| S8-3 | Run the end-to-end suite; fix P0 bugs | 6 | Zero open P0 bugs |
| S8-4 | Onboarding: 5 screens plus a gateway setup guide with photos of the YDWG-02 and W2K-1 | 3 | A fisherman who has never seen the app connects the gateway without help |
| S8-5 | TestFlight build, 12 testers invited, feedback form | 2 | 12 installs |
| S8-6 | Beta runbook: how to report a bug, what to expect, weekly check-in | 2 | Sent to testers |
| S8-7 | Dock session with the beta fleet: install, connect gateway, download AOI | 4 | 10 of 12 boats leave the dock with a cached AOI |

**After beta (not scheduled):** N2K direct via gateway, SSCOFS currents layer, WDFW notice feed, route depth check, GPX export, Android. Order is decided by what the beta fleet asks for.

## Testing and end-to-end QA

The map can be wrong in ways that put a boat on a bar, so the pipeline is tested like a safety system: against ground truth, with a hard gate, on every run. The app is tested for the one scenario that matters: a full day offline on a real boat.

**Pipeline**

| Level | What | Tool | Runs |
| --- | --- | --- | --- |
| Unit | `merge.py` newest-wins and 10-year rule on synthetic stacks; `waterline_dem.py` on synthetic tide scenes (already passing, 0.53 ft max error on a 12-scene ramp); datum conversion on 5 known points | pytest | Every push |
| Integration | `make skagit` from a clean checkout produces tiles whose index validates against a JSON schema | pytest + GitHub Actions | Every push to `pipeline/` |
| Ground truth | `validate.py` against 3 sounder runs; RMSE and p90 per source | pytest, fails under p90 1.5 ft | Every pipeline run; this is Gate 1 |
| Regression | Diff new merged raster against the last published version; any cell shallower by more than 3 ft is listed for review before publish | Script + manual review | Every publish |
| Datum sanity | Shoreline from ENC COALNE must sit at roughly +9 to +13 ft MLLW in the merged raster (MHHW is about +11.4 ft above MLLW at Seattle) | pytest | Every publish |

**Backend**

| Level | What | Tool |
| --- | --- | --- |
| RLS matrix | For each table: owner, group member, non-member, anon; select, insert, update, delete | pgTAP in Supabase CI |
| Edge functions | Score batch, reputation batch, rate limiter, HMAC issuer, account deletion | Deno test |
| Contract | OpenAPI-style schema for every endpoint the app calls, checked against the generated Supabase types | TypeScript `tsc` in CI |
| Load | 50 boats uploading a day of depth cells inside 10 minutes; 200 pings a minute | k6, once before beta |

**App**

| Level | What | Tool |
| --- | --- | --- |
| Unit | Score and decay math, NMEA sentence parsing (DPT, DBT, GGA, RMC, VHW with bad checksums), tide interpolation, H3 aggregation, outbox ordering | Jest |
| Component | Ping sheet, tide screen, download screen, inspect popup | React Native Testing Library |
| E2E (simulator) | The six flows below | Maestro, on every PR to `apps/mobile` |
| E2E (device) | The same six flows on a physical iPad in airplane mode, plus an NMEA simulator feeding the gateway | Manual checklist before each TestFlight build |
| Field | One full fishing day per sprint from S4 on; notes on anything that surprised the skipper | Manual |

**The six end-to-end flows**

1. **Cold start to cached map.** Install, sign in with Apple, pick the Skagit AOI, download, kill the app, enable airplane mode, reopen. The map renders with depth, boundaries and tides. Pass: under 2 s to first tile, no network calls attempted except the sync worker's no-op.
2. **Underway with a sounder.** NMEA simulator sends DPT and RMC at 1 Hz. Depth-under-keel updates; the position dot follows; the region readout changes when crossing a boundary. Pass: depth within 0.1 ft of the simulated value after offset and tide correction.
3. **Hazard ping offline.** Airplane mode, drop a "bar moved" ping, kill the app, reopen, ping still shows as pending; disable airplane mode, ping syncs once; a second device sees it within 10 s. Pass: exactly one row on the server.
4. **Confirm with distance check.** Device B at 100 m confirms; device C at 3 km confirms. Pass: score rises from B's vote only.
5. **Depth log to fleet layer.** 30-minute simulated run, app backgrounded, upload on reconnect, nightly job run manually, AOI re-downloaded. Pass: the cell appears hatched (1 boat); after 2 more simulated boats it renders solid; the upload payload contains no uid or timestamp.
6. **Group secrecy.** User A posts a group ping; user B (not a member) cannot see it via the app or a direct REST call with B's token; B joins by invite, sees it; B is removed, loses it on next sync. Pass: every step verified with both the UI and `curl`.

**Release checklist (every TestFlight build)**

- [ ] Pipeline validate report green for all 5 AOIs
- [ ] Maestro suite green
- [ ] Device E2E checklist signed off
- [ ] Sentry shows no new crash signatures from the previous build
- [ ] Privacy labels and disclaimer unchanged or updated with the build
- [ ] Changelog sent to the beta fleet

## Legal, licensing, liability

I am not a lawyer; this is the checklist to take to one before the beta. The exposure is real: someone will run aground with the app open.

**Liability**

- "Not for navigation" disclaimer on first launch (must be accepted), as a persistent line on the map, and in the terms. Every chart app does this, and NOAA's own data pages carry the same language.
- Terms of service with limitation of liability and the user's acknowledgment that depth data is crowdsourced and modeled, not surveyed.
- The app shows source and date for every cell. That is the honest version of the disclaimer and the best defense: the user can see when a number is from 1950.
- Form an LLC for the app rather than running it under the LYMLY sole proprietorship, so a claim stops at the company. Washington LLC filing is about $200 plus a registered agent.
- General liability insurance quote once there are paying users; some carriers cover software products.

**Data licensing**

| Source | Terms | What we must do |
| --- | --- | --- |
| NOAA, USGS, USACE data | US government work, public domain | Nothing required; cite the source in the app's data page anyway |
| NOAA ENC | Public domain, but NOAA asks that derived products not be presented as official charts | Disclaimer; never call the base map an "ENC" |
| Sentinel-2 | Copernicus: free for any use with attribution | "Contains modified Copernicus Sentinel data \[year\]" on the data page |
| WDFW boundaries | Public records; confirm reuse terms with WDFW GIS | Email WDFW GIS once; cite WAC sections |
| OpenStreetMap | ODbL | Attribution on the map; our derived vector tiles that mix OSM with other data may trigger share-alike on the mixed tile. Keep OSM in its own PMTiles file to avoid this |
| MapLibre, GDAL, PDAL, tippecanoe, PMTiles | BSD, MIT, Apache style | Keep a licenses screen in the app |
| Supabase, Expo | Apache 2.0, MIT | Same |

**User data**

- Privacy policy covering: what is collected (handle, vessel name, pings, aggregated depth, last-known position for 24 h), what is never collected (raw tracks), retention, deletion, and the security contact. App Store requires a privacy policy URL and in-app account deletion.
- No sale of data, stated plainly. Fleet depth aggregates are the product's own asset and are not resold.
- Washington's My Health My Data Act does not apply (no health data). CCPA does not apply at beta scale. Keep it simple and true.

**Regulatory**

- The app displays regulatory boundaries but is not the authority. State that WDFW rules and the WAC govern, and link to them.
- No AIS transmission, no radio, nothing that touches FCC rules in v1.

**Commercial**

- Pricing to validate with the beta fleet: $120 to $180 per vessel per year, matching Bristol Maps' $150. Free during beta. Group features free for fleets of 3 or more to drive adoption.
- Apple takes 15% of in-app subscriptions under the Small Business Program (under $1M a year), 30% otherwise. Rules on linking to cheaper web pricing from inside the app have been changing; check at launch.

## Risks, open questions, decisions needed

**Risks**

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Waterline DEM fails Gate 1 because delta water is too turbid for NDWI | Medium | Pitch loses its freshest layer | Try MNDWI (green/SWIR) and a per-AOI threshold; fall back to Landsat; if it still fails, ship baseline plus fleet layer and say so |
| VDatum conversion error in the north Sound where tidal datums vary fast | Medium | Systematic 1 to 2 ft bias | Shoreline sanity test on every publish; compare against NOAA benchmark sheets at Seattle, Port Townsend, Friday Harbor |
| NMEA gateway friction: boats will not buy or wire a $200 box | High | No passive logging, fleet layer starves | Make the app useful with no gateway (baseline, pings, boundaries, tides); offer to install gateways at the dock session; P1 N2K direct |
| Fewer than 10 active beta boats | Medium | No signal on the fleet layer | Recruit 20, expect 12; group features free to pull whole fleets |
| Garmin or Navionics ship a commercial-grade freshness layer | Low | Differentiation shrinks | Our edge is regions, groups, secrecy, and the delta hotspots; they will not chase 500 users |
| Solo developer time, with a full-time job from Sept 2026 | High | Beta slips | 24 h sprints, two gates, cut P1 ruthlessly; a second dev on the app from S3 if available |
| App Store rejection over the navigation disclaimer or account deletion | Low | 1 to 2 week delay | Follow the checklist in Legal; account deletion is in S5 |
| A bad actor poisons pings near their gear | Medium | Trust in the map | Reputation, distance-weighted votes, group isolation, 2-vote threshold for solid rendering |
| R2 or Supabase outage on a fishing day | Low | None on the water; sync waits | Offline-first means the boat never depends on the backend |

**Open questions**

- [ ] Which NOAA subordinate tide stations cover Skagit Bay, Port Susan and the Swinomish approach, and what are their offsets from Port Townsend? Pull from the CO-OPS metadata API in S0.
- [ ] Does the 2020 or 2021 USACE NCMP lidar reach inside the Sound, or only the outer coast? Check the Digital Coast footprint in S0.
- [ ] Is SSCOFS published to the NODD buckets under `sscofs`, or only on NOMADS? Decides the currents job in P1.
- [ ] Is BlueTopo's vertical datum MLLW in every Puget Sound tile? Read the tile metadata in S0.
- [ ] Does WDFW publish the commercial crab region polygons anywhere as GIS, or do we digitize WAC 220-320-110 ourselves? Email WDFW GIS in S0.
- [ ] What gateways does the beta fleet already have? Decides whether 0183 over WiFi is enough for the beta or N2K direct moves to P0.
- [ ] Is the right first area Skagit Bay, or Port Susan where fewer boats run and the bars move more? Interviews in S0-6 decide.

**Decisions needed from David before Sprint 0**

1. Confirm the working name, or pick one. "Sound Maps" is a placeholder.
2. iOS only for the beta (recommended) or iOS and Android from the start (adds about 2 sprints).
3. Supabase hosted (recommended) or self-hosted. Hosted costs $25/mo and saves roughly a sprint of ops work.
4. Form the LLC now or after the beta. Recommended: before any outside boat installs the app.
5. Who the 12 beta boats are, and who among them will tolerate a buggy first build.

## Sources

- [Bristol Maps on the App Store](https://apps.apple.com/us/app/id1608263684)
- [KDLG: Bristol Maps app changes navigation for fishermen](https://www.kdlg.org/news/2024-07-24/bristol-maps-app-changes-navigation-for-fishermen)
- [USGS: Topobathymetric Model of Puget Sound, 1887 to 2017](https://www.usgs.gov/data/topobathymetric-model-puget-sound-washington-1887-2017)
- [USGS ScienceBase: Puget Sound TBDEM](https://www.sciencebase.gov/catalog/item/5d72b5dfe4b0c4f70cffa775)
- [NOAA Digital Coast: CoNED Puget Sound](https://www.fisheries.noaa.gov/inport/item/59971)
- [NOAA NCEI CUDEM 1/9" Puget Sound tiles](https://chs.coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/wash_pugetsound/index.html)
- [NOAA BlueTopo (InPort)](https://www.fisheries.noaa.gov/inport/item/75311)
- [BlueTopo Python fetcher](https://pypi.org/project/BlueTopo/0.5.0)
- [2014 USACE/USGS Topobathy Lidar: Puget Sound](https://www.fisheries.noaa.gov/inport/item/50183)
- [2020 USACE NCMP Topobathy Lidar: Washington](https://www.fisheries.noaa.gov/inport/item/72573)
- [2021 USACE NCMP Topobathy Lidar DEM: Washington](https://fisheries.noaa.gov/inport/item/72562)
- [Washington Lidar Portal](https://lidarportal.dnr.wa.gov/)
- [NOAA ENC Chart Downloader](https://charts.noaa.gov/ENCs/ENCs.shtml)
- [NOAA ENC Direct to GIS](https://www.NauticalCharts.NOAA.gov/learn/encdirect/)
- [NOAA SSCOFS](https://tidesandcurrents.noaa.gov/ofs/sscofs/sscofs_info.html)
- [NOAA OFS on AWS Open Data](https://docs.opendata.aws/noaa-ofs-pds/readme.html)
- [NOAA VDatum](https://vdatum.noaa.gov/)
- [WDFW Recreational Marine Area service](https://geodataservices.wdfw.wa.gov/arcgis/rest/services/FP_Projects/Recreational_Marine_Area/MapServer)
- [PSMFC Marine Area Polygon Segments](https://gis.psmfc.org/server/rest/services/Hosted/MarineAreaPolygonSegments/FeatureServer)
- [CISA: eHydro USACE Hydrographic Surveys](https://www.cisa.gov/mts-resilience-resources/ehydro-usace-hydrographic-surveys)
- [Microsoft Planetary Computer STAC](https://planetarycomputer.microsoft.com/api/stac/v1)
