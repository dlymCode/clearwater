import { requireEnv } from "../_shared/db.ts";
import { errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { handleDepthUpload } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    return await handleDepthUpload(req, {
      db: serviceClient(),
      secret: requireEnv("HMAC_SALT_SECRET"),
      now: () => new Date(),
    });
  } catch (e) {
    return errorResponse(e);
  }
});
