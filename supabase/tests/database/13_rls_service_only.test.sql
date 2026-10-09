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

select plan(50);

-- depth_cells: boats >= 3 readable; depth_uploads/batches/baseline/audit_log/app_config: service only.
select tests.act_admin();
insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats) values
  ('8c2a1072b59ffff', '2026-10-01', -12, -14, 40, 3),
  ('8c2a1072b5a1fff', '2026-10-01', -9,  -11, 20, 1),
  ('8c2a1072b5a3fff', '2026-10-01', -7,  -9,  25, 2);
insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
  values (repeat('a', 64), '8c2a1072b59ffff', '2026-10-01', -12, -14, 40);
insert into public.audit_log (actor, action) values (tests.u(1), 'test.seed');
insert into public.baseline_cells (cell_id, baseline_elev_ft) values ('8c2a1072b59ffff', -11);
insert into public.depth_cell_aggregates (cell_id, period_start, period_end, median_ft, p10_ft, n, boats) values
  ('8c2a1072b59ffff', '2026-01-01', '2026-04-01', -12, -14, 400, 3),
  ('8c2a1072b5a1fff', '2026-01-01', '2026-04-01', -9, -11, 100, 1);

-- ---- depth_cells -------------------------------------------------------------------------
select tests.act_as(tests.u(1));
select is((select count(*) from public.depth_cells), 1::bigint, 'depth_cells select: owner/any signed-in sees only cells with >= 3 boats');
select tests.act_as(tests.u(2));
select is((select count(*) from public.depth_cells), 1::bigint, 'depth_cells select: group member');
select tests.act_as(tests.u(3));
select is((select count(*) from public.depth_cells), 1::bigint, 'depth_cells select: non-member');
select tests.act_anon();
select throws_ok($$select * from public.depth_cells$$, '42501', null, 'depth_cells select: anon denied');
select tests.act_as(tests.u(1));
select throws_ok($$insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats) values ('8c2a1072b5a5fff', '2026-10-02', -1, -2, 3, 3)$$,
                 '42501', null, 'depth_cells insert: signed-in user denied');
select throws_ok($$update public.depth_cells set boats = 9$$, '42501', null, 'depth_cells update: signed-in user denied');
select throws_ok($$delete from public.depth_cells$$, '42501', null, 'depth_cells delete: signed-in user denied');
select tests.act_anon();
select throws_ok($$insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats) values ('8c2a1072b5a5fff', '2026-10-02', -1, -2, 3, 3)$$,
                 '42501', null, 'depth_cells insert: anon denied');
select throws_ok($$update public.depth_cells set boats = 9$$, '42501', null, 'depth_cells update: anon denied');
select throws_ok($$delete from public.depth_cells$$, '42501', null, 'depth_cells delete: anon denied');
select tests.act_service();
select is((select count(*) from public.depth_cells), 3::bigint, 'depth_cells select: service role sees every cell');

-- ---- depth_cell_aggregates (same publication threshold) --------------------------------------
select tests.act_as(tests.u(2));
select is((select count(*) from public.depth_cell_aggregates), 1::bigint, 'depth_cell_aggregates select: only >= 3 boats');
select throws_ok($$delete from public.depth_cell_aggregates$$, '42501', null, 'depth_cell_aggregates delete: signed-in denied');
select tests.act_anon();
select throws_ok($$select * from public.depth_cell_aggregates$$, '42501', null, 'depth_cell_aggregates select: anon denied');

-- ---- depth_uploads: never selectable, never client-writable ------------------------------------
select tests.act_as(tests.u(1));
select throws_ok($$select * from public.depth_uploads$$, '42501', null, 'depth_uploads select: owner/signed-in denied');
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                   values (repeat('b', 64), '8c2a1072b59ffff', '2026-10-01', -12, -14, 5)$$,
                 '42501', null, 'depth_uploads insert: signed-in denied (hash must be server-computed; use depth-upload)');
select throws_ok($$update public.depth_uploads set held = true$$, '42501', null, 'depth_uploads update: denied');
select throws_ok($$delete from public.depth_uploads$$, '42501', null, 'depth_uploads delete: denied');
select tests.act_as(tests.u(2));
select throws_ok($$select * from public.depth_uploads$$, '42501', null, 'depth_uploads select: group member denied');
select tests.act_as(tests.u(3));
select throws_ok($$select * from public.depth_uploads$$, '42501', null, 'depth_uploads select: non-member denied');
select tests.act_anon();
select throws_ok($$select * from public.depth_uploads$$, '42501', null, 'depth_uploads select: anon denied');
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                   values (repeat('b', 64), '8c2a1072b59ffff', '2026-10-01', -12, -14, 5)$$,
                 '42501', null, 'depth_uploads insert: anon denied');
select tests.act_service();
select is((select count(*) from public.depth_uploads), 1::bigint, 'depth_uploads: service role can read');
select lives_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                  values (repeat('c', 64), '8c2a1072b59ffff', '2026-10-01', -12, -14, 5)$$,
                'depth_uploads insert: service role (edge function) can insert');

-- ---- depth_batches / baseline_cells / audit_log / app_config ----------------------------------------
select tests.act_as(tests.u(1));
select throws_ok($$select * from public.depth_batches$$, '42501', null, 'depth_batches select: signed-in denied');
select throws_ok($$select * from public.baseline_cells$$, '42501', null, 'baseline_cells select: signed-in denied');
select throws_ok($$select * from public.audit_log$$, '42501', null, 'audit_log select: signed-in (even an admin uid) denied');
select throws_ok($$insert into public.audit_log (action) values ('forged')$$, '42501', null, 'audit_log insert: signed-in denied');
select throws_ok($$update public.audit_log set action = 'x'$$, '42501', null, 'audit_log update: signed-in denied');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'audit_log delete: signed-in denied');
select throws_ok($$select * from public.app_config$$, '42501', null, 'app_config select: signed-in denied');
select throws_ok($$update public.app_config set value = '99'$$, '42501', null, 'app_config update: signed-in denied');
select tests.act_as(tests.u(2));
select throws_ok($$select * from public.audit_log$$, '42501', null, 'audit_log select: group member denied');
select tests.act_as(tests.u(3));
select throws_ok($$select * from public.audit_log$$, '42501', null, 'audit_log select: non-member denied');
select tests.act_anon();
select throws_ok($$select * from public.audit_log$$, '42501', null, 'audit_log select: anon denied');
select throws_ok($$insert into public.audit_log (action) values ('forged')$$, '42501', null, 'audit_log insert: anon denied');
select throws_ok($$select * from public.depth_batches$$, '42501', null, 'depth_batches select: anon denied');
select throws_ok($$select * from public.baseline_cells$$, '42501', null, 'baseline_cells select: anon denied');
select throws_ok($$select * from public.app_config$$, '42501', null, 'app_config select: anon denied');

select tests.act_service();
select is((select count(*) from public.audit_log where action = 'test.seed'), 1::bigint, 'audit_log: service role reads');
select lives_ok($$insert into public.audit_log (action, details) values ('test.service', '{}')$$, 'audit_log: service role appends');
select throws_ok($$update public.audit_log set action = 'tampered'$$, '42501', null, 'audit_log: append-only even for the service role (update)');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'audit_log: append-only even for the service role (delete)');
select is((select (value #>> '{}')::int from public.app_config where key = 'hmac_salt_epoch'), 0, 'app_config: salt epoch starts at 0');

-- Server-only functions cannot be called by clients
select tests.act_as(tests.u(1));
select throws_ok($$select public.run_reputation_batch()$$, '42501', null, 'run_reputation_batch: not callable by signed-in users');
select throws_ok($$select public.run_retention()$$, '42501', null, 'run_retention: not callable by signed-in users');
select throws_ok($$select public.delete_account_data(tests.u(2))$$, '42501', null, 'delete_account_data: not callable by signed-in users');
select throws_ok($$select public.admin_rotate_salt(tests.u(1))$$, '42501', null, 'admin_rotate_salt: not callable by signed-in users');
select throws_ok($$select public.ingest_depth_batch(gen_random_uuid(), tests.u(1), '[]'::jsonb)$$, '42501', null, 'ingest_depth_batch: not callable by signed-in users');
select tests.act_anon();
select throws_ok($$select public.run_retention()$$, '42501', null, 'run_retention: not callable by anon');

select * from finish();
rollback;
