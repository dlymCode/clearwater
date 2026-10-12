/**
 * Group helpers (FLT-7): invite code shape and expiry. Codes are 8 symbols from the server alphabet
 * [A-HJ-NP-Z2-9] (no 0/O/1/I); they expire 7 days after creation (server-enforced).
 */
import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, MS_PER_DAY, MS_PER_HOUR } from '@clearwater/shared';

/** Uppercase and strip spaces/dashes the user may type or paste ("abcd-2345" -> "ABCD2345"). */
export function normalizeInviteCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export type CodeCheck = { ok: true; code: string } | { ok: false; error: string };

/** Validates with a message the user can act on (0/O/1/I are never in a code, so they are typos). */
export function checkInviteCode(input: string): CodeCheck {
  const code = normalizeInviteCode(input);
  if (code.length !== INVITE_CODE_LENGTH) return { ok: false, error: `Invite codes are ${INVITE_CODE_LENGTH} characters.` };
  const bad = [...code].filter((c) => !INVITE_CODE_ALPHABET.includes(c));
  if (bad.length > 0) {
    const ambiguous = bad.filter((c) => '01OI'.includes(c));
    return {
      ok: false,
      error: ambiguous.length
        ? `Codes never contain 0, 1, O or I. Check "${ambiguous[0]}" (letter O vs zero, letter I vs one).`
        : `"${bad[0]}" is not valid in an invite code.`,
    };
  }
  return { ok: true, code };
}

export function isValidInviteCode(input: string): boolean {
  return checkInviteCode(input).ok;
}

export function isInviteExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || nowMs >= t;
}

/** "Expires in 6 days" / "Expired". */
export function inviteStatusText(expiresAt: string | null | undefined, nowMs: number): string {
  if (isInviteExpired(expiresAt, nowMs)) return 'Expired';
  const left = Date.parse(expiresAt as string) - nowMs;
  const days = Math.floor(left / MS_PER_DAY);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(left / MS_PER_HOUR));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}
