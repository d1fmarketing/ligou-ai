-- Suggested/rejected drafts do not change effective policy. Only the latest
-- approved/revoked decision in a rule group participates in authority.
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
  where r.status in ('aprovado','revogado')
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
  if new.status in ('aprovado','revogado') then
    update public.tenants t
    set policy_epoch = t.policy_epoch + 1
    where t.id = new.tenant_id;
  end if;
  return new;
end;
$$;

revoke all on function public.bump_rule_policy_epoch() from public, anon, authenticated, service_role;
drop trigger if exists rules_policy_epoch on public.rules;
create trigger rules_policy_epoch
after insert on public.rules
for each row execute function public.bump_rule_policy_epoch();
