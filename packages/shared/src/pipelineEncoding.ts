/**
 * Tile encodings produced by the pipeline. SOURCE OF TRUTH: pipeline/common.py (SOURCES registry) and
 * pipeline/tiles.py (Terrain-RGB, source/date/unc packing, UNC_LEVELS_FT). If those change, change
 * this file in the same commit.
 */

/** Terrain-RGB depth tiles: standard Mapbox formula but the value is FEET MLLW (positive up). */
export const TERRAIN_RGB_BASE = -10000;
export const TERRAIN_RGB_INTERVAL = 0.1;
/** (R,G,B) = (0,0,0) is reserved for "no data". */

/** Source codes written to merged_src.tif and the meta tiles (0 = no data). Fit in 4 bits (0..15). */
export const SOURCE_CODES = {
  bluetopo: 1,
  ehydro: 2,
  lidar_ncmp: 3,
  lidar_2014: 4,
  wa_lidar: 5,
  cudem: 6,
  coned: 7,
  waterline: 8,
} as const;
export type SourceName = keyof typeof SOURCE_CODES;

export const SOURCE_LABELS_BY_CODE: Readonly<Record<number, string>> = {
  1: 'NOAA BlueTopo',
  2: 'USACE eHydro',
  3: 'USACE NCMP topobathy lidar 2020/21',
  4: 'USACE/USGS topobathy lidar 2014',
  5: 'WA DNR lidar portal',
  6: 'NOAA NCEI CUDEM 1/9 arc-sec',
  7: 'USGS CoNED Puget Sound TBDEM',
  8: 'Sentinel-2 waterline DEM',
};

/**
 * Vertical-uncertainty buckets (ft); the meta tile stores the index and always rounds UP.
 * Per the pipeline review outcome: index 15 means UNKNOWN exclusively; real values >= 45 ft clamp to index 14,
 * which is OPEN-ENDED (">= 45 ft"). Indices 0..13 are the finite levels below.
 * TODO: re-verify against pipeline/common.py once the pipeline fix pass lands.
 */
export const UNC_LEVELS_FT = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.5, 10.0, 15.0, 20.0, 45.0] as const;
export const UNC_OPEN_ENDED_INDEX = 14;
export const UNC_OPEN_ENDED_MIN_FT = 45;
export const UNKNOWN_UNC_INDEX = 15;

/** Meta tile date: big-endian uint16 of (days since 1970 + 32872) = days since 1880-01-01. */
export const META_DATE_EPOCH_SHIFT_DAYS = 32872;

/**
 * Per-cell source/date/uncertainty ships as a SEPARATE raster archive by path convention (NOT listed in
 * tiles/index.json): tiles/<aoi>/<version>/depth_meta.pmtiles
 */
export const DEPTH_META_FILENAME = 'depth_meta.pmtiles';
