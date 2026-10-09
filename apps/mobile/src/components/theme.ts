import { StyleSheet, useColorScheme } from 'react-native';

/** Helm-friendly: big type, 56 pt minimum tap targets (gloves), high contrast. No pixel-perfect styling yet. */
export const TAP = 56;

export const palette = {
  light: { bg: '#f4f6f7', card: '#ffffff', text: '#0b1620', sub: '#4a5a66', accent: '#0a5fb4', danger: '#c0172b', warn: '#b7791f', border: '#d3dbe0' },
  dark: { bg: '#0b1620', card: '#14232f', text: '#f2f6f8', sub: '#9db0bd', accent: '#5aa9f0', danger: '#ff6b7a', warn: '#f0b429', border: '#27394a' },
} as const;

export function useColors() {
  return useColorScheme() === 'dark' ? palette.dark : palette.light;
}

export const s = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  pad: { padding: 16 },
  gap: { gap: 12 },
  h1: { fontSize: 28, fontWeight: '700' },
  h2: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 16 },
  small: { fontSize: 13 },
  btn: { minHeight: TAP, minWidth: TAP, borderRadius: 10, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 18, fontWeight: '600' },
  input: { minHeight: TAP, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 18 },
  card: { borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth },
});
