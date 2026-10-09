import { errorResponse } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { handleAccountDelete } from "./handler.ts";

Deno.serve(async (req) => {
  try {
    return await handleAccountDelete(req, { db: serviceClient() });
  } catch (e) {
    return errorResponse(e);
  }
});
