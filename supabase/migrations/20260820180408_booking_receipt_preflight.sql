-- Receipts that predate the atomic accepted-receipt authority cannot be proven
-- against an independently persisted expected payload. Preserve them verbatim,
-- quarantine their intents, and require manual policy instead of auto-promotion.
insert into public.booking_receipt_conflicts (intent_id, receipt_ids, reason)
select
  r.intent_id,
  array_agg(r.id order by r.created_at, r.id),
  'legacy_accepted_receipt_unverifiable'
from public.receipts r
where r.kind = 'booking' and r.outcome = 'accepted' and r.intent_id is not null
group by r.intent_id
on conflict (intent_id) do nothing;

create or replace function public.get_booking_confirmation(p_tenant uuid, p_call uuid, p_booking uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  select jsonb_build_object(
    'confirmed', true, 'receipt_id', r.id, 'external_id', r.external_id,
    'payload_hash', r.payload_hash, 'readback', r.readback
  ) into v_result
  from public.bookings b
  join public.booking_accepted_receipts m
    on m.booking_id = b.id and m.tenant_id = b.tenant_id and m.receipt_id = b.receipt_id
  join public.receipts r
    on r.id = m.receipt_id and r.intent_id = m.intent_id and r.outcome = 'accepted'
  where b.id = p_booking and b.tenant_id = p_tenant and b.call_id = p_call
    and b.status = 'confirmed' and b.calendar_event_id = r.external_id
    and m.payload_hash = r.payload_hash and m.external_id = r.external_id
    and not exists (select 1 from public.booking_receipt_conflicts c where c.intent_id = m.intent_id);
  return coalesce(v_result, jsonb_build_object('confirmed', false));
end;
$$;

revoke all on function public.get_booking_confirmation(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_booking_confirmation(uuid,uuid,uuid) to service_role;
