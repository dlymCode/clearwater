# Clearwater backend (`supabase/`)

Postgres 17 + PostGIS, Row Level Security, Deno edge functions, pgTAP tests. Everything the PRD
calls "Fleet reporting and trust model", "Secrecy and privacy" and the backend half of "Security"
lives here. The tile Worker is in [`../workers/tile-auth`](../workers/tile-auth/README.md).

```
supabase/
  config.toml          local/CI config (no secrets)
  migrations/          8 numbered migrations, apply from zero
  functions/           edge functions + _shared + Deno tests
  tests/database/      pgTAP: RLS matrix, score, hold rule, reputation, rate limits, retention
  seed.sql             intentionally empty
  .env.example         placeholder names only
```

## Run it

```sh
supabase start                 # needs Docker
supabase db reset              # applies migrations/ then seed.sql
supabase test db               # pgTAP, 685 assertions
deno test --allow-env supabase/functions     # 59 edge-function tests (no Supabase needed; first run downloads npm:h3-js / supabase-js)
deno check supabase/functions/*/index.ts
```

`deno.json` in `functions/` sets `nodeModulesDir: "none"` so Deno does not pick up an unrelated
`package.json` higher in the repo.

## Migrations

| # | File | What |
| --- | --- | --- |
| 1 | `extensions_types` | postgis, pgcrypto (schema `extensions`), `ping_type` enum, `in_salish_sea()`, `weighted_quantile()`; turns off Supabase's grant-everything defaults |
| 2 | `core_tables` | profiles, groups, group_members, pings, ping_votes, messages, last_positions, rate_events, audit_log, app_config + CHECKs and indexes |
| 3 | `depth_tables` | depth_cells, depth_uploads, depth_batches, baseline_cells, depth_cell_aggregates |
| 4 | `functions` | membership/visibility predicates, rate limiter, triggers, **`score_ping`**, RPCs (`cast_vote`, `join_group`, `rotate_invite_code`, `get_invite_code`, `promote_ping`, `report_position`), read models `ping_feed` and `messages_feed`; vote aggregates (`ping_vote_stats`, `vote_weight`); `auth.users` trigger that creates a profile |
| 5 | `rls` | grants (column-level) + RLS policies for every table |
| 6 | `depth_ingest_admin` | `ingest_depth_batch` (15 ft hold rule + aggregation), admin SQL actions, `delete_account_data` |
| 7 | `retention` | `run_retention`, `roll_old_depth_cells`, `purge_last_positions`, pg_cron schedules (skipped if pg_cron is absent) |
| 8 | `reputation` | `run_reputation_batch` |

Constraints enforced in Postgres (not just clients): note <= 140, message 1-500, ping type enum,
point SRID 4326 inside the Salish Sea box `[-124.0, 46.9]-[-121.9, 49.1]` (pings **and** last_positions),
`created_at` no more than 168 h ahead of the server-stamped `received_at`, `expires_at` within 168 h of `created_at`, H3 res-12 id format, vote in {+1,-1}, reputation in
[0.2, 3.0], invite code = 8 chars. Server clock always wins for `received_at`; `expires_at` defaults
to `created_at + 48 h`.

## Sign convention (depth upload vs baseline)

`depth_uploads.median_ft` / `p10_ft` and `depth_cells.*` are **depth below MLLW, positive down**
(sounder convention, `p10_ft <= median_ft`, shoal-biased). `baseline_cells.baseline_elev_ft` is the
pipeline's `merged_elev`: **elevation, positive up**. The 15 ft hold rule compares
`median_ft` with `-baseline_elev_ft`. The pipeline loads `baseline_cells` with the service role.

## `score_ping(ping_id, at)`

```
S = R_a * (1 + vote_sum) * exp(-lambda * dt)
lambda = ln(2) / 86400 per second      dt = max(0, seconds(at - t_last))
vote_sum = quantize(SUM_i R_i * v_i * w(d_i), 0.25)     quantize(x) = floor(x * 4 + 0.5) / 4   (round half up)
w(d):  NULL -> 0 ; d <= 200 m -> 1.0 ; d <= 500 m -> 0.5 ; else 0        (voter_dist_m, stored at vote time)
t0     = least(created_at, received_at)     -- a device clock running ahead cannot make a ping look fresh
t_last = max(t0, last_confirmed_at)         -- votes dated after `at` are ignored
R_a    = author reputation; for ANONYMOUS pings quantised to the nearest 0.25 (feed and score agree)
```

The raw sum is accumulated in `(created_at, voter_id)` order as `(R_i * v_i) * w`, then quantised, so
the only floating-point difference between SQL and a client is the last ulp of `exp` (Postgres prints
2^-0.5 as `0.7071067811865476`, V8 as `0.7071067811865475`): compare with a tolerance (1e-12), not
equality. The client never sees individual votes: it reads `vote_sum` and `last_confirmed_at` from
`ping_feed`. Golden vectors (asserted in `tests/database/20_score_ping.test.sql`; ping created and received
at T0, author R = 1 unless noted):

| case | S |
| --- | --- |
| no votes, dt = 0 / 12 h / 24 h / 48 h | 1.0 / 0.7071067811865476 / 0.5 / 0.25 |
| author R = 1.5, 24 h | 0.75 |
| confirm @100 m (R 1) at T0+1 h; at T0+1 h / T0+25 h | 2.0 / 1.0 |
| confirm @100 m (R 1.2) + dispute @400 m (R 0.8): raw sum 0.8 -> vote_sum 0.75; at T0+14 h (confirm at +2 h) | 1.75 * 2^-0.5 = 1.2374368670764582 |
| confirms @200 m (R 1), @500 m (R 2), @200.0001 m (R 1); disputes @600 m, @NULL: sum 1 + 1 + 0.5 | 1 + 2.5 = 3.5 |
| two disputes @100 m, R 1 and R 3, dt = 1 h | 1*(1-4)*2^(-1/24) (negative; clients hide S < 0.25) |
| quantise: raw 0.125 -> 0.25 ; raw -0.125 -> 0 ; raw 0.75 -> 0.75 | |
| created_at 3 days in the future, received_at = T0, at = T0 + 24 h | 0.5 (t0 = received_at) |

`pings.score` is only a cache (initial value = author reputation, quantised for anonymous pings;
refreshed by `cast_vote`). It is not client-writable. `score_ping` and `ping_vote_stats` are SECURITY
DEFINER (clients cannot read `pings.author_id` or other people's votes) and return null for pings the
caller cannot see.

## Row Level Security

RLS is on for every table. `anon` holds **no** grants. `authenticated` gets the minimum, with
column-level grants so a client cannot write `reputation`, `revoked_at`, `score`, invite codes, etc.

**The mobile client reads pings through `ping_feed` and the group channel through `messages_feed`; it
cannot `select *` from `pings` (42501 by design) and there is no per-vote view at all.** `pings.author_id` and `rep_processed_at`,
`ping_votes` rows of other users, `groups.invite_code` and `profiles.revoked_at` are not readable
columns; Realtime publishes only `messages`.

| table | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| profiles | any signed-in: `id, handle, vessel_name, reputation, created_at` (not `revoked_at`) | own row (id, handle, vessel_name); a **trigger on `auth.users` already creates a placeholder row** (`user_<19 hex>`, reputation 1.0) so a new user's first write cannot die on the FK; onboarding UPDATEs handle/vessel | own (handle, vessel_name), active accounts only | none (account-delete function) |
| groups | members/owner: all columns **except `invite_code`** | `owner_id` defaults to `auth.uid()`; 5 per hour | owner: name only | owner |
| group_members | members | none (trigger + `join_group`) | none | self-leave (members), owner removes others (this rotates the invite code) |
| pings | all columns **except `author_id`, `rep_processed_at`**, where `ping_visible`: public tier (author reputation >= 0.3, not revoked, or own) or a group I belong to | author, group null or member | none (append-only; `promote_ping`) | author (active accounts only) |
| ping_votes | **own rows only** | none: **`cast_vote` only** | none | none |
| messages | group members (`messages_feed` adds `author_handle`) | member, own author_id, ping from same group or public | none | author or group owner (active accounts only) |
| last_positions | own + fellow group members, < 24 h old | none: **`report_position` only** | none | own (stop sharing) |
| depth_cells, depth_cell_aggregates | signed-in, **only `boats >= 3`** | none | none | none |
| depth_uploads, depth_batches, baseline_cells, rate_events, audit_log, app_config | none | none (service role) | none | none |

`audit_log` is append-only for everyone: no update/delete/truncate privilege for `service_role`, plus a
trigger that also stops the table owner. `admin.denied` / `admin.invalid_request` noise is limited to
one row per actor per 10 minutes.

### Read models (what the app queries)

* **`ping_feed`** (owner-run, `security_barrier`, re-implements the pings visibility rule in `WHERE`):
  `id, author_id, author_handle, author_reputation, mine, group_id, type, geom, note, created_at,
  received_at, expires_at, score, tide_ft, anonymous, updated_at, vote_sum, last_confirmed_at,
  confirm_count, dispute_count`. For an anonymous ping `author_id` is null except to its author,
  `author_handle` is always null, and `author_reputation` is quantised to 0.25 (so neither the feed nor
  the cached score fingerprints a boat). Pending client rows reconcile on `id`. A new vote bumps
  `updated_at`, so cursor sync re-pulls the ping.
* **Vote aggregates, computed on the server (nothing per-vote ever leaves it).** A previous design
  published each vote's weight and exact voter reputation; an exact reputation joins straight back to
  `profiles`, which would have named the voter and, with the weight and the timestamp, their distance
  bucket. Now clients get four numbers per ping: `vote_sum = quantize(SUM R_i*v_i*w(d_i), 0.25)` with
  `quantize(x) = floor(x*4 + 0.5)/4` (round half up), `last_confirmed_at`, and `confirm_count` /
  `dispute_count` (votes with w(d) > 0), all ignoring votes dated after "now". The client score is
  `author_reputation * (1 + vote_sum) * exp(-lambda * dt)`, `dt` from `max(least(created_at, received_at),
  last_confirmed_at)`: the same `vote_sum` feeds `score_ping`, so they agree exactly (modulo the last ulp of
  `exp`). A voter still reads their own votes, with distance, from `ping_votes` (reconciling optimistic
  votes). `w(d)` lives in one SQL function, `vote_weight()`.
* **`messages_feed`** (owner-run, `security_barrier`, `is_group_member` in `WHERE`): `id, group_id,
  author_id, author_handle, body, ping_id, created_at, received_at`. Cursor column: `received_at`.

### Client RPCs

All take the caller from the JWT and raise `PTnnn` SQLSTATEs, which PostgREST returns as HTTP `nnn`
with `{code, message, hint}`:

| RPC | Args | Notes |
| --- | --- | --- |
| `cast_vote` | `p_ping_id uuid, p_vote smallint` (+1 / -1) | returns the `ping_votes` row; idempotent (repeat returns stored vote). Errors: `PT403 confirm_ineligible` (hint `no_position` / `stale_position` / `too_far`), `PT403 cannot_vote_own_ping`, `PT403 account_revoked`, `PT404 ping_not_found`, `PT400 invalid_vote`, `PT401 not_authenticated`, `PT429 rate_limit_exceeded:vote` (keep and retry later). A client may drop a queued vote silently on any 4xx except 429. |
| `report_position` | `p_lat double precision, p_lon double precision` -> void | the only way to write `last_positions`: validates the Salish Sea box (`PT400 position_out_of_range` / `invalid_position`), snaps to 100 m, upserts; a call inside the 5-minute window is a **silent no-op** (the throttle survives delete + re-report) |
| `join_group` | `p_code text` | returns the group id, or **NULL** for an unknown / expired / rotated-out code (not an exception, so failed guesses stay counted); 10 attempts / 15 min -> `PT429` |
| `get_invite_code` | `p_group uuid` | owner only; returns `(invite_code, invite_expires_at)`; `PT403 not_group_owner` |
| `rotate_invite_code` | `p_group uuid` | owner only; 10 per hour; returns `(invite_code, invite_expires_at)` |
| `promote_ping` | `p_ping_id uuid` | author moves a group ping to the public tier; 30 per hour |
| `score_ping` | `p_ping_id uuid, p_at timestamptz` | null for pings you cannot see |

Removing a member rotates the group's invite code, so a removed member cannot rejoin with the code
they already know.

**Confirm eligibility (FLT-2):** a confirm needs a `last_positions` row updated within 24 h and within
500 m of the ping. `voter_dist_m` is computed server-side (clients cannot forge it). Disputes are
always accepted but weigh 0 unless the voter was within 500 m, and the reputation batch ignores them.

**Rate limits** (per user, sliding window, HTTP 429): 30 pings/h, 60 votes/h, 10 messages/min,
1 depth batch/15 min, plus 10 `join_group` attempts/15 min, 1 position report/5 min, 5 group creations/h,
30 `promote_ping`/h and 10 `rotate_invite_code`/h. They are
counted from the append-only `rate_events` ledger, not from surviving rows, so deleting and re-posting
does not reset a window; a per-(user, bucket) advisory lock serialises concurrent requests and the
`BEFORE INSERT` triggers count row by row, so a 31-row bulk insert is refused too. Retried inserts of an
existing client UUID are not counted. Pings, votes and messages are limited by triggers (so direct
PostgREST writes are covered); depth batches by the `depth-upload` function through
`functions/_shared/rate-limit.ts`. SQL is the single authority (`rate_limit_params()` holds every limit;
`rate_limit_consume()` checks and records atomically, `rate_limit_refund()` gives a slot back when the
function failed after consuming it); the TypeScript module only turns a refusal into HTTP 429.

## Edge functions

| Function | Caller | What |
| --- | --- | --- |
| `depth-upload` | signed-in app | Body `{batch_id, rows:[{h3_cell, day, median_ft, p10_ft, n}]}` (or a bare array + `Idempotency-Key`). Allow-list validation (a uid, boat id, lat/lon, sequence or any timestamp finer than `day` is a 400), replay -> `200 {duplicate:true}`, the `h3_cell` is decoded with `h3-js` and must be a real res-12 cell inside the Salish Sea, `p10_ft <= median_ft`, 1 batch/15 min (consumed before the work and **refunded if the ingest fails**, so a transient 5xx does not burn the slot), then `uploader_hash = HMAC-SHA256(HMAC(HMAC_SALT_SECRET, "…:epoch:day"), uid)` **per row-day**, rows are **shuffled** before the RPC (track order is not retained), then `ingest_depth_batch`. The response never reveals which rows were held. |
| `reputation-batch` | pg_cron (service-role bearer) | `run_reputation_batch()` |
| `account-delete` | signed-in app | `delete_account_data(uid)` then `auth.admin.deleteUser` |
| `admin` | `ADMIN_UIDS` only | `hold_upload`, `release_upload`, `revoke_account`, `rotate_salt`, `list_held`; every call (including denials and invalid requests) is in `audit_log` |

**Hold rule** (`ingest_depth_batch`): a row is held (kept, excluded from `depth_cells`) when
`|median_ft - (-baseline_elev_ft)| > 15` **or `|p10_ft - (-baseline_elev_ft)| > 15`** (a fake shoal in the
p10 alone is as dangerous as a fake median) and no other boat **corroborates** it, meaning a non-held row
from a different boat within 90 days, or a held row from a different boat within 30 days, whose median and
p10 are each within **5 ft** of this one (a held corroborator is released together with the new row). "Another boat"
is exact because the function receives the caller's own hashes for the surrounding 90 days across **all
salt epochs** (`p_self_hashes`). Cells with no baseline are never held. Admin holds are never
auto-released. Stale baseline holds (> 30 days) are purged. *Deliberate deviation from the PRD wording*
(which exempts an upload whenever any other boat logged the cell): with the literal rule an attacker
could pair a poisoned reading with any unrelated nearby sounding. **Owner to confirm.**

One row per boat per (cell, day): a repeat upload replaces the earlier row (unique index), and each boat's
weight in a cell's median / p10 is capped at `least(n, 100)`, so neither re-sending nor claiming `n = 86400`
moves the aggregate. `p10_ft <= median_ft` and both within +-2000 ft are CHECK constraints. Batches that
touch the same (cell, day) are serialised by advisory locks taken in sorted key order before anything is
read (two boats uploading one cell at the same moment used to overwrite each other's aggregate: boats = 1).
`depth_batches.user_id` is nulled 15 minutes after receipt (the ledger exists only for idempotency); the
rate-limit ledger `rate_events` keeps a uid for at most 2 hours. Baseline holds are purged 30 days after they
were **received** (`held_on`, a UTC day), not 30 days after the sounding, so a late backlog upload keeps its full
corroboration window: a hold received on day D survives through D+30 and goes in the first retention run of D+31.
Salt epochs record their activation day (`app_config.hmac_salt_epochs`); the function only recomputes
self-hashes for epochs that overlap the batch's +-90 day window.

### Weekly reputation batch (schedule)

Reputation is `+0.05` per ping with >= 2 confirms, `-0.10` per ping with >= 2 disputes (votes cast
within 500 m only), clamped to [0.2, 3.0], evaluated once per ping 48 h after it was received. Create
the secrets in Vault (`vault.create_secret`) and schedule:

```sql
select cron.schedule('clearwater-reputation', '0 11 * * 1', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/reputation-batch',
    headers := jsonb_build_object('Content-Type', 'application/json',
               'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body    := '{}'::jsonb);
$$);
```

Retention (`run_retention`, nightly 03:17 UTC) and the 15-minute housekeeping job (24 h position purge,
rate-event expiry, batch-ledger unlinking) are scheduled by migration 7 when `pg_cron` is available.
Messages are retained 90 days from `received_at`; daily depth cells are rolled into 90-day aggregates only
if they ever had >= 3 boats, and deleted at 180 days either way. Needs `pg_cron` and `pg_net` enabled on the project.

## Deviations from `docs/AGENT-PLAN.md` / PRD

1. **`depth_uploads` is not client-insertable.** The plan says "insert-only for signed-in users", but
   `uploader_hash` must be computed server-side; a client allowed to insert could write three fake
   hashes and defeat the 3-boat threshold. Inserts go through the `depth-upload` function (service role).
2. **`depth_cells` / aggregates are readable only where `boats >= 3`** (plan: "readable by all
   signed-in"). Otherwise any signed-in user could `select` a single boat's daily route.
3. **Votes are written only through `cast_vote`**, and **last positions only through `report_position`**,
   so `voter_dist_m` and the 100 m rounding cannot be bypassed.
4. **Pings are read through `ping_feed`, votes through server-side aggregates.** `pings.author_id` is not
   selectable and `ping_votes` shows only your own rows; other people's votes appear only as the four
   quantised aggregates on `ping_feed` (anonymous pings and voter identity cannot be recovered).
   Users have no `select *` on `pings`.
5. **Corroboration needs agreement within 5 ft** (see Hold rule) and each boat's weight in an aggregate
   is capped at 100 samples.
6. **Additions to the PRD columns/tables:** `profiles.revoked_at`; `pings.anonymous`, `received_at`,
   `updated_at`, `rep_processed_at`; `messages.received_at`; `depth_uploads.p10_ft`,
   `held_reason`, `held_on` and a derived `held`; tables `depth_batches`, `baseline_cells`, `depth_cell_aggregates`, `rate_events`,
   `app_config`.
7. **Reputation batch counts only votes within 500 m**, so disputes from the dock cannot be farmed.
8. **`uploader_hash` salt is per day of the sounding** (not the request date) so a multi-day backlog
   upload cannot be joined across days.
9. **`join_group` returns NULL for a bad code** instead of raising, so failed guesses are counted by
   the throttle (an exception would roll the counter back).

## Limitations and open questions

* **Sybil resistance is out of scope.** A determined attacker with several phone numbers / Apple IDs
  can still mint accounts that confirm each other's pings or pad a cell's boat count toward 3. The 500 m
  confirm check does NOT raise the cost: it trusts the position the account itself reports through
  `report_position`, which a modified client can set to anywhere in the box. For a 12-known-boat beta the controls are the
  invite-only groups, distance-gated confirms, per-account rate limits, reputation, and the admin
  revoke action; identity vetting (invite-only onboarding, per-device attestation, phone-number
  allow-lists) is a post-beta decision for the owner.
* **Residual inference from the vote aggregates.** With `confirm_count = 1` and a `last_confirmed_at`, a
  viewer learns that exactly one boat confirmed at that time; combined with outside knowledge of who was in
  the area they may guess who. Quantising `vote_sum` to 0.25 hides the voter's exact reputation (a single
  confirm shows as 0.25-, 0.5- or 1-step buckets, not a joinable float), but the count and the timestamp
  remain by design (they are the product: "confirmed 2x, 10 min ago"). Anyone who needs to hide a
  confirmation should dispute from afar instead (weight 0, not counted).
* **Reputation of an anonymous ping** is visible quantised to 0.25 (PRD: "carries the author's
  reputation but not the handle"). In a 12-boat fleet a distinctive reputation could still narrow the
  author down; drop `author_reputation` for anonymous pings (treat as 1.0) if that is too leaky.
* **Salt rotation mid-day** changes the hash for the rest of the UTC day, so a boat that uploads
  before and after a rotation can count as two boats for that day's cells.
* **H3 validity** is checked in SQL by format (`8c` + 13 hex) and in the edge function by decoding the cell (`h3-js`): real res-12 index, centre inside the Salish Sea box.
* `supabase test db` was exercised here against PostgreSQL 18.6 + PostGIS with a hand-written
  stand-in for the Supabase roles and `auth` schema, not the Supabase image (no Docker). pg_cron
  paths are unexecuted. Expect CI on the real image to be the first full run.
