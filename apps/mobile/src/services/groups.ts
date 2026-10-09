/** Group operations (FLT-7). Create/join/leave are online-only calls; messages go through the outbox. */
import type { Group, Message } from '@clearwater/shared';
import { normalizeInviteCode } from '../lib/groups';
import { getDb } from './db';
import { getSupabase } from './supabase';

export async function listMyGroups(): Promise<Group[]> {
  const { data, error } = await getSupabase().from('groups').select('*').order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as Group[];
}

export async function createGroup(name: string): Promise<Group> {
  const { data, error } = await getSupabase().from('groups').insert({ name: name.trim() }).select('*').single();
  if (error) throw new Error(error.message);
  return data as Group;
}

/** `join_group(p_code)` RPC: validates the code and its 7-day expiry server-side. */
export async function joinGroup(code: string): Promise<void> {
  const { error } = await getSupabase().rpc('join_group', { p_code: normalizeInviteCode(code) });
  if (error) throw new Error(error.message);
}

export async function leaveGroup(groupId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().from('group_members').delete().eq('group_id', groupId).eq('user_id', userId);
  if (error) throw new Error(error.message);
}

export async function rotateInviteCode(groupId: string): Promise<void> {
  const { error } = await getSupabase().rpc('rotate_invite_code', { p_group: groupId });
  if (error) throw new Error(error.message);
}

export async function removeMember(groupId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().from('group_members').delete().eq('group_id', groupId).eq('user_id', userId);
  if (error) throw new Error(error.message);
}

export async function localMessages(groupId: string): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM messages WHERE group_id = ? ORDER BY created_at ASC LIMIT 500', groupId);
  return rows.map((r) => JSON.parse(r.json) as Message);
}

export async function localPingLabelById(pingId: string): Promise<{ type: string; created_at: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ json: string }>('SELECT json FROM pings WHERE id = ?', pingId);
  if (!row) return null;
  const p = JSON.parse(row.json) as { type: string; created_at: string };
  return { type: p.type, created_at: p.created_at };
}
