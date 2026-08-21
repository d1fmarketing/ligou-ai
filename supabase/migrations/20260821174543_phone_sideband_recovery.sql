-- Corrective phone ownership: renewable sideband leases, at-most-once provider
-- termination attempts, and safe recovery of legacy event/call asymmetry.
alter table public.phone_events
  add column sideband_lease_until timestamptz,
  add column sideband_heartbeat_at timestamptz,
  add column provider_termination_attempt_id uuid,
  add column provider_termination_request_id text,
  add column provider_termination_attempted_at timestamptz;

alter table public.calls
  add column provider_termination_attempt_id uuid,
  add column provider_termination_request_id text,
  add column provider_termination_attempted_at timestamptz;

alter table public.phone_events
  drop constraint phone_events_lifecycle_state_check,
  drop constraint phone_events_provider_termination_state_check,
  drop constraint phone_events_sideband_state_check,
  add constraint phone_events_lifecycle_state_check check (lifecycle_state in (
    'pending','claimed','call_persisted','budget_reserved','accepting','accepted','sideband_attaching','active',
    'rejected','terminated','reconciliation_required','external_evidence_required'
  )),
  add constraint phone_events_provider_termination_state_check check (
    provider_termination_state in ('not_required','active','pending','confirmed','unknown','external_evidence_required')
  ),
  add constraint phone_events_sideband_state_check check (
    sideband_state in ('not_attached','attaching','attached','failed','closed','unknown')
  ),
  add constraint phone_events_provider_termination_attempt_check check (
    (provider_termination_attempt_id is null and provider_termination_request_id is null and provider_termination_attempted_at is null)
    or
    (provider_termination_attempt_id is not null
      and provider_termination_request_id = provider_termination_attempt_id::text
      and provider_termination_attempted_at is not null)
  );

alter table public.calls
  drop constraint calls_provider_termination_state_check,
  add constraint calls_provider_termination_state_check check (
    provider_termination_state in ('not_required','active','pending','confirmed','unknown','external_evidence_required')
  ),
  add constraint calls_provider_termination_attempt_check check (
    (provider_termination_attempt_id is null and provider_termination_request_id is null and provider_termination_attempted_at is null)
    or
    (provider_termination_attempt_id is not null
      and provider_termination_request_id = provider_termination_attempt_id::text
      and provider_termination_attempted_at is not null)
  );

-- Any old pending/unknown state may already have issued a POST. With no provider
-- readback endpoint, it is evidence-only work and can never be retried automatically.
update public.phone_events p set
  lifecycle_state = 'external_evidence_required',
  status = 'error',
  provider_termination_state = 'external_evidence_required',
  lifecycle_last_error = coalesce(p.lifecycle_last_error, 'legacy_provider_termination_outcome_unknown'),
  lifecycle_reconcile_lease_until = null,
  lifecycle_reconcile_worker = null
where p.provider_termination_state in ('pending','unknown');

update public.calls c set
  provider_termination_state = 'external_evidence_required',
  provider_termination_last_error = coalesce(c.provider_termination_last_error, 'legacy_provider_termination_outcome_unknown'),
  provider_termination_reconcile_lease_until = null,
  provider_termination_reconcile_worker = null
where c.provider_termination_state in ('pending','unknown');

update public.phone_events p set
  sideband_lease_until = clock_timestamp() + interval '15 seconds',
  lifecycle_reconcile_after = clock_timestamp() + interval '15 seconds'
where p.lifecycle_state = 'active' and p.sideband_lease_until is null;

create table public.phone_lifecycle_legacy_conflicts (
  event_id uuid primary key references public.phone_events (id) on delete cascade,
  openai_call_id text not null,
  reason text not null check (reason in (
    'legacy_phone_provider_match_absent',
    'legacy_phone_provider_match_ambiguous',
    'legacy_phone_provider_match_cross_tenant',
    'legacy_phone_provider_match_already_owned'
  )),
  event_tenant_id uuid,
  matching_call_ids uuid[] not null default '{}',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.phone_lifecycle_legacy_conflicts enable row level security;
alter table public.phone_lifecycle_legacy_conflicts force row level security;

create or replace function public.repair_legacy_phone_links()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_call public.calls;
  v_call_ids uuid[];
  v_match_count integer;
  v_reason text;
  v_linked integer := 0;
  v_quarantined integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;

  for v_event in
    select p.* from public.phone_events p
    where p.call_id is null and p.handled_at is not null
    order by p.created_at, p.id
    for update of p
  loop
    select count(*)::integer, coalesce(array_agg(c.id order by c.id), '{}'::uuid[])
    into v_match_count, v_call_ids
    from public.calls c
    where c.channel = 'phone' and c.openai_call_id = v_event.openai_call_id;

    v_reason := null;
    if v_match_count = 1 then
      select c.* into v_call from public.calls c where c.id = v_call_ids[1] for update;
      if v_event.tenant_id is not null and v_call.tenant_id is distinct from v_event.tenant_id then
        v_reason := 'legacy_phone_provider_match_cross_tenant';
      elsif v_call.phone_event_id is not null and v_call.phone_event_id is distinct from v_event.id then
        v_reason := 'legacy_phone_provider_match_already_owned';
      elsif v_event.tenant_id is null or v_call.tenant_id is not distinct from v_event.tenant_id then
        update public.phone_events p
        set call_id = v_call.id, tenant_id = coalesce(p.tenant_id, v_call.tenant_id),
            lifecycle_updated_at = clock_timestamp()
        where p.id = v_event.id;
        update public.calls c set phone_event_id = v_event.id where c.id = v_call.id;
        update public.phone_lifecycle_legacy_conflicts f
        set resolved_at = clock_timestamp()
        where f.event_id = v_event.id and f.resolved_at is null;
        v_linked := v_linked + 1;
      end if;
    elsif v_match_count = 0 then
      v_reason := 'legacy_phone_provider_match_absent';
    else
      v_reason := 'legacy_phone_provider_match_ambiguous';
    end if;

    if v_reason is not null then
      insert into public.phone_lifecycle_legacy_conflicts (
        event_id, openai_call_id, reason, event_tenant_id, matching_call_ids, detected_at, resolved_at
      ) values (
        v_event.id, v_event.openai_call_id, v_reason, v_event.tenant_id, v_call_ids, clock_timestamp(), null
      ) on conflict (event_id) do update set
        reason = excluded.reason,
        event_tenant_id = excluded.event_tenant_id,
        matching_call_ids = excluded.matching_call_ids,
        detected_at = excluded.detected_at,
        resolved_at = null;
      update public.phone_events p set
        status = 'error', lifecycle_state = 'external_evidence_required',
        provider_termination_state = 'external_evidence_required',
        lifecycle_last_error = v_reason,
        lifecycle_reconcile_lease_until = null, lifecycle_reconcile_worker = null
      where p.id = v_event.id;
      update public.calls c set
        provider_termination_state = 'external_evidence_required',
        provider_termination_last_error = v_reason,
        provider_termination_reconcile_lease_until = null,
        provider_termination_reconcile_worker = null
      where c.channel = 'phone' and c.openai_call_id = v_event.openai_call_id;
      v_quarantined := v_quarantined + 1;
    end if;
  end loop;

  return jsonb_build_object('linked', v_linked, 'quarantined', v_quarantined);
end;
$$;

select set_config('request.jwt.claim.role', 'service_role', true);
select public.repair_legacy_phone_links();

create or replace function public.begin_provider_termination_attempt(
  p_call_id uuid,
  p_openai_call_id text,
  p_mode text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_call public.calls;
  v_attempt uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_call_id is null or nullif(btrim(p_openai_call_id), '') is null
    or p_mode is null or p_mode not in ('reject','hangup') or nullif(btrim(p_reason), '') is null then
    raise exception 'provider_termination_arguments_invalid' using errcode = '22023';
  end if;
  select c.* into v_call from public.calls c where c.id = p_call_id for update;
  if v_call.id is null then raise exception 'call_not_found' using errcode = 'P0002'; end if;
  if v_call.provider_termination_attempt_id is not null
    or v_call.provider_termination_state in ('pending','unknown','confirmed','external_evidence_required') then
    return jsonb_build_object('should_attempt', false);
  end if;
  if v_call.openai_call_id is not null and v_call.openai_call_id is distinct from p_openai_call_id then
    raise exception 'provider_call_identity_mismatch' using errcode = '23514';
  end if;
  update public.calls c set
    openai_call_id = coalesce(c.openai_call_id, p_openai_call_id),
    provider_termination_state = 'pending',
    provider_termination_mode = p_mode,
    provider_termination_reason = left(p_reason, 400),
    provider_termination_last_error = null,
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    provider_termination_reconcile_lease_until = clock_timestamp() + interval '15 seconds'
  where c.id = v_call.id;
  return jsonb_build_object(
    'should_attempt', true,
    'attempt_id', v_attempt,
    'request_id', v_attempt::text,
    'openai_call_id', p_openai_call_id,
    'provider_termination_mode', p_mode
  );
end;
$$;

create or replace function public.complete_provider_termination_attempt(
  p_call_id uuid,
  p_attempt_id uuid,
  p_confirmed boolean,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_call public.calls;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_call_id is null or p_attempt_id is null or p_confirmed is null then
    raise exception 'provider_termination_completion_invalid' using errcode = '22023';
  end if;
  select c.* into v_call from public.calls c where c.id = p_call_id for update;
  if v_call.id is null then raise exception 'call_not_found' using errcode = 'P0002'; end if;
  if v_call.provider_termination_attempt_id is distinct from p_attempt_id
    or v_call.provider_termination_state <> 'pending' then
    return false;
  end if;
  update public.calls c set
    provider_termination_state = case when p_confirmed then 'confirmed' else 'external_evidence_required' end,
    provider_termination_last_error = case when p_confirmed then null else left(coalesce(p_error, 'provider_termination_external_evidence_required'), 400) end,
    provider_terminated_at = case when p_confirmed then clock_timestamp() else c.provider_terminated_at end,
    provider_termination_reconcile_lease_until = null,
    provider_termination_reconcile_worker = null
  where c.id = v_call.id;
  return true;
end;
$$;

create or replace function public.claim_provider_termination_reconciliation(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_call public.calls;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if nullif(btrim(p_worker), '') is null then raise exception 'worker_required' using errcode = '22023'; end if;

  update public.calls c set
    provider_termination_state = 'external_evidence_required',
    provider_termination_last_error = coalesce(c.provider_termination_last_error, 'provider_termination_attempt_expired'),
    provider_termination_reconcile_lease_until = null,
    provider_termination_reconcile_worker = null
  where c.phone_event_id is null
    and c.provider_termination_attempt_id is not null
    and c.provider_termination_state in ('pending','unknown')
    and c.provider_termination_reconcile_lease_until <= clock_timestamp();

  select c.* into v_call
  from public.calls c
  where c.phone_event_id is null
    and c.status <> 'active'
    and c.provider_termination_state = 'active'
    and c.provider_termination_attempt_id is null
    and c.provider_termination_mode in ('reject','hangup')
    and c.provider_termination_reconcile_after <= clock_timestamp()
    and (c.provider_termination_reconcile_lease_until is null or c.provider_termination_reconcile_lease_until <= clock_timestamp())
  order by c.started_at, c.id
  for update of c skip locked
  limit 1;
  if v_call.id is null then return null; end if;
  update public.calls c set
    provider_termination_reconcile_attempts = c.provider_termination_reconcile_attempts + 1,
    provider_termination_reconcile_lease_until = clock_timestamp() + interval '15 seconds',
    provider_termination_reconcile_worker = left(p_worker, 100)
  where c.id = v_call.id;
  return jsonb_build_object(
    'call_id', v_call.id,
    'openai_call_id', v_call.openai_call_id,
    'provider_termination_mode', v_call.provider_termination_mode,
    'provider_termination_reason', v_call.provider_termination_reason
  );
end;
$$;

create or replace function public.begin_phone_termination(
  p_event_id uuid,
  p_claim_token uuid,
  p_mode text,
  p_reason text,
  p_accept_state text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_attempt uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null or p_mode is null or p_mode not in ('reject','hangup')
    or nullif(btrim(p_reason), '') is null
    or (p_accept_state is not null and p_accept_state not in ('not_attempted','attempting','accepted','failed','unknown')) then
    raise exception 'phone_termination_arguments_invalid' using errcode = '22023';
  end if;
  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;
  if v_event.provider_termination_attempt_id is not null
    or v_event.provider_termination_state in ('pending','unknown','confirmed','external_evidence_required') then
    return jsonb_build_object('should_attempt', false);
  end if;
  update public.phone_events p set
    provider_accept_state = coalesce(p_accept_state, p.provider_accept_state),
    provider_termination_state = 'pending', provider_termination_mode = p_mode,
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    lifecycle_last_error = left(p_reason, 400),
    sideband_state = case when p.sideband_state in ('attaching','attached') then 'failed' else p.sideband_state end,
    lifecycle_updated_at = clock_timestamp(),
    lifecycle_reconcile_after = clock_timestamp() + interval '15 seconds',
    lifecycle_reconcile_lease_until = clock_timestamp() + interval '15 seconds'
  where p.id = v_event.id;
  update public.calls c set
    status = 'error', ended_at = coalesce(c.ended_at, clock_timestamp()),
    provider_termination_state = 'pending', provider_termination_mode = p_mode,
    provider_termination_reason = left(p_reason, 400), provider_usage_state = 'unknown',
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    provider_termination_reconcile_after = clock_timestamp() + interval '15 seconds',
    provider_termination_reconcile_lease_until = clock_timestamp() + interval '15 seconds'
  where c.id = v_event.call_id;
  return jsonb_build_object(
    'should_attempt', true,
    'attempt_id', v_attempt,
    'request_id', v_attempt::text,
    'openai_call_id', v_event.openai_call_id,
    'provider_termination_mode', p_mode
  );
end;
$$;

create or replace function public.complete_phone_termination(
  p_event_id uuid,
  p_claim_token uuid,
  p_confirmed boolean,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_rejected boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null or p_confirmed is null then
    raise exception 'phone_termination_arguments_invalid' using errcode = '22023';
  end if;
  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;

  if v_event.lifecycle_state = 'rejected'
    and v_event.provider_termination_state = 'confirmed'
    and v_event.provider_termination_mode = 'reject'
    and v_event.provider_accept_state in ('not_attempted','failed')
    and p_confirmed then
    update public.calls c set provider_usage_state = 'not_applicable'
    where c.id = v_event.call_id and c.provider_usage_state = 'unknown';
    update public.phone_events p set
      lifecycle_reconcile_lease_until = null, lifecycle_reconcile_worker = null,
      lifecycle_updated_at = clock_timestamp(), lifecycle_reconcile_after = clock_timestamp() + interval '100 years'
    where p.id = v_event.id;
    return true;
  end if;

  if v_event.provider_termination_attempt_id is null or v_event.provider_termination_state <> 'pending' then return false; end if;
  v_rejected := p_confirmed and v_event.provider_termination_mode = 'reject'
    and v_event.provider_accept_state in ('not_attempted','failed');
  update public.phone_events p set
    status = case when v_rejected then 'rejected' else 'error' end,
    lifecycle_state = case
      when not p_confirmed then 'external_evidence_required'
      when v_rejected then 'rejected'
      else 'terminated'
    end,
    provider_termination_state = case when p_confirmed then 'confirmed' else 'external_evidence_required' end,
    provider_terminated_at = case when p_confirmed then clock_timestamp() else p.provider_terminated_at end,
    lifecycle_last_error = left(coalesce(p_error, p.lifecycle_last_error), 400),
    lifecycle_updated_at = clock_timestamp(),
    lifecycle_reconcile_after = clock_timestamp() + case when p_confirmed and v_rejected then interval '5 seconds' else interval '100 years' end,
    lifecycle_reconcile_lease_until = null,
    lifecycle_reconcile_worker = null,
    sideband_lease_until = null
  where p.id = v_event.id;
  update public.calls c set
    provider_termination_state = case when p_confirmed then 'confirmed' else 'external_evidence_required' end,
    provider_termination_last_error = case when p_confirmed then null else left(coalesce(p_error, 'provider_termination_external_evidence_required'), 400) end,
    provider_terminated_at = case when p_confirmed then clock_timestamp() else c.provider_terminated_at end,
    provider_termination_reconcile_after = clock_timestamp() + interval '100 years',
    provider_termination_reconcile_lease_until = null,
    provider_termination_reconcile_worker = null
  where c.id = v_event.call_id;
  return true;
end;
$$;

create or replace function public.begin_phone_sideband(p_event_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_event public.phone_events;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null then raise exception 'phone_sideband_arguments_invalid' using errcode = '22023'; end if;
  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;
  if v_event.lifecycle_state <> 'accepted' or v_event.provider_termination_attempt_id is not null then
    raise exception 'phone_lifecycle_transition_invalid' using errcode = '55000';
  end if;
  update public.phone_events p set
    lifecycle_state = 'sideband_attaching', sideband_state = 'attaching',
    sideband_lease_until = clock_timestamp() + interval '15 seconds',
    lifecycle_updated_at = clock_timestamp(), lifecycle_reconcile_after = clock_timestamp() + interval '15 seconds'
  where p.id = v_event.id;
  return true;
end;
$$;

create or replace function public.confirm_phone_sideband(p_event_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_event public.phone_events;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null then raise exception 'phone_sideband_arguments_invalid' using errcode = '22023'; end if;
  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;
  if v_event.lifecycle_state <> 'sideband_attaching'
    or v_event.sideband_lease_until is null or v_event.sideband_lease_until <= clock_timestamp()
    or v_event.provider_termination_attempt_id is not null then return false; end if;
  update public.phone_events p set
    lifecycle_state = 'active', sideband_state = 'attached',
    sideband_attached_at = coalesce(p.sideband_attached_at, clock_timestamp()),
    sideband_heartbeat_at = clock_timestamp(),
    sideband_lease_until = clock_timestamp() + interval '15 seconds',
    lifecycle_updated_at = clock_timestamp(), lifecycle_reconcile_after = clock_timestamp() + interval '15 seconds',
    lifecycle_reconcile_lease_until = null, lifecycle_reconcile_worker = null
  where p.id = v_event.id;
  return true;
end;
$$;

create or replace function public.heartbeat_phone_sideband(p_event_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null then raise exception 'phone_sideband_arguments_invalid' using errcode = '22023'; end if;
  update public.phone_events p set
    sideband_heartbeat_at = clock_timestamp(),
    sideband_lease_until = clock_timestamp() + interval '15 seconds',
    lifecycle_updated_at = clock_timestamp(), lifecycle_reconcile_after = clock_timestamp() + interval '15 seconds'
  where p.id = p_event_id
    and p.lifecycle_claim_token = p_claim_token
    and nullif(btrim(p.lifecycle_owner), '') is not null
    and p.lifecycle_state = 'active' and p.sideband_state = 'attached'
    and p.provider_termination_attempt_id is null
    and p.provider_termination_state = 'active';
  return found;
end;
$$;

create or replace function public.finalize_phone_sideband(
  p_event_id uuid,
  p_claim_token uuid,
  p_terminal jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_status text;
  v_usage_state text;
  v_duration integer;
  v_cost numeric;
  v_attempt uuid := gen_random_uuid();
  v_needs_termination boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null or p_terminal is null or jsonb_typeof(p_terminal) <> 'object' then
    raise exception 'phone_sideband_terminal_invalid' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_terminal)) <> 9
    or not p_terminal ?& array[
      'status','duration_seconds','transcript','usage_tokens','cost_estimate_usd',
      'provider_usage_state','provider_usage_evidence','outcome','detail'
    ] then raise exception 'phone_sideband_terminal_invalid' using errcode = '22023'; end if;
  v_status := p_terminal->>'status';
  v_usage_state := p_terminal->>'provider_usage_state';
  if v_status not in ('ended','killed_deadline','killed_budget','error')
    or v_usage_state not in ('resolved','unknown')
    or jsonb_typeof(p_terminal->'duration_seconds') <> 'number'
    or jsonb_typeof(p_terminal->'transcript') <> 'array'
    or jsonb_typeof(p_terminal->'detail') <> 'object' then
    raise exception 'phone_sideband_terminal_invalid' using errcode = '22023';
  end if;
  v_duration := (p_terminal->>'duration_seconds')::integer;
  if v_duration < 0 then raise exception 'phone_sideband_terminal_invalid' using errcode = '22023'; end if;
  v_cost := case when p_terminal->'cost_estimate_usd' = 'null'::jsonb then null else (p_terminal->>'cost_estimate_usd')::numeric end;
  if v_cost is not null and v_cost < 0 then raise exception 'phone_sideband_terminal_invalid' using errcode = '22023'; end if;

  select p.* into v_event from public.phone_events p where p.id = p_event_id for update;
  if v_event.id is null then raise exception 'phone_event_not_found' using errcode = 'P0002'; end if;
  if v_event.lifecycle_claim_token is distinct from p_claim_token or nullif(btrim(v_event.lifecycle_owner), '') is null then
    raise exception 'phone_claim_lost' using errcode = '42501';
  end if;
  if v_event.lifecycle_state not in ('active','sideband_attaching') then return jsonb_build_object('should_attempt', false); end if;

  update public.calls c set
    status = v_status,
    ended_at = coalesce(c.ended_at, clock_timestamp()),
    duration_seconds = v_duration,
    transcript = p_terminal->'transcript',
    usage_tokens = case when p_terminal->'usage_tokens' = 'null'::jsonb then null else p_terminal->'usage_tokens' end,
    cost_estimate_usd = v_cost,
    summary_status = 'pending_ingest',
    provider_usage_state = v_usage_state,
    provider_usage_evidence = case when p_terminal->'provider_usage_evidence' = 'null'::jsonb then null else p_terminal->'provider_usage_evidence' end
  where c.id = v_event.call_id;
  if not found then raise exception 'phone_call_not_found' using errcode = 'P0002'; end if;

  v_needs_termination := v_status <> 'ended';
  if not v_needs_termination then
    update public.phone_events p set
      status = 'accepted', lifecycle_state = 'terminated', sideband_state = 'closed',
      sideband_lease_until = null, lifecycle_updated_at = clock_timestamp(),
      provider_termination_state = 'confirmed', provider_termination_mode = 'hangup',
      provider_terminated_at = coalesce(p.provider_terminated_at, clock_timestamp()),
      lifecycle_reconcile_after = clock_timestamp() + interval '100 years',
      lifecycle_reconcile_lease_until = null, lifecycle_reconcile_worker = null
    where p.id = v_event.id;
    update public.calls c set
      provider_termination_state = 'confirmed', provider_termination_mode = 'hangup',
      provider_termination_reason = 'caller_hung_up',
      provider_terminated_at = coalesce(c.provider_terminated_at, clock_timestamp())
    where c.id = v_event.call_id;
    update public.budget_reservations br set
      reconcile_after = clock_timestamp(), reconcile_lease_until = null
    where br.call_id = v_event.call_id and br.status = 'active';
    return jsonb_build_object('should_attempt', false);
  end if;

  if v_event.provider_termination_attempt_id is not null
    or v_event.provider_termination_state in ('pending','unknown','external_evidence_required') then
    update public.phone_events p set
      status = 'error', lifecycle_state = 'external_evidence_required', sideband_state = 'failed',
      sideband_lease_until = null, lifecycle_updated_at = clock_timestamp(),
      provider_termination_state = 'external_evidence_required',
      lifecycle_reconcile_after = clock_timestamp() + interval '100 years'
    where p.id = v_event.id;
    update public.budget_reservations br set reconcile_after = clock_timestamp(), reconcile_lease_until = null
    where br.call_id = v_event.call_id and br.status = 'active';
    return jsonb_build_object('should_attempt', false);
  end if;

  update public.phone_events p set
    status = 'error', lifecycle_state = 'reconciliation_required', sideband_state = 'failed',
    sideband_lease_until = null, lifecycle_updated_at = clock_timestamp(),
    provider_termination_state = 'pending', provider_termination_mode = 'hangup',
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    lifecycle_last_error = 'sideband_' || v_status,
    lifecycle_reconcile_after = clock_timestamp() + interval '15 seconds',
    lifecycle_reconcile_lease_until = clock_timestamp() + interval '15 seconds'
  where p.id = v_event.id;
  update public.calls c set
    provider_termination_state = 'pending', provider_termination_mode = 'hangup',
    provider_termination_reason = 'sideband_' || v_status,
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    provider_termination_reconcile_after = clock_timestamp() + interval '15 seconds',
    provider_termination_reconcile_lease_until = clock_timestamp() + interval '15 seconds'
  where c.id = v_event.call_id;
  update public.budget_reservations br set reconcile_after = clock_timestamp(), reconcile_lease_until = null
  where br.call_id = v_event.call_id and br.status = 'active';
  return jsonb_build_object(
    'should_attempt', true,
    'attempt_id', v_attempt,
    'request_id', v_attempt::text,
    'openai_call_id', v_event.openai_call_id,
    'provider_termination_mode', 'hangup'
  );
end;
$$;

create or replace function public.defer_phone_sideband_finalization(
  p_event_id uuid,
  p_claim_token uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_event_id is null or p_claim_token is null or nullif(btrim(p_error), '') is null then
    raise exception 'phone_sideband_defer_invalid' using errcode = '22023';
  end if;
  update public.phone_events p set
    status = 'error',
    lifecycle_state = case when p.provider_termination_attempt_id is null then 'reconciliation_required' else 'external_evidence_required' end,
    provider_termination_state = case when p.provider_termination_attempt_id is null then p.provider_termination_state else 'external_evidence_required' end,
    sideband_state = 'failed',
    lifecycle_last_error = left(p_error, 400),
    sideband_lease_until = null,
    lifecycle_updated_at = clock_timestamp(),
    lifecycle_reconcile_after = case when p.provider_termination_attempt_id is null then clock_timestamp() else clock_timestamp() + interval '100 years' end,
    lifecycle_reconcile_lease_until = null,
    lifecycle_reconcile_worker = null
  where p.id = p_event_id and p.lifecycle_claim_token = p_claim_token
    and nullif(btrim(p.lifecycle_owner), '') is not null
    and p.lifecycle_state in ('active','sideband_attaching','reconciliation_required');
  return found;
end;
$$;

create or replace function public.claim_phone_lifecycle_reconciliation(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.phone_events;
  v_claim uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_action text;
  v_mode text;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if nullif(btrim(p_worker), '') is null then raise exception 'worker_required' using errcode = '22023'; end if;

  update public.phone_events p set
    status = 'error', lifecycle_state = 'external_evidence_required',
    provider_termination_state = 'external_evidence_required',
    lifecycle_last_error = coalesce(p.lifecycle_last_error, 'provider_termination_attempt_expired'),
    lifecycle_reconcile_lease_until = null, lifecycle_reconcile_worker = null,
    sideband_lease_until = null
  where p.provider_termination_attempt_id is not null
    and p.provider_termination_state in ('pending','unknown')
    and p.lifecycle_reconcile_lease_until <= clock_timestamp();
  update public.calls c set
    provider_termination_state = 'external_evidence_required',
    provider_termination_last_error = coalesce(c.provider_termination_last_error, 'provider_termination_attempt_expired'),
    provider_termination_reconcile_lease_until = null, provider_termination_reconcile_worker = null
  where c.phone_event_id in (
    select p.id from public.phone_events p where p.provider_termination_state = 'external_evidence_required'
  ) and c.provider_termination_attempt_id is not null
    and c.provider_termination_state in ('pending','unknown');

  select p.* into v_event
  from public.phone_events p
  where (p.lifecycle_reconcile_lease_until is null or p.lifecycle_reconcile_lease_until <= clock_timestamp())
    and (
      (
        p.lifecycle_state = 'rejected'
        and p.provider_accept_state in ('not_attempted','failed')
        and p.provider_termination_state = 'confirmed'
        and p.call_id is not null
        and exists (
          select 1 from public.calls c
          join public.budget_reservations br on br.call_id = c.id and br.status = 'active'
          where c.id = p.call_id and c.provider_usage_state = 'unknown'
        )
      )
      or (
        p.provider_termination_attempt_id is null
        and p.provider_termination_state in ('active','not_required')
        and (
          (p.lifecycle_state in ('active','sideband_attaching')
            and p.sideband_lease_until is not null and p.sideband_lease_until <= clock_timestamp())
          or
          (p.lifecycle_state in ('claimed','call_persisted','budget_reserved','accepting','accepted','reconciliation_required')
            and p.lifecycle_reconcile_after <= clock_timestamp())
        )
      )
    )
  order by p.created_at, p.id
  for update of p skip locked
  limit 1;
  if v_event.id is null then return null; end if;

  v_action := case when v_event.lifecycle_state = 'rejected' and v_event.provider_termination_state = 'confirmed'
    then 'resolve_not_applicable' else 'terminate' end;
  if v_action = 'resolve_not_applicable' then
    update public.phone_events p set
      lifecycle_owner = left(p_worker, 100), lifecycle_claim_token = v_claim,
      lifecycle_reconcile_attempts = p.lifecycle_reconcile_attempts + 1,
      lifecycle_reconcile_lease_until = clock_timestamp() + interval '15 seconds',
      lifecycle_reconcile_worker = left(p_worker, 100)
    where p.id = v_event.id;
    return jsonb_build_object('event_id', v_event.id, 'claim_token', v_claim, 'action', v_action);
  end if;

  v_mode := case when v_event.provider_accept_state in ('attempting','accepted','unknown') then 'hangup' else 'reject' end;
  update public.phone_events p set
    lifecycle_owner = left(p_worker, 100), lifecycle_claim_token = v_claim,
    lifecycle_reconcile_attempts = p.lifecycle_reconcile_attempts + 1,
    lifecycle_reconcile_lease_until = clock_timestamp() + interval '15 seconds',
    lifecycle_reconcile_worker = left(p_worker, 100),
    lifecycle_updated_at = clock_timestamp(), lifecycle_state = 'reconciliation_required', status = 'error',
    provider_termination_state = 'pending', provider_termination_mode = v_mode,
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    sideband_state = case when p.sideband_state in ('attaching','attached') then 'failed' else p.sideband_state end,
    sideband_lease_until = null
  where p.id = v_event.id;
  update public.calls c set
    status = 'error', ended_at = coalesce(c.ended_at, clock_timestamp()),
    provider_termination_state = 'pending', provider_termination_mode = v_mode,
    provider_termination_reason = 'phone_lifecycle_reconciliation', provider_usage_state = 'unknown',
    provider_termination_attempt_id = v_attempt,
    provider_termination_request_id = v_attempt::text,
    provider_termination_attempted_at = clock_timestamp(),
    provider_termination_reconcile_after = clock_timestamp() + interval '15 seconds',
    provider_termination_reconcile_lease_until = clock_timestamp() + interval '15 seconds'
  where c.id = v_event.call_id;
  return jsonb_build_object(
    'event_id', v_event.id,
    'claim_token', v_claim,
    'action', v_action,
    'attempt_id', v_attempt,
    'request_id', v_attempt::text,
    'openai_call_id', v_event.openai_call_id,
    'provider_termination_mode', v_mode
  );
end;
$$;

create or replace function public.purge_ephemeral_call_data(
  p_transcript_before timestamptz,
  p_transient_before timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_transcripts integer := 0;
  v_browser_rows integer := 0;
  v_phone_rows integer := 0;
  v_oauth_states integer := 0;
  v_slot_offers integer := 0;
  v_booking_quotes integer := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_transcript_before is null or p_transient_before is null
    or p_transcript_before > v_now or p_transient_before > v_now then
    raise exception using errcode = '22023', message = 'retention_cutoff_invalid';
  end if;
  update public.calls c set transcript = '[]'::jsonb, transcript_deleted_at = v_now
  where c.ended_at is not null and c.ended_at < p_transcript_before
    and c.transcript <> '[]'::jsonb and c.summary_status in ('ready', 'failed')
    and c.learning_status in ('done', 'skipped', 'failed');
  get diagnostics v_transcripts = row_count;
  delete from public.browser_session_requests b
  where b.created_at < p_transient_before and b.status in ('ready', 'error', 'expired');
  get diagnostics v_browser_rows = row_count;
  delete from public.phone_events p
  where p.created_at < p_transient_before and p.handled_at is not null
    and p.status in ('accepted', 'rejected', 'error')
    and p.lifecycle_state in ('active', 'rejected', 'terminated')
    and (
      (
        p.call_id is null
        and not exists (
          select 1 from public.calls orphan
          where orphan.openai_call_id = p.openai_call_id
        )
      )
      or exists (
        select 1 from public.calls c
        where c.id = p.call_id
          and c.status <> 'active'
          and c.provider_termination_state in ('confirmed','not_required')
      )
    );
  get diagnostics v_phone_rows = row_count;
  delete from public.oauth_states o where o.expires_at < p_transient_before;
  get diagnostics v_oauth_states = row_count;
  delete from public.slot_offers s where s.expires_at < p_transient_before;
  get diagnostics v_slot_offers = row_count;
  delete from public.booking_quotes q
  where q.expires_at < p_transient_before
    and not exists (select 1 from public.slot_offers s where s.quote_id = q.id);
  get diagnostics v_booking_quotes = row_count;
  return jsonb_build_object(
    'transcripts_redacted', v_transcripts, 'browser_rows_deleted', v_browser_rows,
    'phone_rows_deleted', v_phone_rows, 'oauth_states_deleted', v_oauth_states,
    'slot_offers_deleted', v_slot_offers, 'booking_quotes_deleted', v_booking_quotes,
    'completed_at', v_now
  );
end;
$$;

revoke all on table public.phone_lifecycle_legacy_conflicts from public, anon, authenticated, service_role;
grant select, insert, update on table public.phone_lifecycle_legacy_conflicts to service_role;

revoke all on function public.begin_provider_termination_attempt(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.begin_provider_termination_attempt(uuid,text,text,text) to service_role;
revoke all on function public.complete_provider_termination_attempt(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.complete_provider_termination_attempt(uuid,uuid,boolean,text) to service_role;
revoke all on function public.begin_phone_termination(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.begin_phone_termination(uuid,uuid,text,text,text) to service_role;
revoke all on function public.complete_phone_termination(uuid,uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.complete_phone_termination(uuid,uuid,boolean,text) to service_role;
revoke all on function public.begin_phone_sideband(uuid,uuid) from public, anon, authenticated;
grant execute on function public.begin_phone_sideband(uuid,uuid) to service_role;
revoke all on function public.confirm_phone_sideband(uuid,uuid) from public, anon, authenticated;
grant execute on function public.confirm_phone_sideband(uuid,uuid) to service_role;
revoke all on function public.heartbeat_phone_sideband(uuid,uuid) from public, anon, authenticated;
grant execute on function public.heartbeat_phone_sideband(uuid,uuid) to service_role;
revoke all on function public.finalize_phone_sideband(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.finalize_phone_sideband(uuid,uuid,jsonb) to service_role;
revoke all on function public.defer_phone_sideband_finalization(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.defer_phone_sideband_finalization(uuid,uuid,text) to service_role;
revoke all on function public.claim_phone_lifecycle_reconciliation(text) from public, anon, authenticated;
grant execute on function public.claim_phone_lifecycle_reconciliation(text) to service_role;
revoke all on function public.claim_provider_termination_reconciliation(text) from public, anon, authenticated;
grant execute on function public.claim_provider_termination_reconciliation(text) to service_role;
revoke all on function public.repair_legacy_phone_links() from public, anon, authenticated;
grant execute on function public.repair_legacy_phone_links() to service_role;
revoke all on function public.purge_ephemeral_call_data(timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.purge_ephemeral_call_data(timestamptz,timestamptz) to service_role;
