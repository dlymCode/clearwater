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

select plan(83);

-- ---- structure --------------------------------------------------------------------------
select has_table('public', t, 'table exists: ' || t)
from unnest(array['profiles','groups','group_members','pings','ping_votes','depth_cells','depth_uploads',
                  'messages','audit_log','last_positions','depth_batches','baseline_cells',
                  'depth_cell_aggregates','app_config']) as t;

select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
          0::bigint, 'RLS is enabled on every table in public');

select enum_has_labels('public', 'ping_type',
  array['bar_moved','touched_bottom','log','gear','closure_line','other'],
  'ping_type has the six contract values in order');

select has_index('public', 'pings', 'pings_geom_gix', 'pings: gist index on geom');
select hasnt_index('public', 'pings', 'pings_created_at_idx', 'dead index dropped: pings created_at');
select has_index('public', 'messages', 'messages_received_idx', 'messages: index on received_at (cursor sync + retention)');
select hasnt_index('public', 'messages', 'messages_created_idx', 'dead index dropped: messages created_at');
select has_index('public', 'messages', 'messages_group_created_idx', 'messages: index on (group, created)');
select has_index('public', 'depth_cells', 'depth_cells_pkey', 'depth_cells: keyed by (cell_id, day)');
select has_index('public', 'last_positions', 'last_positions_pkey', 'last_positions: keyed by user');

select col_default_is('public', 'profiles', 'reputation', '1', 'profiles.reputation defaults to 1.0');
select col_is_pk('public', 'ping_votes', array['ping_id','voter_id'], 'ping_votes unique on (ping_id, voter_id)');
select col_is_pk('public', 'depth_cells', array['cell_id','day'], 'depth_cells pk (cell_id, day)');
select col_type_is('public', 'pings', 'group_id', 'uuid', 'pings.group_id nullable uuid');
select col_is_null('public', 'pings', 'group_id', 'pings.group_id is nullable (null = public tier)');
select col_is_null('public', 'messages', 'ping_id', 'messages.ping_id is nullable');

-- Realtime streams whole rows, so only the group channel is published (C1/C2: author_id, voter_id, voter_dist_m)
select is((select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('pings', 'ping_votes')),
          0::bigint, 'C1/C2: pings and ping_votes are NOT in the Realtime publication');
select is((select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'),
          1::bigint, 'messages stay in the Realtime publication');

-- column privileges that carry the secrecy model
select is(has_column_privilege('authenticated', 'public.pings', 'author_id', 'select'), false, 'authenticated cannot select pings.author_id');
select is(has_column_privilege('authenticated', 'public.pings', 'rep_processed_at', 'select'), false, 'authenticated cannot select pings.rep_processed_at');
select is(has_column_privilege('authenticated', 'public.pings', 'geom', 'select'), true, 'authenticated can select pings.geom');
select is(has_column_privilege('authenticated', 'public.groups', 'invite_code', 'select'), false, 'authenticated cannot select groups.invite_code');
select is(has_column_privilege('authenticated', 'public.profiles', 'revoked_at', 'select'), false, 'authenticated cannot select profiles.revoked_at');
select is(has_column_privilege('authenticated', 'public.last_positions', 'geom', 'insert'), false, 'authenticated cannot insert last_positions directly');
select is(has_column_privilege('authenticated', 'public.last_positions', 'geom', 'update'), false, 'authenticated cannot update last_positions directly');
select is(has_table_privilege('service_role', 'public.audit_log', 'update'), false, 'service_role cannot update audit_log');
select is(has_table_privilege('service_role', 'public.audit_log', 'truncate'), false, 'service_role cannot truncate audit_log');

-- anon has no table privileges whatsoever
select is((select count(*) from information_schema.role_table_grants
            where grantee = 'anon' and table_schema = 'public'),
          0::bigint, 'anon holds no table grants in public');
-- clients can never read or write these
select is((select count(*) from information_schema.role_table_grants
            where grantee in ('anon','authenticated') and table_schema = 'public'
              and table_name in ('depth_uploads','depth_batches','baseline_cells','audit_log','app_config','rate_events')),
          0::bigint, 'service-only tables have no client grants');

-- ---- CHECK constraints (run as the superuser session role: constraints, not RLS) -------------
select tests.act_admin();

select lives_ok($$insert into public.pings (author_id, type, geom, note)
                  values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326), repeat('x', 140))$$,
                'ping note of exactly 140 chars is accepted');
select throws_ok($$insert into public.pings (author_id, type, geom, note)
                   values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326), repeat('x', 141))$$,
                 '23514', null, 'ping note of 141 chars is rejected by CHECK');
select throws_ok($$insert into public.pings (author_id, type, geom)
                   values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-125.0, 48.3), 4326))$$,
                 '23514', null, 'ping west of the Salish Sea box is rejected');
select throws_ok($$insert into public.pings (author_id, type, geom)
                   values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 45.0), 4326))$$,
                 '23514', null, 'ping south of the Salish Sea box is rejected');
select throws_ok($$insert into public.pings (author_id, type, geom)
                   values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 48.3), 3857))$$,
                 '22023', null, 'ping with the wrong SRID is rejected (geometry typmod)');
select lives_ok($$insert into public.pings (author_id, type, geom)
                  values ('00000000-0000-0000-0000-0000000000a1', 'bar_moved', st_setsrid(st_makepoint(-124.0, 46.9), 4326))$$,
                'ping on the box corner (boundary) is accepted');
select throws_ok($$insert into public.pings (author_id, type, geom)
                   values ('00000000-0000-0000-0000-0000000000a1', 'sandbar', st_setsrid(st_makepoint(-122.5, 48.3), 4326))$$,
                 '22P02', null, 'ping type outside the enum is rejected');
select throws_ok($$insert into public.pings (author_id, type, geom, created_at)
                   values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326), now() + interval '8 days')$$,
                 '23514', null, 'ping created more than 7 days in the future is rejected');
select lives_ok($$insert into public.pings (author_id, type, geom, created_at)
                  values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326), now() + interval '6 days')$$,
                'ping created 6 days in the future (device clock skew) is accepted');
select lives_ok($$insert into public.pings (author_id, type, geom, created_at)
                  values ('00000000-0000-0000-0000-0000000000a1', 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326), now() - interval '20 days')$$,
                'ping created 20 days ago (long offline) is accepted');
select is((select expires_at - created_at from public.pings
            where author_id = '00000000-0000-0000-0000-0000000000a1' and type = 'bar_moved'),
          interval '48 hours', 'expires_at defaults to created_at + 48 h');

select lives_ok($$insert into public.messages (group_id, author_id, body)
                  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', repeat('m', 500))$$,
                'message of exactly 500 chars is accepted');
select throws_ok($$insert into public.messages (group_id, author_id, body)
                   values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', repeat('m', 501))$$,
                 '23514', null, 'message of 501 chars is rejected');
select throws_ok($$insert into public.messages (group_id, author_id, body)
                   values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '')$$,
                 '23514', null, 'empty message is rejected');

select throws_ok($$update public.profiles set reputation = 3.5 where handle = 'owner_one'$$,
                 '23514', null, 'reputation above 3.0 is rejected');
select throws_ok($$update public.profiles set reputation = 0.1 where handle = 'owner_one'$$,
                 '23514', null, 'reputation below 0.2 is rejected');
select throws_ok($$insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a9', 'u9@example.test');
                   update public.profiles set handle = 'x!' where id = '00000000-0000-0000-0000-0000000000a9'$$,
                 '23514', null, 'handle with illegal characters is rejected');
select throws_ok($$update public.groups set invite_code = 'SHORT' where id = '00000000-0000-0000-0000-0000000000b1'$$,
                 '23514', null, 'invite code must be 8 characters');
select is((select char_length(invite_code) from public.groups where id = '00000000-0000-0000-0000-0000000000b1'),
          8, 'server-generated invite code is 8 characters');
select ok((select invite_expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
             from public.groups where id = '00000000-0000-0000-0000-0000000000b1'),
          'invite code expires in 7 days');
select is((select role from public.group_members
            where group_id = '00000000-0000-0000-0000-0000000000b1'
              and user_id = '00000000-0000-0000-0000-0000000000a1'),
          'owner', 'creating a group makes the creator its owner member');

select throws_ok($$insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
                   values ('not-an-h3-cell', '2026-10-01', -10, -12, 5, 1)$$,
                 '23514', null, 'depth_cells rejects a malformed H3 id');
select throws_ok($$insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
                   values ('8c2a1072b59ffff', '2026-10-01', -10, -12, 0, 1)$$,
                 '23514', null, 'depth_cells rejects n = 0');
select lives_ok($$insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
                  values ('8c2a1072b59ffff', '2026-10-01', -10, -12, 5, 1)$$,
                'depth_cells accepts a valid res-12 cell');
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                   values ('abc', '8c2a1072b59ffff', '2026-10-01', -10, -12, 5)$$,
                 '23514', null, 'depth_uploads requires a 64-hex uploader_hash');
select throws_ok($$insert into public.ping_votes (ping_id, voter_id, vote)
                   select id, '00000000-0000-0000-0000-0000000000a2', 0 from public.pings limit 1$$,
                 '23514', null, 'ping_votes.vote must be +1 or -1');

-- ---- hardening round: B3 p10, E6 day, dropped columns, E1/E10 function privileges ---------------------
select tests.act_admin();
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                   values (repeat('1', 64), '8c2a1072b59ffff', '2026-10-01', 10, 11, 5)$$,
                 '23514', null, 'B3: depth_uploads rejects p10 deeper than the median (p10 is shoal-biased)');
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                   values (repeat('1', 64), '8c2a1072b59ffff', '2026-10-01', 10, -2500, 5)$$,
                 '23514', null, 'B3: depth_uploads rejects p10 outside +-2000 ft');
select throws_ok($$insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
                   values ('8c2a1072b59ffff', '2026-10-02', 10, 11, 5, 3)$$,
                 '23514', null, 'B3: depth_cells rejects p10 deeper than the median');
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n)
                   values (repeat('1', 64), '8c2a1072b59ffff', 'infinity', 10, 9, 5)$$,
                 '23514', null, 'E6: depth_uploads rejects day = infinity');
select throws_ok($$insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n, held)
                   values (repeat('1', 64), '8c2a1072b59ffff', '2026-10-01', 10, 9, 5, true)$$,
                 '428C9', null, 'depth_uploads.held is derived from held_reason and cannot be written');
select hasnt_column('public', 'depth_batches', 'row_count', 'dead column dropped: depth_batches.row_count');
select hasnt_column('public', 'depth_batches', 'held_count', 'dead column dropped: depth_batches.held_count');
select hasnt_column('public', 'depth_cell_aggregates', 'period_end', 'dead column dropped: depth_cell_aggregates.period_end');
select is(has_function_privilege('authenticated', 'public.author_publicly_visible(uuid)', 'execute'), false, 'E1: authenticated cannot call author_publicly_visible (it would reveal revoked accounts)');
select is(has_function_privilege('authenticated', 'public.ping_visible(uuid, uuid)', 'execute'), true, 'ping_visible stays callable (RLS policy)');
select is(has_function_privilege('anon', 'public.in_salish_sea(extensions.geometry)', 'execute'), false, 'E10: anon cannot execute in_salish_sea');
select is(has_function_privilege('anon', 'public.vote_weight(double precision)', 'execute'), false, 'E10: anon cannot execute vote_weight');
select is(has_function_privilege('authenticated', 'public.rate_limit_refund(uuid, text)', 'execute'), false, 'rate_limit_refund is service-only');
select is(has_function_privilege('authenticated', 'public.ping_vote_stats(uuid, timestamptz)', 'execute'), true, 'ping_vote_stats is callable (ping_feed lateral); it re-checks visibility itself');
select ok(pg_get_expr((select adbin from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                        where d.adrelid = 'public.groups'::regclass and a.attname = 'owner_id'), 'public.groups'::regclass) ilike '%auth.uid()%',
          'B1: groups.owner_id defaults to auth.uid()');
select hasnt_constraint('public', 'groups', 'groups_invite_len', 'dead constraint dropped: groups_invite_len (implied by the charset check)');

select * from finish();
rollback;
