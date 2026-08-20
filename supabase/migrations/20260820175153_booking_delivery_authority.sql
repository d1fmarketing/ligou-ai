-- Corrective Task 4 authority boundary:
--   * append-safe delivery attempts plus one canonical accepted receipt mapping
--   * claim/fence token and irreversible provider-write-start transition
--   * provider input derived from locked booking state, never free intent JSON

drop index if exists public.receipts_one_booking_per_intent;

alter table public.receipts add column attempt_key text;
create unique index receipts_booking_attempt_unique
  on public.receipts (intent_id, attempt_key)
  where kind = 'booking' and intent_id is not null and attempt_key is not null;

create table public.booking_receipt_conflicts (
  intent_id uuid primary key references public.action_intents (id),
  receipt_ids uuid[] not null,
  reason text not null,
  detected_at timestamptz not null default now()
);
alter table public.booking_receipt_conflicts enable row level security;
alter table public.booking_receipt_conflicts force row level security;
create trigger booking_receipt_conflicts_append_only before update or delete on public.booking_receipt_conflicts
  for each row execute function public.block_mutation();

-- This migration has never been applied. At its own transaction boundary,
-- quarantine every pre-authority accepted receipt before confirmation authority
-- exists. Preserve every receipt row; future policy must resolve quarantine.
insert into public.booking_receipt_conflicts (intent_id, receipt_ids, reason)
select r.intent_id, array_agg(r.id order by r.created_at, r.id), 'legacy_accepted_receipt_unverifiable'
from public.receipts r
where r.kind = 'booking' and r.outcome = 'accepted' and r.intent_id is not null
group by r.intent_id
on conflict (intent_id) do nothing;

create table public.booking_accepted_receipts (
  intent_id uuid primary key references public.action_intents (id),
  tenant_id uuid not null references public.tenants (id),
  booking_id uuid not null references public.bookings (id),
  receipt_id uuid not null unique references public.receipts (id),
  payload_hash text not null,
  external_id text not null,
  expected_payload jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.booking_accepted_receipts enable row level security;
alter table public.booking_accepted_receipts force row level security;
create trigger booking_accepted_receipts_append_only before update or delete on public.booking_accepted_receipts
  for each row execute function public.block_mutation();

alter table public.action_intents
  add column claim_token uuid,
  add column claim_version bigint not null default 0,
  add column claimed_by text,
  add column provider_write_started_at timestamptz,
  add column provider_write_claim_token uuid,
  add column provider_write_input jsonb;

create or replace function public.booking_provider_input(p_intent uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_intent public.action_intents;
  v_booking public.bookings;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent;
  select b.* into v_booking from public.bookings b
  where b.id = v_intent.booking_id and b.tenant_id = v_intent.tenant_id and b.call_id = v_intent.call_id;
  if v_intent.id is null or v_booking.id is null then raise exception 'booking_intent_not_found'; end if;
  return jsonb_build_object(
    'tenantId', v_booking.tenant_id::text,
    'bookingId', v_booking.id::text,
    'summary', v_booking.service_type || ' — ' || coalesce(v_booking.client_name, 'customer') || ' ($' || v_booking.price_agreed::text || ')',
    'description', 'Booked by Ligou. Contact: ' || coalesce(v_booking.contact, '?') || '. Call ' || v_booking.call_id::text || '.',
    'startIso', v_booking.slot_start,
    'endIso', coalesce(v_booking.slot_end, v_booking.slot_start),
    'idempotencyKey', v_intent.idempotency_key
  );
end;
$$;

revoke all on function public.booking_provider_input(uuid) from public, anon, authenticated;
grant execute on function public.booking_provider_input(uuid) to service_role;

create or replace function public.enforce_booking_intent_payload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_expected jsonb;
begin
  if new.kind <> 'calendar_book' then return new; end if;
  select b.* into v_booking from public.bookings b
  where b.id = new.booking_id and b.tenant_id = new.tenant_id and b.call_id = new.call_id;
  if v_booking.id is null then raise exception 'booking_intent_scope_mismatch'; end if;
  v_expected := jsonb_build_object(
    'summary', v_booking.service_type || ' — ' || coalesce(v_booking.client_name, 'customer') || ' ($' || v_booking.price_agreed::text || ')',
    'description', 'Booked by Ligou. Contact: ' || coalesce(v_booking.contact, '?') || '. Call ' || v_booking.call_id::text || '.',
    'start_iso', v_booking.slot_start,
    'end_iso', coalesce(v_booking.slot_end, v_booking.slot_start)
  );
  if new.payload <> v_expected then raise exception 'booking_intent_payload_mismatch'; end if;
  return new;
end;
$$;

create trigger action_intents_booking_payload_guard
before insert or update of payload, booking_id, tenant_id, call_id on public.action_intents
for each row execute function public.enforce_booking_intent_payload();

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
    select i.id, i.status as prior_status from public.action_intents i
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
    claim_token = gen_random_uuid(), claim_version = ai.claim_version + 1, claimed_by = p_worker
  from candidate where ai.id = candidate.id
  returning ai.*;
end;
$$;

revoke all on function public.claim_intent(text) from public, anon, authenticated;
grant execute on function public.claim_intent(text) to service_role;

create or replace function public.prepare_booking_provider_write(p_intent uuid, p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.action_intents;
  v_ready boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent for update;
  if v_intent.id is null or v_intent.status <> 'running' or v_intent.execution_mode <> 'write'
     or v_intent.claim_token is null or v_intent.claim_token <> p_claim_token
     or v_intent.lease_until is null or v_intent.lease_until <= now()
     or v_intent.provider_write_started_at is not null then return null; end if;
  v_ready := public.prepare_booking_provider_write(p_intent);
  if not coalesce(v_ready, false) then return null; end if;
  return jsonb_build_object('ready', true, 'provider_input', public.booking_provider_input(p_intent));
end;
$$;

revoke all on function public.prepare_booking_provider_write(uuid,uuid) from public, anon, authenticated;
grant execute on function public.prepare_booking_provider_write(uuid,uuid) to service_role;

create or replace function public.begin_provider_write(p_intent uuid, p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.action_intents;
  v_booking public.bookings;
  v_lease public.booking_slot_leases;
  v_provider_input jsonb;
  v_expected_payload jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent for update;
  if v_intent.id is null or v_intent.status <> 'running' or v_intent.execution_mode <> 'write'
     or v_intent.claim_token is null or v_intent.claim_token <> p_claim_token
     or v_intent.lease_until is null or v_intent.lease_until <= now()
     or v_intent.provider_write_started_at is not null then return null; end if;
  if not public.validate_booking_intent_authority(p_intent) then return null; end if;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent;
  select b.* into v_booking from public.bookings b where b.id = v_intent.booking_id for update;
  select l.* into v_lease from public.booking_slot_leases l where l.intent_id = p_intent for update;
  if v_lease.intent_id is null
     or v_lease.state is distinct from 'held'
     or v_lease.tenant_id is distinct from v_booking.tenant_id
     or v_lease.slot_start is distinct from v_booking.slot_start
     or v_lease.slot_end is distinct from coalesce(v_booking.slot_end, v_booking.slot_start) then
    raise exception 'booking_slot_lease_mismatch';
  end if;
  v_provider_input := jsonb_build_object(
    'summary', v_booking.service_type || ' — ' || coalesce(v_booking.client_name, 'customer') || ' ($' || v_booking.price_agreed::text || ')',
    'description', 'Booked by Ligou. Contact: ' || coalesce(v_booking.contact, '?') || '. Call ' || v_booking.call_id::text || '.',
    'start_iso', v_booking.slot_start,
    'end_iso', coalesce(v_booking.slot_end, v_booking.slot_start)
  );
  if v_intent.payload <> v_provider_input then raise exception 'booking_intent_payload_mismatch'; end if;
  v_expected_payload := public.booking_provider_input(p_intent);
  update public.action_intents ai set
    provider_write_started_at = now(), provider_write_claim_token = p_claim_token,
    provider_write_input = v_expected_payload, execution_mode = 'reconcile'
  where ai.id = p_intent and ai.provider_write_started_at is null;
  if not found then return null; end if;
  return jsonb_build_object('authorized', true, 'provider_input', v_expected_payload);
end;
$$;

revoke all on function public.begin_provider_write(uuid,uuid) from public, anon, authenticated;
grant execute on function public.begin_provider_write(uuid,uuid) to service_role;

create or replace function public.get_booking_provider_input(p_intent uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  return public.booking_provider_input(p_intent);
end;
$$;

revoke all on function public.get_booking_provider_input(uuid) from public, anon, authenticated;
grant execute on function public.get_booking_provider_input(uuid) to service_role;

create or replace function public.transition_claimed_intent(
  p_intent uuid,
  p_claim_token uuid,
  p_transition text,
  p_reason text,
  p_delay_seconds integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.action_intents;
  v_rows integer;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_transition not in ('defer','fail') then raise exception 'invalid_claim_transition'; end if;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent for update;
  if v_intent.id is null or v_intent.status <> 'running'
     or v_intent.claim_token is distinct from p_claim_token
     or v_intent.lease_until is null or v_intent.lease_until <= now()
     or v_intent.provider_write_started_at is not null then return false; end if;

  delete from public.booking_slot_leases l
  where l.intent_id = p_intent and l.state = 'held';

  if p_transition = 'defer' then
    update public.action_intents ai set
      status = 'queued', last_error = left(coalesce(p_reason, 'prewrite_deferred'), 400),
      lease_until = null, next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0))
    where ai.id = p_intent and ai.claim_token = p_claim_token and ai.status = 'running';
    get diagnostics v_rows = row_count;
  else
    update public.action_intents ai set
      status = 'failed', last_error = left(coalesce(p_reason, 'prewrite_failed'), 400),
      finished_at = now(), lease_until = null
    where ai.id = p_intent and ai.claim_token = p_claim_token and ai.status = 'running';
    get diagnostics v_rows = row_count;
    if v_intent.booking_id is not null then
      update public.bookings b set status = 'failed'
      where b.id = v_intent.booking_id and b.tenant_id = v_intent.tenant_id
        and b.call_id = v_intent.call_id and b.status in ('proposed','unknown');
    end if;
  end if;
  return v_rows = 1;
end;
$$;

revoke all on function public.transition_claimed_intent(uuid,uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.transition_claimed_intent(uuid,uuid,text,text,integer) to service_role;

create or replace function public.record_booking_delivery(
  p_intent uuid,
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
  v_booking public.bookings;
  v_existing_map public.booking_accepted_receipts;
  v_existing_receipt public.receipts;
  v_receipt_id uuid;
  v_rows integer;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_outcome not in ('accepted','failed','unknown') then raise exception 'invalid_booking_delivery_outcome'; end if;
  if nullif(p_attempt_key, '') is null then raise exception 'attempt_key_required'; end if;
  select ai.* into v_intent from public.action_intents ai where ai.id = p_intent for update;
  select b.* into v_booking from public.bookings b where b.id = v_intent.booking_id for update;
  if v_intent.id is null or v_booking.id is null then raise exception 'booking_intent_not_found'; end if;

  select m.* into v_existing_map from public.booking_accepted_receipts m where m.intent_id = p_intent;
  if v_existing_map.intent_id is not null and p_outcome <> 'accepted' then
    insert into public.receipts (
      tenant_id, intent_id, call_id, kind, outcome, external_id, readback,
      payload_hash, provider_request, detail, attempt_key
    ) values (
      v_intent.tenant_id, v_intent.id, v_intent.call_id, 'booking', p_outcome,
      p_external_id, p_readback, p_payload_hash, p_provider_request,
      jsonb_build_object('late_after_accepted', true), p_attempt_key
    )
    on conflict (intent_id, attempt_key) where kind = 'booking' and intent_id is not null and attempt_key is not null
    do nothing;
    return jsonb_build_object('authoritative', true, 'receipt_id', v_existing_map.receipt_id, 'reused', true);
  end if;

  if p_outcome = 'accepted' then
    if exists (select 1 from public.booking_receipt_conflicts c where c.intent_id = p_intent) then
      raise exception 'receipt_history_quarantined';
    end if;
    if p_external_id is null or p_readback is null or p_payload_hash is null or p_expected is null then
      raise exception 'accepted_receipt_proof_required';
    end if;
    if nullif(p_expected->>'provider', '') is null
       or nullif(p_expected->>'account_id', '') is null
       or nullif(p_expected->>'calendar_id', '') is null
       or (p_expected->>'summary') is distinct from (v_booking.service_type || ' — ' || coalesce(v_booking.client_name, 'customer') || ' ($' || v_booking.price_agreed::text || ')')
       or (p_expected->>'description') is distinct from ('Booked by Ligou. Contact: ' || coalesce(v_booking.contact, '?') || '. Call ' || v_booking.call_id::text || '.')
       or ((p_expected->>'start')::timestamptz) is distinct from v_booking.slot_start
       or ((p_expected->>'end')::timestamptz) is distinct from coalesce(v_booking.slot_end, v_booking.slot_start)
       or (p_expected->>'status') is distinct from 'confirmed'
       or (p_expected->>'payload_hash') is distinct from p_payload_hash
       or (p_expected->'private'->>'ligouKey') is distinct from v_intent.idempotency_key
       or (p_expected->'private'->>'ligouProvider') is distinct from (p_expected->>'provider')
       or (p_expected->'private'->>'ligouTenantId') is distinct from v_booking.tenant_id::text
       or (p_expected->'private'->>'ligouBookingId') is distinct from v_booking.id::text
       or (p_expected->'private'->>'ligouCalendarId') is distinct from (p_expected->>'calendar_id')
       or (p_expected->'private'->>'ligouAccountId') is distinct from (p_expected->>'account_id')
       or (p_expected->'private'->>'ligouPayloadHash') is distinct from p_payload_hash
       or (p_readback->>'id') is distinct from p_external_id
       or (p_readback->>'summary') is distinct from (p_expected->>'summary')
       or (p_readback->>'description') is distinct from (p_expected->>'description')
       or ((p_readback->'start'->>'dateTime')::timestamptz) is distinct from v_booking.slot_start
       or ((p_readback->'end'->>'dateTime')::timestamptz) is distinct from coalesce(v_booking.slot_end, v_booking.slot_start)
       or (p_readback->>'status') is distinct from 'confirmed'
       or (p_readback->'extendedProperties'->'private') is distinct from (p_expected->'private')
       or (p_readback->'extendedProperties'->'private'->>'ligouPayloadHash') is distinct from p_payload_hash then
      raise exception 'accepted_receipt_proof_mismatch';
    end if;

    if v_existing_map.intent_id is not null then
      select r.* into v_existing_receipt from public.receipts r where r.id = v_existing_map.receipt_id;
      if v_existing_receipt.outcome <> 'accepted' or v_existing_receipt.external_id <> p_external_id
         or v_existing_receipt.payload_hash <> p_payload_hash or v_existing_receipt.readback <> p_readback
         or v_existing_map.expected_payload <> p_expected or v_existing_map.booking_id <> v_booking.id then
        raise exception 'accepted_receipt_conflict';
      end if;
      return jsonb_build_object('authoritative', true, 'receipt_id', v_existing_map.receipt_id, 'reused', true);
    end if;
  end if;

  insert into public.receipts (
    tenant_id, intent_id, call_id, kind, outcome, external_id, readback,
    payload_hash, provider_request, detail, attempt_key
  ) values (
    v_intent.tenant_id, v_intent.id, v_intent.call_id, 'booking', p_outcome,
    p_external_id, p_readback, p_payload_hash, p_provider_request,
    case when p_outcome = 'accepted' then null else jsonb_build_object('delivery_outcome', p_outcome) end,
    p_attempt_key
  )
  on conflict (intent_id, attempt_key) where kind = 'booking' and intent_id is not null and attempt_key is not null
  do nothing returning id into v_receipt_id;

  if v_receipt_id is null then
    select r.* into v_existing_receipt from public.receipts r
    where r.intent_id = p_intent and r.attempt_key = p_attempt_key and r.kind = 'booking';
    if v_existing_receipt.id is null or v_existing_receipt.outcome <> p_outcome
       or v_existing_receipt.external_id is distinct from p_external_id
       or v_existing_receipt.readback is distinct from p_readback
       or v_existing_receipt.payload_hash is distinct from p_payload_hash then
      raise exception 'booking_delivery_attempt_conflict';
    end if;
    v_receipt_id := v_existing_receipt.id;
  end if;

  if p_outcome = 'accepted' then
    begin
      insert into public.booking_accepted_receipts (
        intent_id, tenant_id, booking_id, receipt_id, payload_hash, external_id, expected_payload
      ) values (
        v_intent.id, v_intent.tenant_id, v_booking.id, v_receipt_id, p_payload_hash, p_external_id, p_expected
      );
    exception when unique_violation then
      raise exception 'accepted_receipt_conflict';
    end;
    update public.booking_slot_leases l set state = 'committed', committed_at = coalesce(l.committed_at, now())
    where l.intent_id = v_intent.id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'booking_slot_lease_missing'; end if;
    update public.action_intents ai set status = 'succeeded', finished_at = now(), lease_until = null
    where ai.id = v_intent.id;
    update public.bookings b set status = 'confirmed', calendar_event_id = p_external_id, receipt_id = v_receipt_id
    where b.id = v_booking.id and b.tenant_id = v_intent.tenant_id;
    insert into public.notifications (tenant_id, kind, payload)
    values (v_intent.tenant_id, 'booking_confirmed', jsonb_build_object('booking_id', v_booking.id, 'event_id', p_external_id));
    return jsonb_build_object('authoritative', true, 'receipt_id', v_receipt_id, 'reused', false);
  elsif p_outcome = 'failed' then
    update public.action_intents ai set status = 'failed', last_error = coalesce(p_provider_request->>'error', 'provider_failed'), finished_at = now(), lease_until = null
    where ai.id = v_intent.id;
    update public.bookings b set status = 'failed' where b.id = v_booking.id and b.status in ('proposed','unknown');
  else
    update public.action_intents ai set status = 'unknown', execution_mode = 'reconcile', last_error = coalesce(p_provider_request->>'error', 'provider_unknown'),
      lease_until = null, next_attempt_at = now() + interval '60 seconds'
    where ai.id = v_intent.id;
    update public.bookings b set status = 'unknown' where b.id = v_booking.id and b.status = 'proposed';
  end if;
  return jsonb_build_object('authoritative', false, 'receipt_id', v_receipt_id);
end;
$$;

revoke all on function public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.record_booking_delivery(uuid,text,text,text,jsonb,text,jsonb,jsonb) to service_role;

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
  join public.booking_accepted_receipts m on m.booking_id = b.id and m.tenant_id = b.tenant_id and m.receipt_id = b.receipt_id
  join public.receipts r on r.id = m.receipt_id and r.intent_id = m.intent_id and r.outcome = 'accepted'
  where b.id = p_booking and b.tenant_id = p_tenant and b.call_id = p_call and m.intent_id = b.intent_id
    and b.status = 'confirmed' and b.calendar_event_id = r.external_id
    and m.payload_hash = r.payload_hash and m.external_id = r.external_id
    and not exists (select 1 from public.booking_receipt_conflicts c where c.intent_id = m.intent_id);
  return coalesce(v_result, jsonb_build_object('confirmed', false));
end;
$$;

revoke all on function public.get_booking_confirmation(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_booking_confirmation(uuid,uuid,uuid) to service_role;

-- The old split commit RPC is no longer confirmation authority.
revoke execute on function public.commit_booking_slot_lease(uuid) from service_role;
revoke execute on function public.release_booking_slot_lease(uuid) from service_role;
revoke execute on function public.prepare_booking_provider_write(uuid) from service_role;
revoke execute on function public.validate_booking_intent_authority(uuid) from service_role;
