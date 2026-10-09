import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { Group } from '@clearwater/shared';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { inviteStatusText, isValidInviteCode } from '../lib/groups';
import { createGroup, joinGroup, leaveGroup, listMyGroups, rotateInviteCode } from '../services/groups';
import { getSupabase } from '../services/supabase';

/** FLT-7: create, invite by code (8 chars, 7 days), join, leave. Online-only operations; owner can rotate the code. */
export function GroupsScreen({ onOpen }: { onOpen: (g: Group) => void }) {
  const c = useColors();
  const [groups, setGroups] = useState<Group[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGroups(await listMyGroups());
      setMe((await getSupabase().auth.getUser()).data.user?.id ?? null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Offline: groups need a connection.');
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const run = (fn: () => Promise<unknown>) => () => void fn().then(refresh).catch((e: unknown) => setMsg(e instanceof Error ? e.message : String(e)));

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={[s.pad, s.gap]}>
      <Text style={[s.h1, { color: c.text }]}>Groups</Text>
      {msg ? <Text style={{ color: c.danger }}>{msg}</Text> : null}
      {groups.map((g) => (
        <View key={g.id} style={[s.card, s.gap, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[s.h2, { color: c.text }]}>{g.name}</Text>
          {g.owner_id === me && g.invite_code ? (
            <Text style={[s.body, { color: c.text }]}>{`Invite code ${g.invite_code}. ${inviteStatusText(g.invite_expires_at, Date.now())}`}</Text>
          ) : null}
          <Button label="Open channel" onPress={() => onOpen(g)} />
          {g.owner_id === me ? <Button label="New invite code" kind="secondary" onPress={run(() => rotateInviteCode(g.id))} /> : null}
          {me ? <Button label="Leave group" kind="danger" onPress={run(() => leaveGroup(g.id, me))} /> : null}
        </View>
      ))}
      <Text style={[s.h2, { color: c.text }]}>Create a group</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Group name" placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} />
      <Button label="Create" disabled={name.trim().length === 0} onPress={run(async () => { await createGroup(name); setName(''); })} />
      <Text style={[s.h2, { color: c.text }]}>Join with a code</Text>
      <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="8-character code" placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} />
      <Button label="Join" disabled={!isValidInviteCode(code)} onPress={run(async () => { await joinGroup(code); setCode(''); })} />
    </ScrollView>
  );
}
