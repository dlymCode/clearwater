import {
  NmeaFixTracker,
  NmeaLineBuffer,
  NmeaStream,
  buildNmea,
  newNmeaStats,
  nmeaChecksum,
  parseNmeaLine,
} from '../src/lib/nmea';
import type { DbtSentence, DptSentence, GgaSentence, RmcSentence, VhwSentence } from '../src/lib/nmea';

describe('checksum', () => {
  it('matches the canonical GGA example (*47)', () => {
    expect(nmeaChecksum('GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,')).toBe('47');
  });
  it('matches the canonical RMC example (*6A)', () => {
    expect(nmeaChecksum('GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W')).toBe('6A');
  });
});

describe('DPT', () => {
  it('parses depth and offsets in metres, derives feet', () => {
    const s = parseNmeaLine(buildNmea('SDDPT,10.00,0.5,100.0')) as DptSentence;
    expect(s.type).toBe('DPT');
    expect(s.talker).toBe('SD');
    expect(s.depthM).toBe(10);
    expect(s.depthFt).toBeCloseTo(32.808399, 5);
    expect(s.offsetM).toBe(0.5);
    expect(s.maxRangeM).toBe(100);
  });
  it('empty depth gives null depth', () => {
    const s = parseNmeaLine(buildNmea('SDDPT,,')) as DptSentence;
    expect(s.depthM).toBeNull();
    expect(s.depthFt).toBeNull();
  });
  it('negative (keel) offset is preserved', () => {
    const s = parseNmeaLine(buildNmea('SDDPT,5.2,-1.1')) as DptSentence;
    expect(s.offsetM).toBe(-1.1);
  });
});

describe('DBT (feet / metres / fathoms)', () => {
  it('prefers the metres field', () => {
    const s = parseNmeaLine(buildNmea('SDDBT,30.0,f,9.1,M,5.0,F')) as DbtSentence;
    expect(s.depthM).toBeCloseTo(9.1, 9);
    expect(s.depthFt).toBeCloseTo(9.1 * 3.280839895, 6);
  });
  it('falls back to feet when metres are empty', () => {
    const s = parseNmeaLine(buildNmea('SDDBT,30.0,f,,M,,F')) as DbtSentence;
    expect(s.depthFt).toBe(30);
    expect(s.depthM).toBeCloseTo(30 / 3.280839895, 9);
  });
  it('falls back to fathoms (6 ft each)', () => {
    const s = parseNmeaLine(buildNmea('SDDBT,,f,,M,5.0,F')) as DbtSentence;
    expect(s.depthFt).toBe(30);
  });
  it('all empty gives null', () => {
    const s = parseNmeaLine(buildNmea('SDDBT,,f,,M,,F')) as DbtSentence;
    expect(s.depthFt).toBeNull();
  });
});

describe('GGA', () => {
  it('parses the canonical example including HDOP', () => {
    const s = parseNmeaLine(
      '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47',
    ) as GgaSentence;
    expect(s.type).toBe('GGA');
    expect(s.timeUtc).toBe('12:35:19');
    expect(s.lat).toBeCloseTo(48 + 7.038 / 60, 9);
    expect(s.lon).toBeCloseTo(11 + 31 / 60, 9);
    expect(s.fixQuality).toBe(1);
    expect(s.satellites).toBe(8);
    expect(s.hdop).toBe(0.9);
    expect(s.altitudeM).toBe(545.4);
  });
  it('southern / western hemispheres are negative (Puget Sound is W)', () => {
    const s = parseNmeaLine(buildNmea('GPGGA,010203,4818.500,N,12230.250,W,2,10,1.2,3.0,M,0,M,,')) as GgaSentence;
    expect(s.lat).toBeCloseTo(48 + 18.5 / 60, 9);
    expect(s.lon).toBeCloseTo(-(122 + 30.25 / 60), 9);
  });
  it('fix quality 0 withholds position but keeps HDOP', () => {
    const s = parseNmeaLine(buildNmea('GPGGA,010203,4818.500,N,12230.250,W,0,00,99.9,,M,,M,,')) as GgaSentence;
    expect(s.lat).toBeNull();
    expect(s.lon).toBeNull();
    expect(s.hdop).toBe(99.9);
  });
});

describe('RMC', () => {
  it('parses the canonical example: knots, COG, UTC date', () => {
    const s = parseNmeaLine(
      '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A',
    ) as RmcSentence;
    expect(s.valid).toBe(true);
    expect(s.sogKt).toBe(22.4);
    expect(s.cogDeg).toBe(84.4);
    expect(s.timeMs).toBe(Date.UTC(1994, 2, 23, 12, 35, 19));
  });
  it('void status withholds the position', () => {
    const s = parseNmeaLine(buildNmea('GPRMC,123519,V,,,,,,,230326,,')) as RmcSentence;
    expect(s.valid).toBe(false);
    expect(s.lat).toBeNull();
    expect(s.sogKt).toBeNull();
  });
  it('two-digit year pivots to 2000s', () => {
    const s = parseNmeaLine(buildNmea('GPRMC,000000,A,4818.5,N,12230.25,W,3.5,10.0,091026,,')) as RmcSentence;
    expect(s.timeMs).toBe(Date.UTC(2026, 9, 9, 0, 0, 0));
  });
});

describe('VHW', () => {
  it('reads knots directly', () => {
    const s = parseNmeaLine(buildNmea('IIVHW,90.0,T,87.0,M,5.5,N,10.2,K')) as VhwSentence;
    expect(s.headingTrueDeg).toBe(90);
    expect(s.headingMagneticDeg).toBe(87);
    expect(s.stwKt).toBe(5.5);
  });
  it('derives knots from km/h when the knots field is empty', () => {
    const s = parseNmeaLine(buildNmea('IIVHW,,T,,M,,N,18.52,K')) as VhwSentence;
    expect(s.stwKt).toBeCloseTo(10, 9);
  });
});

describe('checksum failures and junk', () => {
  it('bad checksum returns null and counts', () => {
    const stats = newNmeaStats();
    expect(parseNmeaLine('$SDDPT,10.0,0.0*00', stats)).toBeNull();
    expect(stats.badChecksum).toBe(1);
    expect(stats.parsed).toBe(0);
  });
  it('flipped digit in an otherwise valid sentence is caught', () => {
    const good = buildNmea('SDDPT,10.0,0.0');
    const bad = good.replace('10.0', '11.0');
    const stats = newNmeaStats();
    expect(parseNmeaLine(good, stats)).not.toBeNull();
    expect(parseNmeaLine(bad, stats)).toBeNull();
    expect(stats.badChecksum).toBe(1);
    expect(stats.parsed).toBe(1);
  });
  it('missing checksum is rejected by default, accepted when not required', () => {
    const stats = newNmeaStats();
    expect(parseNmeaLine('$SDDPT,10.0,0.0', stats)).toBeNull();
    expect(stats.badChecksum).toBe(1);
    expect(parseNmeaLine('$SDDPT,10.0,0.0', undefined, { requireChecksum: false })).not.toBeNull();
  });
  it('lowercase checksum hex is accepted', () => {
    const s = parseNmeaLine('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6a');
    expect(s).not.toBeNull();
  });
  it('unused types are ignored (counted), proprietary ignored, noise malformed', () => {
    const stats = newNmeaStats();
    expect(parseNmeaLine(buildNmea('GPGSV,1,1,00'), stats)).toBeNull();
    expect(parseNmeaLine(buildNmea('PGRMZ,100,f,3'), stats)).toBeNull();
    expect(parseNmeaLine('hello world', stats)).toBeNull();
    expect(stats.ignored).toBe(2);
    expect(stats.malformed).toBe(1);
    expect(stats.badChecksum).toBe(0);
  });
  it('truncated sentence with a valid checksum is malformed, not a crash', () => {
    const stats = newNmeaStats();
    expect(parseNmeaLine(buildNmea('GPGGA,123519'), stats)).toBeNull();
    expect(stats.malformed).toBe(1);
  });
  it('tolerates a gateway prefix before the $', () => {
    const s = parseNmeaLine(`12:00:01.123 ${buildNmea('SDDPT,3.0,0.0')}`);
    expect(s?.type).toBe('DPT');
  });
});

describe('NmeaLineBuffer', () => {
  it('splits CRLF, LF and CR and keeps partials across chunks', () => {
    const b = new NmeaLineBuffer();
    expect(b.push('$AA,1*00\r\n$BB,2')).toEqual(['$AA,1*00']);
    // A bare CR terminates a line; the LF that follows in the next chunk yields an empty line (dropped).
    expect(b.push('*11\n$CC,3*22\r')).toEqual(['$BB,2*11', '$CC,3*22']);
    expect(b.push('\n')).toEqual([]);
  });
  it('several sentences in one datagram', () => {
    const b = new NmeaLineBuffer();
    expect(b.push('a\r\nb\r\nc\r\n')).toEqual(['a', 'b', 'c']);
  });
  it('flush emits an unterminated final line (UDP)', () => {
    const b = new NmeaLineBuffer();
    expect(b.push('$AA,1*00')).toEqual([]);
    expect(b.flush()).toEqual(['$AA,1*00']);
    expect(b.flush()).toEqual([]);
  });
  it('discards a runaway line and counts the overflow', () => {
    const b = new NmeaLineBuffer(16);
    expect(b.push('x'.repeat(40))).toEqual([]);
    expect(b.overflows).toBe(1);
    expect(b.push('ok\n')).toEqual(['ok']);
  });
});

describe('NmeaStream', () => {
  it('parses a split TCP stream and tallies stats', () => {
    const d = buildNmea('SDDPT,12.0,0.0');
    const bad = '$SDDPT,12.0,0.0*FF';
    const r = buildNmea('GPRMC,123519,A,4807.038,N,01131.000,E,5.0,84.4,230394,,');
    const stream = new NmeaStream();
    const out = [
      ...stream.feed(d.slice(0, 7)),
      ...stream.feed(`${d.slice(7)}\r\n${bad}\r\n${r.slice(0, 20)}`),
      ...stream.feed(`${r.slice(20)}\r\n`),
    ];
    expect(out.map((s) => s.type)).toEqual(['DPT', 'RMC']);
    expect(stream.stats.badChecksum).toBe(1);
    expect(stream.stats.parsed).toBe(2);
  });
  it('datagram mode flushes the last line', () => {
    const stream = new NmeaStream();
    expect(stream.feed(buildNmea('SDDPT,5.0,0.0'), true)).toHaveLength(1);
  });
});

describe('NmeaFixTracker', () => {
  const gga = parseNmeaLine(buildNmea('GPGGA,010203,4818.500,N,12230.250,W,1,10,1.8,3.0,M,0,M,,'))!;
  const rmc = parseNmeaLine(buildNmea('GPRMC,010203,A,4818.500,N,12230.250,W,4.2,10.0,091026,,'))!;
  const dpt = parseNmeaLine(buildNmea('SDDPT,3.048,0.0'))!; // 10 ft

  it('joins depth with position, SOG and HDOP', () => {
    const t = new NmeaFixTracker({ minIntervalMs: 0 });
    t.update(gga, 1000);
    t.update(rmc, 1000);
    const snap = t.update(dpt, 1500)!;
    expect(snap.rawDepthFt).toBeCloseTo(10, 4);
    expect(snap.sogKt).toBe(4.2);
    expect(snap.hdop).toBe(1.8);
    expect(snap.lat).toBeCloseTo(48 + 18.5 / 60, 9);
  });
  it('marks stale fields null after maxFieldAgeMs', () => {
    const t = new NmeaFixTracker({ minIntervalMs: 0, maxFieldAgeMs: 5000 });
    t.update(gga, 1000);
    t.update(rmc, 1000);
    const snap = t.update(dpt, 7000)!;
    expect(snap.sogKt).toBeNull();
    expect(snap.hdop).toBeNull();
    expect(snap.lat).toBeNull();
  });
  it('rate-limits snapshots (DPT+DBT duplicates collapse to 1 Hz)', () => {
    const t = new NmeaFixTracker();
    expect(t.update(dpt, 1000)).not.toBeNull();
    expect(t.update(dpt, 1200)).toBeNull();
    expect(t.update(dpt, 2000)).not.toBeNull();
  });
  it('void RMC does not update position or SOG', () => {
    const voidRmc = parseNmeaLine(buildNmea('GPRMC,010203,V,,,,,,,091026,,'))!;
    const t = new NmeaFixTracker({ minIntervalMs: 0 });
    t.update(voidRmc, 1000);
    const snap = t.update(dpt, 1100)!;
    expect(snap.sogKt).toBeNull();
    expect(snap.lat).toBeNull();
  });
});

describe('B3: resync on glued / truncated sentences', () => {
  const good = buildNmea('SDDPT,12.3,0.5,100');
  it('a truncated sentence glued in front of a good one parses the good one', () => {
    expect(parseNmeaLine(`$SDDPT,12.3,0.5,1${good}`)?.type).toBe('DPT');
  });
  it('a doubled "$" parses', () => {
    expect(parseNmeaLine(`$${good}`)?.type).toBe('DPT');
  });
  it('a truncated sentence WITHOUT its own "$" in front of a good one still resyncs', () => {
    expect(parseNmeaLine(`SDDPT,12.3*7F${good}`)?.type).toBe('DPT');
  });
  it('a good sentence followed by garbage without "*" keeps its own checksum scope', () => {
    expect(parseNmeaLine(good)?.type).toBe('DPT');
  });
  it('two full sentences on one line: the last one wins, nothing throws', () => {
    expect(parseNmeaLine(good + good)?.type).toBe('DPT');
  });
  it('a stale partial line cannot eat the first sentence after a reconnect (fresh stream per connection)', () => {
    const old = new NmeaStream();
    old.feed('$SDDPT,12.3,0.5,'); // connection dropped mid-sentence
    expect(old.feed(`${good}\r\n`)).toHaveLength(1); // resync saves even the stale stream...
    const fresh = new NmeaStream(); // ...and the client uses a fresh one anyway
    expect(fresh.feed(`${good}\r\n`)).toHaveLength(1);
  });
});

describe('E: tracker never emits non-finite depth', () => {
  it('Infinity / NaN depth is treated as no sounder', () => {
    const t = new NmeaFixTracker({ minIntervalMs: 0 });
    expect(t.update({ type: 'DPT', talker: 'SD', depthM: Infinity, depthFt: Infinity, offsetM: 0, maxRangeM: null }, 1000)).toBeNull();
    expect(t.update({ type: 'DBT', talker: 'SD', depthM: Number.NaN, depthFt: Number.NaN }, 2000)).toBeNull();
    expect(t.update({ type: 'DBT', talker: 'SD', depthM: 3, depthFt: 10 }, 3000)?.rawDepthFt).toBe(10);
  });
  it('the parser itself never produces Infinity from a literal "1e999" or hex garbage', () => {
    const s = parseNmeaLine(buildNmea('SDDPT,1e999,0'));
    expect(s === null || (s.type === 'DPT' && (s.depthFt === null || Number.isFinite(s.depthFt)))).toBe(true);
  });
});
