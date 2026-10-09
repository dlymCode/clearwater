import Constants from 'expo-constants';

/** Runtime config. EXPO_PUBLIC_* are inlined at build time; TILE_AUTH_URL arrives via app.config.ts `extra`. */
const extra = (Constants.expoConfig?.extra ?? {}) as { tileAuthUrl?: string };

export const CONFIG = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  tileAuthUrl: extra.tileAuthUrl ?? '',
  tilesIndexUrl: process.env.EXPO_PUBLIC_TILES_INDEX_URL ?? '',
} as const;

export function isBackendConfigured(): boolean {
  return CONFIG.supabaseUrl.length > 0 && CONFIG.supabaseAnonKey.length > 0;
}
