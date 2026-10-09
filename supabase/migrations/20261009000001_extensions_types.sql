-- Clearwater (Sound Maps) backend, migration 1 of 8: extensions, enums, helpers.
--
-- Conventions used by every migration in this directory:
--   * PostGIS and pgcrypto live in the `extensions` schema (Supabase default),
--     and every call to them is schema-qualified so nothing depends on search_path.
--   * Supabase grants ALL on new public tables/functions to anon + authenticated by
--     default. We turn that off below and grant the minimum, per table, in migration 5.
--     Anything you add later must therefore be granted explicitly.

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Deny-by-default for objects created from now on in `public` (by the migration role).
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Ping types: exact strings from docs/AGENT-PLAN.md (shared contract).
create type public.ping_type as enum (
  'bar_moved',
  'touched_bottom',
  'log',
  'gear',
  'closure_line',
  'other'
);

-- Salish Sea bounding polygon used by CHECK constraints.
-- A lon/lat box [-124.0, 46.9] .. [-121.9, 49.1] (WGS84). It is a polygon, so it can be
-- tightened to a real coastline-following polygon later by editing this one function.
create or replace function public.in_salish_sea(g extensions.geometry)
returns boolean
language sql
immutable
parallel safe
set search_path = public, extensions
as $$
  select g is not null
     and extensions.ST_SRID(g) = 4326
     and extensions.ST_Covers(
           extensions.ST_MakeEnvelope(-124.0, 46.9, -121.9, 49.1, 4326),
           g
         );
$$;

comment on function public.in_salish_sea(extensions.geometry) is
  'True when the geometry is SRID 4326 and lies inside the Salish Sea bounding box [-124.0,46.9]-[-121.9,49.1].';

-- Weighted lower quantile: the first value (ascending) whose cumulative weight reaches
-- q * total weight. Ties are broken by array position, so the result is deterministic.
-- Used for "median across uploads weighted by n" (PRD, Depth log trust #5).
create or replace function public.weighted_quantile(
  vals double precision[],
  wts double precision[],
  q double precision
)
returns double precision
language sql
immutable
parallel safe
as $$
  with s as (
    select t.v, t.w, t.ord,
           sum(t.w) over (order by t.v, t.ord rows between unbounded preceding and current row) as cum,
           sum(t.w) over () as total
    from unnest(vals, wts) with ordinality as t(v, w, ord)
  )
  select s.v
  from s
  where s.cum >= q * s.total
  order by s.v, s.ord
  limit 1;
$$;

comment on function public.weighted_quantile(double precision[], double precision[], double precision) is
  'Lower weighted quantile. weighted_quantile({10,20},{1,3},0.5) = 20 (cum weights 1,4; half of 4 is 2).';

revoke execute on function public.in_salish_sea(extensions.geometry) from public, anon, authenticated;
grant execute on function public.in_salish_sea(extensions.geometry) to anon, authenticated, service_role;
revoke execute on function public.weighted_quantile(double precision[], double precision[], double precision) from public, anon, authenticated;
grant execute on function public.weighted_quantile(double precision[], double precision[], double precision) to service_role;
