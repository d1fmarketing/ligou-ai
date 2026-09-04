begin;

-- Interview-only persistence. Existing calls, coverage receipts, selected
-- Discovery artifacts and tenant generations are never rewritten here.
create table public.website_interview_preparations (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  owner_id uuid not null references auth.users(id),
  generation bigint not null check (generation >= 0),
  prior_call_id uuid not null references public.calls(id),
  draft_id uuid not null references public.company_discovery_onboarding_drafts(id),
  draft_hash text not null check (draft_hash ~ '^[a-f0-9]{64}$'),
  result_id uuid not null references public.worker_results(id),
  result_hash text not null check (result_hash ~ '^[a-f0-9]{64}$'),
  consumed_call_id uuid unique references public.calls(id),
  created_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  check ((consumed_call_id is null) = (consumed_at is null))
);
create unique index website_interview_one_pending on public.website_interview_preparations(tenant_id) where consumed_call_id is null;
create table public.website_interviews (
  interview_id uuid primary key references public.calls(id),
  preparation_id uuid not null unique references public.website_interview_preparations(id),
  tenant_id uuid not null references public.tenants(id),
  owner_id uuid not null references auth.users(id),
  generation bigint not null,
  current_call_id uuid not null unique references public.calls(id),
  agenda jsonb not null check (octet_length(agenda::text) <= 2097152),
  next_action jsonb not null,
  db_version bigint not null default 0 check (db_version >= 0),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('unfinished','reviewing','closing','complete')),
  receipt_id uuid not null references public.receipts(id),
  created_at timestamptz not null default clock_timestamp()
);
create index website_interviews_tenant on public.website_interviews(tenant_id);
create table public.website_interview_calls (
  call_id uuid primary key references public.calls(id),
  request_id uuid not null unique references public.browser_session_requests(id),
  interview_id uuid not null references public.website_interviews(interview_id),
  tenant_id uuid not null references public.tenants(id),
  created_at timestamptz not null default clock_timestamp()
);
create index website_interview_calls_lineage on public.website_interview_calls(interview_id);
create index website_interview_calls_tenant on public.website_interview_calls(tenant_id);
create table public.website_interview_owner_turns (
  call_id uuid not null references public.website_interview_calls(call_id),
  provider_item_id text not null check (length(btrim(provider_item_id)) > 0 and length(provider_item_id) <= 400),
  tenant_id uuid not null references public.tenants(id),
  owner_text text not null check (length(btrim(owner_text)) > 0 and length(owner_text) <= 32768),
  created_at timestamptz not null default clock_timestamp(),
  primary key(call_id, provider_item_id)
);
create index website_interview_owner_turns_tenant on public.website_interview_owner_turns(tenant_id);
create trigger website_interview_calls_append_only before update or delete on public.website_interview_calls for each row execute function public.block_mutation();
create trigger website_interview_owner_turns_append_only before update or delete on public.website_interview_owner_turns for each row execute function public.block_mutation();

do $$ declare v_table text; v_constraint text; begin
  foreach v_table in array array['website_interview_preparations','website_interviews','website_interview_calls','website_interview_owner_turns'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', v_table);
    execute format('grant select on table public.%I to authenticated, service_role', v_table);
    execute format('create policy %I on public.%I for select to authenticated using (exists (select 1 from public.tenants t where t.id = tenant_id and t.owner_user_id = (select auth.uid())))', v_table || '_owner_select', v_table);
  end loop;
  select pg_get_constraintdef(oid) into v_constraint from pg_constraint where conrelid = 'public.receipts'::regclass and conname = 'receipts_kind_check';
  if v_constraint is null then raise exception 'receipts_kind_constraint_missing'; end if;
  alter table public.receipts drop constraint receipts_kind_check;
  execute 'alter table public.receipts add constraint receipts_kind_check check ((' || substring(v_constraint from 8 for length(v_constraint)-8) || ') or kind = ''website_interview'')';
end $$;
create unique index receipts_website_interview_key on public.receipts(tenant_id, external_id) where kind = 'website_interview';

create function public.website_interview_service_guard() returns void
language plpgsql security definer set search_path = '' as $$ begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt()->>'role') is distinct from 'service_role' then
    raise exception using errcode='42501', message='service_role_required';
  end if;
end $$;

-- Match existing draft -> tenant -> call/request lock ordering. Tenant lock
-- serializes preparations and competing starts without a tenant-selected API.
create function public.website_interview_scope(p_owner uuid, p_call uuid, p_request uuid, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_found uuid; begin
  perform public.website_interview_service_guard();
  select c.tenant_id into v_tenant from public.calls c where c.id=p_call;
  if v_tenant is null then raise exception using errcode='42501', message='interview_call_not_owner_bound'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ligou.company_discovery.onboarding_draft:' || v_tenant::text,0));
  perform 1 from public.tenants t where t.id=v_tenant for update;
  select c.id into v_found from public.tenants t join public.calls c on c.tenant_id=t.id
  join public.browser_session_requests br on br.call_id=c.id and br.tenant_id=t.id
  where t.id=v_tenant and t.owner_user_id=p_owner and t.status='onboarding' and t.operational_mode='simulation_only'
    and c.id=p_call and c.channel='browser' and c.session_type='onboarding'
    and c.test_memory_generation=t.test_memory_generation and (not p_active or (c.status='active' and c.ended_at is null))
    and br.id=p_request and br.user_id=p_owner and br.session_type='onboarding'
    and br.test_memory_generation=t.test_memory_generation and br.onboarding_protocol_version in (2,3)
    and br.opening_mode_requested='application_tts_v1' and (not p_active or br.status in ('processing','ready'))
  for update of c,br;
  if v_found is null then raise exception using errcode='42501', message='interview_call_not_owner_bound'; end if;
  return v_tenant;
end $$;

create function public.website_interview_source_valid(p_tenant uuid,p_owner uuid,p_draft uuid,p_draft_hash text,p_result uuid,p_result_hash text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.company_discovery_onboarding_drafts d
    join public.worker_jobs j on j.id=d.source_job_id and j.tenant_id=d.tenant_id
    join public.worker_results r on r.id=d.source_result_id and r.tenant_id=d.tenant_id and r.job_id=j.id
    where d.tenant_id=p_tenant and d.created_by=p_owner and d.id=p_draft and d.draft_hash=p_draft_hash
      and d.source_result_id=p_result and r.result_hash=p_result_hash and d.draft->>'source_result_hash'=p_result_hash
      and d.draft->>'schema_version'='company_discovery.onboarding_draft.v2'
      and j.selected_attempt_id=r.attempt_id and j.status='awaiting_review' and r.validation_state='validated'
      and r.result_schema='company_discovery.result.v2'
      and not exists(select 1 from public.company_discovery_onboarding_drafts newer where newer.tenant_id=d.tenant_id and newer.version>d.version));
$$;

create function public.website_interview_prior_settled(p_tenant uuid,p_owner uuid,p_call uuid,p_generation bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_call public.calls; v_budget public.budget_reservations; begin
  select c.* into v_call from public.calls c where c.id=p_call and c.tenant_id=p_tenant for update;
  select b.* into v_budget from public.budget_reservations b where b.call_id=p_call and b.tenant_id=p_tenant for update;
  return coalesce(v_call.channel='browser' and v_call.session_type='onboarding' and v_call.test_memory_generation=p_generation
    and v_call.status in ('ended','error','killed_budget','killed_deadline') and v_call.ended_at is not null
    and v_call.provider_termination_state='confirmed' and v_budget.status='settled'
    and exists(select 1 from public.browser_session_requests br where br.call_id=p_call and br.tenant_id=p_tenant and br.user_id=p_owner and br.test_memory_generation=p_generation),false);
end $$;

create function public.prepare_fresh_website_interview(p_preparation uuid,p_owner uuid,p_expected_tenant uuid,p_generation bigint,p_prior_call uuid,p_draft uuid,p_draft_hash text,p_result uuid,p_result_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant public.tenants; v_existing public.website_interview_preparations; begin
  perform public.website_interview_service_guard();
  perform pg_advisory_xact_lock(hashtextextended('ligou.company_discovery.onboarding_draft:' || p_expected_tenant::text,0));
  select t.* into v_tenant from public.tenants t where t.id=p_expected_tenant and t.owner_user_id=p_owner for update;
  if v_tenant.id is null or v_tenant.status<>'onboarding' or v_tenant.operational_mode<>'simulation_only' or v_tenant.test_memory_generation is distinct from p_generation then
    raise exception using errcode='42501',message='interview_owner_or_generation_changed'; end if;
  if not public.website_interview_source_valid(v_tenant.id,p_owner,p_draft,p_draft_hash,p_result,p_result_hash) then raise exception using errcode='40001',message='interview_selected_draft_changed'; end if;
  select * into v_existing from public.website_interview_preparations where id=p_preparation;
  if v_existing.id is not null then
    if row(v_existing.tenant_id,v_existing.owner_id,v_existing.generation,v_existing.prior_call_id,v_existing.draft_id,v_existing.draft_hash,v_existing.result_id,v_existing.result_hash)
      is distinct from row(p_expected_tenant,p_owner,p_generation,p_prior_call,p_draft,p_draft_hash,p_result,p_result_hash) then raise exception using errcode='23505',message='interview_preparation_conflict'; end if;
    return jsonb_build_object('preparationId',v_existing.id,'consumedCallId',v_existing.consumed_call_id,'replayed',true);
  end if;
  if not public.website_interview_prior_settled(v_tenant.id,p_owner,p_prior_call,p_generation) then raise exception using errcode='55000',message='interview_prior_not_settled'; end if;
  if exists(select 1 from public.calls c where c.tenant_id=v_tenant.id and c.status='active') then raise exception using errcode='55000',message='interview_competing_active_call'; end if;
  insert into public.website_interview_preparations(id,tenant_id,owner_id,generation,prior_call_id,draft_id,draft_hash,result_id,result_hash)
    values(p_preparation,v_tenant.id,p_owner,p_generation,p_prior_call,p_draft,p_draft_hash,p_result,p_result_hash);
  return jsonb_build_object('preparationId',p_preparation,'consumedCallId',null,'replayed',false);
end $$;

create function public.resolve_prepared_website_source(p_owner uuid,p_call uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_p public.website_interview_preparations; v_d public.company_discovery_onboarding_drafts; v_resume public.website_interviews; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  select p.* into v_p from public.website_interview_preparations p where p.tenant_id=v_tenant and p.owner_id=p_owner
    and (p.consumed_call_id is null or p.consumed_call_id=p_call) order by p.created_at desc limit 1 for update;
  if v_p.id is null then
    select i.* into v_resume from public.website_interviews i where i.tenant_id=v_tenant and i.owner_id=p_owner
      and i.state='unfinished' and i.current_call_id<>p_call
      and not exists(select 1 from public.website_interviews newer where newer.tenant_id=v_tenant and newer.created_at>i.created_at)
      order by i.created_at desc limit 1 for update;
    if v_resume.interview_id is null then return jsonb_build_object('prepared',false); end if;
    if not public.website_interview_prior_settled(v_tenant,p_owner,v_resume.current_call_id,v_resume.generation)
      or exists(select 1 from public.calls where tenant_id=v_tenant and status='active' and id<>p_call) then raise exception 'interview_resume_source_not_settled'; end if;
    select * into v_p from public.website_interview_preparations where id=v_resume.preparation_id;
  end if;
  if v_p.generation is distinct from (select test_memory_generation from public.tenants where id=v_tenant)
    or not public.website_interview_source_valid(v_tenant,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash) then raise exception using errcode='40001',message='interview_selected_draft_changed'; end if;
  select * into v_d from public.company_discovery_onboarding_drafts where id=v_p.draft_id;
  return jsonb_build_object('prepared',true,'preparationId',v_p.id,'draftId',v_p.draft_id,'draftHash',v_p.draft_hash,'sourceResultId',v_p.result_id,'sourceResultHash',v_p.result_hash,
    'draft_readback',jsonb_build_object('draft_id',v_d.id,'draft_version',v_d.version,'draft_hash',v_d.draft_hash,'draft',v_d.draft),
    'resume',case when v_resume.interview_id is not null then jsonb_build_object('interviewId',v_resume.interview_id,'priorCallId',v_resume.current_call_id) else null end);
end $$;

-- JSON is bounded before expansion/casts. This is not an alternate reducer:
-- TypeScript parses full domain invariants and SQL enforces persistence guards.
create function public.website_interview_validate_agenda(p_agenda jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_e jsonb; v_count bigint; v_candidate jsonb; v_queue jsonb; v_candidate_index bigint; v_previous_index bigint:=0; begin
  if p_agenda is null or octet_length(p_agenda::text)>2097152 or jsonb_typeof(p_agenda)<>'object'
    or p_agenda->'version' is distinct from '1'::jsonb or jsonb_typeof(p_agenda->'binding') is distinct from 'object'
    or jsonb_typeof(p_agenda->'items') is distinct from 'array' or jsonb_typeof(p_agenda->'ownerTurns') is distinct from 'array'
    or jsonb_typeof(p_agenda->'candidateContext') is distinct from 'array' or jsonb_typeof(p_agenda->'candidateOverrides') is distinct from 'array'
    or jsonb_typeof(p_agenda->'revision') is distinct from 'number'
    or coalesce((p_agenda->>'revision') ~ '^[0-9]{1,9}$',false)=false then raise exception using errcode='22023',message='interview_agenda_invalid'; end if;
  if (select count(*) from jsonb_object_keys(p_agenda))<>7 or (select count(*) from jsonb_object_keys(p_agenda->'binding'))<>6 then raise exception 'interview_agenda_fields_invalid'; end if;
  if jsonb_array_length(p_agenda->'items') not between 1 and 1024 or (p_agenda->>'revision')::bigint<>jsonb_array_length(p_agenda->'ownerTurns') then raise exception using errcode='22023',message='interview_agenda_counter_invalid'; end if;
  if jsonb_array_length(p_agenda->'candidateContext')>100 or jsonb_array_length(p_agenda->'candidateOverrides')>jsonb_array_length(p_agenda->'candidateContext') then raise exception 'interview_candidate_count_invalid'; end if;
  select count(distinct x->>'id') into v_count from jsonb_array_elements(p_agenda->'candidateContext') x;
  if v_count<>jsonb_array_length(p_agenda->'candidateContext') then raise exception 'interview_candidate_ids_invalid'; end if;
  for v_candidate in select value from jsonb_array_elements(p_agenda->'candidateContext') loop
    if jsonb_typeof(v_candidate) is distinct from 'object' then raise exception 'interview_candidate_metadata_invalid'; end if;
    if (select count(*) from jsonb_object_keys(v_candidate))<>4 or coalesce(v_candidate->>'id','') !~ '^candidate:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      or jsonb_typeof(v_candidate->'subject') is distinct from 'string' or jsonb_typeof(v_candidate->'questionPt') is distinct from 'string'
      or length(btrim(coalesce(v_candidate->>'subject',''))) not between 1 and 4096 or length(btrim(coalesce(v_candidate->>'questionPt',''))) not between 1 and 8192
      or v_candidate->'coverageRefs' is distinct from jsonb_build_array('discovery.candidate.'||replace(substring(v_candidate->>'id' from 11),'-',''))
      or exists(select 1 from jsonb_array_elements(p_agenda->'items') item where item->>'id'=v_candidate->>'id') then raise exception 'interview_candidate_metadata_invalid'; end if;
  end loop;
  for v_item in select value from jsonb_array_elements(p_agenda->'candidateOverrides') loop
    select value,n into v_candidate,v_candidate_index from jsonb_array_elements(p_agenda->'candidateContext') with ordinality c(value,n) where value->>'id'=v_item->>'id';
    if v_candidate is null or (v_item-array['source','relatedItemIds','blocking','status','answerRevision','clarificationCount','lastQuestionPt','evidence']) is distinct from v_candidate
      or v_item->>'source' is distinct from 'contradiction' or v_item->'relatedItemIds' is distinct from '[]'::jsonb or v_item->'blocking' is distinct from 'true'::jsonb then raise exception 'interview_candidate_override_invalid'; end if;
    if v_candidate_index<=v_previous_index then raise exception 'interview_candidate_override_order_invalid'; end if;
    v_previous_index:=v_candidate_index;
  end loop;
  v_queue:=p_agenda->'items'||(p_agenda->'candidateOverrides');
  select count(distinct x->>'id') into v_count from jsonb_array_elements(v_queue) x;
  if v_count<>jsonb_array_length(v_queue) then raise exception 'interview_item_ids_invalid'; end if;
  select count(distinct x->>'turnId') into v_count from jsonb_array_elements(p_agenda->'ownerTurns') x;
  if v_count<>jsonb_array_length(p_agenda->'ownerTurns') then raise exception 'interview_turn_ids_invalid'; end if;
  for v_e in select value from jsonb_array_elements(p_agenda->'ownerTurns') loop
    if jsonb_typeof(v_e) is distinct from 'object' or length(btrim(coalesce(v_e->>'turnId',''))) not between 1 and 512 or length(btrim(coalesce(v_e->>'text',''))) not between 1 and 32768 then raise exception 'interview_turn_invalid'; end if;
    if (select count(*) from jsonb_object_keys(v_e))<>2 then raise exception 'interview_turn_invalid'; end if;
  end loop;
  for v_item in select value from jsonb_array_elements(v_queue) loop
    if jsonb_typeof(v_item) is distinct from 'object' or length(btrim(coalesce(v_item->>'id',''))) not between 1 and 512
      or jsonb_typeof(v_item->'id') is distinct from 'string' or jsonb_typeof(v_item->'subject') is distinct from 'string' or jsonb_typeof(v_item->'questionPt') is distinct from 'string'
      or length(btrim(coalesce(v_item->>'subject',''))) not between 1 and 4096
      or length(btrim(coalesce(v_item->>'questionPt',''))) not between 1 and 8192
      or v_item->>'lastQuestionPt' is distinct from v_item->>'questionPt'
      or coalesce(v_item->>'status','') not in ('open','awaiting_clarification','answered','corrected','not_applicable','deferred_owner_review')
      or coalesce(v_item->>'source','') not in ('missing_website_information','ambiguity','contradiction','owner_private_requirement')
      or jsonb_typeof(v_item->'coverageRefs') is distinct from 'array' or jsonb_typeof(v_item->'relatedItemIds') is distinct from 'array'
      or jsonb_typeof(v_item->'blocking') is distinct from 'boolean' or jsonb_typeof(v_item->'evidence') is distinct from 'array'
      or jsonb_typeof(v_item->'answerRevision') is distinct from 'number' or jsonb_typeof(v_item->'clarificationCount') is distinct from 'number'
      or coalesce((v_item->>'answerRevision') ~ '^[0-9]{1,9}$',false)=false
      or coalesce((v_item->>'clarificationCount') ~ '^[0-2]$',false)=false then raise exception 'interview_item_invalid'; end if;
    if (select count(*) from jsonb_object_keys(v_item))<>12 then raise exception 'interview_item_fields_invalid'; end if;
    if jsonb_array_length(v_item->'coverageRefs')>4096 or jsonb_array_length(v_item->'relatedItemIds')>1024
      or exists(select 1 from jsonb_array_elements(v_item->'relatedItemIds') ref where jsonb_typeof(ref)<>'string' or ref#>>'{}'=v_item->>'id' or not exists(select 1 from jsonb_array_elements(v_queue) x where x->>'id'=ref#>>'{}'))
      or exists(select 1 from jsonb_array_elements(v_item->'coverageRefs') ref where jsonb_typeof(ref)<>'string' or length(btrim(ref#>>'{}')) not between 1 and 512)
      or (select count(distinct ref) from jsonb_array_elements(v_item->'relatedItemIds') ref)<>jsonb_array_length(v_item->'relatedItemIds')
      or (select count(distinct ref) from jsonb_array_elements(v_item->'coverageRefs') ref)<>jsonb_array_length(v_item->'coverageRefs') then raise exception 'interview_seed_references_invalid'; end if;
    if (v_item->>'answerRevision')::bigint>jsonb_array_length(v_item->'evidence') then raise exception 'interview_evidence_counter_invalid'; end if;
    for v_e in select value from jsonb_array_elements(v_item->'evidence') loop
      if not (p_agenda->'ownerTurns' @> jsonb_build_array(v_e)) then raise exception 'interview_evidence_not_owner_turn'; end if;
    end loop;
  end loop;
end $$;

create function public.website_interview_action(p_agenda jsonb,p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_next jsonb; v_type text; v_prefix text; v_id text; v_b jsonb:=p_agenda->'binding'; begin
  select value into v_next from jsonb_array_elements(p_agenda->'items'||(p_agenda->'candidateOverrides')) with ordinality x(value,n) where value->>'status' in ('open','awaiting_clarification') order by n limit 1;
  v_type:=case p_kind when 'off_scope' then 'DEFER_OFF_SCOPE_AND_CONTINUE' when 'correction' then 'HANDLE_OWNER_CORRECTION'
    when 'clarification' then case when v_next->>'status'='awaiting_clarification' then 'CLARIFY_CURRENT_GAP' else 'CONFIRM_AND_ASK_NEXT' end
    when 'initial' then case when v_next->>'status'='awaiting_clarification' then 'CLARIFY_CURRENT_GAP' else 'ASK_NEXT_GAP' end
    else 'CONFIRM_AND_ASK_NEXT' end;
  if v_next is null and v_type not in ('HANDLE_OWNER_CORRECTION','DEFER_OFF_SCOPE_AND_CONTINUE') then v_type:='GENERATE_FINAL_SUMMARY'; end if;
  v_prefix:=case v_type when 'ASK_NEXT_GAP' then '' when 'CLARIFY_CURRENT_GAP' then 'Para esclarecer: '
    when 'CONFIRM_AND_ASK_NEXT' then 'Obrigado, registrei sua resposta. '
    when 'DEFER_OFF_SCOPE_AND_CONTINUE' then 'Podemos tratar disso depois; agora vamos concluir sua configuração. '
    when 'GENERATE_FINAL_SUMMARY' then 'Vou preparar o resumo para sua revisão.' when 'HANDLE_OWNER_CORRECTION' then 'Registrei sua correção. ' end;
  v_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(1,v_b->>'interviewId',v_b->>'callId',v_b->>'draftId',v_b->>'draftHash',v_b->>'sourceResultId',v_b->>'sourceResultHash',(p_agenda->>'revision')::bigint,v_next->>'id',v_type)),'sha256'),'hex');
  return jsonb_strip_nulls(jsonb_build_object('type',v_type,'actionId',v_id,'itemId',v_next->>'id','questionPt',v_next->>'questionPt','spokenPt',v_prefix||coalesce(v_next->>'questionPt',case when v_type='GENERATE_FINAL_SUMMARY' then '' else 'Vou preparar o resumo para sua revisão.' end)));
end $$;

create function public.website_interview_readback(p_interview uuid,p_replayed boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_i public.website_interviews; begin
  select * into strict v_i from public.website_interviews where interview_id=p_interview;
  return jsonb_build_object('agenda',v_i.agenda,'revision',(v_i.agenda->>'revision')::bigint,'storeVersion',v_i.db_version,'digest',v_i.digest,'receiptId',v_i.receipt_id,'state',v_i.state,'replayed',p_replayed,
    'nextAction',v_i.next_action);
end $$;

create function public.initialize_website_interview(p_owner uuid,p_call uuid,p_request uuid,p_preparation uuid,p_agenda jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_p public.website_interview_preparations; v_i public.website_interviews; v_receipt uuid:=gen_random_uuid(); v_digest text; v_binding jsonb; v_action jsonb; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  select * into v_p from public.website_interview_preparations where id=p_preparation and tenant_id=v_tenant and owner_id=p_owner for update;
  if v_p.id is null then raise exception using errcode='42501',message='interview_preparation_not_bound'; end if;
  select * into v_i from public.website_interviews where preparation_id=p_preparation for update;
  if v_i.interview_id is not null then
    if v_i.current_call_id<>p_call or not exists(select 1 from public.website_interview_calls where call_id=p_call and request_id=p_request) then raise exception 'interview_preparation_consumed'; end if;
    perform public.website_interview_validate_agenda(p_agenda);
    if not exists(select 1 from public.receipts r where r.tenant_id=v_tenant and r.kind='website_interview'
      and r.external_id='website-interview:'||p_call::text||':initialize'
      and r.payload_hash=encode(extensions.digest(public.onboarding_canonical_json_v1(p_agenda),'sha256'),'hex')) then
      raise exception using errcode='23505',message='interview_initialization_conflict'; end if;
    return public.website_interview_readback(v_i.interview_id,true);
  end if;
  if v_p.consumed_call_id is not null then raise exception 'interview_preparation_consumed'; end if;
  if v_p.generation is distinct from (select test_memory_generation from public.tenants where id=v_tenant)
    or not public.website_interview_source_valid(v_tenant,p_owner,v_p.draft_id,v_p.draft_hash,v_p.result_id,v_p.result_hash) then raise exception using errcode='40001',message='interview_selected_draft_changed'; end if;
  if not public.website_interview_prior_settled(v_tenant,p_owner,v_p.prior_call_id,v_p.generation) then raise exception 'interview_prior_not_settled'; end if;
  if exists(select 1 from public.calls where tenant_id=v_tenant and status='active' and id<>p_call) then raise exception 'interview_competing_active_call'; end if;
  if (select started_at from public.calls where id=p_call)<v_p.created_at then raise exception 'interview_call_predates_preparation'; end if;
  perform public.website_interview_validate_agenda(p_agenda);
  v_binding:=jsonb_build_object('interviewId',p_call,'callId',p_call,'draftId',v_p.draft_id,'draftHash',v_p.draft_hash,'sourceResultId',v_p.result_id,'sourceResultHash',v_p.result_hash);
  if p_agenda->'binding' is distinct from v_binding or p_agenda->>'revision'<>'0' or p_agenda->'ownerTurns'<>'[]'::jsonb
    or p_agenda->'candidateOverrides' is distinct from '[]'::jsonb
    or exists(select 1 from jsonb_array_elements(p_agenda->'items') x where x->>'status'<>'open' or x->>'answerRevision'<>'0' or x->>'clarificationCount'<>'0' or x->'evidence'<>'[]'::jsonb) then raise exception 'interview_initial_seed_invalid'; end if;
  if jsonb_array_length(p_agenda->'candidateContext')<>(select jsonb_array_length(draft->'candidate_facts') from public.company_discovery_onboarding_drafts where id=v_p.draft_id)
    or exists(select 1 from jsonb_array_elements(p_agenda->'candidateContext') context where not exists(
      select 1 from public.company_discovery_onboarding_drafts d,jsonb_array_elements(d.draft->'candidate_facts') fact where d.id=v_p.draft_id
        and 'candidate:'||(fact->>'claim_id')=context->>'id' and fact->>'claim_type'=context->>'subject')) then raise exception 'interview_candidate_source_mismatch'; end if;
  v_digest:=encode(extensions.digest(public.onboarding_canonical_json_v1(p_agenda),'sha256'),'hex');
  v_action:=public.website_interview_action(p_agenda,'initial');
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_tenant,p_call,'website_interview','accepted','website-interview:'||p_call::text||':initialize',v_digest,jsonb_build_object('agenda',p_agenda,'nextAction',v_action),jsonb_build_object('preparationId',p_preparation,'dbVersion',0));
  insert into public.website_interviews(interview_id,preparation_id,tenant_id,owner_id,generation,current_call_id,agenda,next_action,digest,state,receipt_id)
    values(p_call,p_preparation,v_tenant,p_owner,v_p.generation,p_call,p_agenda,v_action,v_digest,'unfinished',v_receipt);
  insert into public.website_interview_calls(call_id,request_id,interview_id,tenant_id) values(p_call,p_request,p_call,v_tenant);
  update public.website_interview_preparations set consumed_call_id=p_call,consumed_at=clock_timestamp() where id=p_preparation;
  return public.website_interview_readback(p_call);
end $$;

create function public.read_website_interview(p_owner uuid,p_call uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_interview uuid; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request,false);
  select i.interview_id into v_interview from public.website_interviews i join public.website_interview_calls c on c.interview_id=i.interview_id where c.call_id=p_call and c.request_id=p_request and i.current_call_id=p_call and i.tenant_id=v_tenant;
  if v_interview is null then raise exception 'interview_binding_missing_or_superseded'; end if;
  return public.website_interview_readback(v_interview);
end $$;

create function public.record_website_interview_owner_turn(p_owner uuid,p_call uuid,p_request uuid,p_item text,p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_existing text; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  if not exists(select 1 from public.website_interview_calls c join public.website_interviews i on i.interview_id=c.interview_id where c.call_id=p_call and c.request_id=p_request and i.current_call_id=p_call and i.state<>'complete') then raise exception 'interview_not_current'; end if;
  if p_item is null or length(btrim(p_item)) not between 1 and 400 or p_text is null or length(btrim(p_text))<1 or length(p_text)>32768 then raise exception 'interview_owner_transcript_invalid'; end if;
  select owner_text into v_existing from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
  if v_existing is not null and v_existing<>p_text then raise exception using errcode='23505',message='interview_owner_transcript_conflict'; end if;
  if v_existing is null then insert into public.website_interview_owner_turns(call_id,provider_item_id,tenant_id,owner_text) values(p_call,p_item,v_tenant,p_text); end if;
  return jsonb_build_object('callId',p_call,'turnId',p_call::text||':'||p_item,'providerItemId',p_item,'text',p_text,'replayed',v_existing is not null);
end $$;

create function public.commit_website_interview_turn(p_owner uuid,p_call uuid,p_request uuid,p_revision bigint,p_store_version bigint,p_digest text,p_item text,p_agenda jsonb,p_proposal_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_i public.website_interviews; v_old jsonb; v_new jsonb; v_turn jsonb; v_current jsonb; v_current_new jsonb; v_text text; v_old_queue jsonb; v_new_queue jsonb; v_context jsonb;
  v_receipt uuid:=gen_random_uuid(); v_digest text; v_key text; v_prior public.receipts; v_action jsonb; v_changed int:=0; v_expected_status text; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  select i.* into v_i from public.website_interviews i join public.website_interview_calls c on c.interview_id=i.interview_id where c.call_id=p_call and c.request_id=p_request and i.current_call_id=p_call and i.tenant_id=v_tenant for update of i;
  if v_i.interview_id is null or v_i.state='complete' then raise exception 'interview_not_current'; end if;
  select owner_text into v_text from public.website_interview_owner_turns where call_id=p_call and provider_item_id=p_item;
  if v_text is null then raise exception 'interview_authoritative_owner_turn_missing'; end if;
  if coalesce(p_proposal_kind,'') not in ('answer','clarification','off_scope','defer','not_applicable','correction') then raise exception 'interview_proposal_kind_invalid'; end if;
  perform public.website_interview_validate_agenda(p_agenda);
  v_digest:=encode(extensions.digest(public.onboarding_canonical_json_v1(p_agenda),'sha256'),'hex');
  v_key:='website-interview:'||p_call::text||':turn:'||p_item;
  select * into v_prior from public.receipts where tenant_id=v_tenant and kind='website_interview' and external_id=v_key;
  if v_prior.id is not null then
    if v_prior.payload_hash<>v_digest or v_prior.detail->>'expectedDigest' is distinct from p_digest or (v_prior.detail->>'expectedStoreVersion')::bigint is distinct from p_store_version or (v_prior.detail->>'expectedRevision')::bigint is distinct from p_revision or v_prior.detail->>'proposalKind' is distinct from p_proposal_kind then raise exception using errcode='23505',message='interview_turn_replay_conflict'; end if;
    return public.website_interview_readback(v_i.interview_id,true);
  end if;
  if v_i.digest is distinct from p_digest or v_i.db_version is distinct from p_store_version or (v_i.agenda->>'revision')::bigint is distinct from p_revision then raise exception using errcode='40001',message='interview_revision_changed'; end if;
  v_turn:=jsonb_build_object('turnId',p_call::text||':'||p_item,'text',v_text);
  if p_agenda->'binding' is distinct from v_i.agenda->'binding' or (p_agenda->>'revision')::bigint<>p_revision+1
    or p_agenda->'ownerTurns' is distinct from (v_i.agenda->'ownerTurns'||jsonb_build_array(v_turn))
    or jsonb_array_length(p_agenda->'items')<>jsonb_array_length(v_i.agenda->'items') then raise exception 'interview_identity_or_turn_changed'; end if;
  if p_agenda->'candidateContext' is distinct from v_i.agenda->'candidateContext' or jsonb_array_length(p_agenda->'candidateOverrides')<jsonb_array_length(v_i.agenda->'candidateOverrides')
    or exists(select 1 from jsonb_array_elements(v_i.agenda->'candidateOverrides') old_override where not exists(select 1 from jsonb_array_elements(p_agenda->'candidateOverrides') new_override where new_override->>'id'=old_override->>'id')) then raise exception 'interview_candidate_context_changed'; end if;
  v_old_queue:=v_i.agenda->'items'||(v_i.agenda->'candidateOverrides');
  v_new_queue:=p_agenda->'items'||(p_agenda->'candidateOverrides');
  select value into v_current from jsonb_array_elements(v_old_queue) with ordinality x(value,n) where value->>'status' in ('open','awaiting_clarification') order by n limit 1;
  select value into v_current_new from jsonb_array_elements(v_new_queue) where value->>'id'=v_current->>'id';
  for v_idx in 0..jsonb_array_length(v_new_queue)-1 loop
    v_new:=v_new_queue->v_idx;
    if v_idx<jsonb_array_length(p_agenda->'items') then v_old:=v_old_queue->v_idx;
    else select value into v_old from jsonb_array_elements(v_i.agenda->'candidateOverrides') where value->>'id'=v_new->>'id'; end if;
    if v_old is null then
      if p_proposal_kind<>'correction' then raise exception 'interview_candidate_override_requires_correction'; end if;
      select value into v_context from jsonb_array_elements(p_agenda->'candidateContext') where value->>'id'=v_new->>'id';
      if v_context is null then raise exception 'interview_candidate_source_mismatch'; end if;
      v_old:=v_context||jsonb_build_object('source','contradiction','relatedItemIds','[]'::jsonb,'blocking',true,'status','open','answerRevision',0,'clarificationCount',0,'lastQuestionPt',v_context->>'questionPt','evidence','[]'::jsonb);
    end if;
    if (v_old-array['status','answerRevision','clarificationCount','evidence']) is distinct from (v_new-array['status','answerRevision','clarificationCount','evidence']) then raise exception 'interview_immutable_seed_changed'; end if;
    if v_old is distinct from v_new then
      v_changed:=v_changed+1;
      if v_new->'evidence' is distinct from (v_old->'evidence'||jsonb_build_array(v_turn))
        or (v_new->>'answerRevision')::bigint not between (v_old->>'answerRevision')::bigint and (v_old->>'answerRevision')::bigint+1
        or (v_new->>'clarificationCount')::int not between (v_old->>'clarificationCount')::int and (v_old->>'clarificationCount')::int+1 then raise exception 'interview_atomic_evidence_invalid'; end if;
      if v_old->>'id' is distinct from v_current->>'id' and not coalesce(v_current->'relatedItemIds' ? (v_old->>'id'),false)
        and not (p_proposal_kind='correction' and v_new->>'status' in ('corrected','open') and (v_new->>'answerRevision')::bigint=(v_old->>'answerRevision')::bigint+1) then raise exception 'interview_noncurrent_unrelated_item'; end if;
      if (v_new->>'status' in ('answered','corrected','not_applicable') or (v_new->>'status'='open' and p_proposal_kind='correction')) and (v_new->>'answerRevision')::bigint<>(v_old->>'answerRevision')::bigint+1 then raise exception 'interview_atomic_counter_invalid'; end if;
      if v_old->>'id' is distinct from v_current->>'id' and v_new->>'status'='answered'
        and (v_current_new is not distinct from v_current or v_current_new->>'status' not in ('answered','corrected')) then raise exception 'interview_related_without_current'; end if;
      if p_proposal_kind in ('answer','correction','not_applicable') then
        v_expected_status:=case p_proposal_kind when 'answer' then case when (v_old->>'answerRevision')::bigint>0 then 'corrected' else 'answered' end when 'not_applicable' then 'not_applicable' else v_new->>'status' end;
        if v_new->>'status' is distinct from v_expected_status or v_new->>'clarificationCount' is distinct from v_old->>'clarificationCount'
          or (p_proposal_kind='correction' and v_new->>'status' not in ('corrected','open'))
          or (p_proposal_kind='not_applicable' and v_old->>'id' is distinct from v_current->>'id') then raise exception 'interview_proposal_transition_invalid'; end if;
      else
        v_expected_status:=case when p_proposal_kind='defer' or (v_old->>'clarificationCount')::int>=2 then 'deferred_owner_review' when p_proposal_kind='clarification' then 'awaiting_clarification' else v_old->>'status' end;
        if v_old->>'id' is distinct from v_current->>'id' or v_new->>'answerRevision' is distinct from v_old->>'answerRevision'
          or v_new->>'status' is distinct from v_expected_status
          or (v_new->>'clarificationCount')::int<>least(2,(v_old->>'clarificationCount')::int+case when p_proposal_kind='defer' then 0 else 1 end) then raise exception 'interview_proposal_transition_invalid'; end if;
      end if;
    end if;
  end loop;
  if (p_proposal_kind<>'off_scope' and v_changed=0) or (v_current is not null and p_proposal_kind<>'correction' and v_current_new is not distinct from v_current) then raise exception 'interview_current_transition_missing'; end if;
  v_action:=public.website_interview_action(p_agenda,p_proposal_kind);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_tenant,p_call,'website_interview','accepted',v_key,v_digest,jsonb_build_object('agenda',p_agenda,'nextAction',v_action),jsonb_build_object('turnId',v_turn->>'turnId','proposalKind',p_proposal_kind,'expectedDigest',p_digest,'expectedStoreVersion',p_store_version,'expectedRevision',p_revision,'dbVersion',v_i.db_version+1));
  update public.website_interviews set agenda=p_agenda,next_action=v_action,digest=v_digest,db_version=db_version+1,receipt_id=v_receipt,
    state=case when exists(select 1 from jsonb_array_elements(v_new_queue) x where x->>'status' in ('open','awaiting_clarification')) then 'unfinished' else 'reviewing' end where interview_id=v_i.interview_id;
  return public.website_interview_readback(v_i.interview_id);
end $$;

create function public.attach_website_interview(p_owner uuid,p_call uuid,p_request uuid,p_interview uuid,p_prior_call uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_i public.website_interviews; v_agenda jsonb; v_digest text; v_receipt uuid:=gen_random_uuid(); v_action jsonb; begin
  v_tenant:=public.website_interview_scope(p_owner,p_call,p_request);
  select * into v_i from public.website_interviews where interview_id=p_interview and tenant_id=v_tenant and owner_id=p_owner for update;
  if v_i.interview_id is null or v_i.state<>'unfinished' then raise exception 'interview_not_resumable'; end if;
  if v_i.current_call_id=p_call and exists(select 1 from public.website_interview_calls where call_id=p_call and request_id=p_request) then return public.website_interview_readback(p_interview,true); end if;
  if v_i.current_call_id is distinct from p_prior_call or v_i.generation is distinct from (select test_memory_generation from public.tenants where id=v_tenant)
    or not public.website_interview_prior_settled(v_tenant,p_owner,p_prior_call,v_i.generation) then raise exception 'interview_resume_source_changed'; end if;
  if exists(select 1 from public.calls where tenant_id=v_tenant and status='active' and id<>p_call)
    or exists(select 1 from public.website_interview_preparations where tenant_id=v_tenant and consumed_call_id is null)
    or exists(select 1 from public.website_interviews where tenant_id=v_tenant and created_at>v_i.created_at) then raise exception 'interview_resume_competing_lineage'; end if;
  v_agenda:=jsonb_set(v_i.agenda,'{binding,callId}',to_jsonb(p_call::text));
  v_digest:=encode(extensions.digest(public.onboarding_canonical_json_v1(v_agenda),'sha256'),'hex');
  v_action:=public.website_interview_action(v_agenda,'initial');
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_tenant,p_call,'website_interview','accepted','website-interview:'||p_call::text||':attach',v_digest,jsonb_build_object('agenda',v_agenda,'nextAction',v_action),jsonb_build_object('priorCallId',p_prior_call,'dbVersion',v_i.db_version+1));
  insert into public.website_interview_calls(call_id,request_id,interview_id,tenant_id) values(p_call,p_request,p_interview,v_tenant);
  update public.website_interviews set current_call_id=p_call,agenda=v_agenda,next_action=v_action,digest=v_digest,db_version=db_version+1,receipt_id=v_receipt where interview_id=p_interview;
  return public.website_interview_readback(p_interview);
end $$;

-- Every helper is private; only bounded RPCs can be invoked by the service role.
do $$ declare v_function record; begin
  for v_function in select p.oid::regprocedure as signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
    (p.proname like 'website_interview_%' or p.proname in ('prepare_fresh_website_interview','resolve_prepared_website_source','initialize_website_interview','read_website_interview','record_website_interview_owner_turn','commit_website_interview_turn','attach_website_interview')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.signature);
    if v_function.proname not like 'website_interview_%' then execute format('grant execute on function %s to service_role',v_function.signature); end if;
  end loop;
end $$;
commit;
