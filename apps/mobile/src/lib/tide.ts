/**
 * Tide helpers: interpolation of cached predictions, correction of a sounding to MLLW, nearest station.
 *
 * Sign convention (matches the working vertical: feet, MLLW):
 *   tide height h  = water surface above MLLW (ft), from predictions
 *   depth below surface d_s = raw sounder depth + transducer depth below the waterline
 *   charted depth (MLLW, positive down) = d_s - h          <- what the map ramp / fleet layer use
 *   bottom elevation (MLLW, positive up) = h - d_s         (a bar at +3 ft dries at a 3 ft tide)
 *   depth under keel = d_s - keel depth below the waterline  (live clearance; independent of tide)
 */
import type { TidePredictions, TideStation } from '@clearwater/shared';
import { haversineM, type LatLon } from './geo';

export interface TideSeries {
  stationId: string;
  name: string;
  /** Strictly increasing UTC epoch ms. */
  tMs: number[];
  /** Height, ft above MLLW, parallel to tMs. */
  v: number[];
}

/** Parse cached predictions JSON into a sorted numeric series (invalid points dropped, last dup wins). */
export function toSeries(p: TidePredictions): TideSeries {
  const pts: Array<[number, number]> = [];
  for (const row of p.predictions) {
    const t = Date.parse(row.t);
    if (Number.isFinite(t) && Number.isFinite(row.v)) pts.push([t, row.v]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const tMs: number[] = [];
  const v: number[] = [];
  for (const [t, h] of pts) {
    if (tMs.length > 0 && tMs[tMs.length - 1] === t) v[v.length - 1] = h;
    else {
      tMs.push(t);
      v.push(h);
    }
  }
  return { stationId: p.station_id, name: p.name, tMs, v };
}

export interface InterpolateOptions {
  /** Refuse to interpolate across a gap wider than this (default 7 h: hi/lo-only files). */
  maxGapMs?: number;
}

/** Linear interpolation. null when t is outside the cached range or the bracketing gap is too wide. */
export function interpolateTide(series: TideSeries, tMs: number, opts: InterpolateOptions = {}): number | null {
  const n = series.tMs.length;
  if (n === 0 || !Number.isFinite(tMs)) return null;
  const first = series.tMs[0] as number;
  const last = series.tMs[n - 1] as number;
  if (tMs < first || tMs > last) return null;
  // Binary search for the greatest index with tMs[i] <= t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((series.tMs[mid] as number) <= tMs) lo = mid;
    else hi = mid - 1;
  }
  const t0 = series.tMs[lo] as number;
  const v0 = series.v[lo] as number;
  if (t0 === tMs || lo === n - 1) return v0;
  const t1 = series.tMs[lo + 1] as number;
  const v1 = series.v[lo + 1] as number;
  if (t1 - t0 > (opts.maxGapMs ?? 7 * 3_600_000)) return null;
  return v0 + ((v1 - v0) * (tMs - t0)) / (t1 - t0);
}

export interface TidePoint {
  tMs: number;
  /** null where the cache has no coverage. */
  v: number | null;
}

/** Sample the curve for the 48 h tide screen. */
export function tideCurve(series: TideSeries, startMs: number, endMs: number, stepMin = 10): TidePoint[] {
  const out: TidePoint[] = [];
  const step = stepMin * 60_000;
  for (let t = startMs; t <= endMs; t += step) out.push({ tMs: t, v: interpolateTide(series, t) });
  return out;
}

/** Last timestamp covered by the cache, or null if empty. */
export function coverageEndMs(series: TideSeries): number | null {
  return series.tMs.length ? (series.tMs[series.tMs.length - 1] as number) : null;
}

/** Days of predictions cached ahead of `nowMs` (>= 0). */
export function daysCachedAhead(series: TideSeries, nowMs: number): number {
  const end = coverageEndMs(series);
  return end === null ? 0 : Math.max(0, (end - nowMs) / 86_400_000);
}

export interface SoundingCorrectionInput {
  /** Depth below the transducer exactly as the sounder reported it, ft. */
  rawDepthFt: number;
  /** Transducer depth below the waterline, ft (>= 0). */
  transducerDepthFt: number;
  /** Keel depth below the waterline, ft (>= 0). */
  keelDepthFt: number;
  /** Tide height above MLLW at the sounding time, ft. */
  tideFt: number;
}

export interface CorrectedDepth {
  depthBelowSurfaceFt: number;
  underKeelFt: number;
  /** Charted depth, ft below MLLW (positive down). */
  mllwDepthFt: number;
  /** Bottom elevation, ft MLLW (positive up). */
  elevationFtMllw: number;
  tideFt: number;
}

export function correctToMllw(i: SoundingCorrectionInput): CorrectedDepth {
  const depthBelowSurfaceFt = i.rawDepthFt + i.transducerDepthFt;
  const mllwDepthFt = depthBelowSurfaceFt - i.tideFt;
  return {
    depthBelowSurfaceFt,
    underKeelFt: depthBelowSurfaceFt - i.keelDepthFt,
    mllwDepthFt,
    elevationFtMllw: -mllwDepthFt,
    tideFt: i.tideFt,
  };
}

export interface NearestStation {
  station: TideStation;
  distanceM: number;
}

export function nearestStation(
  stations: readonly TideStation[],
  pos: LatLon,
  maxDistanceM = Number.POSITIVE_INFINITY,
): NearestStation | null {
  let best: NearestStation | null = null;
  for (const station of stations) {
    const d = haversineM(pos, { lat: station.lat, lon: station.lon });
    if (d <= maxDistanceM && (best === null || d < best.distanceM)) best = { station, distanceM: d };
  }
  return best;
}

/** What gets stored with each reading: the station used and the correction applied. */
export interface TideCorrectionRecord {
  stationId: string;
  tideFt: number;
}
