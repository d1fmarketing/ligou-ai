-- NULL explicitly disables the daily voice budget for a configured tenant.
-- Existing numeric budgets and the default remain unchanged; all usage is recorded.
alter table public.tenants alter column daily_budget_usd drop not null;
comment on column public.tenants.daily_budget_usd is 'Daily voice budget in USD; NULL means no daily spending cap. Usage accounting remains enabled.';

CREATE OR REPLACE FUNCTION public.reserve_call_budget(p_tenant uuid, p_call uuid, p_est_cost numeric, p_reserved_minutes numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_budget numeric;
  v_timezone text;
  v_spent numeric;
  v_id uuid;
  v_existing public.budget_reservations;
  v_now timestamptz;
  v_day date;
begin
  if p_est_cost is null or p_est_cost < 0 then
    raise exception using errcode = '22023',
      message = 'invalid_estimated_cost';
  end if;
  if p_reserved_minutes is null or p_reserved_minutes <= 0 then
    raise exception using errcode = '22023',
      message = 'invalid_reserved_minutes';
  end if;

  select t.daily_budget_usd, t.timezone
    into v_budget, v_timezone
  from public.tenants t
  where t.id = p_tenant
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'tenant_not_found';
  end if;
  v_now := clock_timestamp();
  v_day := (v_now at time zone v_timezone)::date;

  if not exists (
    select 1 from public.calls c
    where c.id = p_call and c.tenant_id = p_tenant
  ) then
    raise exception using errcode = '23503', message = 'call_tenant_mismatch';
  end if;
  select br.* into v_existing
  from public.budget_reservations br
  where br.call_id = p_call
  for update;
  if v_existing.id is not null then
    if v_existing.tenant_id is distinct from p_tenant
       or v_existing.reserved_cost_usd is distinct from p_est_cost
       or v_existing.reserved_minutes is distinct from p_reserved_minutes then
      raise exception using errcode = '23505',
        message = 'budget_reservation_payload_mismatch';
    end if;
    return v_existing.id;
  end if;

  select coalesce(sum(
    case when br.status = 'active'
      then br.reserved_cost_usd else br.final_cost_usd end
  ), 0)
  into v_spent
  from public.budget_reservations br
  where br.tenant_id = p_tenant and br.budget_day = v_day;
  if v_budget is not null and v_spent + p_est_cost > v_budget then
    raise exception 'budget_exceeded: spent % + est % > cap %',
      v_spent, p_est_cost, v_budget;
  end if;

  insert into public.budget_reservations (
    tenant_id, call_id, budget_day, reserved_cost_usd, reserved_minutes
  ) values (p_tenant, p_call, v_day, p_est_cost, p_reserved_minutes)
  returning id into v_id;
  insert into public.usage_ledger (
    tenant_id, call_id, kind, cost_usd, detail, budget_reservation_id
  ) values (
    p_tenant, p_call, 'reservation', p_est_cost,
    jsonb_build_object(
      'at', 'session_start',
      'budget_day', v_day,
      'reserved_minutes', p_reserved_minutes
    ),
    v_id
  );
  return v_id;
end;
$function$;
