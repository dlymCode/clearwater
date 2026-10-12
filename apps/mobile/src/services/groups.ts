/**
 * Group operations (FLT-7). Create/join/leave are online-only calls; messages go through the outbox.
 *
 * Column grants matter: `groups` is readable only on (id, name, owner_id, invite_expires_at, created_at). The invite
 * code is NOT selectable, so there is no select('*') anywhere here: owners read the code with the get_invite_code RPC,
 * and rotate_invite_code returns the new one.
 */
import type { Group, Message } from '@clearwater/shared';
import { checkInviteCode } from '../lib/groups';
import { uuidv4 } from '../lib/uuid';
import { getDb } from './db';
import { getSupabase } from './supabase';

export const GROUP_COLUMNS = 'id,name,owner_id,invite_expires_at,created_at';

export interface InviteCode {
  code: string;
  expiresAt: string | null;
}

async function currentUserId(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const id = data.session?.user.id;
  if (!id) throw new Error('Sign in first.');
  return id;
}

export async function listMyGroups(): Promise<Group[]> {
  const { data, error } = await getSupabase().from('groups').select(GROUP_COLUMNS).order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as Group[];
}

/** Owner only. `get_invite_code` returns a one-row table. */
export async function getInviteCode(groupId: string): Promise<InviteCode | null> {
  const { data, error } = await getSupabase().rpc('get_invite_code', { p_group: groupId });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { invite_code?: string; invite_expires_at?: string } | undefined;
  return row?.invite_code ? { code: row.invite_code, expiresAt: row.invite_expires_at ?? null } : null;
}

/** owner_id is NOT NULL with no default, so it comes from the session; the id is client-generated. */
export async function createGroup(name: string): Promise<Group> {
  const owner_id = await currentUserId();
  const { data, error } = await getSupabase()
    .from('groups')
    .insert({ id: uuidv4(), name: name.trim(), owner_id })
    .select(GROUP_COLUMNS) // explicit selectable columns only: RETURNING * would hit the invite_code column grant
    .single();
  if (error) throw new Error(error.message);
  return data as Group;
}

/**
 * `join_group(p_code)` returns the group id, or NULL for an unknown / expired / rotated-out code (it does not raise,
 * so the server-side attempt throttle keeps counting). Null therefore means "that code does not work".
 */
export async function joinGroup(code: string): Promise<string> {
  const checked = checkInviteCode(code);
  if (!checked.ok) throw new Error(checked.error);
  const { data, error } = await getSupabase().rpc('join_group', { p_code: checked.code });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('That invite code is not valid or has expired. Ask the group owner for a new one.');
  return data as string;
}

export async function leaveGroup(groupId: string, userId: string): Promise<void> {
  const { error } = await getSupabase().from('group_members').delete().eq('group_id', groupId).eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** Returns the NEW code so the screen can show it immediately. */
export async function rotateInviteCode(groupId: string): Promise<InviteCode> {
  const { data, error } = await getSupabase().rpc('rotate_invite_code', { p_group: groupId });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { invite_code?: string; invite_expires_at?: string } | undefined;
  if (!row?.invite_code) throw new Error('No invite code returned.');
  return { code: row.invite_code, expiresAt: row.invite_expires_at ?? null };
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
