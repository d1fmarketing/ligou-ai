-- DirectModel Company Discovery Stage 0B.
-- Website facts remain immutable evidence and populate only a versioned
-- onboarding draft. They never approve a rule, grant a power, or change the
-- operational mode. OpenClaw/result.v1 remains preserved and disabled.

alter table public.worker_results
  drop constraint if exists worker_results_result_schema_check;
alter table public.worker_results
  add constraint worker_results_result_schema_check check (
    result_schema in (
      'company_discovery.result.v1',
      'company_discovery.result.v2'
    )
  );

alter table public.discovery_claims
  add column adapter_id text,
  add column provider text,
  add column model text,
  add column confidence text,
  add column contradiction_status text,
  add column missing_fields jsonb not null default '[]'::jsonb,
  add column ambiguous_fields jsonb not null default '[]'::jsonb,
  add column claim_schema_version text not null
    default 'company_discovery.claim.v1';

alter table public.discovery_claims
  add constraint discovery_claims_stage0b_provenance_check check (
    (
      claim_schema_version = 'company_discovery.claim.v1'
      and adapter_id is null
      and provider is null
      and model is null
      and confidence is null
      and contradiction_status is null
    )
    or (
      claim_schema_version = 'company_discovery.claim.v2'
      and adapter_id = 'direct_model'
      and provider = 'openai-codex'
      and model = 'gpt-5.6-sol'
      and confidence in ('high', 'medium', 'low')
      and contradiction_status in ('none', 'possible', 'confirmed')
    )
  ),
  add constraint discovery_claims_stage0b_gap_arrays_check check (
    jsonb_typeof(missing_fields) = 'array'
    and jsonb_typeof(ambiguous_fields) = 'array'
  );

alter table public.company_discovery_review_nonces
  drop constraint if exists company_discovery_review_nonces_claim_ids_check;
alter table public.company_discovery_review_nonces
  add constraint company_discovery_review_nonces_claim_ids_check check (
    cardinality(claim_ids) between 0 and 100
    and array_position(claim_ids, null) is null
  );

create table public.company_discovery_onboarding_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  version bigint not null check (version > 0),
  source_job_id uuid not null,
  source_result_id uuid not null,
  decision_ids uuid[] not null,
  draft jsonb not null,
  draft_hash text not null check (draft_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users (id),
  created_at timestamp with time zone not null default now(),
  unique (tenant_id, version),
  unique (id, tenant_id),
  foreign key (source_job_id, tenant_id)
    references public.worker_jobs (id, tenant_id),
  foreign key (source_result_id, tenant_id)
    references public.worker_results (id, tenant_id),
  check (
    cardinality(decision_ids) > 0
    or jsonb_array_length(draft->'unresolved_items') > 0
  ),
  check (jsonb_typeof(draft) = 'object'),
  check (draft->>'schema_version' = 'company_discovery.onboarding_draft.v1'),
  check (draft->'authority' = '{
    "rules_approved": false,
    "powers_granted": false,
    "operational_mode_changed": false
  }'::jsonb)
);

alter table public.discovery_decisions
  add column resulting_onboarding_draft_id uuid
    references public.company_discovery_onboarding_drafts (id);

create trigger company_discovery_onboarding_drafts_append_only
  before update or delete on public.company_discovery_onboarding_drafts
  for each row execute function public.block_mutation();

alter table public.company_discovery_onboarding_drafts enable row level security;
alter table public.company_discovery_onboarding_drafts force row level security;

create policy company_discovery_onboarding_drafts_owner_select
  on public.company_discovery_onboarding_drafts for select to authenticated
  using (exists (
    select 1 from public.tenants t
    where t.id = company_discovery_onboarding_drafts.tenant_id
      and t.owner_user_id = (select auth.uid())
  ));

revoke all on table public.company_discovery_onboarding_drafts
  from public, anon, authenticated, service_role;
grant select on table public.company_discovery_onboarding_drafts
  to authenticated, service_role;

alter table public.receipts drop constraint if exists receipts_kind_check;
alter table public.receipts add constraint receipts_kind_check check (
  kind in (
    'booking', 'booking_cancel', 'rule_change', 'power_change', 'notification',
    'onboarding_coverage', 'onboarding_voice_approval',
    'onboarding_event_alias', 'onboarding_discovery_fallback'
  )
);

create unique index receipts_onboarding_discovery_fallback_call_unique
  on public.receipts (tenant_id, call_id)
  where kind = 'onboarding_discovery_fallback';

create or replace function public.company_discovery_v2_price_valid(
  p_value jsonb,
  p_nullable boolean default true
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_amount text;
  v_currency text;
  v_qualifier text;
  v_condition text;
begin
  if p_value = 'null'::jsonb then return p_nullable; end if;
  if jsonb_typeof(p_value) <> 'object'
     or not (p_value ?& array['amount','currency','qualifier','condition'])
     or (p_value - array['amount','currency','qualifier','condition']::text[])
       <> '{}'::jsonb then return false;
  end if;
  v_amount := case when p_value->'amount' = 'null'::jsonb
    then null else p_value->>'amount' end;
  v_currency := case when p_value->'currency' = 'null'::jsonb
    then null else p_value->>'currency' end;
  v_qualifier := p_value->>'qualifier';
  v_condition := case when p_value->'condition' = 'null'::jsonb
    then null else p_value->>'condition' end;
  if v_qualifier not in (
       'fixed','starting_at','estimate','promotional','conditional','unknown'
     )
     or (v_amount is null) <> (v_currency is null)
     or (v_amount is not null and v_amount !~
       '^(0|[1-9][0-9]{0,8})[.][0-9]{2}$')
     or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
     or (v_condition is not null and length(v_condition) not between 1 and 1000)
     or (v_qualifier in ('fixed','starting_at','conditional') and v_amount is null)
     or (v_qualifier = 'unknown' and v_amount is not null)
     or (v_qualifier = 'conditional' and v_condition is null) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function public.company_discovery_v2_price_valid(jsonb,boolean)
  from public, anon, authenticated, service_role;

create or replace function public.company_discovery_v2_value_valid(
  p_claim_class text,
  p_claim_type text,
  p_value jsonb
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_interval jsonb;
  v_days text[];
  v_closed text[];
  v_coverage text[];
  v_duration jsonb;
begin
  if p_claim_class = 'descriptive' then
    return p_claim_type in (
      'business_name','business_description','public_phone',
      'public_email','public_address','public_website'
    ) and jsonb_typeof(p_value) = 'string'
      and length(p_value #>> '{}') between 1 and 2000;
  end if;
  if p_claim_class = 'safety_critical' then
    return p_claim_type = 'emergency'
      and jsonb_typeof(p_value) = 'object'
      and (p_value - array['guidance']::text[]) = '{}'::jsonb
      and jsonb_typeof(p_value->'guidance') = 'string'
      and length(p_value->>'guidance') between 1 and 2000;
  end if;
  if p_claim_class <> 'operational' then return false; end if;

  if p_claim_type = 'service' then
    return jsonb_typeof(p_value) = 'object'
      and (p_value ?& array[
        'service_type','service_names','public_price','duration_minutes'
      ])
      and (p_value - array[
        'service_type','service_names','public_price','duration_minutes'
      ]::text[]) = '{}'::jsonb
      and coalesce(p_value->>'service_type','') ~
        '^[a-z0-9][a-z0-9_]{0,199}$'
      and jsonb_typeof(p_value->'service_names') = 'array'
      and jsonb_array_length(p_value->'service_names') between 1 and 20
      and not exists (
        select 1 from jsonb_array_elements(p_value->'service_names') item
        where jsonb_typeof(item) <> 'string'
          or length(item #>> '{}') not between 1 and 200
      )
      and public.company_discovery_v2_price_valid(
        p_value->'public_price', true
      )
      and (
        jsonb_typeof(p_value->'duration_minutes') = 'null'
        or (
          jsonb_typeof(p_value->'duration_minutes') = 'number'
          and (p_value->>'duration_minutes') ~ '^[0-9]+$'
          and (p_value->>'duration_minutes')::integer between 1 and 10080
        )
      );
  end if;

  if p_claim_type = 'service_territory' then
    if jsonb_typeof(p_value) <> 'object'
       or not (p_value ?& array[
         'service_type','included_areas','excluded_areas','radius'
       ])
       or (p_value - array[
         'service_type','included_areas','excluded_areas','radius'
       ]::text[]) <> '{}'::jsonb
       or not (
         jsonb_typeof(p_value->'service_type') = 'null'
         or (
           jsonb_typeof(p_value->'service_type') = 'string'
           and p_value->>'service_type' ~ '^[a-z0-9][a-z0-9_]{0,199}$'
         )
       )
       or jsonb_typeof(p_value->'included_areas') <> 'array'
       or jsonb_typeof(p_value->'excluded_areas') <> 'array'
       or jsonb_array_length(p_value->'included_areas') > 50
       or jsonb_array_length(p_value->'excluded_areas') > 50 then
      return false;
    end if;
    for v_item in
      select value from jsonb_array_elements(
        (p_value->'included_areas') || (p_value->'excluded_areas')
      )
    loop
      if jsonb_typeof(v_item) <> 'object'
         or not (v_item ?& array['kind','name','region_state','country_code'])
         or (v_item - array[
           'kind','name','region_state','country_code'
         ]::text[]) <> '{}'::jsonb
         or v_item->>'kind' not in (
           'city','county','region_state','postal_code','marketing_region'
         )
         or jsonb_typeof(v_item->'name') <> 'string'
         or length(v_item->>'name') not between 1 and 200
         or not (
           jsonb_typeof(v_item->'region_state') = 'null'
           or (
             jsonb_typeof(v_item->'region_state') = 'string'
             and length(v_item->>'region_state') between 1 and 100
           )
         )
         or not (
           jsonb_typeof(v_item->'country_code') = 'null'
           or (
             jsonb_typeof(v_item->'country_code') = 'string'
             and v_item->>'country_code' ~ '^[A-Z]{2}$'
           )
         ) then return false;
      end if;
    end loop;
    if jsonb_array_length(p_value->'included_areas') = 0
       and jsonb_array_length(p_value->'excluded_areas') = 0 then
      if jsonb_typeof(p_value->'radius') = 'null' then return false; end if;
    end if;
    if jsonb_typeof(p_value->'radius') <> 'null' then
      if jsonb_typeof(p_value->'radius') <> 'object'
         or ((p_value->'radius') - array[
           'distance','unit','center'
         ]::text[]) <> '{}'::jsonb
         or p_value->'radius'->>'distance' !~
           '^(0[.][0-9]*[1-9]|[1-9][0-9]{0,6}([.][0-9]{1,3})?)$'
         or p_value->'radius'->>'unit' not in ('miles','kilometers')
         or not (
           jsonb_typeof(p_value->'radius'->'center') = 'null'
           or (
             jsonb_typeof(p_value->'radius'->'center') = 'string'
             and length(p_value->'radius'->>'center') between 1 and 200
           )
         ) then return false;
      end if;
    end if;
    return true;
  end if;

  if p_claim_type = 'business_hours' then
    if jsonb_typeof(p_value) <> 'object'
       or not (p_value ?& array[
         'timezone','ordinary_intervals','closed_days','ordinary_24_7',
         'emergency_24_7','after_hours','holiday_policy'
       ])
       or (p_value - array[
         'timezone','ordinary_intervals','closed_days','ordinary_24_7',
         'emergency_24_7','after_hours','holiday_policy'
       ]::text[]) <> '{}'::jsonb
       or jsonb_typeof(p_value->'ordinary_intervals') <> 'array'
       or jsonb_array_length(p_value->'ordinary_intervals') > 14
       or jsonb_typeof(p_value->'closed_days') <> 'array'
       or jsonb_array_length(p_value->'closed_days') > 7
       or jsonb_typeof(p_value->'ordinary_24_7') <> 'boolean'
       or jsonb_typeof(p_value->'emergency_24_7') <> 'boolean'
       or p_value->>'after_hours' not in (
         'not_stated','unavailable','available','emergency_only'
       ) then return false;
    end if;
    select array_agg(value #>> '{}') into v_closed
    from jsonb_array_elements(p_value->'closed_days') value;
    if exists (
      select 1 from unnest(coalesce(v_closed, '{}'::text[])) day
      where day not in ('sun','mon','tue','wed','thu','fri','sat')
    ) or cardinality(coalesce(v_closed, '{}'::text[])) <>
      cardinality(array(select distinct day from unnest(
        coalesce(v_closed, '{}'::text[])
      ) day)) then return false;
    end if;
    for v_interval in select value from jsonb_array_elements(
      p_value->'ordinary_intervals'
    )
    loop
      if jsonb_typeof(v_interval) <> 'object'
         or (v_interval - array['days','opens','closes']::text[]) <> '{}'::jsonb
         or jsonb_typeof(v_interval->'days') <> 'array'
         or jsonb_array_length(v_interval->'days') not between 1 and 7
         or v_interval->>'opens' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_interval->>'closes' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_interval->>'opens' = v_interval->>'closes' then return false;
      end if;
      select array_agg(value #>> '{}') into v_days
      from jsonb_array_elements(v_interval->'days') value;
      if exists (
        select 1 from unnest(v_days) day
        where day not in ('sun','mon','tue','wed','thu','fri','sat')
          or day = any(coalesce(v_closed, '{}'::text[]))
      ) or cardinality(v_days) <>
        cardinality(array(select distinct day from unnest(v_days) day)) then
        return false;
      end if;
    end loop;
    if (p_value->>'ordinary_24_7')::boolean
       and (
         jsonb_array_length(p_value->'ordinary_intervals') <> 0
         or jsonb_array_length(p_value->'closed_days') <> 0
       ) then return false;
    end if;
    if (p_value->>'emergency_24_7')::boolean
       and p_value->>'after_hours' not in ('available','emergency_only') then
      return false;
    end if;
    return (
      jsonb_typeof(p_value->'timezone') = 'null'
      or (
        jsonb_typeof(p_value->'timezone') = 'string'
        and (
          p_value->>'timezone' = 'UTC'
          or p_value->>'timezone' ~ '^[A-Za-z_]+/[A-Za-z0-9_+.-]+$'
        )
      )
    ) and (
      jsonb_typeof(p_value->'holiday_policy') = 'null'
      or (
        jsonb_typeof(p_value->'holiday_policy') = 'string'
        and length(p_value->>'holiday_policy') between 1 and 2000
      )
    );
  end if;

  if p_claim_type = 'guarantee' then
    if jsonb_typeof(p_value) <> 'object'
       or not (p_value ?& array[
         'guarantee_kind','service_type','coverage','duration',
         'conditions','exclusions'
       ])
       or (p_value - array[
         'guarantee_kind','service_type','coverage','duration',
         'conditions','exclusions'
       ]::text[]) <> '{}'::jsonb
       or p_value->>'guarantee_kind' not in (
         'company_guarantee','manufacturer_warranty',
         'satisfaction_statement','case_by_case'
       )
       or not (
         jsonb_typeof(p_value->'service_type') = 'null'
         or p_value->>'service_type' ~ '^[a-z0-9][a-z0-9_]{0,199}$'
       )
       or jsonb_typeof(p_value->'coverage') <> 'array'
       or jsonb_array_length(p_value->'coverage') not between 1 and 5
       or jsonb_typeof(p_value->'conditions') <> 'array'
       or jsonb_array_length(p_value->'conditions') > 20
       or jsonb_typeof(p_value->'exclusions') <> 'array'
       or jsonb_array_length(p_value->'exclusions') > 20 then return false;
    end if;
    select array_agg(value #>> '{}') into v_coverage
    from jsonb_array_elements(p_value->'coverage') value;
    if exists (
      select 1 from unnest(v_coverage) item
      where item not in ('labor','parts','product','service','satisfaction')
    ) or cardinality(v_coverage) <>
      cardinality(array(select distinct item from unnest(v_coverage) item))
      or exists (
        select 1 from jsonb_array_elements(
          (p_value->'conditions') || (p_value->'exclusions')
        ) item where jsonb_typeof(item) <> 'string'
          or length(item #>> '{}') not between 1 and 1000
      ) then return false;
    end if;
    v_duration := p_value->'duration';
    if p_value->>'guarantee_kind' in (
         'satisfaction_statement','case_by_case'
       ) and jsonb_typeof(v_duration) <> 'null' then return false;
    end if;
    return jsonb_typeof(v_duration) = 'null' or (
      jsonb_typeof(v_duration) = 'object'
      and (v_duration - array['amount','unit']::text[]) = '{}'::jsonb
      and (v_duration->>'amount') ~ '^[0-9]+$'
      and (v_duration->>'amount')::integer between 1 and 10000
      and v_duration->>'unit' in ('days','months','years')
    );
  end if;

  if p_claim_type = 'booking_restriction' then
    return jsonb_typeof(p_value) = 'object'
      and (p_value ?& array[
        'restriction_type','service_type','rule','notice_minutes',
        'public_fee','conditions'
      ])
      and (p_value - array[
        'restriction_type','service_type','rule','notice_minutes',
        'public_fee','conditions'
      ]::text[]) = '{}'::jsonb
      and p_value->>'restriction_type' in (
        'same_day','advance_notice','weekend','sunday','emergency_only',
        'access','deposit','cancellation','no_show_fee','visit_fee',
        'customer_presence','service_specific'
      )
      and (
        jsonb_typeof(p_value->'service_type') = 'null'
        or p_value->>'service_type' ~ '^[a-z0-9][a-z0-9_]{0,199}$'
      )
      and p_value->>'rule' in (
        'allowed','not_allowed','required','conditional','fee_applies',
        'emergency_only'
      )
      and (
        jsonb_typeof(p_value->'notice_minutes') = 'null'
        or (
          jsonb_typeof(p_value->'notice_minutes') = 'number'
          and (p_value->>'notice_minutes') ~ '^[0-9]+$'
          and (p_value->>'notice_minutes')::integer between 1 and 525600
        )
      )
      and public.company_discovery_v2_price_valid(
        p_value->'public_fee', true
      )
      and jsonb_typeof(p_value->'conditions') = 'array'
      and jsonb_array_length(p_value->'conditions') between 1 and 20
      and not exists (
        select 1 from jsonb_array_elements(p_value->'conditions') item
        where jsonb_typeof(item) <> 'string'
          or length(item #>> '{}') not between 1 and 1000
      );
  end if;
  return false;
exception when others then
  return false;
end;
$$;

revoke all on function public.company_discovery_v2_value_valid(text,text,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.commit_company_discovery_result_v2(
  p_attempt_id uuid,
  p_fence_generation bigint,
  p_claim_token text,
  p_result jsonb,
  p_result_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.worker_attempts;
  v_job public.worker_jobs;
  v_result_id uuid := gen_random_uuid();
  v_actual_hash text;
  v_snapshot jsonb;
  v_snapshot_id uuid;
  v_snapshot_ids uuid[] := '{}'::uuid[];
  v_claim jsonb;
  v_evidence_ids uuid[];
  v_order integer;
  v_collection text;
  v_area jsonb;
  v_area_index bigint;
  v_required_gap text;
begin
  select a.* into v_attempt
  from public.worker_attempts a
  where a.id = p_attempt_id
  for update;
  if v_attempt.id is null then
    raise exception using errcode = '55000',
      message = 'company_discovery_attempt_not_found';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  where j.id = v_attempt.job_id
  for update;
  if not (v_attempt.adapter_id = 'direct_model') then
    raise exception using errcode = '22023',
      message = 'company_discovery_v2_direct_model_required';
  end if;
  if v_attempt.status <> 'running' then
    raise exception using errcode = '55000',
      message = 'company_discovery_attempt_terminal';
  end if;
  if v_job.current_attempt_id is distinct from v_attempt.id then
    raise exception using errcode = '55000',
      message = 'company_discovery_attempt_not_current';
  end if;
  if v_attempt.runtime_identity = '{}'::jsonb
     or v_attempt.runtime_identity_hash is null
     or v_attempt.runtime_identity->>'runtime_kind'
       <> 'direct_model_subscription' then
    raise exception using errcode = '55000',
      message = 'company_discovery_runtime_not_bound';
  end if;
  if v_job.fence_generation is distinct from p_fence_generation
     or v_attempt.fence_generation is distinct from p_fence_generation then
    raise exception using errcode = '40001',
      message = 'company_discovery_stale_fence';
  end if;
  if v_attempt.claim_token_hash is distinct from
       extensions.digest(p_claim_token, 'sha256') then
    raise exception using errcode = '42501',
      message = 'company_discovery_claim_token_invalid';
  end if;
  if v_attempt.lease_until <= clock_timestamp()
     or v_job.deadline_at <= clock_timestamp() then
    raise exception using errcode = '55000',
      message = 'company_discovery_attempt_lease_expired';
  end if;

  if jsonb_typeof(p_result) <> 'object'
     or not (p_result ?& array[
       'schema_version','source_snapshots','candidate_facts',
       'missing_questions','contradictions','uncertainty'
     ])
     or (p_result - array[
       'schema_version','source_snapshots','candidate_facts',
       'missing_questions','contradictions','uncertainty'
     ]::text[]) <> '{}'::jsonb
     or p_result->>'schema_version' <> 'company_discovery.result.v2'
     or jsonb_typeof(p_result->'source_snapshots') <> 'array'
     or jsonb_typeof(p_result->'candidate_facts') <> 'array'
     or jsonb_typeof(p_result->'missing_questions') <> 'array'
     or jsonb_typeof(p_result->'contradictions') <> 'array'
     or jsonb_typeof(p_result->'uncertainty') <> 'array' then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_v2_schema_invalid';
  end if;
  if octet_length(p_result::text) > 10485760 then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_payload_too_large';
  end if;
  if public.company_discovery_json_has_forbidden_keys(p_result) then
    raise exception using errcode = '22023',
      message = 'company_discovery_forbidden_result_field';
  end if;
  if jsonb_array_length(p_result->'source_snapshots') not between 1 and 25
     or jsonb_array_length(p_result->'candidate_facts') > 100
     or jsonb_array_length(p_result->'missing_questions') > 50
     or jsonb_array_length(p_result->'contradictions') > 50
     or jsonb_array_length(p_result->'uncertainty') > 50
     or (
       jsonb_array_length(p_result->'candidate_facts') = 0
       and jsonb_array_length(p_result->'missing_questions') = 0
     ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_v2_collection_invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_result->'missing_questions') item
    where jsonb_typeof(item) <> 'string'
      or length(item #>> '{}') not between 1 and 1000
  ) or exists (
    select 1 from jsonb_array_elements(p_result->'contradictions') item
    where jsonb_typeof(item) <> 'string'
      or length(item #>> '{}') not between 1 and 2000
  ) or exists (
    select 1 from jsonb_array_elements(p_result->'uncertainty') item
    where jsonb_typeof(item) <> 'string'
      or length(item #>> '{}') not between 1 and 1000
  ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_v2_collection_item_invalid';
  end if;

  for v_snapshot in
    select value from jsonb_array_elements(p_result->'source_snapshots')
  loop
    if jsonb_typeof(v_snapshot) <> 'object'
       or not (v_snapshot ?& array[
         'url','retrieved_at','http_status','mime_type','byte_length',
         'content_hash','excerpt','crawl_order','crawl_depth'
       ])
       or (v_snapshot - array[
         'url','retrieved_at','http_status','mime_type','byte_length',
         'content_hash','excerpt','crawl_order','crawl_depth'
       ]::text[]) <> '{}'::jsonb
       or jsonb_typeof(v_snapshot->'url') <> 'string'
       or length(v_snapshot->>'url') not between 9 and 2048
       or v_snapshot->>'url' !~ '^https://'
       or jsonb_typeof(v_snapshot->'retrieved_at') <> 'string'
       or v_snapshot->>'retrieved_at' !~*
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}t[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?z$'
       or jsonb_typeof(v_snapshot->'http_status') <> 'number'
       or (v_snapshot->>'http_status') !~ '^[1-5][0-9]{2}$'
       or jsonb_typeof(v_snapshot->'mime_type') <> 'string'
       or lower(v_snapshot->>'mime_type') <> 'text/html'
       or jsonb_typeof(v_snapshot->'byte_length') <> 'number'
       or (v_snapshot->>'byte_length') !~ '^[0-9]+$'
       or (v_snapshot->>'byte_length')::integer > 1048576
       or jsonb_typeof(v_snapshot->'content_hash') <> 'string'
       or (v_snapshot->>'content_hash') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_snapshot->'excerpt') <> 'string'
       or octet_length(v_snapshot->>'excerpt') > 16384
       or jsonb_typeof(v_snapshot->'crawl_order') <> 'number'
       or (v_snapshot->>'crawl_order') !~ '^[0-9]+$'
       or (v_snapshot->>'crawl_order')::integer not between 0 and 24
       or jsonb_typeof(v_snapshot->'crawl_depth') <> 'number'
       or (v_snapshot->>'crawl_depth') !~ '^[0-9]+$'
       or (v_snapshot->>'crawl_depth')::integer not between 0 and 2 then
      raise exception using errcode = '22023',
        message = 'company_discovery_source_schema_invalid';
    end if;
  end loop;
  if (
    select coalesce(sum((snapshot->>'byte_length')::bigint), 0) > 10485760
    from jsonb_array_elements(p_result->'source_snapshots') snapshot
  ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_job_byte_limit_exceeded';
  end if;

  for v_claim in
    select value from jsonb_array_elements(p_result->'candidate_facts')
  loop
    if jsonb_typeof(v_claim) <> 'object'
       or not (v_claim ?& array[
         'claim_class','claim_type','normalized_value','evidence_refs',
         'confidence','contradiction_status','contradictions',
         'missing_fields','ambiguous_fields','uncertainty',
         'claim_schema_version'
       ])
       or (v_claim - array[
         'claim_class','claim_type','normalized_value','evidence_refs',
         'confidence','contradiction_status','contradictions',
         'missing_fields','ambiguous_fields','uncertainty',
         'claim_schema_version'
       ]::text[]) <> '{}'::jsonb
       or v_claim->>'claim_class' not in (
         'descriptive','operational','safety_critical'
       )
       or jsonb_typeof(v_claim->'claim_type') <> 'string'
       or length(v_claim->>'claim_type') not between 1 and 200
       or v_claim->>'confidence' not in ('high','medium','low')
       or v_claim->>'contradiction_status' not in (
         'none','possible','confirmed'
       )
       or v_claim->>'claim_schema_version'
         <> 'company_discovery.claim.v2'
       or jsonb_typeof(v_claim->'evidence_refs') <> 'array'
       or jsonb_array_length(v_claim->'evidence_refs') not between 1 and 25
       or exists (
         select 1 from jsonb_array_elements(v_claim->'evidence_refs') ref
         where jsonb_typeof(ref) <> 'number'
           or (ref #>> '{}') !~ '^[0-9]+$'
       )
       or jsonb_typeof(v_claim->'contradictions') <> 'array'
       or jsonb_array_length(v_claim->'contradictions') > 20
       or jsonb_typeof(v_claim->'missing_fields') <> 'array'
       or jsonb_array_length(v_claim->'missing_fields') > 50
       or jsonb_typeof(v_claim->'ambiguous_fields') <> 'array'
       or jsonb_array_length(v_claim->'ambiguous_fields') > 50
       or jsonb_typeof(v_claim->'uncertainty') <> 'array'
       or jsonb_array_length(v_claim->'uncertainty') > 20
       or exists (
         select 1 from jsonb_array_elements(
           (v_claim->'missing_fields') || (v_claim->'ambiguous_fields')
         ) item where jsonb_typeof(item) <> 'string'
           or length(item #>> '{}') not between 1 and 200
       )
       or exists (
         select 1 from jsonb_array_elements(v_claim->'contradictions') item
         where jsonb_typeof(item) <> 'string'
           or length(item #>> '{}') not between 1 and 2000
       )
       or exists (
         select 1 from jsonb_array_elements(v_claim->'uncertainty') item
         where jsonb_typeof(item) <> 'string'
           or length(item #>> '{}') not between 1 and 1000
       )
       or (
         (v_claim->>'contradiction_status' = 'none') <>
         (jsonb_array_length(v_claim->'contradictions') = 0)
       )
       or not coalesce(public.company_discovery_v2_value_valid(
         v_claim->>'claim_class', v_claim->>'claim_type',
         v_claim->'normalized_value'
       ), false) then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_v2_schema_invalid';
    end if;
    if octet_length((v_claim->'normalized_value')::text) > 65536 then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_value_too_large';
    end if;
    if v_claim->>'claim_type' = 'service_territory' then
      foreach v_collection in array array['included_areas','excluded_areas']
      loop
        for v_area, v_area_index in
          select value, ordinality - 1
          from jsonb_array_elements(
            v_claim->'normalized_value'->v_collection
          ) with ordinality
        loop
          if v_area->>'kind' = 'city'
             and v_area->'region_state' = 'null'::jsonb then
            v_required_gap := format(
              '%s[%s].region_state', v_collection, v_area_index
            );
            if not (v_claim->'ambiguous_fields' ? v_required_gap) then
              raise exception using errcode = '22023',
                message = 'company_discovery_territory_ambiguity_missing';
            end if;
          end if;
        end loop;
      end loop;
    elsif v_claim->>'claim_type' = 'business_hours' then
      if (
        v_claim->'normalized_value'->'timezone' = 'null'::jsonb
        and not (v_claim->'missing_fields' ? 'timezone')
      ) or (
        v_claim->'normalized_value'->'holiday_policy' = 'null'::jsonb
        and not (v_claim->'missing_fields' ? 'holiday_policy')
      ) or (
        v_claim->'normalized_value'->>'after_hours' = 'not_stated'
        and not (v_claim->'missing_fields' ? 'after_hours')
      ) then
        raise exception using errcode = '22023',
          message = 'company_discovery_hours_gap_missing';
      end if;
    end if;
  end loop;

  v_actual_hash := encode(extensions.digest(
    convert_to(p_result::text, 'utf8'), 'sha256'
  ), 'hex');
  if p_result_hash is distinct from v_actual_hash then
    raise exception using errcode = '22000',
      message = 'company_discovery_result_hash_mismatch';
  end if;

  insert into public.worker_results (
    id, tenant_id, job_id, attempt_id, fence_generation,
    result_schema, candidate_result, result_hash
  ) values (
    v_result_id, v_job.tenant_id, v_job.id, v_attempt.id,
    p_fence_generation, 'company_discovery.result.v2',
    p_result, p_result_hash
  );

  for v_snapshot in
    select value from jsonb_array_elements(p_result->'source_snapshots')
    order by (value->>'crawl_order')::integer
  loop
    v_order := (v_snapshot->>'crawl_order')::integer;
    if v_order is distinct from cardinality(v_snapshot_ids) then
      raise exception using errcode = '22023',
        message = 'company_discovery_source_order_invalid';
    end if;
    insert into public.discovery_source_snapshots (
      tenant_id, job_id, attempt_id, result_id, url, retrieved_at,
      http_status, mime_type, byte_length, content_hash, excerpt,
      crawl_order, crawl_depth
    ) values (
      v_job.tenant_id, v_job.id, v_attempt.id, v_result_id,
      v_snapshot->>'url',
      (v_snapshot->>'retrieved_at')::timestamp with time zone,
      (v_snapshot->>'http_status')::integer,
      v_snapshot->>'mime_type',
      (v_snapshot->>'byte_length')::integer,
      v_snapshot->>'content_hash', v_snapshot->>'excerpt',
      v_order, (v_snapshot->>'crawl_depth')::integer
    ) returning id into v_snapshot_id;
    v_snapshot_ids := array_append(v_snapshot_ids, v_snapshot_id);
  end loop;

  for v_claim in
    select value from jsonb_array_elements(p_result->'candidate_facts')
  loop
    v_evidence_ids := '{}'::uuid[];
    for v_order in
      select (value #>> '{}')::integer
      from jsonb_array_elements(v_claim->'evidence_refs')
    loop
      if v_order < 0 or v_order >= cardinality(v_snapshot_ids)
         or v_snapshot_ids[v_order + 1] is null then
        raise exception using errcode = '22023',
          message = 'company_discovery_claim_evidence_invalid';
      end if;
      v_evidence_ids := array_append(
        v_evidence_ids, v_snapshot_ids[v_order + 1]
      );
    end loop;
    if cardinality(v_evidence_ids) <>
       cardinality(array(
         select distinct evidence_id from unnest(v_evidence_ids) evidence_id
       )) then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_evidence_invalid';
    end if;
    select array_agg(evidence_id order by evidence_id)
      into v_evidence_ids
    from unnest(v_evidence_ids) evidence_id;
    insert into public.discovery_claims (
      tenant_id, job_id, attempt_id, result_id,
      claim_class, claim_type, normalized_value, evidence_refs,
      contradictions, uncertainty, adapter_id, provider, model,
      confidence, contradiction_status, missing_fields,
      ambiguous_fields, claim_schema_version
    ) values (
      v_job.tenant_id, v_job.id, v_attempt.id, v_result_id,
      v_claim->>'claim_class', v_claim->>'claim_type',
      v_claim->'normalized_value', v_evidence_ids,
      v_claim->'contradictions', v_claim->'uncertainty',
      'direct_model', 'openai-codex', 'gpt-5.6-sol',
      v_claim->>'confidence', v_claim->>'contradiction_status',
      v_claim->'missing_fields', v_claim->'ambiguous_fields',
      'company_discovery.claim.v2'
    );
  end loop;

  update public.worker_attempts
  set status = 'validated', result_id = v_result_id,
      provider_metadata = jsonb_build_object(
        'provider', 'openai-codex',
        'model', 'gpt-5.6-sol',
        'billing_basis', 'chatgpt_subscription',
        'marginal_api_charge_usd', 0,
        'result_schema', 'company_discovery.result.v2'
      ),
      terminal_at = clock_timestamp()
  where id = v_attempt.id;
  update public.worker_jobs
  set status = 'awaiting_review', version = version + 1,
      fallback_state = 'discovery_available', updated_at = clock_timestamp()
  where id = v_job.id
  returning * into v_job;
  return jsonb_build_object(
    'job_id', v_job.id,
    'attempt_id', v_attempt.id,
    'result_id', v_result_id,
    'job_version', v_job.version,
    'fence_generation', v_job.fence_generation
  );
end;
$$;

revoke all on function public.commit_company_discovery_result_v2(
  uuid,bigint,text,jsonb,text
) from public, anon, authenticated, service_role;
grant execute on function public.commit_company_discovery_result_v2(
  uuid,bigint,text,jsonb,text
) to service_role;

create or replace function public.company_discovery_coverage_target_v1(
  p_claim_type text,
  p_value jsonb,
  p_field text default null
) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_target text;
  v_subject text;
  v_restriction text;
begin
  if p_claim_type = 'service' then
    v_subject := nullif(p_value->>'service_type', '');
    v_target := case p_field
      when 'public_price' then 'service.price_mode'
      when 'duration_minutes' then 'service.duration'
      when 'service_names' then 'service.name_synonyms'
      else 'service.name_synonyms'
    end;
  elsif p_claim_type = 'service_territory' then
    v_target := 'area.coverage';
  elsif p_claim_type = 'business_hours' then
    v_target := case
      when p_field in ('holiday_policy') then 'schedule.holidays'
      when p_field in ('after_hours','emergency_24_7')
        then 'emergency.after_hours'
      else 'schedule.business_hours'
    end;
  elsif p_claim_type = 'guarantee' then
    v_subject := nullif(p_value->>'service_type', '');
    v_target := case when v_subject is null
      then 'policy.warranty_materials' else 'service.warranty' end;
  elsif p_claim_type = 'booking_restriction' then
    v_restriction := p_value->>'restriction_type';
    v_subject := nullif(p_value->>'service_type', '');
    v_target := case
      when v_restriction in ('same_day','advance_notice')
        then 'schedule.same_day_lead_time'
      when v_restriction in ('sunday','weekend','emergency_only')
        then 'schedule.business_hours'
      when v_restriction in ('cancellation','no_show_fee','visit_fee')
        then 'schedule.reschedule_cancel'
      when v_restriction in ('access','customer_presence')
        then 'policy.access_cancellation'
      when v_restriction = 'deposit' then 'policy.payment_estimate'
      when v_restriction = 'service_specific' and v_subject is not null
        then 'service.inclusions_exclusions'
      else null
    end;
  elsif p_claim_type = 'emergency' then
    v_target := 'emergency.safety_escalation';
  else
    return null;
  end if;
  if v_target is null then return null; end if;
  return jsonb_build_object('field', v_target, 'subject', v_subject);
end;
$$;

revoke all on function public.company_discovery_coverage_target_v1(text,jsonb,text)
  from public, anon, authenticated, service_role;

create or replace function public.create_company_discovery_review_nonce_v2(
  p_job uuid,
  p_result uuid,
  p_claim_ids uuid[]
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_job public.worker_jobs;
  v_result public.worker_results;
  v_claim_ids uuid[];
  v_requested_claim_ids uuid[];
  v_global_unresolved_count integer;
  v_nonce text;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  join public.tenants t
    on t.id = j.tenant_id and t.owner_user_id = v_owner
  where j.id = p_job and j.status = 'awaiting_review';
  if v_job.id is null then
    raise exception using errcode = '42501',
      message = 'company_discovery_review_result_not_owner';
  end if;
  select wr.* into v_result
  from public.worker_results wr
  where wr.job_id = v_job.id
    and wr.id = p_result
    and wr.validation_state = 'validated'
    and wr.result_schema = 'company_discovery.result.v2'
    and v_job.selected_attempt_id = wr.attempt_id;
  if v_result.id is null then
    raise exception using errcode = '42501',
      message = 'company_discovery_review_result_not_owner';
  end if;
  select coalesce(array_agg(c.id order by c.id), '{}'::uuid[])
    into v_claim_ids
  from public.discovery_claims c
  where c.result_id = p_result
    and c.claim_schema_version = 'company_discovery.claim.v2';
  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_requested_claim_ids
  from unnest(coalesce(p_claim_ids, '{}'::uuid[])) requested(id);
  if p_claim_ids is null
     or v_requested_claim_ids is distinct from v_claim_ids then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_claim_set_invalid';
  end if;
  v_global_unresolved_count :=
    jsonb_array_length(v_result.candidate_result->'missing_questions') +
    jsonb_array_length(v_result.candidate_result->'contradictions') +
    jsonb_array_length(v_result.candidate_result->'uncertainty');
  if cardinality(v_claim_ids) = 0 and not (v_global_unresolved_count > 0) then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_claim_set_invalid';
  end if;
  if exists (
    select 1 from public.discovery_decisions d
    where d.claim_id = any(v_claim_ids)
  ) then
    raise exception using errcode = '55000',
      message = 'company_discovery_claim_already_reviewed';
  end if;
  v_nonce := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.company_discovery_review_nonces (
    tenant_id, job_id, result_id, claim_ids, nonce_hash,
    expires_at, created_by
  ) values (
    v_job.tenant_id, v_job.id, p_result, v_claim_ids,
    extensions.digest(v_nonce, 'sha256'),
    clock_timestamp() + interval '10 minutes', v_owner
  );
  return v_nonce;
end;
$$;

revoke all on function public.create_company_discovery_review_nonce_v2(
  uuid,uuid,uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.create_company_discovery_review_nonce_v2(
  uuid,uuid,uuid[]
) to authenticated;

create or replace function public.review_company_discovery_claims_v2(
  p_job uuid,
  p_result uuid,
  p_expected_version bigint,
  p_decisions jsonb,
  p_unresolved_decisions jsonb,
  p_confirmation_nonce text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_job public.worker_jobs;
  v_result public.worker_results;
  v_nonce public.company_discovery_review_nonces;
  v_decision jsonb;
  v_claim public.discovery_claims;
  v_claim_ids uuid[];
  v_distinct_ids uuid[];
  v_complete_claim_ids uuid[];
  v_decision_id uuid;
  v_decision_ids uuid[] := '{}'::uuid[];
  v_decision_kind text;
  v_unresolved_decision jsonb;
  v_unresolved_expected integer;
  v_unresolved_count integer;
  v_unresolved_distinct integer;
  v_source_kind text;
  v_source_index integer;
  v_source_text text;
  v_unresolved_decision_kind text;
  v_owner_response text;
  v_question text;
  v_source_claim_ids uuid[];
  v_evidence_ids uuid[];
  v_source_claim public.discovery_claims;
  v_unresolved_id uuid;
  v_coverage_field text;
  v_value jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_approved jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_unresolved jsonb := '[]'::jsonb;
  v_item jsonb;
  v_field text;
  v_collection text;
  v_area jsonb;
  v_area_index bigint;
  v_target jsonb;
  v_effective_missing jsonb;
  v_effective_ambiguous jsonb;
  v_effective_contradictions jsonb;
  v_effective_uncertainty jsonb;
  v_effective_contradiction_status text;
  v_draft_id uuid := gen_random_uuid();
  v_draft_version bigint;
  v_draft jsonb;
  v_draft_hash text;
  v_reviewed integer := 0;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  join public.tenants t
    on t.id = j.tenant_id and t.owner_user_id = v_owner
  where j.id = p_job
    and j.status = 'awaiting_review'
  for update of j;
  if v_job.id is null then
    if exists (
      select 1 from public.worker_jobs j
      join public.tenants t
        on t.id = j.tenant_id and t.owner_user_id = v_owner
      where j.id = p_job and j.status <> 'awaiting_review'
    ) then
      raise exception using errcode = '55000',
        message = 'company_discovery_review_not_awaiting';
    end if;
    raise exception using errcode = '42501',
      message = 'company_discovery_review_result_not_owner';
  end if;
  select wr.* into v_result
  from public.worker_results wr
  where wr.job_id = v_job.id
    and wr.id = p_result
    and wr.validation_state = 'validated'
    and wr.result_schema = 'company_discovery.result.v2'
    and v_job.selected_attempt_id = wr.attempt_id
  for update;
  if v_result.id is null then
    raise exception using errcode = '42501',
      message = 'company_discovery_review_result_not_owner';
  end if;
  if v_job.version is distinct from p_expected_version then
    raise exception using errcode = '40001',
      message = 'company_discovery_stale_version';
  end if;
  if jsonb_typeof(p_decisions) <> 'array' then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_decisions_invalid';
  end if;

  select n.* into v_nonce
  from public.company_discovery_review_nonces n
  where n.job_id = p_job
    and n.result_id = p_result
    and n.created_by = v_owner
    and n.nonce_hash = extensions.digest(p_confirmation_nonce, 'sha256')
  for update;
  if v_nonce.id is null or v_nonce.consumed_at is not null
     or v_nonce.invalidated_at is not null
     or v_nonce.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'company_discovery_review_nonce_invalid';
  end if;
  select
    coalesce(
      array_agg((item->>'claim_id')::uuid order by (item->>'claim_id')::uuid),
      '{}'::uuid[]
    ),
    coalesce(
      array_agg(distinct (item->>'claim_id')::uuid order by (item->>'claim_id')::uuid),
      '{}'::uuid[]
    )
    into v_claim_ids, v_distinct_ids
  from jsonb_array_elements(p_decisions) item
  where item->>'claim_id' ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  if cardinality(v_claim_ids) <> jsonb_array_length(p_decisions)
     or v_claim_ids is distinct from v_distinct_ids
     or v_claim_ids is distinct from v_nonce.claim_ids then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_claim_set_mismatch';
  end if;
  select coalesce(array_agg(c.id order by c.id), '{}'::uuid[])
    into v_complete_claim_ids
  from public.discovery_claims c
  where c.result_id = p_result
    and c.claim_schema_version = 'company_discovery.claim.v2';
  if v_claim_ids is distinct from v_complete_claim_ids then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_claim_set_mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_draft:' || v_job.tenant_id::text,
    0
  ));
  select coalesce(max(d.version), 0) + 1 into v_draft_version
  from public.company_discovery_onboarding_drafts d
  where d.tenant_id = v_job.tenant_id;

  v_unresolved_expected :=
    jsonb_array_length(v_result.candidate_result->'missing_questions') +
    jsonb_array_length(v_result.candidate_result->'contradictions') +
    jsonb_array_length(v_result.candidate_result->'uncertainty');
  if jsonb_typeof(p_unresolved_decisions) <> 'array'
     or jsonb_array_length(p_unresolved_decisions) <> v_unresolved_expected then
    raise exception using errcode = '22023',
      message = 'company_discovery_unresolved_decision_set_mismatch';
  end if;
  select count(*), count(distinct (
    item->>'source_kind', item->>'source_index'
  )) into v_unresolved_count, v_unresolved_distinct
  from jsonb_array_elements(p_unresolved_decisions) item;
  if v_unresolved_count <> v_unresolved_expected
     or v_unresolved_distinct <> v_unresolved_expected then
    raise exception using errcode = '22023',
      message = 'company_discovery_unresolved_decision_set_mismatch';
  end if;

  for v_unresolved_decision in
    select value from jsonb_array_elements(p_unresolved_decisions)
    order by case value->>'source_kind'
      when 'missing_question' then 0
      when 'contradiction' then 1
      when 'uncertainty' then 2
      else 3
    end, value->>'source_index'
  loop
    if jsonb_typeof(v_unresolved_decision) <> 'object'
       or (v_unresolved_decision - array[
         'source_kind','source_index','source_text','decision','owner_response'
       ]::text[]) <> '{}'::jsonb then
      raise exception using errcode = '22023',
        message = 'company_discovery_unresolved_decision_schema_invalid';
    end if;
    v_source_kind := v_unresolved_decision->>'source_kind';
    if v_source_kind not in (
      'missing_question','contradiction','uncertainty'
    ) or jsonb_typeof(v_unresolved_decision->'source_index') <> 'number'
       or coalesce(v_unresolved_decision->>'source_index', '') !~ '^[0-9]+$'
    then
      raise exception using errcode = '22023',
        message = 'company_discovery_unresolved_decision_set_mismatch';
    end if;
    v_source_index := (v_unresolved_decision->>'source_index')::integer;
    v_source_text := case v_source_kind
      when 'missing_question' then
        v_result.candidate_result->'missing_questions'->>v_source_index
      when 'contradiction' then
        v_result.candidate_result->'contradictions'->>v_source_index
      when 'uncertainty' then
        v_result.candidate_result->'uncertainty'->>v_source_index
    end;
    if v_source_text is null or v_unresolved_decision->>'source_text'
         is distinct from v_source_text then
      raise exception using errcode = '22023',
        message = 'company_discovery_unresolved_decision_set_mismatch';
    end if;
    v_unresolved_decision_kind := v_unresolved_decision->>'decision';
    if v_unresolved_decision_kind not in (
      'ask','answer','reject','not_applicable','defer'
    ) then
      raise exception using errcode = '22023',
        message = 'company_discovery_unresolved_decision_invalid';
    end if;
    if v_unresolved_decision_kind = 'answer' then
      if jsonb_typeof(v_unresolved_decision->'owner_response') <> 'string'
         or length(regexp_replace(
           v_unresolved_decision->>'owner_response',
           '^[[:space:]]+|[[:space:]]+$', '', 'g'
         )) not between 1 and 2000 then
        raise exception using errcode = '22023',
          message = 'company_discovery_unresolved_owner_response_invalid';
      end if;
      v_owner_response := v_unresolved_decision->>'owner_response';
    else
      if v_unresolved_decision->'owner_response' is distinct from 'null'::jsonb
      then
        raise exception using errcode = '22023',
          message = 'company_discovery_unresolved_owner_response_invalid';
      end if;
      v_owner_response := null;
    end if;

    select coalesce(array_agg(c.id order by c.id), '{}'::uuid[])
      into v_source_claim_ids
    from public.discovery_claims c
    where c.result_id = p_result
      and c.claim_schema_version = 'company_discovery.claim.v2'
      and (
        (v_source_kind = 'contradiction'
          and c.contradictions @> jsonb_build_array(to_jsonb(v_source_text)))
        or (v_source_kind = 'uncertainty'
          and c.uncertainty @> jsonb_build_array(to_jsonb(v_source_text)))
      );
    select coalesce(array_agg(distinct evidence_id order by evidence_id),
        '{}'::uuid[])
      into v_evidence_ids
    from public.discovery_claims c
    cross join unnest(c.evidence_refs) evidence_id
    where c.id = any(v_source_claim_ids);
    v_source_claim := null;
    v_target := null;
    if cardinality(v_source_claim_ids) = 1 then
      select c.* into v_source_claim
      from public.discovery_claims c
      where c.id = v_source_claim_ids[1];
      v_target := public.company_discovery_coverage_target_v1(
        v_source_claim.claim_type, v_source_claim.normalized_value, null
      );
    end if;
    v_unresolved_id := gen_random_uuid();
    v_coverage_field := coalesce(
      v_target->>'field',
      'discovery.owner_question.' || replace(v_unresolved_id::text, '-', '')
    );
    v_question := case v_source_kind
      when 'missing_question' then v_source_text
      when 'contradiction' then
        'Confirme esta contradição encontrada no site: ' || v_source_text
      when 'uncertainty' then
        'Confirme este ponto que o site deixou incerto: ' || v_source_text
    end;
    v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
      'unresolved_id', v_unresolved_id,
      'source_kind', v_source_kind,
      'source_index', v_source_index,
      'source_claim_ids', to_jsonb(v_source_claim_ids),
      'evidence_refs', to_jsonb(v_evidence_ids),
      'source_job_id', v_job.id,
      'source_attempt_id', v_result.attempt_id,
      'source_result_id', v_result.id,
      'draft_revision', v_draft_version,
      'review_status', case v_unresolved_decision_kind
        when 'ask' then 'pending_onboarding'
        when 'answer' then 'answered'
        when 'reject' then 'rejected'
        when 'not_applicable' then 'not_applicable'
        when 'defer' then 'deferred'
      end,
      'owner_response', v_owner_response,
      'reason', case v_source_kind
        when 'missing_question' then 'missing_or_owner_private'
        when 'contradiction' then 'contradiction'
        when 'uncertainty' then 'operationally_incomplete'
      end,
      'claim_id', null,
      'claim_type', null,
      'field', null,
      'coverage_field', v_coverage_field,
      'coverage_subject', v_target->>'subject',
      'question_pt', v_question
    ));
  end loop;

  for v_decision in
    select value from jsonb_array_elements(p_decisions)
  loop
    if jsonb_typeof(v_decision) <> 'object'
       or (v_decision - array[
         'claim_id','decision','value','group_confirmed',
         'evidence_acknowledged','acknowledged_evidence_refs'
       ]::text[]) <> '{}'::jsonb then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_decision_schema_invalid';
    end if;
    select c.* into v_claim
    from public.discovery_claims c
    where c.id = (v_decision->>'claim_id')::uuid
      and c.result_id = p_result
      and c.claim_schema_version = 'company_discovery.claim.v2'
      and c.adapter_id = 'direct_model'
      and c.provider = 'openai-codex'
      and c.model = 'gpt-5.6-sol'
    for update;
    if v_claim.id is null then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_claim_set_mismatch';
    end if;
    v_decision_kind := v_decision->>'decision';
    if v_decision_kind not in ('approve','edit','reject') then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_decision_invalid';
    end if;
    if v_decision_kind = 'edit' and not (v_decision ? 'value') then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_edit_value_required';
    end if;
    v_value := case when v_decision_kind = 'edit'
      then v_decision->'value' else v_claim.normalized_value end;
    if v_decision_kind <> 'reject' and (
      public.company_discovery_json_has_forbidden_keys(v_value)
      or not coalesce(public.company_discovery_v2_value_valid(
        v_claim.claim_class, v_claim.claim_type, v_value
      ), false)
    ) then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_value_invalid';
    end if;
    if v_decision_kind <> 'reject'
       and v_claim.claim_class in ('operational','safety_critical')
       and coalesce((v_decision->>'group_confirmed')::boolean, false)
         is not true then
      raise exception using errcode = '22023',
        message = 'company_discovery_operational_confirmation_required';
    end if;
    if v_decision_kind <> 'reject'
       and v_claim.claim_class = 'safety_critical'
       and (
         coalesce((v_decision->>'evidence_acknowledged')::boolean, false)
           is not true
         or coalesce(
           v_decision->'acknowledged_evidence_refs', '[]'::jsonb
         ) is distinct from to_jsonb(v_claim.evidence_refs)
       ) then
      raise exception using errcode = '22023',
        message = 'company_discovery_safety_evidence_ack_required';
    end if;

    v_effective_missing := v_claim.missing_fields;
    v_effective_ambiguous := v_claim.ambiguous_fields;
    v_effective_contradictions := v_claim.contradictions;
    v_effective_uncertainty := v_claim.uncertainty;
    v_effective_contradiction_status := v_claim.contradiction_status;
    if v_decision_kind = 'edit' then
      v_effective_missing := '[]'::jsonb;
      v_effective_ambiguous := '[]'::jsonb;
      v_effective_contradictions := '[]'::jsonb;
      v_effective_uncertainty := '[]'::jsonb;
      v_effective_contradiction_status := 'none';
      if v_claim.claim_type = 'service_territory' then
        foreach v_collection in array array['included_areas','excluded_areas']
        loop
          for v_area, v_area_index in
            select value, ordinality - 1
            from jsonb_array_elements(v_value->v_collection) with ordinality
          loop
            if v_area->>'kind' = 'city'
               and jsonb_typeof(v_area->'region_state') = 'null' then
              v_effective_ambiguous := v_effective_ambiguous ||
                jsonb_build_array(format(
                  '%s[%s].region_state', v_collection, v_area_index
                ));
            end if;
          end loop;
        end loop;
      elsif v_claim.claim_type = 'business_hours' then
        if jsonb_typeof(v_value->'timezone') = 'null' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('timezone');
        end if;
        if jsonb_typeof(v_value->'holiday_policy') = 'null' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('holiday_policy');
        end if;
        if v_value->>'after_hours' = 'not_stated' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('after_hours');
        end if;
      elsif v_claim.claim_type = 'service' then
        if jsonb_typeof(v_value->'public_price') = 'null' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('public_price');
        end if;
        if jsonb_typeof(v_value->'duration_minutes') = 'null' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('duration_minutes');
        end if;
      elsif v_claim.claim_type = 'guarantee'
            and v_value->>'guarantee_kind' in (
              'company_guarantee','manufacturer_warranty'
            )
            and jsonb_typeof(v_value->'duration') = 'null' then
        v_effective_missing := v_effective_missing ||
          jsonb_build_array('duration');
      elsif v_claim.claim_type = 'booking_restriction' then
        if v_value->>'restriction_type' in ('same_day','advance_notice')
           and jsonb_typeof(v_value->'notice_minutes') = 'null' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('notice_minutes');
        end if;
        if v_value->>'rule' = 'fee_applies'
           and jsonb_typeof(v_value->'public_fee') = 'null' then
          v_effective_missing := v_effective_missing ||
            jsonb_build_array('public_fee');
        end if;
      end if;
    end if;

    v_decision_id := gen_random_uuid();
    v_decision_ids := array_append(v_decision_ids, v_decision_id);
    v_pending := v_pending || jsonb_build_array(jsonb_build_object(
      'decision_id', v_decision_id,
      'claim_id', v_claim.id,
      'decision', v_decision_kind,
      'value', case when v_decision_kind = 'reject' then null else v_value end,
      'evidence_acknowledged', coalesce(
        (v_decision->>'evidence_acknowledged')::boolean, false
      )
    ));
    if v_decision_kind = 'reject' then
      v_rejected := v_rejected || to_jsonb(v_claim.id);
      v_target := public.company_discovery_coverage_target_v1(
        v_claim.claim_type, v_claim.normalized_value, null
      );
      v_unresolved_id := gen_random_uuid();
      v_coverage_field := coalesce(
        v_target->>'field',
        'discovery.owner_question.' || replace(v_unresolved_id::text, '-', '')
      );
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'unresolved_id', v_unresolved_id,
        'source_kind', 'claim_rejection',
        'source_index', null,
        'source_claim_ids', jsonb_build_array(v_claim.id),
        'evidence_refs', to_jsonb(v_claim.evidence_refs),
        'source_job_id', v_job.id,
        'source_attempt_id', v_result.attempt_id,
        'source_result_id', v_result.id,
        'draft_revision', v_draft_version,
        'review_status', 'pending_onboarding',
        'owner_response', null,
        'reason', 'rejected',
        'claim_id', v_claim.id,
        'claim_type', v_claim.claim_type,
        'field', null,
        'coverage_field', v_coverage_field,
        'coverage_subject', v_target->>'subject',
        'question_pt', format(
          'Você rejeitou a sugestão de %s do site. Qual é a informação correta?',
          replace(v_claim.claim_type, '_', ' ')
        )
      ));
    else
      v_approved := v_approved || jsonb_build_array(jsonb_build_object(
        'claim_id', v_claim.id,
        'claim_class', v_claim.claim_class,
        'claim_type', v_claim.claim_type,
        'value', v_value,
        'decision', v_decision_kind,
        'edited_by_owner', v_decision_kind = 'edit',
        'evidence_refs', to_jsonb(v_claim.evidence_refs),
        'confidence', v_claim.confidence,
        'contradiction_status', v_effective_contradiction_status,
        'missing_fields', v_effective_missing,
        'ambiguous_fields', v_effective_ambiguous,
        'contradictions', v_effective_contradictions,
        'uncertainty', v_effective_uncertainty,
        'website_missing_fields', v_claim.missing_fields,
        'website_ambiguous_fields', v_claim.ambiguous_fields,
        'website_contradictions', v_claim.contradictions,
        'website_uncertainty', v_claim.uncertainty,
        'adapter_id', v_claim.adapter_id,
        'provider', v_claim.provider,
        'model', v_claim.model,
        'claim_schema_version', v_claim.claim_schema_version
      ));
    end if;
    for v_item in select value from jsonb_array_elements(v_effective_missing)
    loop
      v_field := v_item #>> '{}';
      v_target := public.company_discovery_coverage_target_v1(
        v_claim.claim_type, v_value, v_field
      );
      v_unresolved_id := gen_random_uuid();
      v_coverage_field := coalesce(
        v_target->>'field',
        'discovery.owner_question.' || replace(v_unresolved_id::text, '-', '')
      );
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'unresolved_id', v_unresolved_id,
        'source_kind', 'claim_gap',
        'source_index', null,
        'source_claim_ids', jsonb_build_array(v_claim.id),
        'evidence_refs', to_jsonb(v_claim.evidence_refs),
        'source_job_id', v_job.id,
        'source_attempt_id', v_result.attempt_id,
        'source_result_id', v_result.id,
        'draft_revision', v_draft_version,
        'review_status', 'pending_onboarding',
        'owner_response', null,
        'reason', 'missing_field',
        'claim_id', v_claim.id,
        'claim_type', v_claim.claim_type,
        'field', v_field,
        'coverage_field', v_coverage_field,
        'coverage_subject', v_target->>'subject',
        'question_pt', format(
          'O site não informou %s para %s. Qual é a resposta correta?',
          replace(v_field, '_', ' '), replace(v_claim.claim_type, '_', ' ')
        )
      ));
    end loop;
    for v_item in select value from jsonb_array_elements(v_effective_ambiguous)
    loop
      v_field := v_item #>> '{}';
      v_target := public.company_discovery_coverage_target_v1(
        v_claim.claim_type, v_value, v_field
      );
      v_unresolved_id := gen_random_uuid();
      v_coverage_field := coalesce(
        v_target->>'field',
        'discovery.owner_question.' || replace(v_unresolved_id::text, '-', '')
      );
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'unresolved_id', v_unresolved_id,
        'source_kind', 'claim_gap',
        'source_index', null,
        'source_claim_ids', jsonb_build_array(v_claim.id),
        'evidence_refs', to_jsonb(v_claim.evidence_refs),
        'source_job_id', v_job.id,
        'source_attempt_id', v_result.attempt_id,
        'source_result_id', v_result.id,
        'draft_revision', v_draft_version,
        'review_status', 'pending_onboarding',
        'owner_response', null,
        'reason', 'ambiguous_field',
        'claim_id', v_claim.id,
        'claim_type', v_claim.claim_type,
        'field', v_field,
        'coverage_field', v_coverage_field,
        'coverage_subject', v_target->>'subject',
        'question_pt', format(
          'O site deixou %s ambíguo em %s. Como devemos registrar isso?',
          replace(v_field, '_', ' '), replace(v_claim.claim_type, '_', ' ')
        )
      ));
    end loop;
    for v_item in select value from jsonb_array_elements(v_effective_contradictions)
    loop
      if v_result.candidate_result->'contradictions' @>
           jsonb_build_array(v_item) then
        continue;
      end if;
      v_target := public.company_discovery_coverage_target_v1(
        v_claim.claim_type, v_value, null
      );
      v_unresolved_id := gen_random_uuid();
      v_coverage_field := coalesce(
        v_target->>'field',
        'discovery.owner_question.' || replace(v_unresolved_id::text, '-', '')
      );
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'unresolved_id', v_unresolved_id,
        'source_kind', 'claim_gap',
        'source_index', null,
        'source_claim_ids', jsonb_build_array(v_claim.id),
        'evidence_refs', to_jsonb(v_claim.evidence_refs),
        'source_job_id', v_job.id,
        'source_attempt_id', v_result.attempt_id,
        'source_result_id', v_result.id,
        'draft_revision', v_draft_version,
        'review_status', 'pending_onboarding',
        'owner_response', null,
        'reason', 'contradiction',
        'claim_id', v_claim.id,
        'claim_type', v_claim.claim_type,
        'field', null,
        'coverage_field', v_coverage_field,
        'coverage_subject', v_target->>'subject',
        'question_pt', 'Confirme esta contradição encontrada no site: ' ||
          (v_item #>> '{}')
      ));
    end loop;
    for v_item in select value from jsonb_array_elements(v_effective_uncertainty)
    loop
      if v_result.candidate_result->'uncertainty' @>
           jsonb_build_array(v_item) then
        continue;
      end if;
      v_target := public.company_discovery_coverage_target_v1(
        v_claim.claim_type, v_value, null
      );
      v_unresolved_id := gen_random_uuid();
      v_coverage_field := coalesce(
        v_target->>'field',
        'discovery.owner_question.' || replace(v_unresolved_id::text, '-', '')
      );
      v_unresolved := v_unresolved || jsonb_build_array(jsonb_build_object(
        'unresolved_id', v_unresolved_id,
        'source_kind', 'claim_gap',
        'source_index', null,
        'source_claim_ids', jsonb_build_array(v_claim.id),
        'evidence_refs', to_jsonb(v_claim.evidence_refs),
        'source_job_id', v_job.id,
        'source_attempt_id', v_result.attempt_id,
        'source_result_id', v_result.id,
        'draft_revision', v_draft_version,
        'review_status', 'pending_onboarding',
        'owner_response', null,
        'reason', 'operationally_incomplete',
        'claim_id', v_claim.id,
        'claim_type', v_claim.claim_type,
        'field', null,
        'coverage_field', v_coverage_field,
        'coverage_subject', v_target->>'subject',
        'question_pt', 'Confirme este ponto que o site deixou incerto: ' ||
          (v_item #>> '{}')
      ));
    end loop;
    v_reviewed := v_reviewed + 1;
  end loop;

  v_draft := jsonb_build_object(
    'schema_version', 'company_discovery.onboarding_draft.v1',
    'source_job_id', v_job.id,
    'source_attempt_id', v_result.attempt_id,
    'source_result_id', p_result,
    'source_result_hash', v_result.result_hash,
    'source_result_schema', v_result.result_schema,
    'approved_facts', v_approved,
    'rejected_claim_ids', v_rejected,
    'unresolved_items', v_unresolved,
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
    v_job.id, p_result, v_decision_ids, v_draft, v_draft_hash, v_owner
  );

  for v_item in select value from jsonb_array_elements(v_pending)
  loop
    insert into public.discovery_decisions (
      id, tenant_id, job_id, result_id, claim_id, decision,
      decided_value, confirmation_nonce_id, evidence_acknowledged,
      resulting_rule_id, resulting_profile_version_id,
      resulting_onboarding_draft_id, decided_by
    ) values (
      (v_item->>'decision_id')::uuid,
      v_job.tenant_id, v_job.id, p_result,
      (v_item->>'claim_id')::uuid, v_item->>'decision',
      case when v_item->>'decision' = 'reject'
        then null else v_item->'value' end,
      v_nonce.id,
      (v_item->>'evidence_acknowledged')::boolean,
      null, null, v_draft_id, v_owner
    );
  end loop;

  update public.company_discovery_review_nonces
  set consumed_at = clock_timestamp()
  where id = v_nonce.id
    and consumed_at is null
    and invalidated_at is null;
  if not found then
    raise exception using errcode = '40001',
      message = 'company_discovery_review_nonce_race_lost';
  end if;
  update public.worker_jobs
  set status = 'reviewed', version = version + 1,
      updated_at = clock_timestamp()
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id,
    'result_id', p_result,
    'reviewed', v_reviewed,
    'version', v_job.version + 1,
    'onboarding_draft_id', v_draft_id,
    'onboarding_draft_version', v_draft_version,
    'onboarding_draft_hash', v_draft_hash,
    'authority', jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
  );
end;
$$;

revoke all on function public.review_company_discovery_claims_v2(
  uuid,uuid,bigint,jsonb,jsonb,text
) from public, anon, authenticated, service_role;
grant execute on function public.review_company_discovery_claims_v2(
  uuid,uuid,bigint,jsonb,jsonb,text
) to authenticated;

create or replace function public.read_company_discovery_onboarding_draft(
  p_tenant uuid,
  p_owner uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_draft public.company_discovery_onboarding_drafts;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_owner is null or not exists (
    select 1 from public.tenants t
    where t.id = p_tenant and t.owner_user_id = p_owner
  ) then
    raise exception using errcode = '42501',
      message = 'company_discovery_onboarding_draft_not_owner_bound';
  end if;
  select d.* into v_draft
  from public.company_discovery_onboarding_drafts d
  where d.tenant_id = p_tenant
  order by d.version desc, d.created_at desc, d.id desc
  limit 1;
  if v_draft.id is null then return null; end if;
  return jsonb_build_object(
    'draft_id', v_draft.id,
    'draft_version', v_draft.version,
    'draft_hash', v_draft.draft_hash,
    'draft', v_draft.draft
  );
end;
$$;

revoke all on function public.read_company_discovery_onboarding_draft(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_company_discovery_onboarding_draft(uuid,uuid)
  to service_role;

create or replace function public.initialize_company_discovery_onboarding_prefill(
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
  v_request_id uuid;
  v_draft public.company_discovery_onboarding_drafts;
  v_job public.worker_jobs;
  v_result public.worker_results;
  v_latest_draft_id uuid;
  v_fallback public.receipts;
  v_existing public.receipts;
  v_receipt_id uuid;
  v_readback jsonb;
  v_digest text;
  v_external_id text;
  v_payload_hash text;
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
    raise exception using errcode = '22023',
      message = 'company_discovery_onboarding_prefill_scope_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_draft:' || p_tenant::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_prefill:' ||
      p_tenant::text || ':' || p_target_call::text,
    0
  ));
  select br.id into v_request_id
  from public.calls c
  join public.tenants t
    on t.id = c.tenant_id
   and t.id = p_tenant
   and t.owner_user_id = p_owner
   and t.status = 'onboarding'
   and t.operational_mode = 'simulation_only'
  join public.browser_session_requests br
    on br.tenant_id = t.id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
   and br.status = 'ready'
  where c.id = p_target_call
    and c.tenant_id = p_tenant
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and c.status = 'active'
  order by br.handled_at desc nulls last,
    br.created_at desc, br.id desc
  limit 1
  for update of c, t, br;
  if v_request_id is null then
    raise exception using errcode = '42501',
      message = 'onboarding_call_not_owner_bound';
  end if;
  select d.* into v_draft
  from public.company_discovery_onboarding_drafts d
  where d.id = p_draft and d.tenant_id = p_tenant;
  select d.id into v_latest_draft_id
  from public.company_discovery_onboarding_drafts d
  where d.tenant_id = p_tenant
  order by d.version desc, d.created_at desc, d.id desc
  limit 1;
  if v_draft.id is null or v_latest_draft_id is distinct from v_draft.id
     or v_draft.created_by is distinct from p_owner then
    raise exception using errcode = '40001',
      message = 'company_discovery_onboarding_draft_changed';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  where j.id = v_draft.source_job_id
    and j.tenant_id = p_tenant
    and j.status = 'reviewed';
  if v_job.id is null then
    raise exception using errcode = '40001',
      message = 'company_discovery_onboarding_draft_changed';
  end if;
  select wr.* into v_result
  from public.worker_results wr
  where wr.id = v_draft.source_result_id
    and wr.job_id = v_job.id
    and wr.tenant_id = p_tenant
    and wr.attempt_id = v_job.selected_attempt_id
    and wr.validation_state = 'validated'
    and wr.result_schema = 'company_discovery.result.v2';
  if v_result.id is null then
    raise exception using errcode = '40001',
      message = 'company_discovery_onboarding_draft_changed';
  end if;

  select r.* into v_fallback
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_target_call
    and r.kind = 'onboarding_discovery_fallback'
  limit 1;
  if v_fallback.id is not null then
    if v_fallback.readback is not distinct from jsonb_build_object(
      'schema_version', 'company_discovery.onboarding_fallback.v1',
      'tenant_id', p_tenant,
      'call_id', p_target_call,
      'owner_id', p_owner,
      'draft_id', v_draft.id,
      'draft_version', v_draft.version,
      'draft_hash', v_draft.draft_hash,
      'source_job_id', v_job.id,
      'source_attempt_id', v_result.attempt_id,
      'source_result_id', v_result.id,
      'source_result_hash', v_result.result_hash,
      'source_result_schema', v_result.result_schema,
      'reason', 'prefill_not_committed_after_locked_reconciliation',
      'authority', jsonb_build_object(
        'rules_approved', false,
        'powers_granted', false,
        'operational_mode_changed', false
      )
    ) then
      return jsonb_build_object(
        'status', 'safe_fallback',
        'reason', 'prefill_not_committed_after_locked_reconciliation'
      );
    end if;
    raise exception using errcode = '55000',
      message = 'company_discovery_onboarding_prefill_fallback_mismatch';
  end if;

  select r.* into v_existing
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_target_call
    and r.kind = 'onboarding_coverage'
  order by (r.readback->>'revision')::integer desc,
    r.created_at desc, r.id desc
  limit 1;
  if v_existing.id is not null then
    if v_existing.readback->>'transition_kind' = 'discovery_prefill'
       and v_existing.readback->'discovery_context'->>'draft_id'
         = p_draft::text
       and v_existing.readback->'discovery_context'->>'draft_hash'
         = v_draft.draft_hash then
      if v_existing.readback->'discovery_context'->>'source_job_id'
           is distinct from v_job.id::text
         or v_existing.readback->'discovery_context'->>'source_attempt_id'
           is distinct from v_result.attempt_id::text
         or v_existing.readback->'discovery_context'->>'source_result_id'
           is distinct from v_result.id::text
         or v_existing.readback->'discovery_context'->>'source_result_hash'
           is distinct from v_result.result_hash
         or v_existing.readback->'discovery_context'->>'source_result_schema'
           is distinct from v_result.result_schema then
        raise exception using errcode = '55000',
          message = 'company_discovery_onboarding_prefill_not_empty';
      end if;
      return jsonb_build_object(
        'status', 'reused',
        'draft_id', p_draft,
        'draft_hash', v_draft.draft_hash,
        'coverage_receipt_id', v_existing.id,
        'revision', 1,
        'snapshot_digest', v_existing.readback->>'snapshot_digest',
        'next_action', v_existing.readback->'next_action',
        'coverage', v_existing.readback
      );
    end if;
    raise exception using errcode = '55000',
      message = 'company_discovery_onboarding_prefill_not_empty';
  end if;

  if jsonb_typeof(p_coverage) <> 'object'
     or not (p_coverage ?& array[
       'schema_version','transition_kind','tenant_id','call_id','revision',
       'complete','snapshot','progress','selected_rule_ids','next_action',
       'current_answer_hashes','materializations','summary_projection',
       'summary_hash','authority','discovery_context'
     ])
     or (p_coverage - array[
       'schema_version','transition_kind','tenant_id','call_id','revision',
       'complete','snapshot','progress','selected_rule_ids','next_action',
       'current_answer_hashes','materializations','summary_projection',
       'summary_hash','authority','discovery_context'
     ]::text[]) <> '{}'::jsonb
     or p_coverage->'schema_version' <> '2'::jsonb
     or p_coverage->>'transition_kind' <> 'discovery_prefill'
     or p_coverage->>'tenant_id' <> p_tenant::text
     or p_coverage->>'call_id' <> p_target_call::text
     or p_coverage->'revision' <> '1'::jsonb
     or p_coverage->'complete' <> 'false'::jsonb
     or jsonb_typeof(p_coverage->'snapshot') <> 'object'
     or p_coverage->'snapshot'->>'tenantId' <> p_tenant::text
     or p_coverage->'snapshot'->>'callId' <> p_target_call::text
     or p_coverage->'snapshot'->'revision' <> '1'::jsonb
     or jsonb_typeof(p_coverage->'snapshot'->'services') <> 'array'
     or jsonb_typeof(p_coverage->'snapshot'->'cells') <> 'object'
     or jsonb_typeof(p_coverage->'snapshot'->'followUps') <> 'number'
     or jsonb_typeof(p_coverage->'snapshot'->'followUpGroups') <> 'object'
     or jsonb_typeof(p_coverage->'snapshot'->'summaryInvalidated') <> 'boolean'
     or exists (
       select 1 from jsonb_object_keys(p_coverage->'snapshot') key
       where key not in (
         'tenantId','callId','revision','services','currentSubject','cells',
         'followUps','followUpGroups','summaryInvalidated','catalogOverflow'
       )
     )
     or jsonb_typeof(p_coverage->'progress') <> 'object'
     or jsonb_typeof(p_coverage->'progress'->'missingRequired') <> 'array'
     or jsonb_typeof(p_coverage->'progress'->'ambiguous') <> 'array'
     or p_coverage->'selected_rule_ids' <> '[]'::jsonb
     or p_coverage->'materializations' <> '[]'::jsonb
     or p_coverage->'summary_projection' <> 'null'::jsonb
     or p_coverage->'summary_hash' <> 'null'::jsonb
     or jsonb_typeof(p_coverage->'next_action') <> 'object'
     or p_coverage->'next_action'->>'type' <> 'ask'
     or coalesce(p_coverage->'next_action'->>'field','') = ''
     or coalesce(p_coverage->'next_action'->>'question_pt','') = ''
     or p_coverage->'current_answer_hashes' is distinct from
       public.onboarding_snapshot_hashes_v1(p_coverage->'snapshot')
     or p_coverage->'authority' is distinct from jsonb_build_object(
       'rules_approved', false,
       'powers_granted', false,
       'operational_mode_changed', false
     )
    or p_coverage->'discovery_context' is distinct from jsonb_build_object(
       'draft_id', v_draft.id,
       'draft_version', v_draft.version,
       'draft_hash', v_draft.draft_hash,
       'source_job_id', v_job.id,
       'source_attempt_id', v_result.attempt_id,
       'source_result_id', v_result.id,
       'source_result_hash', v_result.result_hash,
       'source_result_schema', v_result.result_schema
     ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_onboarding_prefill_invalid';
  end if;

  v_readback := p_coverage;
  v_digest := encode(extensions.digest(
    convert_to(v_readback::text, 'utf8'), 'sha256'
  ), 'hex');
  v_readback := v_readback || jsonb_build_object(
    'snapshot_digest', v_digest
  );
  v_external_id := encode(extensions.digest(convert_to(
    'ligou.company_discovery.onboarding_prefill:v1:' ||
      p_tenant::text || ':' || p_target_call::text || ':' ||
      p_draft::text || ':' || v_draft.draft_hash,
    'utf8'
  ), 'sha256'), 'hex');
  v_payload_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'tenant_id', p_tenant,
      'call_id', p_target_call,
      'owner_id', p_owner,
      'draft_id', p_draft,
      'coverage', p_coverage
    )::text,
    'utf8'
  ), 'sha256'), 'hex');
  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id,
    readback, payload_hash, detail
  ) values (
    p_tenant, p_target_call, 'onboarding_coverage', 'accepted',
    v_external_id, v_readback, v_payload_hash,
    jsonb_build_object(
      'transition_kind', 'discovery_prefill',
      'transition_schema', 2,
      'draft_id', v_draft.id,
      'draft_version', v_draft.version,
      'draft_hash', v_draft.draft_hash,
      'source_job_id', v_job.id,
      'source_attempt_id', v_result.attempt_id,
      'source_result_id', v_result.id,
      'source_result_hash', v_result.result_hash,
      'source_result_schema', v_result.result_schema,
      'browser_request_id', v_request_id,
      'owner_id', p_owner
    )
  ) returning id into v_receipt_id;
  return jsonb_build_object(
    'status', 'initialized',
    'draft_id', p_draft,
    'draft_hash', v_draft.draft_hash,
    'coverage_receipt_id', v_receipt_id,
    'revision', 1,
    'snapshot_digest', v_digest,
    'next_action', v_readback->'next_action',
    'coverage', v_readback
  );
end;
$$;

revoke all on function public.initialize_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.initialize_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,jsonb
) to service_role;

create or replace function public.reconcile_company_discovery_onboarding_prefill(
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
  v_request_id uuid;
  v_draft public.company_discovery_onboarding_drafts;
  v_latest_draft_id uuid;
  v_job public.worker_jobs;
  v_result public.worker_results;
  v_coverage_count integer;
  v_fallback_count integer;
  v_receipt public.receipts;
  v_fallback public.receipts;
  v_readback jsonb;
  v_external_id text;
  v_payload_hash text;
begin
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(auth.jwt()->>'role', '')
  );
  if v_role is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_target_call is null or p_owner is null
     or p_draft is null or p_expected_draft_version is null
     or p_expected_draft_version < 1 or p_source_job is null
     or p_source_attempt is null or p_source_result is null
     or coalesce(p_expected_draft_hash ~ '^[0-9a-f]{64}$', false) = false
     or coalesce(p_expected_result_hash ~ '^[0-9a-f]{64}$', false) = false
     or p_expected_result_schema <> 'company_discovery.result.v2' then
    raise exception using errcode = '22023',
      message = 'company_discovery_onboarding_reconciliation_scope_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_draft:' || p_tenant::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.onboarding_prefill:' ||
      p_tenant::text || ':' || p_target_call::text,
    0
  ));
  select br.id into v_request_id
  from public.calls c
  join public.tenants t
    on t.id = c.tenant_id
   and t.id = p_tenant
   and t.owner_user_id = p_owner
   and t.status = 'onboarding'
   and t.operational_mode = 'simulation_only'
  join public.browser_session_requests br
    on br.tenant_id = t.id
   and br.call_id = c.id
   and br.user_id = p_owner
   and br.session_type = 'onboarding'
   and br.status = 'ready'
  where c.id = p_target_call
    and c.tenant_id = p_tenant
    and c.channel = 'browser'
    and c.session_type = 'onboarding'
    and c.status = 'active'
  order by br.handled_at desc nulls last,
    br.created_at desc, br.id desc
  limit 1
  for update of c, t, br;
  if v_request_id is null then
    raise exception using errcode = '42501',
      message = 'onboarding_call_not_owner_bound';
  end if;

  select d.* into v_draft
  from public.company_discovery_onboarding_drafts d
  where d.id = p_draft and d.tenant_id = p_tenant;
  select d.id into v_latest_draft_id
  from public.company_discovery_onboarding_drafts d
  where d.tenant_id = p_tenant
  order by d.version desc, d.created_at desc, d.id desc
  limit 1;
  if v_draft.id is null or v_latest_draft_id is distinct from v_draft.id
     or v_draft.version is distinct from p_expected_draft_version then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'draft_revision_changed'
    );
  end if;
  if v_draft.draft_hash is distinct from p_expected_draft_hash then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'draft_hash_changed'
    );
  end if;
  if v_draft.created_by is distinct from p_owner
     or v_draft.source_job_id is distinct from p_source_job
     or v_draft.source_result_id is distinct from p_source_result then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'source_identity_changed'
    );
  end if;
  select j.* into v_job
  from public.worker_jobs j
  where j.id = p_source_job
    and j.tenant_id = p_tenant
    and j.status = 'reviewed'
    and j.selected_attempt_id = p_source_attempt;
  if v_job.id is null then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'source_identity_changed'
    );
  end if;
  select wr.* into v_result
  from public.worker_results wr
  where wr.id = p_source_result
    and wr.tenant_id = p_tenant
    and wr.job_id = p_source_job
    and wr.attempt_id = p_source_attempt
    and wr.validation_state = 'validated'
    and wr.result_schema = p_expected_result_schema;
  if v_result.id is null then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'source_identity_changed'
    );
  end if;
  if v_result.result_hash is distinct from p_expected_result_hash then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'result_hash_changed'
    );
  end if;

  select count(*) into v_coverage_count
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_target_call
    and r.kind = 'onboarding_coverage';
  select count(*) into v_fallback_count
  from public.receipts r
  where r.tenant_id = p_tenant
    and r.call_id = p_target_call
    and r.kind = 'onboarding_discovery_fallback';
  if v_coverage_count + v_fallback_count > 1 then
    return jsonb_build_object(
      'status', 'indeterminate', 'reason', 'multiple_receipts'
    );
  end if;
  if v_coverage_count = 1 then
    select r.* into v_receipt
    from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = p_target_call
      and r.kind = 'onboarding_coverage'
    limit 1;
    if v_receipt.readback->'schema_version' is distinct from '2'::jsonb
       or v_receipt.readback->>'transition_kind' <> 'discovery_prefill'
       or v_receipt.readback->>'revision' <> '1'
       or coalesce(
         v_receipt.readback->>'snapshot_digest' ~ '^[0-9a-f]{64}$', false
       ) = false
       or v_receipt.readback->'discovery_context' is distinct from
         jsonb_build_object(
           'draft_id', v_draft.id,
           'draft_version', v_draft.version,
           'draft_hash', v_draft.draft_hash,
           'source_job_id', v_job.id,
           'source_attempt_id', v_result.attempt_id,
           'source_result_id', v_result.id,
           'source_result_hash', v_result.result_hash,
           'source_result_schema', v_result.result_schema
         )
       or v_receipt.detail->>'owner_id' is distinct from p_owner::text
       or v_receipt.detail->>'draft_id' is distinct from v_draft.id::text
       or (v_receipt.detail->>'draft_version')::bigint
         is distinct from v_draft.version
       or v_receipt.detail->>'draft_hash' is distinct from v_draft.draft_hash
       or v_receipt.detail->>'source_job_id' is distinct from v_job.id::text
       or v_receipt.detail->>'source_attempt_id'
         is distinct from v_result.attempt_id::text
       or v_receipt.detail->>'source_result_id' is distinct from v_result.id::text
       or v_receipt.detail->>'source_result_hash'
         is distinct from v_result.result_hash
       or v_receipt.detail->>'source_result_schema'
         is distinct from v_result.result_schema then
      return jsonb_build_object(
        'status', 'indeterminate', 'reason', 'receipt_mismatch'
      );
    end if;
    return jsonb_build_object(
      'status', 'reused',
      'draft_id', v_draft.id,
      'draft_hash', v_draft.draft_hash,
      'coverage_receipt_id', v_receipt.id,
      'revision', 1,
      'snapshot_digest', v_receipt.readback->>'snapshot_digest',
      'next_action', v_receipt.readback->'next_action',
      'coverage', v_receipt.readback
    );
  end if;
  if v_fallback_count = 1 then
    select r.* into v_fallback
    from public.receipts r
    where r.tenant_id = p_tenant
      and r.call_id = p_target_call
      and r.kind = 'onboarding_discovery_fallback'
    limit 1;
    if v_fallback.readback is distinct from jsonb_build_object(
      'schema_version', 'company_discovery.onboarding_fallback.v1',
      'tenant_id', p_tenant,
      'call_id', p_target_call,
      'owner_id', p_owner,
      'draft_id', v_draft.id,
      'draft_version', v_draft.version,
      'draft_hash', v_draft.draft_hash,
      'source_job_id', v_job.id,
      'source_attempt_id', v_result.attempt_id,
      'source_result_id', v_result.id,
      'source_result_hash', v_result.result_hash,
      'source_result_schema', v_result.result_schema,
      'reason', 'prefill_not_committed_after_locked_reconciliation',
      'authority', jsonb_build_object(
        'rules_approved', false,
        'powers_granted', false,
        'operational_mode_changed', false
      )
    ) then
      return jsonb_build_object(
        'status', 'indeterminate', 'reason', 'receipt_mismatch'
      );
    end if;
    return jsonb_build_object(
      'status', 'safe_fallback',
      'reason', 'prefill_not_committed_after_locked_reconciliation'
    );
  end if;

  v_readback := jsonb_build_object(
    'schema_version', 'company_discovery.onboarding_fallback.v1',
    'tenant_id', p_tenant,
    'call_id', p_target_call,
    'owner_id', p_owner,
    'draft_id', v_draft.id,
    'draft_version', v_draft.version,
    'draft_hash', v_draft.draft_hash,
    'source_job_id', v_job.id,
    'source_attempt_id', v_result.attempt_id,
    'source_result_id', v_result.id,
    'source_result_hash', v_result.result_hash,
    'source_result_schema', v_result.result_schema,
    'reason', 'prefill_not_committed_after_locked_reconciliation',
    'authority', jsonb_build_object(
      'rules_approved', false,
      'powers_granted', false,
      'operational_mode_changed', false
    )
  );
  v_external_id := encode(extensions.digest(convert_to(
    'ligou.company_discovery.onboarding_fallback:v1:' ||
      p_tenant::text || ':' || p_target_call::text || ':' ||
      v_draft.id::text || ':' || v_draft.draft_hash,
    'utf8'
  ), 'sha256'), 'hex');
  v_payload_hash := encode(extensions.digest(
    convert_to(v_readback::text, 'utf8'), 'sha256'
  ), 'hex');
  insert into public.receipts (
    tenant_id, call_id, kind, outcome, external_id,
    readback, payload_hash, detail
  ) values (
    p_tenant, p_target_call, 'onboarding_discovery_fallback', 'accepted',
    v_external_id, v_readback, v_payload_hash,
    jsonb_build_object(
      'browser_request_id', v_request_id,
      'owner_id', p_owner,
      'draft_id', v_draft.id,
      'draft_version', v_draft.version,
      'draft_hash', v_draft.draft_hash,
      'source_job_id', v_job.id,
      'source_attempt_id', v_result.attempt_id,
      'source_result_id', v_result.id,
      'source_result_hash', v_result.result_hash,
      'source_result_schema', v_result.result_schema,
      'reason', 'prefill_not_committed_after_locked_reconciliation'
    )
  );
  return jsonb_build_object(
    'status', 'safe_fallback',
    'reason', 'prefill_not_committed_after_locked_reconciliation'
  );
end;
$$;

revoke all on function public.reconcile_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_company_discovery_onboarding_prefill(
  uuid,uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,text
) to service_role;

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
              'answer', 'directed_followup', 'resume_checkpoint',
              'discovery_prefill'
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
              or (
                readback->>'transition_kind' = 'discovery_prefill'
                and readback->>'revision' = '1'
                and readback->'complete' = 'false'::jsonb
                and detail->>'transition_kind' = 'discovery_prefill'
                and detail->'transition_schema' is not distinct from '2'::jsonb
                and coalesce(
                  detail->>'draft_id' ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                  false
                )
                and coalesce(
                  detail->>'draft_hash' ~ '^[0-9a-f]{64}$', false
                )
                and jsonb_typeof(readback->'discovery_context') = 'object'
                and readback->'discovery_context'->>'draft_id' =
                  detail->>'draft_id'
                and readback->'discovery_context'->>'draft_hash' =
                  detail->>'draft_hash'
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
            and readback->>'snapshot_revision' = readback->>'target_revision'
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

alter table public.worker_jobs
  add column processing_stage text;
update public.worker_jobs
set processing_stage = case status
  when 'queued' then 'queued'
  when 'running' then 'fetching'
  when 'awaiting_review' then 'ready_for_review'
  when 'reviewed' then 'reviewed'
  when 'failed' then 'failed'
  when 'cancelled' then 'cancelled'
end;
alter table public.worker_jobs
  alter column processing_stage set default 'queued',
  alter column processing_stage set not null,
  add constraint worker_jobs_processing_stage_check check (
    processing_stage in (
      'queued','fetching','analyzing','ready_for_review','reviewed','failed','cancelled'
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
    when 'awaiting_review' then 'ready_for_review'
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

create or replace function public.mark_company_discovery_attempt_fetching()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.worker_jobs
  set processing_stage = 'fetching', updated_at = clock_timestamp()
  where id = new.job_id and status in ('queued','running');
  return new;
end;
$$;

create or replace function public.mark_company_discovery_subscription_analyzing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.worker_jobs
  set processing_stage = 'analyzing', updated_at = clock_timestamp()
  where id = new.job_id and status = 'running';
  return new;
end;
$$;

create or replace function public.mark_company_discovery_result_review_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.worker_jobs
  set processing_stage = 'ready_for_review', updated_at = clock_timestamp()
  where id = new.job_id and status = 'running';
  return new;
end;
$$;

revoke all on function public.sync_company_discovery_job_status_stage()
  from public, anon, authenticated, service_role;
revoke all on function public.mark_company_discovery_attempt_fetching()
  from public, anon, authenticated, service_role;
revoke all on function public.mark_company_discovery_subscription_analyzing()
  from public, anon, authenticated, service_role;
revoke all on function public.mark_company_discovery_result_review_ready()
  from public, anon, authenticated, service_role;

create trigger company_discovery_job_status_stage
  before insert or update of status on public.worker_jobs
  for each row execute function public.sync_company_discovery_job_status_stage();
create trigger company_discovery_attempt_fetching_stage
  after insert on public.worker_attempts
  for each row execute function public.mark_company_discovery_attempt_fetching();
create trigger company_discovery_subscription_analyzing_stage
  after insert on public.company_discovery_subscription_reservations
  for each row execute function public.mark_company_discovery_subscription_analyzing();
create trigger company_discovery_result_review_stage
  after insert on public.worker_results
  for each row execute function public.mark_company_discovery_result_review_ready();

alter function public.onboarding_answer_value_valid_v2(text,jsonb)
  rename to onboarding_answer_value_valid_v2_base;

revoke all on function public.onboarding_answer_value_valid_v2_base(text,jsonb)
  from public, anon, authenticated, service_role;

create function public.onboarding_answer_value_valid_v2(
  p_field text,
  p_value jsonb
) returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_field ~ '^discovery[.]owner_question[.][0-9a-f]{32}$' then
    return jsonb_typeof(p_value) = 'string'
      and length(regexp_replace(
        p_value #>> '{}', '^[[:space:]]+|[[:space:]]+$', '', 'g'
      )) between 1 and 2000;
  end if;
  return public.onboarding_answer_value_valid_v2_base(p_field, p_value);
end;
$$;

revoke all on function public.onboarding_answer_value_valid_v2(text,jsonb)
  from public, anon, authenticated, service_role;
