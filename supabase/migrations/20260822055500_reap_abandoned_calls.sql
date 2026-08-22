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

-- Closing the last hold: at-most-once spends a single termination POST, so a call
-- whose one attempt never confirmed can never learn more (a second POST is
-- forbidden and no read-back exists). Treating that as permanently pending held
-- the reservation forever, which is strictly worse than settling it at the
-- bounded estimate, so a durably attempted-but-unknown termination is accepted.
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
  if coalesce(v_call.provider_termination_state, 'unknown') not in ('confirmed','not_required')
    and not (v_call.provider_termination_state = 'unknown'
             and v_call.provider_termination_attempted_at is not null) then
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
