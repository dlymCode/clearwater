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

select plan(35);

-- 30 pings/h, 60 votes/h, 10 messages/min, 1 depth batch / 15 min, 10 join attempts / 15 min,
-- 1 position / 5 min -> HTTP 429 (SQLSTATE PT429). Counted from the append-only rate_events ledger.
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

-- M3: a bulk insert cannot sneak past the limit inside one statement
select throws_ok($$insert into public.pings (type, geom)
                   select 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 31)$$,
                 'PT429', null, 'M3: a single 31-row INSERT is refused (limit is enforced per row, not per statement)');
select is((select count(*) from public.pings), 31::bigint, 'M3: the refused bulk insert stored nothing (31 = u1''s 30 + u2''s 1)');

-- M3: deleting and re-posting does not reset the window
select tests.act_as(tests.u(1));
select is(tests.dml($$delete from public.pings$$), 30::bigint, 'u1 deletes their own 30 pings (RLS limits the delete to the author)');
select throws_ok($$insert into public.pings (type, geom) values ('log', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                 'PT429', null, 'M3: delete-and-repost does not reset the limit (events are counted, not surviving rows)');

-- retries of an existing client UUID do not consume budget
select tests.act_as(tests.u(3));
select lives_ok($$insert into public.pings (id, type, geom) values (tests.c(1), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$, 'u3 posts one ping');
select lives_ok($$insert into public.pings (id, type, geom) select tests.c(1), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 5)
                  on conflict (id) do nothing$$, 'five replays of the same client UUID');
select tests.act_admin();
select is((select count(*) from public.rate_events where user_id = tests.u(3) and bucket = 'ping'), 1::bigint, 'replays of an existing row are not counted');

-- window slides
update public.rate_events set at = now() - interval '61 minutes' where user_id = tests.u(1) and bucket = 'ping';
select is((select retry_after_s from public.rate_limit_status(tests.u(2), 'ping')), 0, 'retry_after_s is 0 while under the limit');
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.pings (type, geom) values ('log', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                'the window slides: events older than an hour no longer count');
select tests.act_admin();
select ok((select retry_after_s from public.rate_limit_status(tests.u(1), 'ping')) = 0, 'u1 has 1 event in the window: still allowed');

-- service role / seed data are not limited
select lives_ok($$insert into public.pings (author_id, type, geom)
                  select tests.u(3), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 40)$$,
                'service/superuser inserts (no JWT subject) are not rate limited');

-- ---- messages: 10/min --------------------------------------------------------------------------------------------
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.messages (group_id, body) select tests.g(), 'm' || i from generate_series(1, 10) i$$,
                '10 messages in a minute are accepted');
select throws_ok($$insert into public.messages (group_id, body) values (tests.g(), 'one too many')$$,
                 'PT429', null, 'the 11th message in a minute returns 429');
select is(tests.dml($$delete from public.messages where author_id = tests.u(1)$$), 10::bigint, 'u1 deletes their messages');
select throws_ok($$insert into public.messages (group_id, body) values (tests.g(), 'repost')$$,
                 'PT429', null, 'M3: message delete-and-repost does not reset the limit');
select tests.act_as(tests.u(2));
select lives_ok($$insert into public.messages (group_id, body) values (tests.g(), 'other user fine')$$, 'messages: limit is per user');
select tests.act_admin();
update public.rate_events set at = now() - interval '2 minutes' where user_id = tests.u(1) and bucket = 'message';
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.messages (group_id, body) values (tests.g(), 'window slid')$$, 'messages: window slides after a minute');

-- ---- votes: 60/h -------------------------------------------------------------------------------------------------------
select tests.act_admin();
insert into public.pings (author_id, type, geom)
  select tests.u(4), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 61);
insert into public.last_positions (user_id, geom) values (tests.u(5), st_setsrid(st_makepoint(-122.5, 48.3), 4326));
create temp table _vp as select id from public.pings where author_id = tests.u(4);
grant select on _vp to authenticated;
select tests.act_as(tests.u(5));
select lives_ok($$select public.cast_vote(p.id, 1::smallint) from (select id from _vp order by id limit 60) p$$,
                '60 votes in an hour are accepted');
select throws_ok($$select public.cast_vote(p.id, 1::smallint) from (select id from _vp order by id offset 60 limit 1) p$$,
                 'PT429', null, 'the 61st vote in an hour returns 429');

-- ---- depth batches / join / position: same ledger, same limiter ---------------------------------------------------------
select tests.act_service();
select is((select allowed from public.rate_limit_consume(tests.u(1), 'depth_batch')), true, 'depth_batch: first batch allowed');
select is((select allowed from public.rate_limit_consume(tests.u(1), 'depth_batch')), false, 'depth_batch: second batch inside 15 min refused');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'depth_batch')), 1, 'depth_batch limit is 1');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'ping')), 30, 'ping limit is 30');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'vote')), 60, 'vote limit is 60');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'message')), 10, 'message limit is 10');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'join_group')), 10, 'join_group limit is 10 per 15 min');
select is((select max_allowed from public.rate_limit_status(tests.u(1), 'position')), 1, 'position limit is 1 per 5 min');
select throws_ok($$select * from public.rate_limit_status(tests.u(1), 'nonsense')$$, '22023', null, 'unknown bucket is an error');

-- the ledger itself is service-only
select tests.act_as(tests.u(1));
select throws_ok($$select * from public.rate_events$$, '42501', null, 'rate_events: not readable by clients');
select throws_ok($$delete from public.rate_events$$, '42501', null, 'rate_events: not deletable by clients (cannot reset own limits)');
select throws_ok($$insert into public.rate_events (user_id, bucket) values (tests.u(1), 'ping')$$, '42501', null, 'rate_events: not writable by clients');
select throws_ok($$select public.rate_limit_consume(tests.u(1), 'ping')$$, '42501', null, 'rate_limit_consume: not callable by clients');

select * from finish();
rollback;
