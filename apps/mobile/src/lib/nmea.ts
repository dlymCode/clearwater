/**
 * NMEA 0183 parser (DPT, DBT, GGA, RMC, VHW), checksum validation, TCP/UDP line buffering and a
 * fix tracker that joins depth with the latest position/SOG/HDOP.
 *
 * Pure TS: no native imports. Bad checksum => null + counter (spoofing/corruption defence).
 */
import { FEET_PER_FATHOM, FEET_PER_METER, KMH_PER_KNOT } from '@clearwater/shared';

export type NmeaType = 'DPT' | 'DBT' | 'GGA' | 'RMC' | 'VHW';

export interface DptSentence {
  type: 'DPT';
  talker: string;
  /** Water depth relative to the transducer, metres (DPT is always metres). */
  depthM: number | null;
  depthFt: number | null;
  /** +: transducer offset from waterline; -: offset from keel. Metres. */
  offsetM: number | null;
  maxRangeM: number | null;
}

export interface DbtSentence {
  type: 'DBT';
  talker: string;
  /** Canonical depth below transducer: metres field preferred, else feet, else fathoms. */
  depthM: number | null;
  depthFt: number | null;
}

export interface GgaSentence {
  type: 'GGA';
  talker: string;
  timeUtc: string | null;
  lat: number | null;
  lon: number | null;
  /** 0 = invalid. Position is null when quality is 0. */
  fixQuality: number | null;
  satellites: number | null;
  hdop: number | null;
  altitudeM: number | null;
}

export interface RmcSentence {
  type: 'RMC';
  talker: string;
  /** Status 'A' = valid, 'V' = void (warning). */
  valid: boolean;
  timeUtc: string | null;
  /** UTC epoch ms when both time and date parsed. */
  timeMs: number | null;
  lat: number | null;
  lon: number | null;
  sogKt: number | null;
  cogDeg: number | null;
}

export interface VhwSentence {
  type: 'VHW';
  talker: string;
  headingTrueDeg: number | null;
  headingMagneticDeg: number | null;
  /** Speed through water, knots (km/h field converted when the knots field is empty). */
  stwKt: number | null;
}

export type NmeaSentence = DptSentence | DbtSentence | GgaSentence | RmcSentence | VhwSentence;

export interface NmeaStats {
  lines: number;
  parsed: number;
  /** Failed checksum or checksum missing (when required). */
  badChecksum: number;
  /** Structurally broken sentences. */
  malformed: number;
  /** Valid but a type we do not use. */
  ignored: number;
}

export function newNmeaStats(): NmeaStats {
  return { lines: 0, parsed: 0, badChecksum: 0, malformed: 0, ignored: 0 };
}

export interface ParseOptions {
  /** Reject sentences without a *hh checksum. Default true. */
  requireChecksum?: boolean;
}

/** XOR of all chars between '$' and '*' as 2-digit uppercase hex. */
export function nmeaChecksum(body: string): string {
  let x = 0;
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i);
  return x.toString(16).toUpperCase().padStart(2, '0');
}

/** Build a valid sentence from a body such as "GPDPT,12.3,0.0" (test/simulator helper). */
export function buildNmea(body: string): string {
  return `$${body}*${nmeaChecksum(body)}`;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** ddmm.mmmm / dddmm.mmmm + hemisphere => signed decimal degrees. */
export function parseCoord(value: string | undefined, hemi: string | undefined, isLat: boolean): number | null {
  const v = num(value);
  if (v === null || !hemi) return null;
  const deg = Math.floor(v / 100);
  const minutes = v - deg * 100;
  if (minutes < 0 || minutes >= 60) return null;
  let dd = deg + minutes / 60;
  const h = hemi.toUpperCase();
  if (isLat) {
    if (h !== 'N' && h !== 'S') return null;
    if (h === 'S') dd = -dd;
    return dd <= 90 && dd >= -90 ? dd : null;
  }
  if (h !== 'E' && h !== 'W') return null;
  if (h === 'W') dd = -dd;
  return dd <= 180 && dd >= -180 ? dd : null;
}

function parseTime(t: string | undefined): { text: string; ms: number } | null {
  if (!t || !/^\d{6}(\.\d+)?$/.test(t)) return null;
  const hh = Number(t.slice(0, 2));
  const mm = Number(t.slice(2, 4));
  const ss = Number(t.slice(4));
  if (hh > 23 || mm > 59 || ss >= 61) return null;
  const text = `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  return { text, ms: ((hh * 60 + mm) * 60 + ss) * 1000 };
}

function parseDate(d: string | undefined): number | null {
  if (!d || !/^\d{6}$/.test(d)) return null;
  const day = Number(d.slice(0, 2));
  const month = Number(d.slice(2, 4));
  const yy = Number(d.slice(4, 6));
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const year = yy < 80 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, month - 1, day);
}

const mToFt = (m: number): number => m * FEET_PER_METER;

/**
 * Parse one NMEA 0183 line. Returns null for: bad checksum (counted), malformed, or unused types.
 * `stats` (optional) is mutated in place.
 */
export function parseNmeaLine(
  rawLine: string,
  stats?: NmeaStats,
  opts: ParseOptions = {},
): NmeaSentence | null {
  const requireChecksum = opts.requireChecksum ?? true;
  if (stats) stats.lines++;
  const line = rawLine.trim();
  const start = line.indexOf('$');
  if (start < 0) {
    if (stats && line.length > 0) stats.malformed++;
    return null;
  }
  const star = line.indexOf('*', start);
  const body = line.slice(start + 1, star < 0 ? undefined : star);

  if (star < 0) {
    if (requireChecksum) {
      if (stats) stats.badChecksum++;
      return null;
    }
  } else {
    const given = line.slice(star + 1, star + 3).toUpperCase();
    if (!/^[0-9A-F]{2}$/.test(given) || given !== nmeaChecksum(body)) {
      if (stats) stats.badChecksum++;
      return null;
    }
  }

  const fields = body.split(',');
  const head = fields[0] ?? '';
  if (head.length < 5 || head.startsWith('P')) {
    // Proprietary sentences ($PGRMZ, ...) and garbage.
    if (stats) {
      if (head.startsWith('P')) stats.ignored++;
      else stats.malformed++;
    }
    return null;
  }
  const talker = head.slice(0, 2);
  const kind = head.slice(2);
  const f = (i: number): string | undefined => fields[i];

  let result: NmeaSentence | null = null;
  switch (kind) {
    case 'DPT': {
      const depthM = num(f(1));
      if (fields.length < 3) break;
      result = {
        type: 'DPT',
        talker,
        depthM,
        depthFt: depthM === null ? null : mToFt(depthM),
        offsetM: num(f(2)),
        maxRangeM: num(f(3)),
      };
      break;
    }
    case 'DBT': {
      if (fields.length < 7) break;
      // $--DBT,x.x,f,x.x,M,x.x,F : feet, metres, fathoms. Prefer metres, then feet, then fathoms.
      const ft = f(2)?.toUpperCase() === 'F' ? num(f(1)) : null;
      const m = f(4)?.toUpperCase() === 'M' ? num(f(3)) : null;
      const fa = f(6)?.toUpperCase() === 'F' ? num(f(5)) : null;
      let depthFt: number | null = null;
      if (m !== null) depthFt = mToFt(m);
      else if (ft !== null) depthFt = ft;
      else if (fa !== null) depthFt = fa * FEET_PER_FATHOM;
      result = {
        type: 'DBT',
        talker,
        depthM: depthFt === null ? null : depthFt / FEET_PER_METER,
        depthFt,
      };
      break;
    }
    case 'GGA': {
      if (fields.length < 10) break;
      const fixQuality = num(f(6));
      const hasFix = fixQuality !== null && fixQuality > 0;
      result = {
        type: 'GGA',
        talker,
        timeUtc: parseTime(f(1))?.text ?? null,
        lat: hasFix ? parseCoord(f(2), f(3), true) : null,
        lon: hasFix ? parseCoord(f(4), f(5), false) : null,
        fixQuality,
        satellites: num(f(7)),
        hdop: num(f(8)),
        altitudeM: num(f(9)),
      };
      break;
    }
    case 'RMC': {
      if (fields.length < 10) break;
      const valid = f(2)?.toUpperCase() === 'A';
      const time = parseTime(f(1));
      const dateMs = parseDate(f(9));
      result = {
        type: 'RMC',
        talker,
        valid,
        timeUtc: time?.text ?? null,
        timeMs: time && dateMs !== null ? dateMs + time.ms : null,
        lat: valid ? parseCoord(f(3), f(4), true) : null,
        lon: valid ? parseCoord(f(5), f(6), false) : null,
        sogKt: num(f(7)),
        cogDeg: num(f(8)),
      };
      break;
    }
    case 'VHW': {
      if (fields.length < 9) break;
      const kt = num(f(5));
      const kmh = num(f(7));
      result = {
        type: 'VHW',
        talker,
        headingTrueDeg: num(f(1)),
        headingMagneticDeg: num(f(3)),
        stwKt: kt !== null ? kt : kmh !== null ? kmh / KMH_PER_KNOT : null,
      };
      break;
    }
    default:
      if (stats) stats.ignored++;
      return null;
  }

  if (!result) {
    if (stats) stats.malformed++;
    return null;
  }
  if (stats) stats.parsed++;
  return result;
}

/**
 * Splits a TCP/UDP byte stream (already decoded to text) into lines. Handles CRLF, LF, bare CR,
 * sentences split across chunks, and several sentences in one datagram.
 */
export class NmeaLineBuffer {
  private rest = '';
  overflows = 0;

  constructor(private readonly maxLineLength = 1024) {}

  /** Feed a chunk; returns the complete lines it finished (without terminators, non-empty). */
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split(/\r\n|\n|\r/);
    this.rest = parts.pop() ?? '';
    if (this.rest.length > this.maxLineLength) {
      this.rest = '';
      this.overflows++;
    }
    return parts.filter((l) => l.length > 0);
  }

  /** Emit a trailing unterminated line (UDP datagrams often omit the final CRLF). */
  flush(): string[] {
    const r = this.rest.trim();
    this.rest = '';
    return r.length > 0 ? [r] : [];
  }
}

/** Convenience: chunk in, parsed sentences out, with running stats. */
export class NmeaStream {
  readonly stats: NmeaStats = newNmeaStats();
  private readonly buffer: NmeaLineBuffer;

  constructor(
    private readonly opts: ParseOptions = {},
    maxLineLength?: number,
  ) {
    this.buffer = new NmeaLineBuffer(maxLineLength);
  }

  feed(chunk: string, endsDatagram = false): NmeaSentence[] {
    const lines = this.buffer.push(chunk);
    if (endsDatagram) lines.push(...this.buffer.flush());
    const out: NmeaSentence[] = [];
    for (const line of lines) {
      const s = parseNmeaLine(line, this.stats, this.opts);
      if (s) out.push(s);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Fix tracker
// ---------------------------------------------------------------------------

/** Raw instrument snapshot taken when a depth sentence arrives. Fields are null when unknown/stale. */
export interface InstrumentSnapshot {
  /** Device-clock ms (UTC epoch) when the depth sentence was received. */
  tMs: number;
  /** Depth below the transducer, feet, exactly as the sounder reported it (no offsets applied). */
  rawDepthFt: number;
  lat: number | null;
  lon: number | null;
  sogKt: number | null;
  cogDeg: number | null;
  hdop: number | null;
  headingTrueDeg: number | null;
  stwKt: number | null;
}

interface Stamped<T> {
  v: T;
  t: number;
}

export interface TrackerOptions {
  /** Max age of a non-depth field before it is considered stale (null in the snapshot). Default 5000. */
  maxFieldAgeMs?: number;
  /** Emit at most one snapshot per this many ms (DPT+DBT duplicates, >1 Hz sounders). Default 900. */
  minIntervalMs?: number;
}

export class NmeaFixTracker {
  private pos: Stamped<{ lat: number; lon: number }> | null = null;
  private sog: Stamped<number> | null = null;
  private cog: Stamped<number> | null = null;
  private hdop: Stamped<number> | null = null;
  private hdg: Stamped<number> | null = null;
  private stw: Stamped<number> | null = null;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private readonly maxAge: number;
  private readonly minInterval: number;

  constructor(opts: TrackerOptions = {}) {
    this.maxAge = opts.maxFieldAgeMs ?? 5000;
    this.minInterval = opts.minIntervalMs ?? 900;
  }

  private fresh<T>(s: Stamped<T> | null, now: number): T | null {
    return s && now - s.t <= this.maxAge ? s.v : null;
  }

  /** Update with a sentence; returns a snapshot when a depth sentence completes one. */
  update(s: NmeaSentence, nowMs: number): InstrumentSnapshot | null {
    switch (s.type) {
      case 'GGA':
        if (s.lat !== null && s.lon !== null) this.pos = { v: { lat: s.lat, lon: s.lon }, t: nowMs };
        if (s.hdop !== null) this.hdop = { v: s.hdop, t: nowMs };
        return null;
      case 'RMC':
        if (s.valid && s.lat !== null && s.lon !== null) this.pos = { v: { lat: s.lat, lon: s.lon }, t: nowMs };
        if (s.valid && s.sogKt !== null) this.sog = { v: s.sogKt, t: nowMs };
        if (s.valid && s.cogDeg !== null) this.cog = { v: s.cogDeg, t: nowMs };
        return null;
      case 'VHW':
        if (s.headingTrueDeg !== null) this.hdg = { v: s.headingTrueDeg, t: nowMs };
        if (s.stwKt !== null) this.stw = { v: s.stwKt, t: nowMs };
        return null;
      case 'DPT':
      case 'DBT': {
        if (s.depthFt === null) return null;
        if (nowMs - this.lastEmit < this.minInterval) return null;
        this.lastEmit = nowMs;
        const pos = this.fresh(this.pos, nowMs);
        return {
          tMs: nowMs,
          rawDepthFt: s.depthFt,
          lat: pos?.lat ?? null,
          lon: pos?.lon ?? null,
          sogKt: this.fresh(this.sog, nowMs),
          cogDeg: this.fresh(this.cog, nowMs),
          hdop: this.fresh(this.hdop, nowMs),
          headingTrueDeg: this.fresh(this.hdg, nowMs),
          stwKt: this.fresh(this.stw, nowMs),
        };
      }
    }
  }
}
