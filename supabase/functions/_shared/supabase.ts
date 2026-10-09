import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { type Db, requireEnv } from "./db.ts";

/** Service-role client. The key never leaves the function runtime. */
export function serviceClient(): Db {
  const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // supabase-js is structurally compatible with Db for the calls we make; the cast keeps handlers
  // independent of its generic types.
  return client as unknown as Db;
}
