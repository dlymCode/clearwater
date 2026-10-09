import { latLngToCell } from 'h3-js';
import type { DepthUploadRow } from '@clearwater/shared';
import {
  aggregateSoundings,
  assertAnonymousUploadPayload,
  buildUploadPayload,
  mergeUploadRows,
  percentile,
  sanitizeUploadRows,
  utcDay,
} from '../src/lib/aggregate';
import type { CorrectedSounding } from '../src/lib/aggregate';

const LAT = 48.3083;
const LON = -122.5042;
const CELL = latLngToCell(LAT, LON, 12);
const T = Date.parse('2026-10-09T15:30:00Z');

const s = (depth: number, over: Partial<CorrectedSounding> = {}): CorrectedSounding => ({
  tMs: T,
  lat: LAT,
  lon: LON,
  mllwDepthFt: depth,
  ...over,
});

describe('percentile', () => {
  it('matches linear interpolation (type 7)', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(a, 0.5)).toBe(5.5);
    expect(percentile(a, 0.1)).toBeCloseTo(1.9, 12);
    expect(percentile(a, 0)).toBe(1);
    expect(percentile(a, 1)).toBe(10);
    expect(percentile([7], 0.1)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('aggregateSoundings', () => {
  it('groups into one row per cell per UTC day', () => {
    const rows = aggregateSoundings([s(10), s(12), s(11), s(30, { lat: 48.4 })]);
    expect(rows).toHaveLength(2);
    const r = rows.find((x) => x.h3_cell === CELL)!;
    expect(r).toEqual({ h3_cell: CELL, day: '2026-10-09', median_ft: 11, p10_ft: 10.2, n: 3 });
  });

  it('splits at the UTC day boundary, not local time', () => {
    const rows = aggregateSoundings([
      s(10, { tMs: Date.parse('2026-10-09T23:59:59Z') }),
      s(10, { tMs: Date.parse('2026-10-10T00:00:00Z') }),
    ]);
    expect(rows.map((r) => r.day)).toEqual(['2026-10-09', '2026-10-10']);
    expect(utcDay(Date.parse('2026-10-09T23:59:59.999Z'))).toBe('2026-10-09');
  });

  it('uses H3 resolution 12 cells', () => {
    expect(CELL).toHaveLength(15);
    expect(aggregateSoundings([s(10)])[0]!.h3_cell).toBe(CELL);
  });

  it('skips non-finite soundings; empty input is empty output', () => {
    expect(aggregateSoundings([s(Number.NaN), s(10, { lat: Number.NaN })])).toEqual([]);
    expect(aggregateSoundings([])).toEqual([]);
  });

  it('output carries exactly the five keys and no sub-day information', () => {
    const rows = aggregateSoundings([s(10, { tMs: Date.parse('2026-10-09T03:04:05Z') })]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['day', 'h3_cell', 'median_ft', 'n', 'p10_ft']);
    expect(JSON.stringify(rows)).not.toMatch(/T\d\d:\d\d/);
  });

  it('is independent of input (track) order', () => {
    const a = aggregateSoundings([s(10), s(20, { lat: 48.4 }), s(12)]);
    const b = aggregateSoundings([s(12), s(10), s(20, { lat: 48.4 })]);
    expect(a).toEqual(b);
  });
});

describe('payload anonymity', () => {
  const row: DepthUploadRow = { h3_cell: CELL, day: '2026-10-09', median_ft: 11, p10_ft: 10, n: 3 };

  it('sanitize strips uid and timestamps at runtime and counts them', () => {
    const dirty = { ...row, uid: 'abc', ts: '2026-10-09T15:30:00Z', boat: 'x' } as unknown;
    const r = sanitizeUploadRows([dirty]);
    expect(r.stripped).toBe(1);
    expect(r.rows).toEqual([row]);
    expect(Object.keys(r.rows[0]!)).toHaveLength(5);
  });

  it('sanitize drops invalid rows', () => {
    const r = sanitizeUploadRows([
      { ...row, h3_cell: 'nope' },
      { ...row, day: '2026-10-09T15:30:00Z' },
      { ...row, n: 0 },
      { ...row, median_ft: Number.NaN },
      'string',
      null,
      row,
    ]);
    expect(r.rows).toEqual([row]);
    expect(r.dropped).toBe(6);
  });

  it('buildUploadPayload output passes the guard', () => {
    const payload = buildUploadPayload([row]);
    expect(() => assertAnonymousUploadPayload(payload)).not.toThrow();
    expect(Object.keys(payload)).toEqual(['rows']);
  });

  it('type level: a row type with a uid does not compile', () => {
    const withUid = { ...row, uid: 'u1' };
    // @ts-expect-error extra key `uid` must be rejected by the type system
    buildUploadPayload([withUid]);
    // the runtime strip still removes it if the type guard is bypassed
    const payload = buildUploadPayload([withUid] as unknown as DepthUploadRow[]);
    expect(payload.rows[0]).toEqual(row);
  });

  it('guard throws on uid, timestamps, extra top-level keys', () => {
    expect(() => assertAnonymousUploadPayload({ rows: [{ ...row, uid: 'u' }] })).toThrow(/forbidden/);
    expect(() => assertAnonymousUploadPayload({ rows: [row], uid: 'u' })).toThrow(/top-level/);
    expect(() => assertAnonymousUploadPayload({ rows: [{ ...row, day: '2026-10-09T10:00:00Z' }] })).toThrow(/invalid/);
    expect(() => assertAnonymousUploadPayload([row])).toThrow();
  });
});

describe('mergeUploadRows', () => {
  const base: DepthUploadRow = { h3_cell: CELL, day: '2026-10-09', median_ft: 10, p10_ft: 8, n: 3 };
  it('merges same cell+day: n summed, weighted median, weighted p10', () => {
    const [m] = mergeUploadRows([base, { ...base, median_ft: 14, p10_ft: 12, n: 1 }]);
    expect(m).toEqual({ h3_cell: CELL, day: '2026-10-09', median_ft: 10, p10_ft: 9, n: 4 });
  });
  it('leaves distinct cells/days alone', () => {
    const out = mergeUploadRows([base, { ...base, day: '2026-10-10' }]);
    expect(out).toHaveLength(2);
  });
  it('idempotent on already-unique rows', () => {
    expect(mergeUploadRows([base])).toEqual([base]);
  });
});
