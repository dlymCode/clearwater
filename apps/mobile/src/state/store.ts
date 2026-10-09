import { create } from 'zustand';
import type { GpsFix } from '../services/location';
import type { NmeaStats } from '../lib/nmea';
import { DEFAULT_SETTINGS, mergeSettings, type AppSettings } from '../lib/settings';
import type { NmeaStatus } from '../services/nmeaClient';

export interface DepthReading {
  tMs: number;
  rawFt: number;
  /** Clearance below the keel (live; independent of tide). null until offsets are set. */
  underKeelFt: number | null;
  /** Charted depth ft below MLLW at this position. null without tide data. */
  mllwDepthFt: number | null;
  tideFt: number | null;
  logged: boolean;
}

interface AppState {
  settings: AppSettings;
  settingsLoaded: boolean;
  gps: GpsFix | null;
  depth: DepthReading | null;
  nmeaStatus: NmeaStatus;
  nmeaStats: NmeaStats | null;
  /** Bumped whenever local ping/vote/message tables change, to refresh lists. */
  dataRev: number;
  setSettings: (patch: Partial<AppSettings>) => void;
  hydrateSettings: (stored: unknown) => void;
  setGps: (fix: GpsFix) => void;
  setDepth: (d: DepthReading | null) => void;
  setNmea: (status: NmeaStatus, stats?: NmeaStats | null) => void;
  bumpData: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  gps: null,
  depth: null,
  nmeaStatus: 'idle',
  nmeaStats: null,
  dataRev: 0,
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  hydrateSettings: (stored) => set({ settings: mergeSettings(stored), settingsLoaded: true }),
  setGps: (gps) => set({ gps }),
  setDepth: (depth) => set({ depth }),
  setNmea: (nmeaStatus, stats) => set((s) => ({ nmeaStatus, nmeaStats: stats === undefined ? s.nmeaStats : stats })),
  bumpData: () => set((s) => ({ dataRev: s.dataRev + 1 })),
}));
