-- Effective policy is the latest version in each tenant/group, and is visible
-- only while that exact latest version remains approved.
alter table public.tenants
  add column if not exists policy_epoch integer not null default 1;

create or replace view public.effective_rules
with (security_invoker = true)
as
select
  ranked.id,
  ranked.tenant_id,
  ranked.rule_group_id,
  ranked.version,
  ranked.category,
  ranked.escopo,
  ranked.text,
  ranked.structured,
  ranked.created_at
from (
  select
    r.*,
    row_number() over (
      partition by r.tenant_id, r.rule_group_id
      order by r.version desc, r.created_at desc, r.id desc
    ) as version_rank
  from public.rules r
) ranked
where ranked.version_rank = 1 and ranked.status = 'aprovado';

revoke all on public.effective_rules from public, anon;
grant select on public.effective_rules to authenticated, service_role;

create or replace function public.bump_rule_policy_epoch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tenants t
  set policy_epoch = t.policy_epoch + 1
  where t.id = new.tenant_id;
  return new;
end;
$$;

revoke all on function public.bump_rule_policy_epoch() from public, anon, authenticated;

create trigger rules_policy_epoch
after insert on public.rules
for each row execute function public.bump_rule_policy_epoch();

create or replace function public.bump_power_auth_epoch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  v_tenant := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  update public.tenants t
  set auth_epoch = t.auth_epoch + 1
  where t.id = v_tenant;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.bump_power_auth_epoch() from public, anon, authenticated;

create trigger powers_auth_epoch
after insert or update or delete on public.powers
for each row execute function public.bump_power_auth_epoch();

-- Replace the older RPC so the trigger is the single epoch increment authority.
create or replace function public.revoke_power(p_power uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select p.tenant_id into v_tenant
  from public.powers p
  join public.tenants t on t.id = p.tenant_id and t.owner_user_id = auth.uid()
  where p.id = p_power and p.revoked_at is null
  for update of p;

  if v_tenant is null then
    raise exception 'power_not_found_or_not_owner';
  end if;

  update public.powers p
  set revoked_at = now(), revoked_by = auth.uid()
  where p.id = p_power and p.revoked_at is null;

  insert into public.receipts (tenant_id, kind, outcome, external_id, readback, payload_hash)
  values (v_tenant, 'power_change', 'accepted', p_power::text,
          jsonb_build_object('op','revoke'), md5(p_power::text || 'revoke'));
end;
$$;

revoke all on function public.revoke_power(uuid) from public, anon;

-- One exported PowerConditions shape: {days[], start, end}. The historical seed
-- used {days:'mon-sat', open, close}; normalize it forward without editing history.
update public.powers p
set conditions = jsonb_set(
  p.conditions,
  '{allowed_hours}',
  jsonb_build_object('days', jsonb_build_array('mon','tue','wed','thu','fri','sat'), 'start', '08:00', 'end', '18:00')
)
where p.conditions->'allowed_hours' = jsonb_build_object('days', 'mon-sat', 'open', '08:00', 'close', '18:00');

alter table public.bookings
  add column if not exists authority_context jsonb not null default '{}'::jsonb;
