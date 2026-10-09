-- Migration 6 of 8: depth ingestion (hold rule + aggregation) and admin actions.
-- Every function here is SECURITY DEFINER and executable by service_role ONLY; they are called
-- from the edge functions (depth-upload, admin, account-delete), never from the app directly.

-- ======================================================================================
-- recompute_depth_cell: rebuild the (cell, day) aggregate from non-held uploads.
--   median_ft = n-weighted (lower) median of uploads' median_ft
--   p10_ft    = n-weighted 10th percentile of uploads' p10_ft
--   n         = sum(n)            boats = count(distinct uploader_hash)
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
  select
    public.weighted_quantile(array_agg(u.median_ft order by u.median_ft, u.id),
                             array_agg(u.n::double precision order by u.median_ft, u.id), 0.5),
    count(distinct u.uploader_hash),
    sum(u.n)
  into v_median, v_boats, v_n
  from public.depth_uploads u
  where u.cell_id = p_cell and u.day = p_day and not u.held;

  if v_boats is null or v_boats = 0 then
    delete from public.depth_cells where cell_id = p_cell and day = p_day;
    return;
  end if;

  select public.weighted_quantile(array_agg(u.p10_ft order by u.p10_ft, u.id),
                                  array_agg(u.n::double precision order by u.p10_ft, u.id), 0.10)
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
--   p_self_hashes  this user's hashes for the surrounding 90 days (same secret, same epoch), so
--                  "another boat" is exact even though hashes rotate daily.
--
-- Hold rule (PRD "Depth log trust" #4, docs/AGENT-PLAN.md):
--   a row is HELD (kept, excluded from depth_cells) when |median_ft - (-baseline_elev_ft)| > 15 AND no
--   other boat has a non-held upload for that cell within 90 days AND no other boat's held row
--   within 30 days agrees with it (|delta| <= 5 ft). If another boat's held row agrees, the new
--   row is accepted and the agreeing held rows are RELEASED. Rows with no baseline are never held.
--   Admin-held rows (held_reason = 'admin') are never auto-released.
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

  insert into public.depth_batches (batch_id, user_id) values (p_batch_id, p_user_id)
  on conflict (batch_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select user_id into v_owner from public.depth_batches where batch_id = p_batch_id;
    if v_owner is distinct from p_user_id then
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
    v_disagree := v_base is not null and abs(v_med - v_base) > c_hold_ft;
    v_held := false;

    if v_disagree then
      select count(*) into v_agreeing
        from public.depth_uploads u
       where u.cell_id = v_cell
         and u.held and u.held_reason = 'baseline_disagreement'
         and u.day between v_day - 30 and v_day + 30
         and abs(u.median_ft - v_med) <= c_agree_ft
         and u.uploader_hash <> v_hash
         and u.uploader_hash <> all (p_self_hashes);

      select exists (
        select 1 from public.depth_uploads u
         where u.cell_id = v_cell
           and not u.held
           and u.day between v_day - 90 and v_day + 90
           and u.uploader_hash <> v_hash
           and u.uploader_hash <> all (p_self_hashes)
      ) into v_corroborated;

      v_held := not (v_corroborated or v_agreeing > 0);

      if v_agreeing > 0 and not v_held then
        for rel in
          update public.depth_uploads u
             set held = false, held_reason = null
           where u.cell_id = v_cell
             and u.held and u.held_reason = 'baseline_disagreement'
             and u.day between v_day - 30 and v_day + 30
             and abs(u.median_ft - v_med) <= c_agree_ft
             and u.uploader_hash <> v_hash
             and u.uploader_hash <> all (p_self_hashes)
          returning u.cell_id, u.day
        loop
          v_released := v_released + 1;
          v_keys := v_keys || (rel.cell_id || '|' || rel.day::text);
        end loop;
      end if;
    end if;

    insert into public.depth_uploads
      (uploader_hash, cell_id, day, median_ft, p10_ft, n, held, held_reason)
    values
      (v_hash, v_cell, v_day, v_med, v_p10, v_n, v_held,
       case when v_held then 'baseline_disagreement' end);

    if v_held then v_held_count := v_held_count + 1; else v_accepted := v_accepted + 1; end if;
    v_keys := v_keys || (v_cell || '|' || v_day::text);
  end loop;

  for v_key in select distinct k from unnest(v_keys) as k loop
    perform public.recompute_depth_cell(split_part(v_key, '|', 1), split_part(v_key, '|', 2)::date);
  end loop;

  update public.depth_batches
     set row_count = v_accepted + v_held_count, held_count = v_held_count
   where batch_id = p_batch_id;

  return jsonb_build_object('duplicate', false, 'accepted', v_accepted,
                            'held', v_held_count, 'released', v_released);
end
$$;

-- Replay check used by the depth-upload edge function BEFORE rate limiting, so a retry of an
-- already-accepted batch is answered as a duplicate instead of a 429.
create or replace function public.depth_batch_owner(p_batch_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select user_id from public.depth_batches where batch_id = p_batch_id;
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
  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (p_actor, left(p_action, 100), left(p_target_type, 100), left(p_target_id, 200),
          coalesce(p_details, '{}'::jsonb));
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
  update public.depth_uploads
     set held = p_held,
         held_reason = case when p_held then 'admin' end
   where id = p_upload
  returning cell_id, day into v_cell, v_day;
  if not found then
    raise exception 'upload_not_found' using errcode = 'PT404';
  end if;
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
  insert into public.audit_log (actor, action, target_type, target_id, details)
  values (p_actor, 'admin.rotate_salt', 'app_config', 'hmac_salt_epoch', jsonb_build_object('epoch', v_epoch));
  return v_epoch;
end
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
create or replace function public.delete_account_data(p_user uuid)
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
                         'admin_revoke_account','admin_rotate_salt','get_salt_epoch','admin_list_held',
                         'delete_account_data','depth_batch_owner','admin_audit')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
