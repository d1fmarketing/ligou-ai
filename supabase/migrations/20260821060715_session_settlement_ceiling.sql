create or replace function public.settle_call_budget(
  p_tenant uuid,
  p_call uuid,
  p_actual_cost numeric,
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
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_actual_cost is null or p_actual_cost < 0 or p_minutes is null or p_minutes < 0 then
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
  if p_actual_cost > v_reservation.reserved_cost_usd then
    raise exception 'settlement_exceeds_reservation' using errcode = '22003';
  end if;

  select c.* into v_call
  from public.calls c
  where c.id = p_call and c.tenant_id = p_tenant
  for update;
  if v_call.id is null then
    raise exception 'call_tenant_mismatch' using errcode = '23503';
  end if;
  if coalesce(v_call.provider_usage_state, 'unknown') not in ('resolved','not_applicable') then
    raise exception 'provider_usage_unresolved' using errcode = '55000';
  end if;

  if v_reservation.status = 'settled' then return v_reservation.id; end if;

  update public.budget_reservations br
  set status = 'settled',
      outcome = p_outcome,
      final_cost_usd = p_actual_cost,
      final_minutes = p_minutes,
      settled_at = clock_timestamp()
  where br.id = v_reservation.id and br.status = 'active';

  insert into public.usage_ledger (tenant_id, call_id, kind, cost_usd, detail, budget_reservation_id)
  values (p_tenant, p_call, 'adjustment', -v_reservation.reserved_cost_usd,
          jsonb_build_object('at','reservation_release','outcome',p_outcome), v_reservation.id)
  on conflict (budget_reservation_id, kind) where budget_reservation_id is not null do nothing;

  insert into public.usage_ledger (tenant_id, call_id, kind, minutes, cost_usd, detail, budget_reservation_id)
  values (p_tenant, p_call, 'usage', p_minutes, p_actual_cost,
          coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('outcome',p_outcome), v_reservation.id)
  on conflict (budget_reservation_id, kind) where budget_reservation_id is not null do nothing;

  return v_reservation.id;
end;
$$;

revoke all on function public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb) from public, anon, authenticated;
grant execute on function public.settle_call_budget(uuid,uuid,numeric,numeric,text,jsonb) to service_role;
