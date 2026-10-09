import { Text, View } from 'react-native';
import { s, useColors } from './theme';

export function Banner({ level, text }: { level: 'yellow' | 'red' | 'info'; text: string }) {
  const c = useColors();
  const bg = level === 'red' ? c.danger : level === 'yellow' ? c.warn : c.accent;
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: bg, padding: 10, borderRadius: 8 }}>
      <Text style={[s.small, { color: '#fff', fontWeight: '600' }]}>{text}</Text>
    </View>
  );
}

/** Persistent line on the map (PRD Legal: "not for navigation" on first launch AND on the map). */
export function NotForNavigationLine() {
  const c = useColors();
  return <Text style={[s.small, { color: c.sub, textAlign: 'center' }]}>Not for navigation. Depths are modeled and crowdsourced.</Text>;
}
