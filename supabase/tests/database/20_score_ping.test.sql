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

select plan(22);

-- Hand-computed vectors for  S = R_a * (1 + SUM R_i*v_i*w(d_i)) * exp(-ln2/86400 * dt).
-- T0 is the ping's created_at; lambda gives half-life 24 h, so exp factor = 2^(-hours/24):
--   12 h -> 0.7071067811865476   24 h -> 0.5   48 h -> 0.25
-- Tolerance 1e-12 absolute; the mobile TS implementation must match these to the same tolerance.

select tests.act_admin();
insert into auth.users (id, email) values (tests.u(5), 'u5@example.test'), (tests.u(6), 'u6@example.test'), (tests.u(7), 'u7@example.test');
insert into public.profiles (id, handle) values (tests.u(5), 'voter_five'), (tests.u(6), 'voter_six'), (tests.u(7), 'voter_seven');

-- reputations: u1 author 1.0 (default), u4 author 1.5, voters: u2 1.0 (changed per case), u3 .., u5..u7
insert into public.pings (id, author_id, type, geom, created_at) values
  (tests.c(1), tests.u(1), 'bar_moved', st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00'),
  (tests.c(2), tests.u(4), 'bar_moved', st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00'),
  (tests.c(3), tests.u(1), 'log',       st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00'),
  (tests.c(4), tests.u(1), 'log',       st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00'),
  (tests.c(5), tests.u(1), 'gear',      st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00'),
  (tests.c(6), tests.u(1), 'gear',      st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00'),
  (tests.c(7), tests.u(1), 'other',     st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00');
update public.profiles set reputation = 1.5 where id = tests.u(4);

-- ---- no votes: pure decay ---------------------------------------------------------------------
select ok(abs(public.score_ping(tests.c(1), timestamptz '2026-10-01 12:00:00+00') - 1.0) < 1e-12, 'S(t=0) = R_a = 1.0');
select ok(abs(public.score_ping(tests.c(1), timestamptz '2026-10-02 00:00:00+00') - 0.7071067811865476) < 1e-12, 'S(12 h) = 2^-0.5');
select ok(abs(public.score_ping(tests.c(1), timestamptz '2026-10-02 12:00:00+00') - 0.5) < 1e-12, 'S(24 h) = 0.5: half strength after one day');
select ok(abs(public.score_ping(tests.c(1), timestamptz '2026-10-03 12:00:00+00') - 0.25) < 1e-12, 'S(48 h) = 0.25: the hide threshold');
select ok(abs(public.score_ping(tests.c(2), timestamptz '2026-10-02 12:00:00+00') - 0.75) < 1e-12, 'S(24 h) with R_a = 1.5 is 0.75');
select ok(abs(public.score_ping(tests.c(1), timestamptz '2026-10-01 11:00:00+00') - 1.0) < 1e-12, 'dt is clamped at 0 when `at` precedes t_last');
select is(public.score_ping(tests.c(1), timestamptz '2026-10-02 12:00:00+00')::numeric(10, 6), 0.500000::numeric(10, 6), 'S(24 h) prints as 0.500000');
select is(public.score_ping('00000000-0000-0000-0000-00000000ffff', now()), null::double precision, 'unknown ping id scores null');
select ok(public.score_ping(tests.c(1)) between 0 and 1, 'at defaults to now(): an old ping has decayed below 1');

-- ---- one confirm within 200 m: weight 1.0, t_last moves to the confirm --------------------------------
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m, created_at) values
  (tests.c(3), tests.u(2), 1, 100, timestamptz '2026-10-01 13:00:00+00');
select ok(abs(public.score_ping(tests.c(3), timestamptz '2026-10-01 13:00:00+00') - 2.0) < 1e-12,
          'confirm@100 m, R=1: S at the vote = 1*(1+1)*1 = 2.0');
select ok(abs(public.score_ping(tests.c(3), timestamptz '2026-10-02 13:00:00+00') - 1.0) < 1e-12,
          'confirm resets decay: 24 h after the confirm S = 2*0.5 = 1.0');
select ok(abs(public.score_ping(tests.c(3), timestamptz '2026-10-01 12:30:00+00') - 1.0 * exp(-ln(2.0) / 86400 * 1800)) < 1e-12,
          'a vote after `at` is ignored (score at 12:30 uses only the ping)');

-- ---- confirm (R 1.2, 100 m) + dispute (R 0.8, 400 m): 1.2*1*1 + 0.8*(-1)*0.5 = 0.8 --------------------------
update public.profiles set reputation = 1.2 where id = tests.u(2);
update public.profiles set reputation = 0.8 where id = tests.u(3);
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m, created_at) values
  (tests.c(4), tests.u(2),  1, 100, timestamptz '2026-10-01 14:00:00+00'),
  (tests.c(4), tests.u(3), -1, 400, timestamptz '2026-10-01 15:00:00+00');
select ok(abs(public.score_ping(tests.c(4), timestamptz '2026-10-02 02:00:00+00') - 1.8 * 0.7071067811865476) < 1e-12,
          'mixed votes: 1.0*(1+1.2-0.4)*2^-0.5 = 1.2727922061357857 (t_last = confirm, a dispute does not reset decay)');
select ok(abs(public.score_ping(tests.c(4), timestamptz '2026-10-02 02:00:00+00') - 1.2727922061357857) < 1e-12,
          'mixed votes: literal 1.2727922061357857');

-- ---- distance weights at their boundaries ---------------------------------------------------------------
update public.profiles set reputation = 1.0 where id in (tests.u(2), tests.u(3));
update public.profiles set reputation = 2.0 where id = tests.u(5);
update public.profiles set reputation = 3.0 where id = tests.u(6);
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m, created_at) values
  (tests.c(5), tests.u(2),  1, 200,  timestamptz '2026-10-01 13:00:00+00'),   -- w = 1.0 (inclusive), R 1   => +1.0
  (tests.c(5), tests.u(5),  1, 500,  timestamptz '2026-10-01 13:00:00+00'),   -- w = 0.5 (inclusive), R 2   => +1.0
  (tests.c(5), tests.u(6), -1, 600,  timestamptz '2026-10-01 13:00:00+00'),   -- w = 0                       =>  0
  (tests.c(5), tests.u(7), -1, null, timestamptz '2026-10-01 13:00:00+00'),   -- unknown distance: w = 0     =>  0
  (tests.c(5), tests.u(3),  1, 200.0001, timestamptz '2026-10-01 13:00:00+00'); -- w = 0.5, R 1             => +0.5
select ok(abs(public.score_ping(tests.c(5), timestamptz '2026-10-01 13:00:00+00') - 3.5) < 1e-12,
          'weights: 200 m -> 1.0, 500 m -> 0.5, 600 m and unknown -> 0; S = 1+1+1+0+0+0.5 = 3.5');

-- ---- votes after `at` ignored; t_last uses only confirms <= at -------------------------------------------
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m, created_at) values
  (tests.c(6), tests.u(2), 1, 50, timestamptz '2026-10-01 17:00:00+00');
select ok(abs(public.score_ping(tests.c(6), timestamptz '2026-10-01 13:00:00+00') - exp(-ln(2.0) / 86400 * 3600)) < 1e-12,
          'historical `at`: a later confirm does not count');
select ok(abs(public.score_ping(tests.c(6), timestamptz '2026-10-01 17:00:00+00') - 2.0) < 1e-12,
          'historical `at` after the confirm counts it: 2.0');

-- ---- disputes can drive S negative (clients hide S < 0.25) -------------------------------------------------
update public.profiles set reputation = 3.0 where id = tests.u(3);
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m, created_at) values
  (tests.c(7), tests.u(2), -1, 100, timestamptz '2026-10-01 13:00:00+00'),
  (tests.c(7), tests.u(3), -1, 100, timestamptz '2026-10-01 13:00:00+00');
select ok(abs(public.score_ping(tests.c(7), timestamptz '2026-10-01 13:00:00+00') - (1.0 * (1.0 - 1.0 - 3.0) * exp(-ln(2.0) / 86400 * 3600))) < 1e-12,
          'two disputes (R 1 and 3) give 1*(1-4)*decay = negative');

-- ---- invoker rights: RLS decides who can score what ----------------------------------------------------------
select tests.act_admin();
insert into public.pings (id, author_id, group_id, type, geom, created_at) values
  (tests.c(8), tests.u(1), tests.g(), 'gear', st_setsrid(st_makepoint(-122.5, 48.3), 4326), timestamptz '2026-10-01 12:00:00+00');
select tests.act_as(tests.u(2));
select ok(public.score_ping(tests.c(8), timestamptz '2026-10-01 12:00:00+00') is not null, 'score_ping: group member can score a group ping');
select tests.act_as(tests.u(4));
select is(public.score_ping(tests.c(8), timestamptz '2026-10-01 12:00:00+00'), null::double precision, 'score_ping: non-member gets null for a group ping');
select tests.act_anon();
select throws_ok($$select public.score_ping(tests.c(1), now())$$, '42501', null, 'score_ping: anon denied');

-- ---- stored score at insert -------------------------------------------------------------------------------
select tests.act_admin();
insert into public.pings (id, author_id, type, geom) values
  (tests.c(9), tests.u(4), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326));
select is((select score from public.pings where id = tests.c(9)), 1.5::double precision, 'pings.score starts at the author reputation (1.5)');

select * from finish();
rollback;
