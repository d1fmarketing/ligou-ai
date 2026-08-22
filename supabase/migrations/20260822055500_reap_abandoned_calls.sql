-- A controller restart abandons whatever calls it was servicing: nothing ever
-- transitions them out of 'active'. Production accumulated 115 such calls, three
-- of which still held a budget reservation each, and the dashboard reported them
-- as in progress days later.
--
-- This reaps only calls that cannot possibly still be live: older than a grace
-- window far beyond the longest legitimate session, and never touching a row a
-- live sideband is still updating. The provider side is handed to the existing
-- at-most-once termination reconciliation rather than being POSTed here, and the
-- budget is left to the normal reconciliation path now that the call is terminal.
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
      -- Usage genuinely never resolved for an abandoned call; say so rather than
      -- claiming zero, so the bounded settlement path prices it honestly.
      provider_usage_state = case
        when c.openai_call_id is null then 'not_applicable'
        else 'unknown'
      end,
      -- Hand the provider side to the existing at-most-once reconciliation.
      provider_termination_state = case
        when c.openai_call_id is null then 'not_required'
        else 'unknown'
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
      -- summary_status and learning_status are deliberately untouched: the existing
      -- workers already handle a terminal call with an empty transcript correctly,
      -- and 'skipped' is not a legal summary_status.
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
