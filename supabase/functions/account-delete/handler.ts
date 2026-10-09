import { authenticate } from "../_shared/auth.ts";
import { type Db, rpc } from "../_shared/db.ts";
import { errorResponse, HttpError, json } from "../_shared/http.ts";

export interface AccountDeleteDeps {
  db: Db;
}

/**
 * POST /account-delete  (App Store: in-app account deletion; PRD: within 24 h, logged)
 *
 * Runs immediately rather than queueing, which is comfortably inside the 24 h promise:
 *   1. public.delete_account_data(uid): profile, pings, votes, messages, memberships, positions,
 *      upload ledger; owned groups pass to the longest-standing member or are deleted; one
 *      audit_log row. Aggregated depth_cells are untouched (they cannot be attributed).
 *   2. auth.admin.deleteUser(uid): the account can no longer sign in.
 * Data first, auth second: if step 2 fails the user still holds a valid token and can retry, and
 * step 1 is idempotent. A user who is already gone from auth is treated as success.
 */
export async function handleAccountDelete(req: Request, deps: AccountDeleteDeps): Promise<Response> {
  try {
    if (req.method !== "POST" && req.method !== "DELETE") {
      throw new HttpError(405, "method_not_allowed", "Use POST.", { allow: "POST, DELETE" });
    }
    const user = await authenticate(req, deps.db);
    const removed = await rpc<Record<string, number>>(deps.db, "delete_account_data", { p_user: user.id });

    const { error } = await deps.db.auth.admin.deleteUser(user.id);
    if (error && !/not.?found/i.test(error.message) && error.status !== 404) {
      console.error("auth.admin.deleteUser failed", error.message);
      throw new HttpError(502, "auth_delete_failed", "Your data was removed; sign-in removal failed. Retry.");
    }
    return json(200, { deleted: true, removed });
  } catch (e) {
    return errorResponse(e);
  }
}
