begin;

-- A failed or deliberately bounded opening contains no owner knowledge. This
-- service-only proof walks every prior onboarding call in the current reset
-- generation and permits a fresh Discovery prefill only when each one is an
-- exact empty startup or an exact agent-only opening. Any owner progress wins.
create function public.company_discovery_onboarding_prefill_source_allowed(
  p_tenant uuid,
  p_target_call uuid,
  p_owner uuid,
  p_draft uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_generation bigint;
  v_draft public.company_discovery_onboarding_drafts;
  v_target public.calls;
  v_prior public.calls;
  v_request public.browser_session_requests;
  v_budget public.budget_reservations;
  v_coverage public.receipts;
  v_request_count integer;
  v_coverage_count integer;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_target_call is null
     or p_owner is null or p_draft is null then
    return false;
  end if;

  select d.* into v_draft
  from public.company_discovery_onboarding_drafts d
  where d.id = p_draft
    and d.tenant_id = p_tenant
    and d.created_by = p_owner;
  if v_draft.id is null then return false; end if;

  select c.* into v_target
  from public.tenants t
  join public.calls c
    on c.tenant_id = t.id
   and c.id = p_target_call
  join public.browser_session_requests br
    on br.tenant_id = t.id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
   and br.status = 'processing'
   and br.opening_mode_requested = 'application_tts_v1'
   and br.onboarding_protocol_version = 2
   and br.answer_sdp is null
   and br.opening_mode_applied is null
   and br.opening_payload is null
   and br.test_memory_generation = t.test_memory_generation
  where t.id = p_tenant
    and t.owner_user_id = p_owner
    and t.status = 'onboarding'
    and t.operational_mode = 'simulation_only'
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and c.status = 'active'
    and c.test_memory_generation = t.test_memory_generation
  limit 1
  for update of t, c, br;
  if v_target.id is null then return false; end if;
  v_generation := v_target.test_memory_generation;

  for v_prior in
    select c.*
    from public.calls c
    where c.tenant_id = p_tenant
      and c.id <> p_target_call
      and c.channel = 'browser'
      and c.session_type = 'onboarding'
      and c.test_memory_generation = v_generation
      and (c.started_at, c.id) < (v_target.started_at, v_target.id)
    order by c.started_at desc, c.id desc
    for update of c
  loop
    if v_prior.ended_at is null
       or v_prior.transcript_deleted_at is not null
       or jsonb_typeof(v_prior.transcript) <> 'array' then
      return false;
    end if;

    select count(*) into v_request_count
    from public.browser_session_requests br
    where br.tenant_id = p_tenant
      and br.call_id = v_prior.id;
    if v_request_count <> 1 then return false; end if;
    v_request := null;
    select br.* into v_request
    from public.browser_session_requests br
    where br.tenant_id = p_tenant
      and br.call_id = v_prior.id
    for update of br;
    if v_request.user_id is distinct from p_owner
       or v_request.session_type is distinct from 'onboarding'
       or v_request.opening_mode_requested is distinct from 'application_tts_v1'
       or v_request.onboarding_protocol_version is distinct from 2
       or v_request.test_memory_generation is distinct from v_generation then
      return false;
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_prior.transcript) item
      where item->>'role' = 'caller'
    ) or exists (
      select 1 from public.rules r
      where r.tenant_id = p_tenant
        and r.related_call_id = v_prior.id
    ) or exists (
      select 1 from public.receipts r
      where r.tenant_id = p_tenant
        and r.call_id = v_prior.id
        and r.kind in (
          'onboarding_voice_approval',
          'onboarding_event_alias',
          'onboarding_discovery_fallback'
        )
    ) or exists (
      select 1 from public.onboarding_resume_consumptions oc
      where oc.tenant_id = p_tenant
        and (
          oc.source_call_id = v_prior.id
          or oc.target_call_id = v_prior.id
        )
    ) then
      return false;
    end if;

    select count(*) into v_coverage_count
    from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = v_prior.id
      and r.kind = 'onboarding_coverage';
    if v_coverage_count > 1 then return false; end if;

    v_budget := null;
    select b.* into v_budget
    from public.budget_reservations b
    where b.tenant_id = p_tenant
      and b.call_id = v_prior.id
    for update of b;

    -- Pre-provider startup failures are safe only with no transport, transcript,
    -- or coverage. A budget-denied call may legitimately have no reservation.
    if v_request.status in ('error','expired') then
      if v_coverage_count <> 0
         or v_request.answer_sdp is not null
         or v_request.opening_mode_applied is not null
         or v_request.opening_payload is not null
         or v_prior.openai_call_id is not null
         or v_prior.provider_termination_state is distinct from 'not_required'
         or v_prior.transcript is distinct from '[]'::jsonb
         or not (
           (
             v_prior.status = 'error'
             and v_budget.id is not null
             and v_budget.status = 'settled'
             and v_budget.outcome in ('startup_error','error')
           ) or (
             v_prior.status = 'killed_budget'
             and (
               v_budget.id is null
               or (
                 v_budget.status = 'settled'
                 and v_budget.outcome = 'killed_budget'
               )
             )
           )
         ) then
        return false;
      end if;
      continue;
    end if;

    -- A post-provider smoke must be one settled terminal call, one exact agent
    -- opening transcript, and no hidden transcript redaction.
    if v_request.status is distinct from 'ready'
       or coalesce(btrim(v_request.answer_sdp), '') = ''
       or v_request.opening_mode_applied is distinct from 'application_tts_v1'
       or jsonb_typeof(v_request.opening_payload) is distinct from 'object'
       or v_request.opening_payload->'version' is distinct from '2'::jsonb
       or coalesce(v_prior.openai_call_id, '') = ''
       or v_prior.provider_termination_state is distinct from 'confirmed'
       or v_budget.id is null
       or v_budget.status is distinct from 'settled'
       or not (
         (
           v_prior.status = 'ended'
           and v_budget.outcome = 'ended'
         ) or (
           v_prior.status = 'error'
           and v_budget.outcome = 'error'
         ) or (
           v_prior.status in ('killed_budget','killed_deadline')
           and v_budget.outcome = v_prior.status
         )
       )
       or jsonb_array_length(v_prior.transcript) <> 1
       or jsonb_typeof(v_prior.transcript->0) is distinct from 'object'
       or not ((v_prior.transcript->0) ?& array['role','text','at'])
       or (v_prior.transcript->0) - array['role','text','at']::text[]
         is distinct from '{}'::jsonb
       or v_prior.transcript->0->>'role' is distinct from 'agent'
       or v_prior.transcript->0->>'text' is distinct from
         v_request.opening_payload->>'text' then
      return false;
    end if;

    if v_coverage_count = 0 then
      if v_request.opening_payload->'resume_context' is distinct from
           'null'::jsonb then
        return false;
      end if;
      continue;
    end if;

    v_coverage := null;
    select r.* into v_coverage
    from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = v_prior.id
      and r.kind = 'onboarding_coverage'
    limit 1
    for update of r;
    if v_coverage.id is null
       or v_coverage.readback->'schema_version' is distinct from '2'::jsonb
       or v_coverage.readback->>'transition_kind' is distinct from
         'discovery_prefill'
       or v_coverage.readback->'revision' is distinct from '1'::jsonb
       or v_coverage.readback->'complete' is distinct from 'false'::jsonb
       or v_coverage.readback->>'tenant_id' is distinct from p_tenant::text
       or v_coverage.readback->>'call_id' is distinct from v_prior.id::text
       or v_coverage.readback->'selected_rule_ids' is distinct from '[]'::jsonb
       or v_coverage.readback->'materializations' is distinct from '[]'::jsonb
       or v_coverage.readback->'summary_projection' is distinct from 'null'::jsonb
       or v_coverage.readback->'summary_hash' is distinct from 'null'::jsonb
       or v_coverage.readback->'authority' is distinct from jsonb_build_object(
         'rules_approved', false,
         'powers_granted', false,
         'operational_mode_changed', false
       )
       or v_coverage.readback->'discovery_context'->>'draft_id' is distinct from
         v_draft.id::text
       or v_coverage.readback->'discovery_context'->>'draft_hash' is distinct from
         v_draft.draft_hash
       or v_coverage.detail->>'owner_id' is distinct from p_owner::text
       or v_coverage.detail->>'draft_id' is distinct from v_draft.id::text
       or coalesce(
         v_coverage.readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$',
         false
       ) = false
       or v_request.opening_payload->'resume_context'
         ->>'coverage_receipt_id' is distinct from v_coverage.id::text
       or v_request.opening_payload->'resume_context'
         ->>'snapshot_digest' is distinct from
           v_coverage.readback->>'snapshot_digest'
       or v_request.opening_payload->'resume_context'->'next_action'
         is distinct from v_coverage.readback->'next_action'
       or v_request.opening_payload->'resume_context'->'next_action'
         ->>'question_pt' not like 'Eu já analisei seu website%'
       or position(
         'Eu já analisei seu website' in v_request.opening_payload->>'text'
       ) <= 0
       or position(
         v_coverage.readback->'next_action'->>'question_pt' in
           v_request.opening_payload->>'text'
       ) <= 0 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

revoke all on function public.company_discovery_onboarding_prefill_source_allowed(
  uuid,uuid,uuid,uuid
) from public, anon, authenticated, service_role;

-- These wrappers preserve the existing CAS functions and their lock order.
-- They add the empty-opening proof only for the recovery path selected after
-- onboarding_resume_latest_ineligible; ordinary first-time prefill is unchanged.
create function public.initialize_discovery_prefill_after_empty_opening(
  p_tenant uuid,
  p_target_call uuid,
  p_owner uuid,
  p_draft uuid,
  p_coverage jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_draft:' || p_tenant::text, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_prefill:' ||
      p_tenant::text || ':' || p_target_call::text, 0
  ));
  if not public.company_discovery_onboarding_prefill_source_allowed(
    p_tenant, p_target_call, p_owner, p_draft
  ) then
    raise exception using errcode = '55000',
      message = 'company_discovery_onboarding_prior_progress_present';
  end if;
  return public.initialize_company_discovery_onboarding_prefill(
    p_tenant, p_target_call, p_owner, p_draft, p_coverage
  );
end;
$$;

revoke all on function public.initialize_discovery_prefill_after_empty_opening(
  uuid,uuid,uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.initialize_discovery_prefill_after_empty_opening(
  uuid,uuid,uuid,uuid,jsonb
) to service_role;

create function public.reconcile_discovery_prefill_after_empty_opening(
  p_tenant uuid,
  p_target_call uuid,
  p_owner uuid,
  p_draft uuid,
  p_expected_draft_version bigint,
  p_expected_draft_hash text,
  p_source_job uuid,
  p_source_attempt uuid,
  p_source_result uuid,
  p_expected_result_hash text,
  p_expected_result_schema text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_draft:' || p_tenant::text, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_prefill:' ||
      p_tenant::text || ':' || p_target_call::text, 0
  ));
  if not public.company_discovery_onboarding_prefill_source_allowed(
    p_tenant, p_target_call, p_owner, p_draft
  ) then
    raise exception using errcode = '55000',
      message = 'company_discovery_onboarding_prior_progress_present';
  end if;
  return public.reconcile_company_discovery_onboarding_prefill(
    p_tenant,
    p_target_call,
    p_owner,
    p_draft,
    p_expected_draft_version,
    p_expected_draft_hash,
    p_source_job,
    p_source_attempt,
    p_source_result,
    p_expected_result_hash,
    p_expected_result_schema
  );
end;
$$;

revoke all on function public.reconcile_discovery_prefill_after_empty_opening(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_discovery_prefill_after_empty_opening(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) to service_role;

commit;
