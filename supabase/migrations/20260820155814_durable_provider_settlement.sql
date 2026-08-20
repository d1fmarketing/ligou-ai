-- Provider termination is durable state. A zero-cost settlement is allowed
-- only when no provider call existed or termination has been confirmed.
alter table public.calls
  add column if not exists provider_termination_state text not null default 'not_required',
  add column if not exists provider_termination_mode text,
  add column if not exists provider_termination_reason text,
  add column if not exists provider_termination_last_error text,
  add column if not exists provider_terminated_at timestamptz;

alter table public.calls
  add constraint calls_provider_termination_state_check
    check (provider_termination_state in ('not_required','active','pending','confirmed','unknown')),
  add constraint calls_provider_termination_mode_check
    check (provider_termination_mode is null or provider_termination_mode in ('reject','hangup'));

update public.calls c set
  provider_termination_state = case
    when c.openai_call_id is null then 'not_required'
    when c.status = 'active' then 'active'
    else 'unknown'
  end,
  provider_termination_mode = case when c.openai_call_id is null then null else 'hangup' end;

alter table public.budget_reservations
  add column if not exists reconcile_attempts integer not null default 0,
  add column if not exists reconcile_after timestamptz not null default now(),
  add column if not exists reconcile_lease_until timestamptz,
  add column if not exists reconcile_last_error text;

-- Correct the earlier backfill: terminal call status wins over the mere
-- presence of a usage row.
update public.budget_reservations br set
  outcome = case
    when c.status = 'error' then 'error'
    when c.status = 'killed_deadline' then 'killed_deadline'
    when c.status = 'killed_budget' then 'killed_budget'
    else br.outcome
  end
from public.calls c
where c.id = br.call_id
  and br.status = 'settled'
  and c.status in ('error','killed_deadline','killed_budget');

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
    'openai_call_id', v_call.openai_call_id
  );
end;
$$;

revoke all on function public.claim_budget_reconciliation(text) from public, anon, authenticated;
grant execute on function public.claim_budget_reconciliation(text) to service_role;

-- Corrective replacement: tenant-local time is sampled only after the tenant
-- row lock, so a waiter crossing local midnight receives the post-lock day.
create or replace function public.reserve_call_budget(p_tenant uuid, p_call uuid, p_est_cost numeric)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget numeric;
  v_timezone text;
  v_spent numeric;
  v_id uuid;
  v_now timestamptz;
  v_day date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_est_cost is null or p_est_cost < 0 then
    raise exception 'invalid_estimated_cost' using errcode = '22023';
  end if;

  select t.daily_budget_usd, t.timezone into v_budget, v_timezone from public.tenants t where t.id = p_tenant for update;
  if v_budget is null then raise exception 'tenant_not_found' using errcode = 'P0002'; end if;
  v_now := clock_timestamp();
  v_day := (v_now at time zone v_timezone)::date;

  if not exists (select 1 from public.calls c where c.id = p_call and c.tenant_id = p_tenant) then
    raise exception 'call_tenant_mismatch' using errcode = '23503';
  end if;
  select br.id into v_id from public.budget_reservations br where br.call_id = p_call;
  if v_id is not null then return v_id; end if;

  select coalesce(sum(case when br.status = 'active' then br.reserved_cost_usd else br.final_cost_usd end), 0)
  into v_spent from public.budget_reservations br
  where br.tenant_id = p_tenant and br.budget_day = v_day;
  if v_spent + p_est_cost > v_budget then
    raise exception 'budget_exceeded: spent % + est % > cap %', v_spent, p_est_cost, v_budget;
  end if;

  insert into public.budget_reservations (tenant_id, call_id, budget_day, reserved_cost_usd)
  values (p_tenant, p_call, v_day, p_est_cost) returning id into v_id;
  insert into public.usage_ledger (tenant_id, call_id, kind, cost_usd, detail, budget_reservation_id)
  values (p_tenant, p_call, 'reservation', p_est_cost,
          jsonb_build_object('at','session_start','budget_day',v_day), v_id);
  return v_id;
end;
$$;

revoke all on function public.reserve_call_budget(uuid,uuid,numeric) from public, anon, authenticated;
grant execute on function public.reserve_call_budget(uuid,uuid,numeric) to service_role;
