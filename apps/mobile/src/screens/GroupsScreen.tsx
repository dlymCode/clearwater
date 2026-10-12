import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { INVITE_CODE_LENGTH, type Group } from '@clearwater/shared';
import { Button } from '../components/Button';
import { s, useColors } from '../components/theme';
import { checkInviteCode, inviteStatusText } from '../lib/groups';
import { canWrite } from '../lib/profile';
import { createGroup, getInviteCode, joinGroup, leaveGroup, listMyGroups, rotateInviteCode } from '../services/groups';
import { useAppStore } from '../state/store';
import { getSupabase } from '../services/supabase';

// TODO(item 19, not implemented): remove-member UI for owners (services/groups.removeMember exists) and group-tier ping
// creation from the map.
/** FLT-7: create, invite by code (8 chars, 7 days), join, leave. Online-only operations; owner can rotate the code. */
export function GroupsScreen({ onOpen }: { onOpen: (g: Group) => void }) {
  const c = useColors();
  const [groups, setGroups] = useState<Group[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  // Owners read the invite code through get_invite_code (it is not a selectable column); rotation returns the new one.
  const [codes, setCodes] = useState<Record<string, { code: string; expiresAt: string | null }>>({});
  const profileReady = useAppStore((st) => st.profileReady);
  const accountRevoked = useAppStore((st) => st.accountRevoked);
  const gate = canWrite({ profileReady, accountRevoked });

  const refresh = useCallback(async () => {
    try {
      const list = await listMyGroups();
      setGroups(list);
      const uid = (await getSupabase().auth.getSession()).data.session?.user.id ?? null;
      setMe(uid);
      const next: Record<string, { code: string; expiresAt: string | null }> = {};
      for (const g of list) {
        if (g.owner_id === uid) {
          const c = await getInviteCode(g.id).catch(() => null);
          if (c) next[g.id] = c;
        }
      }
      setCodes(next);
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
          {g.owner_id === me && codes[g.id] ? (
            <Text style={[s.body, { color: c.text }]}>{`Invite code ${codes[g.id]!.code}. ${inviteStatusText(codes[g.id]!.expiresAt, Date.now())}`}</Text>
          ) : null}
          <Button label="Open channel" onPress={() => onOpen(g)} />
          {g.owner_id === me ? <Button label="New invite code" kind="secondary" onPress={run(async () => { const n = await rotateInviteCode(g.id); setCodes((p) => ({ ...p, [g.id]: n })); })} /> : null}
          {me ? <Button label="Leave group" kind="danger" onPress={run(() => leaveGroup(g.id, me))} /> : null}
        </View>
      ))}
      <Text style={[s.h2, { color: c.text }]}>Create a group</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Group name" placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} />
      {!gate.ok ? <Text style={{ color: c.warn }}>{gate.reason}</Text> : null}
      <Button label="Create" disabled={!gate.ok || name.trim().length === 0} onPress={run(async () => { await createGroup(name); setName(''); })} />
      <Text style={[s.h2, { color: c.text }]}>Join with a code</Text>
      <TextInput value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder={`${INVITE_CODE_LENGTH}-character code`} placeholderTextColor={c.sub} style={[s.input, { color: c.text, borderColor: c.border }]} />
      {code.length > 0 && !checkInviteCode(code).ok ? <Text style={{ color: c.warn }}>{(checkInviteCode(code) as { error: string }).error}</Text> : null}
      <Button label="Join" disabled={!gate.ok || !checkInviteCode(code).ok} onPress={run(async () => { await joinGroup(code); setCode(''); })} />
    </ScrollView>
  );
}
