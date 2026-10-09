import { authenticate } from "../_shared/auth.ts";
import { type Db, rpc } from "../_shared/db.ts";
import { MAX_BODY_BYTES, parseDepthBatch } from "../_shared/depth.ts";
import { addDays, dayRange, uploaderHash, utcDay } from "../_shared/hmac.ts";
import { errorResponse, HttpError, json, readJsonLimited } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";

export interface DepthUploadDeps {
  db: Db;
  /** HMAC_SALT_SECRET, at least 32 chars. */
  secret: string;
  now: () => Date;
}

const HOLD_WINDOW_DAYS = 90;

/** Fisher-Yates with crypto randomness. */
export function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  const buf = new Uint32Array(1);
  for (let i = a.length - 1; i > 0; i--) {
    // rejection sampling to avoid modulo bias
    const limit = Math.floor(0x1_0000_0000 / (i + 1)) * (i + 1);
    let r: number;
    do {
      crypto.getRandomValues(buf);
      r = buf[0];
    } while (r >= limit);
    const j = r % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * POST /depth-upload
 *
 * 1. authenticate the user (their uid is used only to derive hashes and for the rate limit)
 * 2. validate the anonymous payload (allow-list; no uid, nothing finer than a day)
 * 3. replay of a known batch UUID -> 200 {duplicate:true}, before rate limiting
 * 4. rate limit: 1 batch / 15 min -> 429
 * 5. derive uploader_hash per row-day (HMAC of the uid with that day's salt) and the same user's
 *    hashes for the surrounding 90 days, so the SQL hold rule can tell "another boat" exactly
 * 6. public.ingest_depth_batch applies the 15 ft hold rule and re-aggregates depth_cells
 *
 * Sign convention: rows carry depth below MLLW, positive down; the 15 ft hold rule in SQL compares
 * with the baseline depth (-baseline_elev_ft), see _shared/depth.ts.
 *
 * The response never says which rows were held: that would tell an attacker how to tune a poisoned
 * upload to slip under the threshold.
 */
export async function handleDepthUpload(req: Request, deps: DepthUploadDeps): Promise<Response> {
  try {
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.", { allow: "POST" });
    if (deps.secret.length < 32) {
      console.error("HMAC_SALT_SECRET is missing or shorter than 32 characters");
      throw new HttpError(500, "misconfigured", "Server is not configured.");
    }

    const user = await authenticate(req, deps.db);
    const body = await readJsonLimited(req, MAX_BODY_BYTES);
    const now = deps.now();
    const batch = parseDepthBatch(body, req.headers.get("idempotency-key"), now);

    // owner is null once the ledger row has been unlinked from its user (15 minutes after receipt):
    // any later replay is then simply a duplicate.
    const seen = await rpc<{ found: boolean; owner: string | null }>(deps.db, "depth_batch_lookup", {
      p_batch_id: batch.batchId,
    });
    if (seen.found) {
      if (seen.owner && seen.owner.toLowerCase() !== user.id) {
        throw new HttpError(409, "batch_id_conflict", "Batch id already used.");
      }
      return json(200, { batch_id: batch.batchId, duplicate: true, rows: batch.rows.length });
    }

    const limited = await enforceRateLimit(deps.db, user.id, "depth_batch");
    if (limited) return limited;

    const epoch = Number(await rpc<number>(deps.db, "get_salt_epoch"));
    if (!Number.isInteger(epoch) || epoch < 0) throw new Error("get_salt_epoch returned a bad value");

    const days = batch.rows.map((r) => r.day).sort();
    const first = addDays(days[0], -HOLD_WINDOW_DAYS);
    const last = addDays(days[days.length - 1], HOLD_WINDOW_DAYS);
    const span = dayRange(first, last);
    // Hashes for the row days use the CURRENT epoch. "Self" hashes cover every epoch 0..current, so a
    // salt rotation does not make this boat look like a stranger to its own earlier uploads.
    const hashByDay = new Map<string, string>();
    for (const d of span) hashByDay.set(d, await uploaderHash(deps.secret, user.id, d, epoch));
    const selfHashes = new Set(hashByDay.values());
    for (let e = 0; e < epoch; e++) {
      for (const d of span) selfHashes.add(await uploaderHash(deps.secret, user.id, d, e));
    }

    // Row order is the order the boat drove its track in; the server must not retain or be able to
    // infer it, so shuffle before anything is written.
    const rows = shuffle(batch.rows.map((r) => ({ ...r, uploader_hash: hashByDay.get(r.day)! })));
    const result = await rpc<{ duplicate: boolean; accepted?: number; held?: number }>(
      deps.db,
      "ingest_depth_batch",
      {
        p_batch_id: batch.batchId,
        p_user_id: user.id,
        p_rows: rows,
        p_self_hashes: [...selfHashes],
      },
    );

    return json(200, {
      batch_id: batch.batchId,
      duplicate: Boolean(result.duplicate),
      rows: batch.rows.length,
      received_day: utcDay(now),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
