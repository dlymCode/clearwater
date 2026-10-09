import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { addDays, dailySalt, dayRange, isIsoDay, toHex, uploaderHash, utcDay } from "./hmac.ts";

// Unit-test-only value; not a secret.
const SECRET = "unit-test-only-not-a-real-secret-0123456789";
const UID = "00000000-0000-0000-0000-0000000000a1";

Deno.test("daily salt matches an independent HMAC-SHA256 computation (node:crypto)", async () => {
  assertEquals(
    toHex(await dailySalt(SECRET, "2026-10-01", 0)),
    "b0e40342eff615c641987326775e410bd412e01a1214232b74009425d3b3bb6b",
  );
});

Deno.test("uploader hash vectors (node:crypto reference)", async () => {
  assertEquals(
    await uploaderHash(SECRET, UID, "2026-10-01", 0),
    "977986c7cc18375d384ed077bf3b48e49966c9e68dff9c7473197f14a4e1e4a2",
  );
  assertEquals(
    await uploaderHash(SECRET, UID.toUpperCase(), "2026-10-01", 0),
    "977986c7cc18375d384ed077bf3b48e49966c9e68dff9c7473197f14a4e1e4a2",
  );
});

Deno.test("the hash changes with day, epoch and user, so a boat cannot be joined across days", async () => {
  const base = await uploaderHash(SECRET, UID, "2026-10-01", 0);
  assertEquals(
    await uploaderHash(SECRET, UID, "2026-10-02", 0),
    "93d909fffb55d634db5b6d130dfb8f71fb54358bd361c8aa0a10f579bbe24450",
  );
  assertEquals(
    await uploaderHash(SECRET, UID, "2026-10-01", 1),
    "b8eaf1b4b2894af2d23aceca90e0f7b56a75fc775d114baf18ba07c768f3b579",
  );
  assertNotEquals(await uploaderHash(SECRET, "00000000-0000-0000-0000-0000000000a2", "2026-10-01", 0), base);
  assertNotEquals(await uploaderHash("another-unit-test-secret-0123456789abcd", UID, "2026-10-01", 0), base);
  assertEquals(base.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(base), true);
});

Deno.test("day helpers", () => {
  assertEquals(isIsoDay("2026-10-01"), true);
  assertEquals(isIsoDay("2026-02-30"), false);
  assertEquals(isIsoDay("2026-10-01T10:00:00Z"), false);
  assertEquals(isIsoDay(20261001), false);
  assertEquals(utcDay(new Date("2026-10-01T23:59:59Z")), "2026-10-01");
  assertEquals(addDays("2026-03-01", -1), "2026-02-28");
  assertEquals(addDays("2026-12-31", 1), "2027-01-01");
  assertEquals(dayRange("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});
