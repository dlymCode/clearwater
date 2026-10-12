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
 * Verified against pipeline/common.py and pipeline/tiles.py (levels, open-ended index 14, unknown index 15).
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

/**
 * fleet.pmtiles is Terrain-RGB with the SAME decoder as depth.pmtiles (feet, positive up): the pipeline NEGATES depth to
 * elevation before encoding (12 ft of water decodes as -12; a drying hump at depth -2 decodes as +2). The charted depth
 * to display is therefore -decoded, exactly as for the baseline.
 *
 * Per-cell boat count and freshness ship as a SEPARATE raster archive by path convention (not in tiles/index.json),
 * tiles/<aoi>/<version>/fleet_meta.pmtiles. MIRROR of pipeline/tiles.py pack_fleet_meta / unpack_fleet_meta (source of
 * truth): R = distinct-boat count clamped to 255; G,B = big-endian uint16 days since 1880-01-01 of the newest contributing
 * day (same epoch as depth_meta); A = 255 valid / 0 hole (alpha is only a validity flag).
 */
export const FLEET_META_FILENAME = 'fleet_meta.pmtiles';
export const FLEET_META_MAX_BOATS = 255;
/** R sits above the 16 date bits, so a Terrain-RGB read of this archive has code = boats * 65536 + uint16 day. */
export const FLEET_META_BOATS_SHIFT = 65536;

export interface FleetMeta {
  boats: number;
  /** Newest contributing UTC day, days since 1970-01-01. */
  newestDay1970: number;
}

/** null for holes (alpha != 255). */
export function decodeFleetMetaPixel(r: number, g: number, b: number, a: number): FleetMeta | null {
  if (a !== 255) return null;
  return { boats: r, newestDay1970: g * 256 + b - META_DATE_EPOCH_SHIFT_DAYS };
}
