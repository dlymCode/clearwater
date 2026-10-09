import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';

/** First-launch gate: the "not for navigation" disclaimer MUST be accepted before the app is usable. */
export function OnboardingScreen({ onAccept }: { onAccept: (isoTime: string) => void }) {
  const c = useColors();
  const [checked, setChecked] = useState(false);
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>Sound Maps</Text>
      <Text style={[s.h2, { color: c.danger }]}>Not for navigation</Text>
      <Text style={[s.body, { color: c.text }]}>
        This app is an overlay and a second screen, not a chartplotter. Depths come from public surveys, satellite imagery and
        other boats' sounders. They are modeled and crowdsourced, not surveyed, and may be years out of date. Every cell shows its
        source and date: check them. Regulatory boundaries are shown for reference; WDFW rules and the WAC govern.
      </Text>
      <Text style={[s.body, { color: c.text }]}>
        Your raw tracks and soundings never leave this device. Only anonymous per-cell depth summaries, your pings, and (if you allow
        it) your last position rounded to 100 m are shared.
      </Text>
      <View style={[s.row, { justifyContent: 'space-between', minHeight: 56 }]}>
        <Text style={[s.body, { color: c.text, flex: 1 }]}>I understand this app is not for navigation.</Text>
        <Switch value={checked} onValueChange={setChecked} accessibilityLabel="Accept not for navigation" />
      </View>
      <Button label="Continue" disabled={!checked} onPress={() => onAccept(new Date().toISOString())} />
    </ScrollView>
  );
}
