/** Profile capture (handle + optional vessel name). Constraints mirror public.profiles checks. */
export const HANDLE_RE = /^[A-Za-z0-9_.-]{3,24}$/;
export const VESSEL_MAX = 60;

export type Check<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateProfile(handle: string, vessel: string): Check<{ handle: string; vessel_name: string | null }> {
  const h = handle.trim();
  if (!HANDLE_RE.test(h)) return { ok: false, error: 'Handle: 3 to 24 letters, numbers, dot, dash or underscore.' };
  const v = vessel.trim();
  if (Array.from(v).length > VESSEL_MAX) return { ok: false, error: `Vessel name is limited to ${VESSEL_MAX} characters.` };
  return { ok: true, value: { handle: h, vessel_name: v.length ? v : null } };
}

/** Actions that need the profiles row (FK from pings / votes / messages / group_members). */
export function canWrite(state: { profileReady: boolean; accountRevoked: boolean }): { ok: true } | { ok: false; reason: string } {
  if (state.accountRevoked) return { ok: false, reason: 'This account has been blocked.' };
  if (!state.profileReady) return { ok: false, reason: 'Choose a handle first (Settings > Profile).' };
  return { ok: true };
}
