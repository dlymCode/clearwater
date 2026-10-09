-- Migration 3 of 8: fleet depth layer tables.
--
-- Privacy shape (PRD "Secrecy and privacy"):
--   SIGN CONVENTION (docs/AGENT-PLAN.md addendum): uploaded median_ft / p10_ft are DEPTH BELOW MLLW,
--   POSITIVE DOWN (sounder convention; 12.0 = twelve feet of water at MLLW); p10_ft is the
--   shoal-biased 10th percentile, so p10_ft <= median_ft. The baseline is elevation, positive up.
--
--   depth_uploads  one row per (uploader_hash, H3 cell, UTC day). NO timestamps finer than
--                  the day, NO uid. uploader_hash = HMAC(uid, daily salt) computed by the
--                  depth-upload edge function. Never client-selectable, and in this build
--                  never client-insertable either (the edge function writes with the
--                  service role; see supabase/README.md "Deviations").
--   depth_cells    server-side aggregate per (cell, day). Raw soundings are never stored.
--   depth_batches  idempotency + rate-limit ledger: (client batch UUID, uid, received_at).
--                  It holds no cell data, and depth_uploads holds no time, so the two
--                  cannot be joined to follow a boat.

-- H3 resolution-12 cell ids are 15 hex chars beginning "8c" (mode 1, res 12).
create domain public.h3_res12 as text
  check (value ~ '^8c[0-9a-f]{13}$');

create table public.depth_cells (
  cell_id    public.h3_res12 not null,
  day        date not null,
  median_ft  double precision not null,
  p10_ft     double precision not null,
  n          integer not null,
  boats      integer not null,
  primary key (cell_id, day),
  constraint depth_cells_median_range check (median_ft between -2000 and 2000),
  constraint depth_cells_p10_range    check (p10_ft between -2000 and 2000),
  constraint depth_cells_n_pos        check (n > 0),
  constraint depth_cells_boats_pos    check (boats > 0)
);
create index depth_cells_day_idx on public.depth_cells (day);

comment on table public.depth_cells is
  'Per-day cell aggregate. median_ft/p10_ft are n-weighted over non-held uploads; boats = distinct uploader_hash that day. RLS only exposes boats >= 3.';

create table public.depth_uploads (
  id             uuid primary key default gen_random_uuid(),
  uploader_hash  text not null,
  cell_id        public.h3_res12 not null,
  day            date not null,
  median_ft      double precision not null,
  p10_ft         double precision not null,
  n              integer not null,
  held           boolean not null default false,
  held_reason    text,
  constraint depth_uploads_hash_hex    check (uploader_hash ~ '^[0-9a-f]{64}$'),
  constraint depth_uploads_median_range check (median_ft between -2000 and 2000),
  constraint depth_uploads_p10_range    check (p10_ft between -2000 and 2000),
  constraint depth_uploads_n_range      check (n between 1 and 86400),
  constraint depth_uploads_held_reason  check ((held and held_reason in ('baseline_disagreement', 'admin'))
                                               or (not held and held_reason is null))
);
create index depth_uploads_cell_day_idx on public.depth_uploads (cell_id, day);
create index depth_uploads_held_idx     on public.depth_uploads (cell_id, day) where held;
create index depth_uploads_day_idx      on public.depth_uploads (day);

comment on column public.depth_uploads.held is
  'True when the 15 ft baseline-disagreement rule (or an admin) is holding the row out of depth_cells. Held rows are never deleted by the rule.';

-- Baseline per H3 cell, loaded by the pipeline (service role) so the server can apply the hold
-- rule. Stored exactly as the pipeline produces it: merged_elev, ELEVATION in feet MLLW, POSITIVE UP
-- (a cell 12 ft under water at MLLW is -12). Uploads use the opposite sign (see below), so the hold
-- rule compares depth_uploads.median_ft with -baseline_elev_ft.
create table public.baseline_cells (
  cell_id          public.h3_res12 primary key,
  baseline_elev_ft double precision not null,
  source_date      date,
  constraint baseline_cells_range check (baseline_elev_ft between -2000 and 2000)
);

create table public.depth_batches (
  batch_id     uuid primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  received_at  timestamptz not null default now(),
  row_count    integer not null default 0,
  held_count   integer not null default 0
);
create index depth_batches_user_idx on public.depth_batches (user_id, received_at desc);

-- 90-day rollups of daily cells older than 180 days (PRD retention table).
create table public.depth_cell_aggregates (
  cell_id       public.h3_res12 not null,
  period_start  date not null,
  period_end    date not null,
  median_ft     double precision not null,
  p10_ft        double precision not null,
  n             integer not null,
  boats         integer not null,       -- max boats seen on any rolled day (distinct count across days is not knowable by design)
  primary key (cell_id, period_start),
  constraint depth_cell_aggregates_period check (period_end > period_start),
  constraint depth_cell_aggregates_n_pos  check (n > 0)
);
