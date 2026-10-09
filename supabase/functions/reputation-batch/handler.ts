import { type Db, rpc } from "../_shared/db.ts";
import { bearerToken, errorResponse, HttpError, json, timingSafeEqual } from "../_shared/http.ts";

export interface ReputationBatchDeps {
  db: Db;
  /** SUPABASE_SERVICE_ROLE_KEY: the only credential allowed to run the batch (pg_cron passes it). */
  serviceRoleKey: string;
}

/**
 * Weekly cron target. All the arithmetic lives in SQL (public.run_reputation_batch, covered by
 * pgTAP): +0.05 per ping with >= 2 confirms, -0.10 per ping with >= 2 disputes, clamp [0.2, 3.0],
 * audit_log rows per changed account. This wrapper only authenticates the caller and relays the
 * summary.
 */
export async function handleReputationBatch(req: Request, deps: ReputationBatchDeps): Promise<Response> {
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.", { allow: "POST" });
    const token = bearerToken(req);
    if (!token || !deps.serviceRoleKey || !timingSafeEqual(token, deps.serviceRoleKey)) {
      throw new HttpError(401, "unauthenticated", "This endpoint is for the scheduler only.");
    }
    const summary = await rpc<Record<string, unknown>>(deps.db, "run_reputation_batch", {});
    return json(200, summary);
  } catch (e) {
    return errorResponse(e);
  }
}
