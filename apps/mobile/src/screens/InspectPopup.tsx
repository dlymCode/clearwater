import { Modal, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import type { InspectReadout } from '../lib/inspect';

/** MAP-3: depth, source, date, uncertainty. Every field is a non-empty string ("unknown" when absent). */
export function InspectPopup({ readout, region, onClose }: { readout: InspectReadout | null; region: string | null; onClose: () => void }) {
  const c = useColors();
  if (!readout) return null;
  const rows: Array<[string, string]> = [
    ['Depth', readout.depth],
    ['Source', readout.source],
    ['Survey / image date', `${readout.date}${readout.age === 'unknown' ? '' : ` (${readout.age})`}`],
    ['Vertical uncertainty', readout.uncertainty],
  ];
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
        <View style={[s.pad, s.gap, { backgroundColor: c.card }]}>
          {rows.map(([k, v]) => (
            <View key={k}>
              <Text style={[s.small, { color: c.sub }]}>{k}</Text>
              <Text style={[s.h2, { color: c.text }]}>{v}</Text>
            </View>
          ))}
          {readout.old ? <Text style={[s.body, { color: c.warn }]}>This data is more than 10 years old.</Text> : null}
          {region ? <Text style={[s.body, { color: c.text }]}>{region}</Text> : null}
          <Button label="Close" kind="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
