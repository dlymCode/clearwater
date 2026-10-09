import { requireEnv } from "../_shared/db.ts";
import { errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { handleReputationBatch } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    return await handleReputationBatch(req, {
      db: serviceClient(),
      serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    });
  } catch (e) {
    return errorResponse(e);
  }
});
