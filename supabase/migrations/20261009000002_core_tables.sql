-- Migration 2 of 8: social/hazard tables (profiles, groups, group_members, pings,
-- ping_votes, messages), last_positions, audit_log, app_config.
--
-- Column sets follow docs/PRD.md "Fleet reporting and trust model" exactly; the few
-- additions (revoked_at, anonymous, received_at, updated_at, rep_processed_at) are
-- listed in supabase/README.md under "Deviations / additions".
-- Input limits are CHECK constraints here, not just client-side (PRD "App security").

-- profiles ------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  handle       text not null,
  vessel_name  text,
  reputation   double precision not null default 1.0,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint profiles_handle_format   check (handle ~ '^[A-Za-z0-9_.-]{3,24}$'),
  constraint profiles_vessel_len      check (vessel_name is null or char_length(vessel_name) between 1 and 60),
  constraint profiles_reputation_range check (reputation between 0.2 and 3.0)
);
create unique index profiles_handle_lower_key on public.profiles (lower(handle));

comment on table public.profiles is 'One row per auth user. No real name; handle is what others see.';
comment on column public.profiles.reputation is 'Weekly batch moves this within [0.2, 3.0]. Not client-writable (column grants).';
comment on column public.profiles.revoked_at is 'Set by the admin edge function; blocks writes and hides the account''s public pings.';

-- groups --------------------------------------------------------------------------
create table public.groups (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  owner_id           uuid not null references public.profiles (id) on delete restrict,
  invite_code        text not null,
  invite_expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at         timestamptz not null default now(),
  constraint groups_name_len     check (char_length(name) between 1 and 60),
  constraint groups_invite_len   check (char_length(invite_code) = 8),
  constraint groups_invite_chars check (invite_code ~ '^[A-Z2-9]{8}$')
);
create unique index groups_invite_code_key on public.groups (invite_code);
create index groups_owner_idx on public.groups (owner_id);

comment on column public.groups.invite_code is '8 chars from an unambiguous alphabet; generated server-side; expires 7 days after issue.';

-- group_members -------------------------------------------------------------------
create table public.group_members (
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null default 'member',
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id),
  constraint group_members_role check (role in ('owner', 'member'))
);
create index group_members_user_idx on public.group_members (user_id);
create unique index group_members_one_owner on public.group_members (group_id) where role = 'owner';

-- pings ---------------------------------------------------------------------------
create table public.pings (
  id                uuid primary key default gen_random_uuid(),   -- client-generated UUID => idempotent sync
  author_id         uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  group_id          uuid references public.groups (id) on delete cascade,  -- null = public tier
  type              public.ping_type not null,
  geom              extensions.geometry(Point, 4326) not null,
  note              text,
  created_at        timestamptz not null default now(),           -- device clock (UTC)
  received_at       timestamptz not null default now(),           -- server clock, forced by trigger
  expires_at        timestamptz not null,                         -- defaults to created_at + 48 h in trigger
  score             double precision,                             -- cache of score_ping(id, now()) refreshed on vote
  tide_ft           double precision,
  anonymous         boolean not null default false,               -- public-tier ping that hides the handle
  updated_at        timestamptz not null default now(),           -- cursor for inbound sync
  rep_processed_at  timestamptz,                                  -- set by the weekly reputation batch
  constraint pings_note_len      check (note is null or char_length(note) <= 140),
  constraint pings_geom_salish   check (public.in_salish_sea(geom)),
  constraint pings_created_sane  check (created_at >= timestamptz '2020-01-01 00:00:00+00'
                                        and created_at <= received_at + interval '168 hours'),
  constraint pings_expires_after check (expires_at > created_at),
  constraint pings_tide_sane     check (tide_ft is null or tide_ft between -10 and 30),
  constraint pings_anon_public   check (not anonymous or group_id is null)
);
create index pings_geom_gix       on public.pings using gist (geom);
create index pings_created_at_idx on public.pings (created_at desc);
create index pings_group_idx      on public.pings (group_id, created_at desc) where group_id is not null;
create index pings_author_idx     on public.pings (author_id, received_at desc);
create index pings_updated_at_idx on public.pings (updated_at);
create index pings_rep_pending_idx on public.pings (received_at) where rep_processed_at is null;

comment on column public.pings.score is 'Cache only. Authoritative value is public.score_ping(id, at); clients recompute from timestamps.';

-- ping_votes ----------------------------------------------------------------------
create table public.ping_votes (
  ping_id        uuid not null references public.pings (id) on delete cascade,
  voter_id       uuid not null references public.profiles (id) on delete cascade,
  vote           smallint not null,
  voter_dist_m   double precision,                -- from the voter's last_positions row; null when unknown
  created_at     timestamptz not null default now(),
  primary key (ping_id, voter_id),                -- unique (ping_id, voter_id): votes are idempotent, server wins
  constraint ping_votes_vote_val  check (vote in (1, -1)),
  constraint ping_votes_dist_nonneg check (voter_dist_m is null or voter_dist_m >= 0)
);
create index ping_votes_voter_idx on public.ping_votes (voter_id, created_at desc);
create index ping_votes_created_idx on public.ping_votes (ping_id, created_at);

-- messages ------------------------------------------------------------------------
create table public.messages (
  id           uuid primary key default gen_random_uuid(),     -- client-generated UUID => idempotent sync
  group_id     uuid not null references public.groups (id) on delete cascade,
  author_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body         text not null,
  ping_id      uuid references public.pings (id) on delete set null,
  created_at   timestamptz not null default now(),
  received_at  timestamptz not null default now(),
  constraint messages_body_len     check (char_length(body) between 1 and 500),
  constraint messages_created_sane check (created_at >= timestamptz '2020-01-01 00:00:00+00'
                                          and created_at <= received_at + interval '168 hours')
);
create index messages_group_created_idx on public.messages (group_id, created_at desc);
create index messages_author_idx        on public.messages (author_id, received_at desc);
create index messages_created_idx       on public.messages (created_at);

-- last_positions (rounded to 100 m by trigger; deleted after 24 h) ------------------
create table public.last_positions (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  geom        extensions.geometry(Point, 4326) not null,
  updated_at  timestamptz not null default now()
);
create index last_positions_updated_idx on public.last_positions (updated_at);

-- audit_log (service role only; append-only) ----------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor        uuid,                  -- admin uid, or null for system jobs
  action       text not null,
  target_type  text,
  target_id    text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_action_idx  on public.audit_log (action, created_at desc);

-- app_config (service role only) ------------------------------------------------------
create table public.app_config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
insert into public.app_config (key, value) values ('hmac_salt_epoch', '0'::jsonb);

-- Supabase Realtime for group channels + new pings (additive to cursor sync).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages, public.pings, public.ping_votes;
  end if;
end
$$;
