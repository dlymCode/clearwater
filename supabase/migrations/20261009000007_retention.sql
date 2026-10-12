-- Migration 7 of 8: data retention (PRD "Data retention") as callable functions + pg_cron schedules.
--
--   pings            1 year in the database (clients hide them at 48 h)
--   ping_votes       1 year (cascade from pings; also purged by their own age)
--   depth daily cells 180 days, then rolled into 90-day aggregates only
--   depth_uploads    180 days of sounding age (same horizon as the daily cells they feed);
--                    baseline-held rows that never found a second boat are purged by RECEIPT day
--                    (held_on), not sounding day: a row survives through held_on + 30 and goes in
--                    the first run on UTC day held_on + 31. A late backlog upload of an old
--                    sounding therefore still gets its full 30-day chance to be corroborated.
--   last_positions   24 hours
--   messages         90 days (by server receipt time, so a device clock cannot extend it)
--   rate_events      2 hours (the longest window is 1 h)
--   depth_batches    7 days (idempotency ledger); its uid is nulled after 15 minutes
--
-- All functions take an explicit "now" so pgTAP can run them against fixtures.

-- 90-day aligned bucket start for a day: 1970-01-01 + 90 * floor(days_since_epoch / 90)
create or replace function public.depth_bucket_start(p_day date)
returns date
language sql
immutable
parallel safe
as $$
  select (date '1970-01-01' + (floor((p_day - date '1970-01-01')::numeric / 90) * 90)::integer);
$$;

-- Roll daily cells older than 180 days into 90-day aggregates, then delete the daily rows.
-- Merging with an existing aggregate treats it as one more sample weighted by its n, so the run
-- is incremental and safe to repeat (nothing left to roll => no-op).
create or replace function public.roll_old_depth_cells(p_today date default (now() at time zone 'utc')::date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  with old as (
    select c.cell_id, public.depth_bucket_start(c.day) as bs, c.median_ft, c.p10_ft, c.n, c.boats
      from public.depth_cells c
     where c.day < p_today - 180
       and c.boats >= 3        -- cells never publishable (< 3 boats) are deleted, not rolled up
  ),
  keys as (select distinct cell_id, bs from old),
  samples as (
    select cell_id, bs, median_ft, p10_ft, n::double precision as w, boats from old
    union all
    select a.cell_id, a.period_start, a.median_ft, a.p10_ft, a.n::double precision, a.boats
      from public.depth_cell_aggregates a
      join keys k on k.cell_id = a.cell_id and k.bs = a.period_start
  ),
  merged as (
    select s.cell_id, s.bs,
           public.weighted_quantile(array_agg(s.median_ft order by s.median_ft, s.w, s.p10_ft),
                                    array_agg(s.w order by s.median_ft, s.w, s.p10_ft), 0.5) as median_ft,
           public.weighted_quantile(array_agg(s.p10_ft order by s.p10_ft, s.w, s.median_ft),
                                    array_agg(s.w order by s.p10_ft, s.w, s.median_ft), 0.10) as p10_ft,
           least(sum(s.w), 2000000000)::integer as n,
           max(s.boats) as boats
      from samples s
     group by s.cell_id, s.bs
  )
  insert into public.depth_cell_aggregates (cell_id, period_start, median_ft, p10_ft, n, boats)
  select m.cell_id, m.bs, m.median_ft, m.p10_ft, m.n, m.boats
    from merged m
  on conflict (cell_id, period_start) do update
    set median_ft = excluded.median_ft,
        p10_ft    = excluded.p10_ft,
        n         = excluded.n,
        boats     = excluded.boats;

  delete from public.depth_cells where day < p_today - 180;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

create or replace function public.purge_last_positions(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  delete from public.last_positions where updated_at < p_now - interval '24 hours';
  get diagnostics v_n = row_count;
  -- same 15-minute housekeeping job: expire rate-limit events and unlink old depth batch ledger rows
  delete from public.rate_events where at < p_now - interval '2 hours';
  update public.depth_batches set user_id = null
   where user_id is not null and received_at < p_now - interval '15 minutes';
  return v_n;
end
$$;

create or replace function public.run_retention(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (p_now at time zone 'utc')::date;
  v_pings integer;
  v_votes integer;
  v_messages integer;
  v_positions integer;
  v_rolled integer;
  v_uploads integer;
  v_held integer;
  v_batches integer;
  v_result jsonb;
begin
  -- Roll first, so a failed delete never loses the aggregate.
  v_rolled := public.roll_old_depth_cells(v_today);

  delete from public.depth_uploads where day < v_today - 180;
  get diagnostics v_uploads = row_count;

  delete from public.depth_uploads
   where held_reason = 'baseline_disagreement' and held_on < v_today - 30;
  get diagnostics v_held = row_count;

  delete from public.ping_votes where created_at < p_now - interval '1 year';
  get diagnostics v_votes = row_count;

  delete from public.pings where received_at < p_now - interval '1 year';
  get diagnostics v_pings = row_count;

  delete from public.messages where received_at < p_now - interval '90 days';
  get diagnostics v_messages = row_count;

  v_positions := public.purge_last_positions(p_now);

  delete from public.depth_batches where received_at < p_now - interval '7 days';
  get diagnostics v_batches = row_count;

  v_result := jsonb_build_object(
    'depth_cells_rolled_and_deleted', v_rolled,
    'depth_uploads_deleted', v_uploads,
    'stale_held_uploads_deleted', v_held,
    'ping_votes_deleted', v_votes,
    'pings_deleted', v_pings,
    'messages_deleted', v_messages,
    'last_positions_deleted', v_positions,
    'depth_batches_deleted', v_batches);

  insert into public.audit_log (actor, action, target_type, details)
  values (null, 'retention.run', 'system', v_result);
  return v_result;
end
$$;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('depth_bucket_start','roll_old_depth_cells','purge_last_positions','run_retention')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- Schedules (cron-ready). pg_cron is available on Supabase; skipped quietly where it is not
-- (for example a bare Postgres in CI). Weekly reputation is scheduled in supabase/README.md
-- because it must call the reputation-batch edge function with the project's URL and key.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available (%): retention schedules not created', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('clearwater-purge-positions', '*/15 * * * *', 'select public.purge_last_positions()');
    perform cron.schedule('clearwater-retention',       '17 3 * * *',  'select public.run_retention()');
  end if;
end
$$;
