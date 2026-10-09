# Data licenses and attribution

Source list from PRD §Data catalog and §Legal, licensing, liability. Every source is free to use.
Attribution text must appear on the app's data page and in the release notes.

## Depth and elevation

| Dataset | Publisher | License / terms | Attribution or obligation | Notes |
| --- | --- | --- | --- | --- |
| USGS CoNED Puget Sound TBDEM | USGS (ScienceBase; NOAA Digital Coast mirror) | US federal work, public domain | Cite source: USGS Topobathymetric Model of Puget Sound, 1887 to 2017 | NAVD88; convert to MLLW with VDatum before merge |
| WA DNR CoNED MLLW conversion | WA DNR Nearshore Habitat Program | State agency data; confirm reuse terms with WA DNR before public release | Cite WA DNR and the USGS CoNED model it derives from | Already MLLW; still record vertical CRS metadata |
| NOAA NCEI CUDEM 1/9" | NOAA NCEI | US federal work, public domain | Cite NOAA NCEI CUDEM | NAVD88 |
| NOAA BlueTopo | NOAA OCS | US federal work, public domain | Cite NOAA BlueTopo; retain source survey ID and date | MLLW (confirm per tile) |
| 2014 USACE/USGS Topobathy Lidar: Puget Sound | USACE / USGS via NOAA Digital Coast | US federal work, public domain | Cite source | NAVD88 |
| USACE NCMP Topobathy Lidar: Washington (2020, 2021) | USACE / NOAA Digital Coast | US federal work, public domain | Cite source | NAVD88 |
| Washington Lidar Portal projects | WA DNR | State agency data; check each project's terms on the portal | Cite WA DNR and project name | NAVD88 |
| USACE eHydro (Seattle District) | USACE Hydrographic Surveys | US federal work, public domain | Cite source and survey date | MLLW; ArcGIS feature service URL to be confirmed |
| NOAA ENC | NOAA Office of Coast Survey | US federal work, public domain. NOAA asks that derived products not be presented as official charts | Disclaimer required; never call the base map an "ENC" or an official chart | MLLW; weekly refresh |
| NOAA 1/3" Puget Sound DEM | NOAA NCEI (NTHMP tsunami DEM) | US federal work, public domain | Cite source | MHW datum; fallback only |

## Imagery

| Dataset | Publisher | License / terms | Attribution or obligation | Notes |
| --- | --- | --- | --- | --- |
| Sentinel-2 L2A | ESA Copernicus, via Microsoft Planetary Computer or AWS Earth Search | Copernicus: free for any use with attribution | "Contains modified Copernicus Sentinel data [year]" on the data page | Used for NDWI waterline DEM |
| Landsat 8/9 Collection 2 Level 2 | USGS | US federal work, public domain | Cite source | Fallback and longer history |

## Water level, currents and context

| Dataset | Publisher | License / terms | Attribution or obligation | Notes |
| --- | --- | --- | --- | --- |
| NOAA CO-OPS tides | NOAA | US federal work, public domain | Cite source | Predictions and observed levels, MLLW |
| NOAA SSCOFS currents | NOAA OFS | US federal work, public domain | Cite source | P1 layer |
| NOAA VDatum | NOAA | US federal work, public domain | Cite source and version | Grids used for NAVD88 to MLLW |
| WDFW Marine Areas and Marine Fish-Shellfish Catch Areas | WDFW | Public records. Confirm reuse terms with WDFW GIS by email before beta (open item) | Cite WAC 220-301-030 and WAC 220-320-110 | Boundaries are regulatory context only. WDFW rules and the WAC govern; the app is not the authority |
| WAC 220-320-110 text (crab region coordinates) | Washington State Legislature (WAC) | Public law | Cite WAC 220-320-110 per feature | Digitize from legal text; do not trace the PDF |
| WDFW commercial crab notices | WDFW | Public notices; scraped. Confirm reuse terms with WDFW GIS | Link to the source notice | Per-notice refresh |
| PSMFC Marine Area Polygon Segments | Pacific States Marine Fisheries Commission | Confirm terms before reuse | Cite PSMFC | Cross-check only |
| OpenStreetMap (land, roads, place names) | OpenStreetMap contributors via Protomaps or Geofabrik | ODbL 1.0 | "Map data &copy; OpenStreetMap contributors" visible on the map; share-alike applies to derived databases | Keep OSM in its own PMTiles file so the share-alike obligation does not reach mixed tiles |

## Open-source components (license screen)

| Component | License |
| --- | --- |
| MapLibre (native and GL) | BSD / open source |
| GDAL, PDAL, tippecanoe, PMTiles CLI | BSD / MIT / Apache style |
| Supabase, Expo | Apache 2.0 / MIT |

## Open items

- WDFW GIS: confirm reuse terms for Marine Areas, catch areas and crab notices (email once, during Sprint 0).
- WA DNR: confirm reuse terms for the CoNED MLLW conversion product.
- Keep the app's licenses screen in sync with this table.
