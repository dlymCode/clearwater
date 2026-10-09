import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleAdmin } from "./handler.ts";
import { authed, dbError, mockDb, req } from "../_shared/testing.ts";

const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000a2";
const TARGET = "00000000-0000-0000-0000-0000000000a3";
const UPLOAD = "11111111-2222-4333-8444-555555555555";

function setup(over: Parameters<typeof mockDb>[0] = {}) {
  const db = mockDb({
    users: { admintok: ADMIN, usertok: USER },
    rpc: {
      admin_set_upload_held: () => null,
      admin_revoke_account: () => null,
      admin_rotate_salt: () => 3,
      admin_list_held: () => [{ id: UPLOAD }],
      admin_audit: () => null,
    },
    ...over,
  });
  return { db, call: (r: Request) => handleAdmin(r, { db, adminUids: ` ${ADMIN}, nonsense ` }) };
}
const act = (tok: string, body: unknown) => authed("POST", tok, body);

Deno.test("401 without a token", async () => {
  const { call } = setup();
  assertEquals((await call(req("POST", { action: "rotate_salt" }))).status, 401);
});

Deno.test("403 for a signed-in non-admin, and the attempt is audited", async () => {
  const { db, call } = setup();
  const res = await call(act("usertok", { action: "rotate_salt" }));
  assertEquals(res.status, 403);
  const audits = db.calls.filter((c) => c.fn === "admin_audit");
  assertEquals(audits.length, 1);
  assertEquals(audits[0].args.p_action, "admin.denied");
  assertEquals(audits[0].args.p_actor, USER);
  assertEquals(db.calls.some((c) => c.fn === "admin_rotate_salt"), false);
});

Deno.test("hold_upload / release_upload call the audited SQL function with the actor", async () => {
  const { db, call } = setup();
  assertEquals((await call(act("admintok", { action: "hold_upload", upload_id: UPLOAD }))).status, 200);
  assertEquals((await call(act("admintok", { action: "release_upload", upload_id: UPLOAD }))).status, 200);
  assertEquals(db.calls.map((c) => c.args.p_held), [true, false]);
  assertEquals(db.calls[0].args.p_actor, ADMIN);
  assertEquals(db.calls[0].args.p_upload, UPLOAD);
});

Deno.test("revoke_account: SQL revoke first, then a permanent auth ban", async () => {
  const { db, call } = setup();
  const res = await call(act("admintok", { action: "revoke_account", user_id: TARGET.toUpperCase(), reason: "spam" }));
  assertEquals(res.status, 200);
  assertEquals(db.calls[0].fn, "admin_revoke_account");
  assertEquals(db.calls[0].args, { p_actor: ADMIN, p_target: TARGET, p_reason: "spam" });
  assertEquals(db.banned, [{ id: TARGET, ban_duration: "876000h" }]);
});

Deno.test("revoke_account: refuses to revoke an administrator", async () => {
  const { db, call } = setup();
  assertEquals((await call(act("admintok", { action: "revoke_account", user_id: ADMIN }))).status, 400);
  assertEquals(db.banned.length, 0);
});

Deno.test("revoke_account: ban failure is reported (502) and audited, writes are already blocked", async () => {
  const { db, call } = setup({ banError: { message: "gotrue down" } });
  const res = await call(act("admintok", { action: "revoke_account", user_id: TARGET }));
  assertEquals(res.status, 502);
  assert(db.calls.some((c) => c.fn === "admin_audit" && c.args.p_action === "admin.revoke_account.ban_failed"));
  assert(db.calls.some((c) => c.fn === "admin_revoke_account"));
});

Deno.test("rotate_salt returns the new epoch", async () => {
  const { call } = setup();
  const res = await call(act("admintok", { action: "rotate_salt" }));
  assertEquals(await res.json(), { ok: true, action: "rotate_salt", epoch: 3 });
});

Deno.test("list_held", async () => {
  const { db, call } = setup();
  const res = await call(act("admintok", { action: "list_held", limit: 5 }));
  assertEquals((await res.json()).rows, [{ id: UPLOAD }]);
  assertEquals(db.calls[0].args, { p_actor: ADMIN, p_limit: 5 });
});

Deno.test("invalid requests are 400 and audited", async () => {
  const { db, call } = setup();
  assertEquals((await call(act("admintok", { action: "hold_upload", upload_id: "nope" }))).status, 400);
  assertEquals((await call(act("admintok", { action: "wipe_everything" }))).status, 400);
  assertEquals((await call(act("admintok", "[]"))).status, 400);
  const audits = db.calls.filter((c) => c.fn === "admin_audit");
  assertEquals(audits.length, 3);
  assert(audits.every((a) => a.args.p_action === "admin.invalid_request"));
});

Deno.test("SQL errors keep their HTTP status (unknown upload -> 404)", async () => {
  const { call } = setup({
    rpc: { admin_set_upload_held: () => dbError("PT404", "upload_not_found"), admin_audit: () => null },
  });
  assertEquals((await call(act("admintok", { action: "hold_upload", upload_id: UPLOAD }))).status, 404);
});

Deno.test("nobody is admin when ADMIN_UIDS is empty", async () => {
  const db = mockDb({ users: { admintok: ADMIN }, rpc: { admin_audit: () => null } });
  const res = await handleAdmin(act("admintok", { action: "rotate_salt" }), { db, adminUids: "" });
  assertEquals(res.status, 403);
});
