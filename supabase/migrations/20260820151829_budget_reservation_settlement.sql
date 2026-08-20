-- Auditable budget holds. Active reservations count at their estimate; settled
-- reservations count at actual cost. Both are assigned to the tenant-local day.
create table public.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  call_id uuid not null references public.calls (id),
  budget_day date not null,
  reserved_cost_usd numeric not null check (reserved_cost_usd >= 0),
  status text not null default 'active' check (status in ('active','settled')),
  outcome text check (outcome in ('ended','startup_error','killed_deadline','killed_budget','error')),
  final_cost_usd numeric check (final_cost_usd >= 0),
  final_minutes numeric check (final_minutes >= 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (call_id),
  constraint budget_reservation_settlement_complete check (
    (status = 'active' and outcome is null and final_cost_usd is null and final_minutes is null and settled_at is null)
    or
    (status = 'settled' and outcome is not null and final_cost_usd is not null and final_minutes is not null and settled_at is not null)
  )
);

create index budget_reservations_tenant_day_idx
  on public.budget_reservations (tenant_id, budget_day, status);

alter table public.budget_reservations enable row level security;
alter table public.budget_reservations force row level security;
create policy budget_reservations_owner_select on public.budget_reservations for select
  using (tenant_id in (select t.id from public.tenants t where t.owner_user_id = auth.uid()));

alter table public.usage_ledger
  add column if not exists budget_reservation_id uuid references public.budget_reservations (id);

-- Preserve pre-migration holds and completed usage. A legacy completed call is
-- settled immediately and receives the missing negative release event, so the
-- historical ledger becomes net-actual without rewriting an old row.
with legacy_budget as (
  select
    l.tenant_id,
    l.call_id,
    ((min(l.created_at) filter (where l.kind = 'reservation')) at time zone t.timezone)::date as budget_day,
    sum(l.cost_usd) filter (where l.kind = 'reservation') as reserved_cost,
    coalesce(sum(l.cost_usd) filter (where l.kind = 'usage'), 0::numeric) as actual_cost,
    coalesce(sum(l.minutes) filter (where l.kind = 'usage'), 0::numeric) as actual_minutes,
    bool_or(l.kind = 'usage') as has_usage,
    c.status as call_status,
    c.ended_at,
    min(l.created_at) filter (where l.kind = 'reservation') as reservation_at,
    max(l.created_at) as last_ledger_at
  from public.usage_ledger l
  join public.calls c on c.id = l.call_id and c.tenant_id = l.tenant_id
  join public.tenants t on t.id = l.tenant_id
  where l.call_id is not null
  group by l.tenant_id, l.call_id, t.timezone, c.status, c.ended_at
  having count(*) filter (where l.kind = 'reservation') > 0
)
insert into public.budget_reservations (
  tenant_id, call_id, budget_day, reserved_cost_usd, status, outcome,
  final_cost_usd, final_minutes, created_at, settled_at
)
select
  lb.tenant_id,
  lb.call_id,
  lb.budget_day,
  lb.reserved_cost,
  case when lb.has_usage or lb.call_status <> 'active' then 'settled' else 'active' end,
  case
    when not lb.has_usage and lb.call_status = 'active' then null
    when lb.call_status = 'killed_deadline' then 'killed_deadline'
    when lb.call_status = 'killed_budget' then 'killed_budget'
    when lb.call_status = 'ended' or lb.has_usage then 'ended'
    else 'error'
  end,
  case when lb.has_usage or lb.call_status <> 'active' then lb.actual_cost else null end,
  case when lb.has_usage or lb.call_status <> 'active' then lb.actual_minutes else null end,
  lb.reservation_at,
  case when lb.has_usage or lb.call_status <> 'active' then coalesce(lb.ended_at, lb.last_ledger_at) else null end
from legacy_budget lb;

with first_legacy_reservation as (
  select distinct on (l.call_id) l.id as ledger_id, br.id as reservation_id
  from public.usage_ledger l
  join public.budget_reservations br on br.call_id = l.call_id and br.tenant_id = l.tenant_id
  where l.kind = 'reservation'
  order by l.call_id, l.created_at, l.id
)
update public.usage_ledger l
set budget_reservation_id = flr.reservation_id
from first_legacy_reservation flr
where l.id = flr.ledger_id;

with first_legacy_usage as (
  select distinct on (l.call_id) l.id as ledger_id, br.id as reservation_id
  from public.usage_ledger l
  join public.budget_reservations br on br.call_id = l.call_id and br.tenant_id = l.tenant_id
  where l.kind = 'usage'
  order by l.call_id, l.created_at, l.id
)
update public.usage_ledger l
set budget_reservation_id = flu.reservation_id
from first_legacy_usage flu
where l.id = flu.ledger_id;

insert into public.usage_ledger (tenant_id, call_id, kind, cost_usd, detail, budget_reservation_id)
select br.tenant_id, br.call_id, 'adjustment', -br.reserved_cost_usd,
       jsonb_build_object('at','legacy_reservation_release'), br.id
from public.budget_reservations br
where br.status = 'settled';

insert into public.usage_ledger (tenant_id, call_id, kind, minutes, cost_usd, detail, budget_reservation_id)
select br.tenant_id, br.call_id, 'usage', br.final_minutes, br.final_cost_usd,
       jsonb_build_object('at','legacy_zero_usage_settlement'), br.id
from public.budget_reservations br
where br.status = 'settled'
  and not exists (
    select 1 from public.usage_ledger l
    where l.budget_reservation_id = br.id and l.kind = 'usage'
  );

create unique index usage_ledger_budget_event_unique
  on public.usage_ledger (budget_reservation_id, kind)
  where budget_reservation_id is not null;

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
  v_now timestamptz := clock_timestamp();
  v_day date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_est_cost is null or p_est_cost < 0 then
    raise exception 'invalid_estimated_cost' using errcode = '22023';
  end if;

  select t.daily_budget_usd, t.timezone into v_budget, v_timezone from public.tenants t where t.id = p_tenant for update;
  if v_budget is null then
    raise exception 'tenant_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.calls c where c.id = p_call and c.tenant_id = p_tenant) then
    raise exception 'call_tenant_mismatch' using errcode = '23503';
  end if;

  select br.id into v_id
  from public.budget_reservations br
  where br.call_id = p_call;
  if v_id is not null then
    return v_id;
  end if;

  v_day := (v_now at time zone v_timezone)::date;
  select coalesce(sum(
    case when br.status = 'active' then br.reserved_cost_usd else br.final_cost_usd end
  ), 0) into v_spent
  from public.budget_reservations br
  where br.tenant_id = p_tenant and br.budget_day = v_day;

  if v_spent + p_est_cost > v_budget then
    raise exception 'budget_exceeded: spent % + est % > cap %', v_spent, p_est_cost, v_budget;
  end if;

  insert into public.budget_reservations (tenant_id, call_id, budget_day, reserved_cost_usd)
  values (p_tenant, p_call, v_day, p_est_cost)
  returning id into v_id;

  insert into public.usage_ledger (tenant_id, call_id, kind, cost_usd, detail, budget_reservation_id)
  values (p_tenant, p_call, 'reservation', p_est_cost,
          jsonb_build_object('at','session_start','budget_day',v_day), v_id);

  return v_id;
end;
$$;

revoke all on function public.reserve_call_budget(uuid,uuid,numeric) from public, anon, authenticated;
grant execute on function public.reserve_call_budget(uuid,uuid,numeric) to service_role;

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
