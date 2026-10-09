import { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { PING_TYPE_LABELS, isPingType, type Group, type Message } from '@clearwater/shared';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { buildMessagePayload, validateMessageBody } from '../lib/pingModel';
import { uuidv4 } from '../lib/uuid';
import { localMessages, localPingLabelById } from '../services/groups';
import { saveLocalMessage } from '../services/localWrites';
import { outbox } from '../services/syncService';
import { useAppStore } from '../state/store';
import { MESSAGE_BODY_MAX } from '@clearwater/shared';

/**
 * Group channel: text + ping references. Messages are queued in the outbox (works offline) and shown with a
 * "pending" mark until synced. Realtime is additive; cursor sync fills the local table.
 */
export function ChannelScreen({ group, attachPingId, onBack }: { group: Group; attachPingId?: string | null; onBack: () => void }) {
  const c = useColors();
  const rev = useAppStore((st) => st.dataRev);
  const bump = useAppStore((st) => st.bumpData);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await localMessages(group.id);
    setMessages(list);
    setPending(await outbox.pendingIds('message'));
    const next: Record<string, string> = {};
    for (const m of list) {
      if (m.ping_id && !next[m.ping_id]) {
        const p = await localPingLabelById(m.ping_id);
        next[m.ping_id] = p && isPingType(p.type) ? PING_TYPE_LABELS[p.type] : 'ping';
      }
    }
    setLabels(next);
  }, [group.id]);
  useEffect(() => void load(), [load, rev]);

  async function send() {
    const v = validateMessageBody(text);
    if (!v.ok) return setError(v.error);
    const id = uuidv4();
    const payload = buildMessagePayload(group.id, text, { id, nowMs: Date.now(), pingId: attachPingId ?? null });
    await outbox.enqueue('message', payload, { id });
    await saveLocalMessage(payload);
    setText('');
    setError(null);
    bump();
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[s.row, s.pad]}>
        <Button label="Back" kind="secondary" onPress={onBack} />
        <Text style={[s.h2, { color: c.text, marginLeft: 12 }]}>{group.name}</Text>
      </View>
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[s.pad, s.gap]}
        renderItem={({ item }) => (
          <View style={[s.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[s.small, { color: c.sub }]}>{`${item.author_handle ?? 'member'} · ${new Date(item.created_at).toLocaleString()}${pending.has(item.id) ? ' · pending sync' : ''}`}</Text>
            {item.ping_id ? <Text style={[s.body, { color: c.accent }]}>{`Ping: ${labels[item.ping_id] ?? 'ping'}`}</Text> : null}
            <Text style={[s.body, { color: c.text }]}>{item.body}</Text>
          </View>
        )}
      />
      <View style={[s.pad, s.gap]}>
        {attachPingId ? <Text style={[s.small, { color: c.accent }]}>A ping will be attached to your next message.</Text> : null}
        <TextInput value={text} onChangeText={setText} maxLength={MESSAGE_BODY_MAX} placeholder="Message" placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} />
        {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
        <Button label="Send" onPress={() => void send()} />
      </View>
    </View>
  );
}
