/**
 * The profiles row. Nothing else works without it: pings, votes, messages and group membership all reference
 * profiles(id) by foreign key, so the first write of a new account would fail. The app captures a handle (and an
 * optional vessel name) once after sign-in and upserts the user's own row (RLS profiles_insert_own); the pings / vote /
 * join UI stays blocked until `profileReady` is true.
 */
import { validateProfile } from '../lib/profile';
import { useAppStore } from '../state/store';
import { getSupabase } from './supabase';

/** Does the signed-in user already have a profiles row? */
export async function loadProfileState(): Promise<boolean> {
  const sb = getSupabase();
  const { data: s } = await sb.auth.getSession();
  const uid = s.session?.user.id;
  if (!uid) return false;
  const { data, error } = await sb.from('profiles').select('id').eq('id', uid).maybeSingle();
  const ready = !error && !!data;
  useAppStore.getState().setProfileReady(ready);
  return ready;
}

export async function saveProfile(handle: string, vessel: string): Promise<string | null> {
  const v = validateProfile(handle, vessel);
  if (!v.ok) return v.error;
  const sb = getSupabase();
  const { data: s } = await sb.auth.getSession();
  const uid = s.session?.user.id;
  if (!uid) return 'Sign in first.';
  // Minimal response: only (id, handle, vessel_name) are insertable columns.
  const { error } = await sb.from('profiles').upsert({ id: uid, ...v.value }, { onConflict: 'id' });
  if (error) {
    return /duplicate|unique|23505/i.test(error.message) ? 'That handle is taken. Pick another.' : error.message;
  }
  useAppStore.getState().setProfileReady(true);
  return null;
}
