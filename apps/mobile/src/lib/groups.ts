/** Group helpers (FLT-7): invite code shape and expiry. Codes are 8 chars; expire 7 days after creation. */
import { INVITE_CODE_LENGTH, INVITE_TTL_DAYS } from '@clearwater/shared';

const CODE_RE = new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`);

/** Uppercase and strip spaces/dashes the user may type or paste ("abcd-1234" -> "ABCD1234"). */
export function normalizeInviteCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidInviteCode(input: string): boolean {
  return CODE_RE.test(normalizeInviteCode(input));
}

export function isInviteExpired(expiresAt: string | null | undefined, nowMs: number): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || nowMs >= t;
}

export function inviteExpiryFrom(createdMs: number): string {
  return new Date(createdMs + INVITE_TTL_DAYS * 86_400_000).toISOString();
}

/** "Expires in 6 days" / "Expired". */
export function inviteStatusText(expiresAt: string | null | undefined, nowMs: number): string {
  if (isInviteExpired(expiresAt, nowMs)) return 'Expired';
  const left = Date.parse(expiresAt as string) - nowMs;
  const days = Math.floor(left / 86_400_000);
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.floor(left / 3_600_000));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}
