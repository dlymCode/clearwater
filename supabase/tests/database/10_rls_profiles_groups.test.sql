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

select plan(81);

-- Roles in this file: u1 = owner, u2 = group member, u3 = signed-in non-member, anon.

-- =============================== profiles ==================================================
select tests.act_as(tests.u(1));
select is((select count(*) from public.profiles where id = tests.u(1)), 1::bigint, 'profiles select: owner reads own row');
select tests.act_as(tests.u(2));
select is((select count(*) from public.profiles), 4::bigint, 'profiles select: group member reads all signed-in profiles');
select tests.act_as(tests.u(3));
select is((select count(*) from public.profiles), 4::bigint, 'profiles select: non-member reads all signed-in profiles');
select is((select reputation from public.profiles where id = tests.u(1)), 1.0::double precision, 'profiles select: reputation is readable so clients can score pings offline');
select tests.act_anon();
select throws_ok($$select * from public.profiles$$, '42501', null, 'profiles select: anon denied');

-- insert (u5 has an auth user but no profile yet)
select tests.act_admin();
insert into auth.users (id, email) values (tests.u(5), 'u5@example.test'), (tests.u(6), 'u6@example.test');
select tests.act_as(tests.u(5));
select lives_ok($$insert into public.profiles (id, handle) values (tests.u(5), 'newcomer_five')$$,
                'profiles insert: owner creates own profile');
select is((select reputation from public.profiles where id = tests.u(5)), 1.0::double precision,
          'profiles insert: new account starts at reputation 1.0');
select throws_ok($$insert into public.profiles (id, handle) values (tests.u(6), 'forged_six')$$,
                 '42501', null, 'profiles insert: cannot create a profile for someone else');
select tests.act_admin();
delete from public.profiles where id = tests.u(5);
select tests.act_as(tests.u(5));
select throws_ok($$insert into public.profiles (id, handle, reputation) values (tests.u(5), 'cheater_five', 3.0)$$,
                 '42501', null, 'profiles insert: cannot choose own reputation (column privilege)');
select tests.act_anon();
select throws_ok($$insert into public.profiles (id, handle) values (tests.u(6), 'anon_six')$$,
                 '42501', null, 'profiles insert: anon denied');

-- update
select tests.act_as(tests.u(1));
select is(tests.dml($$update public.profiles set vessel_name = 'F/V Renamed' where id = tests.u(1)$$), 1::bigint,
          'profiles update: owner edits own vessel name');
select throws_ok($$update public.profiles set reputation = 3.0 where id = tests.u(1)$$,
                 '42501', null, 'profiles update: owner cannot raise own reputation');
select throws_ok($$update public.profiles set revoked_at = null where id = tests.u(1)$$,
                 '42501', null, 'profiles update: owner cannot touch revoked_at');
select tests.act_as(tests.u(2));
select is(tests.dml($$update public.profiles set vessel_name = 'hijack' where id = tests.u(1)$$), 0::bigint,
          'profiles update: group member cannot edit another profile');
select tests.act_as(tests.u(3));
select is(tests.dml($$update public.profiles set vessel_name = 'hijack' where id = tests.u(1)$$), 0::bigint,
          'profiles update: non-member cannot edit another profile');
select tests.act_anon();
select throws_ok($$update public.profiles set vessel_name = 'x'$$, '42501', null, 'profiles update: anon denied');

-- delete (no delete grant at all: accounts are removed by the account-delete function)
select tests.act_as(tests.u(1));
select throws_ok($$delete from public.profiles where id = tests.u(1)$$, '42501', null, 'profiles delete: owner denied');
select tests.act_as(tests.u(2));
select throws_ok($$delete from public.profiles where id = tests.u(1)$$, '42501', null, 'profiles delete: group member denied');
select tests.act_as(tests.u(3));
select throws_ok($$delete from public.profiles where id = tests.u(1)$$, '42501', null, 'profiles delete: non-member denied');
select tests.act_anon();
select throws_ok($$delete from public.profiles$$, '42501', null, 'profiles delete: anon denied');

-- =============================== groups ====================================================
select tests.act_as(tests.u(1));
select is((select count(*) from public.groups where id = tests.g()), 1::bigint, 'groups select: owner');
select tests.act_as(tests.u(2));
select is((select count(*) from public.groups where id = tests.g()), 1::bigint, 'groups select: member');
select tests.act_as(tests.u(3));
select is((select count(*) from public.groups where id = tests.g()), 0::bigint, 'groups select: non-member sees nothing');
select tests.act_anon();
select throws_ok($$select * from public.groups$$, '42501', null, 'groups select: anon denied');

select tests.act_as(tests.u(3));
select lives_ok($$insert into public.groups (id, name, owner_id)
                  values ('00000000-0000-0000-0000-0000000000b2', 'Outsiders', tests.u(3))$$,
                'groups insert: any signed-in user creates a group they own');
select is((select count(*) from public.group_members
            where group_id = '00000000-0000-0000-0000-0000000000b2' and user_id = tests.u(3) and role = 'owner'),
          1::bigint, 'groups insert: creator becomes owner member and can read the group');
select throws_ok($$insert into public.groups (name, owner_id) values ('Stolen', tests.u(1))$$,
                 '42501', null, 'groups insert: cannot create a group owned by someone else');
select throws_ok($$insert into public.groups (name, owner_id, invite_code) values ('Mine', tests.u(3), 'AAAAAAAA')$$,
                 '42501', null, 'groups insert: client cannot choose the invite code');
select tests.act_anon();
select throws_ok($$insert into public.groups (name, owner_id) values ('Anon', tests.u(3))$$,
                 '42501', null, 'groups insert: anon denied');

select tests.act_as(tests.u(1));
select is(tests.dml($$update public.groups set name = 'Skagit Crew 2' where id = tests.g()$$), 1::bigint, 'groups update: owner renames');
select throws_ok($$update public.groups set invite_code = 'ZZZZZZZZ' where id = tests.g()$$,
                 '42501', null, 'groups update: owner cannot set invite code directly (rotate_invite_code only)');
select tests.act_as(tests.u(2));
select is(tests.dml($$update public.groups set name = 'Mine now' where id = tests.g()$$), 0::bigint, 'groups update: member cannot rename');
select tests.act_as(tests.u(3));
select is(tests.dml($$update public.groups set name = 'Mine now' where id = tests.g()$$), 0::bigint, 'groups update: non-member cannot rename');
select tests.act_anon();
select throws_ok($$update public.groups set name = 'x'$$, '42501', null, 'groups update: anon denied');

select tests.act_as(tests.u(2));
select is(tests.dml($$delete from public.groups where id = tests.g()$$), 0::bigint, 'groups delete: member cannot delete');
select tests.act_as(tests.u(3));
select is(tests.dml($$delete from public.groups where id = tests.g()$$), 0::bigint, 'groups delete: non-member cannot delete');
select tests.act_anon();
select throws_ok($$delete from public.groups$$, '42501', null, 'groups delete: anon denied');
select tests.act_as(tests.u(3));
select is(tests.dml($$delete from public.groups where id = '00000000-0000-0000-0000-0000000000b2'$$), 1::bigint,
          'groups delete: owner deletes own group');

-- invite codes: rotate (owner only) and join
select tests.act_admin();
create temp table _codes as select invite_code as old_code from public.groups where id = tests.g();
grant select on _codes to authenticated, anon;
select tests.act_as(tests.u(2));
select throws_ok($$select * from public.rotate_invite_code(tests.g())$$, 'PT403', null, 'rotate_invite_code: member denied');
select tests.act_as(tests.u(3));
select throws_ok($$select * from public.rotate_invite_code(tests.g())$$, 'PT403', null, 'rotate_invite_code: non-member denied');
select tests.act_anon();
select throws_ok($$select * from public.rotate_invite_code(tests.g())$$, '42501', null, 'rotate_invite_code: anon denied');
select tests.act_as(tests.u(1));
select lives_ok($$select * from public.rotate_invite_code(tests.g())$$, 'rotate_invite_code: owner may rotate');
select isnt((select invite_code from public.get_invite_code(tests.g())), (select old_code from _codes),
            'rotate_invite_code: code changed');
select throws_ok($$select invite_code from public.groups where id = tests.g()$$, '42501', null, 'groups: invite_code is not a selectable column even for the owner');
select throws_ok($$select * from public.groups$$, '42501', null, 'groups: select * is denied (invite_code column)');
select lives_ok($$select id, name, owner_id, invite_expires_at from public.groups$$, 'groups: the other columns remain readable');
select tests.act_as(tests.u(2));
select throws_ok($$select invite_code from public.groups$$, '42501', null, 'groups: a member cannot read the invite code');
select throws_ok($$select * from public.get_invite_code(tests.g())$$, 'PT403', null, 'get_invite_code: member denied');
select tests.act_as(tests.u(4));
select throws_ok($$select * from public.get_invite_code(tests.g())$$, 'PT403', null, 'get_invite_code: non-member denied');
select tests.act_anon();
select throws_ok($$select * from public.get_invite_code(tests.g())$$, '42501', null, 'get_invite_code: anon denied');
select tests.act_as(tests.u(1));
select is((select count(*) from public.get_invite_code(tests.g())), 1::bigint, 'get_invite_code: owner reads the code');
select tests.act_as(tests.u(3));
select is((select public.join_group((select old_code from _codes))), null::uuid, 'join_group: the rotated-out code no longer works');
select tests.act_admin();
create temp table _newcode as select invite_code as code from public.groups where id = tests.g();
grant select on _newcode to authenticated;
update public.groups set invite_expires_at = now() - interval '1 minute' where id = tests.g();
select tests.act_as(tests.u(3));
select is((select public.join_group((select code from _newcode))), null::uuid, 'join_group: expired code is refused');
select tests.act_admin();
update public.groups set invite_expires_at = now() + interval '7 days' where id = tests.g();
select tests.act_as(tests.u(3));
select lives_ok(format($$select public.join_group(%L)$$, lower((select code from _newcode))),
                'join_group: valid code (case-insensitive) joins');
select is((select count(*) from public.groups where id = tests.g()), 1::bigint, 'join_group: new member can now read the group');
select tests.act_anon();
select throws_ok($$select public.join_group('AAAAAAAA')$$, '42501', null, 'join_group: anon denied');

-- =============================== group_members ================================================
-- roster now: u1 owner, u2 member, u3 member
select tests.act_as(tests.u(1));
select is((select count(*) from public.group_members where group_id = tests.g()), 3::bigint, 'group_members select: owner sees roster');
select tests.act_as(tests.u(2));
select is((select count(*) from public.group_members where group_id = tests.g()), 3::bigint, 'group_members select: member sees roster');
select tests.act_as(tests.u(4));
select is((select count(*) from public.group_members where group_id = tests.g()), 0::bigint, 'group_members select: non-member sees nothing');
select tests.act_anon();
select throws_ok($$select * from public.group_members$$, '42501', null, 'group_members select: anon denied');

select tests.act_as(tests.u(1));
select throws_ok($$insert into public.group_members (group_id, user_id, role) values (tests.g(), tests.u(4), 'member')$$,
                 '42501', null, 'group_members insert: owner denied (joining is join_group)');
select tests.act_as(tests.u(2));
select throws_ok($$insert into public.group_members (group_id, user_id, role) values (tests.g(), tests.u(4), 'owner')$$,
                 '42501', null, 'group_members insert: member denied');
select tests.act_as(tests.u(4));
select throws_ok($$insert into public.group_members (group_id, user_id, role) values (tests.g(), tests.u(4), 'member')$$,
                 '42501', null, 'group_members insert: non-member cannot add self');
select tests.act_anon();
select throws_ok($$insert into public.group_members (group_id, user_id, role) values (tests.g(), tests.u(4), 'member')$$,
                 '42501', null, 'group_members insert: anon denied');

select tests.act_as(tests.u(1));
select throws_ok($$update public.group_members set role = 'owner' where user_id = tests.u(2)$$,
                 '42501', null, 'group_members update: owner denied (no role changes in v1)');
select tests.act_as(tests.u(2));
select throws_ok($$update public.group_members set role = 'owner' where user_id = tests.u(2)$$,
                 '42501', null, 'group_members update: member cannot promote self');
select tests.act_as(tests.u(4));
select throws_ok($$update public.group_members set role = 'owner'$$, '42501', null, 'group_members update: non-member denied');
select tests.act_anon();
select throws_ok($$update public.group_members set role = 'owner'$$, '42501', null, 'group_members update: anon denied');

select tests.act_as(tests.u(4));
select is(tests.dml($$delete from public.group_members where group_id = tests.g()$$), 0::bigint, 'group_members delete: non-member removes nothing');
select tests.act_as(tests.u(2));
select is(tests.dml($$delete from public.group_members where user_id = tests.u(3)$$), 0::bigint, 'group_members delete: member cannot remove another member');
select is(tests.dml($$delete from public.group_members where user_id = tests.u(1)$$), 0::bigint, 'group_members delete: member cannot remove the owner');
select tests.act_as(tests.u(1));
select is(tests.dml($$delete from public.group_members where user_id = tests.u(1)$$), 0::bigint, 'group_members delete: owner cannot remove themself');
select is(tests.dml($$delete from public.group_members where user_id = tests.u(3)$$), 1::bigint, 'group_members delete: owner removes a member');
select tests.act_as(tests.u(3));
select is((select count(*) from public.groups where id = tests.g()), 0::bigint, 'removal revokes group access immediately');
select is((select public.join_group((select code from _newcode))), null::uuid, 'removed member cannot rejoin with the invite code they knew (code rotated on removal)');
select tests.act_admin();
select isnt((select invite_code from public.groups where id = tests.g()), (select code from _newcode), 'owner removal rotated the stored invite code');
select tests.act_as(tests.u(3));
select tests.act_as(tests.u(2));
select is(tests.dml($$delete from public.group_members where user_id = tests.u(2)$$), 1::bigint, 'group_members delete: member leaves');
select tests.act_anon();
select throws_ok($$delete from public.group_members$$, '42501', null, 'group_members delete: anon denied');

-- join_group is throttled: 10 attempts per 15 minutes per user
select tests.act_as(tests.u(4));
do $$ begin for i in 1..10 loop perform public.join_group('AAAAAAAA'); end loop; end $$;
select throws_ok($$select public.join_group('AAAAAAAA')$$, 'PT429', null, 'join_group: the 11th attempt in 15 minutes returns 429');

-- profiles.revoked_at is not selectable
select tests.act_as(tests.u(1));
select throws_ok($$select revoked_at from public.profiles$$, '42501', null, 'profiles: revoked_at is not a selectable column');
select throws_ok($$update public.profiles set revoked_at = now()$$, '42501', null, 'profiles: revoked_at is not updatable');

select * from finish();
rollback;
