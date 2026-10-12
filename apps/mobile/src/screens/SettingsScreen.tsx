import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { offsetsNeeded, parseOffsetFt, validateNmea, type NmeaProtocol } from '../lib/settings';
import { saveSettings } from '../services/settingsRepo';
import { getLastSyncReport, outbox, syncNow } from '../services/syncService';
import type { OutboxRow } from '../lib/outbox';
import { useAppStore } from '../state/store';

/** Sync health: unsent counts, rows the server rejected (with a retry button), last pull errors. Never silent. */
function SyncStatus() {
  const c = useColors();
  const rev = useAppStore((st) => st.dataRev);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<OutboxRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const refresh = useCallback(async () => {
    setPending((await outbox.pending()).length);
    setFailed(await outbox.failed());
    setErrors(getLastSyncReport()?.errors ?? []);
  }, []);
  useEffect(() => void refresh(), [refresh, rev]);
  return (
    <View style={s.gap}>
      <Text style={[s.h2, { color: c.text }]}>Sync</Text>
      <Text style={[s.body, { color: c.text }]}>{`${pending} waiting to send, ${failed.length} rejected by the server`}</Text>
      {failed.map((r) => (
        <Text key={r.id} style={[s.small, { color: c.danger }]}>{`${r.kind}: ${r.lastError ?? 'rejected'}`}</Text>
      ))}
      {errors.map((e) => (
        <Text key={e} style={[s.small, { color: c.warn }]}>{e}</Text>
      ))}
      <Button label="Sync now" kind="secondary" onPress={() => { syncNow().then(refresh).catch(() => refresh()); }} />
      {failed.length > 0 ? <Button label="Retry rejected" onPress={() => { outbox.retryFailed().then(() => syncNow()).then(refresh).catch(() => refresh()); }} /> : null}
    </View>
  );
}

export function SettingsScreen() {
  const c = useColors();
  const settings = useAppStore((st) => st.settings);
  const nmeaStatus = useAppStore((st) => st.nmeaStatus);
  const stats = useAppStore((st) => st.nmeaStats);
  const [xducer, setXducer] = useState(settings.transducerDepthFt?.toString() ?? '');
  const [keel, setKeel] = useState(settings.keelDepthFt?.toString() ?? '');
  const [host, setHost] = useState(settings.nmeaHost);
  const [port, setPort] = useState(String(settings.nmeaPort));
  const [msg, setMsg] = useState<string | null>(null);

  async function saveOffsets() {
    const a = parseOffsetFt(xducer, 'Transducer depth');
    const b = parseOffsetFt(keel, 'Keel depth');
    if (!a.ok) return setMsg(a.error);
    if (!b.ok) return setMsg(b.error);
    await saveSettings({ transducerDepthFt: a.value, keelDepthFt: b.value });
    setMsg('Saved.');
  }
  async function saveNmea(protocol: NmeaProtocol = settings.nmeaProtocol) {
    const v = validateNmea(host, port);
    if (!v.ok) return setMsg(v.error);
    await saveSettings({ nmeaHost: v.value.host, nmeaPort: v.value.port, nmeaProtocol: protocol });
    setMsg('Saved.');
  }

  const field = { color: c.text, borderColor: c.border } as const;
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>Settings</Text>
      {msg ? <Text style={{ color: c.accent }}>{msg}</Text> : null}

      <Text style={[s.h2, { color: c.text }]}>Boat offsets (asked once)</Text>
      {offsetsNeeded(settings) ? <Text style={{ color: c.warn }}>Set both before depth logging starts. A wrong offset is the most likely source of error.</Text> : null}
      <Text style={[s.small, { color: c.sub }]}>Transducer depth below the waterline (ft)</Text>
      <TextInput value={xducer} onChangeText={setXducer} keyboardType="decimal-pad" style={[s.input, field]} accessibilityLabel="Transducer depth in feet" />
      <Text style={[s.small, { color: c.sub }]}>Keel depth below the waterline (ft)</Text>
      <TextInput value={keel} onChangeText={setKeel} keyboardType="decimal-pad" style={[s.input, field]} accessibilityLabel="Keel depth in feet" />
      <Button label="Save offsets" onPress={() => void saveOffsets()} />

      <Text style={[s.h2, { color: c.text }]}>Depth sounder (NMEA 0183 over WiFi)</Text>
      <View style={[s.row, { justifyContent: 'space-between', minHeight: 56 }]}>
        <Text style={[s.body, { color: c.text }]}>Read sounder</Text>
        <Switch value={settings.nmeaEnabled} onValueChange={(v) => void saveSettings({ nmeaEnabled: v })} />
      </View>
      <View style={s.row}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Button label="TCP" kind={settings.nmeaProtocol === 'tcp' ? 'primary' : 'secondary'} onPress={() => void saveNmea('tcp')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="UDP" kind={settings.nmeaProtocol === 'udp' ? 'primary' : 'secondary'} onPress={() => void saveNmea('udp')} />
        </View>
      </View>
      <TextInput value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} style={[s.input, field]} accessibilityLabel="Gateway host" />
      <TextInput value={port} onChangeText={setPort} keyboardType="number-pad" style={[s.input, field]} accessibilityLabel="Gateway port" />
      <Button label="Save connection" onPress={() => void saveNmea()} />
      <Text style={[s.small, { color: c.sub }]}>
        {`Status: ${nmeaStatus}${stats ? `. ${stats.parsed} sentences parsed, ${stats.badChecksum} bad checksums dropped.` : ''}`}
      </Text>

      <SyncStatus />

      <Text style={[s.h2, { color: c.text }]}>Privacy</Text>
      <View style={[s.row, { justifyContent: 'space-between', minHeight: 56 }]}>
        <Text style={[s.body, { color: c.text, flex: 1 }]}>Share my last position (rounded to 100 m, every 5 min, app open). Off = you cannot confirm pings.</Text>
        <Switch value={settings.sharePosition} onValueChange={(v) => void saveSettings({ sharePosition: v })} />
      </View>
      <Text style={[s.small, { color: c.sub }]}>Raw tracks and soundings never leave this device.</Text>
    </ScrollView>
  );
}
