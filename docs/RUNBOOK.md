# Operations runbook

Skeleton. Fill in the TODO items as the pipeline, backend and worker go live.
Never paste secrets, service keys or HMAC salts into this file.

## 1. Pipeline rerun for one AOI

AOIs: `skagit`, `port_susan`, `snohomish`, `padilla_samish`, `nisqually`.
Every step reads and writes files under `data/<aoi>/<step>/` and is safe to rerun.

1. Confirm the working tree is clean and on the intended commit.
2. Confirm the runner has its environment variables (scoped R2 token, Supabase service key). Nothing is read from disk.
3. Run the AOI target, for example `make skagit`. (TODO: confirm Makefile target names in `pipeline/`.)
4. Check the validate report. The build fails if the p90 waterline error exceeds 1.5 ft (Gate 1 criterion).
5. Review the regression listing: any cell shallower by more than 3 ft versus the last published version must be reviewed before publish.
6. Publish only after review (section 2).

## 2. Tile publish and rollback

Tiles live on R2 under `tiles/<aoi>/<version>/`. `tiles/index.json` lists the live versions.

**Publish**

1. Confirm the datum sanity check passed (shoreline from ENC COALNE at roughly +9 to +13 ft MLLW).
2. Upload to `tiles/<aoi>/<version>/`.
3. Update `tiles/index.json` last, so clients never see an index that points at missing files.

**Rollback**

`tiles/index.json` holds exactly one entry per AOI. The app picks the highest version string for each AOI, so appending an older entry does nothing.

1. Replace the AOI's single entry in `tiles/index.json` with the previous version's entry (its version and file paths).
2. Do not delete the bad version immediately; keep it for investigation.

**Retention**

- Old versions are kept for 30 days after they are superseded, then removed by `publish --prune`.

## 3. HMAC salt rotation

The `uploader_hash` is HMAC(uid, daily server salt). The salt rotates daily.

Manual rotation (incident or scheduled):

1. Call the `admin` Edge Function with action `rotate_salt`. It bumps the HMAC salt epoch and writes an `audit_log` row.
2. Confirm new uploads carry the new salt-derived hash.
3. Record the time and reason in the incident log.

If the salt or service key leaks: rotate the salt, rotate the service key, invalidate all sessions, and review `last_positions` exposure (24 h window).

## 4. Account revocation

Use this for a bad actor or a compromised account. Admin actions run through Edge Functions that check the admin uid list and write to `audit_log`.

1. Identify the account (`profiles.id`, handle). Do not record the email address in tickets.
2. Call the `admin` Edge Function with action `revoke_account` and the target `user_id` (optional `reason`). It blocks writes, hides public pings, and bans sign-in, which invalidates its sessions.
3. Hide its pings from the public tier if needed (reputation under 0.3 already hides them).
4. Confirm that a removed group member loses access on the next request (RLS evaluates per query).
5. Record the action and reason in `audit_log` and the incident log.

User-initiated deletion runs as an Edge Function within 24 h and is logged.

## 5. Incident contacts

- Owner and admin: David Lym (LYMLY). TODO: add phone or pager contact.
- Security contact (listed in the app and privacy page): TODO: add address.
- Supabase support: TODO: add project reference (not a secret).
- Cloudflare account contact: TODO.
- Apple Developer account contact: TODO.

## 6. Incident checklist

1. Classify severity and note the start time.
2. Stop publishes if tiles or depth data are suspect.
3. Preserve logs (Supabase, Sentry, Better Stack).
4. Fix, verify with the pipeline validate report or pgTAP, then republish.
5. Write a short postmortem in `docs/`.
