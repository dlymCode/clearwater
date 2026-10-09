import { Modal, Text, View } from 'react-native';
import { PING_TYPE_LABELS } from '@clearwater/shared';
import { Button } from './Button';
import { s, useColors } from './theme';
import type { ScoredPing } from '../lib/pingModel';

/** FLT-2: confirm or dispute in one tap. Eligibility (within 500 m in the last 24 h) is enforced server-side by cast_vote. */
export function PingDetail({
  scored,
  onVote,
  onClose,
}: {
  scored: ScoredPing | null;
  onVote: (pingId: string, vote: 1 | -1) => void;
  onClose: () => void;
}) {
  const c = useColors();
  if (!scored) return null;
  const { ping, summary, pendingSync } = scored;
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
        <View style={[s.pad, s.gap, { backgroundColor: c.card }]}>
          <Text style={[s.h2, { color: c.text }]}>{PING_TYPE_LABELS[ping.type]}</Text>
          <Text style={[s.body, { color: c.sub }]}>{`${new Date(ping.created_at).toLocaleString()}${pendingSync ? ' · pending sync' : ''}`}</Text>
          {ping.note ? <Text style={[s.body, { color: c.text }]}>{ping.note}</Text> : null}
          <Text style={[s.body, { color: c.text }]}>{`${summary.confirms} confirmed, ${summary.disputes} disputed · ${summary.state}`}</Text>
          {!pendingSync ? (
            <View style={s.row}>
              <View style={{ flex: 1, marginRight: 8 }}><Button label="Confirm" onPress={() => onVote(ping.id, 1)} /></View>
              <View style={{ flex: 1 }}><Button label="Dispute" kind="danger" onPress={() => onVote(ping.id, -1)} /></View>
            </View>
          ) : null}
          <Button label="Close" kind="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
