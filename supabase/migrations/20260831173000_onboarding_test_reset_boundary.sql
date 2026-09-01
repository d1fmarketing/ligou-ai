-- A test reset is an operational epoch, not a deletion. Historical calls,
-- receipts, versions and budget evidence remain immutable, while no pre-reset
-- onboarding state can be displayed or resumed by a later test.

alter table public.tenants
  add column if not exists test_memory_reset_at timestamp with time zone;
alter table public.tenants
  add column if not exists test_memory_generation bigint not null default 0;

alter table public.rules
  add column if not exists test_memory_generation bigint not null default 0;
alter table public.approval_cases
  add column if not exists test_memory_generation bigint not null default 0;
alter table public.powers
  add column if not exists test_memory_generation bigint not null default 0;
alter table public.calls
  add column if not exists test_memory_generation bigint not null default 0;
alter table public.browser_session_requests
  add column if not exists test_memory_generation bigint not null default 0;
alter table public.notifications
  add column if not exists test_memory_generation bigint not null default 0;

comment on column public.tenants.test_memory_reset_at is
  'Owner-triggered simulation reset boundary; pre-boundary test state remains audit-only.';

create or replace function public.stamp_test_memory_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation bigint;
begin
  select t.test_memory_generation into v_generation
  from public.tenants t
  where t.id = new.tenant_id
  for update;
  if v_generation is null then
    raise exception using errcode = '23503', message = 'tenant_not_found';
  end if;
  new.test_memory_generation := v_generation;
  return new;
end;
$$;

revoke all on function public.stamp_test_memory_generation()
  from public, anon, authenticated, service_role;

create trigger rules_test_memory_generation
before insert on public.rules
for each row execute function public.stamp_test_memory_generation();
create trigger approval_cases_test_memory_generation
before insert on public.approval_cases
for each row execute function public.stamp_test_memory_generation();
create trigger powers_test_memory_generation
before insert on public.powers
for each row execute function public.stamp_test_memory_generation();
create trigger calls_test_memory_generation
before insert on public.calls
for each row execute function public.stamp_test_memory_generation();
create trigger browser_requests_test_memory_generation
before insert on public.browser_session_requests
for each row execute function public.stamp_test_memory_generation();
create trigger notifications_test_memory_generation
before insert on public.notifications
for each row execute function public.stamp_test_memory_generation();

-- Legacy reset receipts represented only rules/cases, not a complete test
-- epoch. They are intentionally not promoted: only this new atomic RPC may set
-- the boundary after also revoking powers and proving all postconditions.

create or replace function public.reset_owner_test_memory()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_role text;
  v_tenant public.tenants;
  v_reset_at timestamptz;
  v_generation bigint;
  v_revoked int := 0;
  v_rejected int := 0;
  v_cases int := 0;
  v_powers int := 0;
  v_effective_rules int := 0;
  v_pending_cases int := 0;
  v_active_powers int := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using errcode = '42501',
      message = 'authentication_required';
  end if;
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  if v_role <> 'authenticated' then
    raise exception using errcode = '42501',
      message = 'authenticated_role_required';
  end if;

  select t.* into v_tenant
  from public.tenants t
  where t.owner_user_id = v_uid
    and t.bootstrap_origin = 'v0_2_google'
  order by t.created_at asc
  limit 1;
  if v_tenant.id is null then
    raise exception using errcode = 'P0002', message = 'tenant_not_found';
  end if;

  -- Lock order is shared by reset/resume first, then by rule versioning.
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.onboarding_resume:' || v_tenant.id::text,
    0
  ));

  select t.* into v_tenant
  from public.tenants t
  where t.id = v_tenant.id
    and t.owner_user_id = v_uid
    and t.bootstrap_origin = 'v0_2_google'
  for update;
  if v_tenant.id is null then
    raise exception using errcode = '42501',
      message = 'tenant_not_owner_bound';
  end if;
  if v_tenant.operational_mode <> 'simulation_only' then
    raise exception using errcode = '42501',
      message = 'reset_requires_simulation_only';
  end if;
  if exists (
    select 1
    from public.calls c
    where c.tenant_id = v_tenant.id
      and c.session_type = 'onboarding'
      and c.status = 'active'
  ) or exists (
    select 1
    from public.browser_session_requests br
    where br.tenant_id = v_tenant.id
      and br.session_type = 'onboarding'
      and br.status in ('pending', 'processing', 'cancel_requested')
  ) then
    raise exception using errcode = '55000',
      message = 'test_reset_active_onboarding_session';
  end if;
  -- Answer persistence locks the tenant before rule versioning; reset uses the
  -- same order so neither path can hold one lock while waiting on the other.
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.rules_versioning:' || v_tenant.id::text,
    0
  ));

  v_reset_at := clock_timestamp();
  -- Neutralization stays in the old generation. The tenant row is already
  -- locked, so concurrent writers wait and receive the new generation only
  -- after this complete boundary commits.
  with latest as (
    select distinct on (r.rule_group_id) r.*
    from public.rules r
    where r.tenant_id = v_tenant.id
    order by r.rule_group_id, r.version desc, r.created_at desc, r.id desc
  )
  insert into public.rules (
    tenant_id, rule_group_id, version, origem, escopo, status, category,
    text, structured, evidence_quote, related_call_id, approved_by,
    approved_at
  )
  select l.tenant_id, l.rule_group_id, l.version + 1, l.origem, l.escopo,
    'revogado', l.category, l.text, l.structured, l.evidence_quote,
    l.related_call_id, v_uid, v_reset_at
  from latest l
  where l.status = 'aprovado';
  get diagnostics v_revoked = row_count;

  with latest as (
    select distinct on (r.rule_group_id) r.*
    from public.rules r
    where r.tenant_id = v_tenant.id
    order by r.rule_group_id, r.version desc, r.created_at desc, r.id desc
  )
  insert into public.rules (
    tenant_id, rule_group_id, version, origem, escopo, status, category,
    text, structured, evidence_quote, related_call_id, approved_by,
    approved_at
  )
  select l.tenant_id, l.rule_group_id, l.version + 1, l.origem, l.escopo,
    'rejeitado', l.category, l.text, l.structured, l.evidence_quote,
    l.related_call_id, v_uid, v_reset_at
  from latest l
  where l.status <> 'rejeitado';
  get diagnostics v_rejected = row_count;

  update public.approval_cases
  set status = 'expirada',
      resolved_at = v_reset_at,
      resolved_by = v_uid,
      resolution = jsonb_build_object('mode', 'test_reset')
  where tenant_id = v_tenant.id and status = 'pendente';
  get diagnostics v_cases = row_count;

  update public.powers
  set revoked_at = v_reset_at,
      revoked_by = v_uid
  where tenant_id = v_tenant.id and revoked_at is null;
  get diagnostics v_powers = row_count;

  select count(*) into v_effective_rules
  from public.effective_rules er
  where er.tenant_id = v_tenant.id;
  select count(*) into v_pending_cases
  from public.approval_cases ac
  where ac.tenant_id = v_tenant.id and ac.status = 'pendente';
  select count(*) into v_active_powers
  from public.powers p
  where p.tenant_id = v_tenant.id and p.revoked_at is null;
  if v_effective_rules <> 0 or v_pending_cases <> 0 or v_active_powers <> 0 then
    raise exception using errcode = '55000',
      message = 'test_reset_postcondition_failed';
  end if;

  update public.tenants
  set test_memory_reset_at = v_reset_at,
      test_memory_generation = test_memory_generation + 1
  where id = v_tenant.id
  returning test_memory_generation into v_generation;

  insert into public.receipts (
    tenant_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    v_tenant.id,
    'rule_change',
    'accepted',
    'test_reset:' || v_reset_at::text,
    jsonb_build_object(
      'reset_at', v_reset_at,
      'generation', v_generation,
      'revoked', v_revoked,
      'rejected', v_rejected,
      'cases_expired', v_cases,
      'powers_revoked', v_powers,
      'effective_rules', v_effective_rules,
      'pending_cases', v_pending_cases,
      'active_powers', v_active_powers
    ),
    md5(v_tenant.id::text || 'test_reset' || v_reset_at::text),
    jsonb_build_object(
      'mode', 'test_reset',
      'operational_mode', v_tenant.operational_mode,
      'reset_at', v_reset_at
    )
  );

  return jsonb_build_object(
    'tenant_id', v_tenant.id,
    'reset_at', v_reset_at,
    'generation', v_generation,
    'revoked', v_revoked,
    'rejected', v_rejected,
    'cases_expired', v_cases,
    'powers_revoked', v_powers,
    'effective_rules', v_effective_rules,
    'pending_cases', v_pending_cases,
    'active_powers', v_active_powers
  );
end;
$$;

revoke all on function public.reset_owner_test_memory()
  from public, anon, authenticated, service_role;
grant execute on function public.reset_owner_test_memory()
  to authenticated;

-- Reset and every owner mutation that can create or consume test-memory state
-- share one lock order: tenant row first, then the rules advisory or case row.
-- Reissue the latest definitions here so upgraded databases cannot retain the
-- historical advisory->tenant or case->tenant inversions.

create or replace function public.decide_rule(
  p_rule uuid,
  p_decision text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.rules;
  v_new uuid;
begin
  select r.* into v_rule
  from public.rules r
  join public.tenants t
    on t.id = r.tenant_id
   and t.owner_user_id = auth.uid()
  where r.id = p_rule
  for update of t;
  if v_rule.id is null then
    raise exception 'rule_not_found_or_not_owner';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.rules_versioning:' || v_rule.tenant_id::text,
    0
  ));
  if exists (
    select 1 from public.rules r
    where r.tenant_id = v_rule.tenant_id
      and r.rule_group_id = v_rule.rule_group_id
      and r.version > v_rule.version
  ) then
    raise exception using errcode = '40001', message = 'stale_rule_version';
  end if;
  if v_rule.status <> 'sugerido' then
    raise exception 'rule_not_pending: %', v_rule.status;
  end if;
  if p_decision not in ('aprovado','rejeitado') then
    raise exception 'invalid_decision';
  end if;
  if p_decision = 'aprovado'
     and v_rule.origem = 'onboarding'
     and (
       jsonb_typeof(v_rule.structured->'materialization_eligible')
         is distinct from 'boolean'
       or jsonb_typeof(v_rule.structured->'review_ready')
         is distinct from 'boolean'
       or (v_rule.structured->>'materialization_eligible')::boolean is not true
       or (v_rule.structured->>'review_ready')::boolean is not true
     ) then
    raise exception using errcode = '22023',
      message = 'rule_not_materialization_eligible';
  end if;
  insert into public.rules (
    tenant_id, rule_group_id, version, origem, escopo, status, category, text,
    structured, evidence_quote, related_call_id, approved_by, approved_at
  ) values (
    v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1,
    v_rule.origem, v_rule.escopo, p_decision, v_rule.category, v_rule.text,
    v_rule.structured, v_rule.evidence_quote, v_rule.related_call_id,
    auth.uid(), now()
  ) returning id into v_new;
  return v_new;
end;
$$;

revoke all on function public.decide_rule(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_rule(uuid,text) to authenticated;

create or replace function public.revoke_rule(
  p_rule uuid,
  p_reason text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.rules;
  v_new uuid;
begin
  select r.* into v_rule
  from public.rules r
  join public.tenants t
    on t.id = r.tenant_id
   and t.owner_user_id = auth.uid()
  where r.id = p_rule
  for update of t;
  if v_rule.id is null then
    raise exception 'rule_not_found_or_not_owner';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.rules_versioning:' || v_rule.tenant_id::text,
    0
  ));
  if exists (
    select 1 from public.rules r
    where r.tenant_id = v_rule.tenant_id
      and r.rule_group_id = v_rule.rule_group_id
      and r.version > v_rule.version
  ) then
    raise exception using errcode = '40001', message = 'stale_rule_version';
  end if;
  if v_rule.status <> 'aprovado' then
    raise exception 'only_approved_can_be_revoked';
  end if;
  insert into public.rules (
    tenant_id, rule_group_id, version, origem, escopo, status, category, text,
    structured, approved_by, approved_at
  ) values (
    v_rule.tenant_id, v_rule.rule_group_id, v_rule.version + 1,
    v_rule.origem, v_rule.escopo, 'revogado', v_rule.category, v_rule.text,
    v_rule.structured, auth.uid(), now()
  ) returning id into v_new;
  insert into public.receipts (
    tenant_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    v_rule.tenant_id, 'rule_change', 'accepted', v_new::text,
    jsonb_build_object('revoked_rule', p_rule),
    md5(p_rule::text || 'revogado'),
    jsonb_build_object('reason', p_reason)
  );
  return v_new;
end;
$$;

revoke all on function public.revoke_rule(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_rule(uuid,text) to authenticated;

create or replace function public.decide_case(
  p_case uuid,
  p_decision text,
  p_mode text default 'case',
  p_rule_text text default null,
  p_rule_structured jsonb default null,
  p_scope text default 'geral',
  p_duration text default 'permanente'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.approval_cases;
  v_tenant uuid;
  v_rule_id uuid;
  v_rows int;
begin
  select c.tenant_id into v_tenant
  from public.approval_cases c
  join public.tenants t
    on t.id = c.tenant_id
   and t.owner_user_id = auth.uid()
  where c.id = p_case
  for update of t;
  if v_tenant is null then
    raise exception 'case_not_found_or_not_owner';
  end if;
  select c.* into v_case
  from public.approval_cases c
  where c.id = p_case and c.tenant_id = v_tenant
  for update of c;
  if v_case.id is null then
    raise exception 'case_not_found_or_not_owner';
  end if;
  if v_case.status <> 'pendente' then
    raise exception 'case_already_decided: %', v_case.status;
  end if;
  if p_decision not in ('aprovada','recusada') then
    raise exception 'invalid_decision';
  end if;

  update public.approval_cases
  set status = p_decision,
      resolved_at = now(),
      resolved_by = auth.uid(),
      resolution = jsonb_build_object(
        'mode', p_mode, 'scope', p_scope, 'duration', p_duration
      )
  where id = p_case and status = 'pendente';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'case_race_lost';
  end if;

  if p_decision = 'aprovada' and p_mode = 'rule' then
    if p_rule_text is null then
      raise exception 'rule_text_required_for_rule_mode';
    end if;
    insert into public.rules (
      tenant_id, origem, escopo, status, category, text, structured,
      related_call_id, approved_by, approved_at
    ) values (
      v_case.tenant_id, 'escalacao', p_scope, 'aprovado',
      coalesce(p_rule_structured->>'category','escalacao'),
      p_rule_text, p_rule_structured, v_case.call_id, auth.uid(), now()
    ) returning id into v_rule_id;
  end if;

  insert into public.receipts (
    tenant_id, kind, outcome, external_id, readback, payload_hash, detail
  ) values (
    v_case.tenant_id, 'rule_change', 'accepted', p_case::text,
    jsonb_build_object('case_status', p_decision, 'rule_id', v_rule_id),
    md5(coalesce(p_rule_text,'') || p_decision),
    jsonb_build_object('mode', p_mode)
  );

  update public.bookings
  set status = case
    when p_decision = 'aprovada' then 'proposed'
    else 'cancelled'
  end
  where case_id = p_case and status = 'pending_approval';

  return jsonb_build_object(
    'case_id', p_case, 'status', p_decision, 'rule_id', v_rule_id
  );
end;
$$;

revoke all on function public.decide_case(uuid,text,text,text,jsonb,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.decide_case(uuid,text,text,text,jsonb,text,text)
  to authenticated;

create or replace function public.adjust_case(
  p_case uuid,
  p_proposal text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.approval_cases;
  v_tenant uuid;
  v_rows int;
begin
  select c.tenant_id into v_tenant
  from public.approval_cases c
  join public.tenants t
    on t.id = c.tenant_id
   and t.owner_user_id = auth.uid()
  where c.id = p_case
  for update of t;
  if v_tenant is null then
    raise exception 'case_not_found_or_not_owner';
  end if;
  select c.* into v_case
  from public.approval_cases c
  where c.id = p_case and c.tenant_id = v_tenant
  for update of c;
  if v_case.id is null then
    raise exception 'case_not_found_or_not_owner';
  end if;
  if v_case.status <> 'pendente' then
    raise exception 'case_already_decided';
  end if;
  update public.approval_cases
  set proposed_action = p_proposal,
      resolution = coalesce(resolution, '{}'::jsonb) || jsonb_build_object(
        'adjustments',
        coalesce(resolution->'adjustments', '[]'::jsonb) || jsonb_build_array(
          jsonb_build_object(
            'before', v_case.proposed_action,
            'after', p_proposal,
            'at', now()
          )
        )
      )
  where id = p_case and status = 'pendente';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'case_race_lost';
  end if;
  return jsonb_build_object(
    'case_id', p_case,
    'proposed_action', p_proposal
  );
end;
$$;

revoke all on function public.adjust_case(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.adjust_case(uuid,text) to authenticated;

create or replace function public.revoke_power(p_power uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_power_tenant uuid;
begin
  select p.tenant_id into v_tenant
  from public.powers p
  join public.tenants t
    on t.id = p.tenant_id
   and t.owner_user_id = auth.uid()
  where p.id = p_power and p.revoked_at is null
  for update of t;
  if v_tenant is null then
    raise exception 'power_not_found_or_not_owner';
  end if;

  select p.tenant_id into v_power_tenant
  from public.powers p
  where p.id = p_power
    and p.tenant_id = v_tenant
    and p.revoked_at is null
  for update of p;
  if v_power_tenant is null then
    raise exception 'power_not_found_or_not_owner';
  end if;

  update public.powers p
  set revoked_at = now(), revoked_by = auth.uid()
  where p.id = p_power and p.revoked_at is null;

  insert into public.receipts (
    tenant_id, kind, outcome, external_id, readback, payload_hash
  ) values (
    v_tenant, 'power_change', 'accepted', p_power::text,
    jsonb_build_object('op','revoke'), md5(p_power::text || 'revoke')
  );
end;
$$;

revoke all on function public.revoke_power(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_power(uuid) to authenticated;

-- Keep the complete eligibility implementation immutable behind a reset-aware
-- wrapper. Existing runtimes call the same public signature throughout rollout.
alter function public.initialize_onboarding_resume(uuid,uuid,uuid)
  rename to initialize_onboarding_resume_v1;

revoke all on function public.initialize_onboarding_resume_v1(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.initialize_onboarding_resume(
  p_tenant uuid,
  p_target_call uuid,
  p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reset_at timestamptz;
  v_generation bigint;
  v_target_started_at timestamptz;
  v_target_request_created_at timestamptz;
  v_target_generation bigint;
  v_target_request_generation bigint;
  v_source_call_generation bigint;
  v_source_request_generation bigint;
begin
  if p_tenant is null or p_target_call is null or p_owner is null then
    raise exception using errcode = '22023',
      message = 'onboarding_resume_scope_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.onboarding_resume:' || p_tenant::text,
    0
  ));

  select t.test_memory_reset_at, t.test_memory_generation,
    c.started_at, br.created_at,
    c.test_memory_generation, br.test_memory_generation
  into v_reset_at, v_generation,
    v_target_started_at, v_target_request_created_at,
    v_target_generation, v_target_request_generation
  from public.tenants t
  join public.calls c
    on c.tenant_id = t.id and c.id = p_target_call
  join public.browser_session_requests br
    on br.tenant_id = t.id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
  where t.id = p_tenant
    and t.owner_user_id = p_owner
    and t.status = 'onboarding'
    and t.operational_mode = 'simulation_only'
  limit 1;
  if v_target_started_at is null or v_target_request_created_at is null then
    raise exception using errcode = '42501',
      message = 'onboarding_resume_target_not_owner_bound';
  end if;

  if v_reset_at is not null and (
    v_target_generation <> v_generation or
    v_target_request_generation <> v_generation
  ) then
    raise exception using errcode = 'P0002',
      message = 'onboarding_resume_source_missing';
  end if;

  if v_reset_at is not null then
    select c.test_memory_generation, br.test_memory_generation
    into v_source_call_generation, v_source_request_generation
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
      and (c.started_at, c.id) <
        (v_target_started_at, p_target_call)
    order by c.started_at desc, c.id desc
    limit 1;
    if not found
       or v_source_call_generation <> v_generation
       or v_source_request_generation <> v_generation then
      raise exception using errcode = 'P0002',
        message = 'onboarding_resume_source_missing';
    end if;
  end if;

  return public.initialize_onboarding_resume_v1(
    p_tenant, p_target_call, p_owner
  );
end;
$$;

revoke all on function public.initialize_onboarding_resume(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.initialize_onboarding_resume(uuid,uuid,uuid)
  to service_role;

alter function public.get_onboarding_resume_status(uuid)
  rename to get_onboarding_resume_status_v1;

revoke all on function public.get_onboarding_resume_status_v1(uuid)
  from public, anon, authenticated, service_role;

create function public.get_onboarding_resume_status(p_call uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_owner uuid;
  v_reset_at timestamptz;
  v_generation bigint;
  v_call_started_at timestamptz;
  v_request_created_at timestamptz;
  v_call_generation bigint;
  v_request_generation bigint;
begin
  v_owner := auth.uid();
  if v_owner is null then
    raise exception using errcode = '42501',
      message = 'authentication_required';
  end if;

  select t.test_memory_reset_at, t.test_memory_generation,
    c.started_at, br.created_at,
    c.test_memory_generation, br.test_memory_generation
  into v_reset_at, v_generation,
    v_call_started_at, v_request_created_at,
    v_call_generation, v_request_generation
  from public.calls c
  join public.tenants t
    on t.id = c.tenant_id and t.owner_user_id = v_owner
  join public.browser_session_requests br
    on br.tenant_id = c.tenant_id
   and br.call_id = c.id
   and br.user_id = v_owner
   and br.session_type = 'onboarding'
  where c.id = p_call
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
  limit 1;
  if v_call_started_at is null or v_request_created_at is null then
    raise exception using errcode = '42501',
      message = 'onboarding_resume_status_not_owner_bound';
  end if;

  if v_reset_at is not null and (
    v_call_generation <> v_generation or
    v_request_generation <> v_generation
  ) then
    return jsonb_build_object('status', 'blocked');
  end if;

  return public.get_onboarding_resume_status_v1(p_call);
end;
$$;

revoke all on function public.get_onboarding_resume_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_onboarding_resume_status(uuid)
  to authenticated;
