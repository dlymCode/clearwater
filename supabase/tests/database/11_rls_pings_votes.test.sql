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

select plan(113);

-- Pings: c1 = u1 public, c2 = u1 in group G, c3 = u3 public. Skagit Bay, ~(-122.5, 48.3).
select tests.act_admin();
insert into public.pings (id, author_id, group_id, type, geom, note) values
  (tests.c(1), tests.u(1), null,       'bar_moved', st_setsrid(st_makepoint(-122.5, 48.3), 4326), 'public bar'),
  (tests.c(2), tests.u(1), tests.g(),  'gear',      st_setsrid(st_makepoint(-122.5, 48.3), 4326), 'group gear'),
  (tests.c(3), tests.u(3), null,       'log',       st_setsrid(st_makepoint(-122.5, 48.3), 4326), 'u3 log');

-- =============================== pings: select ================================================
select tests.act_as(tests.u(1));
select is((select count(*) from public.pings), 3::bigint, 'pings select: author sees own group + public pings');
select tests.act_as(tests.u(2));
select is((select count(*) from public.pings), 3::bigint, 'pings select: group member sees public + group pings');
select tests.act_as(tests.u(3));
select is((select count(*) from public.pings), 2::bigint, 'pings select: non-member sees only public pings');
select is((select count(*) from public.pings where id = tests.c(2)), 0::bigint, 'pings select: group ping invisible to non-member');
select tests.act_anon();
select throws_ok($$select * from public.pings$$, '42501', null, 'pings select: anon denied');

-- ---- C1: authorship is not selectable from the table at all ------------------------------------------
select tests.act_as(tests.u(3));
select throws_ok($$select author_id from public.pings$$, '42501', null, 'pings: author_id is not selectable by a non-author (column privilege)');
select throws_ok($$select * from public.pings$$, '42501', null, 'pings: select * is denied (it would include author_id)');
select throws_ok($$select rep_processed_at from public.pings$$, '42501', null, 'pings: rep_processed_at is not selectable');
select throws_ok($$select id from public.pings where author_id = tests.u(1)$$, '42501', null, 'pings: cannot filter by author_id either (no author-probing oracle)');
select tests.act_as(tests.u(1));
select throws_ok($$select author_id from public.pings$$, '42501', null, 'pings: even the author reads authorship via ping_feed, not the table');
select is((select author_handle from public.ping_feed where id = tests.c(1)), 'owner_one', 'ping_feed: non-anonymous ping shows the handle');
select is((select author_id from public.ping_feed where id = tests.c(1)), tests.u(1), 'ping_feed: non-anonymous ping shows the author id');
select tests.act_as(tests.u(4));
select is((select author_handle from public.ping_feed where id = tests.c(1)), 'owner_one', 'ping_feed: other users see the handle of a non-anonymous ping');
select is((select count(*) from public.ping_feed where id = tests.c(2)), 0::bigint, 'ping_feed: a group ping does not leak to a non-member');
select is((select count(*) from public.ping_feed where group_id = tests.g()), 0::bigint, 'ping_feed: filtering by group does not leak either');
select has_column('public', 'ping_feed', 'author_reputation', 'ping_feed exposes author_reputation');
select is((select count(distinct id) from public.ping_feed), (select count(*) from public.ping_feed), 'ping_feed.id is unique (keyset pagination tie-break)');
select is((select count(*) from public.ping_feed where vote_sum is null or confirm_count is null or dispute_count is null), 0::bigint, 'ping_feed: vote_sum and the counts are never null (last_confirmed_at is null until the first confirm)');
select has_column('public', 'ping_feed', 'received_at', 'ping_feed exposes received_at');
select is((select author_reputation from public.ping_feed where id = tests.c(1)), 1.0::double precision, 'ping_feed: author_reputation for a normal ping');
select tests.act_anon();
select throws_ok($$select * from public.ping_feed$$, '42501', null, 'ping_feed: anon denied');
select tests.act_as(tests.u(3));

-- =============================== pings: insert ================================================
select tests.act_as(tests.u(1));
select lives_ok($$insert into public.pings (id, group_id, type, geom, note)
                  values (tests.c(4), null, 'touched_bottom', st_setsrid(st_makepoint(-122.4, 48.2), 4326), 'two taps')$$,
                'pings insert: author posts to the public tier (author_id defaults to uid)');
select is(tests.dml($$insert into public.pings (id, group_id, type, geom)
                      values (tests.c(4), null, 'touched_bottom', st_setsrid(st_makepoint(-122.4, 48.2), 4326))
                      on conflict (id) do nothing$$), 0::bigint,
          'pings insert: replay with the same client UUID is a no-op (idempotent sync)');
select tests.act_as(tests.u(2));
select lives_ok($$insert into public.pings (id, group_id, type, geom)
                  values (tests.c(5), tests.g(), 'log', st_setsrid(st_makepoint(-122.4, 48.2), 4326))$$,
                'pings insert: group member posts a group ping');
select tests.act_as(tests.u(3));
select throws_ok($$insert into public.pings (group_id, type, geom)
                   values (tests.g(), 'log', st_setsrid(st_makepoint(-122.4, 48.2), 4326))$$,
                 '42501', null, 'pings insert: non-member cannot post into a group');
select throws_ok($$insert into public.pings (author_id, type, geom)
                   values (tests.u(1), 'log', st_setsrid(st_makepoint(-122.4, 48.2), 4326))$$,
                 '42501', null, 'pings insert: cannot forge another author');
select throws_ok($$insert into public.pings (type, geom, score)
                   values ('log', st_setsrid(st_makepoint(-122.4, 48.2), 4326), 99)$$,
                 '42501', null, 'pings insert: score is not client-writable');
select throws_ok($$insert into public.pings (type, geom, created_at)
                   values ('log', st_setsrid(st_makepoint(-122.4, 48.2), 4326), now() + interval '8 days')$$,
                 '23514', null, 'pings insert: clock more than 7 days ahead rejected');
select throws_ok($$insert into public.pings (type, geom)
                   values ('log', st_setsrid(st_makepoint(-110.0, 40.0), 4326))$$,
                 '23514', null, 'pings insert: outside the Salish Sea polygon rejected');
select tests.act_anon();
select throws_ok($$insert into public.pings (author_id, type, geom)
                   values (tests.u(1), 'log', st_setsrid(st_makepoint(-122.4, 48.2), 4326))$$,
                 '42501', null, 'pings insert: anon denied');

-- =============================== pings: update (append-only) =====================================
select tests.act_as(tests.u(1));
select throws_ok($$update public.pings set note = 'edited' where id = tests.c(1)$$, '42501', null, 'pings update: author denied (append-only)');
select tests.act_as(tests.u(2));
select throws_ok($$update public.pings set note = 'edited' where id = tests.c(2)$$, '42501', null, 'pings update: group member denied');
select tests.act_as(tests.u(3));
select throws_ok($$update public.pings set group_id = null where id = tests.c(2)$$, '42501', null, 'pings update: non-member denied');
select tests.act_anon();
select throws_ok($$update public.pings set note = 'x'$$, '42501', null, 'pings update: anon denied');

-- =============================== pings: delete =====================================================
select tests.act_as(tests.u(2));
select is(tests.dml($$delete from public.pings where id = tests.c(2)$$), 0::bigint, 'pings delete: member cannot delete the author''s group ping');
select tests.act_as(tests.u(3));
select is(tests.dml($$delete from public.pings where id = tests.c(1)$$), 0::bigint, 'pings delete: non-member cannot delete someone else''s ping');
select tests.act_anon();
select throws_ok($$delete from public.pings$$, '42501', null, 'pings delete: anon denied');
select tests.act_as(tests.u(1));
select is(tests.dml($$delete from public.pings where id = tests.c(4)$$), 1::bigint, 'pings delete: author retracts own ping');

-- ============================= promote_ping / anonymous / reputation gate ==============================
select tests.act_as(tests.u(3));
select throws_ok($$select public.promote_ping(tests.c(2))$$, 'PT404', null, 'promote_ping: non-author denied');
select tests.act_as(tests.u(2));
select throws_ok($$select public.promote_ping(tests.c(2))$$, 'PT404', null, 'promote_ping: member who is not the author denied');
select tests.act_as(tests.u(1));
select lives_ok($$select public.promote_ping(tests.c(2))$$, 'promote_ping: author moves a group ping to the public tier');
select tests.act_as(tests.u(3));
select is((select count(*) from public.pings where id = tests.c(2)), 1::bigint, 'promote_ping: non-member can now see the promoted ping');

select tests.act_as(tests.u(2));
select throws_ok($$insert into public.pings (id, group_id, type, geom, anonymous)
                   values (tests.c(6), tests.g(), 'other', st_setsrid(st_makepoint(-122.4, 48.2), 4326), true)$$,
                 '23514', null, 'pings insert: an anonymous ping must be public-tier');
select lives_ok($$insert into public.pings (id, type, geom, anonymous)
                  values (tests.c(6), 'other', st_setsrid(st_makepoint(-122.4, 48.2), 4326), true)$$,
                'pings insert: anonymous public ping');
select tests.act_as(tests.u(3));
select is((select author_id from public.ping_feed where id = tests.c(6)), null::uuid, 'ping_feed: anonymous ping hides author id from others');
select is((select author_handle from public.ping_feed where id = tests.c(6)), null::text, 'ping_feed: anonymous ping hides handle from others');
select tests.act_as(tests.u(2));
select is((select author_id from public.ping_feed where id = tests.c(6)), tests.u(2), 'ping_feed: anonymous ping still shows author to themself');

select tests.act_admin();
update public.profiles set reputation = 1.13 where id = tests.u(2);
insert into public.pings (id, author_id, type, geom, anonymous)
  values (tests.c(8), tests.u(2), 'other', st_setsrid(st_makepoint(-122.4, 48.2), 4326), true);
select is((select score from public.pings where id = tests.c(8)), 1.25::double precision,
          'anonymous ping: cached score uses the quantised reputation, not the raw 1.13');
select tests.act_as(tests.u(3));
select is((select author_reputation from public.ping_feed where id = tests.c(8)), 1.25::double precision, 'ping_feed: anonymous ping exposes reputation quantised to 0.25');
select is((select author_handle from public.ping_feed where id = tests.c(8)), null::text, 'ping_feed: anonymous ping never exposes the handle');
select tests.act_admin();
update public.profiles set reputation = 1.0 where id = tests.u(2);
update public.profiles set reputation = 0.25 where id = tests.u(3);
select tests.act_as(tests.u(4));
select is((select count(*) from public.pings where id = tests.c(3)), 0::bigint, 'reputation < 0.3: author''s public ping hidden from other users');
select tests.act_as(tests.u(3));
select is((select count(*) from public.pings where id = tests.c(3)), 1::bigint, 'reputation < 0.3: author still sees own ping');
select tests.act_admin();
update public.profiles set reputation = 0.25 where id = tests.u(2);
select tests.act_as(tests.u(1));
select is((select count(*) from public.pings where id = tests.c(5)), 1::bigint, 'reputation < 0.3: group ping stays visible inside its group');
select tests.act_admin();
update public.profiles set reputation = 1.0 where id in (tests.u(2), tests.u(3));

select tests.act_admin();
update public.profiles set revoked_at = now() where id = tests.u(4);
select tests.act_as(tests.u(4));
select throws_ok($$insert into public.pings (type, geom) values ('log', st_setsrid(st_makepoint(-122.4, 48.2), 4326))$$,
                 '42501', null, 'revoked account: cannot insert pings');
select tests.act_admin();
update public.profiles set revoked_at = null where id = tests.u(4);

-- =============================== ping_votes =========================================================
-- Last-known positions: u2 ~0 m from the ping, u4 ~330 m north, u3 ~2.2 km north.
-- (the trigger snaps to a 100 m grid, so distances are approximate)
select tests.act_admin();
insert into public.last_positions (user_id, geom) values
  (tests.u(2), st_setsrid(st_makepoint(-122.5,    48.3),    4326)),
  (tests.u(4), st_setsrid(st_makepoint(-122.5,    48.3030), 4326)),
  (tests.u(3), st_setsrid(st_makepoint(-122.5,    48.32),   4326));

select tests.act_as(tests.u(3));
select throws_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'PT403', null,
                 'cast_vote: confirm from 2 km away is ineligible');
select throws_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'PT403', 'confirm_ineligible', 'cast_vote: rejection carries the stable message confirm_ineligible');
select lives_ok($$select * from public.cast_vote(tests.c(1), (-1)::smallint)$$, 'cast_vote: a dispute from afar is stored (weight 0)');
select ok((select voter_dist_m from public.ping_votes where ping_id = tests.c(1) and voter_id = tests.u(3)) > 1500,
          'cast_vote: far voter''s distance is recorded');
select tests.act_as(tests.u(2));
select lives_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'cast_vote: confirm from ~0 m accepted');
select ok((select voter_dist_m from public.ping_votes where ping_id = tests.c(1) and voter_id = tests.u(2)) <= 200,
          'cast_vote: near voter distance <= 200 m');
select ok((select score from public.pings where id = tests.c(1)) > 1.5, 'cast_vote: ping score cache refreshed after a confirm');
select tests.act_as(tests.u(4));
select lives_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'cast_vote: confirm from ~330 m accepted');
select ok((select voter_dist_m from public.ping_votes where ping_id = tests.c(1) and voter_id = tests.u(4)) between 200 and 500,
          'cast_vote: mid-range voter distance recorded between 200 and 500 m');
select tests.act_as(tests.u(3));
select is((select count(*) from public.ping_votes where ping_id = tests.c(1)), 1::bigint, 'ping_votes select: a voter sees only their own vote rows');
select is((select count(*) from public.ping_votes where voter_id <> tests.u(3)), 0::bigint, 'ping_votes: other people''s voter_id / distance are not readable');
select hasnt_view('public', 'ping_votes_feed', 'C1: ping_votes_feed no longer exists: per-vote data never leaves the server');
select hasnt_column('public', 'ping_feed', 'voter_id', 'ping_feed has no voter_id');
select hasnt_column('public', 'ping_feed', 'voter_reputation', 'ping_feed has no per-voter reputation (it would join back to profiles)');
select has_column('public', 'ping_feed', 'vote_sum', 'ping_feed.vote_sum');
select has_column('public', 'ping_feed', 'last_confirmed_at', 'ping_feed.last_confirmed_at');
select has_column('public', 'ping_feed', 'confirm_count', 'ping_feed.confirm_count');
select has_column('public', 'ping_feed', 'dispute_count', 'ping_feed.dispute_count');
-- c(1) votes: u3 dispute from ~2 km (w 0), u2 confirm ~0 m (w 1, R 1), u4 confirm ~330 m (w 0.5, R 1):  sum = 1.5
select is((select vote_sum from public.ping_feed where id = tests.c(1)), 1.5::double precision, 'ping_feed: vote_sum = 1*1 + 1*0.5 (the far dispute weighs 0)');
select is((select confirm_count from public.ping_feed where id = tests.c(1)), 2, 'ping_feed: confirm_count counts the weighted confirms');
select is((select dispute_count from public.ping_feed where id = tests.c(1)), 0, 'ping_feed: a far (weight 0) dispute is not counted');
select ok((select last_confirmed_at from public.ping_feed where id = tests.c(1)) is not null, 'ping_feed: last_confirmed_at is set');
select tests.act_as(tests.u(1));
select is((select count(*) from public.ping_votes where ping_id = tests.c(1)), 0::bigint, 'ping_votes: the ping author cannot read who voted either');
select is((select vote_sum from public.ping_feed where id = tests.c(1)), 1.5::double precision, 'ping_feed: the author sees the same aggregate');
select throws_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'PT403', null, 'cast_vote: author cannot vote on own ping');
select tests.act_as(tests.u(2));
select is((select vote from public.cast_vote(tests.c(1), (-1)::smallint)), 1::smallint, 'cast_vote: repeat vote is idempotent (server wins)');
select is((select count(*) from public.ping_votes where ping_id = tests.c(1) and voter_id = tests.u(2)), 1::bigint, 'cast_vote: still one row per (ping, voter)');
select throws_ok($$select * from public.cast_vote(tests.c(1), 2::smallint)$$, 'PT400', 'invalid_vote', 'cast_vote: vote must be +1 or -1');

-- stale position (> 24 h) is not eligible
select tests.act_admin();
alter table public.last_positions disable trigger last_positions_before_write;
update public.last_positions set updated_at = now() - interval '25 hours' where user_id = tests.u(4);
alter table public.last_positions enable trigger last_positions_before_write;
delete from public.ping_votes where voter_id = tests.u(4);
select tests.act_as(tests.u(4));
select throws_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'PT403', null, 'cast_vote: position older than 24 h is ineligible');
select tests.act_admin();
delete from public.last_positions where user_id = tests.u(4);
select tests.act_as(tests.u(4));
select throws_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, 'PT403', 'confirm_ineligible', 'cast_vote: no position on file is ineligible');

-- group-ping votes follow group visibility
select tests.act_admin();
insert into public.pings (id, author_id, group_id, type, geom) values
  (tests.c(7), tests.u(1), tests.g(), 'gear', st_setsrid(st_makepoint(-122.5, 48.3), 4326));
select tests.act_as(tests.u(3));
select throws_ok($$select * from public.cast_vote(tests.c(7), (-1)::smallint)$$, 'PT404', null, 'cast_vote: non-member cannot vote on a group ping (looks like 404)');
select tests.act_admin();
update public.pings set updated_at = now() - interval '2 days' where id = tests.c(7);
select tests.act_as(tests.u(2));
select lives_ok($$select * from public.cast_vote(tests.c(7), 1::smallint)$$, 'cast_vote: member confirms a group ping');
select tests.act_admin();
select ok((select updated_at from public.pings where id = tests.c(7)) > now() - interval '1 hour', 'C1: a new vote bumps pings.updated_at so cursor sync re-pulls the ping');
select tests.act_as(tests.u(2));
select tests.act_as(tests.u(1));
select is((select confirm_count from public.ping_feed where id = tests.c(7)), 1, 'ping_feed: author sees the confirm count on the group ping');
select is((select count(*) from public.ping_votes where ping_id = tests.c(7)), 0::bigint, 'ping_votes: ...but not who cast it');
select tests.act_as(tests.u(3));
select is((select count(*) from public.ping_feed where id = tests.c(7)), 0::bigint, 'ping_feed: non-member cannot see the group ping or its aggregates');
select is(public.score_ping(tests.c(7), now()), null::double precision, 'score_ping: null for a group ping the caller cannot see');
select is((select vote_sum from public.ping_vote_stats(tests.c(7), now())), null::double precision, 'ping_vote_stats: null for a group ping the caller cannot see');
select tests.act_anon();
select throws_ok($$select * from public.ping_vote_stats(tests.c(7))$$, '42501', null, 'ping_vote_stats: anon denied');
select tests.act_as(tests.u(2));
select is((select count(*) from public.ping_votes where ping_id = tests.c(7)), 1::bigint, 'ping_votes: a voter still sees their own vote');
select tests.act_as(tests.u(3));
select tests.act_anon();
select throws_ok($$select * from public.ping_votes$$, '42501', null, 'ping_votes select: anon denied');
select throws_ok($$select * from public.cast_vote(tests.c(1), 1::smallint)$$, '42501', null, 'cast_vote: anon denied');

-- direct writes to ping_votes are never granted (only cast_vote)
select tests.act_as(tests.u(2));
select throws_ok($$insert into public.ping_votes (ping_id, voter_id, vote, voter_dist_m) values (tests.c(3), tests.u(2), 1, 0)$$,
                 '42501', null, 'ping_votes insert: voter cannot bypass cast_vote (no forged distance)');
select throws_ok($$update public.ping_votes set vote = -1 where voter_id = tests.u(2)$$, '42501', null, 'ping_votes update: voter denied');
select throws_ok($$delete from public.ping_votes where voter_id = tests.u(2)$$, '42501', null, 'ping_votes delete: voter denied');
select tests.act_as(tests.u(1));
select throws_ok($$delete from public.ping_votes where ping_id = tests.c(7)$$, '42501', null, 'ping_votes delete: ping author denied');
select throws_ok($$insert into public.ping_votes (ping_id, voter_id, vote) values (tests.c(3), tests.u(1), 1)$$, '42501', null, 'ping_votes insert: owner denied');
select tests.act_as(tests.u(3));
select throws_ok($$insert into public.ping_votes (ping_id, voter_id, vote) values (tests.c(7), tests.u(3), 1)$$, '42501', null, 'ping_votes insert: non-member denied');
select tests.act_anon();
select throws_ok($$insert into public.ping_votes (ping_id, voter_id, vote) values (tests.c(1), tests.u(3), 1)$$, '42501', null, 'ping_votes insert: anon denied');
select throws_ok($$update public.ping_votes set vote = 1$$, '42501', null, 'ping_votes update: anon denied');
select throws_ok($$delete from public.ping_votes$$, '42501', null, 'ping_votes delete: anon denied');

-- a revoked account cannot vote
select tests.act_admin();
update public.profiles set revoked_at = now() where id = tests.u(2);
select tests.act_as(tests.u(2));
select throws_ok($$select * from public.cast_vote(tests.c(7), (-1)::smallint)$$, 'PT403', null, 'cast_vote: revoked account denied');
-- B4: a revoked account cannot delete its pings or rename its profile (no evading review)
select is(tests.dml($$delete from public.pings$$), 0::bigint, 'B4: revoked account cannot delete its own pings');
select is(tests.dml($$update public.profiles set vessel_name = 'F/V Renamed' where id = tests.u(2)$$), 0::bigint, 'B4: revoked account cannot edit its profile');
select tests.act_admin();
select is((select count(*) from public.pings where author_id = tests.u(2)), 3::bigint, 'B4: the revoked account''s pings are intact');
select tests.act_as(tests.u(2));
select throws_ok($$select public.author_publicly_visible(tests.u(2))$$, '42501', null, 'E1: author_publicly_visible is not callable by clients (no revocation oracle)');

-- ---- misc hardening ------------------------------------------------------------------------------------
select tests.act_as(tests.u(3));
select throws_ok($$insert into public.pings (type, geom, expires_at) values ('log', st_setsrid(st_makepoint(-122.4, 48.2), 4326), now() + interval '30 days')$$,
                 '23514', null, 'pings: expires_at more than 7 days after created_at is rejected');
select tests.act_admin();
update public.profiles set revoked_at = null where id = tests.u(2);

-- E8: the 0.3 visibility threshold compares reputation rounded to 4 decimals
select tests.act_admin();
update public.profiles set reputation = 0.29996 where id = tests.u(3);
select tests.act_as(tests.u(4));
select is((select count(*) from public.pings where id = tests.c(3)), 1::bigint, 'E8: reputation 0.29996 rounds to 0.3000 and stays visible');
select tests.act_admin();
update public.profiles set reputation = 0.29994 where id = tests.u(3);
select tests.act_as(tests.u(4));
select is((select count(*) from public.pings where id = tests.c(3)), 0::bigint, 'E8: reputation 0.29994 rounds to 0.2999 and is hidden');
select tests.act_admin();
update public.profiles set reputation = 1.0 where id = tests.u(3);

select * from finish();
rollback;
