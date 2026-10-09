/**
 * Physical filters for passive depth logging (PRD §Depth log trust, step 1):
 * drop SOG < 0.5 kt (transducer may be aerated) or > 25 kt, depth jumps > 10 ft in 1 s, HDOP > 5.
 * Stateful: the jump check compares against the last ACCEPTED reading so a sustained real change in
 * depth is accepted once enough time has passed (allowed jump scales with elapsed seconds).
 */
import { DEPTH_FILTER } from '@clearwater/shared';

export interface FilterReading {
  tMs: number;
  /** Depth below transducer, ft (raw). */
  depthFt: number;
  sogKt: number | null;
  hdop: number | null;
  lat: number | null;
  lon: number | null;
}

export type RejectReason =
  | 'bad_depth'
  | 'no_position'
  | 'sog_unknown'
  | 'sog_low'
  | 'sog_high'
  | 'hdop_unknown'
  | 'hdop_high'
  | 'jump';

export type FilterResult = { ok: true } | { ok: false; reason: RejectReason };

export interface DepthFilterOptions {
  minSogKt?: number;
  maxSogKt?: number;
  maxJumpFtPerS?: number;
  maxHdop?: number;
  /** Drop readings when SOG is unknown. Default true (cannot verify the boat is moving). */
  requireSog?: boolean;
  /** Drop readings when HDOP is unknown. Default false (phone GPS may be the position source). */
  requireHdop?: boolean;
}

export type RejectCounts = Record<RejectReason, number>;

const emptyCounts = (): RejectCounts => ({
  bad_depth: 0,
  no_position: 0,
  sog_unknown: 0,
  sog_low: 0,
  sog_high: 0,
  hdop_unknown: 0,
  hdop_high: 0,
  jump: 0,
});

export class DepthFilter {
  private last: { tMs: number; depthFt: number } | null = null;
  readonly rejected: RejectCounts = emptyCounts();
  accepted = 0;
  private readonly o: Required<DepthFilterOptions>;

  constructor(opts: DepthFilterOptions = {}) {
    this.o = {
      minSogKt: opts.minSogKt ?? DEPTH_FILTER.MIN_SOG_KT,
      maxSogKt: opts.maxSogKt ?? DEPTH_FILTER.MAX_SOG_KT,
      maxJumpFtPerS: opts.maxJumpFtPerS ?? DEPTH_FILTER.MAX_JUMP_FT_PER_S,
      maxHdop: opts.maxHdop ?? DEPTH_FILTER.MAX_HDOP,
      requireSog: opts.requireSog ?? true,
      requireHdop: opts.requireHdop ?? false,
    };
  }

  accept(r: FilterReading): FilterResult {
    const fail = (reason: RejectReason): FilterResult => {
      this.rejected[reason]++;
      return { ok: false, reason };
    };
    if (!Number.isFinite(r.depthFt) || r.depthFt <= 0) return fail('bad_depth');
    if (r.lat === null || r.lon === null) return fail('no_position');
    if (r.sogKt === null) {
      if (this.o.requireSog) return fail('sog_unknown');
    } else {
      if (r.sogKt < this.o.minSogKt) return fail('sog_low');
      if (r.sogKt > this.o.maxSogKt) return fail('sog_high');
    }
    if (r.hdop === null) {
      if (this.o.requireHdop) return fail('hdop_unknown');
    } else if (r.hdop > this.o.maxHdop) return fail('hdop_high');

    if (this.last) {
      const dtS = Math.max(1, (r.tMs - this.last.tMs) / 1000);
      if (Math.abs(r.depthFt - this.last.depthFt) > this.o.maxJumpFtPerS * dtS) return fail('jump');
    }
    this.last = { tMs: r.tMs, depthFt: r.depthFt };
    this.accepted++;
    return { ok: true };
  }

  reset(): void {
    this.last = null;
  }
}
