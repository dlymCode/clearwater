import { isUuid } from "./http.ts";

/**
 * ADMIN_UIDS is a comma/space separated list of auth user ids (the "hard-coded admin uid list" of
 * the PRD, kept in an env var so it is never in the app bundle). Malformed entries are dropped; an
 * empty result means nobody is an admin.
 */
export function parseAdminUids(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,;]+/)) {
    const v = part.trim().toLowerCase();
    if (isUuid(v)) out.add(v);
  }
  return out;
}
