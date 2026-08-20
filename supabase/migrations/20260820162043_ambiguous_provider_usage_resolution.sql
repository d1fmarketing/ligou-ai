-- Provider termination stops future activity; it does not resolve usage that
-- may already have accrued. Track these as independent durable facts.
alter table public.calls
  add column if not exists provider_usage_state text not null default 'not_applicable';

alter table public.calls
  add constraint calls_provider_usage_state_check
    check (provider_usage_state in ('not_applicable','unknown','resolved'));

update public.calls c set provider_usage_state = case
  when c.openai_call_id is null then 'not_applicable'
  when c.ended_at is not null and c.usage_tokens is not null and c.cost_estimate_usd is not null then 'resolved'
  else 'unknown'
end;

create or replace function public.claim_budget_reconciliation(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.budget_reservations;
  v_call public.calls;
  v_outcome text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select br.* into v_reservation
  from public.budget_reservations br
  join public.calls c on c.id = br.call_id and c.tenant_id = br.tenant_id
  where br.status = 'active'
    and c.status <> 'active'
    and br.reconcile_after <= now()
    and (br.reconcile_lease_until is null or br.reconcile_lease_until < now())
  order by br.created_at
  for update of br skip locked
  limit 1;
  if v_reservation.id is null then return null; end if;

  update public.budget_reservations br set
    reconcile_attempts = br.reconcile_attempts + 1,
    reconcile_lease_until = now() + interval '30 seconds',
    reconcile_last_error = null
  where br.id = v_reservation.id;

  select c.* into v_call from public.calls c where c.id = v_reservation.call_id;
  v_outcome := case
    when v_call.status = 'ended' then 'ended'
    when v_call.status = 'killed_deadline' then 'killed_deadline'
    when v_call.status = 'killed_budget' then 'killed_budget'
    when v_call.status = 'error' then 'error'
    else 'startup_error'
  end;

  return jsonb_build_object(
    'reservation_id', v_reservation.id,
    'tenant_id', v_reservation.tenant_id,
    'call_id', v_reservation.call_id,
    'actual_cost_usd', coalesce(v_call.cost_estimate_usd, 0),
    'minutes', coalesce(v_call.duration_seconds, 0)::numeric / 60,
    'outcome', v_outcome,
    'provider_termination_state', v_call.provider_termination_state,
    'provider_termination_mode', v_call.provider_termination_mode,
    'provider_termination_reason', v_call.provider_termination_reason,
    'provider_terminated_at', v_call.provider_terminated_at,
    'provider_usage_state', v_call.provider_usage_state,
    'openai_call_id', v_call.openai_call_id
  );
end;
$$;

revoke all on function public.claim_budget_reconciliation(text) from public, anon, authenticated;
grant execute on function public.claim_budget_reconciliation(text) to service_role;
