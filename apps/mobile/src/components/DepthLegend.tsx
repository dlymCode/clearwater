import { Text, View } from 'react-native';
import { depthLegend } from '../lib/mapStyle';
import { s, useColors } from './theme';

/** MAP-2: the legend is ALWAYS visible (no toggle, no collapse). Stops come from the fixed ramp 0,3,6,10,20,40 ft. */
export function DepthLegend() {
  const c = useColors();
  return (
    <View accessibilityLabel="Depth legend, feet below MLLW" style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[s.small, { color: c.sub }]}>Depth (ft, MLLW)</Text>
      {depthLegend().map((stop) => (
        <View key={stop.label} style={s.row}>
          <View style={{ width: 18, height: 12, backgroundColor: stop.color, marginRight: 8, borderRadius: 2 }} />
          <Text style={[s.small, { color: c.text }]}>{stop.label}</Text>
        </View>
      ))}
    </View>
  );
}
