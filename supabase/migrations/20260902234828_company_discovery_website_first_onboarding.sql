-- Website-first onboarding for the allowlisted DirectModel pilot.
-- Public website observations become a candidate onboarding draft, never an
-- owner decision, active rule, power, or private authority grant.

begin;

alter table public.worker_jobs
  drop constraint if exists worker_jobs_processing_stage_check;
alter table public.worker_jobs
  add constraint worker_jobs_processing_stage_check check (
    processing_stage in (
      'queued','fetching','analyzing','ready_for_review',
      'ready_for_onboarding','reviewed','failed','cancelled'
    )
  );

create or replace function public.sync_company_discovery_job_status_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.processing_stage := case new.status
    when 'queued' then 'queued'
    when 'awaiting_review' then case
      when new.processing_stage = 'ready_for_onboarding'
        then 'ready_for_onboarding'
      else 'ready_for_review'
    end
    when 'reviewed' then 'reviewed'
    when 'failed' then 'failed'
    when 'cancelled' then 'cancelled'
    when 'running' then case
      when new.processing_stage in ('fetching','analyzing')
        then new.processing_stage
      else 'fetching'
    end
  end;
  return new;
end;
$$;

revoke all on function public.sync_company_discovery_job_status_stage()
  from public, anon, authenticated, service_role;

do $drop_legacy_draft_checks$
declare
  v_constraint text;
begin
  for v_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.company_discovery_onboarding_drafts'::regclass
      and c.contype = 'c'
      and (
        c.conname like 'company_discovery_onboarding_drafts_check%'
        or c.conname in (
          'company_discovery_onboarding_drafts_draft_check',
          'company_discovery_onboarding_drafts_draft_check1',
          'company_discovery_onboarding_drafts_draft_check2'
        )
      )
  loop
    execute format(
      'alter table public.company_discovery_onboarding_drafts drop constraint %I',
      v_constraint
    );
  end loop;
end;
$drop_legacy_draft_checks$;

alter table public.company_discovery_onboarding_drafts
  add constraint company_discovery_onboarding_drafts_payload_check check (
    jsonb_typeof(draft) = 'object'
    and draft->>'schema_version' in (
      'company_discovery.onboarding_draft.v1',
      'company_discovery.onboarding_draft.v2'
    )
    and draft->'authority' = '{
      "rules_approved": false,
      "powers_granted": false,
      "operational_mode_changed": false
    }'::jsonb
    and (
      (
        draft->>'schema_version' = 'company_discovery.onboarding_draft.v1'
        and jsonb_typeof(draft->'approved_facts') = 'array'
        and jsonb_typeof(draft->'unresolved_items') = 'array'
      )
      or (
        draft->>'schema_version' = 'company_discovery.onboarding_draft.v2'
        and draft->>'review_mode' = 'onboarding_voice'
        and jsonb_typeof(draft->'candidate_facts') = 'array'
        and jsonb_typeof(draft->'missing_information') = 'array'
        and jsonb_typeof(draft->'ambiguous_information') = 'array'
        and jsonb_typeof(draft->'contradictions') = 'array'
        and jsonb_typeof(draft->'owner_private_information_needed') = 'array'
        and jsonb_typeof(draft->'sources') = 'array'
      )
    )
  ),
  add constraint company_discovery_onboarding_drafts_nonempty_check check (
    (
      draft->>'schema_version' = 'company_discovery.onboarding_draft.v1'
      and (
        cardinality(decision_ids) > 0
        or jsonb_array_length(draft->'unresolved_items') > 0
      )
    )
    or (
      draft->>'schema_version' = 'company_discovery.onboarding_draft.v2'
      and cardinality(decision_ids) = 0
      and (
        jsonb_array_length(draft->'candidate_facts') > 0
        or jsonb_array_length(draft->'missing_information') > 0
        or jsonb_array_length(draft->'ambiguous_information') > 0
        or jsonb_array_length(draft->'contradictions') > 0
      )
    )
  );

create unique index company_discovery_candidate_draft_result_unique
  on public.company_discovery_onboarding_drafts (source_result_id)
  where draft->>'schema_version' = 'company_discovery.onboarding_draft.v2';

create or replace function public.select_company_discovery_result(
  p_job_id uuid,
  p_attempt_id uuid,
  p_expected_version bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.worker_jobs;
  v_attempt public.worker_attempts;
  v_result public.worker_results;
  v_existing_draft public.company_discovery_onboarding_drafts;
  v_owner uuid;
  v_draft_id uuid;
  v_draft_version bigint;
  v_draft jsonb;
  v_draft_hash text;
  v_candidate_facts jsonb;
  v_ambiguous jsonb;
  v_claim_contradictions jsonb;
  v_sources jsonb;
  v_already_selected boolean := false;
begin
  select j.* into v_job
  from public.worker_jobs j
  where j.id = p_job_id
  for update;
  if v_job.id is null then
    raise exception using errcode = '55000',
      message = 'company_discovery_job_not_found';
  end if;
  v_already_selected := coalesce(
    v_job.selected_attempt_id = p_attempt_id,
    false
  );
  if v_job.selected_attempt_id is not null and not v_already_selected then
    raise exception using errcode = '55000',
      message = 'company_discovery_result_already_selected';
  end if;
  if (not v_already_selected and v_job.version is distinct from p_expected_version)
     or (v_already_selected and v_job.version not in (
       p_expected_version, p_expected_version + 1
     )) then
    raise exception using errcode = '40001',
      message = 'company_discovery_stale_version';
  end if;
  select a.* into v_attempt
  from public.worker_attempts a
  where a.id = p_attempt_id and a.job_id = v_job.id
  for update;
  if v_attempt.id is null
     or v_job.current_attempt_id is distinct from v_attempt.id then
    raise exception using errcode = '55000',
      message = 'company_discovery_attempt_not_current';
  end if;
  if (not v_already_selected
      and v_attempt.fence_generation is distinct from v_job.fence_generation)
     or (v_already_selected
      and v_job.fence_generation is distinct from v_attempt.fence_generation + 1) then
    raise exception using errcode = '40001',
      message = 'company_discovery_stale_fence';
  end if;
  select wr.* into v_result
  from public.worker_results wr
  where wr.attempt_id = v_attempt.id
  for update;
  if v_result.id is null
     or v_result.validation_state <> 'validated'
     or (not v_already_selected and v_attempt.status <> 'validated')
     or (v_already_selected and v_attempt.status <> 'selected') then
    raise exception using errcode = '55000',
      message = 'company_discovery_result_not_validated';
  end if;
  if v_result.result_schema = 'company_discovery.result.v2' and not (
    jsonb_array_length(v_result.candidate_result->'candidate_facts') > 0
    or jsonb_array_length(v_result.candidate_result->'missing_questions') > 0
    or jsonb_array_length(v_result.candidate_result->'contradictions') > 0
    or jsonb_array_length(v_result.candidate_result->'uncertainty') > 0
  ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_candidate_context_empty';
  end if;

  if v_result.result_schema = 'company_discovery.result.v2' then
    select t.owner_user_id into v_owner
    from public.tenants t
    where t.id = v_job.tenant_id;
    if v_owner is null then
      raise exception using errcode = '55000',
        message = 'company_discovery_owner_missing';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'ligou.company_discovery.onboarding_draft:' || v_job.tenant_id::text,
      0
    ));
    select d.* into v_existing_draft
    from public.company_discovery_onboarding_drafts d
    where d.source_result_id = v_result.id
      and d.draft->>'schema_version' =
        'company_discovery.onboarding_draft.v2'
    order by d.version desc, d.created_at desc, d.id desc
    limit 1;
    if v_existing_draft.id is not null then
      if v_existing_draft.tenant_id is distinct from v_job.tenant_id
         or v_existing_draft.source_job_id is distinct from v_job.id
         or v_existing_draft.draft->>'source_attempt_id'
           is distinct from v_attempt.id::text
         or v_existing_draft.draft->>'source_result_hash'
           is distinct from v_result.result_hash then
        raise exception using errcode = '55000',
          message = 'company_discovery_candidate_draft_mismatch';
      end if;
      v_draft_id := v_existing_draft.id;
      v_draft_hash := v_existing_draft.draft_hash;
    else
      select coalesce(max(d.version), 0) + 1 into v_draft_version
      from public.company_discovery_onboarding_drafts d
      where d.tenant_id = v_job.tenant_id;

      select coalesce(jsonb_agg(jsonb_build_object(
      'claim_id', c.id,
      'claim_class', c.claim_class,
      'claim_type', c.claim_type,
      'value', c.normalized_value,
      'evidence_refs', to_jsonb(c.evidence_refs),
      'confidence', c.confidence,
      'contradiction_status', c.contradiction_status,
      'missing_fields', c.missing_fields,
      'ambiguous_fields', c.ambiguous_fields,
      'contradictions', c.contradictions,
      'uncertainty', c.uncertainty,
      'adapter_id', c.adapter_id,
      'provider', c.provider,
      'model', c.model,
      'claim_schema_version', c.claim_schema_version,
      'review_status', 'pending_onboarding'
    ) order by c.created_at, c.id), '[]'::jsonb)
        into v_candidate_facts
      from public.discovery_claims c
      where c.result_id = v_result.id
        and c.claim_schema_version = 'company_discovery.claim.v2';

      select coalesce(jsonb_agg(jsonb_build_object(
      'claim_id', c.id,
      'claim_type', c.claim_type,
      'fields', c.ambiguous_fields,
      'evidence_refs', to_jsonb(c.evidence_refs)
    ) order by c.created_at, c.id), '[]'::jsonb)
        into v_ambiguous
      from public.discovery_claims c
      where c.result_id = v_result.id
        and jsonb_array_length(c.ambiguous_fields) > 0;

      select coalesce(jsonb_agg(jsonb_build_object(
      'claim_id', c.id,
      'claim_type', c.claim_type,
      'items', c.contradictions,
      'evidence_refs', to_jsonb(c.evidence_refs)
    ) order by c.created_at, c.id), '[]'::jsonb)
        into v_claim_contradictions
      from public.discovery_claims c
      where c.result_id = v_result.id
        and jsonb_array_length(c.contradictions) > 0;

      select coalesce(jsonb_agg(jsonb_build_object(
      'evidence_id', s.id,
      'url', s.url,
      'excerpt', left(s.excerpt, 500),
      'crawl_order', s.crawl_order
    ) order by s.crawl_order, s.id), '[]'::jsonb)
        into v_sources
      from public.discovery_source_snapshots s
      where s.result_id = v_result.id;

      v_draft_id := gen_random_uuid();
      v_draft := jsonb_build_object(
      'schema_version', 'company_discovery.onboarding_draft.v2',
      'review_mode', 'onboarding_voice',
      'source_job_id', v_job.id,
      'source_attempt_id', v_result.attempt_id,
      'source_result_id', v_result.id,
      'source_result_hash', v_result.result_hash,
      'source_result_schema', v_result.result_schema,
      'candidate_facts', v_candidate_facts,
      'missing_information',
        coalesce(v_result.candidate_result->'missing_questions', '[]'::jsonb)
        || coalesce(v_result.candidate_result->'uncertainty', '[]'::jsonb),
      'ambiguous_information', v_ambiguous,
      'contradictions',
        coalesce(v_result.candidate_result->'contradictions', '[]'::jsonb)
        || v_claim_contradictions,
      'owner_private_information_needed', jsonb_build_array(
        jsonb_build_object('field', 'authority.quote_price',
          'question_pt', 'Quando o Ligou pode informar um preço ao cliente?'),
        jsonb_build_object('field', 'authority.negotiate_floor',
          'question_pt', 'Qual é o limite privado de negociação e desconto?'),
        jsonb_build_object('field', 'authority.read_calendar',
          'question_pt', 'O Ligou pode consultar sua agenda?'),
        jsonb_build_object('field', 'authority.book',
          'question_pt', 'O Ligou pode confirmar agendamentos?'),
        jsonb_build_object('field', 'authority.reschedule_cancel',
          'question_pt', 'O Ligou pode remarcar ou cancelar serviços?'),
        jsonb_build_object('field', 'authority.charge_fee',
          'question_pt', 'O Ligou pode confirmar ou cobrar taxas?'),
        jsonb_build_object('field', 'authority.emergency',
          'question_pt', 'Que autonomia o Ligou tem em emergências?'),
        jsonb_build_object('field', 'authority.out_of_area',
          'question_pt', 'Que autonomia o Ligou tem fora da área atendida?')
      ),
      'sources', v_sources,
      'authority', jsonb_build_object(
        'rules_approved', false,
        'powers_granted', false,
        'operational_mode_changed', false
      )
    );
      v_draft_hash := encode(extensions.digest(
        convert_to(v_draft::text, 'utf8'), 'sha256'
      ), 'hex');
      insert into public.company_discovery_onboarding_drafts (
        id, tenant_id, version, source_job_id, source_result_id,
        decision_ids, draft, draft_hash, created_by
      ) values (
        v_draft_id, v_job.tenant_id, v_draft_version,
        v_job.id, v_result.id, '{}'::uuid[], v_draft, v_draft_hash, v_owner
      );
    end if;
  end if;

  if v_already_selected then
    update public.worker_jobs
    set processing_stage = case
          when v_result.result_schema = 'company_discovery.result.v2'
            then 'ready_for_onboarding'
          else 'ready_for_review'
        end,
        fallback_state = 'discovery_selected',
        updated_at = clock_timestamp()
    where id = v_job.id;
    return jsonb_build_object(
      'job_id', v_job.id,
      'attempt_id', v_attempt.id,
      'result_id', v_result.id,
      'version', v_job.version,
      'fence_generation', v_job.fence_generation,
      'draft_id', v_draft_id,
      'draft_hash', v_draft_hash
    );
  end if;

  update public.worker_attempts
  set status = 'selected'
  where id = v_attempt.id;
  update public.worker_jobs
  set selected_attempt_id = v_attempt.id,
      status = 'awaiting_review',
      processing_stage = case
        when v_result.result_schema = 'company_discovery.result.v2'
          then 'ready_for_onboarding'
        else 'ready_for_review'
      end,
      fence_generation = fence_generation + 1,
      version = version + 1,
      fallback_state = 'discovery_selected',
      updated_at = clock_timestamp()
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id,
    'attempt_id', v_attempt.id,
    'result_id', v_result.id,
    'version', v_job.version + 1,
    'fence_generation', v_job.fence_generation + 1
  );
end;
$$;

revoke all on function public.select_company_discovery_result(uuid,uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.select_company_discovery_result(uuid,uuid,bigint)
  to service_role;

create or replace function public.company_discovery_setup_status()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_tenant public.tenants;
  v_tenant_count integer;
  v_allowlisted boolean := false;
  v_enabled boolean := false;
  v_job public.worker_jobs;
  v_attempt public.worker_attempts;
  v_result public.worker_results;
  v_draft public.company_discovery_onboarding_drafts;
  v_state text;
  v_failure_code text;
  v_company_name text;
  v_services jsonb := '[]'::jsonb;
  v_claim_count integer := 0;
  v_source_count integer := 0;
  v_gap_count integer := 0;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select count(*) into v_tenant_count
  from public.tenants t
  where t.owner_user_id = v_owner;
  if v_tenant_count <> 1 then
    raise exception using errcode = '42501',
      message = 'company_discovery_owner_tenant_ambiguous';
  end if;
  select t.* into v_tenant
  from public.tenants t
  where t.owner_user_id = v_owner
  order by t.created_at, t.id
  limit 1;
  select coalesce(c.enabled, false) into v_enabled
  from public.company_discovery_controls c
  where c.singleton;
  select coalesce(a.active, false)
         and (a.expires_at is null or a.expires_at > statement_timestamp())
    into v_allowlisted
  from public.company_discovery_allowlist a
  where a.tenant_id = v_tenant.id;
  v_allowlisted := coalesce(v_allowlisted, false);

  if v_tenant.status = 'active' or exists (
    select 1
    from public.receipts r
    join public.calls c on c.id = r.call_id and c.tenant_id = v_tenant.id
    where r.tenant_id = v_tenant.id
      and r.kind = 'onboarding_voice_approval'
      and r.outcome = 'accepted'
      and c.test_memory_generation = v_tenant.test_memory_generation
  ) then
    v_state := 'onboarding_complete';
  elsif not v_allowlisted then
    v_state := 'payment_pending';
  elsif exists (
    select 1 from public.calls c
    where c.tenant_id = v_tenant.id
      and c.session_type = 'onboarding'
      and c.status = 'active'
      and c.test_memory_generation = v_tenant.test_memory_generation
  ) then
    v_state := 'onboarding_in_progress';
  else
    select j.* into v_job
    from public.worker_jobs j
    where j.tenant_id = v_tenant.id
    order by j.created_at desc, j.id desc
    limit 1;
    if v_job.id is null then
      v_state := 'website_required';
    elsif v_job.status in ('queued','running') then
      v_state := 'learning';
    elsif v_job.status in ('failed','cancelled') then
      v_state := 'learning_failed';
      select a.* into v_attempt
      from public.worker_attempts a
      where a.job_id = v_job.id
      order by a.attempt_number desc, a.created_at desc, a.id desc
      limit 1;
    elsif v_job.status in ('awaiting_review','reviewed') then
      select a.* into v_attempt
      from public.worker_attempts a
      where a.id = coalesce(v_job.selected_attempt_id, v_job.current_attempt_id)
        and a.job_id = v_job.id;
      select wr.* into v_result
      from public.worker_results wr
      where wr.job_id = v_job.id
        and wr.attempt_id = v_attempt.id
        and wr.validation_state = 'validated';
      if v_job.status = 'reviewed' then
        select d.* into v_draft
        from public.company_discovery_onboarding_drafts d
        where d.tenant_id = v_tenant.id
          and d.source_job_id = v_job.id
          and d.source_result_id = v_result.id
          and d.draft->>'schema_version' =
            'company_discovery.onboarding_draft.v1'
        order by d.version desc, d.created_at desc, d.id desc
        limit 1;
        if v_job.selected_attempt_id is not null
           and v_attempt.id = v_job.selected_attempt_id
           and v_attempt.status = 'selected'
           and v_result.id is not null
           and v_draft.id is not null
           and v_draft.draft->>'source_attempt_id' = v_attempt.id::text
           and v_draft.draft->>'source_result_hash' = v_result.result_hash then
          v_state := 'ready_for_onboarding';
        else
          v_state := 'learning_failed';
          v_failure_code := 'setup_state_unrecoverable';
        end if;
      elsif v_job.selected_attempt_id is null then
        v_state := 'learning_failed';
        v_failure_code := case
          when v_attempt.status = 'validated'
            and v_result.result_schema = 'company_discovery.result.v2'
            then 'result_selection_incomplete'
          when v_result.id is not null
            then 'legacy_review_requires_restart'
          else 'setup_state_unrecoverable'
        end;
      elsif v_result.result_schema = 'company_discovery.result.v2' then
        select d.* into v_draft
        from public.company_discovery_onboarding_drafts d
        where d.tenant_id = v_tenant.id
          and d.source_job_id = v_job.id
          and d.source_result_id = v_result.id
          and d.draft->>'schema_version' =
            'company_discovery.onboarding_draft.v2'
        order by d.version desc, d.created_at desc, d.id desc
        limit 1;
        if v_attempt.status = 'selected'
           and v_draft.id is not null
           and v_draft.draft->>'source_attempt_id' = v_attempt.id::text
           and v_draft.draft->>'source_result_hash' = v_result.result_hash then
          v_state := 'ready_for_onboarding';
        else
          v_state := 'learning_failed';
          v_failure_code := 'result_selection_incomplete';
        end if;
      else
        v_state := 'learning_failed';
        v_failure_code := 'legacy_review_requires_restart';
      end if;
    else
      v_state := 'learning_failed';
      v_failure_code := 'setup_state_unrecoverable';
    end if;
  end if;

  if v_result.id is not null and v_draft.id is not null then
    select count(*)::integer into v_claim_count
    from public.discovery_claims c
    where c.result_id = v_result.id;
    select count(*)::integer into v_source_count
    from public.discovery_source_snapshots s
    where s.result_id = v_result.id;
    select c.normalized_value #>> '{}'
      into v_company_name
    from public.discovery_claims c
    where c.result_id = v_result.id and c.claim_type = 'business_name'
    order by c.created_at, c.id
    limit 1;
    select coalesce(jsonb_agg(name order by name), '[]'::jsonb)
      into v_services
    from (
      select distinct value #>> '{}' as name
      from public.discovery_claims c,
        lateral jsonb_array_elements(c.normalized_value->'service_names') value
      where c.result_id = v_result.id and c.claim_type = 'service'
    ) service_names;
    if v_draft.draft->>'schema_version' =
       'company_discovery.onboarding_draft.v1' then
      v_gap_count := jsonb_array_length(v_draft.draft->'unresolved_items');
    else
      v_gap_count :=
        jsonb_array_length(v_draft.draft->'missing_information')
        + jsonb_array_length(v_draft.draft->'ambiguous_information')
        + jsonb_array_length(v_draft.draft->'contradictions')
        + jsonb_array_length(v_draft.draft->'owner_private_information_needed');
    end if;
  end if;

  return jsonb_build_object(
    'schema_version', 'company_discovery.setup_status.v1',
    'state', v_state,
    'entitlement_source', case when v_allowlisted
      then 'pilot_allowlist' else 'none' end,
    'discovery_enabled', v_enabled,
    'can_start', v_allowlisted and v_enabled,
    'job', case when v_job.id is null then null else jsonb_build_object(
      'job_id', v_job.id,
      'version', v_job.version,
      'status', v_job.status,
      'processing_stage', v_job.processing_stage,
      'normalized_origin', v_job.normalized_origin,
      'failure_code', coalesce(v_failure_code, v_attempt.terminal_reason)
    ) end,
    'summary', case when v_state <> 'ready_for_onboarding' then null
      else jsonb_build_object(
        'company_name', v_company_name,
        'services', v_services,
        'pages_analyzed', v_source_count,
        'claims_found', v_claim_count,
        'questions_remaining', v_gap_count
      ) end,
    'ready_proof', case when v_state <> 'ready_for_onboarding' then null
      else jsonb_build_object(
        'job_id', v_job.id,
        'attempt_id', v_attempt.id,
        'result_id', v_result.id,
        'result_hash', v_result.result_hash,
        'draft_id', v_draft.id,
        'draft_hash', v_draft.draft_hash
      ) end
  );
end;
$$;

revoke all on function public.company_discovery_setup_status()
  from public, anon, authenticated, service_role;
grant execute on function public.company_discovery_setup_status()
  to authenticated;

create or replace function public.start_company_discovery_setup(
  p_url text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_tenant public.tenants;
  v_tenant_count integer;
  v_input text := btrim(p_url);
  v_tail text;
  v_host text;
  v_suffix text;
  v_origin text;
  v_request_hash text;
  v_existing public.worker_jobs;
  v_job_id uuid;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select count(*) into v_tenant_count
  from public.tenants t
  where t.owner_user_id = v_owner;
  if v_tenant_count <> 1 then
    raise exception using errcode = '42501',
      message = 'company_discovery_owner_tenant_ambiguous';
  end if;
  select t.* into v_tenant
  from public.tenants t
  where t.owner_user_id = v_owner
  order by t.created_at, t.id
  limit 1;
  if lower(left(v_input, 8)) <> 'https://' or v_input ~ '[#]' then
    raise exception using errcode = '22023',
      message = 'company_discovery_origin_invalid';
  end if;
  v_tail := substring(v_input from 9);
  v_host := lower(split_part(split_part(v_tail, '/', 1), '?', 1));
  if v_host = '' or v_host ~ '[@:]'
     or v_host !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' then
    raise exception using errcode = '22023',
      message = 'company_discovery_origin_invalid';
  end if;
  v_suffix := substring(
    v_tail from length(split_part(split_part(v_tail, '/', 1), '?', 1)) + 1
  );
  v_origin := 'https://' || v_host || case
    when v_suffix = '' then '/' else v_suffix end;
  v_request_hash := encode(extensions.digest(convert_to(
    'company_discovery.v1|' || v_origin, 'utf8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.setup:' || v_tenant.id::text,
    0
  ));
  if not exists (
    select 1 from public.company_discovery_controls c
    where c.singleton and c.enabled
  ) then
    raise exception using errcode = '55000',
      message = 'company_discovery_disabled';
  end if;
  if not exists (
    select 1 from public.company_discovery_allowlist a
    where a.tenant_id = v_tenant.id and a.active
      and (a.expires_at is null or a.expires_at > clock_timestamp())
  ) then
    raise exception using errcode = '42501',
      message = 'company_discovery_tenant_not_allowlisted';
  end if;
  select j.* into v_existing
  from public.worker_jobs j
  where j.tenant_id = v_tenant.id
    and j.request_hash = v_request_hash
  order by j.created_at desc, j.id desc
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object(
      'job_id', v_existing.id,
      'status', v_existing.status,
      'version', v_existing.version,
      'reused', true
    );
  end if;
  if exists (
    select 1 from public.worker_jobs j
    where j.tenant_id = v_tenant.id
      and j.status in ('queued','running','awaiting_review')
      and j.request_hash <> v_request_hash
  ) then
    raise exception using errcode = '55000',
      message = 'company_discovery_url_change_blocked';
  end if;
  v_job_id := public.submit_company_discovery(
    v_origin,
    'website-setup:' || v_request_hash
  );
  select j.* into v_existing
  from public.worker_jobs j
  where j.id = v_job_id;
  return jsonb_build_object(
    'job_id', v_existing.id,
    'status', v_existing.status,
    'version', v_existing.version,
    'reused', false
  );
end;
$$;

revoke all on function public.start_company_discovery_setup(text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_company_discovery_setup(text)
  to authenticated;

create or replace function public.retry_company_discovery_setup(
  p_job uuid,
  p_expected_version bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_job public.worker_jobs;
  v_attempt public.worker_attempts;
  v_result public.worker_results;
  v_recovery jsonb;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  join public.tenants t on t.id = j.tenant_id
    and t.owner_user_id = v_owner
  where j.id = p_job
  for update of j;
  if v_job.id is null then
    raise exception using errcode = '42501',
      message = 'company_discovery_job_not_owner';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.setup:' || v_job.tenant_id::text,
    0
  ));
  if not exists (
    select 1 from public.company_discovery_controls c
    where c.singleton and c.enabled
  ) then
    raise exception using errcode = '55000',
      message = 'company_discovery_disabled';
  end if;
  if not exists (
    select 1 from public.company_discovery_allowlist a
    where a.tenant_id = v_job.tenant_id and a.active
      and (a.expires_at is null or a.expires_at > clock_timestamp())
  ) then
    raise exception using errcode = '42501',
      message = 'company_discovery_tenant_not_allowlisted';
  end if;
  if v_job.status in ('queued','running')
     and v_job.version >= p_expected_version + 1 then
    return jsonb_build_object(
      'job_id', v_job.id,
      'status', v_job.status,
      'version', v_job.version,
      'fence_generation', v_job.fence_generation,
      'reused', true
    );
  end if;
  if v_job.version is distinct from p_expected_version then
    raise exception using errcode = '40001',
      message = 'company_discovery_stale_version';
  end if;
  if v_job.status = 'awaiting_review' then
    select a.* into v_attempt
    from public.worker_attempts a
    where a.id = coalesce(v_job.selected_attempt_id, v_job.current_attempt_id)
      and a.job_id = v_job.id
    for update;
    select wr.* into v_result
    from public.worker_results wr
    where wr.job_id = v_job.id
      and wr.attempt_id = v_attempt.id
      and wr.validation_state = 'validated'
    for update;
    if v_result.result_schema = 'company_discovery.result.v2'
       and (
         (v_job.selected_attempt_id is null and v_attempt.status = 'validated')
         or (
           v_job.selected_attempt_id = v_attempt.id
           and v_attempt.status = 'selected'
         )
       ) then
      select public.select_company_discovery_result(
        v_job.id,
        v_attempt.id,
        v_job.version
      ) into v_recovery;
      return v_recovery || jsonb_build_object(
        'status', 'awaiting_review',
        'reused', true,
        'recovered', true
      );
    end if;
  end if;
  if v_job.status not in ('cancelled','failed','awaiting_review') then
    raise exception using errcode = '55000',
      message = 'company_discovery_retry_not_terminal';
  end if;
  update public.worker_attempts
  set status = 'superseded',
      terminal_at = coalesce(terminal_at, clock_timestamp())
  where id = v_job.current_attempt_id
    and status in ('running','validated','selected');
  update public.company_discovery_review_nonces
  set invalidated_at = clock_timestamp(),
      invalidation_reason = 'job_retried'
  where job_id = v_job.id
    and consumed_at is null
    and invalidated_at is null;
  update public.worker_jobs
  set status = 'queued',
      processing_stage = 'queued',
      current_attempt_id = null,
      selected_attempt_id = null,
      fallback_state = 'existing_onboarding',
      deadline_at = clock_timestamp() + interval '10 minutes',
      version = version + 1,
      fence_generation = fence_generation + 1,
      updated_at = clock_timestamp()
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id,
    'status', 'queued',
    'version', v_job.version + 1,
    'fence_generation', v_job.fence_generation + 1,
    'reused', false
  );
end;
$$;

revoke all on function public.retry_company_discovery_setup(uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.retry_company_discovery_setup(uuid,bigint)
  to authenticated;

-- The existing prefill functions contain the full call/receipt CAS protocol.
-- Change only their job-state predicate, with an exact occurrence guard, so
-- legacy owner-reviewed v1 drafts and candidate v2 drafts share that protocol.
do $patch_prefill_status$
declare
  v_definition text;
  v_old text := 'and j.status = ''reviewed''';
  v_new text := 'and ((v_draft.draft->>''schema_version'' = ''company_discovery.onboarding_draft.v1'' and j.status = ''reviewed'') or (v_draft.draft->>''schema_version'' = ''company_discovery.onboarding_draft.v2'' and j.status = ''awaiting_review''))';
begin
  select pg_get_functiondef(
    'public.initialize_company_discovery_onboarding_prefill(uuid,uuid,uuid,uuid,jsonb)'::regprocedure
  ) into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) <> 1 then
    raise exception 'company_discovery_prefill_status_patch_mismatch';
  end if;
  execute replace(v_definition, v_old, v_new);

  select pg_get_functiondef(
    'public.reconcile_company_discovery_onboarding_prefill(uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text)'::regprocedure
  ) into v_definition;
  if (length(v_definition) - length(replace(v_definition, v_old, '')))
       / length(v_old) <> 1 then
    raise exception 'company_discovery_reconcile_status_patch_mismatch';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$patch_prefill_status$;

revoke all on function public.initialize_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.initialize_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,jsonb
) to service_role;

revoke all on function public.reconcile_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) to service_role;

commit;
