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

select plan(17);

-- Fixture: authors u1..u4, voters u5 and u6 (3 days old pings are eligible; the batch needs >= 48 h).
select tests.act_admin();
insert into auth.users (id, email) values (tests.u(5), 'u5@example.test'), (tests.u(6), 'u6@example.test');
insert into public.profiles (id, handle) values (tests.u(5), 'voter_five'), (tests.u(6), 'voter_six');
update public.profiles set reputation = 0.25 where id = tests.u(3);
update public.profiles set reputation = 2.98 where id = tests.u(4);

-- ping id scheme: c(1..3) = u1's a1 a2 a3 ; c(4..7) = u2's ; c(8) = u3's ; c(9) = u4's ; c(10) = u1 fresh ping
insert into public.pings (id, author_id, type, geom) select tests.c(i), tests.u(1), 'bar_moved', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(1, 3) i;
insert into public.pings (id, author_id, type, geom) select tests.c(i), tests.u(2), 'bar_moved', st_setsrid(st_makepoint(-122.5, 48.3), 4326) from generate_series(4, 7) i;
insert into public.pings (id, author_id, type, geom) values
  (tests.c(8),  tests.u(3), 'log',       st_setsrid(st_makepoint(-122.5, 48.3), 4326)),
  (tests.c(9),  tests.u(4), 'gear',      st_setsrid(st_makepoint(-122.5, 48.3), 4326)),
  (tests.c(10), tests.u(1), 'bar_moved', st_setsrid(st_makepoint(-122.5, 48.3), 4326));
update public.pings set received_at = now() - interval '3 days' where id <> tests.c(10);

-- a1: 2 confirms ; a2: 2 disputes ; a3: 2 disputes from the dock (5 km / unknown) => ignored
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m) values
  (tests.c(1), tests.u(5),  1, 100), (tests.c(1), tests.u(6),  1, 150),
  (tests.c(2), tests.u(5), -1, 100), (tests.c(2), tests.u(6), -1, 150),
  (tests.c(3), tests.u(5), -1, 5000), (tests.c(3), tests.u(6), -1, null),
-- u2: b1, b2, b3 each 2 confirms; b4 only 1 confirm
  (tests.c(4), tests.u(5),  1, 100), (tests.c(4), tests.u(6),  1, 100),
  (tests.c(5), tests.u(5),  1, 100), (tests.c(5), tests.u(6),  1, 100),
  (tests.c(6), tests.u(5),  1, 100), (tests.c(6), tests.u(6),  1, 100),
  (tests.c(7), tests.u(5),  1, 100),
-- u3 (rep 0.25): 2 disputes => 0.15 => clamped to 0.2
  (tests.c(8), tests.u(5), -1, 100), (tests.c(8), tests.u(6), -1, 100),
-- u4 (rep 2.98): 2 confirms => 3.03 => clamped to 3.0
  (tests.c(9), tests.u(5),  1, 100), (tests.c(9), tests.u(6),  1, 100),
-- the fresh ping has 2 confirms but is under 48 h old
  (tests.c(10), tests.u(5), 1, 100), (tests.c(10), tests.u(6), 1, 100);

select tests.act_as(tests.u(1));
select throws_ok($$select public.run_reputation_batch()$$, '42501', null, 'run_reputation_batch: signed-in users cannot trigger it');
select tests.act_service();

select is((public.run_reputation_batch()) ->> 'pings_evaluated', '9', 'batch evaluates the 9 pings older than 48 h and skips the fresh one');
select is((public.run_reputation_batch() ) ->> 'pings_evaluated', '0', 'a second run evaluates nothing (idempotent)');

select tests.act_admin();
select ok(abs((select reputation from public.profiles where id = tests.u(1)) - 0.95) < 1e-9, 'u1: +0.05 (a1) -0.10 (a2), dock disputes ignored => 0.95');
select ok(abs((select reputation from public.profiles where id = tests.u(2)) - 1.15) < 1e-9, 'u2: three pings with >= 2 confirms (+0.15), one with a single confirm (0) => 1.15');
select ok(abs((select reputation from public.profiles where id = tests.u(3)) - 0.2) < 1e-9, 'u3: 0.25 - 0.10 = 0.15 clamps up to 0.2');
select ok(abs((select reputation from public.profiles where id = tests.u(4)) - 3.0) < 1e-9, 'u4: 2.98 + 0.05 = 3.03 clamps down to 3.0');
select is((select reputation from public.profiles where id = tests.u(5)), 1.0::double precision, 'voters with no pings are unchanged');

select is((select count(*) from public.audit_log where action = 'reputation.update'), 4::bigint, 'one audit row per changed account');
select is((select count(*) from public.audit_log where action = 'reputation.batch'), 2::bigint, 'one summary audit row per run');
select is((select details ->> 'after' from public.audit_log where action = 'reputation.update' and target_id = tests.u(3)::text), '0.2', 'audit row records the clamped value');
select is((select details ->> 'delta' from public.audit_log where action = 'reputation.update' and target_id = tests.u(1)::text), '-0.05', 'audit row records the net delta (-0.05)');
select is((select count(*) from public.pings where rep_processed_at is null), 1::bigint, 'only the fresh ping is still pending');

-- reputation < 0.3 hides the account''s public pings (PRD)
select tests.act_as(tests.u(4));
select is((select count(*) from public.pings where id = tests.c(8)), 0::bigint, 'u3 (now 0.2) has its public ping hidden from other users');
select tests.act_as(tests.u(3));
select is((select count(*) from public.pings where id = tests.c(8)), 1::bigint, 'u3 still sees its own ping');

-- later batch picks the fresh ping up exactly once
select tests.act_service();
select is((public.run_reputation_batch(now() + interval '3 days')) ->> 'pings_evaluated', '1', 'a later run evaluates the ping that has now aged past 48 h');
select tests.act_admin();
select ok(abs((select reputation from public.profiles where id = tests.u(1)) - 1.0) < 1e-9, 'u1: 0.95 + 0.05 = 1.0 after the fresh ping is evaluated');

select * from finish();
rollback;
