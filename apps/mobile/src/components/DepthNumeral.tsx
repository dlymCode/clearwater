import { Text, View } from 'react-native';
import { GPS_STALE_MS } from '@clearwater/shared';
import type { DepthReading } from '../state/store';
import { s, useColors } from './theme';

/** MAP-6: large depth-under-keel numeral; "no sounder" when the feed is absent or stale (> 5 s). */
export function DepthNumeral({ depth, nowMs, offsetsMissing }: { depth: DepthReading | null; nowMs: number; offsetsMissing: boolean }) {
  const c = useColors();
  const live = depth !== null && nowMs - depth.tMs <= GPS_STALE_MS;
  const value = live ? (depth.underKeelFt ?? depth.rawFt) : null;
  return (
    <View style={[s.card, { backgroundColor: c.card, borderColor: c.border, alignItems: 'center' }]}>
      <Text style={[s.small, { color: c.sub }]}>{offsetsMissing ? 'Depth (set offsets in Settings)' : 'Under keel (ft)'}</Text>
      {value === null ? (
        <Text style={{ fontSize: 40, fontWeight: '700', color: c.sub }}>no sounder</Text>
      ) : (
        <Text accessibilityLabel={`Depth under keel ${value.toFixed(1)} feet`} style={{ fontSize: 72, fontWeight: '800', color: c.text }}>
          {value.toFixed(1)}
        </Text>
      )}
      {live && depth.mllwDepthFt !== null ? (
        <Text style={[s.body, { color: c.sub }]}>{`${depth.mllwDepthFt.toFixed(1)} ft MLLW (chart)`}</Text>
      ) : live ? (
        <Text style={[s.small, { color: c.warn }]}>No tide data cached: MLLW depth unavailable</Text>
      ) : null}
    </View>
  );
}
