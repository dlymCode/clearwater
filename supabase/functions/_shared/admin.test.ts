import { assertEquals } from "jsr:@std/assert@1";
import { parseAdminUids } from "./admin.ts";
import { dbErrorToHttp } from "./db.ts";

Deno.test("parseAdminUids accepts comma/space/newline lists and drops junk", () => {
  const a = "00000000-0000-0000-0000-0000000000a1";
  const b = "00000000-0000-0000-0000-0000000000A2";
  assertEquals([...parseAdminUids(`${a}, ${b}\n not-a-uuid ;`)], [a, b.toLowerCase()]);
  assertEquals(parseAdminUids("").size, 0);
  assertEquals(parseAdminUids(undefined).size, 0);
});

Deno.test("dbErrorToHttp maps PTnnn SQLSTATEs to HTTP statuses", () => {
  const e = dbErrorToHttp({ code: "PT429", message: "rate_limit_exceeded:ping", hint: "120" });
  assertEquals(e.status, 429);
  assertEquals(e.headers["retry-after"], "120");
  assertEquals(dbErrorToHttp({ code: "PT403", message: "confirm_ineligible" }).status, 403);
  assertEquals(dbErrorToHttp({ code: "23505", message: "duplicate key" }).status, 500);
  assertEquals(dbErrorToHttp({ code: undefined, message: "x" }).status, 500);
});
