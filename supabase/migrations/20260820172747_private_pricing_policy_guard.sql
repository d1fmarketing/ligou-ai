-- A voice-learned public quote is not authority to negotiate or close. Slot
-- offers require a separate private server policy field on the exact effective
-- rule, and the private value never enters a tool response or model prompt.
create or replace function public.enforce_slot_offer_private_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.effective_rules er
    where er.id = new.rule_id and er.tenant_id = new.tenant_id
      and er.structured ? 'price_min'
      and new.public_quote >= (er.structured->>'price_min')::numeric
  ) then
    raise exception 'slot_offer_private_policy_missing_or_denied';
  end if;
  return new;
end;
$$;

create trigger slot_offers_private_policy_guard
before insert on public.slot_offers
for each row execute function public.enforce_slot_offer_private_policy();
