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

select plan(72);

-- =============================== retention ===================================================
select tests.act_admin();
insert into public.pings (id, author_id, type, geom) values
  (tests.c(1), tests.u(1), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326)),   -- will be 400 days old
  (tests.c(2), tests.u(1), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326));   -- recent
update public.pings set received_at = now() - interval '400 days', created_at = now() - interval '400 days',
       expires_at = now() - interval '398 days' where id = tests.c(1);
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m, created_at) values
  (tests.c(2), tests.u(2),  1, 100, now() - interval '400 days'),
  (tests.c(2), tests.u(3),  1, 100, now() - interval '2 days');
insert into public.messages (id, group_id, author_id, body, created_at) values
  (tests.c(1), tests.g(), tests.u(1), 'old', now() - interval '100 days'),
  (tests.c(2), tests.g(), tests.u(1), 'recent', now() - interval '30 days'),
  (tests.c(9), tests.g(), tests.u(1), 'written 100 days ago offline, delivered just now', now() - interval '100 days');
-- retention keys on the SERVER receipt time (received_at is forced to now() at insert; backdate it here)
update public.messages set received_at = created_at where id in (tests.c(1), tests.c(2));
insert into public.last_positions (user_id, geom) values
  (tests.u(1), st_setsrid(st_makepoint(-122.5, 48.3), 4326)),
  (tests.u(2), st_setsrid(st_makepoint(-122.5, 48.3), 4326));
alter table public.last_positions disable trigger last_positions_before_write;
update public.last_positions set updated_at = now() - interval '25 hours' where user_id = tests.u(1);
alter table public.last_positions enable trigger last_positions_before_write;
insert into public.depth_batches (batch_id, user_id, received_at) values
  (tests.c(1), tests.u(1), now() - interval '8 days'), (tests.c(2), tests.u(1), now() - interval '1 day');
insert into public.depth_uploads (uploader_hash, cell_id, day, median_ft, p10_ft, n, held, held_reason) values
  (repeat('a', 64), '8c2a1072b59ff01', (now() at time zone 'utc')::date - 200, -10, -12, 5, false, null),     -- >180 d: deleted
  (repeat('b', 64), '8c2a1072b59ff02', (now() at time zone 'utc')::date - 5,   -10, -12, 5, false, null),     -- recent: kept
  (repeat('c', 64), '8c2a1072b59ff03', (now() at time zone 'utc')::date - 40,  -50, -52, 5, true, 'baseline_disagreement'), -- stale hold: deleted
  (repeat('d', 64), '8c2a1072b59ff04', (now() at time zone 'utc')::date - 10,  -50, -52, 5, true, 'baseline_disagreement'), -- fresh hold: kept
  (repeat('e', 64), '8c2a1072b59ff05', (now() at time zone 'utc')::date - 40,  -50, -52, 5, true, 'admin');                  -- admin hold: kept

-- daily cells to roll: three old days in ONE 90-day bucket for cell X, plus a recent cell Y
create temp table _b as select public.depth_bucket_start((now() at time zone 'utc')::date - 300) as b;
grant select on _b to public;
select is((select b from _b) - date '1970-01-01', ((select b from _b) - date '1970-01-01') / 90 * 90, 'depth_bucket_start is aligned to 90-day multiples from 1970-01-01');
insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
select '8c2a1072b59ff10', (select b from _b) + d, m, p, n, bo
  from (values (0, -10.0, -12.0, 10, 3), (10, -12.0, -15.0, 30, 4), (20, -14.0, -17.0, 10, 2)) v(d, m, p, n, bo);
-- a cell only ever seen by 2 boats (never publishable): deleted at 180 days, never rolled up
insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
values ('8c2a1072b59ff12', (select b from _b) + 5, -9, -10, 20, 2);
insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
values ('8c2a1072b59ff11', (now() at time zone 'utc')::date - 3, -9, -10, 10, 3);

select tests.act_as(tests.u(1));
select throws_ok($$select public.run_retention()$$, '42501', null, 'run_retention: not callable by clients');
select tests.act_service();
select ok((public.run_retention(now()) ->> 'pings_deleted')::int >= 1, 'run_retention returns counts');

select tests.act_admin();
select is((select count(*) from public.pings where id = tests.c(1)), 0::bigint, 'pings older than 1 year are deleted');
select is((select count(*) from public.pings where id = tests.c(2)), 1::bigint, 'recent pings are kept');
select is((select count(*) from public.ping_votes where ping_id = tests.c(2)), 1::bigint, 'votes older than 1 year are deleted, recent kept');
select is((select count(*) from public.messages where id = tests.c(1)), 0::bigint, 'messages older than 90 days are deleted');
select is((select count(*) from public.messages where id = tests.c(2)), 1::bigint, 'recent messages are kept');
select is((select count(*) from public.messages where id = tests.c(9)), 1::bigint, 'S9: retention counts from server receipt, so a message delivered just now is kept despite an old device timestamp');
select is((select count(*) from public.last_positions where user_id = tests.u(1)), 0::bigint, 'last positions older than 24 h are deleted');
select is((select count(*) from public.last_positions where user_id = tests.u(2)), 1::bigint, 'fresh last positions are kept');
select is((select count(*) from public.depth_batches where batch_id = tests.c(1)), 0::bigint, 'idempotency ledger older than 7 days is deleted');
select is((select count(*) from public.depth_batches where batch_id = tests.c(2)), 1::bigint, 'recent batch ledger kept');
select is((select count(*) from public.depth_uploads where uploader_hash = repeat('a', 64)), 0::bigint, 'uploads older than 180 days are deleted');
select is((select count(*) from public.depth_uploads where uploader_hash = repeat('b', 64)), 1::bigint, 'recent uploads kept');
select is((select count(*) from public.depth_uploads where uploader_hash = repeat('c', 64)), 0::bigint, 'baseline holds older than 30 days are purged');
select is((select count(*) from public.depth_uploads where uploader_hash = repeat('d', 64)), 1::bigint, 'fresh baseline holds are kept');
select is((select count(*) from public.depth_uploads where uploader_hash = repeat('e', 64)), 1::bigint, 'admin holds are never auto-purged');

select is((select count(*) from public.depth_cells where cell_id = '8c2a1072b59ff10'), 0::bigint, 'daily cells older than 180 days are deleted');
select is((select count(*) from public.depth_cells where cell_id = '8c2a1072b59ff11'), 1::bigint, 'recent daily cells are kept');
select is((select median_ft from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), -12::float8, 'rolled 90-day aggregate: n-weighted median of the daily medians');
select is((select p10_ft from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), -15::float8, 'rolled 90-day aggregate: n-weighted p10 (the 2-boat day is excluded)');
select is((select n from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), 40, 'rolled aggregate sums n of the >= 3-boat days only');
select is((select count(*) from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff12'), 0::bigint, 'S10: a cell that never had 3 boats is not rolled into an aggregate');
select is((select count(*) from public.depth_cells where cell_id = '8c2a1072b59ff12'), 0::bigint, 'S10: ...and its daily row is still deleted after 180 days');
select is((select boats from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), 4, 'rolled aggregate keeps the max daily boat count');
select is((select period_start from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), (select b from _b), 'aggregate period starts at the bucket start');
select is((select period_end - period_start from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), 90, 'aggregate spans 90 days');

-- incremental: another old day for the same cell and bucket merges into the existing aggregate
insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats)
values ('8c2a1072b59ff10', (select b from _b) + 30, -8, -9, 50, 3);
select tests.act_service();
select lives_ok($$select public.run_retention(now())$$, 'run_retention is repeatable');
select tests.act_admin();
select is((select n from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), 90, 'second roll merges into the existing aggregate (n = 40 + 50)');
select is((select median_ft from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), -8::float8, 'merged median: (-12, w40) and (-8, w50) -> lower weighted median -8');
select is((select count(*) from public.depth_cell_aggregates where cell_id = '8c2a1072b59ff10'), 1::bigint, 'still one aggregate row per (cell, bucket)');
select is((select count(*) from public.audit_log where action = 'retention.run'), 2::bigint, 'each retention run is logged');

-- last-position purge as its own job
select tests.act_admin();
insert into public.last_positions (user_id, geom) values (tests.u(3), st_setsrid(st_makepoint(-122.5, 48.3), 4326));
alter table public.last_positions disable trigger last_positions_before_write;
update public.last_positions set updated_at = now() - interval '23 hours 59 minutes' where user_id = tests.u(3);
alter table public.last_positions enable trigger last_positions_before_write;
select tests.act_service();
select is(public.purge_last_positions(now()), 0, 'purge_last_positions: 23h59m old is kept');
select is(public.purge_last_positions(now() + interval '2 minutes'), 1, 'purge_last_positions: the 23h59m row is removed once it passes 24 h; the fresh row stays');

-- =============================== account deletion =============================================
select tests.act_admin();
insert into public.groups (id, name, owner_id) values
  ('00000000-0000-0000-0000-0000000000b2', 'U3 crew', tests.u(3)),
  ('00000000-0000-0000-0000-0000000000b3', 'U1 solo', tests.u(1));
insert into public.group_members (group_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000b2', tests.u(2), 'member'),
  (tests.g(), tests.u(3), 'member');
insert into public.pings (id, author_id, group_id, type, geom) values
  (tests.c(3), tests.u(3), null, 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326)),
  (tests.c(4), tests.u(3), '00000000-0000-0000-0000-0000000000b2', 'gear', st_setsrid(st_makepoint(-122.5, 48.3), 4326)),
  (tests.c(5), tests.u(1), null, 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326));
insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m) values (tests.c(5), tests.u(3), 1, 100), (tests.c(3), tests.u(2), 1, 100);
insert into public.messages (id, group_id, author_id, body, ping_id) values
  (tests.c(3), '00000000-0000-0000-0000-0000000000b2', tests.u(3), 'bye', null),
  (tests.c(4), '00000000-0000-0000-0000-0000000000b2', tests.u(2), 'refers to u3 ping', tests.c(4));
insert into public.depth_batches (batch_id, user_id) values (tests.c(6), tests.u(3));
insert into public.depth_cells (cell_id, day, median_ft, p10_ft, n, boats) values ('8c2a1072b59ff20', '2026-10-01', -11, -12, 9, 3);

select tests.act_service();
select is((public.delete_account_data(tests.u(3))) ->> 'pings', '2', 'delete_account_data reports 2 pings removed for u3');
select tests.act_admin();
select is((select count(*) from public.profiles where id = tests.u(3)), 0::bigint, 'profile removed');
select is((select count(*) from public.pings where author_id = tests.u(3)), 0::bigint, 'pings removed');
select is((select count(*) from public.ping_votes where voter_id = tests.u(3)), 0::bigint, 'votes cast by the account removed');
select is((select count(*) from public.ping_votes where ping_id = tests.c(3)), 0::bigint, 'votes on the account''s pings go with them');
select is((select count(*) from public.messages where author_id = tests.u(3)), 0::bigint, 'messages removed');
select is((select ping_id from public.messages where id = tests.c(4)), null::uuid, 'other people''s messages that referenced a deleted ping survive, link cleared');
select is((select count(*) from public.group_members where user_id = tests.u(3)), 0::bigint, 'memberships removed');
select is((select count(*) from public.depth_batches where user_id = tests.u(3)), 0::bigint, 'upload ledger removed');
select is((select owner_id from public.groups where id = '00000000-0000-0000-0000-0000000000b2'), tests.u(2), 'owned group passes to the remaining member');
select is((select role from public.group_members where group_id = '00000000-0000-0000-0000-0000000000b2' and user_id = tests.u(2)), 'owner', 'new owner holds the owner role');
select is((select count(*) from public.depth_cells where cell_id = '8c2a1072b59ff20'), 1::bigint, 'aggregated depth cells remain (they cannot be attributed)');
select is((select count(*) from public.audit_log where action = 'account.delete' and target_id = tests.u(3)::text), 1::bigint, 'deletion is logged');

select tests.act_service();
select lives_ok($$select public.delete_account_data(tests.u(1))$$, 'delete the owner of the fixture group and of a solo group');
select tests.act_admin();
select is((select count(*) from public.groups where id = '00000000-0000-0000-0000-0000000000b3'), 0::bigint, 'a solo group disappears with its owner');
select is((select owner_id from public.groups where id = tests.g()), tests.u(2), 'fixture group passes to its remaining member');
select lives_ok($$select public.delete_account_data(tests.u(1))$$, 'deleting an already-deleted account is a harmless no-op');

-- =============================== admin: revoke account =============================================
select tests.act_admin();
insert into public.pings (id, author_id, type, geom) values (tests.c(7), tests.u(4), 'log', st_setsrid(st_makepoint(-122.5, 48.3), 4326));
insert into public.last_positions (user_id, geom) values (tests.u(4), st_setsrid(st_makepoint(-122.5, 48.3), 4326));
select tests.act_service();
select lives_ok($$select public.admin_revoke_account(tests.u(2), tests.u(4), 'spam')$$, 'admin_revoke_account runs');
select tests.act_admin();
select ok((select revoked_at from public.profiles where id = tests.u(4)) is not null, 'profile marked revoked');
select is((select count(*) from public.last_positions where user_id = tests.u(4)), 0::bigint, 'revoked account''s position is dropped');
select is((select details ->> 'reason' from public.audit_log where action = 'admin.revoke_account'), 'spam', 'revocation is audited with the reason');
select tests.act_as(tests.u(2));
select is((select count(*) from public.pings where id = tests.c(7)), 0::bigint, 'revoked account''s public pings are hidden from others');
select tests.act_service();
select throws_ok($$select public.admin_revoke_account(tests.u(2), gen_random_uuid(), null)$$, 'PT404', null, 'revoking an unknown account is a 404');

-- =============================== S1: a revoked account cannot erase itself ========================
select tests.act_service();
select throws_ok($$select public.delete_account_data(tests.u(4))$$, 'PT403', 'account_revoked', 'S1: self-deletion is refused for a revoked profile');
select is((select count(*) from public.profiles where id = tests.u(4)), 1::bigint, 'S1: the revoked profile and its pings are still there for review');
select is((select count(*) from public.pings where id = tests.c(7)), 1::bigint, 'S1: its pings are preserved');
select lives_ok($$select public.delete_account_data(tests.u(4), false)$$, 'S1: an operator-initiated deletion (p_self = false) still works');

-- =============================== S8: audit_log cannot be rewritten ==================================
select tests.act_service();
select throws_ok($$truncate public.audit_log$$, '42501', null, 'S8: the service role cannot truncate audit_log');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'S8: the service role cannot delete audit rows');
select throws_ok($$update public.audit_log set action = 'x'$$, '42501', null, 'S8: the service role cannot update audit rows');
select tests.act_admin();
select throws_ok($$truncate public.audit_log$$, '42501', null, 'S8: even the table owner is stopped by the truncate trigger');

-- admin.denied / admin.invalid_request flood control: one row per actor per 10 minutes
select tests.act_service();
select lives_ok($$select public.admin_audit(tests.u(3), 'admin.denied', null, null, '{}') from generate_series(1, 20)$$, '20 denied attempts in a row');
select is((select count(*) from public.audit_log where action = 'admin.denied' and actor = tests.u(3)), 1::bigint, 'S8: only one admin.denied row is written per actor per 10 minutes');
select lives_ok($$select public.admin_audit(tests.u(3), 'admin.invalid_request') from generate_series(1, 5)$$, 'invalid requests');
select is((select count(*) from public.audit_log where action = 'admin.invalid_request' and actor = tests.u(3)), 1::bigint, 'S8: invalid_request noise is throttled too');
select lives_ok($$select public.admin_audit(tests.u(3), 'admin.revoke_account.ban_failed') from generate_series(1, 3)$$, 'real admin events');
select is((select count(*) from public.audit_log where action = 'admin.revoke_account.ban_failed'), 3::bigint, 'S8: real admin actions are never deduplicated');

select * from finish();
rollback;
