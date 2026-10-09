import { assertEquals } from "jsr:@std/assert@1";
import { handleAccountDelete } from "./handler.ts";
import { authed, dbError, mockDb, req } from "../_shared/testing.ts";

const UID = "00000000-0000-0000-0000-0000000000a3";
const removed = { pings: 2, messages: 1, votes: 3 };

Deno.test("deletes data first, then the auth user, and reports what was removed", async () => {
  const db = mockDb({ users: { tok: UID }, rpc: { delete_account_data: () => removed } });
  const res = await handleAccountDelete(authed("POST", "tok"), { db });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, removed });
  assertEquals(db.calls, [{ fn: "delete_account_data", args: { p_user: UID } }]);
  assertEquals(db.deletedUsers, [UID]);
});

Deno.test("a user can only delete themself: the uid comes from the token, never the body", async () => {
  const db = mockDb({ users: { tok: UID }, rpc: { delete_account_data: () => removed } });
  await handleAccountDelete(authed("POST", "tok", { user_id: "00000000-0000-0000-0000-0000000000a9" }), { db });
  assertEquals(db.calls[0].args, { p_user: UID });
  assertEquals(db.deletedUsers, [UID]);
});

Deno.test("401 without a valid user token, and nothing is deleted", async () => {
  const db = mockDb({ users: { tok: UID } });
  assertEquals((await handleAccountDelete(req("POST"), { db })).status, 401);
  assertEquals((await handleAccountDelete(authed("POST", "nope"), { db })).status, 401);
  assertEquals(db.calls.length, 0);
  assertEquals(db.deletedUsers.length, 0);
});

Deno.test("retry-safe: an auth user that is already gone counts as success", async () => {
  const db = mockDb({
    users: { tok: UID },
    rpc: { delete_account_data: () => removed },
    deleteUserError: { message: "User not found", status: 404 },
  });
  assertEquals((await handleAccountDelete(authed("POST", "tok"), { db })).status, 200);
});

Deno.test("502 (retryable) when removing the auth user fails after the data is gone", async () => {
  const db = mockDb({
    users: { tok: UID },
    rpc: { delete_account_data: () => removed },
    deleteUserError: { message: "upstream exploded", status: 500 },
  });
  assertEquals((await handleAccountDelete(authed("POST", "tok"), { db })).status, 502);
});

Deno.test("if the data deletion fails the auth user is left alone so the user can retry", async () => {
  const db = mockDb({ users: { tok: UID }, rpc: { delete_account_data: () => dbError("XX000", "disk full") } });
  assertEquals((await handleAccountDelete(authed("POST", "tok"), { db })).status, 500);
  assertEquals(db.deletedUsers.length, 0);
});

Deno.test("405 for GET", async () => {
  assertEquals((await handleAccountDelete(authed("GET", "tok"), { db: mockDb({ users: { tok: UID } }) })).status, 405);
});

Deno.test("S1: a revoked account is refused (403) and nothing is deleted", async () => {
  const db = mockDb({ users: { tok: UID }, rpc: { delete_account_data: () => dbError("PT403", "account_revoked") } });
  const res = await handleAccountDelete(authed("POST", "tok"), { db });
  assertEquals(res.status, 403);
  assertEquals(db.deletedUsers.length, 0);
});
