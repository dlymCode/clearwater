/** App settings model + validation. Persisted on-device only (private tier; never uploaded). */
import { DEFAULT_TOGGLES, type LayerToggles } from './mapStyle';
import { round2 } from './num';

export type NmeaProtocol = 'tcp' | 'udp';

export interface AppSettings {
  /** Transducer depth below the waterline, ft. null = not asked yet (asked once). */
  transducerDepthFt: number | null;
  /** Keel depth below the waterline, ft. null = not asked yet. */
  keelDepthFt: number | null;
  nmeaEnabled: boolean;
  nmeaHost: string;
  nmeaPort: number;
  nmeaProtocol: NmeaProtocol;
  /** Send rounded last-known position (needed to confirm pings). */
  sharePosition: boolean;
  /** ISO time the "not for navigation" gate was accepted; null = must show it. */
  acceptedDisclaimerAt: string | null;
  toggles: LayerToggles;
}

export const DEFAULT_SETTINGS: AppSettings = {
  transducerDepthFt: null,
  keelDepthFt: null,
  nmeaEnabled: false,
  nmeaHost: '192.168.4.1', // Yacht Devices YDWG-02 default AP address; confirm per gateway
  nmeaPort: 1456, // YDWG-02 default NMEA 0183 TCP port; UDP gateways commonly use 10110
  nmeaProtocol: 'tcp',
  /** Default OFF (privacy): the user opts in explicitly during onboarding. */
  sharePosition: false,
  acceptedDisclaimerAt: null,
  toggles: DEFAULT_TOGGLES,
};

export const MAX_OFFSET_FT = 60;

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseOffsetFt(input: string | number, label: string): Check<number> {
  const n = typeof input === 'number' ? input : Number(input.trim().replace(',', '.'));
  if (input === '' || !Number.isFinite(n)) return { ok: false, error: `${label} must be a number of feet.` };
  if (n < 0 || n > MAX_OFFSET_FT) return { ok: false, error: `${label} must be between 0 and ${MAX_OFFSET_FT} ft.` };
  return { ok: true, value: round2(n) };
}

export function validateNmea(host: string, port: string | number): Check<{ host: string; port: number }> {
  const h = host.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(h)) return { ok: false, error: 'Enter the gateway IP address or host name.' };
  const p = typeof port === 'number' ? port : Number(port.trim());
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: 'Port must be 1-65535.' };
  return { ok: true, value: { host: h, port: p } };
}

/** The offsets are asked once, before the first depth reading is trusted. */
export function offsetsNeeded(s: AppSettings): boolean {
  return s.transducerDepthFt === null || s.keelDepthFt === null;
}

export function mergeSettings(stored: unknown): AppSettings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS;
  const o = stored as Partial<AppSettings>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    transducerDepthFt: num(o.transducerDepthFt),
    keelDepthFt: num(o.keelDepthFt),
    nmeaEnabled: o.nmeaEnabled === true,
    nmeaHost: typeof o.nmeaHost === 'string' && o.nmeaHost ? o.nmeaHost : DEFAULT_SETTINGS.nmeaHost,
    nmeaPort: Number.isInteger(o.nmeaPort) ? (o.nmeaPort as number) : DEFAULT_SETTINGS.nmeaPort,
    nmeaProtocol: o.nmeaProtocol === 'udp' ? 'udp' : 'tcp',
    sharePosition: o.sharePosition === true,
    acceptedDisclaimerAt: typeof o.acceptedDisclaimerAt === 'string' ? o.acceptedDisclaimerAt : null,
    toggles: { ...DEFAULT_TOGGLES, ...(typeof o.toggles === 'object' && o.toggles ? o.toggles : {}) },
  };
}
