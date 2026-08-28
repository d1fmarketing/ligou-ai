-- Task 2: make the session duration used by budget enforcement durable, and
-- initialize one resumable onboarding checkpoint without rewriting its source.

alter table public.budget_reservations
  add column if not exists reserved_minutes numeric;

update public.budget_reservations br
set reserved_minutes = case
  when c.session_type = 'onboarding' then 30::numeric
  else greatest(coalesce(t.session_max_minutes, 15), 1)::numeric
end
from public.calls c
join public.tenants t on t.id = c.tenant_id
where c.id = br.call_id
  and c.tenant_id = br.tenant_id
  and br.reserved_minutes is null;

do $$
begin
  if exists (
    select 1 from public.budget_reservations br
    where br.reserved_minutes is null or br.reserved_minutes <= 0
  ) then
    raise exception using errcode = '55000',
      message = 'budget_reserved_minutes_backfill_incomplete';
  end if;
end
$$;

alter table public.budget_reservations
  drop constraint if exists budget_reservations_reserved_minutes_check;
alter table public.budget_reservations
  add constraint budget_reservations_reserved_minutes_check
    check (reserved_minutes > 0) not valid;
alter table public.budget_reservations
  validate constraint budget_reservations_reserved_minutes_check;
alter table public.budget_reservations
  alter column reserved_minutes set not null;

create or replace function public.reserve_call_budget(
  p_tenant uuid,
  p_call uuid,
  p_est_cost numeric,
  p_reserved_minutes numeric
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
  if v_budget is null then
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
  if v_spent + p_est_cost > v_budget then
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
$$;

create or replace function public.reserve_call_budget(
  p_tenant uuid,
  p_call uuid,
  p_est_cost numeric
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reserved_minutes numeric;
begin
  select case
      when c.session_type = 'onboarding' then 30::numeric
      else greatest(coalesce(t.session_max_minutes, 15), 1)::numeric
    end
    into v_reserved_minutes
  from public.calls c
  join public.tenants t on t.id = c.tenant_id
  where c.id = p_call and c.tenant_id = p_tenant;
  if v_reserved_minutes is null then
    raise exception using errcode = '23503', message = 'call_tenant_mismatch';
  end if;
  return public.reserve_call_budget(
    p_tenant, p_call, p_est_cost, v_reserved_minutes
  );
end;
$$;

revoke all on function public.reserve_call_budget(uuid,uuid,numeric,numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_call_budget(uuid,uuid,numeric,numeric)
  to service_role;
revoke all on function public.reserve_call_budget(uuid,uuid,numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_call_budget(uuid,uuid,numeric)
  to service_role;

create or replace function public.claim_budget_reconciliation(p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.budget_reservations;
  v_call public.calls;
  v_outcome text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select br.* into v_reservation
  from public.budget_reservations br
  join public.calls c on c.id = br.call_id and c.tenant_id = br.tenant_id
  where br.status = 'active'
    and c.status <> 'active'
    and br.reconcile_after <= now()
    and (br.reconcile_lease_until is null or br.reconcile_lease_until < now())
  order by br.created_at
  for update of br skip locked
  limit 1;
  if v_reservation.id is null then return null; end if;

  update public.budget_reservations br set
    reconcile_attempts = br.reconcile_attempts + 1,
    reconcile_lease_until = now() + interval '30 seconds',
    reconcile_last_error = null
  where br.id = v_reservation.id;

  select c.* into v_call
  from public.calls c where c.id = v_reservation.call_id;
  v_outcome := case
    when v_call.status = 'ended' then 'ended'
    when v_call.status = 'killed_deadline' then 'killed_deadline'
    when v_call.status = 'killed_budget' then 'killed_budget'
    when v_call.status = 'error' then 'error'
    else 'startup_error'
  end;

  return jsonb_build_object(
    'reservation_id', v_reservation.id,
    'tenant_id', v_reservation.tenant_id,
    'call_id', v_reservation.call_id,
    'actual_cost_usd', coalesce(v_call.cost_estimate_usd, 0),
    'minutes', coalesce(v_call.duration_seconds, 0)::numeric / 60,
    'outcome', v_outcome,
    'reconcile_attempts', coalesce(v_reservation.reconcile_attempts, 0) + 1,
    'reserved_cost_usd', v_reservation.reserved_cost_usd,
    'reserved_minutes', v_reservation.reserved_minutes,
    'provider_termination_state', v_call.provider_termination_state,
    'provider_termination_mode', v_call.provider_termination_mode,
    'provider_termination_reason', v_call.provider_termination_reason,
    'provider_terminated_at', v_call.provider_terminated_at,
    'provider_termination_attempted_at',
      v_call.provider_termination_attempted_at,
    'provider_termination_attempt_id', v_call.provider_termination_attempt_id,
    'provider_usage_state', v_call.provider_usage_state,
    'openai_call_id', v_call.openai_call_id
  );
end;
$$;

revoke all on function public.claim_budget_reconciliation(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_budget_reconciliation(text)
  to service_role;

create table public.onboarding_resume_consumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  source_call_id uuid not null unique
    references public.calls (id) on delete restrict,
  source_receipt_id uuid not null unique
    references public.receipts (id) on delete restrict,
  target_call_id uuid not null unique
    references public.calls (id) on delete restrict,
  target_receipt_id uuid not null unique
    references public.receipts (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint onboarding_resume_distinct_calls_check
    check (source_call_id <> target_call_id)
);

create index onboarding_resume_consumptions_tenant_created_idx
  on public.onboarding_resume_consumptions (tenant_id, created_at desc);

alter table public.onboarding_resume_consumptions enable row level security;
alter table public.onboarding_resume_consumptions force row level security;
revoke all on table public.onboarding_resume_consumptions
  from public, anon, authenticated, service_role;

alter table public.receipts
  drop constraint if exists receipts_onboarding_shape_check;
alter table public.receipts add constraint receipts_onboarding_shape_check check (
  kind not in (
    'onboarding_coverage',
    'onboarding_voice_approval',
    'onboarding_event_alias'
  )
  or (
    outcome = 'accepted'
    and call_id is not null
    and coalesce(external_id ~ '^[0-9a-f]{64}$', false)
    and coalesce(payload_hash ~ '^[0-9a-f]{64}$', false)
    and jsonb_typeof(readback) = 'object'
    and coalesce(readback->>'call_id' = call_id::text, false)
    and readback->'authority' is not distinct from jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
    and (
      kind <> 'onboarding_coverage'
      or (
        coalesce(readback->>'revision' ~ '^[1-9][0-9]*$', false)
        and jsonb_typeof(readback->'complete') = 'boolean'
        and coalesce(readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$', false)
        and (
          (
            readback->'schema_version' is not distinct from '1'::jsonb
            and coalesce(detail->>'answer_hash' ~ '^[0-9a-f]{64}$', false)
          )
          or (
            readback->'schema_version' is not distinct from '2'::jsonb
            and coalesce(readback->>'transition_kind', '') in (
              'answer', 'directed_followup', 'resume_checkpoint'
            )
            and jsonb_typeof(readback->'snapshot') = 'object'
            and jsonb_typeof(readback->'progress') = 'object'
            and jsonb_typeof(readback->'selected_rule_ids') = 'array'
            and jsonb_typeof(readback->'current_answer_hashes') = 'object'
            and jsonb_typeof(readback->'materializations') = 'array'
            and (
              (
                (readback->>'complete')::boolean = false
                and readback->'summary_projection' = 'null'::jsonb
                and readback->'summary_hash' = 'null'::jsonb
              )
              or (
                (readback->>'complete')::boolean = true
                and jsonb_typeof(readback->'summary_projection') = 'object'
                and coalesce(
                  readback->>'summary_hash' ~ '^[0-9a-f]{64}$', false
                )
                and readback->>'summary_hash' =
                  readback->'summary_projection'->>'summaryHash'
              )
            )
            and (
              (
                readback->>'transition_kind' = 'answer'
                and coalesce(detail->>'answer_hash' ~ '^[0-9a-f]{64}$', false)
                and coalesce(detail->>'coverage_key', '') <> ''
              )
              or (
                readback->>'transition_kind' = 'directed_followup'
                and detail->>'transition_kind' = 'directed_followup'
                and coalesce(
                  detail->>'source_revision' ~ '^[1-9][0-9]*$', false
                )
                and coalesce(detail->>'field', '') <> ''
                and (
                  not (detail ? 'transition_schema')
                  or (
                    detail->'transition_schema' is not distinct from '2'::jsonb
                    and coalesce(
                      detail->>'source_digest' ~ '^[0-9a-f]{64}$', false
                    )
                    and coalesce(detail->>'question_pt', '') <> ''
                  )
                )
              )
              or (
                readback->>'transition_kind' = 'resume_checkpoint'
                and readback->>'revision' = '1'
                and detail->>'transition_kind' = 'resume_checkpoint'
                and detail->'transition_schema' is not distinct from '2'::jsonb
                and coalesce(
                  detail->>'source_revision' ~ '^[1-9][0-9]*$', false
                )
                and coalesce(
                  detail->>'source_digest' ~ '^[0-9a-f]{64}$', false
                )
                and coalesce(
                  detail->>'source_call_id' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  false
                )
                and coalesce(
                  detail->>'source_receipt_id' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  false
                )
                and jsonb_typeof(readback->'resume_context') = 'object'
                and readback->'resume_context'->>'source_call_id' =
                  detail->>'source_call_id'
                and readback->'resume_context'->>'source_receipt_id' =
                  detail->>'source_receipt_id'
                and readback->'resume_context'->>'source_revision' =
                  detail->>'source_revision'
                and readback->'resume_context'->>'source_snapshot_digest' =
                  detail->>'source_digest'
                and jsonb_array_length(readback->'selected_rule_ids') = 0
                and jsonb_array_length(readback->'materializations') = 0
              )
            )
          )
        )
      )
    )
    and (
      kind <> 'onboarding_voice_approval'
      or (
        readback->'schema_version' is not distinct from '1'::jsonb
        and coalesce(
          readback->>'snapshot_receipt_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        and coalesce(readback->>'snapshot_revision' ~ '^[1-9][0-9]*$', false)
        and coalesce(readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$', false)
        and coalesce(
          detail->>'owner_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
      )
    )
    and (
      kind <> 'onboarding_event_alias'
      or (
        readback->'schema_version' is not distinct from '2'::jsonb
        and readback->>'target_kind' in (
          'onboarding_coverage', 'onboarding_voice_approval'
        )
        and coalesce(
          readback->>'target_receipt_id' ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          false
        )
        and coalesce(readback->>'target_revision' ~ '^[1-9][0-9]*$', false)
        and coalesce(readback->>'target_digest' ~ '^[0-9a-f]{64}$', false)
        and coalesce(
          detail->>'target_receipt_id' = readback->>'target_receipt_id', false
        )
        and (
          readback->>'target_kind' = 'onboarding_coverage'
          or (
            readback->>'target_kind' = 'onboarding_voice_approval'
            and readback->>'approval_receipt_id' =
              readback->>'target_receipt_id'
            and coalesce(
              readback->>'snapshot_receipt_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
              false
            )
            and readback->>'snapshot_revision' =
              readback->>'target_revision'
            and readback->>'snapshot_digest' = readback->>'target_digest'
            and coalesce(
              detail->>'owner_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
              false
            )
            and coalesce(detail->>'provider_tool_call_id', '') <> ''
            and coalesce(detail->>'owner_words', '') <> ''
          )
        )
      )
    )
  )
) not valid;
alter table public.receipts
  validate constraint receipts_onboarding_shape_check;

create or replace function public.initialize_onboarding_resume(
  p_tenant uuid,
  p_target_call uuid,
  p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.calls;
  v_target_request_id uuid;
  v_source public.calls;
  v_reservation public.budget_reservations;
  v_source_receipt public.receipts;
  v_target_receipt public.receipts;
  v_consumption public.onboarding_resume_consumptions;
  v_source_revision integer;
  v_source_digest text;
  v_source_readback_digest text;
  v_snapshot jsonb;
  v_readback jsonb;
  v_snapshot_digest text;
  v_payload jsonb;
  v_payload_hash text;
  v_external_id text;
begin
  if p_tenant is null or p_target_call is null or p_owner is null then
    raise exception using errcode = '22023',
      message = 'onboarding_resume_scope_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.onboarding_resume:' || p_tenant::text,
    0
  ));

  perform 1
  from public.tenants t
  where t.id = p_tenant
    and t.owner_user_id = p_owner
    and t.status = 'onboarding'
    and t.operational_mode = 'simulation_only'
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'onboarding_resume_not_owner_bound';
  end if;

  select oc.* into v_consumption
  from public.onboarding_resume_consumptions oc
  join public.receipts r
    on r.id = oc.target_receipt_id
   and r.tenant_id = oc.tenant_id
   and r.call_id = oc.target_call_id
   and r.kind = 'onboarding_coverage'
  where oc.tenant_id = p_tenant
    and oc.owner_user_id = p_owner
    and oc.target_call_id = p_target_call
  for update of oc;
  if v_consumption.id is not null then
    select r.* into v_target_receipt
    from public.receipts r
    where r.id = v_consumption.target_receipt_id
      and r.tenant_id = p_tenant
      and r.call_id = p_target_call
      and r.kind = 'onboarding_coverage';
    if v_target_receipt.readback->>'transition_kind' <>
         'resume_checkpoint'
       or v_target_receipt.readback->>'revision' <> '1'
       or v_target_receipt.readback->>'source_call_id' is not null
       or v_target_receipt.readback->'resume_context'->>'source_call_id' <>
         v_consumption.source_call_id::text
       or v_target_receipt.readback->'resume_context'->>'source_receipt_id' <>
         v_consumption.source_receipt_id::text then
      raise exception using errcode = '55000',
        message = 'onboarding_resume_checkpoint_corrupt';
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'source_call_id', v_consumption.source_call_id,
      'source_receipt_id', v_consumption.source_receipt_id,
      'coverage_receipt_id', v_target_receipt.id,
      'revision', 1,
      'snapshot_digest', v_target_receipt.readback->>'snapshot_digest',
      'next_action', v_target_receipt.readback->'next_action',
      'coverage', v_target_receipt.readback
    );
  end if;

  select c.* into v_target
  from public.calls c
  join public.browser_session_requests br
    on br.tenant_id = c.tenant_id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
   and br.status = 'processing'
   and br.opening_mode_requested = 'application_tts_v1'
   and br.opening_mode_applied is null
   and br.opening_payload is null
   and br.answer_sdp is null
  where c.id = p_target_call
    and c.tenant_id = p_tenant
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and c.status = 'active'
  limit 1
  for update of c, br;
  if v_target.id is null then
    raise exception using errcode = '42501',
      message = 'onboarding_resume_target_not_owner_bound';
  end if;
  select br.id into v_target_request_id
  from public.browser_session_requests br
  where br.tenant_id = p_tenant
    and br.call_id = p_target_call
    and br.user_id = p_owner
    and br.session_type = 'onboarding'
    and br.status = 'processing'
    and br.opening_mode_requested = 'application_tts_v1';

  if exists (
    select 1 from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = p_target_call
      and r.kind in (
        'onboarding_coverage', 'onboarding_voice_approval',
        'onboarding_event_alias'
      )
  ) then
    raise exception using errcode = '55000',
      message = 'onboarding_resume_target_state_unsupported';
  end if;

  -- Select the latest prior owner-bound onboarding call before testing any
  -- eligibility predicate. A newer unsupported state must never be skipped.
  select c.* into v_source
  from public.calls c
  join public.browser_session_requests br
    on br.tenant_id = c.tenant_id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
  where c.tenant_id = p_tenant
    and c.id <> p_target_call
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and (c.started_at, c.id) < (v_target.started_at, v_target.id)
  order by c.started_at desc, c.id desc
  limit 1
  for update of c;
  if v_source.id is null then
    raise exception using errcode = 'P0002',
      message = 'onboarding_resume_source_missing';
  end if;

  select br.* into v_reservation
  from public.budget_reservations br
  where br.tenant_id = p_tenant
    and br.call_id = v_source.id
  for update;

  select r.* into v_source_receipt
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = v_source.id
    and r.kind = 'onboarding_coverage'
  order by (r.readback->>'revision')::integer desc,
    r.created_at desc, r.id desc
  limit 1;

  -- A pre-provider target may have consumed an earlier source and then ended
  -- before its application opening became usable. Chain only that exact
  -- immutable revision-one checkpoint; every arbitrary/later error remains the
  -- latest call and fails closed without searching backward.
  if v_source.status = 'error' and (
       v_source.provider_termination_state not in ('confirmed','not_required')
       or v_reservation.id is null
       or v_reservation.status is distinct from 'settled'
       or v_reservation.outcome not in ('startup_error','error')
       or v_source_receipt.id is null
       or v_source_receipt.readback->>'transition_kind' <>
         'resume_checkpoint'
       or v_source_receipt.readback->>'revision' <> '1'
       or v_source_receipt.detail->>'transition_kind' <>
         'resume_checkpoint'
       or v_source_receipt.detail->'transition_schema' is distinct from
         '2'::jsonb
       or (
         select count(*) from public.receipts r
         where r.tenant_id = p_tenant
           and r.call_id = v_source.id
           and r.kind = 'onboarding_coverage'
       ) <> 1
       or exists (
         select 1 from public.receipts r
         where r.tenant_id = p_tenant
           and r.call_id = v_source.id
           and r.kind = 'onboarding_event_alias'
       )
       or jsonb_array_length(
         v_source_receipt.readback->'materializations'
       ) <> 0
     ) then
    raise exception using errcode = '55000',
      message = 'onboarding_resume_latest_ineligible';
  end if;

  if v_source.status not in ('killed_budget','killed_deadline','error')
     or (
       v_source.status in ('killed_budget','killed_deadline')
       and v_source.provider_termination_state is distinct from 'confirmed'
     )
     or (
       v_source.status = 'error'
       and v_source.provider_termination_state not in (
         'confirmed','not_required'
       )
     )
     or v_reservation.id is null
     or v_reservation.status is distinct from 'settled'
     or (
       v_source.status in ('killed_budget','killed_deadline')
       and v_reservation.outcome is distinct from v_source.status
     )
     or (
       v_source.status = 'error'
       and v_reservation.outcome not in ('startup_error','error')
     )
     or v_reservation.reserved_minutes <= 0
     or v_source_receipt.id is null
     or exists (
       select 1 from public.onboarding_resume_consumptions oc
       where oc.source_call_id = v_source.id
          or oc.source_receipt_id = v_source_receipt.id
     )
     or exists (
       select 1 from public.receipts r
       where r.tenant_id = p_tenant
         and r.call_id = v_source.id
         and r.kind = 'onboarding_voice_approval'
     )
     or exists (
       select 1 from public.rules r
       where r.tenant_id = p_tenant
         and r.related_call_id = v_source.id
     ) then
    raise exception using errcode = '55000',
      message = 'onboarding_resume_latest_ineligible';
  end if;

  if v_source_receipt.readback->'schema_version' is distinct from '2'::jsonb
     or v_source_receipt.readback->'complete' is distinct from 'false'::jsonb
     or v_source_receipt.readback->>'tenant_id' <> p_tenant::text
     or v_source_receipt.readback->>'call_id' <> v_source.id::text
     or jsonb_typeof(v_source_receipt.readback->'snapshot') <> 'object'
     or jsonb_typeof(v_source_receipt.readback->'snapshot'->'cells') <>
       'object'
     or jsonb_typeof(v_source_receipt.readback->'snapshot'->'services') <>
       'array'
     or jsonb_typeof(v_source_receipt.readback->'snapshot'->'followUps') <>
       'number'
     or jsonb_typeof(
       v_source_receipt.readback->'snapshot'->'followUpGroups'
     ) <> 'object'
     or v_source_receipt.readback->'snapshot'->>'tenantId' <>
       p_tenant::text
     or v_source_receipt.readback->'snapshot'->>'callId' <>
       v_source.id::text
     or v_source_receipt.readback->'snapshot'->>'revision' <>
       v_source_receipt.readback->>'revision'
     or jsonb_typeof(v_source_receipt.readback->'progress') <> 'object'
     or jsonb_typeof(
       v_source_receipt.readback->'progress'->'missingRequired'
     ) <> 'array'
     or jsonb_typeof(v_source_receipt.readback->'progress'->'ambiguous') <>
       'array'
     or jsonb_typeof(v_source_receipt.readback->'selected_rule_ids') <>
       'array'
     or jsonb_typeof(v_source_receipt.readback->'current_answer_hashes') <>
       'object'
     or jsonb_typeof(v_source_receipt.readback->'materializations') <>
       'array'
     or v_source_receipt.readback->'summary_projection' is distinct from
       'null'::jsonb
     or v_source_receipt.readback->'summary_hash' is distinct from 'null'::jsonb
     or v_source_receipt.readback->'authority' is distinct from
       jsonb_build_object(
         'rules_approved', false,
         'powers_granted', false,
         'operational_mode_changed', false
       )
     or v_source_receipt.readback->'next_action'->>'type' is distinct from 'ask'
     or coalesce(
       btrim(v_source_receipt.readback->'next_action'->>'field'), ''
     ) = ''
     or coalesce(
       btrim(v_source_receipt.readback->'next_action'->>'question_pt'), ''
     ) = '' then
    raise exception using errcode = '55000',
      message = 'onboarding_resume_latest_ineligible';
  end if;

  if jsonb_array_length(v_source_receipt.readback->'selected_rule_ids') <> 0
     or exists (
       select 1
       from jsonb_array_elements(
         v_source_receipt.readback->'materializations'
       ) item
       where item->>'review_ready' = 'true'
          or item->'structured'->>'review_ready' = 'true'
          or item->'structured'->>'materialization_eligible' = 'true'
     )
     or v_source_receipt.readback->'current_answer_hashes' is distinct from
       public.onboarding_snapshot_hashes_v1(
         v_source_receipt.readback->'snapshot'
       )
     or v_source_receipt.readback->'next_action'->>'field' is distinct from
       v_source_receipt.readback->'progress'->'nextQuestion'->>'field'
     or coalesce(
       v_source_receipt.readback->'next_action'->>'subject', ''
     ) is distinct from coalesce(
       v_source_receipt.readback->'progress'->'nextQuestion'->>'subject', ''
     )
     or v_source_receipt.readback->'next_action'->>'question_pt' is distinct from
       v_source_receipt.readback->'progress'->'nextQuestion'->>'questionPt'
  then
    raise exception using errcode = '55000',
      message = 'onboarding_resume_latest_ineligible';
  end if;

  v_source_revision := (v_source_receipt.readback->>'revision')::integer;
  v_source_digest := v_source_receipt.readback->>'snapshot_digest';
  v_source_readback_digest := encode(extensions.digest(
    convert_to(
      (v_source_receipt.readback - 'snapshot_digest')::text,
      'UTF8'
    ),
    'sha256'
  ), 'hex');
  if v_source_revision < 1
     or coalesce(v_source_digest ~ '^[0-9a-f]{64}$', false) = false
     or v_source_digest is distinct from v_source_readback_digest then
    raise exception using errcode = '55000',
      message = 'onboarding_resume_latest_ineligible';
  end if;

  v_snapshot := v_source_receipt.readback->'snapshot' || jsonb_build_object(
    'tenantId', p_tenant,
    'callId', p_target_call,
    'revision', 1
  );
  v_readback := (
    v_source_receipt.readback - array[
      'snapshot_digest', 'rule_id', 'rule_group_id',
      'materialization_action', 'resume_context'
    ]::text[]
  ) || jsonb_build_object(
    'schema_version', 2,
    'transition_kind', 'resume_checkpoint',
    'tenant_id', p_tenant,
    'call_id', p_target_call,
    'revision', 1,
    'complete', false,
    'snapshot', v_snapshot,
    'selected_rule_ids', '[]'::jsonb,
    'next_action', v_source_receipt.readback->'next_action',
    'current_answer_hashes', public.onboarding_snapshot_hashes_v1(v_snapshot),
    'materializations', '[]'::jsonb,
    'summary_projection', 'null'::jsonb,
    'summary_hash', 'null'::jsonb,
    'rule_id', null,
    'rule_group_id', null,
    'materialization_action', 'coverage_only',
    'resume_context', jsonb_build_object(
      'source_call_id', v_source.id,
      'source_receipt_id', v_source_receipt.id,
      'source_revision', v_source_revision,
      'source_snapshot_digest', v_source_digest
    ),
    'authority', jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
  );
  v_snapshot_digest := encode(extensions.digest(
    convert_to(v_readback::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_readback := v_readback || jsonb_build_object(
    'snapshot_digest', v_snapshot_digest
  );
  v_external_id := encode(extensions.digest(convert_to(
    'ligou.v0_2.onboarding_resume:v1:' || p_tenant::text || ':' ||
      v_source.id::text || ':' || p_target_call::text,
    'UTF8'
  ), 'sha256'), 'hex');
  v_payload := jsonb_build_object(
    'schema_version', 1,
    'tenant_id', p_tenant,
    'owner_id', p_owner,
    'source_call_id', v_source.id,
    'source_receipt_id', v_source_receipt.id,
    'source_revision', v_source_revision,
    'source_snapshot_digest', v_source_digest,
    'target_call_id', p_target_call,
    'target_revision', 1
  );
  v_payload_hash := encode(extensions.digest(
    convert_to(v_payload::text, 'UTF8'), 'sha256'
  ), 'hex');

  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id, readback,
    payload_hash, detail
  ) values (
    p_tenant, p_target_call, 'onboarding_coverage', 'accepted',
    v_external_id, v_readback, v_payload_hash,
    jsonb_build_object(
      'transition_kind', 'resume_checkpoint',
      'transition_schema', 2,
      'source_call_id', v_source.id,
      'source_receipt_id', v_source_receipt.id,
      'source_revision', v_source_revision,
      'source_digest', v_source_digest,
      'browser_request_id', v_target_request_id
    )
  ) returning * into v_target_receipt;

  insert into public.onboarding_resume_consumptions (
    tenant_id, owner_user_id, source_call_id, source_receipt_id,
    target_call_id, target_receipt_id
  ) values (
    p_tenant, p_owner, v_source.id, v_source_receipt.id,
    p_target_call, v_target_receipt.id
  ) returning * into v_consumption;

  return jsonb_build_object(
    'status', 'initialized',
    'source_call_id', v_source.id,
    'source_receipt_id', v_source_receipt.id,
    'coverage_receipt_id', v_target_receipt.id,
    'revision', 1,
    'snapshot_digest', v_snapshot_digest,
    'next_action', v_readback->'next_action',
    'coverage', v_readback
  );
end;
$$;

revoke all on function public.initialize_onboarding_resume(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.initialize_onboarding_resume(uuid,uuid,uuid)
  to service_role;

-- This migration has not shipped yet, so it also carries the backward-
-- compatible opening payload cutover consumed by the resumed runtime. V1
-- remains readable while every new application-owned opening is exact V2.
alter table public.browser_session_requests
  drop constraint if exists browser_session_requests_opening_state_check;
alter table public.browser_session_requests
  add constraint browser_session_requests_opening_state_check check (
    coalesce((
      (
        status in ('pending', 'processing', 'error', 'expired')
        and opening_mode_applied is null
        and opening_payload is null
        and (status <> 'pending' or call_id is null)
        and (
          status <> 'processing'
          or call_id is null
          or (
            session_type = 'onboarding'
            and opening_mode_requested = 'application_tts_v1'
            and answer_sdp is null
          )
        )
      )
      or
      (
        status = 'cancel_requested'
        and session_type = 'onboarding'
        and opening_mode_requested = 'application_tts_v1'
        and call_id is not null
        and answer_sdp is null
        and opening_mode_applied is null
        and opening_payload is null
      )
      or
      (
        status in ('ready', 'cancel_requested')
        and opening_mode_applied = opening_mode_requested
        and (
          status <> 'cancel_requested'
          or (
            session_type = 'onboarding'
            and opening_mode_requested = 'application_tts_v1'
            and opening_mode_applied = 'application_tts_v1'
            and call_id is not null
            and coalesce(answer_sdp, '') <> ''
          )
        )
        and (
          (
            opening_mode_applied = 'provider_model_v1'
            and opening_payload is null
          )
          or (
            session_type = 'onboarding'
            and opening_mode_applied = 'application_tts_v1'
            and coalesce((
              jsonb_typeof(opening_payload) = 'object'
              and opening_payload ? 'version'
              and opening_payload ? 'item_id'
              and opening_payload ? 'text'
              and opening_payload ? 'text_sha256'
              and opening_payload ? 'audio_base64'
              and opening_payload ? 'audio_sha256'
              and opening_payload ? 'mime'
              and opening_payload ? 'voice'
              and opening_payload ? 'tts_model'
              and opening_payload ? 'cost_usd'
              and length(opening_payload->>'item_id') = 32
              and opening_payload->>'item_id' ~ '^lgo-[0-9a-f]{28}$'
              and length(opening_payload->>'text') between 1 and 1000
              and btrim(opening_payload->>'text') <> ''
              and opening_payload->>'text_sha256' ~ '^[0-9a-f]{64}$'
              and length(opening_payload->>'audio_base64')
                between 4 and 2000000
              and length(opening_payload->>'audio_base64') % 4 = 0
              and opening_payload->>'audio_base64' ~
                '^[A-Za-z0-9+/]+={0,2}$'
              and opening_payload->>'audio_sha256' ~ '^[0-9a-f]{64}$'
              and opening_payload->>'mime' = 'audio/mpeg'
              and opening_payload->>'voice' = 'ash'
              and case
                when jsonb_typeof(opening_payload->'cost_usd') = 'number'
                  then (opening_payload->>'cost_usd')::numeric between 0 and 1
                else false
              end
              and (
                (
                  opening_payload->'version' = '1'::jsonb
                  and opening_payload->>'tts_model' = 'tts-1'
                  and opening_payload - array[
                    'version',
                    'item_id',
                    'text',
                    'text_sha256',
                    'audio_base64',
                    'audio_sha256',
                    'mime',
                    'voice',
                    'tts_model',
                    'cost_usd'
                  ]::text[] = '{}'::jsonb
                )
                or
                (
                  opening_payload->'version' = '2'::jsonb
                  and opening_payload->>'tts_model' = 'tts-1-hd'
                  and opening_payload - array[
                    'version',
                    'item_id',
                    'text',
                    'text_sha256',
                    'audio_base64',
                    'audio_sha256',
                    'mime',
                    'voice',
                    'tts_model',
                    'cost_usd',
                    'resume_context'
                  ]::text[] = '{}'::jsonb
                  and (
                    opening_payload @>
                      '{"resume_context":null}'::jsonb
                    or (
                      jsonb_typeof(opening_payload->'resume_context') =
                        'object'
                      and (opening_payload->'resume_context') - array[
                        'coverage_receipt_id',
                        'revision',
                        'snapshot_digest',
                        'next_action'
                      ]::text[] = '{}'::jsonb
                      and coalesce(
                        opening_payload->'resume_context'
                          ->>'coverage_receipt_id' ~
                            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                        false
                      )
                      and opening_payload->'resume_context'->'revision' =
                        '1'::jsonb
                      and coalesce(
                        opening_payload->'resume_context'
                          ->>'snapshot_digest' ~ '^[0-9a-f]{64}$',
                        false
                      )
                      and jsonb_typeof(
                        opening_payload->'resume_context'->'next_action'
                      ) = 'object'
                      and (opening_payload->'resume_context'->'next_action')
                        - array[
                          'type', 'field', 'subject', 'question_pt'
                        ]::text[] = '{}'::jsonb
                      and opening_payload->'resume_context'->'next_action'->>'type' = 'ask'
                      and coalesce(btrim(
                        opening_payload->'resume_context'->'next_action'
                          ->>'field'
                      ), '') <> ''
                      and coalesce(btrim(
                        opening_payload->'resume_context'->'next_action'
                          ->>'question_pt'
                      ), '') <> ''
                      and (
                        opening_payload->'resume_context'->'next_action'
                          ->'subject' is null
                        or coalesce(btrim(
                          opening_payload->'resume_context'->'next_action'
                            ->>'subject'
                        ), '') <> ''
                      )
                      and position(
                        'Vamos continuar de onde paramos.' in
                          opening_payload->>'text'
                      ) > 0
                      and position(
                        opening_payload->'resume_context'->'next_action'
                          ->>'question_pt' in opening_payload->>'text'
                      ) > 0
                    )
                  )
                )
              )
            ), false)
          )
        )
      )
    ), false)
  );
