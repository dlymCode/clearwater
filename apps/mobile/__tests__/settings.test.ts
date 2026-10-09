import { DEFAULT_SETTINGS, mergeSettings, offsetsNeeded, parseOffsetFt, validateNmea } from '../src/lib/settings';

describe('settings', () => {
  it('offsets: numbers in range only, comma decimals accepted', () => {
    expect(parseOffsetFt('2.5', 'Transducer')).toEqual({ ok: true, value: 2.5 });
    expect(parseOffsetFt('2,5', 'Transducer')).toEqual({ ok: true, value: 2.5 });
    expect(parseOffsetFt('', 'Transducer').ok).toBe(false);
    expect(parseOffsetFt('-1', 'Keel').ok).toBe(false);
    expect(parseOffsetFt('61', 'Keel').ok).toBe(false);
    expect(parseOffsetFt('abc', 'Keel').ok).toBe(false);
  });
  it('NMEA host/port validation', () => {
    expect(validateNmea(' 192.168.4.1 ', '1456')).toEqual({ ok: true, value: { host: '192.168.4.1', port: 1456 } });
    expect(validateNmea('bad host', 1456).ok).toBe(false);
    expect(validateNmea('1.2.3.4', 70000).ok).toBe(false);
    expect(validateNmea('1.2.3.4', 'x').ok).toBe(false);
  });
  it('offsets are asked until both are set', () => {
    expect(offsetsNeeded(DEFAULT_SETTINGS)).toBe(true);
    expect(offsetsNeeded({ ...DEFAULT_SETTINGS, transducerDepthFt: 1, keelDepthFt: 3 })).toBe(false);
  });
  it('mergeSettings tolerates garbage and fills defaults', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const m = mergeSettings({ nmeaPort: 'x', nmeaProtocol: 'udp', toggles: { fleet: true }, sharePosition: false });
    expect(m.nmeaPort).toBe(DEFAULT_SETTINGS.nmeaPort);
    expect(m.nmeaProtocol).toBe('udp');
    expect(m.toggles.fleet).toBe(true);
    expect(m.toggles.depth).toBe(true);
    expect(m.sharePosition).toBe(false);
    expect(DEFAULT_SETTINGS.sharePosition).toBe(false);
    expect(mergeSettings({}).sharePosition).toBe(false);
    expect(mergeSettings({ sharePosition: true }).sharePosition).toBe(true);
  });
});
