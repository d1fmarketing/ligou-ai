-- Corrects a defect introduced by 20260822055500: the reaper set
-- provider_termination_state='unknown' for reaped calls, but
-- begin_provider_termination_attempt treats 'unknown' as "an attempt already
-- happened" and refuses to POST. The reaper therefore permanently blocked the one
-- hangup it was supposed to schedule, and the reservation stayed held with
-- provider_termination_already_attempted forever.
--
-- A reaped call must stay ELIGIBLE for its single attempt: leave the state alone
-- when the provider has a call id, and only declare 'not_required' when there is
-- no provider-side call at all.
create or replace function public.reap_abandoned_calls(p_grace_minutes integer default 120)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reaped integer := 0;
  v_cutoff timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_grace_minutes is null or p_grace_minutes < 60 or p_grace_minutes > 1440 then
    raise exception 'invalid_grace_window' using errcode = '22023';
  end if;
  v_cutoff := now() - make_interval(mins => p_grace_minutes);

  with abandoned as (
    select c.id
    from public.calls c
    where c.status = 'active'
      and c.started_at < v_cutoff
      and c.ended_at is null
    order by c.started_at
    for update skip locked
    limit 200
  )
  update public.calls c
  set status = 'error',
      ended_at = coalesce(c.ended_at, now()),
      provider_usage_state = case
        when c.openai_call_id is null then 'not_applicable'
        else 'unknown'
      end,
      -- Only a call with no provider-side identity needs no termination. Every
      -- other reaped call keeps a state that still permits its single attempt.
      provider_termination_state = case
        when c.openai_call_id is null then 'not_required'
        else c.provider_termination_state
      end,
      provider_termination_mode = case
        when c.openai_call_id is null then c.provider_termination_mode
        else coalesce(c.provider_termination_mode, 'hangup')
      end,
      provider_termination_reason = case
        when c.openai_call_id is null then c.provider_termination_reason
        else coalesce(c.provider_termination_reason, 'abandoned_call_reaped')
      end,
      provider_termination_reconcile_after = least(
        coalesce(c.provider_termination_reconcile_after, now()), now()
      ),
      duration_seconds = coalesce(
        c.duration_seconds,
        greatest(0, extract(epoch from (now() - c.started_at))::integer)
      )
  from abandoned a
  where c.id = a.id;

  get diagnostics v_reaped = row_count;
  return v_reaped;
end;
$$;

revoke all on function public.reap_abandoned_calls(integer) from public, anon, authenticated;
grant execute on function public.reap_abandoned_calls(integer) to service_role;

-- Repair the rows the defective reaper already blocked: they were 'active' before
-- it ran and no attempt was ever recorded, so restoring eligibility is a return to
-- the truth, not a new claim. Strictly scoped to rows that carry the reaper's own
-- reason, still hold an unsettled reservation, and have never been attempted.
update public.calls c
set provider_termination_state = 'active'
where c.provider_termination_state = 'unknown'
  and c.provider_termination_attempt_id is null
  and c.provider_termination_attempted_at is null
  and c.provider_termination_reason = 'abandoned_call_reaped'
  and exists (
    select 1 from public.budget_reservations br
    where br.call_id = c.id and br.status = 'active'
  );
