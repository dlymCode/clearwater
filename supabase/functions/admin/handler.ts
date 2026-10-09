import { parseAdminUids } from "../_shared/admin.ts";
import { authenticate } from "../_shared/auth.ts";
import { type Db, rpc } from "../_shared/db.ts";
import { errorResponse, HttpError, isUuid, json, readJsonLimited } from "../_shared/http.ts";

export interface AdminDeps {
  db: Db;
  /** Raw ADMIN_UIDS env value. */
  adminUids: string;
}

const BAN_FOREVER = "876000h"; // ~100 years; GoTrue has no "permanent" value.

/**
 * POST /admin   { "action": "...", ... }
 *
 *   hold_upload     { upload_id }            exclude an upload from depth_cells (never auto-released)
 *   release_upload  { upload_id }            put it back
 *   revoke_account  { user_id, reason? }     block writes, hide public pings, ban sign-in
 *   rotate_salt                              bump the HMAC salt epoch (hashes change from now on)
 *   list_held                                held uploads awaiting review
 *
 * Callers must be in ADMIN_UIDS. Every action - including denied and invalid attempts - ends up in
 * audit_log (the SQL functions write their own rows in the same transaction as the change).
 */
export async function handleAdmin(req: Request, deps: AdminDeps): Promise<Response> {
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.", { allow: "POST" });
    const user = await authenticate(req, deps.db);

    const admins = parseAdminUids(deps.adminUids);
    if (!admins.has(user.id)) {
      await audit(deps.db, user.id, "admin.denied", { path: "admin" });
      throw new HttpError(403, "forbidden", "Not an administrator.");
    }

    try {
      return await dispatch(req, deps, user.id, admins);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) {
        await audit(deps.db, user.id, "admin.invalid_request", { code: e.code });
      }
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}

async function dispatch(req: Request, deps: AdminDeps, actor: string, admins: Set<string>): Promise<Response> {
  const body = await readJsonLimited(req, 10_000);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  switch (b.action) {
    case "hold_upload":
    case "release_upload": {
      if (!isUuid(b.upload_id)) throw new HttpError(400, "invalid_upload_id", "upload_id must be a UUID.");
      await rpc(deps.db, "admin_set_upload_held", {
        p_actor: actor,
        p_upload: b.upload_id,
        p_held: b.action === "hold_upload",
      });
      return json(200, { ok: true, action: b.action, upload_id: b.upload_id });
    }
    case "revoke_account": {
      if (!isUuid(b.user_id)) throw new HttpError(400, "invalid_user_id", "user_id must be a UUID.");
      const target = b.user_id.toLowerCase();
      if (admins.has(target)) throw new HttpError(400, "cannot_revoke_admin", "Remove the uid from ADMIN_UIDS first.");
      const reason = typeof b.reason === "string" ? b.reason.slice(0, 500) : null;
      await rpc(deps.db, "admin_revoke_account", { p_actor: actor, p_target: target, p_reason: reason });
      const { error } = await deps.db.auth.admin.updateUserById(target, { ban_duration: BAN_FOREVER });
      if (error) {
        await audit(deps.db, actor, "admin.revoke_account.ban_failed", { target, message: error.message });
        throw new HttpError(502, "ban_failed", "Writes are blocked, but the sign-in ban failed. Retry.");
      }
      return json(200, { ok: true, action: "revoke_account", user_id: target });
    }
    case "rotate_salt": {
      const epoch = await rpc<number>(deps.db, "admin_rotate_salt", { p_actor: actor });
      return json(200, { ok: true, action: "rotate_salt", epoch });
    }
    case "list_held": {
      const limit = typeof b.limit === "number" && Number.isInteger(b.limit) ? b.limit : 100;
      const rows = await rpc<unknown[]>(deps.db, "admin_list_held", { p_actor: actor, p_limit: limit });
      return json(200, { ok: true, action: "list_held", rows });
    }
    default:
      throw new HttpError(400, "unknown_action", "Unknown action.");
  }
}

async function audit(db: Db, actor: string, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await rpc(db, "admin_audit", { p_actor: actor, p_action: action, p_details: details });
  } catch (e) {
    console.error("audit write failed", e instanceof Error ? e.message : String(e));
  }
}
