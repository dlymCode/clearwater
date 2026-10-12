-- Migration 6 of 8: depth ingestion (hold rule + aggregation) and admin actions.
-- Every function here is SECURITY DEFINER and executable by service_role ONLY; they are called
-- from the edge functions (depth-upload, admin, account-delete), never from the app directly.

-- ======================================================================================
-- recompute_depth_cell: rebuild the (cell, day) aggregate from non-held uploads.
--   median_ft = weighted (lower) median of uploads' median_ft
--   p10_ft    = weighted 10th percentile of uploads' p10_ft
--   weight    = least(n, 100) per boat-day-cell, so one boat cannot dominate a cell by claiming a huge n
--   n         = sum(least(n, 100))   boats = count(distinct uploader_hash)
-- No qualifying uploads => the aggregate row is deleted.
-- ======================================================================================
create or replace function public.recompute_depth_cell(p_cell text, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_median double precision;
  v_p10 double precision;
  v_n bigint;
  v_boats integer;
begin
  -- same lock key as ingest_depth_batch (re-entrant within a transaction)
  perform pg_advisory_xact_lock(hashtextextended(p_cell || '|' || p_day::text, 0));
  select
    public.weighted_quantile(array_agg(u.median_ft order by u.median_ft, u.id),
                             array_agg(least(u.n, 100)::double precision order by u.median_ft, u.id), 0.5),
    count(distinct u.uploader_hash),
    sum(least(u.n, 100))
  into v_median, v_boats, v_n
  from public.depth_uploads u
  where u.cell_id = p_cell and u.day = p_day and not u.held;

  if v_boats is null or v_boats = 0 then
    delete from public.depth_cells where cell_id = p_cell and day = p_day;
    return;
  end if;

  select public.weighted_quantile(array_agg(u.p10_ft order by u.p10_ft, u.id),
                                  array_agg(least(u.n, 100)::double precision order by u.p10_ft, u.id), 0.10)
  into v_p10
  from public.depth_uploads u
  where u.cell_id = p_cell and u.day = p_day and not u.held;

  insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
  values (p_cell, p_day, v_median, v_p10, least(v_n, 2000000000)::integer, v_boats)
  on conflict (cell_id, day) do update
    set median_ft = excluded.median_ft,
        p10_ft    = excluded.p10_ft,
        n         = excluded.n,
        boats     = excluded.boats;
end
$$;

-- ======================================================================================
-- ingest_depth_batch: the whole server-side half of an upload, in one transaction.
--
-- Inputs (all computed by the edge function; the app never sends a uid or a hash):
--   p_batch_id     client batch UUID. Replays return {duplicate:true} and change nothing.
--   p_user_id      JWT subject, stored only in depth_batches (rate limit + idempotency).
--   p_rows         [{h3_cell, day, median_ft, p10_ft, n, uploader_hash}], hash per row because
--                  the salt is per DAY OF THE ROW (a boat's hashes differ across days).
--   p_self_hashes  this user's hashes for the surrounding 90 days under every salt epoch that was
--                  active in that window, so "another boat" is exact even though hashes rotate daily.
--
-- Hold rule (PRD "Depth log trust" #4, docs/AGENT-PLAN.md):
--   a row is HELD (kept, excluded from depth_cells) when |median_ft - (-baseline_elev_ft)| > 15 OR
--   |p10_ft - (-baseline_elev_ft)| > 15 (a fake shoal in the p10 alone is as dangerous as a fake median),
--   AND no other boat corroborates it. Corroboration (a deliberate tightening of the PRD wording, which
--   only says "no other boat has logged that cell within 90 days"; flagged to the owner because with
--   the literal wording any unrelated nearby reading would let a poisoned value through):
--     * a NON-held upload from another boat within 90 days whose median AND p10 are each within 5 ft of
--       this one, or
--     * a HELD upload from another boat within 30 days within 5 ft (median and p10) of this one (that
--       boat's row is then RELEASED together with this row).
--   Rows with no baseline are never held. Admin-held rows (held_reason = 'admin') are never
--   auto-released. A repeat upload by the same boat for the same (cell, day) REPLACES the earlier one
--   (unique index), so a boat cannot add weight by re-sending.
--
-- Concurrency: an advisory lock per (cell, day), taken for the whole batch in sorted key order
-- BEFORE anything is read or written, serialises concurrent batches that touch the same aggregate (two
-- boats uploading the same cell at the same moment used to overwrite each other's aggregate, boats = 1).
-- Sorted acquisition avoids deadlocks between batches. Released rows on other days are locked inside
-- recompute_depth_cell(), which takes the same lock.
-- ======================================================================================
create or replace function public.ingest_depth_batch(
  p_batch_id uuid,
  p_user_id uuid,
  p_rows jsonb,
  p_self_hashes text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_hold_ft constant double precision := 15.0;
  c_agree_ft constant double precision := 5.0;
  v_row jsonb;
  v_cell text;
  v_day date;
  v_med double precision;
  v_p10 double precision;
  v_n integer;
  v_hash text;
  v_base double precision;
  v_disagree boolean;
  v_corroborated boolean;
  v_agreeing integer;
  v_held boolean;
  v_accepted integer := 0;
  v_held_count integer := 0;
  v_released integer := 0;
  v_keys text[] := '{}';
  v_key text;
  v_inserted integer;
  v_owner uuid;
  rel record;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'rows must be a non-empty array of at most 5000' using errcode = 'PT400';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and revoked_at is not null) then
    raise exception 'account_revoked' using errcode = 'PT403';
  end if;

  -- Validate every row before anything is written (finite numbers, a real calendar day, p10 <= median).
  for v_row in select * from jsonb_array_elements(p_rows) loop
    begin
      v_day := (v_row ->> 'day')::date;
      v_med := (v_row ->> 'median_ft')::double precision;
      v_p10 := (v_row ->> 'p10_ft')::double precision;
      v_n   := (v_row ->> 'n')::integer;
    exception when others then
      raise exception 'invalid_row' using errcode = 'PT400';
    end;
    if not isfinite(v_day) or v_day not between date '2020-01-01' and date '2100-01-01'
       or v_med in ('NaN', 'Infinity', '-Infinity') or v_p10 in ('NaN', 'Infinity', '-Infinity')
       or v_p10 > v_med or (v_row ->> 'h3_cell') is null or (v_row ->> 'uploader_hash') is null then
      raise exception 'invalid_row' using errcode = 'PT400';
    end if;
    v_keys := v_keys || ((v_row ->> 'h3_cell') || '|' || v_day::text);
  end loop;

  -- Serialise on every aggregate this batch touches, in sorted order (deadlock-free).
  for v_key in select distinct k from unnest(v_keys) as k order by k loop
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  end loop;
  v_keys := '{}';

  -- Unlink uploader ids from batch ledger rows once the 15-minute rate window has passed.
  update public.depth_batches set user_id = null
   where user_id is not null and received_at < now() - interval '15 minutes';

  insert into public.depth_batches (batch_id, user_id) values (p_batch_id, p_user_id)
  on conflict (batch_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select user_id into v_owner from public.depth_batches where batch_id = p_batch_id;
    -- owner is null once the ledger row has been unlinked: any replay is then simply a duplicate
    if v_owner is not null and v_owner <> p_user_id then
      raise exception 'batch_id_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('duplicate', true);
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_cell := v_row ->> 'h3_cell';
    v_day  := (v_row ->> 'day')::date;
    v_med  := (v_row ->> 'median_ft')::double precision;
    v_p10  := (v_row ->> 'p10_ft')::double precision;
    v_n    := (v_row ->> 'n')::integer;
    v_hash := v_row ->> 'uploader_hash';

    -- Sign convention: uploads are depth positive DOWN, the baseline is elevation positive UP,
    -- so the baseline depth is the negated elevation.
    select -b.baseline_elev_ft into v_base from public.baseline_cells b where b.cell_id = v_cell;
    v_disagree := v_base is not null
                  and (abs(v_med - v_base) > c_hold_ft or abs(v_p10 - v_base) > c_hold_ft);
    v_held := false;

    if v_disagree then
      select count(*) into v_agreeing
        from public.depth_uploads u
       where u.cell_id = v_cell
         and u.held_reason = 'baseline_disagreement'
         and u.day between v_day - 30 and v_day + 30
         and abs(u.median_ft - v_med) <= c_agree_ft
         and abs(u.p10_ft - v_p10) <= c_agree_ft
         and u.uploader_hash <> v_hash
         and u.uploader_hash <> all (p_self_hashes);

      select exists (
        select 1 from public.depth_uploads u
         where u.cell_id = v_cell
           and u.held_reason is null
           and u.day between v_day - 90 and v_day + 90
           and abs(u.median_ft - v_med) <= c_agree_ft
           and abs(u.p10_ft - v_p10) <= c_agree_ft
           and u.uploader_hash <> v_hash
           and u.uploader_hash <> all (p_self_hashes)
      ) into v_corroborated;

      v_held := not (v_corroborated or v_agreeing > 0);

      if v_agreeing > 0 and not v_held then
        for rel in
          update public.depth_uploads u
             set held_reason = null, held_on = null
           where u.cell_id = v_cell
             and u.held_reason = 'baseline_disagreement'
             and u.day between v_day - 30 and v_day + 30
             and abs(u.median_ft - v_med) <= c_agree_ft
             and abs(u.p10_ft - v_p10) <= c_agree_ft
             and u.uploader_hash <> v_hash
             and u.uploader_hash <> all (p_self_hashes)
          returning u.cell_id, u.day
        loop
          v_released := v_released + 1;
          v_keys := v_keys || (rel.cell_id || '|' || rel.day::text);
        end loop;
      end if;
    end if;

    -- Upsert-replace per (boat, cell, day). An admin hold on the existing row survives the replacement.
    insert into public.depth_uploads
      (uploader_hash, cell_id, day, median_ft, p10_ft, n, held_reason, held_on)
    values
      (v_hash, v_cell, v_day, v_med, v_p10, v_n,
       case when v_held then 'baseline_disagreement' end,
       case when v_held then (now() at time zone 'utc')::date end)
    on conflict (uploader_hash, cell_id, day) do update
      set median_ft   = excluded.median_ft,
          p10_ft      = excluded.p10_ft,
          n           = excluded.n,
          held_reason = case when depth_uploads.held_reason = 'admin' then 'admin'
                             else excluded.held_reason end,
          held_on     = case when depth_uploads.held_reason = 'admin' then null
                             else excluded.held_on end;

    if v_held then v_held_count := v_held_count + 1; else v_accepted := v_accepted + 1; end if;
    v_keys := v_keys || (v_cell || '|' || v_day::text);
  end loop;

  for v_key in select distinct k from unnest(v_keys) as k order by k loop
    perform public.recompute_depth_cell(split_part(v_key, '|', 1), split_part(v_key, '|', 2)::date);
  end loop;

  return jsonb_build_object('duplicate', false, 'accepted', v_accepted,
                            'held', v_held_count, 'released', v_released);
end
$$;

-- Replay check used by the depth-upload edge function BEFORE rate limiting, so a retry of an
-- already-accepted batch is answered as a duplicate instead of a 429. owner is null once the ledger
-- row has been unlinked from its user (15 minutes after receipt).
create or replace function public.depth_batch_lookup(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('found', true, 'owner', b.user_id) from public.depth_batches b where b.batch_id = p_batch_id),
    jsonb_build_object('found', false, 'owner', null));
$$;

-- Audit helper for the admin edge function (denied attempts, invalid requests, ban outcomes).
create or replace function public.admin_audit(
  p_actor uuid, p_action text, p_target_type text default null, p_target_id text default null,
  p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  -- Flood control: one row per actor per 10 minutes for denial / invalid-request noise.
  insert into public.audit_log (actor, action, target_type, target_id, details)
  select p_actor, left(p_action, 100), left(p_target_type, 100), left(p_target_id, 200),
         coalesce(p_details, '{}'::jsonb)
   where p_action not in ('admin.denied', 'admin.invalid_request')
      or not exists (select 1 from public.audit_log a
                      where a.actor is not distinct from p_actor and a.action = p_action
                        and a.created_at > now() - interval '10 minutes');
$$;

-- ======================================================================================
-- Admin actions. Each writes audit_log inside the same transaction as the change.
-- Callers (the admin edge function) have already checked the admin uid allow-list.
-- ======================================================================================

create or replace function public.admin_set_upload_held(p_actor uuid, p_upload uuid, p_held boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cell text;
  v_day date;
begin
  select cell_id, day into v_cell, v_day from public.depth_uploads where id = p_upload;
  if not found then
    raise exception 'upload_not_found' using errcode = 'PT404';
  end if;
  -- same per-aggregate lock as ingest, taken before the row changes
  perform pg_advisory_xact_lock(hashtextextended(v_cell || '|' || v_day::text, 0));
  update public.depth_uploads
     set held_reason = case when p_held then 'admin' end,
         held_on = null
   where id = p_upload;
  perform public.recompute_depth_cell(v_cell, v_day);
  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (p_actor, case when p_held then 'admin.hold_upload' else 'admin.release_upload' end,
          'depth_upload', p_upload::text, jsonb_build_object('cell_id', v_cell, 'day', v_day));
end
$$;

create or replace function public.admin_revoke_account(p_actor uuid, p_target uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set revoked_at = coalesce(revoked_at, now()) where id = p_target;
  if not found then
    raise exception 'profile_not_found' using errcode = 'PT404';
  end if;
  delete from public.last_positions where user_id = p_target;
  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (p_actor, 'admin.revoke_account', 'profile', p_target::text,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));
end
$$;

-- Bumps the epoch mixed into every daily salt. Hashes computed afterwards differ from those
-- computed before, even for the same day. (Rotating HMAC_SALT_SECRET itself is an env change.)
create or replace function public.admin_rotate_salt(p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_epoch integer;
begin
  update public.app_config
     set value = to_jsonb(((value #>> '{}')::integer + 1)), updated_at = now()
   where key = 'hmac_salt_epoch'
  returning (value #>> '{}')::integer into v_epoch;
  -- remember the UTC day this epoch became active (depth-upload only recomputes self-hashes for epochs
  -- that overlap a batch's +-90 day window)
  update public.app_config
     set value = value || jsonb_build_array(jsonb_build_object('epoch', v_epoch,
                                                               'from', to_char(now() at time zone 'utc', 'YYYY-MM-DD'))),
         updated_at = now()
   where key = 'hmac_salt_epochs';
  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (p_actor, 'admin.rotate_salt', 'app_config', 'hmac_salt_epoch', jsonb_build_object('epoch', v_epoch));
  return v_epoch;
end
$$;

create or replace function public.get_salt_epochs()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select value from public.app_config where key = 'hmac_salt_epochs';
$$;

create or replace function public.get_salt_epoch()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (value #>> '{}')::integer from public.app_config where key = 'hmac_salt_epoch';
$$;

create or replace function public.admin_list_held(p_actor uuid, p_limit integer default 100)
returns table (id uuid, cell_id text, day date, median_ft double precision, p10_ft double precision,
               n integer, held_reason text, baseline_depth_ft double precision)
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log (actor, action, target_type, details)
  values (p_actor, 'admin.list_held', 'depth_upload', jsonb_build_object('limit', p_limit));
  return query
    select u.id, u.cell_id::text, u.day, u.median_ft, u.p10_ft, u.n, u.held_reason, -b.baseline_elev_ft
      from public.depth_uploads u
      left join public.baseline_cells b on b.cell_id = u.cell_id
     where u.held
     order by u.day desc, u.id
     limit least(greatest(p_limit, 1), 500);
end
$$;

-- ======================================================================================
-- Account deletion (PRD retention table): removes profile, pings, votes, messages, positions
-- and memberships. Aggregated depth cells are NOT touched (they cannot be attributed).
-- Groups the user owns pass to the longest-standing other member, or are deleted if empty.
-- The edge function deletes the auth.users row afterwards.
-- ======================================================================================
create or replace function public.delete_account_data(p_user uuid, p_self boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g record;
  v_new_owner uuid;
  v_pings integer;
  v_msgs integer;
  v_votes integer;
begin
  -- A revoked account may not erase its own footprint (pings, votes, messages) to dodge review.
  -- Operator-initiated deletion calls this with p_self = false.
  if p_self and exists (select 1 from public.profiles where id = p_user and revoked_at is not null) then
    raise exception 'account_revoked' using errcode = 'PT403';
  end if;
  for g in select id from public.groups where owner_id = p_user loop
    select gm.user_id into v_new_owner
      from public.group_members gm
     where gm.group_id = g.id and gm.user_id <> p_user
     order by gm.joined_at, gm.user_id
     limit 1;
    if v_new_owner is null then
      delete from public.groups where id = g.id;
    else
      update public.group_members set role = 'member' where group_id = g.id and user_id = p_user;
      update public.group_members set role = 'owner'  where group_id = g.id and user_id = v_new_owner;
      update public.groups set owner_id = v_new_owner where id = g.id;
    end if;
  end loop;

  delete from public.ping_votes where voter_id = p_user;
  get diagnostics v_votes = row_count;
  delete from public.messages where author_id = p_user;
  get diagnostics v_msgs = row_count;
  delete from public.pings where author_id = p_user;
  get diagnostics v_pings = row_count;
  delete from public.depth_batches where user_id = p_user;
  delete from public.last_positions where user_id = p_user;
  delete from public.group_members where user_id = p_user;
  delete from public.profiles where id = p_user;

  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (p_user, 'account.delete', 'profile', p_user::text,
          jsonb_build_object('pings', v_pings, 'messages', v_msgs, 'votes', v_votes));
  return jsonb_build_object('pings', v_pings, 'messages', v_msgs, 'votes', v_votes);
end
$$;

-- Execute privileges: service_role only -------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('recompute_depth_cell','ingest_depth_batch','admin_set_upload_held',
                         'admin_revoke_account','admin_rotate_salt','get_salt_epoch','get_salt_epochs','admin_list_held',
                         'delete_account_data','depth_batch_lookup','admin_audit')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
