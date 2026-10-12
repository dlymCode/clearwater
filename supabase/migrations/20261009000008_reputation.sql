-- Migration 8 of 8: weekly reputation batch (PRD "Reputation update").
--
--   +0.05 per ping with >= 2 confirms, -0.10 per ping with >= 2 disputes,
--   reputation clamped to [0.2, 3.0]; new accounts start at 1.0.
--
-- Only votes cast within 500 m (voter_dist_m <= 500) count. Confirms always satisfy this (the
-- vote RPC refuses ineligible confirms); the filter exists so two disputes lodged from the dock
-- cannot be used to farm reputation penalties against an honest author ("a vote from the dock
-- counts for nothing").
-- A ping is evaluated once: pings become eligible 48 h after received_at (when they stop
-- being visible) and are stamped with rep_processed_at so re-runs and late batches never
-- double count. Every changed account gets an audit_log row, plus one summary row per run.

create or replace function public.run_reputation_batch(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_confirm_bonus constant numeric := 0.05;
  c_dispute_penalty constant numeric := 0.10;
  c_min constant double precision := 0.2;
  c_max constant double precision := 3.0;
  r record;
  v_after double precision;
  v_pings integer := 0;
  v_authors integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('clearwater.reputation_batch')) then
    return jsonb_build_object('skipped', true, 'reason', 'batch already running');
  end if;

  drop table if exists pg_temp._rep_eligible;
  create temporary table _rep_eligible on commit drop as
  select p.id as ping_id,
         p.author_id,
         (count(*) filter (where v.vote = 1  and public.vote_weight(v.voter_dist_m) > 0)) as confirms,
         (count(*) filter (where v.vote = -1 and public.vote_weight(v.voter_dist_m) > 0)) as disputes
    from public.pings p
    left join public.ping_votes v on v.ping_id = p.id
   where p.rep_processed_at is null
     and p.received_at < p_now - interval '48 hours'
   group by p.id, p.author_id;

  select count(*) into v_pings from _rep_eligible;

  for r in
    select e.author_id,
           count(*) filter (where e.confirms >= 2) as confirmed_pings,
           count(*) filter (where e.disputes >= 2) as disputed_pings,
           (c_confirm_bonus * count(*) filter (where e.confirms >= 2)
            - c_dispute_penalty * count(*) filter (where e.disputes >= 2)) as delta,
           pr.reputation as before_rep
      from _rep_eligible e
      join public.profiles pr on pr.id = e.author_id
     group by e.author_id, pr.reputation
     order by e.author_id
  loop
    if r.delta <> 0 then
      v_after := greatest(c_min, least(c_max, r.before_rep + r.delta::double precision));
      update public.profiles set reputation = v_after where id = r.author_id;
      insert into public.audit_log (actor, action, target_type, target_id, details)
      values (null, 'reputation.update', 'profile', r.author_id::text,
              jsonb_build_object('before', r.before_rep, 'after', v_after, 'delta', r.delta,
                                 'confirmed_pings', r.confirmed_pings, 'disputed_pings', r.disputed_pings));
      v_authors := v_authors + 1;
    end if;
  end loop;

  update public.pings set rep_processed_at = p_now
   where id in (select ping_id from _rep_eligible);
  drop table pg_temp._rep_eligible;

  insert into public.audit_log (actor, action, target_type, details)
  values (null, 'reputation.batch', 'system',
          jsonb_build_object('pings_evaluated', v_pings, 'authors_changed', v_authors, 'as_of', p_now));

  return jsonb_build_object('skipped', false, 'pings_evaluated', v_pings, 'authors_changed', v_authors);
end
$$;

revoke all on function public.run_reputation_batch(timestamptz) from public, anon, authenticated;
grant execute on function public.run_reputation_batch(timestamptz) to service_role;
