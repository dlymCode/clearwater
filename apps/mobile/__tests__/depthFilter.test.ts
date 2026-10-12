import { DepthFilter } from '../src/lib/depthFilter';
import type { FilterReading } from '../src/lib/depthFilter';

const r = (over: Partial<FilterReading> = {}): FilterReading => ({
  tMs: 0,
  depthFt: 20,
  sogKt: 5,
  hdop: 1,
  lat: 48.3,
  lon: -122.5,
  ...over,
});

/** The classic per-reading rules are tested with baseline confirmation off; confirmation has its own block below. */
const NOCONFIRM = { confirmBaseline: false } as const;

describe('DepthFilter', () => {
  it('accepts a normal reading', () => {
    expect(new DepthFilter(NOCONFIRM).accept(r())).toEqual({ ok: true });
  });

  it('SOG bounds: <0.5 and >25 dropped; boundaries kept', () => {
    const f = new DepthFilter(NOCONFIRM);
    expect(f.accept(r({ sogKt: 0.49 }))).toEqual({ ok: false, reason: 'sog_low' });
    expect(f.accept(r({ sogKt: 0.5, tMs: 1000 }))).toEqual({ ok: true });
    expect(f.accept(r({ sogKt: 25, tMs: 2000 }))).toEqual({ ok: true });
    expect(f.accept(r({ sogKt: 25.01, tMs: 3000 }))).toEqual({ ok: false, reason: 'sog_high' });
  });

  it('HDOP > 5 dropped; 5 kept', () => {
    const f = new DepthFilter(NOCONFIRM);
    expect(f.accept(r({ hdop: 5 }))).toEqual({ ok: true });
    expect(f.accept(r({ hdop: 5.1, tMs: 1000 }))).toEqual({ ok: false, reason: 'hdop_high' });
  });

  it('unknown SOG dropped by default; unknown HDOP allowed by default', () => {
    const f = new DepthFilter(NOCONFIRM);
    expect(f.accept(r({ sogKt: null }))).toEqual({ ok: false, reason: 'sog_unknown' });
    expect(f.accept(r({ hdop: null }))).toEqual({ ok: true });
    expect(new DepthFilter({ ...NOCONFIRM, requireHdop: true }).accept(r({ hdop: null }))).toEqual({
      ok: false,
      reason: 'hdop_unknown',
    });
    expect(new DepthFilter({ ...NOCONFIRM, requireSog: false }).accept(r({ sogKt: null }))).toEqual({ ok: true });
  });

  it('missing position, zero or invalid depth dropped', () => {
    const f = new DepthFilter(NOCONFIRM);
    expect(f.accept(r({ lat: null }))).toEqual({ ok: false, reason: 'no_position' });
    expect(f.accept(r({ depthFt: 0 }))).toEqual({ ok: false, reason: 'bad_depth' });
    expect(f.accept(r({ depthFt: Number.NaN }))).toEqual({ ok: false, reason: 'bad_depth' });
  });

  it('depth jump > 10 ft in 1 s dropped; exactly 10 kept', () => {
    const f = new DepthFilter(NOCONFIRM);
    expect(f.accept(r({ tMs: 0, depthFt: 20 }))).toEqual({ ok: true });
    expect(f.accept(r({ tMs: 1000, depthFt: 30 }))).toEqual({ ok: true });
    expect(f.accept(r({ tMs: 2000, depthFt: 40.5 }))).toEqual({ ok: false, reason: 'jump' });
  });

  it('a single spike is dropped and the next normal reading is accepted', () => {
    const f = new DepthFilter(NOCONFIRM);
    f.accept(r({ tMs: 0, depthFt: 20 }));
    expect(f.accept(r({ tMs: 1000, depthFt: 90 })).ok).toBe(false);
    expect(f.accept(r({ tMs: 2000, depthFt: 21 })).ok).toBe(true);
  });

  it('sub-second readings are judged against a 1 s window, not amplified', () => {
    const f = new DepthFilter(NOCONFIRM);
    f.accept(r({ tMs: 0, depthFt: 20 }));
    expect(f.accept(r({ tMs: 200, depthFt: 28 })).ok).toBe(true);
  });

  it('a sustained real change is accepted once enough time has elapsed', () => {
    const f = new DepthFilter(NOCONFIRM);
    f.accept(r({ tMs: 0, depthFt: 20 }));
    // Real cliff to 60 ft: rejected each second until the allowed delta (10 ft/s * dt) covers 40 ft.
    const results = [1, 2, 3, 4].map((s) => f.accept(r({ tMs: s * 1000, depthFt: 60 })).ok);
    expect(results).toEqual([false, false, false, true]);
  });

  it('after a gap longer than the jump allowance the filter does not get stuck', () => {
    const f = new DepthFilter(NOCONFIRM);
    f.accept(r({ tMs: 0, depthFt: 20 }));
    expect(f.accept(r({ tMs: 60_000, depthFt: 80 })).ok).toBe(true);
  });

  it('counts rejects by reason and resets', () => {
    const f = new DepthFilter(NOCONFIRM);
    f.accept(r({ sogKt: 0 }));
    f.accept(r({ sogKt: 0 }));
    f.accept(r({ hdop: 9 }));
    f.accept(r());
    expect(f.rejected.sog_low).toBe(2);
    expect(f.rejected.hdop_high).toBe(1);
    expect(f.accepted).toBe(1);
    f.reset();
    expect(f.accept(r({ tMs: 5000, depthFt: 90 })).ok).toBe(true);
  });
});

describe('E: non-finite and out-of-range inputs', () => {
  it('NaN SOG / HDOP and impossible coordinates are rejected (NaN comparisons would otherwise pass every threshold)', () => {
    const f = new DepthFilter(NOCONFIRM);
    expect(f.accept(r({ sogKt: Number.NaN }))).toEqual({ ok: false, reason: 'sog_invalid' });
    expect(f.accept(r({ sogKt: Infinity }))).toEqual({ ok: false, reason: 'sog_invalid' });
    expect(f.accept(r({ hdop: Number.NaN }))).toEqual({ ok: false, reason: 'hdop_invalid' });
    expect(f.accept(r({ lat: 91 }))).toEqual({ ok: false, reason: 'bad_position' });
    expect(f.accept(r({ lon: -181 }))).toEqual({ ok: false, reason: 'bad_position' });
    expect(f.accept(r({ lat: Number.NaN }))).toEqual({ ok: false, reason: 'bad_position' });
    expect(f.accept(r({ depthFt: Infinity }))).toEqual({ ok: false, reason: 'bad_depth' });
  });
});

describe('E: first-reading baseline must be confirmed', () => {
  it('a spike as the very first reading does not poison the stream: it is dropped and the good readings that follow are kept', () => {
    const f = new DepthFilter();
    expect(f.accept(r({ tMs: 0, depthFt: 900 }))).toEqual({ ok: false, reason: 'unconfirmed' }); // implausible, never a candidate
    expect(f.accept(r({ tMs: 1000, depthFt: 20 }))).toEqual({ ok: false, reason: 'unconfirmed' }); // candidate
    expect(f.accept(r({ tMs: 2000, depthFt: 21 })).ok).toBe(true); // confirmed by a consistent second reading
    expect(f.accept(r({ tMs: 3000, depthFt: 21.5 })).ok).toBe(true);
    expect(f.rejected.unconfirmed).toBe(2);
  });
  it('a spike as the first PLAUSIBLE reading: the next normal reading replaces it as candidate, the third is accepted', () => {
    const f = new DepthFilter();
    expect(f.accept(r({ tMs: 0, depthFt: 150 })).ok).toBe(false); // plausible spike becomes the candidate
    expect(f.accept(r({ tMs: 1000, depthFt: 20 })).ok).toBe(false); // inconsistent with the candidate: replaces it
    expect(f.accept(r({ tMs: 2000, depthFt: 20.5 })).ok).toBe(true);
    // the spike never became the jump baseline, so normal readings keep flowing
    expect(f.accept(r({ tMs: 3000, depthFt: 21 })).ok).toBe(true);
  });
  it('the first accepted reading must be within 0..2000 ft', () => {
    const f = new DepthFilter();
    expect(f.accept(r({ tMs: 0, depthFt: 2500 })).ok).toBe(false);
    expect(f.accept(r({ tMs: 1000, depthFt: 2500 })).ok).toBe(false); // consistent with each other but implausible
    expect(f.accept(r({ tMs: 2000, depthFt: 2500 })).ok).toBe(false);
  });
  it('reset() starts the confirmation again', () => {
    const f = new DepthFilter();
    f.accept(r({ tMs: 0 }));
    f.accept(r({ tMs: 1000 }));
    f.reset();
    expect(f.accept(r({ tMs: 5000, depthFt: 90 })).ok).toBe(false);
  });
  it('confirmBaseline:false keeps the old immediate behaviour', () => {
    expect(new DepthFilter(NOCONFIRM).accept(r()).ok).toBe(true);
  });
});
