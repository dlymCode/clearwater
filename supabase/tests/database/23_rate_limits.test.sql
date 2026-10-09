-- pgTAP test file for Clearwater. Runs with `supabase test db` (CI) inside one transaction that
-- is rolled back at the end. The helper block and fixture below are repeated in every file on
-- purpose: pg_prove runs each file in its own session, so files cannot share temp state.
begin;
create extension if not exists pgtap with schema extensions;

-- ---- helpers --------------------------------------------------------------------------
create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- Become a signed-in user (JWT claims + Postgres role), as PostgREST does per request.
create or replace function tests.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function tests.act_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;
create or replace function tests.act_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
-- Back to the superuser session role (fixture setup / ground-truth reads).
create or replace function tests.act_admin() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
end $$;
-- Fixture ids: tests.u(1..4) are users u1..u4; tests.g() is the fixture group.
create or replace function tests.u(i integer) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-0000000000a' || i::text)::uuid $$;
create or replace function tests.g() returns uuid language sql immutable as $$
  select '00000000-0000-0000-0000-0000000000b1'::uuid $$;
create or replace function tests.c(i integer) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-000000000' || lpad(to_hex(3072 + i), 3, '0'))::uuid $$;
-- Run one DML statement as the current role and return the affected row count.
create or replace function tests.dml(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- fixture (created as the superuser session role) -------------------------------
-- u1 = group owner, u2 = group member, u3 = signed-in non-member, u4 = bystander
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'u1@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'u2@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'u3@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'u4@example.test');
insert into public.profiles (id, handle, vessel_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner_one', 'F/V One'),
  ('00000000-0000-0000-0000-0000000000a2', 'member_two', 'F/V Two'),
  ('00000000-0000-0000-0000-0000000000a3', 'outsider_three', 'F/V Three'),
  ('00000000-0000-0000-0000-0000000000a4', 'bystander_four', 'F/V Four');
-- Group G owned by u1 (the groups trigger makes u1 the owner member), u2 joins as member.
insert into public.groups (id, name, owner_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'Skagit Crew', '00000000-0000-0000-0000-0000000000a1');
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', 'member');

select plan(19);

-- 30 pings/h, 60 votes/h, 10 messages/min, 1 depth batch / 15 min -> HTTP 429 (SQLSTATE PT429).
select tests.act_admin();
insert into auth.users (id, email) select tests.u(i), 'v' || i || '@example.test' from generate_series(5, 8) i;
insert into public.profiles (id, handle) select tests.u(i), 'voter_' || i from generate_series(5, 8) i;

-- ---- pings: the 31st in an hour is refused -----------------------------------------------------------
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.pings (type, geom)
                  select 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 30)$$,
                '30 pings in an hour are accepted');
select throws_ok($$insert into public.pings (type, geom) values ('log', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                 'PT429', null, 'the 31st ping in an hour returns 429');
select tests.act_as(tests.u(2));
select lives_ok($$insert into public.pings (type, geom) values ('log', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                'limits are per user: another user is unaffected');
select tests.act_admin();
select is((select retry_after_s from public.rate_limit_status(tests.u(1), 'ping')) between 1 and 3600, true, 'retry_after_s is reported');
update public.pings set received_at = now() - interval '61 minutes' where author_id = tests.u(1);
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.pings (type, geom) values ('log', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                'the window slides: pings older than an hour no longer count');
-- service role / seed data are not limited
select tests.act_admin();
select lives_ok($$insert into public.pings (author_id, type, geom)
                  select tests.u(3), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 40)$$,
                'service/superuser inserts (no JWT subject) are not rate limited');

-- ---- messages: 10/min --------------------------------------------------------------------------------------------
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.messages (group_id, body) select tests.g(), 'm' || i from generate_series(1, 10) i$$,
                '10 messages in a minute are accepted');
select throws_ok($$insert into public.messages (group_id, body) values (tests.g(), 'one too many')$$,
                 'PT429', null, 'the 11th message in a minute returns 429');
select tests.act_as(tests.u(2));
select lives_ok($$insert into public.messages (group_id, body) values (tests.g(), 'other user fine')$$, 'messages: limit is per user');
select tests.act_admin();
update public.messages set received_at = now() - interval '2 minutes' where author_id = tests.u(1);
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.messages (group_id, body) values (tests.g(), 'window slid')$$, 'messages: window slides after a minute');

-- ---- votes: 60/h -------------------------------------------------------------------------------------------------------
-- 61 pings by u3 (inserted by the superuser) + positions so u5 is eligible to vote on all of them.
select tests.act_admin();
insert into public.pings (author_id, type, geom)
  select tests.u(4), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 61);
insert into public.last_positions (user_id, geom) values (tests.u(5), st_setsrid(st_makepoint(-122.5, 48.3), 4326));
select tests.act_as(tests.u(5));
select lives_ok($$select public.cast_vote(p.id, 1::smallint) from (select id from public.pings where author_id = tests.u(4) order by id limit 60) p$$,
                '60 votes in an hour are accepted');
select throws_ok($$select public.cast_vote(p.id, 1::smallint) from (select id from public.pings where author_id = tests.u(4) order by id offset 60 limit 1) p$$,
                 'PT429', null, 'the 61st vote in an hour returns 429');

-- ---- depth batches / edge-function view of the same limiter ------------------------------------------------------------
select tests.act_service();
select is((select allowed from public.rate_limit_status(tests.u(1), 'depth_batch')), true, 'rate_limit_status: depth_batch allowed with no batch');
insert into public.depth_batches (batch_id, user_id) values (gen_random_uuid(), tests.u(1));
select is((select allowed from public.rate_limit_status(tests.u(1), 'depth_batch')), false, 'rate_limit_status: second batch inside 15 min refused');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'depth_batch')), 1, 'depth_batch limit is 1');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'ping')), 30, 'ping limit is 30');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'vote')), 60, 'vote limit is 60');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'message')), 10, 'message limit is 10');
select throws_ok($$select * from public.rate_limit_status(tests.u(1), 'nonsense')$$, '22023', null, 'unknown bucket is an error');

select * from finish();
rollback;
