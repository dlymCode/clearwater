import type { ExpoConfig } from 'expo/config';

/**
 * iOS-first (PRD non-goal: Android before iOS). Env values are read at build time via EAS secrets
 * / .env. TILE_AUTH_URL is not EXPO_PUBLIC_ so it is surfaced to the app through `extra`.
 */
const config: ExpoConfig = {
  name: 'Sound Maps',
  slug: 'sound-maps',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  scheme: 'soundmaps',
  ios: {
    bundleIdentifier: 'com.lymly.soundmaps', // TODO: confirm with Apple Developer account (S0-1)
    supportsTablet: true,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'Sound Maps shows your boat on the map and rounds your last position to 100 m so other boats can confirm hazards near you.',
      NSLocalNetworkUsageDescription:
        'Sound Maps connects to your boat\'s WiFi NMEA gateway to read the depth sounder.',
      UIBackgroundModes: ['location', 'fetch'],
    },
  },
  plugins: [
    'expo-secure-store',
    ['expo-sqlite', { useSQLCipher: true }],
    ['expo-location', { isIosBackgroundLocationEnabled: false }],
    '@maplibre/maplibre-react-native',
    'expo-build-properties',
  ],
  extra: {
    tileAuthUrl: process.env.TILE_AUTH_URL ?? '',
    eas: { projectId: '' }, // TODO: filled by `eas init`
  },
};

export default config;
