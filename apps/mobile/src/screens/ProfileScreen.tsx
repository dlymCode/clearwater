import { useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { validateProfile } from '../lib/profile';
import { saveProfile } from '../services/profile';

/**
 * Handle + optional vessel name, captured once after sign-in. The profiles row must exist before any ping, vote,
 * message or join (foreign keys), so the rest of the app waits for this screen.
 */
export function ProfileScreen({ onDone }: { onDone: () => void }) {
  const c = useColors();
  const [handle, setHandle] = useState('');
  const [vessel, setVessel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const check = validateProfile(handle, vessel);

  async function save() {
    const e = await saveProfile(handle, vessel);
    if (e) setErr(e);
    else onDone();
  }
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>Choose a handle</Text>
      <Text style={[s.body, { color: c.sub }]}>Other boats see this handle on your pings and messages. No real name needed.</Text>
      <TextInput value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false} placeholder="Handle (3 to 24 characters)" placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} accessibilityLabel="Handle" />
      <TextInput value={vessel} onChangeText={setVessel} placeholder="Vessel name (optional)" placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} accessibilityLabel="Vessel name" />
      {handle.length > 0 && !check.ok ? <Text style={{ color: c.warn }}>{check.error}</Text> : null}
      {err ? <Text style={{ color: c.danger }}>{err}</Text> : null}
      <Button label="Continue" disabled={!check.ok} onPress={() => void save()} />
    </ScrollView>
  );
}
