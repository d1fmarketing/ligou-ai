-- Rotate both the worker claim and the provider-write fence together when an
-- already-started provider operation is reclaimed for reconciliation.
create or replace function public.claim_intent(p_worker text)
returns setof public.action_intents
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  update public.action_intents ai set
    status = 'failed', last_error = 'authority_stale_before_claim', finished_at = now(), lease_until = null
  where ai.status in ('authorized','queued') and ai.kind = 'calendar_book'
    and ai.provider_write_started_at is null
    and not (
      exists (select 1 from public.tenants t where t.id = ai.tenant_id
        and t.auth_epoch = (ai.policy_snapshot->>'auth_epoch')::integer
        and t.policy_epoch = (ai.policy_snapshot->>'policy_epoch')::integer)
      and exists (select 1 from public.powers p where p.id = (ai.policy_snapshot->>'power_id')::uuid
        and p.tenant_id = ai.tenant_id and p.revoked_at is null)
      and exists (select 1 from public.effective_rules er where er.id = (ai.policy_snapshot->>'rule_id')::uuid
        and er.tenant_id = ai.tenant_id)
    );

  return query
  with candidate as (
    select i.id, i.status as prior_status, gen_random_uuid() as next_claim_token
    from public.action_intents i
    where (i.status in ('authorized','queued','unknown') or (i.status = 'running' and i.lease_until < now()))
      and i.next_attempt_at <= now() and (i.lease_until is null or i.lease_until < now()) and i.attempts < 5
    order by i.created_at for update skip locked limit 1
  )
  update public.action_intents ai set
    status = 'running', attempts = ai.attempts + 1,
    lease_until = now() + interval '90 seconds', last_error = null,
    execution_mode = case
      when candidate.prior_status in ('unknown','running') or ai.provider_write_started_at is not null then 'reconcile'
      else ai.execution_mode end,
    claim_token = candidate.next_claim_token,
    provider_write_claim_token = case
      when ai.provider_write_started_at is not null then candidate.next_claim_token
      else ai.provider_write_claim_token end,
    claim_version = ai.claim_version + 1,
    claimed_by = p_worker
  from candidate where ai.id = candidate.id
  returning ai.*;
end;
$$;

revoke all on function public.claim_intent(text) from public, anon, authenticated;
grant execute on function public.claim_intent(text) to service_role;

-- Keep the historical eight-argument implementation internal. The only
-- service-role delivery authority is this fenced nine-argument wrapper.
create or replace function public.record_booking_delivery(
  p_intent uuid,
  p_claim_token uuid,
  p_attempt_key text,
  p_outcome text,
  p_external_id text,
  p_readback jsonb,
  p_payload_hash text,
  p_provider_request jsonb,
  p_expected jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.action_intents;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select ai.* into v_intent
  from public.action_intents ai
  where ai.id = p_intent
  for update;
  if v_intent.id is null then raise exception 'booking_intent_not_found'; end if;

  if p_outcome = 'accepted' then
    if p_claim_token is null
       or v_intent.provider_write_started_at is null
       or v_intent.provider_write_claim_token is distinct from p_claim_token
       or v_intent.claim_token is distinct from p_claim_token then
      raise exception 'provider_write_fence_required';
    end if;
    if v_intent.provider_write_input is null
       or v_intent.provider_write_input is distinct from public.booking_provider_input(p_intent) then
      raise exception 'provider_write_input_mismatch';
    end if;
    if p_expected is null
       or (p_expected->>'summary') is distinct from (v_intent.provider_write_input->>'summary')
       or (p_expected->>'description') is distinct from (v_intent.provider_write_input->>'description')
       or ((p_expected->>'start')::timestamptz) is distinct from ((v_intent.provider_write_input->>'startIso')::timestamptz)
       or ((p_expected->>'end')::timestamptz) is distinct from ((v_intent.provider_write_input->>'endIso')::timestamptz)
       or (p_expected->'private'->>'ligouKey') is distinct from (v_intent.provider_write_input->>'idempotencyKey')
       or (p_expected->'private'->>'ligouTenantId') is distinct from (v_intent.provider_write_input->>'tenantId')
       or (p_expected->'private'->>'ligouBookingId') is distinct from (v_intent.provider_write_input->>'bookingId') then
      raise exception 'provider_write_input_mismatch';
    end if;
  end if;

  return public.record_booking_delivery(
    p_intent, p_attempt_key, p_outcome, p_external_id, p_readback,
    p_payload_hash, p_provider_request, p_expected
  );
end;
$$;

revoke all on function public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.record_booking_delivery(uuid,uuid,text,text,text,jsonb,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.record_booking_delivery(uuid,uuid,text,text,text,jsonb,text,jsonb,jsonb) to service_role;
