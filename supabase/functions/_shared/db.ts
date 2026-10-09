// Minimal structural types over supabase-js so handlers can be unit-tested with plain objects.
// (The real client is built in supabase.ts, which is the only file that imports supabase-js.)
import { HttpError } from "./http.ts";

export interface DbError {
  message: string;
  code?: string;
  hint?: string | null;
  details?: string | null;
}

export interface RpcResult {
  data: unknown;
  error: DbError | null;
}

export interface AuthUser {
  id: string;
}

export interface Db {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
  auth: {
    getUser(jwt: string): Promise<{ data: { user: AuthUser | null }; error: unknown }>;
    admin: {
      deleteUser(id: string): Promise<{ error: { message: string; status?: number } | null }>;
      updateUserById(
        id: string,
        attrs: { ban_duration?: string },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
}

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`missing required env var ${name}`);
    throw new HttpError(500, "misconfigured", "Server is not configured.");
  }
  return v;
}

/**
 * PostgREST maps a SQLSTATE of the form PTnnn to HTTP status nnn. Our SQL raises PT400/401/403/
 * 404/409/429 deliberately; translate them back into HttpErrors. Anything else is a 500.
 */
export function dbErrorToHttp(err: DbError): HttpError {
  const m = /^PT(\d{3})$/.exec(err.code ?? "");
  if (m) {
    const status = Number(m[1]);
    const headers: Record<string, string> = {};
    if (status === 429 && err.hint && /^\d+$/.test(err.hint)) headers["retry-after"] = err.hint;
    return new HttpError(status, err.message.split(":")[0] || "request_failed", err.message, headers);
  }
  console.error("database error", err.code, err.message);
  return new HttpError(500, "internal_error", "Something went wrong.");
}

export async function rpc<T = unknown>(db: Db, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw dbErrorToHttp(error);
  return data as T;
}
