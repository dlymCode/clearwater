import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';
import type { Group } from '@clearwater/shared';
import { s, useColors } from './src/components/theme';
import { isBackendConfigured } from './src/services/config';
import { getDb } from './src/services/db';
import { DepthLogger } from './src/services/depthLogger';
import { requestForegroundPermission, watchGps } from './src/services/location';
import { NmeaClient } from './src/services/nmeaClient';
import { maybeReportPosition } from './src/services/positionReporter';
import { loadSettings, saveSettings } from './src/services/settingsRepo';
import { loadProfileState } from './src/services/profile';
import { getSupabase } from './src/services/supabase';
import { outbox, startSyncTriggers } from './src/services/syncService';
import { useAppStore } from './src/state/store';
import { AuthScreen } from './src/screens/AuthScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { ChannelScreen } from './src/screens/ChannelScreen';
import { DownloadScreen } from './src/screens/DownloadScreen';
import { GroupsScreen } from './src/screens/GroupsScreen';
import { MapScreen } from './src/screens/MapScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TideScreen } from './src/screens/TideScreen';

type Tab = 'map' | 'tides' | 'areas' | 'groups' | 'settings';
const TABS: Array<[Tab, string]> = [['map', 'Map'], ['tides', 'Tides'], ['areas', 'Areas'], ['groups', 'Groups'], ['settings', 'Settings']];

export default function App() {
  const c = useColors();
  const loaded = useAppStore((st) => st.settingsLoaded);
  const authRequired = useAppStore((st) => st.authRequired);
  const profileReady = useAppStore((st) => st.profileReady);
  const settings = useAppStore((st) => st.settings);
  const [tab, setTab] = useState<Tab>('map');
  const [channel, setChannel] = useState<Group | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const logger = useRef(new DepthLogger(outbox));
  const nmea = useRef<NmeaClient | null>(null);

  // Boot: open the encrypted store, load settings, check the session.
  useEffect(() => {
    void (async () => {
      await getDb();
      await loadSettings();
      if (isBackendConfigured()) {
        const { data } = await getSupabase().auth.getSession();
        useAppStore.getState().setUserId(data.session?.user.id ?? null);
        if (data.session) await loadProfileState().catch(() => false);
        setSignedIn(!!data.session);
      } else {
        setSignedIn(true); // offline-only mode: map, tides, boundaries work without a backend
      }
    })();
  }, []);

  const accepted = settings.acceptedDisclaimerAt !== null;

  // Sync triggers (foreground, connectivity, 15 min) once the user is in.
  useEffect(() => {
    if (!accepted || !signedIn || !isBackendConfigured()) return;
    return startSyncTriggers();
  }, [accepted, signedIn]);

  // GPS at 1 Hz; accuracy follows whether the sounder feed is active.
  useEffect(() => {
    if (!accepted) return;
    let sub: { remove(): void } | undefined;
    let cancelled = false;
    void requestForegroundPermission().then(async (ok) => {
      if (!ok || cancelled) return;
      sub = await watchGps(settings.nmeaEnabled, (fix) => {
        useAppStore.getState().setGps(fix);
        void maybeReportPosition().catch(() => undefined);
      });
    });
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [accepted, settings.nmeaEnabled]);

  // NMEA sounder feed -> depth logger.
  useEffect(() => {
    if (!accepted || !settings.nmeaEnabled) {
      nmea.current?.stop();
      logger.current.stop().catch(() => undefined);
      return;
    }
    logger.current.start();
    nmea.current = new NmeaClient({
      onSnapshot: (snap) => { logger.current.onSnapshot(snap).catch((e: unknown) => console.warn(`[depth] ${e instanceof Error ? e.message : String(e)}`)); },
      onStatus: (status) => useAppStore.getState().setNmea(status),
      onStats: (stats) => useAppStore.getState().setNmea(useAppStore.getState().nmeaStatus, stats),
    });
    nmea.current.start({ host: settings.nmeaHost, port: settings.nmeaPort, protocol: settings.nmeaProtocol });
    return () => nmea.current?.stop();
  }, [accepted, settings.nmeaEnabled, settings.nmeaHost, settings.nmeaPort, settings.nmeaProtocol]);

  if (!loaded || signedIn === null) return <View style={{ flex: 1, backgroundColor: c.bg }} />;
  if (!accepted) return <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}><OnboardingScreen onAccept={(t, share) => void saveSettings({ acceptedDisclaimerAt: t, sharePosition: share })} /></SafeAreaView>;
  if (!signedIn || authRequired) return <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}><AuthScreen onSignedIn={() => { setSignedIn(true); useAppStore.getState().setAuthRequired(false); void getSupabase().auth.getSession().then(({ data }) => useAppStore.getState().setUserId(data.session?.user.id ?? null)).then(() => loadProfileState()).catch(() => false); }} /></SafeAreaView>;

  // Everything that writes needs the profiles row (foreign keys); capture a handle first.
  if (isBackendConfigured() && !profileReady) return <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}><ProfileScreen onDone={() => undefined} /></SafeAreaView>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style="auto" />
      <View style={s.fill}>
        {tab === 'map' ? <MapScreen /> : null}
        {tab === 'tides' ? <TideScreen /> : null}
        {tab === 'areas' ? <DownloadScreen /> : null}
        {tab === 'groups' ? (channel ? <ChannelScreen group={channel} onBack={() => setChannel(null)} /> : <GroupsScreen onOpen={setChannel} />) : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>
      <View style={[s.row, { backgroundColor: c.card }]}>
        {TABS.map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} style={{ flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: tab === key ? c.accent : c.sub, fontWeight: tab === key ? '700' : '500' }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
