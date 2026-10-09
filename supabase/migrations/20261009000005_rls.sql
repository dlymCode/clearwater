-- Migration 5 of 8: grants + Row Level Security. RLS is ON for every table.
--
-- Two layers, both deny-by-default:
--   1. GRANTs: anon gets nothing at all. authenticated gets only the verbs/columns below
--      (column-level grants stop clients writing reputation, score, revoked_at, invite codes, ...).
--   2. RLS policies, written `to authenticated` and evaluated on every query, so leaving a group
--      or being removed revokes history access immediately.
-- service_role bypasses RLS (BYPASSRLS) and keeps full table privileges.
--
-- Matrix covered by supabase/tests/: owner / group member / non-member / anon x
-- select / insert / update / delete, per table.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter table public.profiles              enable row level security;
alter table public.groups                enable row level security;
alter table public.group_members         enable row level security;
alter table public.pings                 enable row level security;
alter table public.ping_votes            enable row level security;
alter table public.messages              enable row level security;
alter table public.last_positions        enable row level security;
alter table public.depth_cells           enable row level security;
alter table public.depth_uploads         enable row level security;
alter table public.depth_batches         enable row level security;
alter table public.depth_cell_aggregates enable row level security;
alter table public.baseline_cells        enable row level security;
alter table public.audit_log             enable row level security;
alter table public.rate_events           enable row level security;
alter table public.app_config            enable row level security;

-- profiles: readable by all signed-in users; writable (handle, vessel_name) by the owner -----
-- revoked_at is deliberately not selectable: whether an account was revoked is not other users' business.
grant select (id, handle, vessel_name, reputation, created_at) on public.profiles to authenticated;
grant insert (id, handle, vessel_name) on public.profiles to authenticated;
grant update (handle, vessel_name)     on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated using (true);
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- No delete policy: accounts are removed by the account-delete edge function.

-- groups: members read; any active user creates their own; owner renames/deletes -------------
-- invite_code is not selectable (a removed member must not be able to re-read it, and plain members
-- have no business with it): the owner reads it via get_invite_code(), rotates via rotate_invite_code().
grant select (id, name, owner_id, invite_expires_at, created_at) on public.groups to authenticated;
grant insert (id, name, owner_id) on public.groups to authenticated;
grant update (name) on public.groups to authenticated;
grant delete on public.groups to authenticated;

create policy groups_select_member on public.groups
  for select to authenticated
  using (owner_id = (select auth.uid()) or public.is_group_member(id));
create policy groups_insert_own on public.groups
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and public.auth_is_active());
create policy groups_update_owner on public.groups
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy groups_delete_owner on public.groups
  for delete to authenticated using (owner_id = (select auth.uid()));
-- Invite codes are rotated through rotate_invite_code(); joining is join_group(code).

-- group_members: members see the roster; members leave; the owner removes others -------------
grant select, delete on public.group_members to authenticated;

create policy group_members_select on public.group_members
  for select to authenticated using (public.is_group_member(group_id));
create policy group_members_leave on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) and role = 'member');
create policy group_members_remove_by_owner on public.group_members
  for delete to authenticated
  using (public.is_group_owner(group_id) and user_id <> (select auth.uid()));
-- No insert/update policy: membership is created by the groups trigger and join_group().

-- pings: public tier or member of the group; the author inserts/deletes ----------------------
-- Column-level SELECT: everything except author_id and rep_processed_at. Authorship of a ping is only
-- ever exposed through public.ping_feed (which masks anonymous pings). A plain `select *` from pings
-- therefore fails with 42501 by design.
grant select (id, group_id, type, geom, note, created_at, received_at, expires_at, score, tide_ft,
              anonymous, updated_at)
  on public.pings to authenticated;
grant insert (id, author_id, group_id, type, geom, note, created_at, expires_at, tide_ft, anonymous)
  on public.pings to authenticated;
grant delete on public.pings to authenticated;

create policy pings_select on public.pings
  for select to authenticated
  using (public.ping_visible(group_id, author_id));
create policy pings_insert_author on public.pings
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.auth_is_active()
    and (group_id is null or public.is_group_member(group_id))
  );
create policy pings_delete_author on public.pings
  for delete to authenticated using (author_id = (select auth.uid()));
-- No update policy: pings are append-only; use promote_ping() to move a group ping public.

-- ping_votes: a voter sees only their OWN votes (to reconcile optimistic client votes). Everyone else's
-- voter_id / voter_dist_m would trilaterate a named boat, so other people's votes are read through
-- public.ping_votes_feed (no identity, no distance). Written only through cast_vote().
grant select on public.ping_votes to authenticated;

create policy ping_votes_select_own on public.ping_votes
  for select to authenticated
  using (voter_id = (select auth.uid()));

-- messages: group members read and write; author or group owner deletes ----------------------
grant select on public.messages to authenticated;
grant insert (id, group_id, author_id, body, ping_id, created_at) on public.messages to authenticated;
grant delete on public.messages to authenticated;

create policy messages_select_member on public.messages
  for select to authenticated using (public.is_group_member(group_id));
create policy messages_insert_member on public.messages
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.is_group_member(group_id)
    and public.auth_is_active()
    and (ping_id is null
         or exists (select 1 from public.pings p
                    where p.id = messages.ping_id
                      and (p.group_id is null or p.group_id = messages.group_id)))
  );
create policy messages_delete_author_or_owner on public.messages
  for delete to authenticated
  using (author_id = (select auth.uid()) or public.is_group_owner(group_id));

-- last_positions: own row + fellow group members, never older than 24 h ----------------------
-- Writes go through report_position() only (validates the Salish Sea box, snaps to 100 m, throttles to
-- one report per 5 minutes). Clients may read the rows they may see and delete their own (stop sharing).
grant select, delete on public.last_positions to authenticated;

create policy last_positions_select on public.last_positions
  for select to authenticated
  using (
    updated_at > now() - interval '24 hours'
    and (user_id = (select auth.uid()) or public.shares_group_with(user_id))
  );
create policy last_positions_delete_own on public.last_positions
  for delete to authenticated using (user_id = (select auth.uid()));

-- depth_cells / aggregates: signed-in read, but only cells seen by >= 3 distinct boats --------
-- (PRD "Aggregation thresholds": below 3 the cell exists in the database but is not published,
--  so one boat's route cannot be reconstructed by querying the table either.)
grant select on public.depth_cells to authenticated;
grant select on public.depth_cell_aggregates to authenticated;

create policy depth_cells_select on public.depth_cells
  for select to authenticated using (boats >= 3);
create policy depth_cell_aggregates_select on public.depth_cell_aggregates
  for select to authenticated using (boats >= 3);

-- depth_uploads, depth_batches, baseline_cells, rate_events, audit_log, app_config ------------------
-- RLS enabled, NO policies and NO grants for anon/authenticated: service role only.
-- (depth_uploads is "insert-only, never selectable" for clients; inserts go through the
--  depth-upload edge function because uploader_hash must be computed server-side. See README.)

-- read-model views (owner-run, security_barrier; see migration 4) ------------------------------------
grant select on public.ping_feed to authenticated;
grant select on public.ping_votes_feed to authenticated;

-- service_role keeps everything --------------------------------------------------------------
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
-- audit_log: the service role may append and read, never rewrite history.
revoke update, delete, truncate on public.audit_log from service_role;
