import { useState } from 'react';
import { Modal, Text, TextInput, View } from 'react-native';
import { PING_TYPES, PING_TYPE_LABELS, PING_NOTE_MAX, type PingType } from '@clearwater/shared';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { buildPingPayload, canSubmitPing, validateNote, type PingDraft } from '../lib/pingModel';
import { uuidv4 } from '../lib/uuid';
import { saveLocalPing } from '../services/localWrites';
import { outbox } from '../services/syncService';
import { useAppStore } from '../state/store';

/**
 * Two taps: (1) pick a type, (2) confirm. The note is optional. The ping lands at the boat's position, or at
 * the dragged map point (`position` is controlled by the map: long-press / drag moves the pin). Queued
 * locally and shown immediately with a "pending sync" mark; works with no network (FLT-1).
 */
export function PingSheet({
  visible,
  position,
  tideFt,
  groupId,
  onClose,
}: {
  visible: boolean;
  position: { lat: number; lon: number } | null;
  tideFt: number | null;
  groupId: string | null;
  onClose: (sentId?: string) => void;
}) {
  const c = useColors();
  const [type, setType] = useState<PingType | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bump = useAppStore((st) => st.bumpData);

  const reset = () => { setType(null); setNote(''); setError(null); };

  async function confirm() {
    if (!position) return setError('No position yet.');
    const draft: PingDraft = { type, lat: position.lat, lon: position.lon, note, groupId };
    const ok = canSubmitPing(draft);
    if (!ok.ok) return setError(ok.error);
    const id = uuidv4();
    const payload = buildPingPayload(draft, { id, nowMs: Date.now(), tideFt });
    await outbox.enqueue('ping', payload, { id });
    await saveLocalPing(payload);
    bump();
    reset();
    onClose(id);
  }

  const noteCheck = validateNote(note);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { reset(); onClose(); }}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#0006' }}>
        <View style={[s.pad, s.gap, { backgroundColor: c.card }]}>
          <Text style={[s.h2, { color: c.text }]}>{type ? PING_TYPE_LABELS[type] : 'What did you find?'}</Text>
          {!type ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {PING_TYPES.map((t) => (
                <View key={t} style={{ width: '48%' }}>
                  <Button label={PING_TYPE_LABELS[t]} kind="secondary" onPress={() => setType(t)} />
                </View>
              ))}
            </View>
          ) : (
            <>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Optional note (one line)"
                placeholderTextColor={c.sub}
                maxLength={PING_NOTE_MAX}
                style={[s.input, { color: c.text, borderColor: c.border }]}
              />
              <Text style={[s.small, { color: c.sub }]}>{`${Array.from(note).length}/${PING_NOTE_MAX}. Long-press the map first to move the pin.`}</Text>
              {!noteCheck.ok ? <Text style={{ color: c.danger }}>{noteCheck.error}</Text> : null}
              <Button label="Drop ping" onPress={() => void confirm()} />
              <Button label="Back" kind="secondary" onPress={() => setType(null)} />
            </>
          )}
          {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
          <Button label="Cancel" kind="secondary" onPress={() => { reset(); onClose(); }} />
        </View>
      </View>
    </Modal>
  );
}
