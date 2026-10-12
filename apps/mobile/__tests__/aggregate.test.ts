import { latLngToCell } from 'h3-js';
import type { DepthUploadRow } from '@clearwater/shared';
import {
  aggregateSoundings,
  assertAnonymousUploadPayload,
  buildUploadPayload,
  isRealCalendarDay,
  mergeUploadRows,
  percentile,
  reaggregateTouched,
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

describe('mergeUploadRows: later complete-day aggregates supersede earlier ones', () => {
  const base: DepthUploadRow = { h3_cell: CELL, day: '2026-10-09', median_ft: 10, p10_ft: 8, n: 3 };
  it('same cell+day: the LATER row replaces the earlier one (never summed)', () => {
    const later = { ...base, median_ft: 14, p10_ft: 12, n: 7 };
    expect(mergeUploadRows([base, later])).toEqual([later]);
    expect(mergeUploadRows([later, base])).toEqual([base]); // order is send order, oldest first
  });
  it('leaves distinct cells/days alone, sorted by day then cell', () => {
    const out = mergeUploadRows([{ ...base, day: '2026-10-10' }, base]);
    expect(out.map((r) => r.day)).toEqual(['2026-10-09', '2026-10-10']);
  });
  it('clamps p10 to at most the median', () => {
    expect(mergeUploadRows([{ ...base, median_ft: 5, p10_ft: 9 }])[0]!.p10_ft).toBe(5);
  });
  it('idempotent on already-unique rows', () => {
    expect(mergeUploadRows([base])).toEqual([base]);
  });
});

describe('B1: reaggregateTouched uploads the COMPLETE day for touched cells', () => {
  const morning = Date.parse('2026-10-09T10:00:00Z');
  const afternoon = Date.parse('2026-10-09T14:00:00Z');
  const other = 48.4;
  it('a cell logged at 10:00 and again at 14:00 ends with the combined n / median', () => {
    const am = [s(10, { tMs: morning }), s(12, { tMs: morning + 1000 })];
    const pm = [s(20, { tMs: afternoon }), s(22, { tMs: afternoon + 1000 })];
    const untouched = [s(30, { tMs: morning, lat: other })];
    // first batch: only the morning soundings are fresh
    const first = reaggregateTouched(am.concat(untouched), am.concat(untouched));
    expect(first.find((r) => r.h3_cell === CELL)).toMatchObject({ n: 2, median_ft: 11 });
    // second batch: only the afternoon ones are fresh, but the day's rows for that cell are ALL re-aggregated
    const second = reaggregateTouched(pm, am.concat(pm).concat(untouched));
    expect(second).toHaveLength(1); // the untouched cell is not re-sent
    expect(second[0]).toMatchObject({ h3_cell: CELL, day: '2026-10-09', n: 4, median_ft: 16 });
  });
  it('days are independent: yesterday\'s rows are not pulled into today\'s batch', () => {
    const y = s(50, { tMs: morning - 86_400_000 });
    const out = reaggregateTouched([s(10, { tMs: morning })], [y, s(10, { tMs: morning })]);
    expect(out.map((r) => [r.day, r.n])).toEqual([['2026-10-09', 1]]);
  });
  it('replaying the same fresh set is a no-op in content (idempotent)', () => {
    const rows = [s(10, { tMs: morning }), s(12, { tMs: afternoon })];
    expect(reaggregateTouched(rows, rows)).toEqual(reaggregateTouched(rows, rows));
  });
});

describe('E: input guards', () => {
  const T = Date.parse('2026-10-09T10:00:00Z');
  it('bogus coordinates are rejected BEFORE H3 (they would otherwise map to valid cells)', () => {
    expect(aggregateSoundings([s(10, { lat: 91 }), s(10, { lat: -91 }), s(10, { lon: 181 }), s(10, { lon: -181 }), s(10, { lat: Number.NaN })])).toEqual([]);
    expect(aggregateSoundings([s(10, { lat: 90, lon: 180 })])).toHaveLength(1);
  });
  it('bogus times (non-finite, before 2020, far future, beyond Date range) are rejected without throwing', () => {
    expect(aggregateSoundings([s(10, { tMs: Number.NaN }), s(10, { tMs: 8.64e15 + 1 }), s(10, { tMs: 0 }), s(10, { tMs: Date.UTC(2200, 0, 1) }), s(10, { tMs: Infinity })])).toEqual([]);
    expect(aggregateSoundings([s(10, { tMs: T })])).toHaveLength(1);
  });
  it('absurd depths are rejected', () => {
    expect(aggregateSoundings([s(5000), s(-5000)])).toEqual([]);
  });
  it('upload rows: only H3 resolution 12, |values| <= 2000 ft, real calendar days', () => {
    const good: DepthUploadRow = { h3_cell: CELL, day: '2026-10-09', median_ft: 11, p10_ft: 10, n: 3 };
    const res10 = latLngToCell(LAT, LON, 10);
    const res13 = latLngToCell(LAT, LON, 13);
    const r = sanitizeUploadRows([
      good,
      { ...good, h3_cell: res10 },
      { ...good, h3_cell: res13 },
      { ...good, median_ft: 2000.5 },
      { ...good, p10_ft: -2001 },
      { ...good, day: '2026-02-31' },
      { ...good, day: '2026-13-01' },
      { ...good, day: '2026-00-10' },
    ]);
    expect(r.rows).toEqual([good]);
    expect(r.dropped).toBe(7);
    expect(isRealCalendarDay('2024-02-29')).toBe(true);
    expect(isRealCalendarDay('2026-02-29')).toBe(false);
  });
  it('the guard throws for out-of-bounds rows too', () => {
    expect(() => assertAnonymousUploadPayload({ rows: [{ h3_cell: CELL, day: '2026-10-09', median_ft: 99999, p10_ft: 1, n: 1 }] })).toThrow(/invalid/);
  });
});
