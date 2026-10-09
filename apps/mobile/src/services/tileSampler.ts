/**
 * Tap-to-inspect pixel sampling. MapLibre RN cannot read raster values, so the app reads the tile bytes from
 * the local PMTiles files itself (depth.pmtiles for elevation, depth_meta.pmtiles for source/date/uncertainty),
 * decodes the PNG and returns the pixel under the tap. Decoding then goes through lib/inspect.ts.
 *
 * STUB: needs (a) a PMTiles reader that works on a local file (the `pmtiles` JS package with a FileSource over
 * expo-file-system) and (b) a PNG decoder (e.g. upng-js). Until then every sample is null, which the popup
 * renders as "unknown" (never blank).
 */
import type { RgbaPixel } from '../lib/inspect';
import { lonLatToTilePixel } from '../lib/terrainRgb';

export interface TileSampler {
  sample(archive: 'depth' | 'depth_meta', lon: number, lat: number, zoom: number): Promise<RgbaPixel | null>;
}

export const stubTileSampler: TileSampler = {
  async sample(_archive, lon, lat, zoom) {
    void lonLatToTilePixel(lon, lat, Math.min(16, Math.max(8, Math.round(zoom))));
    return null;
  },
};
