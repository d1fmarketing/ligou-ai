-- Corrects the exhaustion guard introduced alongside the bounded settlement path.
-- Production showed the real shape: the single hangup POST timed out and the call
-- parked in external_evidence_required with a recorded attempt id, which the
-- narrower 'unknown' test refused, so three reservations stayed held anyway.
create or replace function public.settle_unresolved_call_budget(
  p_tenant uuid,
  p_call uuid,
  p_estimated_cost numeric,
  p_minutes numeric,
  p_outcome text,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.budget_reservations;
  v_call public.calls;
  v_min_attempts constant integer := 20;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_estimated_cost is null or p_estimated_cost < 0 or p_minutes is null or p_minutes < 0 then
    raise exception 'invalid_settlement_amount' using errcode = '22023';
  end if;
  if p_outcome not in ('ended','startup_error','killed_deadline','killed_budget','error') then
    raise exception 'invalid_settlement_outcome' using errcode = '22023';
  end if;

  perform 1 from public.tenants t where t.id = p_tenant for update;
  if not found then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;

  select br.* into v_reservation
  from public.budget_reservations br
  where br.tenant_id = p_tenant and br.call_id = p_call
  for update;
  if v_reservation.id is null then
    raise exception 'reservation_not_found' using errcode = 'P0002';
  end if;
  if v_reservation.status = 'settled' then return v_reservation.id; end if;
  if p_estimated_cost > v_reservation.reserved_cost_usd then
    raise exception 'settlement_exceeds_reservation' using errcode = '22003';
  end if;
  if coalesce(v_reservation.reconcile_attempts, 0) < v_min_attempts then
    raise exception 'unresolved_settlement_premature' using errcode = '55000';
  end if;

  select c.* into v_call
  from public.calls c
  where c.id = p_call and c.tenant_id = p_tenant
  for update;
  if v_call.id is null then
    raise exception 'call_tenant_mismatch' using errcode = '23503';
  end if;
  if coalesce(v_call.provider_usage_state, 'unknown') in ('resolved','not_applicable') then
    raise exception 'provider_usage_resolvable' using errcode = '55000';
  end if;
  if v_call.status not in ('ended','killed_deadline','killed_budget','error') then
    raise exception 'call_not_terminal' using errcode = '55000';
  end if;
  -- Exhaustion is a durably recorded attempt, not one particular state: the single
  -- permitted POST can end in pending, unknown, or external_evidence_required, and
  -- at-most-once forbids another in every case. External evidence may never arrive,
  -- and the reservation must not be held hostage to it.
  if coalesce(v_call.provider_termination_state, 'unknown') not in ('confirmed','not_required')
    and v_call.provider_termination_attempt_id is null then
    raise exception 'provider_termination_unconfirmed' using errcode = '55000';
  end if;

  update public.budget_reservations br
  set status = 'settled',
      outcome = p_outcome,
      final_cost_usd = p_estimated_cost,
      final_minutes = p_minutes,
      settled_at = clock_timestamp()
  where br.id = v_reservation.id and br.status = 'active';

  insert into public.usage_ledger (tenant_id, call_id, kind, cost_usd, detail, budget_reservation_id)
  values (p_tenant, p_call, 'adjustment', -v_reservation.reserved_cost_usd,
          jsonb_build_object('at','reservation_release','outcome',p_outcome,
                             'basis','reservation_rate_estimate'), v_reservation.id)
  on conflict (budget_reservation_id, kind) where budget_reservation_id is not null do nothing;

  insert into public.usage_ledger (tenant_id, call_id, kind, minutes, cost_usd, detail, budget_reservation_id)
  values (p_tenant, p_call, 'usage', p_minutes, p_estimated_cost,
          coalesce(p_detail, '{}'::jsonb)
            || jsonb_build_object('outcome',p_outcome,
                                  'settlement_basis','reservation_rate_estimate',
                                  'provider_usage_state', coalesce(v_call.provider_usage_state,'unknown'),
                                  'provider_termination_state', coalesce(v_call.provider_termination_state,'unknown')),
          v_reservation.id)
  on conflict (budget_reservation_id, kind) where budget_reservation_id is not null do nothing;

  return v_reservation.id;
end;
$$;

revoke all on function public.settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.settle_unresolved_call_budget(uuid,uuid,numeric,numeric,text,jsonb)
  to service_role;

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
    'reconcile_attempts', coalesce(v_reservation.reconcile_attempts, 0) + 1,
    'reserved_cost_usd', v_reservation.reserved_cost_usd,
    'provider_termination_state', v_call.provider_termination_state,
    'provider_termination_mode', v_call.provider_termination_mode,
    'provider_termination_reason', v_call.provider_termination_reason,
    'provider_terminated_at', v_call.provider_terminated_at,
    'provider_termination_attempted_at', v_call.provider_termination_attempted_at,
    'provider_termination_attempt_id', v_call.provider_termination_attempt_id,
    'provider_usage_state', v_call.provider_usage_state,
    'openai_call_id', v_call.openai_call_id
  );
end;
$$;

revoke all on function public.claim_budget_reconciliation(text) from public, anon, authenticated;
grant execute on function public.claim_budget_reconciliation(text) to service_role;
