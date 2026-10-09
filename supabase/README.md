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
supabase test db               # pgTAP, ~460 assertions
deno test --allow-env supabase/functions     # 55 edge-function tests (CI; no network, no Supabase)
deno check supabase/functions/*/index.ts
```

`deno.json` in `functions/` sets `nodeModulesDir: "none"` so Deno does not pick up an unrelated
`package.json` higher in the repo.

## Migrations

| # | File | What |
| --- | --- | --- |
| 1 | `extensions_types` | postgis, pgcrypto (schema `extensions`), `ping_type` enum, `in_salish_sea()`, `weighted_quantile()`; turns off Supabase's grant-everything defaults |
| 2 | `core_tables` | profiles, groups, group_members, pings, ping_votes, messages, last_positions, audit_log, app_config + CHECKs and indexes |
| 3 | `depth_tables` | depth_cells, depth_uploads, depth_batches, baseline_cells, depth_cell_aggregates |
| 4 | `functions` | membership predicates, rate limits, triggers, **`score_ping`**, RPCs (`cast_vote`, `join_group`, `rotate_invite_code`, `promote_ping`), `ping_feed` view |
| 5 | `rls` | grants (column-level) + RLS policies for every table |
| 6 | `depth_ingest_admin` | `ingest_depth_batch` (15 ft hold rule + aggregation), admin SQL actions, `delete_account_data` |
| 7 | `retention` | `run_retention`, `roll_old_depth_cells`, `purge_last_positions`, pg_cron schedules (skipped if pg_cron is absent) |
| 8 | `reputation` | `run_reputation_batch` |

Constraints enforced in Postgres (not just clients): note <= 140, message 1-500, ping type enum,
point SRID 4326 inside the Salish Sea box `[-124.0, 46.9]-[-121.9, 49.1]`, `created_at` no more than
168 h ahead of the server-stamped `received_at`, H3 res-12 id format, vote in {+1,-1}, reputation in
[0.2, 3.0], invite code = 8 chars. Server clock always wins for `received_at`; `expires_at` defaults
to `created_at + 48 h`.

## Sign convention (depth upload vs baseline)

`depth_uploads.median_ft` / `p10_ft` and `depth_cells.*` are **depth below MLLW, positive down**
(sounder convention, `p10_ft <= median_ft`, shoal-biased). `baseline_cells.baseline_elev_ft` is the
pipeline's `merged_elev`: **elevation, positive up**. The 15 ft hold rule compares
`median_ft` with `-baseline_elev_ft`. The pipeline loads `baseline_cells` with the service role.

## `score_ping(ping_id, at)`

```
S = R_a * (1 + SUM_i R_i * v_i * w(d_i)) * exp(-lambda * dt)
lambda = ln(2) / 86400 per second      dt = max(0, seconds(at - t_last))
w(d):  NULL -> 0 ; d <= 200 m -> 1.0 ; d <= 500 m -> 0.5 ; else 0        (voter_dist_m, stored at vote time)
t_last = max(created_at, latest confirm created_at <= at)   votes after `at` are ignored
```

Votes are summed ordered by `(created_at, voter_id)`; `(R_i * v_i) * w` in that order. Floating point:
Postgres and V8 agree to within 1 ulp (e.g. 2^-0.5 prints as `0.7071067811865476` in Postgres and
`0.7071067811865475` in JS), so compare with a tolerance (1e-12), not equality. Golden vectors (all
asserted in `tests/database/20_score_ping.test.sql`, ping created at T0, author R=1 unless noted):

| case | S |
| --- | --- |
| no votes, dt = 0 / 12 h / 24 h / 48 h | 1.0 / 0.7071067811865476 / 0.5 / 0.25 |
| author R = 1.5, 24 h | 0.75 |
| confirm @100 m (R 1) at T0+1 h, at T0+1 h / T0+25 h | 2.0 / 1.0 |
| confirm @100 m (R 1.2) + dispute @400 m (R 0.8), at T0+14 h (confirm at +2 h) | 1.2727922061357857 |
| confirms @200 m (R 1), @500 m (R 2), @200.0001 m (R 1); disputes @600 m, @NULL | 1 + 1 + 1 + 0.5 = 3.5 |
| two disputes @100 m, R 1 and R 3, dt = 1 h | 1*(1-1-3)*2^(-1/24) (negative; clients hide S < 0.25) |

`pings.score` is only a cache (initial value = author reputation, refreshed by `cast_vote`). It is not
client-writable.

## Row Level Security

RLS is on for every table. `anon` holds **no** grants. `authenticated` gets the minimum, with
column-level grants so a client cannot write `reputation`, `revoked_at`, `score`, invite codes, etc.

| table | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| profiles | any signed-in (handle, vessel, **reputation**) | own row (id, handle, vessel_name) | own (handle, vessel_name) | none (account-delete function) |
| groups | members/owner | `owner_id = me` (id, name, owner_id) | owner: name only | owner |
| group_members | members | none (trigger + `join_group`) | none | self-leave (members), owner removes others |
| pings | `group_id is null` (author reputation >= 0.3 and not revoked, or own) **or** group member | author, group null or member | none (append-only; `promote_ping`) | author |
| ping_votes | wherever the ping is visible | none: **`cast_vote` only** | none | none |
| messages | group members | member, own author_id, ping from same group or public | none | author or group owner |
| last_positions | own + fellow group members, < 24 h old | own (rounded to 100 m by trigger, <= 1 / 5 min) | own | own |
| depth_cells, depth_cell_aggregates | signed-in, **only `boats >= 3`** | none | none | none |
| depth_uploads, depth_batches, baseline_cells, audit_log, app_config | none | none (service role) | none | none |

`audit_log` is additionally append-only for everyone (trigger), including the service role.

### Client RPCs

All take the caller from the JWT and raise `PTnnn` SQLSTATEs, which PostgREST returns as HTTP `nnn`
with `{code, message, hint}`:

| RPC | Args | Notes |
| --- | --- | --- |
| `cast_vote` | `p_ping_id uuid, p_vote smallint` (+1 / -1) | returns the `ping_votes` row; idempotent (repeat returns stored vote). Errors: `PT403 confirm_ineligible` (hint `no_position` / `stale_position` / `too_far`), `PT403 cannot_vote_own_ping`, `PT403 account_revoked`, `PT404 ping_not_found`, `PT400 invalid_vote`, `PT401 not_authenticated`, `PT429 rate_limit_exceeded:vote` (keep and retry later). A client may drop a queued vote silently on any 4xx except 429. |
| `join_group` | `p_code text` | returns the group id; `PT404 invalid_or_expired_invite` |
| `rotate_invite_code` | `p_group uuid` | owner only; returns `(invite_code, invite_expires_at)`; `PT403 not_group_owner` |
| `promote_ping` | `p_ping_id uuid` | author moves a group ping to the public tier |
| `score_ping` | `p_ping_id uuid, p_at timestamptz` | invoker rights: returns null for pings you cannot see |

**Confirm eligibility (FLT-2):** a confirm needs a `last_positions` row updated within 24 h and within
500 m of the ping. `voter_dist_m` is computed server-side (clients cannot forge it). Disputes are
always accepted but weigh 0 unless the voter was within 500 m, and the reputation batch ignores them.

**Rate limits** (per user, sliding window, HTTP 429): 30 pings/h, 60 votes/h, 10 messages/min,
1 depth batch/15 min. Pings, votes and messages are limited by `BEFORE INSERT` triggers (so direct
PostgREST writes are covered); the depth batch limit is enforced by the `depth-upload` function via
the shared middleware in `functions/_shared/rate-limit.ts`. All use `rate_limit_status(user, bucket)`.

## Edge functions

| Function | Caller | What |
| --- | --- | --- |
| `depth-upload` | signed-in app | Body `{batch_id, rows:[{h3_cell, day, median_ft, p10_ft, n}]}` (or a bare array + `Idempotency-Key`). Allow-list validation (a uid, boat id, lat/lon, sequence or any timestamp finer than `day` is a 400), replay -> `200 {duplicate:true}`, 1 batch/15 min, then `uploader_hash = HMAC-SHA256(HMAC(HMAC_SALT_SECRET, "…:epoch:day"), uid)` **per row-day**, then `ingest_depth_batch`. The response never reveals which rows were held. |
| `reputation-batch` | pg_cron (service-role bearer) | `run_reputation_batch()` |
| `account-delete` | signed-in app | `delete_account_data(uid)` then `auth.admin.deleteUser` |
| `admin` | `ADMIN_UIDS` only | `hold_upload`, `release_upload`, `revoke_account`, `rotate_salt`, `list_held`; every call (including denials and invalid requests) is in `audit_log` |

**Hold rule** (`ingest_depth_batch`): a row is held (kept, excluded from `depth_cells`) when
`|median_ft - (-baseline_elev_ft)| > 15` and no other boat logged the cell: no non-held row from a
different boat within 90 days, and no other boat's held row within 30 days that agrees within 5 ft
(that second boat releases the first). "Another boat" is exact because the function receives the
caller's own hashes for the surrounding 90 days (`p_self_hashes`). Cells with no baseline are never
held. Admin holds are never auto-released. Stale baseline holds (> 30 days) are purged.

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

Retention (`run_retention`, nightly 03:17 UTC) and the 24 h position purge (every 15 min) are
scheduled by migration 7 when `pg_cron` is available. Needs `pg_cron` and `pg_net` enabled on the project.

## Deviations from `docs/AGENT-PLAN.md` / PRD

1. **`depth_uploads` is not client-insertable.** The plan says "insert-only for signed-in users", but
   `uploader_hash` must be computed server-side; a client allowed to insert could write three fake
   hashes and defeat the 3-boat threshold. Inserts go through the `depth-upload` function (service role).
   The pgTAP matrix asserts signed-in insert and select are both denied.
2. **`depth_cells` / aggregates are readable only where `boats >= 3`** (plan: "readable by all
   signed-in"). Otherwise any signed-in user could `select` a single boat's daily route.
3. **Votes are written only through `cast_vote`** (no direct insert policy), so `voter_dist_m` is
   trustworthy.
4. **Additions to the PRD columns:** `profiles.revoked_at`; `pings.anonymous`, `received_at`,
   `updated_at`, `rep_processed_at`; `messages.received_at`; `depth_uploads.p10_ft`, `held`,
   `held_reason`; new tables `depth_batches`, `baseline_cells`, `depth_cell_aggregates`, `app_config`.
5. **Reputation batch counts only votes within 500 m**, so disputes from the dock cannot be farmed.
6. **`uploader_hash` salt is per day of the sounding** (not the request date) so a multi-day backlog
   upload cannot be joined across days.

## Open questions

* **Anonymous pings:** RLS cannot hide one column, so `pings.author_id` is still selectable for an
  anonymous public ping. The `ping_feed` view masks it; if anonymity must be airtight, revoke
  `select (author_id)` on `pings` and have the mobile client read `ping_feed` (one migration).
* **Salt rotation mid-day** changes the hash for the rest of the UTC day, so a boat that uploads
  before and after a rotation can count as two boats for that day's cells.
* **H3 validity** is checked by format (`8c` + 13 hex), not by decoding the index.
* `supabase test db` was exercised here against PostgreSQL 18.6 + PostGIS with a hand-written
  stand-in for the Supabase roles and `auth` schema, not the Supabase image (no Docker). pg_cron
  paths are unexecuted. Expect CI on the real image to be the first full run.
