-- Migration 4 of 8: helper predicates, triggers, rate limits, score_ping, RPCs.
--
-- HTTP status mapping: PostgREST turns a SQLSTATE of the form 'PTnnn' into HTTP status nnn,
-- so `raise ... using errcode = 'PT429'` reaches the app as a real 429.

-- ======================================================================================
-- Membership / visibility helpers (SECURITY DEFINER so RLS policies can call them without
-- recursing into the tables they protect). All read auth.uid() from the request JWT.
-- ======================================================================================

create or replace function public.auth_is_active()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select auth.uid() is not null
     and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.revoked_at is not null);
$$;

create or replace function public.is_group_member(p_group uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group and gm.user_id = auth.uid()
  );
$$;

create or replace function public.is_group_owner(p_group uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.groups g
    where g.id = p_group and g.owner_id = auth.uid()
  );
$$;

create or replace function public.shares_group_with(p_user uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.group_members mine
    join public.group_members theirs on theirs.group_id = mine.group_id
    where mine.user_id = auth.uid() and theirs.user_id = p_user
  );
$$;

-- PRD: reputation under 0.3 hides an account's pings from the public tier (its own group
-- still sees them). Revoked accounts are hidden from the public tier too.
create or replace function public.author_publicly_visible(p_author uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select round(pr.reputation::numeric, 4) >= 0.3 and pr.revoked_at is null from public.profiles pr where pr.id = p_author),
    false);
$$;

-- The single visibility rule for pings, used by the pings RLS policy, ping_feed, ping_votes_feed,
-- cast_vote and score_ping: public-tier pings (author reputation >= 0.3 and not revoked, or my own)
-- or any ping of a group I belong to. SECURITY DEFINER so it works for views owned by the migration
-- role and for policies alike. Service contexts (no JWT subject) are NOT given blanket access here;
-- callers that want that check auth.uid() themselves.
create or replace function public.ping_visible(p_group uuid, p_author uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when p_group is null then (p_author = auth.uid() or public.author_publicly_visible(p_author))
    else public.is_group_member(p_group)
  end;
$$;

-- Anonymous public pings carry the author's reputation (PRD) but not exactly: it is quantised to the
-- nearest 0.25 so the cached score and the feed do not fingerprint a boat among a dozen.
create or replace function public.ping_author_rep(p_anonymous boolean, p_rep double precision)
returns double precision
language sql immutable
as $$
  select case when p_anonymous then (round((p_rep * 4)::numeric) / 4)::double precision else p_rep end;
$$;

-- w(d): THE distance weight (docs/AGENT-PLAN.md). NULL distance -> 0; <= 200 m -> 1.0; <= 500 m -> 0.5; else 0.
-- Used by ping_vote_stats (score and feed), cast_vote eligibility and the reputation batch.
create or replace function public.vote_weight(p_dist_m double precision)
returns double precision
language sql immutable parallel safe
as $$
  select case
    when p_dist_m is null then 0.0
    when p_dist_m <= 200 then 1.0
    when p_dist_m <= 500 then 0.5
    else 0.0
  end::double precision;
$$;

-- ======================================================================================
-- Rate limits. One source of truth used by (a) BEFORE INSERT triggers, so limits hold even for
-- direct PostgREST inserts, (b) RPCs (join_group, report_position) and (c) the edge-function
-- middleware (_shared/rate-limit.ts).
--
--   ping 30/h, vote 60/h, message 10/min, depth_batch 1/15 min      (docs/AGENT-PLAN.md)
--   join_group 10/15 min (invite-code guessing), position 1/5 min,
--   group_create 5/h, promote_ping 30/h, rotate_invite_code 10/h     (added)
--
-- The ledger is public.rate_events (append-only, no client access). Counting events instead of
-- surviving rows means delete-and-repost cannot reset a limit. rate_limit_consume() serialises per
-- (user, bucket) with an advisory lock and records the event in the same statement, so a bulk
-- multi-row INSERT and concurrent requests are both counted.
-- ======================================================================================

create or replace function public.rate_limit_params(p_bucket text, out max_allowed integer, out window_s integer)
language plpgsql immutable
as $$
begin
  case p_bucket
    when 'ping'        then max_allowed := 30; window_s := 3600;
    when 'vote'        then max_allowed := 60; window_s := 3600;
    when 'message'     then max_allowed := 10; window_s := 60;
    when 'depth_batch' then max_allowed := 1;  window_s := 900;
    when 'join_group'  then max_allowed := 10; window_s := 900;
    when 'position'    then max_allowed := 1;  window_s := 300;
    when 'group_create' then max_allowed := 5; window_s := 3600;
    when 'promote'     then max_allowed := 30; window_s := 3600;
    when 'rotate_invite' then max_allowed := 10; window_s := 3600;
    else raise exception 'unknown rate-limit bucket: %', p_bucket using errcode = '22023';
  end case;
end
$$;

create or replace function public.rate_limit_status(
  p_user uuid,
  p_bucket text,
  out allowed boolean,
  out used integer,
  out max_allowed integer,
  out retry_after_s integer
)
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_window integer;
  v_oldest timestamptz;
begin
  select pr.max_allowed, pr.window_s into max_allowed, v_window from public.rate_limit_params(p_bucket) pr;
  select count(*), min(e.at) into used, v_oldest
    from public.rate_events e
   where e.user_id = p_user and e.bucket = p_bucket
     and e.at > now() - make_interval(secs => v_window);
  allowed := used < max_allowed;
  retry_after_s := case
    when allowed or v_oldest is null then 0
    else greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => v_window) - now())))::integer)
  end;
end
$$;

-- Check and, when allowed, record one event atomically (per user+bucket lock held to commit).
create or replace function public.rate_limit_consume(
  p_user uuid,
  p_bucket text,
  out allowed boolean,
  out used integer,
  out max_allowed integer,
  out retry_after_s integer
)
language plpgsql volatile security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_bucket, 0));
  select s.allowed, s.used, s.max_allowed, s.retry_after_s
    into allowed, used, max_allowed, retry_after_s
    from public.rate_limit_status(p_user, p_bucket) s;
  if allowed then
    insert into public.rate_events (user_id, bucket) values (p_user, p_bucket);
  end if;
end
$$;

-- Give back the most recent event (used when an operation fails after consuming its slot, so a transient
-- error does not burn a 15-minute depth-batch window). Service role only.
create or replace function public.rate_limit_refund(p_user uuid, p_bucket text)
returns void
language sql volatile security definer
set search_path = public
as $$
  delete from public.rate_events
   where id = (select e.id from public.rate_events e
                where e.user_id = p_user and e.bucket = p_bucket
                order by e.id desc limit 1);
$$;

-- BEFORE INSERT trigger for pings / messages (author_id) and ping_votes (voter_id).
-- A replay of a row that already exists (client retry with ON CONFLICT DO NOTHING) is not counted.
create or replace function public.tg_enforce_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text := tg_argv[0];
  v_user uuid;
  v_status record;
begin
  -- Service role / migrations / seed data have no JWT subject: not rate limited.
  if auth.uid() is null then
    return new;
  end if;
  -- (if/elsif, not CASE: PL/pgSQL resolves every field reference in a CASE up front)
  if v_bucket = 'vote' then
    v_user := new.voter_id;
    if exists (select 1 from public.ping_votes where ping_id = new.ping_id and voter_id = new.voter_id) then
      return new;
    end if;
  elsif v_bucket = 'ping' then
    v_user := new.author_id;
    if exists (select 1 from public.pings where id = new.id) then
      return new;
    end if;
  else
    v_user := new.author_id;
    if exists (select 1 from public.messages where id = new.id) then
      return new;
    end if;
  end if;
  select * into v_status from public.rate_limit_consume(v_user, v_bucket);
  if not v_status.allowed then
    raise exception 'rate_limit_exceeded:%', v_bucket
      using errcode = 'PT429',
            detail = format('limit %s per window, retry after %s s', v_status.max_allowed, v_status.retry_after_s),
            hint = v_status.retry_after_s::text;
  end if;
  return new;
end
$$;

-- ======================================================================================
-- Triggers
-- ======================================================================================

-- Pings: server clock wins for received_at; default expiry; initial score = author reputation
-- (quantised for anonymous pings, see ping_author_rep).
create or replace function public.tg_pings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.received_at := now();
  new.updated_at := now();
  new.score := public.ping_author_rep(new.anonymous, (select reputation from public.profiles where id = new.author_id));
  new.rep_processed_at := null;
  if new.expires_at is null then
    new.expires_at := new.created_at + interval '48 hours';
  end if;
  return new;
end
$$;

create trigger pings_before_insert
  before insert on public.pings
  for each row execute function public.tg_pings_before_insert();
create trigger pings_rate_limit
  before insert on public.pings
  for each row execute function public.tg_enforce_rate_limit('ping');

create or replace function public.tg_messages_before_insert()
returns trigger
language plpgsql
as $$
begin
  new.received_at := now();
  return new;
end
$$;
create trigger messages_before_insert
  before insert on public.messages
  for each row execute function public.tg_messages_before_insert();
create trigger messages_rate_limit
  before insert on public.messages
  for each row execute function public.tg_enforce_rate_limit('message');

create trigger ping_votes_rate_limit
  before insert on public.ping_votes
  for each row execute function public.tg_enforce_rate_limit('vote');

-- Invite codes: server generated, unambiguous alphabet, 7-day expiry.
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 symbols, no 0/O/1/I
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_code text := '';
  i integer;
begin
  for i in 0..7 loop
    v_code := v_code || substr(c_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_code;
end
$$;

create or replace function public.tg_groups_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status record;
begin
  if auth.uid() is not null and not exists (select 1 from public.groups where id = new.id) then
    select * into v_status from public.rate_limit_consume(auth.uid(), 'group_create');
    if not v_status.allowed then
      raise exception 'rate_limit_exceeded:group_create'
        using errcode = 'PT429', hint = v_status.retry_after_s::text;
    end if;
  end if;
  new.invite_code := public.generate_invite_code();
  new.invite_expires_at := now() + interval '7 days';
  return new;
end
$$;
create trigger groups_before_insert
  before insert on public.groups
  for each row execute function public.tg_groups_before_insert();

create or replace function public.tg_groups_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.group_members (group_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return new;
end
$$;
create trigger groups_after_insert
  after insert on public.groups
  for each row execute function public.tg_groups_after_insert();

-- Removing a member invalidates the old invite code, so a removed member cannot walk back in with
-- the code they already know. (A member leaving on their own does not rotate it.)
create or replace function public.tg_group_members_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'member' and auth.uid() is not null and auth.uid() <> old.user_id then
    update public.groups
       set invite_code = public.generate_invite_code(), invite_expires_at = now() + interval '7 days'
     where id = old.group_id and owner_id = auth.uid();
  end if;
  return old;
end
$$;
create trigger group_members_after_delete
  after delete on public.group_members
  for each row execute function public.tg_group_members_after_delete();

-- Position privacy: snap to a 100 m grid (UTM 10N metres) server-side regardless of what was sent and
-- stamp updated_at with the server clock. The once-per-5-minutes throttle lives in report_position().
create or replace function public.tg_last_positions_before_write()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.geom := extensions.ST_Transform(
                extensions.ST_SnapToGrid(extensions.ST_Transform(new.geom, 32610), 100),
                4326);
  new.updated_at := now();
  return new;
end
$$;
create trigger last_positions_before_write
  before insert or update on public.last_positions
  for each row execute function public.tg_last_positions_before_write();

-- audit_log is append-only for everyone, the service role included.
create or replace function public.tg_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end
$$;
create trigger audit_log_no_update
  before update or delete on public.audit_log
  for each row execute function public.tg_audit_log_immutable();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.tg_audit_log_immutable();

-- ======================================================================================
-- Vote aggregates. Per-vote data (voter, distance, exact reputation) NEVER leaves the server: joining
-- an exact voter_reputation back to profiles would de-anonymise the voter. Clients get only these four
-- numbers per ping (through ping_feed) and compute decay locally.
--
--   vote_sum        = quantize( SUM_i R_i * v_i * w(d_i) , 0.25 )  with quantize(x) = floor(x * 4 + 0.5) / 4
--                     (round half up; the sum is accumulated in (created_at, voter_id) order)
--   last_confirmed_at = created_at of the latest confirm (+1) vote
--   confirm_count / dispute_count = votes of that sign with w(d) > 0 (the votes that actually count)
--   Votes with created_at > p_at are ignored by all four (so p_at can be a historical instant).
-- SECURITY DEFINER with the same visibility rule as RLS: null for pings the caller cannot see.
-- ======================================================================================
create or replace function public.ping_vote_stats(
  p_ping_id uuid,
  p_at timestamptz default now(),
  out vote_sum double precision,
  out last_confirmed_at timestamptz,
  out confirm_count integer,
  out dispute_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_group uuid;
  v_author uuid;
  v_sum double precision := 0.0;
  v_w double precision;
  rec record;
begin
  select p.group_id, p.author_id into v_group, v_author from public.pings p where p.id = p_ping_id;
  if not found or (auth.uid() is not null and not public.ping_visible(v_group, v_author)) then
    vote_sum := null; last_confirmed_at := null; confirm_count := null; dispute_count := null;
    return;
  end if;

  confirm_count := 0;
  dispute_count := 0;
  for rec in
    select v.vote, v.voter_dist_m, v.created_at, pr.reputation
      from public.ping_votes v
      join public.profiles pr on pr.id = v.voter_id
     where v.ping_id = p_ping_id
       and v.created_at <= p_at
     order by v.created_at, v.voter_id
  loop
    v_w := public.vote_weight(rec.voter_dist_m);
    v_sum := v_sum + (rec.reputation * rec.vote::double precision) * v_w;
    if rec.vote = 1 then
      if last_confirmed_at is null or rec.created_at > last_confirmed_at then
        last_confirmed_at := rec.created_at;
      end if;
      if v_w > 0 then confirm_count := confirm_count + 1; end if;
    elsif v_w > 0 then
      dispute_count := dispute_count + 1;
    end if;
  end loop;
  vote_sum := floor(v_sum * 4 + 0.5) / 4;
end
$$;

-- ======================================================================================
-- score_ping: THE ping score. Clients compute it offline from ping_feed columns and must match this to
-- within 1e-12 (they use the SAME quantised vote_sum, so only the exponential can differ by an ulp).
--
--   S = R_a * (1 + vote_sum) * exp(-lambda * dt)
--
--   R_a       author reputation (profiles.reputation, current value); for ANONYMOUS pings quantised to
--             the nearest 0.25 (ping_feed.author_reputation is the same number)
--   vote_sum  quantize(SUM_i R_i * v_i * w(d_i), 0.25)  -- see ping_vote_stats; ping_feed.vote_sum
--   t0        least(created_at, received_at): a device clock running ahead cannot make a ping look fresh
--   t_last    max(t0, last_confirmed_at)                 -- ping_feed.last_confirmed_at
--   lambda    ln(2) / 86400 per second (half-life 24 h)
--   dt        max(0, seconds between at and t_last) as a float
--
-- Reference TypeScript (IEEE-754 doubles):
--   const lambda = Math.LN2 / 86400.0;
--   const t0 = Math.min(createdAt, receivedAt);
--   const tLast = lastConfirmedAt === null ? t0 : Math.max(t0, lastConfirmedAt);   // ms
--   const dt = Math.max(0, (nowMs - tLast) / 1000);
--   return authorReputation * (1.0 + voteSum) * Math.exp(-lambda * dt);
--
-- Render thresholds (client): S < 0.25 hidden; 0.25-0.5 faded; 0.5-1.5 normal; > 1.5 solid + count.
-- SECURITY DEFINER because clients cannot read pings.author_id; null for pings the caller cannot see.
-- With no JWT subject (service/batch) it is unrestricted.
-- ======================================================================================
create or replace function public.score_ping(p_ping_id uuid, p_at timestamptz default now())
returns double precision
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c_lambda constant double precision := ln(2::double precision) / 86400.0;
  v_ping record;
  v_stats record;
  v_tlast timestamptz;
  v_dt double precision;
begin
  select p.created_at, p.received_at, p.group_id, p.author_id, p.anonymous, pr.reputation
    into v_ping
    from public.pings p
    join public.profiles pr on pr.id = p.author_id
   where p.id = p_ping_id;
  if not found then
    return null;
  end if;
  if auth.uid() is not null and not public.ping_visible(v_ping.group_id, v_ping.author_id) then
    return null;
  end if;

  select * into v_stats from public.ping_vote_stats(p_ping_id, p_at);
  v_tlast := least(v_ping.created_at, coalesce(v_ping.received_at, v_ping.created_at));
  if v_stats.last_confirmed_at is not null and v_stats.last_confirmed_at > v_tlast then
    v_tlast := v_stats.last_confirmed_at;
  end if;
  v_dt := greatest(extract(epoch from (p_at - v_tlast))::double precision, 0.0);
  return public.ping_author_rep(v_ping.anonymous, v_ping.reputation)
         * (1.0 + v_stats.vote_sum) * exp(-c_lambda * v_dt);
end
$$;

-- ======================================================================================
-- RPCs used by the app (all SECURITY DEFINER; they re-check auth.uid()).
-- ======================================================================================

-- cast_vote: the only way to write ping_votes (direct inserts are not granted).
-- ERRORS (machine-readable; PostgREST returns HTTP status = nnn of SQLSTATE PTnnn, and the body
-- carries code / message / hint). The client may drop a queued vote silently on any 4xx below:
--   PT401 not_authenticated | PT403 account_revoked | PT400 invalid_vote
--   PT404 ping_not_found    | PT403 cannot_vote_own_ping
--   PT403 confirm_ineligible, hint = no_position | stale_position (> 24 h) | too_far (> 500 m)
--   PT429 rate_limit_exceeded:vote (retry later; do NOT drop)
-- FLT-2 confirm eligibility: the voter's last_positions row must be no older than 24 h and within
-- 500 m of the ping. Disputes are always allowed but store NULL / the real distance, so a dispute
-- from the dock weighs 0 in score_ping and is ignored by the reputation batch.
-- Idempotent: a repeat vote by the same voter returns the stored row (server wins).
create or replace function public.cast_vote(p_ping_id uuid, p_vote smallint)
returns public.ping_votes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_ping public.pings;
  v_lp public.last_positions;
  v_dist double precision;
  v_row public.ping_votes;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if not public.auth_is_active() then
    raise exception 'account_revoked' using errcode = 'PT403';
  end if;
  if p_vote not in (1, -1) then
    raise exception 'invalid_vote' using errcode = 'PT400';
  end if;

  select * into v_ping from public.pings where id = p_ping_id;
  -- Invisible and nonexistent pings look the same (404): no existence oracle for group pings.
  if not found or not public.ping_visible(v_ping.group_id, v_ping.author_id) then
    raise exception 'ping_not_found' using errcode = 'PT404';
  end if;
  if v_ping.author_id = v_uid then
    raise exception 'cannot_vote_own_ping' using errcode = 'PT403';
  end if;

  select * into v_lp from public.last_positions where user_id = v_uid;
  if found and v_lp.updated_at > now() - interval '24 hours' then
    v_dist := extensions.ST_Distance(v_lp.geom::extensions.geography, v_ping.geom::extensions.geography);
  end if;

  if p_vote = 1 and public.vote_weight(v_dist) = 0 then
    raise exception 'confirm_ineligible'
      using errcode = 'PT403',
            hint = case
                     when v_lp.user_id is null then 'no_position'
                     when v_dist is null then 'stale_position'
                     else 'too_far'
                   end,
            detail = 'A confirm requires a last-known position within 500 m of the ping in the last 24 h.';
  end if;

  insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m)
  values (p_ping_id, v_uid, p_vote, v_dist)
  on conflict (ping_id, voter_id) do nothing
  returning * into v_row;

  if v_row.ping_id is null then
    select * into v_row from public.ping_votes where ping_id = p_ping_id and voter_id = v_uid;
  else
    update public.pings
       set score = public.score_ping(p_ping_id, now()), updated_at = now()
     where id = p_ping_id;
  end if;
  return v_row;
end
$$;

-- promote_ping: explicit author action moving a group ping to the public tier.
create or replace function public.promote_ping(p_ping_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if not public.auth_is_active() then
    raise exception 'account_revoked' using errcode = 'PT403';
  end if;
  select * into v_status from public.rate_limit_consume(v_uid, 'promote');
  if not v_status.allowed then
    raise exception 'rate_limit_exceeded:promote' using errcode = 'PT429', hint = v_status.retry_after_s::text;
  end if;
  update public.pings
     set group_id = null, updated_at = now()
   where id = p_ping_id and author_id = v_uid and group_id is not null;
  if not found then
    raise exception 'ping_not_found' using errcode = 'PT404';
  end if;
end
$$;

-- join_group: redeem an invite code. Non-members cannot read `groups`, so this is the only door in.
-- Every attempt (valid or not) counts toward 10 per 15 minutes per user, so codes cannot be guessed.
-- Returns the group id, or NULL when the code is unknown / expired / rotated out. PT429 when throttled.
create or replace function public.join_group(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group uuid;
  v_status record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if not public.auth_is_active() then
    raise exception 'account_revoked' using errcode = 'PT403';
  end if;
  select * into v_status from public.rate_limit_consume(v_uid, 'join_group');
  if not v_status.allowed then
    raise exception 'rate_limit_exceeded:join_group' using errcode = 'PT429', hint = v_status.retry_after_s::text;
  end if;
  select g.id into v_group
    from public.groups g
   where g.invite_code = upper(btrim(p_code))
     and g.invite_expires_at > now();
  -- An unknown, expired or rotated-out code returns NULL rather than raising: an exception would roll
  -- back the attempt counter along with everything else, and the throttle would never fill.
  if v_group is null then
    return null;
  end if;
  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_uid, 'member')
  on conflict (group_id, user_id) do nothing;
  return v_group;
end
$$;

-- rotate_invite_code / get_invite_code: owner only. The code is not a selectable column of `groups`
-- (members cannot read it), so the owner reads it through get_invite_code().
create or replace function public.rotate_invite_code(p_group uuid)
returns table (invite_code text, invite_expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public.generate_invite_code();
  v_exp timestamptz := now() + interval '7 days';
  v_status record;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  select * into v_status from public.rate_limit_consume(auth.uid(), 'rotate_invite');
  if not v_status.allowed then
    raise exception 'rate_limit_exceeded:rotate_invite' using errcode = 'PT429', hint = v_status.retry_after_s::text;
  end if;
  update public.groups g
     set invite_code = v_code, invite_expires_at = v_exp
   where g.id = p_group and g.owner_id = auth.uid();
  if not found then
    raise exception 'not_group_owner' using errcode = 'PT403';
  end if;
  return query select v_code, v_exp;
end
$$;

create or replace function public.get_invite_code(p_group uuid)
returns table (invite_code text, invite_expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  return query
    select g.invite_code, g.invite_expires_at from public.groups g
     where g.id = p_group and g.owner_id = auth.uid();
  if not found then
    raise exception 'not_group_owner' using errcode = 'PT403';
  end if;
end
$$;

-- report_position: the only way to write last_positions (no direct insert/update grant).
-- Validates the Salish Sea box, snaps to 100 m (trigger), upserts, and silently does nothing when the
-- caller already reported within the last 5 minutes (the throttle survives delete + re-report).
create or replace function public.report_position(p_lat double precision, p_lon double precision)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_pt extensions.geometry;
  v_status record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if not public.auth_is_active() then
    raise exception 'account_revoked' using errcode = 'PT403';
  end if;
  if p_lat is null or p_lon is null
     or not (p_lat between -90 and 90 and p_lon between -180 and 180) then
    raise exception 'invalid_position' using errcode = 'PT400';
  end if;
  -- Snap to the 100 m grid FIRST and range-check the snapped point, the one that is stored: a coordinate
  -- on the very edge of the box would otherwise pass here and then fail the table CHECK (raw 23514).
  v_pt := extensions.ST_Transform(
            extensions.ST_SnapToGrid(
              extensions.ST_Transform(extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326), 32610), 100),
            4326);
  if not public.in_salish_sea(v_pt) then
    raise exception 'position_out_of_range' using errcode = 'PT400';
  end if;

  select * into v_status from public.rate_limit_consume(v_uid, 'position');
  if not v_status.allowed then
    return;
  end if;
  insert into public.last_positions (user_id, geom) values (v_uid, v_pt)
  on conflict (user_id) do update set geom = excluded.geom;
end
$$;

-- ======================================================================================
-- Read models. pings.author_id / rep_processed_at and ping_votes.voter_id / voter_dist_m are NOT
-- selectable by clients (column privileges + own-rows policy), so the app reads these two views.
-- They are owned by the migration role (which bypasses RLS) and re-implement the visibility rule in
-- WHERE; security_barrier stops user-supplied predicates from running before that filter.
-- ======================================================================================
create view public.ping_feed
with (security_barrier = true)
as
select
  p.id,
  case when p.anonymous and p.author_id is distinct from auth.uid() then null else p.author_id end as author_id,
  case when p.anonymous then null else pr.handle end                                                as author_handle,
  coalesce(public.ping_author_rep(p.anonymous, pr.reputation), 1.0)                                 as author_reputation,
  (p.author_id = auth.uid())                                                                       as mine,
  p.group_id, p.type, p.geom, p.note, p.created_at, p.received_at, p.expires_at,
  p.score, p.tide_ft, p.anonymous, p.updated_at,
  coalesce(vs.vote_sum, 0.0)          as vote_sum,
  vs.last_confirmed_at                as last_confirmed_at,
  coalesce(vs.confirm_count, 0)       as confirm_count,
  coalesce(vs.dispute_count, 0)       as dispute_count
from public.pings p
join public.profiles pr on pr.id = p.author_id
cross join lateral public.ping_vote_stats(p.id, now()) vs
where public.ping_visible(p.group_id, p.author_id);

comment on view public.ping_feed is
  'Client read model for pings. Hides author_id/handle on anonymous pings (except to the author); author_reputation is quantised to 0.25 for anonymous pings. vote_sum (quantised to 0.25), last_confirmed_at, confirm_count and dispute_count replace per-vote data: clients compute S = author_reputation * (1 + vote_sum) * exp(-lambda * (now - max(least(created_at, received_at), last_confirmed_at))).';

-- messages_feed: messages with the author's handle (group members only, same rule as the table policy).
create view public.messages_feed
with (security_barrier = true)
as
select m.id, m.group_id, m.author_id, pr.handle as author_handle, m.body, m.ping_id, m.created_at, m.received_at
from public.messages m
join public.profiles pr on pr.id = m.author_id
where public.is_group_member(m.group_id);

comment on view public.messages_feed is
  'Client read model for the group channel: messages joined to the author handle. Cursor column: received_at.';

-- ======================================================================================
-- Execute privileges. Default is deny; each function lists who may call it.
-- ======================================================================================
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('auth_is_active','is_group_member','is_group_owner','shares_group_with',
                         'author_publicly_visible','ping_visible','ping_author_rep','vote_weight','ping_vote_stats',
                         'rate_limit_refund','tg_auth_users_after_insert',
                         'rate_limit_params','rate_limit_status','rate_limit_consume','tg_enforce_rate_limit',
                         'tg_pings_before_insert','tg_messages_before_insert','generate_invite_code',
                         'tg_groups_before_insert','tg_groups_after_insert','tg_group_members_after_delete',
                         'tg_last_positions_before_write','tg_audit_log_immutable','score_ping','cast_vote',
                         'promote_ping','join_group','rotate_invite_code','get_invite_code','report_position')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- Callable by signed-in clients (RLS policies call the predicates; the rest are RPCs).
grant execute on function public.auth_is_active()                      to authenticated;
grant execute on function public.is_group_member(uuid)                 to authenticated;
grant execute on function public.is_group_owner(uuid)                  to authenticated;
grant execute on function public.shares_group_with(uuid)               to authenticated;
-- (author_publicly_visible is deliberately NOT granted: calling it would reveal who is revoked or
--  below the visibility threshold; ping_visible is SECURITY DEFINER and does not need the grant)
grant execute on function public.ping_visible(uuid, uuid)             to authenticated;
grant execute on function public.ping_vote_stats(uuid, timestamptz)    to authenticated;
-- (functions called inside a view are permission-checked against the caller, not the view owner)
grant execute on function public.ping_author_rep(boolean, double precision) to authenticated;
grant execute on function public.score_ping(uuid, timestamptz)         to authenticated;
grant execute on function public.cast_vote(uuid, smallint)             to authenticated;
grant execute on function public.promote_ping(uuid)                    to authenticated;
grant execute on function public.join_group(text)                      to authenticated;
grant execute on function public.rotate_invite_code(uuid)              to authenticated;
grant execute on function public.get_invite_code(uuid)                 to authenticated;
grant execute on function public.report_position(double precision, double precision) to authenticated;

-- ======================================================================================
-- A new auth user gets a minimal profile row immediately, so their first write never dies on the
-- profiles foreign key. The onboarding screen then sets the real handle / vessel name (UPDATE).
-- ======================================================================================
create or replace function public.tg_auth_users_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, handle)
  values (new.id, 'user_' || right(replace(new.id::text, '-', ''), 19))   -- 24 chars, the handle maximum
  on conflict (id) do nothing;
  return new;
end
$$;
revoke all on function public.tg_auth_users_after_insert() from public, anon, authenticated;
grant execute on function public.tg_auth_users_after_insert() to service_role;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_auth_users_after_insert();
