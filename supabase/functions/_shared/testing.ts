// Test doubles for the edge-function unit tests (Deno). Not imported by production code.
import { type Db, type DbError, type RpcResult } from "./db.ts";

export type RpcHandler = (args: Record<string, unknown>) => unknown | { __error: DbError };

export interface MockDb extends Db {
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  deletedUsers: string[];
  banned: Array<{ id: string; ban_duration?: string }>;
}

export function dbError(code: string, message: string, hint: string | null = null): { __error: DbError } {
  return { __error: { code, message, hint } };
}

export interface MockOptions {
  /** token -> user id; any other token is rejected */
  users?: Record<string, string>;
  rpc?: Record<string, RpcHandler>;
  deleteUserError?: { message: string; status?: number } | null;
  banError?: { message: string } | null;
}

export function mockDb(opts: MockOptions = {}): MockDb {
  const calls: MockDb["calls"] = [];
  const deletedUsers: string[] = [];
  const banned: MockDb["banned"] = [];
  return {
    calls,
    deletedUsers,
    banned,
    rpc(fn: string, args: Record<string, unknown> = {}): PromiseLike<RpcResult> {
      calls.push({ fn, args });
      const h = opts.rpc?.[fn];
      if (!h) return Promise.resolve({ data: null, error: null });
      const out = h(args);
      if (out && typeof out === "object" && "__error" in out) {
        return Promise.resolve({ data: null, error: (out as { __error: DbError }).__error });
      }
      return Promise.resolve({ data: out, error: null });
    },
    auth: {
      getUser(jwt: string) {
        const id = opts.users?.[jwt];
        return Promise.resolve(
          id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: new Error("bad jwt") },
        );
      },
      admin: {
        deleteUser(id: string) {
          deletedUsers.push(id);
          return Promise.resolve({ error: opts.deleteUserError ?? null });
        },
        updateUserById(id: string, attrs: { ban_duration?: string }) {
          banned.push({ id, ...attrs });
          return Promise.resolve({ error: opts.banError ?? null });
        },
      },
    },
  };
}

export function req(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/fn", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function authed(method: string, token: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return req(method, body, { authorization: `Bearer ${token}`, ...headers });
}
