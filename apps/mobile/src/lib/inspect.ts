/**
 * Tap-to-inspect readout (MAP-3). Fields are NEVER blank: anything unknown reads "unknown".
 *
 * Meta-tile pixel layout is defined by the pipeline (see decodeMetaPixel); elevation comes from the
 * Terrain-RGB pixel (terrainRgb.ts).
 */
import {
  FLEET_MIN_BOATS,
  META_DATE_EPOCH_SHIFT_DAYS,
  MS_PER_DAY,
  SOURCE_LABELS_BY_CODE,
  UNC_LEVELS_FT,
  UNC_OPEN_ENDED_INDEX,
  UNKNOWN_UNC_INDEX,
  decodeFleetMetaPixel,
} from '@clearwater/shared';
import { decodeTerrainRgb } from './terrainRgb';

const DAY_MS = MS_PER_DAY;

export interface RgbaPixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface MetaPixel {
  sourceCode: number | null;
  /** Days since 1970-01-01 (matches merged_date.tif). */
  dateDays1970: number | null;
  /** Upper bound of the uncertainty bucket (the pipeline always rounds up); null if unknown. */
  uncertaintyFt: number | null;
  /** Bucket 14: the real value is >= uncertaintyFt (45 ft). Bucket 15 is unknown (uncertaintyFt null). */
  uncertaintyOpenEnded: boolean;
}

/**
 * depth_meta.pmtiles pixel (pipeline/tiles.py pack_source_date):
 *   R = (source_code << 4) | unc_index,  G,B = big-endian uint16 of days-since-1970 + 32872,
 *   A = 255 valid / 0 hole.
 */
export function decodeMetaPixel(p: RgbaPixel): MetaPixel {
  if (p.a !== 255) return { sourceCode: null, dateDays1970: null, uncertaintyFt: null, uncertaintyOpenEnded: false };
  const sourceCode = p.r >> 4;
  const uncIndex = p.r & 0x0f;
  const d16 = p.g * 256 + p.b;
  return {
    sourceCode: sourceCode === 0 ? null : sourceCode,
    dateDays1970: sourceCode === 0 ? null : d16 - META_DATE_EPOCH_SHIFT_DAYS,
    uncertaintyFt: uncIndex === UNKNOWN_UNC_INDEX ? null : (UNC_LEVELS_FT[uncIndex] ?? null),
    uncertaintyOpenEnded: uncIndex === UNC_OPEN_ENDED_INDEX,
  };
}

export interface InspectInput {
  elevationFt: number | null;
  sourceCode: number | null;
  dateDays1970: number | null;
  uncertaintyFt: number | null;
  uncertaintyOpenEnded?: boolean;
}

export interface InspectReadout {
  depth: string;
  source: string;
  date: string;
  age: string;
  uncertainty: string;
  /** True when the surveyed/imaged date is older than 10 years (the merge rule's staleness line). */
  old: boolean;
  hasData: boolean;
}

const UNKNOWN = 'unknown';

export function formatDateDays(days1970: number): string {
  return new Date(days1970 * DAY_MS).toISOString().slice(0, 10);
}

export function buildInspectReadout(i: InspectInput, nowMs: number = Date.now()): InspectReadout {
  const hasData = i.elevationFt !== null && Number.isFinite(i.elevationFt);
  let depth = UNKNOWN;
  if (hasData) {
    const e = i.elevationFt as number;
    depth = e > 0 ? `Dries ${e.toFixed(1)} ft above MLLW` : `${(-e).toFixed(1)} ft deep (MLLW)`;
  }
  const source =
    i.sourceCode === null || !Number.isFinite(i.sourceCode)
      ? UNKNOWN
      : (SOURCE_LABELS_BY_CODE[i.sourceCode] ?? `Source #${i.sourceCode}`);
  let date = UNKNOWN;
  let age = UNKNOWN;
  let old = false;
  if (i.dateDays1970 !== null && Number.isFinite(i.dateDays1970)) {
    date = formatDateDays(i.dateDays1970);
    const years = (nowMs - i.dateDays1970 * DAY_MS) / (365.25 * DAY_MS);
    age = years < 1 ? `${Math.max(0, Math.round(years * 12))} months old` : `${Math.floor(years)} years old`;
    old = years > 10;
  }
  const uncertainty =
    i.uncertaintyFt !== null && Number.isFinite(i.uncertaintyFt)
      ? i.uncertaintyOpenEnded
        ? `≥ ${i.uncertaintyFt.toFixed(0)} ft`
        : `±${i.uncertaintyFt.toFixed(1)} ft`
      : UNKNOWN;
  return { depth, source, date, age, uncertainty, old, hasData };
}

/** Elevation + meta pixels (both from the tile under the tap) => readout. Either pixel may be missing. */
export function readoutFromPixels(
  terrain: RgbaPixel | null,
  meta: RgbaPixel | null,
  nowMs?: number,
): InspectReadout {
  const elevationFt = terrain ? decodeTerrainRgb(terrain.r, terrain.g, terrain.b, terrain.a) : null;
  const m = meta ? decodeMetaPixel(meta) : { sourceCode: null, dateDays1970: null, uncertaintyFt: null, uncertaintyOpenEnded: false };
  return buildInspectReadout({ elevationFt, ...m }, nowMs);
}

// --- Fleet layer ------------------------------------------------------------------------------------------------------

export interface FleetReadout {
  /** Charted depth from fleet.pmtiles (decoded like depth.pmtiles, then negated to depth), or "unknown". */
  depth: string;
  boats: string;
  newest: string;
  /** Fewer than FLEET_MIN_BOATS contributing boats: shown as low confidence (and washed out on the map). */
  lowConfidence: boolean;
  hasData: boolean;
}

/**
 * Fleet inspect: elevation from the fleet Terrain-RGB pixel (same decoder as depth; 12 ft of water decodes as -12) and
 * boat count + newest day from the fleet_meta pixel. Anything missing reads "unknown", never blank.
 */
export function readoutFromFleetPixels(terrain: RgbaPixel | null, meta: RgbaPixel | null): FleetReadout {
  const elevationFt = terrain ? decodeTerrainRgb(terrain.r, terrain.g, terrain.b, terrain.a) : null;
  const m = meta ? decodeFleetMetaPixel(meta.r, meta.g, meta.b, meta.a) : null;
  const depth =
    elevationFt === null ? UNKNOWN : elevationFt > 0 ? `Dries ${elevationFt.toFixed(1)} ft above MLLW` : `${(-elevationFt).toFixed(1)} ft deep (MLLW)`;
  return {
    depth,
    boats: m ? `${m.boats}${m.boats >= 255 ? '+' : ''}` : UNKNOWN,
    newest: m ? formatDateDays(m.newestDay1970) : UNKNOWN,
    lowConfidence: m !== null && m.boats < FLEET_MIN_BOATS,
    hasData: elevationFt !== null,
  };
}
