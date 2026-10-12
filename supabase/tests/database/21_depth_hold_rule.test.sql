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
  ('00000000-0000-0000-0000-0000000000a4', 'bystander_four', 'F/V Four')
on conflict (id) do update set handle = excluded.handle, vessel_name = excluded.vessel_name;  -- (a trigger already created placeholder rows)
-- Group G owned by u1 (the groups trigger makes u1 the owner member), u2 joins as member.
insert into public.groups (id, name, owner_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'Skagit Crew', '00000000-0000-0000-0000-0000000000a1');
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', 'member');

select plan(105);

create or replace function tests.row(p_cell text, p_day date, p_med float8, p_p10 float8, p_n int, p_hash text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('h3_cell', p_cell, 'day', p_day, 'median_ft', p_med, 'p10_ft', p_p10, 'n', p_n, 'uploader_hash', p_hash)
$$;
-- cells / hashes (a 64-hex hash per boat per day)
create or replace function tests.cell(i int) returns text language sql immutable as $$ select '8c2a1072b59ff' || lpad(to_hex(i), 2, '0') $$;
create or replace function tests.h(c char) returns text language sql immutable as $$ select repeat(c::text, 64) $$;

select tests.act_admin();
-- baseline is ELEVATION ft MLLW, positive up (merged_elev): -11 means 11 ft of water.
-- Uploads are DEPTH below MLLW, positive down: the rule compares median_ft with -baseline_elev_ft.
insert into public.baseline_cells (cell_id, baseline_elev_ft) values
  (tests.cell(1), -11), (tests.cell(2), -10), (tests.cell(3), -10), (tests.cell(4), -10),
  (tests.cell(5), -10), (tests.cell(6), -10);
-- cell(7) intentionally has no baseline.

-- ---- weighted_quantile ----------------------------------------------------------------------------
select is(public.weighted_quantile(array[10, 20]::float8[], array[1, 3]::float8[], 0.5), 20::float8, 'weighted_quantile: {10,20} weights {1,3} -> 20');
select is(public.weighted_quantile(array[10, 20]::float8[], array[3, 1]::float8[], 0.5), 10::float8, 'weighted_quantile: weights {3,1} -> 10');
select is(public.weighted_quantile(array[20, 10, 30]::float8[], array[1, 1, 1]::float8[], 0.5), 20::float8, 'weighted_quantile: unsorted input, equal weights -> middle value');
select is(public.weighted_quantile(array[5]::float8[], array[7]::float8[], 0.1), 5::float8, 'weighted_quantile: single value');

-- ---- structure: no uid, no sub-day timestamp anywhere in depth_uploads --------------------------------
select hasnt_column('public', 'depth_uploads', 'user_id', 'depth_uploads has no user_id');
select hasnt_column('public', 'depth_uploads', 'created_at', 'depth_uploads has no timestamp column');
select col_type_is('public', 'depth_uploads', 'day', 'date', 'depth_uploads.day is a date (no time of day)');

-- ---- 1. ordinary upload: accepted, aggregated ---------------------------------------------------------------
select tests.act_service();
select is((public.ingest_depth_batch(tests.c(1), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 12, 10, 20, tests.h('a'))), '{}')) ->> 'accepted',
          '1', 'ordinary upload within 15 ft of baseline is accepted');
select is((select median_ft from public.depth_cells where cell_id = tests.cell(1) and day = '2026-10-01'), 12::float8, 'depth_cells row created with the median');
select is((select boats from public.depth_cells where cell_id = tests.cell(1)), 1, 'one boat so far');

-- ---- 2./3. held, then released by a second boat that agrees ---------------------------------------------------
select is((public.ingest_depth_batch(tests.c(2), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(2), '2026-10-01', 40, 38, 10, tests.h('b'))), '{}')) ->> 'held',
          '1', 'upload 30 ft off baseline with no other boat is HELD');
select is((select held_reason from public.depth_uploads where cell_id = tests.cell(2)), 'baseline_disagreement', 'held row carries its reason');
select is((select count(*) from public.depth_cells where cell_id = tests.cell(2)), 0::bigint, 'held upload is kept in depth_uploads but absent from depth_cells');
select is((select count(*) from public.depth_uploads where cell_id = tests.cell(2)), 1::bigint, 'held upload is not deleted');

select is((public.ingest_depth_batch(tests.c(3), tests.u(3),
            jsonb_build_array(tests.row(tests.cell(2), '2026-10-05', 38, 36, 30, tests.h('c'))), '{}')) ->> 'released',
          '1', 'a second boat 2 ft from the held reading releases it');
select is((select count(*) from public.depth_uploads where cell_id = tests.cell(2) and held), 0::bigint, 'no rows remain held on that cell');
select is((select count(*) from public.depth_cells where cell_id = tests.cell(2)), 2::bigint, 'both days now appear in depth_cells (released day + new day)');
select is((select median_ft from public.depth_cells where cell_id = tests.cell(2) and day = '2026-10-01'), 40::float8, 'released day aggregates from the released upload');

-- weighted aggregate within one day: two boats, same cell and day
select tests.act_service();
select lives_ok($$select public.ingest_depth_batch(tests.c(4), tests.u(4),
            jsonb_build_array(tests.row(tests.cell(2), '2026-10-05', 39, 37, 10, tests.h('d'))), '{}')$$,
          'a third boat uploads the same cell/day');
select is((select median_ft from public.depth_cells where cell_id = tests.cell(2) and day = '2026-10-05'), 38::float8,
          'median is n-weighted: (39, n=10) and (38, n=30) -> 38');
select is((select p10_ft from public.depth_cells where cell_id = tests.cell(2) and day = '2026-10-05'), 36::float8,
          'p10 is n-weighted: (37, n=10) and (36, n=30) -> 36');
select is((select n from public.depth_cells where cell_id = tests.cell(2) and day = '2026-10-05'), 40, 'n sums across uploads');
select is((select boats from public.depth_cells where cell_id = tests.cell(2) and day = '2026-10-05'), 2, 'boats counts distinct uploader_hash that day');

-- ---- 4. a disagreeing second boat does not release a held reading ---------------------------------------------
select lives_ok($$select public.ingest_depth_batch(tests.c(5), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(3), '2026-10-01', 45, 43, 10, tests.h('e'))), '{}')$$, 'boat E uploads 45 ft depth on a 10 ft baseline');
select lives_ok($$select public.ingest_depth_batch(tests.c(6), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(3), '2026-10-02', 20, 18, 10, tests.h('f'))), '{}')$$, 'boat F uploads 20 ft (only 10 ft off baseline)');
select is((select count(*) from public.depth_uploads where cell_id = tests.cell(3) and held), 1::bigint, 'E stays held: F does not agree with it');
select is((select median_ft from public.depth_cells where cell_id = tests.cell(3)), 20::float8, 'only the non-held reading is published');

-- ---- 5. corroboration must AGREE (within 5 ft), an unrelated normal reading no longer suppresses a hold ---------
select lives_ok($$select public.ingest_depth_batch(tests.c(7), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(4), '2026-10-01', 9, 7, 10, tests.h('a'))), '{}')$$, 'boat A logs a normal reading');
select is((public.ingest_depth_batch(tests.c(8), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(4), '2026-10-03', 50, 48, 10, tests.h('b'))), '{}')) ->> 'held',
          '1', 'S3: a wild reading stays held even though another boat logged a normal reading in the cell');
select is((select count(*) from public.depth_cells where cell_id = tests.cell(4) and median_ft = 50), 0::bigint, 'S3: the held wild reading is not published');

-- a non-held reading from another boat WITHIN 5 ft does corroborate (cell 11 had no baseline when boat X logged it)
select tests.act_admin();
select tests.act_service();
select lives_ok($$select public.ingest_depth_batch(tests.c(30), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(11), '2026-10-01', 50, 48, 10, tests.h('a'))), '{}')$$, 'boat X logs 50 ft in a cell that has no baseline yet (accepted)');
select tests.act_admin();
insert into public.baseline_cells (cell_id, baseline_elev_ft) values (tests.cell(11), -10);
select tests.act_service();
select is((public.ingest_depth_batch(tests.c(31), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(11), '2026-10-02', 52, 50, 10, tests.h('b'))), '{}')) ->> 'held',
          '0', 'a disagreeing reading 2 ft from another boat''s accepted reading is corroborated, not held');
select is((public.ingest_depth_batch(tests.c(32), tests.u(3),
            jsonb_build_array(tests.row(tests.cell(11), '2026-10-03', 80, 78, 10, tests.h('c'))), '{}')) ->> 'held',
          '1', 'a disagreeing reading 28 ft from every other boat stays held');

-- ---- M4. one boat, one row per (cell, day): re-sending replaces, it cannot stack weight -------------------
select tests.act_admin();
insert into public.baseline_cells (cell_id, baseline_elev_ft) values (tests.cell(12), -10);
select tests.act_service();
select lives_ok($$select public.ingest_depth_batch(tests.c(33), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(12), '2026-10-01', 10, 8, 40, tests.h('a'))), '{}')$$, 'honest boat A: 10 ft, n=40');
select lives_ok($$select public.ingest_depth_batch(tests.c(34), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(12), '2026-10-01', 11, 9, 45, tests.h('a'))), '{}')$$, 'honest boat A re-sends the same cell/day in a new batch');
select is((select count(*) from public.depth_uploads where cell_id = tests.cell(12)), 1::bigint, 'M4: the re-send replaced the row (unique per boat/cell/day)');
select is((select median_ft from public.depth_uploads where cell_id = tests.cell(12)), 11::float8, 'M4: replacement carries the new values');
select lives_ok($$select public.ingest_depth_batch(tests.c(35), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(12), '2026-10-01', 12, 10, 60, tests.h('b'))), '{}')$$, 'honest boat B: 12 ft, n=60');
select lives_ok($$select public.ingest_depth_batch(tests.c(36), tests.u(3),
            jsonb_build_array(tests.row(tests.cell(12), '2026-10-01', 24, 22, 86400, tests.h('c'))), '{}')$$, 'attacker C claims n = 86400 at 24 ft (14 ft off the baseline: accepted, below the 15 ft hold line)');
select is((select median_ft from public.depth_cells where cell_id = tests.cell(12) and day = '2026-10-01'), 12::float8,
          'M4: weights are capped at 100 per boat (45, 60, 100), so one boat with n = 86400 cannot move the median (12, not 24)');
select is((select n from public.depth_cells where cell_id = tests.cell(12) and day = '2026-10-01'), 205, 'M4: n in the aggregate is the capped sum 45 + 60 + 100');

-- ---- 6. "another boat" excludes the uploader''s own earlier hashes --------------------------------------------------
select lives_ok($$select public.ingest_depth_batch(tests.c(9), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(5), '2026-10-01', 50, 48, 10, tests.h('1'))), array[]::text[])$$,
          'boat 1 uploads a wild reading on day 1 (held)');
select is((public.ingest_depth_batch(tests.c(10), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(5), '2026-10-02', 50, 48, 10, tests.h('2'))), array[tests.h('1')])) ->> 'held',
          '1', 'same boat on day 2 (different hash, listed in p_self_hashes) cannot corroborate itself');
select is((select count(*) from public.depth_cells where cell_id = tests.cell(5)), 0::bigint, 'nothing from the self-corroborating boat is published');
select is((public.ingest_depth_batch(tests.c(11), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(5), '2026-10-03', 51, 49, 10, tests.h('3'))), '{}')) ->> 'released',
          '2', 'a genuinely different boat agreeing releases both of the first boat''s held rows');

-- ---- 7. idempotency on the client batch UUID ----------------------------------------------------------------------------
select is((public.ingest_depth_batch(tests.c(1), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 12, 10, 20, tests.h('a'))), '{}')) ->> 'duplicate',
          'true', 'replaying a batch UUID is reported as a duplicate');
select is((select n from public.depth_cells where cell_id = tests.cell(1) and day = '2026-10-01'), 20, 'replay changed nothing (n still 20)');
select throws_ok($$select public.ingest_depth_batch(tests.c(1), tests.u(2), jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 12, 10, 20, tests.h('a'))), '{}')$$,
                 'PT409', null, 'a batch UUID owned by another user is a conflict');

-- ---- 8. held rows do not wait forever: 30-day agreement window ---------------------------------------------------------------
select lives_ok($$select public.ingest_depth_batch(tests.c(12), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(6), '2026-08-01', 40, 38, 10, tests.h('4'))), '{}')$$, 'held reading on 2026-08-01');
select is((public.ingest_depth_batch(tests.c(13), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(6), '2026-09-20', 40, 38, 10, tests.h('5'))), '{}')) ->> 'held',
          '1', 'an agreeing reading 50 days later does not release (outside 30 days) and is itself held');

-- ---- 9. no baseline => never held ---------------------------------------------------------------------------------------------
select is((public.ingest_depth_batch(tests.c(14), tests.u(3),
            jsonb_build_array(tests.row(tests.cell(7), '2026-10-01', 300, 290, 5, tests.h('6'))), '{}')) ->> 'held',
          '0', 'a cell with no baseline cannot be held');

-- ---- 10. validation, revoked accounts ------------------------------------------------------------------------------------------
select throws_ok($$select public.ingest_depth_batch(tests.c(15), tests.u(1), '[]'::jsonb, '{}')$$, 'PT400', null, 'empty rows rejected');
select throws_ok($$select public.ingest_depth_batch(tests.c(15), tests.u(1), '{}'::jsonb, '{}')$$, 'PT400', null, 'non-array rows rejected');
select tests.act_admin();
update public.profiles set revoked_at = now() where id = tests.u(4);
select tests.act_service();
select throws_ok($$select public.ingest_depth_batch(tests.c(16), tests.u(4),
            jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 12, 10, 20, tests.h('7'))), '{}')$$, 'PT403', null, 'revoked account cannot upload');

-- ---- 11. rate limit: 1 depth batch / 15 min (consumed by the edge function, counted in rate_events) -------------------
select is((select allowed from public.rate_limit_consume(tests.u(1), 'depth_batch')), true, 'rate_limit_consume: first batch allowed');
select is((select allowed from public.rate_limit_consume(tests.u(1), 'depth_batch')), false, 'rate_limit_consume: second batch inside 15 min refused');
select ok((select retry_after_s from public.rate_limit_status(tests.u(1), 'depth_batch')) between 1 and 900, 'rate_limit_status: retry_after is within 15 minutes');
select is((select allowed from public.rate_limit_status(gen_random_uuid(), 'depth_batch')), true, 'rate_limit_status: a user with no events is allowed');
select is((select count(*) from public.rate_events where user_id = tests.u(1) and bucket = 'depth_batch'), 1::bigint, 'only the allowed attempt was recorded');

-- ---- S5. the batch ledger forgets who sent a batch after 15 minutes --------------------------------------------------
select is((public.depth_batch_lookup(tests.c(1))) ->> 'found', 'true', 'depth_batch_lookup: known batch');
select is((public.depth_batch_lookup(gen_random_uuid())) ->> 'found', 'false', 'depth_batch_lookup: unknown batch');
select tests.act_admin();
update public.depth_batches set received_at = now() - interval '16 minutes' where batch_id = tests.c(2);
select tests.act_service();
select lives_ok($$select public.ingest_depth_batch(tests.c(40), tests.u(3), jsonb_build_array(tests.row(tests.cell(7), '2026-10-02', 300, 290, 5, tests.h('d'))), '{}')$$, 'any later ingest unlinks stale ledger rows');
select is((select user_id from public.depth_batches where batch_id = tests.c(2)), null::uuid, 'S5: user_id is nulled once the 15-minute window has passed');
select is((public.ingest_depth_batch(tests.c(2), tests.u(2), jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 12, 10, 20, tests.h('a'))), '{}')) ->> 'duplicate',
          'true', 'S5: a replay of an unlinked batch is a plain duplicate (no ownership leak, no 409)');

-- ---- 12. publication threshold: RLS shows cells only with >= 3 boats -------------------------------------------------------------------
select tests.act_admin();
select tests.act_as(tests.u(2));
select is((select count(*) from public.depth_cells where cell_id = tests.cell(1)), 0::bigint, 'client cannot read a 1-boat cell');
select tests.act_service();
select lives_ok($$select public.ingest_depth_batch(tests.c(17), tests.u(2), jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 12, 10, 5, tests.h('8'))), '{}')$$, 'second boat on cell 1');
select lives_ok($$select public.ingest_depth_batch(tests.c(18), tests.u(3), jsonb_build_array(tests.row(tests.cell(1), '2026-10-01', 13, 11, 5, tests.h('9'))), '{}')$$, 'third boat on cell 1');
select tests.act_as(tests.u(2));
select is((select boats from public.depth_cells where cell_id = tests.cell(1) and day = '2026-10-01'), 3, 'client can read the cell once 3 distinct boats contributed');

-- ---- 13. admin hold / release / audit ------------------------------------------------------------------------------------------------------
select tests.act_service();
select lives_ok(format($$select public.admin_set_upload_held(tests.u(1), %L, true)$$,
                 (select id from public.depth_uploads where uploader_hash = tests.h('8') limit 1)),
          'admin_set_upload_held: hold an upload');
select is((select boats from public.depth_cells where cell_id = tests.cell(1) and day = '2026-10-01'), 2, 'held upload leaves the aggregate immediately');
select is((select held_reason from public.depth_uploads where uploader_hash = tests.h('8')), 'admin', 'admin hold has its own reason (never auto-released)');
select lives_ok(format($$select public.admin_set_upload_held(tests.u(1), %L, false)$$,
                 (select id from public.depth_uploads where uploader_hash = tests.h('8') limit 1)),
          'admin_set_upload_held: release it');
select is((select boats from public.depth_cells where cell_id = tests.cell(1) and day = '2026-10-01'), 3, 'released upload is back in the aggregate');
select is((select count(*) from public.audit_log where action in ('admin.hold_upload','admin.release_upload') and actor = tests.u(1)),
          2::bigint, 'both admin actions are in audit_log');
select throws_ok($$select public.admin_set_upload_held(tests.u(1), gen_random_uuid(), true)$$, 'PT404', null, 'admin_set_upload_held: unknown upload');
select is((select count(*) from public.admin_list_held(tests.u(1), 100)) > 0, true, 'admin_list_held returns held rows');

-- ---- 14. salt rotation bumps the epoch and is audited ----------------------------------------------------------------------------------------
select is(public.get_salt_epoch(), 0, 'salt epoch starts at 0');
select is(public.admin_rotate_salt(tests.u(1)), 1, 'admin_rotate_salt returns the new epoch');
select is(public.get_salt_epoch(), 1, 'epoch persisted');
select is((select details ->> 'epoch' from public.audit_log where action = 'admin.rotate_salt'), '1', 'rotation is audited');

-- ---- 15. sign convention: uploads are depth (positive down), baseline is elevation (positive up) ----------
-- Baseline elevation -11 means 11 ft of water. An upload of +11 agrees; the wrong-signed -11 is 22 ft
-- off the baseline depth, so it is held.
select tests.act_admin();
insert into public.baseline_cells (cell_id, baseline_elev_ft) values (tests.cell(8), -11), (tests.cell(9), 4), (tests.cell(10), -11);
select tests.act_service();
select is((public.ingest_depth_batch(tests.c(19), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(8), '2026-10-01', 11, 9, 5, tests.h('a'))), '{}')) ->> 'held',
          '0', 'baseline elevation -11 ft agrees with an uploaded depth of +11 ft');
select is((public.ingest_depth_batch(tests.c(20), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(10), '2026-10-01', -11, -13, 5, tests.h('b'))), '{}')) ->> 'held',
          '1', 'a wrong-signed upload (-11 ft depth against 11 ft of water) is 22 ft off and is held');
select is((public.ingest_depth_batch(tests.c(21), tests.u(3),
            jsonb_build_array(tests.row(tests.cell(9), '2026-10-01', 30, 28, 5, tests.h('c'))), '{}')) ->> 'held',
          '1', 'a flat that dries 4 ft (baseline elevation +4 = depth -4) vs an uploaded 30 ft is held');
select is((select baseline_depth_ft from public.admin_list_held(tests.u(1), 100) where cell_id = tests.cell(9)::text), -4::float8,
          'admin_list_held reports the baseline as depth (negated elevation: +4 ft elevation -> -4 ft depth)');

-- ---- B3. p10 is validated and compared with the baseline like the median ------------------------------------------
select tests.act_admin();
insert into public.baseline_cells (cell_id, baseline_elev_ft) values (tests.cell(13), -10), (tests.cell(14), -10);
select tests.act_service();
select is((public.ingest_depth_batch(tests.c(50), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(13), '2026-10-01', 12, -1500, 5, tests.h('a'))), '{}')) ->> 'held',
          '1', 'B3: a normal median with a fake p10 of -1500 ft (a dry hazard) is HELD, not published');
select is((select count(*) from public.depth_cells where cell_id = tests.cell(13)), 0::bigint, 'B3: nothing from the fake-hazard upload reaches depth_cells');
select throws_ok(format($$select public.ingest_depth_batch(%L, %L, %L::jsonb, '{}')$$, tests.c(51), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(14), '2026-10-01', 12, 14, 5, tests.h('b')))::text),
          'PT400', 'invalid_row', 'B3: p10 deeper than the median is rejected');
-- a second boat whose median matches but whose p10 does not agree cannot release it
select is((public.ingest_depth_batch(tests.c(52), tests.u(2),
            jsonb_build_array(tests.row(tests.cell(13), '2026-10-02', 12, -1400, 5, tests.h('b'))), '{}')) ->> 'released',
          '0', 'B3: agreement must hold for p10 too (-1500 vs -1400 is not within 5 ft)');
select is((public.ingest_depth_batch(tests.c(53), tests.u(3),
            jsonb_build_array(tests.row(tests.cell(13), '2026-10-03', 12, -1498, 5, tests.h('c'))), '{}')) ->> 'released',
          '1', 'B3: a boat that genuinely agrees on median and p10 corroborates (and releases) it');

-- ---- E6. non-finite / absurd days and numbers are refused before anything is written -----------------------------
select throws_ok(format($$select public.ingest_depth_batch(%L, %L, %L::jsonb, '{}')$$, tests.c(54), tests.u(1),
            '[{"h3_cell":"8c2a1072b59ff0d","day":"infinity","median_ft":10,"p10_ft":9,"n":5,"uploader_hash":"' || repeat('a', 64) || '"}]'),
          'PT400', 'invalid_row', 'E6: day = infinity rejected');
select throws_ok(format($$select public.ingest_depth_batch(%L, %L, %L::jsonb, '{}')$$, tests.c(55), tests.u(1),
            '[{"h3_cell":"8c2a1072b59ff0d","day":"1999-01-01","median_ft":10,"p10_ft":9,"n":5,"uploader_hash":"' || repeat('a', 64) || '"}]'),
          'PT400', 'invalid_row', 'E6: a day before 2020 is rejected');
select throws_ok(format($$select public.ingest_depth_batch(%L, %L, %L::jsonb, '{}')$$, tests.c(56), tests.u(1),
            '[{"h3_cell":"8c2a1072b59ff0d","day":"2026-10-01","median_ft":"NaN","p10_ft":9,"n":5,"uploader_hash":"' || repeat('a', 64) || '"}]'),
          'PT400', 'invalid_row', 'E6: NaN median rejected');
select is((select count(*) from public.depth_batches where batch_id in (tests.c(54), tests.c(55), tests.c(56))), 0::bigint, 'E6: rejected batches leave no ledger row');

-- ---- B2. advisory locks serialise batches on the same (cell, day) -----------------------------------------------------
select lives_ok($$select public.ingest_depth_batch(tests.c(57), tests.u(1),
            jsonb_build_array(tests.row(tests.cell(15), '2026-10-01', 12, 10, 5, tests.h('a')), tests.row(tests.cell(15), '2026-10-02', 12, 10, 5, tests.h('a'))), '{}')$$,
          'B2: a batch touching two aggregates');
select cmp_ok((select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()), '>=', 2::bigint,
              'B2: the batch holds an advisory lock for each (cell, day) it touched until commit');

-- ---- E4. a failed ingest can give its rate-limit slot back ------------------------------------------------------------------
select is((select allowed from public.rate_limit_consume(tests.u(2), 'depth_batch')), true, 'E4: slot consumed');
select is((select allowed from public.rate_limit_status(tests.u(2), 'depth_batch')), false, 'E4: window full');
select lives_ok($$select public.rate_limit_refund(tests.u(2), 'depth_batch')$$, 'E4: refund');
select is((select allowed from public.rate_limit_status(tests.u(2), 'depth_batch')), true, 'E4: slot available again after a refund');
select lives_ok($$select public.rate_limit_refund(gen_random_uuid(), 'depth_batch')$$, 'E4: refunding a user with no events is harmless');

-- ---- E5. salt epochs carry their activation day ---------------------------------------------------------------------------------
select is((select jsonb_array_length(public.get_salt_epochs())), 2, 'E5: epochs recorded so far (0 and the rotation tested above)');
select is((public.get_salt_epochs() -> 0 ->> 'epoch'), '0', 'E5: epoch 0 ...');
select is((public.get_salt_epochs() -> 0 ->> 'from'), '1970-01-01', 'E5: ... active since the beginning');
select public.admin_rotate_salt(tests.u(1));
select is((select jsonb_array_length(public.get_salt_epochs())), 3, 'E5: another rotation appends an epoch');
select is((public.get_salt_epochs() -> 2 ->> 'from'), to_char(now() at time zone 'utc', 'YYYY-MM-DD'), 'E5: ... stamped with the UTC activation day');

select * from finish();
rollback;
