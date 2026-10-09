import { assertEquals } from "jsr:@std/assert@1";
import { handleReputationBatch } from "./handler.ts";
import { authed, mockDb, req } from "../_shared/testing.ts";

const KEY = "unit-test-service-role-placeholder";
const summary = { skipped: false, pings_evaluated: 9, authors_changed: 4 };

Deno.test("runs the SQL batch for the scheduler (service-role bearer) and relays the summary", async () => {
  const db = mockDb({ rpc: { run_reputation_batch: () => summary } });
  const res = await handleReputationBatch(authed("POST", KEY), { db, serviceRoleKey: KEY });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), summary);
  assertEquals(db.calls.map((c) => c.fn), ["run_reputation_batch"]);
});

Deno.test("rejects missing, wrong, and user tokens without touching the database", async () => {
  const db = mockDb({ users: { usertoken: "u1" }, rpc: { run_reputation_batch: () => summary } });
  for (const r of [req("POST"), authed("POST", "usertoken"), authed("POST", KEY + "x"), authed("POST", "")]) {
    const res = await handleReputationBatch(r, { db, serviceRoleKey: KEY });
    assertEquals(res.status, 401);
  }
  assertEquals(db.calls.length, 0);
});

Deno.test("an unset service key never authenticates anyone", async () => {
  const db = mockDb();
  assertEquals((await handleReputationBatch(authed("POST", ""), { db, serviceRoleKey: "" })).status, 401);
});

Deno.test("POST only", async () => {
  assertEquals((await handleReputationBatch(authed("GET", KEY), { db: mockDb(), serviceRoleKey: KEY })).status, 405);
});
