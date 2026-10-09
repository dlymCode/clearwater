import {
  AOI_SLUGS,
  DEPTH_COLOR_RAMP_FT,
  DEPTH_FILTER,
  H3_RESOLUTION,
  PING_TYPES,
  PING_TYPE_LABELS,
  RATE_LIMITS,
  SCORE_LAMBDA_PER_HOUR,
  isPingType,
} from '../src';

describe('shared constants mirror AGENT-PLAN.md', () => {
  it('ping types are the exact enum strings, in order', () => {
    expect([...PING_TYPES]).toEqual(['bar_moved', 'touched_bottom', 'log', 'gear', 'closure_line', 'other']);
  });

  it('every ping type has a label', () => {
    for (const t of PING_TYPES) expect(PING_TYPE_LABELS[t].length).toBeGreaterThan(0);
  });

  it('isPingType narrows correctly', () => {
    expect(isPingType('bar_moved')).toBe(true);
    expect(isPingType('nope')).toBe(false);
    expect(isPingType(3)).toBe(false);
  });

  it('color ramp is 0,3,6,10,20,40', () => {
    expect([...DEPTH_COLOR_RAMP_FT]).toEqual([0, 3, 6, 10, 20, 40]);
  });

  it('H3 resolution is 12', () => {
    expect(H3_RESOLUTION).toBe(12);
  });

  it('lambda is ln(2)/24h so an unconfirmed ping halves at 24h', () => {
    expect(Math.exp(-SCORE_LAMBDA_PER_HOUR * 24)).toBeCloseTo(0.5, 12);
  });

  it('AOI slugs are canonical', () => {
    expect([...AOI_SLUGS]).toEqual(['skagit', 'port_susan', 'snohomish', 'padilla_samish', 'nisqually']);
  });

  it('depth filter thresholds', () => {
    expect(DEPTH_FILTER).toEqual({ MIN_SOG_KT: 0.5, MAX_SOG_KT: 25, MAX_JUMP_FT_PER_S: 10, MAX_HDOP: 5 });
  });

  it('rate limits', () => {
    expect(RATE_LIMITS.PINGS_PER_HOUR).toBe(30);
    expect(RATE_LIMITS.VOTES_PER_HOUR).toBe(60);
    expect(RATE_LIMITS.MESSAGES_PER_MINUTE).toBe(10);
    expect(RATE_LIMITS.DEPTH_BATCH_INTERVAL_MIN).toBe(15);
  });
});

import { META_DATE_EPOCH_SHIFT_DAYS, SOURCE_CODES, SOURCE_LABELS_BY_CODE, UNC_LEVELS_FT, UNC_OPEN_ENDED_INDEX, UNKNOWN_UNC_INDEX } from '../src';

describe('pipeline encoding mirror (pipeline/common.py, pipeline/tiles.py)', () => {
  it('source codes are 1..8 and each has a label', () => {
    expect(Object.values(SOURCE_CODES)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const c of Object.values(SOURCE_CODES)) expect(SOURCE_LABELS_BY_CODE[c]).toBeTruthy();
  });
  it('date epoch shift is days from 1880-01-01 to 1970-01-01', () => {
    expect(META_DATE_EPOCH_SHIFT_DAYS).toBe((Date.UTC(1970, 0, 1) - Date.UTC(1880, 0, 1)) / 86_400_000);
  });
  it('uncertainty buckets: 15 ascending levels, 14 open-ended (>= 45 ft), 15 reserved for unknown', () => {
    expect(UNC_LEVELS_FT).toHaveLength(15);
    expect([...UNC_LEVELS_FT]).toEqual([...UNC_LEVELS_FT].sort((a, b) => a - b));
    expect(UNC_OPEN_ENDED_INDEX).toBe(14);
    expect(UNC_LEVELS_FT[UNC_OPEN_ENDED_INDEX]).toBe(45);
    expect(UNKNOWN_UNC_INDEX).toBe(15);
  });
});
