/**
 * MapLibre style builder (pure JSON; no @maplibre imports so it can be unit-tested in node).
 * The screen passes the result to <Map mapStyle=...> (typed there with one documented cast).
 *
 * Tile contract (a PMTiles archive holds ONE tile type, so each product is its own file):
 *  - base.pmtiles   vector. source-layers: DEPARE, DEPCNT, SOUNDG, COALNE, BOYLAT, LIGHTS, OBSTRN, WRECKS, CBLSUB and
 *                   `boundaries` (props: region_id, kind), all inside the one file.
 *  - land.pmtiles   vector (OSM land, ODbL kept separate), by path convention tiles/<aoi>/<version>/land.pmtiles, source-
 *                   layer `land`. OPTIONAL: absent => no land fill, the map still works.
 *  - depth.pmtiles  raster Terrain-RGB, standard Mapbox formula but values are FEET MLLW (pipeline/tiles.py), z8-z16,
 *                   tileSize 256. MapLibre treats decoded values as metres, so colour-ramp stops are raw feet and
 *                   hillshade exaggeration is scaled by 0.3048.
 *  - depth_meta.pmtiles  per-cell source/date/uncertainty (RGBA), NOT in index.json; sampled by the inspect popup,
 *                   never drawn.
 *  - waterline.pmtiles raster Terrain-RGB for elevation. OPTIONAL. TODO(pipeline): scene-count hatching (MAP-4, n < 5)
 *                   returns when the pipeline ships per-cell counts as a separate archive; today it masks cells with
 *                   fewer than 5 scenes entirely, so there is nothing to hatch.
 *  - fleet.pmtiles  raster Terrain-RGB, decoded EXACTLY like depth.pmtiles (feet, positive up): the pipeline negates depth to
 *                   elevation before encoding, so the same colour ramp applies. OPTIONAL.
 *  - fleet_meta.pmtiles  per-cell boat count + newest day (RGBA), by path convention, OPTIONAL. Used (a) to wash out cells
 *                   with fewer than 3 boats (below) and (b) by the fleet inspect popup.
 *
 * Optional products are included only when their URL is passed; the builder never references a source it did not
 * declare, so a missing land / waterline / fleet file cannot break the map.
 */
import {
  DEPTH_COLOR_RAMP_FT,
  FLEET_META_BOATS_SHIFT,
  FLEET_MIN_BOATS,
  METERS_PER_FOOT,
  TERRAIN_RGB_BASE,
  TERRAIN_RGB_INTERVAL,
  TILE_ZOOM,
} from '@clearwater/shared';

export interface LayerToggles {
  depth: boolean;
  hillshade: boolean;
  waterline: boolean;
  fleet: boolean;
  boundaries: boolean;
}

export const DEFAULT_TOGGLES: LayerToggles = {
  depth: true,
  hillshade: true,
  waterline: false,
  fleet: false,
  boundaries: true,
};

/** `pmtiles://file:///.../depth.pmtiles` or `pmtiles://https://signed-url`. Optional layers may be absent. */
/** MapLibre assumes metres; our values are feet, so shrink hillshade exaggeration by 0.3048. */
export const HILLSHADE_EXAGGERATION_SCALE = METERS_PER_FOOT;

export interface TileUrls {
  base: string;
  depth: string;
  /** depth_meta.pmtiles (inspect only; not drawn). */
  depthMeta?: string;
  /** land.pmtiles (optional). */
  land?: string;
  waterline?: string;
  fleet?: string;
  /** fleet_meta.pmtiles (optional); drives the low-confidence wash. */
  fleetMeta?: string;
}

export interface StyleLayer {
  id: string;
  type: string;
  source?: string;
  'source-layer'?: string;
  filter?: unknown;
  minzoom?: number;
  maxzoom?: number;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

export interface StyleSource {
  type: 'vector' | 'raster' | 'raster-dem';
  url: string;
  tileSize?: number;
  encoding?: 'mapbox' | 'terrarium';
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}

export interface MapStyleJson {
  version: 8;
  name: string;
  glyphs?: string;
  sources: Record<string, StyleSource>;
  layers: StyleLayer[];
}

// --- Depth color ramp ----------------------------------------------------------------------------

/** Fixed ramp (MAP-2): identical online and offline. Depth in ft below MLLW; first stop is drying. */
export interface LegendStop {
  /** Depth (ft below MLLW, positive down) at which this color applies exactly. */
  depthFt: number;
  color: string;
  label: string;
}

const RAMP_COLORS: Record<number, string> = {
  0: '#e5483f', // 0 ft: at chart datum
  3: '#f0873a',
  6: '#f4cf52',
  10: '#9bd7e6',
  20: '#4a98d3',
  40: '#163f7a',
};
/** Above datum (bar dries at low water). */
export const DRYING_COLOR = '#b89a64';

export function depthLegend(): LegendStop[] {
  const stops: LegendStop[] = [{ depthFt: -3, color: DRYING_COLOR, label: 'Dries' }];
  DEPTH_COLOR_RAMP_FT.forEach((d, i) => {
    const next = DEPTH_COLOR_RAMP_FT[i + 1];
    stops.push({
      depthFt: d,
      color: RAMP_COLORS[d] as string,
      label: next === undefined ? `${d}+ ft` : `${d}-${next} ft`,
    });
  });
  return stops;
}

/** Ramp bands as [deepest..shallowest] depth-ft lower bounds: band d covers depth [d, next deeper-bound). */
const BAND_EPS = 0.001;
/** Anything below this decodes from a no-data pixel (RGB 0,0,0 = -10000 ft); real elevations are far above it. */
const NODATA_BELOW_FT = -5000;
const TRANSPARENT = 'rgba(0,0,0,0)';

/**
 * color-relief expression over the decoded raster value. The depth tiles carry FEET MLLW (positive up) and
 * MapLibre treats the value as "metres", so stops are raw feet. The legend shows HARD BANDS (0-3, 3-6, ... 40+),
 * so the expression emits hard bands too (paired stops BAND_EPS apart) instead of a smooth gradient: what the
 * legend says is what the map draws.
 *   depth >= 40 ft          -> RAMP[40]        value <= -40
 *   20 <= depth < 40        -> RAMP[20]        -40 < value <= -20
 *   ... 0 <= depth < 3      -> RAMP[0]         -3 < value <= 0
 *   dries (value > 0)       -> DRYING_COLOR
 */
export function colorReliefStops(): Array<[number, string]> {
  const ramp = [...DEPTH_COLOR_RAMP_FT].sort((a, b) => b - a); // 40,20,10,6,3,0
  // No-data decodes to -10000 ft: transparent, so holes stay holes instead of clamping to the deepest colour.
  const stops: Array<[number, string]> = [
    [NODATA_BELOW_FT, TRANSPARENT],
    [NODATA_BELOW_FT + BAND_EPS, RAMP_COLORS[ramp[0] as number] as string],
    [-ramp[0]! - 10, RAMP_COLORS[ramp[0] as number] as string],
  ];
  ramp.forEach((d, i) => {
    const color = RAMP_COLORS[d] as string;
    if (i === 0) stops.push([-d, color]); // everything at or below -40 stays deepest
    else {
      const upper = ramp[i - 1]!; // the deeper breakpoint closing this band from below
      stops.push([-upper + BAND_EPS, color]);
      stops.push([-d, color]);
    }
  });
  stops.push([BAND_EPS, DRYING_COLOR]);
  stops.push([3, DRYING_COLOR]);
  return stops;
}

export function colorReliefExpression(): unknown[] {
  const expr: unknown[] = ['interpolate', ['linear'], ['elevation']];
  for (const [v, c] of colorReliefStops()) expr.push(v, c);
  return expr;
}

/** Evaluate the ramp the way MapLibre's linear interpolate does, for a depth in ft (positive down). Used by tests. */
export function rampColorAtDepth(depthFt: number): string {
  const v = -depthFt;
  const stops = colorReliefStops();
  if (v <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i]!;
    const [v0, c0] = stops[i - 1]!;
    if (v <= v1) {
      // Hard bands only interpolate between equal colors (or across a BAND_EPS-wide step); pick the nearer stop.
      return v - v0 < v1 - v ? c0 : c1;
    }
  }
  return stops[stops.length - 1]![1];
}

// --- Style --------------------------------------------------------------------------------------

const vis = (on: boolean): Record<string, unknown> => ({ visibility: on ? 'visible' : 'none' });

export interface BuildOptions {
  /** URL template for locally bundled glyphs (needed for region labels offline). */
  glyphs?: string;
  dark?: boolean;
}

export function buildMapStyle(urls: TileUrls, toggles: LayerToggles = DEFAULT_TOGGLES, opts: BuildOptions = {}): MapStyleJson {
  const sources: Record<string, StyleSource> = {
    base: { type: 'vector', url: urls.base, minzoom: TILE_ZOOM.base.min, maxzoom: TILE_ZOOM.base.max },
    depth: {
      type: 'raster-dem',
      url: urls.depth,
      encoding: 'mapbox',
      tileSize: 256,
      minzoom: TILE_ZOOM.depth.min,
      maxzoom: TILE_ZOOM.depth.max,
    },
  };
  if (urls.waterline) {
    sources.waterline = {
      type: 'raster-dem',
      url: urls.waterline,
      encoding: 'mapbox',
      tileSize: 256,
      minzoom: TILE_ZOOM.waterline.min,
      maxzoom: TILE_ZOOM.waterline.max,
    };
  }
  if (urls.land) sources.land = { type: 'vector', url: urls.land, minzoom: TILE_ZOOM.base.min, maxzoom: TILE_ZOOM.base.max };
  if (urls.fleet) {
    sources.fleet = { type: 'raster-dem', url: urls.fleet, encoding: 'mapbox', tileSize: 256, minzoom: TILE_ZOOM.fleet.min, maxzoom: TILE_ZOOM.fleet.max };
    if (urls.fleetMeta) {
      // Read as terrain too: code = boats * 65536 + uint16 day, so "boats < 3" is a single elevation threshold.
      sources.fleet_meta = { type: 'raster-dem', url: urls.fleetMeta, encoding: 'mapbox', tileSize: 256, minzoom: TILE_ZOOM.fleet.min, maxzoom: TILE_ZOOM.fleet.max };
    }
  }

  const bg = opts.dark ? '#0b1620' : '#eef1f2';
  const land = opts.dark ? '#1e2a30' : '#d9dccf';
  const layers: StyleLayer[] = [
    { id: 'background', type: 'background', paint: { 'background-color': bg } },
    { id: 'depth-relief', type: 'color-relief', source: 'depth', layout: vis(toggles.depth), paint: { 'color-relief-color': colorReliefExpression(), 'color-relief-opacity': 0.9 } },
    { id: 'depth-hillshade', type: 'hillshade', source: 'depth', layout: vis(toggles.hillshade), paint: { 'hillshade-exaggeration': 0.4 * HILLSHADE_EXAGGERATION_SCALE } },
    ...(urls.land ? [{ id: 'land', type: 'fill', source: 'land', 'source-layer': 'land', paint: { 'fill-color': land } } satisfies StyleLayer] : []),
    { id: 'depcnt', type: 'line', source: 'base', 'source-layer': 'DEPCNT', paint: { 'line-color': '#4a6d8c', 'line-width': 0.6 } },
    { id: 'coalne', type: 'line', source: 'base', 'source-layer': 'COALNE', paint: { 'line-color': '#222', 'line-width': 1 } },
    { id: 'cblsub', type: 'line', source: 'base', 'source-layer': 'CBLSUB', paint: { 'line-color': '#8a2be2', 'line-width': 0.8, 'line-dasharray': [4, 2] } },
    { id: 'obstrn', type: 'circle', source: 'base', 'source-layer': 'OBSTRN', paint: { 'circle-radius': 4, 'circle-color': '#c0392b', 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' } },
    { id: 'wrecks', type: 'circle', source: 'base', 'source-layer': 'WRECKS', paint: { 'circle-radius': 4, 'circle-color': '#2c3e50', 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' } },
    { id: 'boylat', type: 'circle', source: 'base', 'source-layer': 'BOYLAT', paint: { 'circle-radius': 3, 'circle-color': '#27ae60' } },
    { id: 'lights', type: 'circle', source: 'base', 'source-layer': 'LIGHTS', paint: { 'circle-radius': 3, 'circle-color': '#f1c40f' } },
  ];

  if (urls.waterline) {
    layers.push({ id: 'waterline-relief', type: 'color-relief', source: 'waterline', layout: vis(toggles.waterline), paint: { 'color-relief-color': colorReliefExpression(), 'color-relief-opacity': 0.85 } });
  }
  if (urls.fleet) {
    layers.push({ id: 'fleet-relief', type: 'color-relief', source: 'fleet', layout: vis(toggles.fleet), paint: { 'color-relief-color': colorReliefExpression(), 'color-relief-opacity': 0.8 } });
    if (urls.fleetMeta) {
      // Defense in depth (the pipeline only publishes cells with >= 3 boats): wash out any cell with fewer.
      layers.push({ id: 'fleet-lowconf', type: 'color-relief', source: 'fleet_meta', layout: vis(toggles.fleet), paint: { 'color-relief-color': fleetLowConfidenceExpression(), 'color-relief-opacity': 1 } });
    }
  }

  layers.push(
    {
      id: 'boundaries',
      type: 'line',
      source: 'base',
      'source-layer': 'boundaries',
      layout: vis(toggles.boundaries),
      paint: { 'line-color': '#d11a2a', 'line-width': 2.2 },
    },
    {
      id: 'boundary-labels',
      type: 'symbol',
      source: 'base',
      'source-layer': 'boundaries',
      layout: { ...vis(toggles.boundaries), 'symbol-placement': 'line', 'text-field': ['get', 'region_id'], 'text-size': 14, 'text-font': ['Noto Sans Bold'] },
      paint: { 'text-color': '#d11a2a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    },
  );

  return {
    version: 8,
    name: 'Sound Maps',
    ...(opts.glyphs ? { glyphs: opts.glyphs } : {}),
    sources,
    layers,
  };
}

/** Ids of layers whose visibility is controlled by each toggle (for tests/UI). */
export function layersForToggle(style: MapStyleJson, toggle: keyof LayerToggles): StyleLayer[] {
  const prefixes: Record<keyof LayerToggles, string[]> = {
    depth: ['depth-relief'],
    hillshade: ['depth-hillshade'],
    waterline: ['waterline-'],
    fleet: ['fleet-'],
    boundaries: ['boundaries', 'boundary-labels'],
  };
  return style.layers.filter((l) => prefixes[toggle].some((p) => l.id.startsWith(p)));
}

// --- Fleet low-confidence wash ----------------------------------------------------------------------------------------
/** Washed-out overlay for cells with fewer than FLEET_MIN_BOATS boats (a colour wash: raster data cannot carry a pattern). */
export const LOW_CONFIDENCE_WASH = 'rgba(245,245,245,0.6)';

/**
 * color-relief expression for the fleet_meta archive read as Terrain-RGB. Its code is boats * 65536 + uint16 day, so the
 * decoded value is  -10000 + 0.1 * code  and boats = floor(code / 65536). Cells with 1..FLEET_MIN_BOATS-1 boats fall in
 * [-10000 + 0.1*65536, -10000 + 0.1*FLEET_MIN_BOATS*65536) = [-3446.4, 9660.8); holes (RGB 0) decode to -10000 and
 * cells with >= 3 boats are above the upper threshold: both are transparent.
 */
export function fleetLowConfidenceExpression(): unknown[] {
  const lo = TERRAIN_RGB_BASE + TERRAIN_RGB_INTERVAL * FLEET_META_BOATS_SHIFT; // first valid boats=1 value
  const hi = TERRAIN_RGB_BASE + TERRAIN_RGB_INTERVAL * FLEET_META_BOATS_SHIFT * FLEET_MIN_BOATS;
  const e = 0.05; // half a code step is 0.05; codes are 0.1 apart
  return [
    'interpolate', ['linear'], ['elevation'],
    lo - 1000, TRANSPARENT,
    lo - e, TRANSPARENT,
    lo, LOW_CONFIDENCE_WASH,
    hi - 0.1, LOW_CONFIDENCE_WASH,
    hi - e, TRANSPARENT,
  ];
}

/** Evaluate which side of the threshold a (boats, day) pixel lands on, the way the expression above does. Tests only. */
export function fleetPixelIsLowConfidence(boats: number, uint16Day: number): boolean {
  const v = TERRAIN_RGB_BASE + TERRAIN_RGB_INTERVAL * (boats * FLEET_META_BOATS_SHIFT + uint16Day);
  const ex = fleetLowConfidenceExpression();
  const stops: Array<[number, string]> = [];
  for (let i = 3; i < ex.length; i += 2) stops.push([ex[i] as number, ex[i + 1] as string]);
  const washed = (c: string) => c === LOW_CONFIDENCE_WASH;
  if (v <= stops[0]![0]) return washed(stops[0]![1]);
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i]![0]) {
      const [v0, c0] = stops[i - 1]!;
      const [v1, c1] = stops[i]!;
      return washed(v - v0 < v1 - v ? c0 : c1);
    }
  }
  return washed(stops[stops.length - 1]![1]);
}
