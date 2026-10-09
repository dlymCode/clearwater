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

select plan(41);

select tests.act_admin();
insert into public.messages (id, group_id, author_id, body) values
  (tests.c(1), tests.g(), tests.u(1), 'tender at the dock at 0600');
insert into public.pings (id, author_id, group_id, type, geom) values
  (tests.c(2), tests.u(3), null, 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326));
insert into public.groups (id, name, owner_id) values ('00000000-0000-0000-0000-0000000000b2', 'Other crew', tests.u(3));
insert into public.pings (id, author_id, group_id, type, geom) values
  (tests.c(3), tests.u(3), '00000000-0000-0000-0000-0000000000b2', 'gear', st_setsrid(st_makepoint(-122.5, 48.3), 4326));

-- =============================== messages: select ==============================================
select tests.act_as(tests.u(1));
select is((select count(*) from public.messages), 1::bigint, 'messages select: owner');
select tests.act_as(tests.u(2));
select is((select count(*) from public.messages), 1::bigint, 'messages select: member');
select tests.act_as(tests.u(3));
select is((select count(*) from public.messages), 0::bigint, 'messages select: non-member sees none');
select tests.act_anon();
select throws_ok($$select * from public.messages$$, '42501', null, 'messages select: anon denied');

-- =============================== messages: insert ==============================================
select tests.act_as(tests.u(2));
select lives_ok($$insert into public.messages (id, group_id, body) values (tests.c(4), tests.g(), 'copy, leaving now')$$,
                'messages insert: member posts (author defaults to uid)');
select is(tests.dml($$insert into public.messages (id, group_id, body) values (tests.c(4), tests.g(), 'copy, leaving now') on conflict (id) do nothing$$),
          0::bigint, 'messages insert: replay with the same client UUID is a no-op');
select lives_ok($$insert into public.messages (id, group_id, body, ping_id) values (tests.c(5), tests.g(), 'see this one', tests.c(2))$$,
                'messages insert: can reference a public ping');
select throws_ok($$insert into public.messages (group_id, body, ping_id) values (tests.g(), 'x', tests.c(3))$$,
                 '42501', null, 'messages insert: cannot attach a ping from another group');
select throws_ok($$insert into public.messages (group_id, body) values (tests.g(), repeat('z', 501))$$,
                 '23514', null, 'messages insert: 501 chars rejected');
select throws_ok($$insert into public.messages (group_id, author_id, body) values (tests.g(), tests.u(1), 'forged')$$,
                 '42501', null, 'messages insert: cannot forge another author');
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.messages (group_id, body) values (tests.g(), 'owner here')$$, 'messages insert: owner posts');
select tests.act_as(tests.u(3));
select throws_ok($$insert into public.messages (group_id, body) values (tests.g(), 'let me in')$$,
                 '42501', null, 'messages insert: non-member denied');
select tests.act_anon();
select throws_ok($$insert into public.messages (group_id, author_id, body) values (tests.g(), tests.u(1), 'x')$$,
                 '42501', null, 'messages insert: anon denied');

-- =============================== messages: update ==============================================
select tests.act_as(tests.u(1));
select throws_ok($$update public.messages set body = 'edited' where id = tests.c(1)$$, '42501', null, 'messages update: owner/author denied');
select tests.act_as(tests.u(2));
select throws_ok($$update public.messages set body = 'edited' where id = tests.c(4)$$, '42501', null, 'messages update: member denied');
select tests.act_as(tests.u(3));
select throws_ok($$update public.messages set body = 'edited'$$, '42501', null, 'messages update: non-member denied');
select tests.act_anon();
select throws_ok($$update public.messages set body = 'edited'$$, '42501', null, 'messages update: anon denied');

-- =============================== messages: delete ==============================================
select tests.act_as(tests.u(3));
select is(tests.dml($$delete from public.messages$$), 0::bigint, 'messages delete: non-member deletes nothing');
select tests.act_anon();
select throws_ok($$delete from public.messages$$, '42501', null, 'messages delete: anon denied');
select tests.act_as(tests.u(2));
select is(tests.dml($$delete from public.messages where id = tests.c(1)$$), 0::bigint, 'messages delete: member cannot delete another''s message');
select is(tests.dml($$delete from public.messages where id = tests.c(5)$$), 1::bigint, 'messages delete: author deletes own message');
select tests.act_as(tests.u(1));
select is(tests.dml($$delete from public.messages where id = tests.c(4)$$), 1::bigint, 'messages delete: group owner moderates a member''s message');

-- =============================== last_positions =================================================
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.last_positions (user_id, geom) values (tests.u(1), st_setsrid(st_makepoint(-122.50123, 48.30456), 4326))$$,
                'last_positions insert: owner reports a position');
select ok((select abs(st_x(st_transform(geom, 32610)) - round(st_x(st_transform(geom, 32610)) / 100) * 100) < 0.01
              and abs(st_y(st_transform(geom, 32610)) - round(st_y(st_transform(geom, 32610)) / 100) * 100) < 0.01
             from public.last_positions where user_id = tests.u(1)),
          'last_positions insert: stored position is snapped to a 100 m grid server-side');
select throws_ok($$insert into public.last_positions (user_id, geom) values (tests.u(2), st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                 '42501', null, 'last_positions insert: cannot report for someone else');
select tests.act_as(tests.u(2));
select lives_ok($$insert into public.last_positions (user_id, geom) values (tests.u(2), st_setsrid(st_makepoint(-122.51, 48.31), 4326))$$,
                'last_positions insert: member reports a position');
select is((select count(*) from public.last_positions), 2::bigint, 'last_positions select: group mates see each other and themself');
select tests.act_as(tests.u(3));
select is((select count(*) from public.last_positions), 0::bigint, 'last_positions select: non-member sees none');
select tests.act_anon();
select throws_ok($$select * from public.last_positions$$, '42501', null, 'last_positions select: anon denied');
select throws_ok($$insert into public.last_positions (user_id, geom) values (tests.u(1), st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                 '42501', null, 'last_positions insert: anon denied');

select tests.act_as(tests.u(1));
select throws_ok($$update public.last_positions set geom = st_setsrid(st_makepoint(-122.6, 48.4), 4326) where user_id = tests.u(1)$$,
                 'PT429', null, 'last_positions update: second update inside 5 minutes is throttled (429)');
select tests.act_admin();
alter table public.last_positions disable trigger last_positions_before_write;
update public.last_positions set updated_at = now() - interval '6 minutes' where user_id = tests.u(1);
alter table public.last_positions enable trigger last_positions_before_write;
select tests.act_as(tests.u(1));
select is(tests.dml($$update public.last_positions set geom = st_setsrid(st_makepoint(-122.6, 48.4), 4326) where user_id = tests.u(1)$$),
          1::bigint, 'last_positions update: owner may update after 5 minutes');
select is(tests.dml($$update public.last_positions set geom = st_setsrid(st_makepoint(-122.6, 48.4), 4326) where user_id = tests.u(2)$$),
          0::bigint, 'last_positions update: cannot move a group mate');
select throws_ok($$update public.last_positions set user_id = tests.u(3) where user_id = tests.u(1)$$, '42501', null,
                 'last_positions update: user_id is immutable (column privilege)');
select tests.act_as(tests.u(3));
select is(tests.dml($$update public.last_positions set geom = st_setsrid(st_makepoint(-122.6, 48.4), 4326)$$), 0::bigint,
          'last_positions update: non-member updates nothing');
select tests.act_anon();
select throws_ok($$update public.last_positions set geom = st_setsrid(st_makepoint(-122.6, 48.4), 4326)$$,
                 '42501', null, 'last_positions update: anon denied');

-- stale rows (> 24 h) are invisible even before the purge job runs
select tests.act_admin();
alter table public.last_positions disable trigger last_positions_before_write;
update public.last_positions set updated_at = now() - interval '25 hours' where user_id = tests.u(2);
alter table public.last_positions enable trigger last_positions_before_write;
select tests.act_as(tests.u(1));
select is((select count(*) from public.last_positions where user_id = tests.u(2)), 0::bigint,
          'last_positions select: a position older than 24 h is not readable');

select tests.act_as(tests.u(3));
select is(tests.dml($$delete from public.last_positions$$), 0::bigint, 'last_positions delete: non-member deletes nothing');
select tests.act_anon();
select throws_ok($$delete from public.last_positions$$, '42501', null, 'last_positions delete: anon denied');
select tests.act_as(tests.u(1));
select is(tests.dml($$delete from public.last_positions where user_id = tests.u(2)$$), 0::bigint, 'last_positions delete: cannot delete a group mate''s row');
select is(tests.dml($$delete from public.last_positions where user_id = tests.u(1)$$), 1::bigint, 'last_positions delete: owner turns sharing off');

select * from finish();
rollback;
