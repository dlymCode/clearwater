import { Pressable, Text } from 'react-native';
import { s, useColors } from './theme';

export function Button({
  label,
  onPress,
  kind = 'primary',
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  const c = useColors();
  const bg = kind === 'primary' ? c.accent : kind === 'danger' ? c.danger : c.card;
  const fg = kind === 'secondary' ? c.text : '#fff';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[s.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1, borderWidth: kind === 'secondary' ? 1 : 0, borderColor: c.border }]}
    >
      <Text style={[s.btnText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}
