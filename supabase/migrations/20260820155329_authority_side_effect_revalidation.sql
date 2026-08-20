-- Booking intent authorization is committed atomically with the exact current
-- grant, effective rule, and tenant epochs. The worker revalidates the same
-- references immediately before the provider boundary.
create or replace function public.authorize_booking_intent(
  p_tenant uuid,
  p_call uuid,
  p_booking uuid,
  p_power uuid,
  p_rule uuid,
  p_confirmed_price numeric,
  p_expected_auth_epoch integer,
  p_expected_policy_epoch integer,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_booking public.bookings;
  v_power public.powers;
  v_rule record;
  v_intent public.action_intents;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = p_tenant for update;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_tenant.auth_epoch <> p_expected_auth_epoch or v_tenant.policy_epoch <> p_expected_policy_epoch then
    raise exception 'authority_epoch_stale';
  end if;

  select b.* into v_booking from public.bookings b
  where b.id = p_booking and b.tenant_id = p_tenant and b.call_id = p_call
  for update;
  if v_booking.id is null or v_booking.status <> 'proposed' then
    raise exception 'booking_not_authorizable';
  end if;

  select p.* into v_power from public.powers p
  where p.id = p_power
    and p.tenant_id = p_tenant
    and p.subject = 'voice_agent'
    and p.capability = 'create_booking'
    and (p.resource = '*' or p.resource = v_booking.service_type)
    and p.revoked_at is null
    and (p.expires_at is null or p.expires_at > now())
  for share;
  if v_power.id is null or (v_power.monetary_limit is not null and p_confirmed_price > v_power.monetary_limit) then
    raise exception 'referenced_power_not_current';
  end if;

  select er.* into v_rule from public.effective_rules er
  where er.id = p_rule
    and er.tenant_id = p_tenant
    and er.category = 'preco'
    and er.structured->>'service_type' = v_booking.service_type;
  if v_rule.id is null
     or p_confirmed_price < coalesce((v_rule.structured->>'price_min')::numeric, p_confirmed_price) then
    raise exception 'referenced_rule_not_effective';
  end if;

  select ai.* into v_intent from public.action_intents ai
  where ai.idempotency_key = p_idempotency_key;
  if v_intent.id is null then
    insert into public.action_intents (
      tenant_id, call_id, booking_id, kind, payload, policy_snapshot, idempotency_key, status
    ) values (
      p_tenant, p_call, p_booking, 'calendar_book', p_payload,
      jsonb_build_object(
        'power_id', p_power,
        'rule_id', p_rule,
        'auth_epoch', p_expected_auth_epoch,
        'policy_epoch', p_expected_policy_epoch,
        'price_confirmed', p_confirmed_price,
        'authority_context', v_booking.authority_context
      ),
      p_idempotency_key, 'queued'
    ) returning * into v_intent;
  elsif v_intent.tenant_id <> p_tenant or v_intent.booking_id <> p_booking then
    raise exception 'idempotency_scope_mismatch';
  end if;

  update public.bookings b
  set intent_id = v_intent.id, price_agreed = p_confirmed_price
  where b.id = p_booking and b.status = 'proposed';

  return jsonb_build_object('id', v_intent.id, 'status', v_intent.status);
end;
$$;

revoke all on function public.authorize_booking_intent(uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.authorize_booking_intent(uuid,uuid,uuid,uuid,uuid,numeric,integer,integer,jsonb,text) to service_role;

create or replace function public.validate_booking_intent_authority(p_intent uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_intent public.action_intents;
  v_booking public.bookings;
  v_valid boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select ai.tenant_id into v_tenant_id from public.action_intents ai where ai.id = p_intent;
  if v_tenant_id is null then return false; end if;
  perform 1 from public.tenants t where t.id = v_tenant_id for update;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent for update;
  select b.* into v_booking from public.bookings b where b.id = v_intent.booking_id;

  select
    v_intent.status = 'running'
    and exists (
      select 1 from public.tenants t
      where t.id = v_intent.tenant_id
        and t.auth_epoch = (v_intent.policy_snapshot->>'auth_epoch')::integer
        and t.policy_epoch = (v_intent.policy_snapshot->>'policy_epoch')::integer
    )
    and exists (
      select 1 from public.powers p
      where p.id = (v_intent.policy_snapshot->>'power_id')::uuid
        and p.tenant_id = v_intent.tenant_id
        and p.subject = 'voice_agent' and p.capability = 'create_booking'
        and (p.resource = '*' or p.resource = v_booking.service_type)
        and p.revoked_at is null and (p.expires_at is null or p.expires_at > now())
        and (p.monetary_limit is null or (v_intent.policy_snapshot->>'price_confirmed')::numeric <= p.monetary_limit)
    )
    and exists (
      select 1 from public.effective_rules er
      where er.id = (v_intent.policy_snapshot->>'rule_id')::uuid
        and er.tenant_id = v_intent.tenant_id
        and er.structured->>'service_type' = v_booking.service_type
        and (v_intent.policy_snapshot->>'price_confirmed')::numeric >= coalesce((er.structured->>'price_min')::numeric, 0)
    )
  into v_valid;

  if not coalesce(v_valid, false) then
    update public.action_intents ai set
      status = 'failed', last_error = 'authority_stale_before_provider', finished_at = now(), lease_until = null
    where ai.id = p_intent and ai.status = 'running';
    update public.bookings b set status = 'pending_approval'
    where b.id = v_intent.booking_id and b.status in ('proposed','unknown');
    return false;
  end if;
  return true;
end;
$$;

revoke all on function public.validate_booking_intent_authority(uuid) from public, anon, authenticated;
grant execute on function public.validate_booking_intent_authority(uuid) to service_role;

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
  where ai.status in ('authorized','queued','unknown')
    and ai.kind = 'calendar_book'
    and not (
      exists (
        select 1 from public.tenants t
        where t.id = ai.tenant_id
          and t.auth_epoch = (ai.policy_snapshot->>'auth_epoch')::integer
          and t.policy_epoch = (ai.policy_snapshot->>'policy_epoch')::integer
      )
      and exists (
        select 1 from public.powers p
        where p.id = (ai.policy_snapshot->>'power_id')::uuid
          and p.tenant_id = ai.tenant_id and p.revoked_at is null
      )
      and exists (
        select 1 from public.effective_rules er
        where er.id = (ai.policy_snapshot->>'rule_id')::uuid and er.tenant_id = ai.tenant_id
      )
    );

  return query
  update public.action_intents ai set
    status = 'running', attempts = ai.attempts + 1,
    lease_until = now() + interval '90 seconds', last_error = null
  where ai.id = (
    select i.id from public.action_intents i
    where (
      i.status in ('authorized','queued','unknown')
      or (i.status = 'running' and i.lease_until < now())
    )
      and i.next_attempt_at <= now()
      and (i.lease_until is null or i.lease_until < now())
      and i.attempts < 5
    order by i.created_at
    for update skip locked
    limit 1
  )
  returning ai.*;
end;
$$;

revoke all on function public.claim_intent(text) from public, anon, authenticated;
grant execute on function public.claim_intent(text) to service_role;
