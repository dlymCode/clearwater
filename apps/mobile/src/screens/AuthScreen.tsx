import { useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { getSupabase } from '../services/supabase';

/** Phone OTP sign-in (no passwords). TODO: Sign in with Apple (needs expo-apple-authentication + Apple Developer setup, S5-2). */
export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const c = useColors();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    const { error } = await getSupabase().auth.signInWithOtp({ phone: phone.trim() });
    if (error) setErr(error.message);
    else { setErr(null); setSent(true); }
  }
  async function verify() {
    const { error } = await getSupabase().auth.verifyOtp({ phone: phone.trim(), token: code.trim(), type: 'sms' });
    if (error) setErr(error.message);
    else onSignedIn();
  }
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>Sign in</Text>
      <TextInput value={phone} onChangeText={setPhone} placeholder="+1 555 123 4567" placeholderTextColor={c.sub} keyboardType="phone-pad" style={[s.input, { color: c.text, borderColor: c.border }]} />
      {sent ? (
        <>
          <TextInput value={code} onChangeText={setCode} placeholder="6-digit code" placeholderTextColor={c.sub} keyboardType="number-pad" style={[s.input, { color: c.text, borderColor: c.border }]} />
          <Button label="Verify" onPress={() => void verify()} />
        </>
      ) : (
        <Button label="Text me a code" onPress={() => void send()} />
      )}
      {err ? <Text style={{ color: c.danger }}>{err}</Text> : null}
    </ScrollView>
  );
}
