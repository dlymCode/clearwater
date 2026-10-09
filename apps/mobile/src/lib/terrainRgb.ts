/**
 * Terrain-RGB decoding for tap-to-inspect (MAP-3), plus the slippy-map tile math to find the pixel.
 *
 * Pipeline contract (pipeline/tiles.py): the standard Mapbox formula, but the value is FEET MLLW,
 * positive up (no metre conversion):
 *     elev_ft = -10000 + 0.1 * (R*65536 + G*256 + B)
 * (R,G,B) = (0,0,0) is reserved for "no data". Depth = -elevation.
 *
 * MapLibre assumes the decoded value is metres, so for hillshade scale exaggeration by 0.3048
 * (see HILLSHADE_EXAGGERATION_SCALE in mapStyle.ts); the colour ramp stops are given in raw feet.
 */
import { TERRAIN_RGB_BASE, TERRAIN_RGB_INTERVAL } from '@clearwater/shared';

/**
 * Decode one pixel to elevation in feet (MLLW, positive up), or null for no data
 * (RGB 0,0,0 or alpha 0).
 */
export function decodeTerrainRgb(r: number, g: number, b: number, a = 255): number | null {
  if (a === 0) return null;
  const code = r * 65536 + g * 256 + b;
  if (code === 0) return null;
  return TERRAIN_RGB_BASE + code * TERRAIN_RGB_INTERVAL;
}

/** Inverse (tests/simulators): elevation in feet -> [r,g,b]. Out-of-range values encode as no-data. */
export function encodeTerrainRgb(elevationFt: number): [number, number, number] {
  const code = Math.round((elevationFt - TERRAIN_RGB_BASE) / TERRAIN_RGB_INTERVAL);
  if (!Number.isFinite(code) || code < 1 || code > 0xffffff) return [0, 0, 0];
  return [(code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff];
}

export interface TilePixel {
  z: number;
  x: number;
  y: number;
  /** Pixel within the tile, 0..tileSize-1. */
  px: number;
  py: number;
}

/** WGS84 lon/lat -> tile + pixel at zoom z (EPSG:3857 slippy scheme). */
export function lonLatToTilePixel(lon: number, lat: number, z: number, tileSize = 256): TilePixel {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.0511287798, Math.min(85.0511287798, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const xf = ((lon + 180) / 360) * n;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(xf)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(yf)));
  const px = Math.min(tileSize - 1, Math.floor((xf - x) * tileSize));
  const py = Math.min(tileSize - 1, Math.floor((yf - y) * tileSize));
  return { z, x, y, px, py };
}
