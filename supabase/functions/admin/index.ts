import { errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { handleAdmin } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    return await handleAdmin(req, { db: serviceClient(), adminUids: Deno.env.get("ADMIN_UIDS") ?? "" });
  } catch (e) {
    return errorResponse(e);
  }
});
