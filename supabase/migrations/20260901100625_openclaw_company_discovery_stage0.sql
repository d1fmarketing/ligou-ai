-- OpenClaw company discovery Stage 0.
-- Ligou owns every identity, fence, claim, decision, and effective rule. Workers
-- submit immutable candidates only; authenticated owner review is the sole path
-- from a candidate claim to an approved rule or descriptive profile version.

-- Discovery is a truthful source in its own right. It must never masquerade as
-- an onboarding call merely to satisfy a runtime parser.
alter table public.rules drop constraint rules_origem_check;
alter table public.rules add constraint rules_origem_check
  check (origem in (
    'onboarding', 'escalacao', 'edicao_manual', 'aprendizado',
    'company_discovery'
  ));

-- ---------------------------------------------------------------- controls
create table public.company_discovery_controls (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  updated_at timestamp with time zone not null default now(),
  updated_by uuid references auth.users (id)
);

insert into public.company_discovery_controls (singleton, enabled)
values (true, false);

create table public.company_discovery_allowlist (
  tenant_id uuid primary key references public.tenants (id),
  active boolean not null default false,
  expires_at timestamp with time zone,
  note text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  check (expires_at is null or expires_at > created_at)
);

-- ---------------------------------------------------------------- jobs and fencing
create table public.worker_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_type text not null default 'company_discovery.v1'
    check (job_type = 'company_discovery.v1'),
  normalized_origin text not null,
  origin_host text not null,
  registrable_domain text,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  version bigint not null default 1 check (version > 0),
  fence_generation bigint not null default 1 check (fence_generation > 0),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'awaiting_review', 'reviewed', 'cancelled', 'failed'
  )),
  current_attempt_id uuid,
  selected_attempt_id uuid,
  deadline_at timestamp with time zone not null,
  budget jsonb not null default '{}'::jsonb,
  fallback_state text not null default 'existing_onboarding' check (
    fallback_state in ('existing_onboarding', 'discovery_available', 'discovery_selected')
  ),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (tenant_id, idempotency_key),
  unique (id, tenant_id),
  check (normalized_origin ~ '^https://[^/@:#?]+([/?].*)?$'),
  check (origin_host ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'),
  check (
    registrable_domain is null or
    registrable_domain ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
  ),
  check (deadline_at > created_at),
  check (jsonb_typeof(budget) = 'object')
);

create index worker_jobs_claimable_idx
  on public.worker_jobs (created_at, id)
  where status = 'queued';

create table public.worker_runtime_slots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id),
  slot_name text not null unique,
  supervisor_worker_id text not null,
  adapter_id text not null default 'openclaw'
    check (adapter_id in ('openclaw','direct_model')),
  status text not null default 'available'
    check (status in ('available', 'busy', 'quarantined')),
  current_attempt_id uuid,
  quarantine_reason text,
  quarantine_proof_hash text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  check (
    quarantine_proof_hash is null or
    quarantine_proof_hash ~ '^[0-9a-f]{64}$'
  )
);

create table public.worker_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  adapter_id text not null check (adapter_id in ('openclaw','direct_model')),
  fence_generation bigint not null check (fence_generation > 0),
  status text not null default 'running' check (status in (
    'running', 'validated', 'selected', 'cancelled', 'failed', 'superseded'
  )),
  claim_token_hash bytea not null,
  claimed_by text not null,
  claimed_at timestamp with time zone not null default now(),
  lease_until timestamp with time zone not null,
  runtime_slot_id uuid references public.worker_runtime_slots (id),
  runtime_identity jsonb not null default '{}'::jsonb,
  provider_metadata jsonb not null default '{}'::jsonb,
  result_id uuid,
  terminal_at timestamp with time zone,
  cleanup_state text not null default 'pending'
    check (cleanup_state in ('pending', 'proved', 'cleanup_unresolved')),
  cleanup_proof jsonb,
  created_at timestamp with time zone not null default now(),
  unique (job_id, attempt_number),
  unique (id, tenant_id),
  foreign key (job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  check (lease_until > claimed_at),
  check (jsonb_typeof(runtime_identity) = 'object'),
  check (jsonb_typeof(provider_metadata) = 'object')
);

alter table public.worker_jobs
  add constraint worker_jobs_current_attempt_fk
  foreign key (current_attempt_id) references public.worker_attempts (id),
  add constraint worker_jobs_selected_attempt_fk
  foreign key (selected_attempt_id) references public.worker_attempts (id);

alter table public.worker_runtime_slots
  add constraint worker_runtime_slots_current_attempt_fk
  foreign key (current_attempt_id) references public.worker_attempts (id);

-- ---------------------------------------------------------------- immutable candidates and evidence
create table public.worker_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_id uuid not null,
  attempt_id uuid not null unique,
  fence_generation bigint not null check (fence_generation > 0),
  result_schema text not null default 'company_discovery.result.v1'
    check (result_schema = 'company_discovery.result.v1'),
  candidate_result jsonb not null,
  result_hash text not null check (result_hash ~ '^[0-9a-f]{64}$'),
  validation_state text not null default 'validated'
    check (validation_state = 'validated'),
  validated_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  unique (id, tenant_id),
  foreign key (job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  foreign key (attempt_id, tenant_id) references public.worker_attempts (id, tenant_id),
  check (jsonb_typeof(candidate_result) = 'object')
);

alter table public.worker_attempts
  add constraint worker_attempts_result_fk
  foreign key (result_id) references public.worker_results (id);

create table public.discovery_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_id uuid not null,
  attempt_id uuid not null,
  result_id uuid not null,
  url text not null check (url ~ '^https://'),
  retrieved_at timestamp with time zone not null,
  http_status integer not null check (http_status between 100 and 599),
  mime_type text not null check (lower(mime_type) = 'text/html'),
  byte_length integer not null check (byte_length between 0 and 1048576),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  excerpt text not null check (octet_length(excerpt) <= 16384),
  crawl_order integer not null check (crawl_order between 0 and 24),
  crawl_depth integer not null check (crawl_depth between 0 and 2),
  created_at timestamp with time zone not null default now(),
  unique (result_id, crawl_order),
  unique (id, result_id),
  foreign key (job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  foreign key (attempt_id, tenant_id) references public.worker_attempts (id, tenant_id),
  foreign key (result_id, tenant_id) references public.worker_results (id, tenant_id)
);

create table public.discovery_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_id uuid not null,
  attempt_id uuid not null,
  result_id uuid not null,
  claim_class text not null check (claim_class in (
    'descriptive', 'operational', 'safety_critical'
  )),
  claim_type text not null check (length(claim_type) between 1 and 200),
  normalized_value jsonb not null,
  evidence_refs uuid[] not null,
  contradictions jsonb not null default '[]'::jsonb,
  uncertainty jsonb not null default '{}'::jsonb,
  claim_version integer not null default 1 check (claim_version = 1),
  created_at timestamp with time zone not null default now(),
  unique (id, result_id),
  foreign key (job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  foreign key (attempt_id, tenant_id) references public.worker_attempts (id, tenant_id),
  foreign key (result_id, tenant_id) references public.worker_results (id, tenant_id),
  check (cardinality(evidence_refs) > 0),
  check (jsonb_typeof(contradictions) = 'array'),
  check (jsonb_typeof(uncertainty) = 'object')
);

create table public.company_discovery_review_nonces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_id uuid not null,
  result_id uuid not null,
  claim_ids uuid[] not null,
  nonce_hash bytea not null unique,
  expires_at timestamp with time zone not null,
  consumed_at timestamp with time zone,
  invalidated_at timestamp with time zone,
  invalidation_reason text,
  created_by uuid not null,
  created_at timestamp with time zone not null default now(),
  foreign key (job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  foreign key (result_id, tenant_id) references public.worker_results (id, tenant_id),
  check (cardinality(claim_ids) > 0),
  check (expires_at > created_at)
);

create table public.business_profile_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  version bigint not null check (version > 0),
  profile jsonb not null,
  source_job_id uuid not null,
  source_result_id uuid not null,
  source_claim_id uuid not null,
  approved_by uuid not null,
  approved_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  unique (tenant_id, version),
  unique (id, tenant_id),
  foreign key (source_job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  foreign key (source_result_id, tenant_id) references public.worker_results (id, tenant_id),
  foreign key (source_claim_id, source_result_id)
    references public.discovery_claims (id, result_id),
  check (jsonb_typeof(profile) = 'object')
);

create table public.discovery_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  job_id uuid not null,
  result_id uuid not null,
  claim_id uuid not null,
  decision text not null check (decision in ('approve', 'edit', 'reject')),
  decided_value jsonb,
  confirmation_nonce_id uuid references public.company_discovery_review_nonces (id),
  evidence_acknowledged boolean not null default false,
  resulting_rule_id uuid references public.rules (id),
  resulting_profile_version_id uuid references public.business_profile_versions (id),
  decided_by uuid not null,
  decided_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  unique (claim_id),
  foreign key (job_id, tenant_id) references public.worker_jobs (id, tenant_id),
  foreign key (result_id, tenant_id) references public.worker_results (id, tenant_id),
  foreign key (claim_id, result_id) references public.discovery_claims (id, result_id)
);

-- ---------------------------------------------------------------- immutable audit guards
create or replace function public.guard_worker_job_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.job_type is distinct from old.job_type
     or new.normalized_origin is distinct from old.normalized_origin
     or new.origin_host is distinct from old.origin_host
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000',
      message = 'company_discovery_job_identity_immutable';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_worker_job_identity()
  from public, anon, authenticated, service_role;

create trigger worker_jobs_identity_immutable
  before update on public.worker_jobs
  for each row execute function public.guard_worker_job_identity();

create trigger worker_results_append_only
  before update or delete on public.worker_results
  for each row execute function public.block_mutation();
create trigger discovery_source_snapshots_append_only
  before update or delete on public.discovery_source_snapshots
  for each row execute function public.block_mutation();
create trigger discovery_claims_append_only
  before update or delete on public.discovery_claims
  for each row execute function public.block_mutation();
create trigger discovery_decisions_append_only
  before update or delete on public.discovery_decisions
  for each row execute function public.block_mutation();
create trigger business_profile_versions_append_only
  before update or delete on public.business_profile_versions
  for each row execute function public.block_mutation();

create or replace function public.company_discovery_json_has_forbidden_keys(
  p_value jsonb
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_child jsonb;
  v_forbidden constant text[] := array[
    'tenant_id', 'canonical_id', 'policy_group', 'approval', 'approved',
    'approved_by', 'approved_at', 'status', 'effective', 'active',
    'enabled', 'policy_hash', 'action_completion', 'rule_id',
    'rule_group_id', 'power', 'powers', 'capability', 'grant', 'authority',
    'materialization_key', 'materialization_eligible', 'review_ready',
    'operational_state', 'source_kind', 'source_call_id', 'source_job_id',
    'source_result_id', 'source_claim_id', 'source_decision_id',
    'coverage_revision'
  ];
begin
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value)
    loop
      if v_key = any(v_forbidden)
         or public.company_discovery_json_has_forbidden_keys(v_child) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value)
    loop
      if public.company_discovery_json_has_forbidden_keys(v_child) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

revoke all on function public.company_discovery_json_has_forbidden_keys(jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- RLS and direct grants
alter table public.company_discovery_controls enable row level security;
alter table public.company_discovery_controls force row level security;
alter table public.company_discovery_allowlist enable row level security;
alter table public.company_discovery_allowlist force row level security;
alter table public.worker_jobs enable row level security;
alter table public.worker_jobs force row level security;
alter table public.worker_runtime_slots enable row level security;
alter table public.worker_runtime_slots force row level security;
alter table public.worker_attempts enable row level security;
alter table public.worker_attempts force row level security;
alter table public.worker_results enable row level security;
alter table public.worker_results force row level security;
alter table public.discovery_source_snapshots enable row level security;
alter table public.discovery_source_snapshots force row level security;
alter table public.discovery_claims enable row level security;
alter table public.discovery_claims force row level security;
alter table public.company_discovery_review_nonces enable row level security;
alter table public.company_discovery_review_nonces force row level security;
alter table public.business_profile_versions enable row level security;
alter table public.business_profile_versions force row level security;
alter table public.discovery_decisions enable row level security;
alter table public.discovery_decisions force row level security;

create policy company_discovery_allowlist_owner_select
  on public.company_discovery_allowlist for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy worker_jobs_owner_select
  on public.worker_jobs for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy worker_attempts_owner_select
  on public.worker_attempts for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy worker_results_owner_select
  on public.worker_results for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy discovery_source_snapshots_owner_select
  on public.discovery_source_snapshots for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy discovery_claims_owner_select
  on public.discovery_claims for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy company_discovery_review_nonces_owner_select
  on public.company_discovery_review_nonces for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy business_profile_versions_owner_select
  on public.business_profile_versions for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));
create policy discovery_decisions_owner_select
  on public.discovery_decisions for select to authenticated
  using (tenant_id in (
    select t.id from public.tenants t
    where t.owner_user_id = (select auth.uid())
  ));

revoke all on table public.company_discovery_controls,
  public.company_discovery_allowlist, public.worker_jobs,
  public.worker_runtime_slots, public.worker_attempts, public.worker_results,
  public.discovery_source_snapshots, public.discovery_claims,
  public.company_discovery_review_nonces, public.business_profile_versions,
  public.discovery_decisions
  from public, anon, authenticated, service_role;

grant select on table public.company_discovery_allowlist, public.worker_jobs,
  public.worker_attempts, public.worker_results,
  public.discovery_source_snapshots, public.discovery_claims,
  public.company_discovery_review_nonces, public.business_profile_versions,
  public.discovery_decisions
  to authenticated;

grant select on table
  public.company_discovery_controls, public.company_discovery_allowlist,
  public.worker_jobs, public.worker_runtime_slots, public.worker_attempts,
  public.worker_results, public.discovery_source_snapshots,
  public.discovery_claims, public.company_discovery_review_nonces,
  public.business_profile_versions, public.discovery_decisions
  to service_role;

grant insert, update on table public.company_discovery_controls,
  public.company_discovery_allowlist
  to service_role;

grant insert on table public.worker_runtime_slots to service_role;

-- ---------------------------------------------------------------- owner RPCs
create or replace function public.submit_company_discovery(
  p_url text,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_tenants uuid[];
  v_tenant uuid;
  v_input text := btrim(p_url);
  v_tail text;
  v_host text;
  v_suffix text;
  v_origin text;
  v_request_hash text;
  v_existing public.worker_jobs;
  v_job uuid;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select array_agg(t.id order by t.created_at, t.id)
    into v_tenants
  from public.tenants t
  where t.owner_user_id = v_owner;
  if coalesce(cardinality(v_tenants), 0) <> 1 then
    raise exception using errcode = '42501',
      message = 'company_discovery_owner_tenant_ambiguous';
  end if;
  v_tenant := v_tenants[1];
  if p_idempotency_key is null
     or length(btrim(p_idempotency_key)) not between 1 and 200 then
    raise exception using errcode = '22023',
      message = 'company_discovery_idempotency_key_invalid';
  end if;
  if lower(left(v_input, 8)) <> 'https://' or v_input ~ '[#]' then
    raise exception using errcode = '22023',
      message = 'company_discovery_origin_invalid';
  end if;
  v_tail := substring(v_input from 9);
  v_host := lower(split_part(split_part(v_tail, '/', 1), '?', 1));
  if v_host = '' or v_host ~ '[@:]' or v_host !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$' then
    raise exception using errcode = '22023',
      message = 'company_discovery_origin_invalid';
  end if;
  v_suffix := substring(v_tail from length(split_part(split_part(v_tail, '/', 1), '?', 1)) + 1);
  v_origin := 'https://' || v_host || case when v_suffix = '' then '/' else v_suffix end;
  v_request_hash := encode(extensions.digest(
    convert_to('company_discovery.v1|' || v_origin, 'utf8'), 'sha256'
  ), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.company_discovery.idempotency:' || v_tenant::text || ':' || btrim(p_idempotency_key),
    0
  ));
  select j.* into v_existing
  from public.worker_jobs j
  where j.tenant_id = v_tenant
    and j.idempotency_key = btrim(p_idempotency_key);
  if v_existing.id is not null then
    if v_existing.request_hash is distinct from v_request_hash then
      raise exception using errcode = '22023',
        message = 'company_discovery_idempotency_conflict';
    end if;
    return v_existing.id;
  end if;
  if not exists (
    select 1 from public.company_discovery_controls c
    where c.singleton and c.enabled
  ) then
    raise exception using errcode = '55000', message = 'company_discovery_disabled';
  end if;
  if not exists (
    select 1 from public.company_discovery_allowlist a
    where a.tenant_id = v_tenant
      and a.active
      and (a.expires_at is null or a.expires_at > clock_timestamp())
  ) then
    raise exception using errcode = '42501',
      message = 'company_discovery_tenant_not_allowlisted';
  end if;
  insert into public.worker_jobs (
    tenant_id, normalized_origin, origin_host, registrable_domain, idempotency_key,
    request_hash, deadline_at, budget
  ) values (
    v_tenant, v_origin, v_host, null, btrim(p_idempotency_key), v_request_hash,
    clock_timestamp() + interval '10 minutes',
    jsonb_build_object(
      'max_pages', 25, 'max_depth', 2, 'max_page_bytes', 1048576,
      'max_job_bytes', 10485760, 'deadline_seconds', 600
    )
  ) returning id into v_job;
  return v_job;
end;
$$;

revoke all on function public.submit_company_discovery(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_company_discovery(text,text)
  to authenticated;

create or replace function public.cancel_company_discovery(
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
    raise exception using errcode = '42501', message = 'company_discovery_job_not_owner';
  end if;
  if v_job.version is distinct from p_expected_version then
    raise exception using errcode = '40001', message = 'company_discovery_stale_version';
  end if;
  if v_job.status in ('reviewed', 'cancelled', 'failed') then
    raise exception using errcode = '55000', message = 'company_discovery_job_terminal';
  end if;
  update public.worker_jobs
  set status = 'cancelled', version = version + 1,
      fence_generation = fence_generation + 1,
      selected_attempt_id = null,
      fallback_state = 'existing_onboarding',
      updated_at = clock_timestamp()
  where id = v_job.id;
  update public.worker_attempts
  set status = case
        when status in ('validated', 'selected') then 'superseded'
        else 'cancelled'
      end,
      terminal_at = coalesce(terminal_at, clock_timestamp())
  where id = v_job.current_attempt_id
    and status in ('running', 'validated', 'selected');
  update public.company_discovery_review_nonces
  set invalidated_at = clock_timestamp(),
      invalidation_reason = 'job_cancelled'
  where job_id = v_job.id
    and consumed_at is null
    and invalidated_at is null;
  return jsonb_build_object(
    'job_id', v_job.id, 'status', 'cancelled',
    'version', v_job.version + 1,
    'fence_generation', v_job.fence_generation + 1
  );
end;
$$;

revoke all on function public.cancel_company_discovery(uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_company_discovery(uuid,bigint)
  to authenticated;

create or replace function public.retry_company_discovery(
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
    raise exception using errcode = '42501', message = 'company_discovery_job_not_owner';
  end if;
  if v_job.version is distinct from p_expected_version then
    raise exception using errcode = '40001', message = 'company_discovery_stale_version';
  end if;
  if v_job.status not in ('cancelled', 'failed') then
    raise exception using errcode = '55000', message = 'company_discovery_retry_not_terminal';
  end if;
  if v_job.deadline_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'company_discovery_deadline_expired';
  end if;
  update public.worker_jobs
  set status = 'queued', current_attempt_id = null,
      selected_attempt_id = null,
      fallback_state = 'existing_onboarding',
      version = version + 1, fence_generation = fence_generation + 1,
      updated_at = clock_timestamp()
  where id = v_job.id;
  update public.worker_attempts
  set status = 'superseded',
      terminal_at = coalesce(terminal_at, clock_timestamp())
  where id = v_job.current_attempt_id
    and status in ('running', 'validated', 'selected');
  update public.company_discovery_review_nonces
  set invalidated_at = clock_timestamp(),
      invalidation_reason = 'job_retried'
  where job_id = v_job.id
    and consumed_at is null
    and invalidated_at is null;
  return jsonb_build_object(
    'job_id', v_job.id, 'status', 'queued',
    'version', v_job.version + 1,
    'fence_generation', v_job.fence_generation + 1
  );
end;
$$;

revoke all on function public.retry_company_discovery(uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.retry_company_discovery(uuid,bigint)
  to authenticated;

create or replace function public.create_company_discovery_review_nonce(
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
  v_claim_ids uuid[];
  v_nonce text;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  join public.tenants t on t.id = j.tenant_id
    and t.owner_user_id = v_owner
  join public.worker_results wr on wr.job_id = j.id
    and wr.id = p_result and wr.validation_state = 'validated'
  where j.id = p_job
    and j.status = 'awaiting_review'
    and j.selected_attempt_id = wr.attempt_id;
  if v_job.id is null then
    raise exception using errcode = '42501',
      message = 'company_discovery_review_result_not_owner';
  end if;
  select array_agg(distinct c.id order by c.id)
    into v_claim_ids
  from public.discovery_claims c
  where c.result_id = p_result and c.id = any(coalesce(p_claim_ids, '{}'::uuid[]));
  if coalesce(cardinality(p_claim_ids), 0) = 0
     or cardinality(v_claim_ids) <> cardinality(p_claim_ids)
     or v_claim_ids is distinct from (
       select array_agg(id order by id) from unnest(p_claim_ids) as id
     ) then
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
    extensions.digest(v_nonce, 'sha256'), clock_timestamp() + interval '10 minutes',
    v_owner
  );
  return v_nonce;
end;
$$;

revoke all on function public.create_company_discovery_review_nonce(uuid,uuid,uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.create_company_discovery_review_nonce(uuid,uuid,uuid[])
  to authenticated;

create or replace function public.review_company_discovery_claims(
  p_job uuid,
  p_result uuid,
  p_expected_version bigint,
  p_decisions jsonb,
  p_confirmation_nonce text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_job public.worker_jobs;
  v_nonce public.company_discovery_review_nonces;
  v_decision jsonb;
  v_claim public.discovery_claims;
  v_claim_ids uuid[];
  v_decision_ids uuid[];
  v_decision_id uuid;
  v_decision_kind text;
  v_value jsonb;
  v_derived_category text;
  v_derived_scope text;
  v_derived_schema text;
  v_derived_text text;
  v_derived_structured jsonb;
  v_materialization_key text;
  v_structured jsonb;
  v_rule_id uuid;
  v_rule_group_ids uuid[];
  v_rule_group_id uuid;
  v_rule_version integer;
  v_group_hex text;
  v_service_type text;
  v_profile_id uuid;
  v_profile_version bigint;
  v_profile jsonb;
  v_reviewed integer := 0;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select j.* into v_job
  from public.worker_jobs j
  join public.tenants t on t.id = j.tenant_id
    and t.owner_user_id = v_owner
  join public.worker_results wr on wr.job_id = j.id
    and wr.id = p_result and wr.validation_state = 'validated'
  where j.id = p_job
    and j.status = 'awaiting_review'
    and j.selected_attempt_id = wr.attempt_id
  for update of j;
  if v_job.id is null then
    if exists (
      select 1 from public.worker_jobs j
      join public.tenants t on t.id = j.tenant_id
        and t.owner_user_id = v_owner
      where j.id = p_job and j.status <> 'awaiting_review'
    ) then
      raise exception using errcode = '55000',
        message = 'company_discovery_review_not_awaiting';
    end if;
    raise exception using errcode = '42501',
      message = 'company_discovery_review_result_not_owner';
  end if;
  if v_job.version is distinct from p_expected_version then
    raise exception using errcode = '40001', message = 'company_discovery_stale_version';
  end if;
  if jsonb_typeof(p_decisions) <> 'array' or jsonb_array_length(p_decisions) = 0 then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_decisions_invalid';
  end if;
  select n.* into v_nonce
  from public.company_discovery_review_nonces n
  where n.job_id = p_job and n.result_id = p_result
    and n.created_by = v_owner
    and n.nonce_hash = extensions.digest(p_confirmation_nonce, 'sha256')
  for update;
  if v_nonce.id is null or v_nonce.consumed_at is not null
     or v_nonce.invalidated_at is not null
     or v_nonce.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501',
      message = 'company_discovery_review_nonce_invalid';
  end if;
  select array_agg((item->>'claim_id')::uuid order by (item->>'claim_id')::uuid),
         array_agg(distinct (item->>'claim_id')::uuid order by (item->>'claim_id')::uuid)
    into v_claim_ids, v_decision_ids
  from jsonb_array_elements(p_decisions) item
  where item->>'claim_id' ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  if cardinality(v_claim_ids) <> jsonb_array_length(p_decisions)
     or v_claim_ids is distinct from v_decision_ids
     or v_claim_ids is distinct from v_nonce.claim_ids then
    raise exception using errcode = '22023',
      message = 'company_discovery_review_claim_set_mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'ligou.v0_2.rules_versioning:' || v_job.tenant_id::text,
    0
  ));

  for v_decision in select value from jsonb_array_elements(p_decisions)
  loop
    if jsonb_typeof(v_decision) <> 'object'
       or (v_decision - array[
         'claim_id', 'decision', 'value', 'group_confirmed',
         'evidence_acknowledged', 'acknowledged_evidence_refs'
       ]::text[]) <> '{}'::jsonb then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_decision_schema_invalid';
    end if;
    select c.* into v_claim
    from public.discovery_claims c
    where c.id = (v_decision->>'claim_id')::uuid
      and c.result_id = p_result
    for update;
    if v_claim.id is null then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_claim_set_mismatch';
    end if;
    if v_claim.claim_class = 'owner_private' then
      raise exception using errcode = '22023',
        message = 'company_discovery_owner_private_fact_forbidden';
    end if;
    v_decision_kind := v_decision->>'decision';
    if v_decision_kind not in ('approve', 'edit', 'reject') then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_decision_invalid';
    end if;
    if v_decision_kind = 'edit' and not (v_decision ? 'value') then
      raise exception using errcode = '22023',
        message = 'company_discovery_review_edit_value_required';
    end if;
    v_value := case when v_decision_kind = 'edit'
      then v_decision->'value' else v_claim.normalized_value end;
    if v_decision_kind <> 'reject'
       and public.company_discovery_json_has_forbidden_keys(v_value) then
      raise exception using errcode = '22023',
        message = 'company_discovery_forbidden_result_field';
    end if;
    v_decision_id := gen_random_uuid();
    v_rule_id := null;
    v_profile_id := null;

    if v_decision_kind <> 'reject' and v_claim.claim_class = 'descriptive' then
      if v_claim.claim_type not in (
           'business_name', 'business_description', 'public_phone',
           'public_email', 'public_address', 'public_website'
         )
         or jsonb_typeof(v_value) <> 'string'
         or length(v_value #>> '{}') not between 1 and 2000 then
        raise exception using errcode = '22023',
          message = 'company_discovery_descriptive_value_invalid';
      end if;
      select bp.version, bp.profile into v_profile_version, v_profile
      from public.business_profile_versions bp
      where bp.tenant_id = v_job.tenant_id
      order by bp.version desc
      limit 1
      for update;
      v_profile_version := coalesce(v_profile_version, 0) + 1;
      v_profile := coalesce(v_profile, '{}'::jsonb) ||
        jsonb_build_object(v_claim.claim_type, v_value);
      insert into public.business_profile_versions (
        tenant_id, version, profile, source_job_id, source_result_id,
        source_claim_id, approved_by
      ) values (
        v_job.tenant_id, v_profile_version, v_profile, v_job.id, p_result,
        v_claim.id, v_owner
      ) returning id into v_profile_id;
    elsif v_decision_kind <> 'reject' then
      if coalesce((v_decision->>'group_confirmed')::boolean, false) is not true then
        raise exception using errcode = '22023',
          message = 'company_discovery_operational_confirmation_required';
      end if;
      if v_claim.claim_class = 'safety_critical' and (
        coalesce((v_decision->>'evidence_acknowledged')::boolean, false) is not true
        or coalesce(v_decision->'acknowledged_evidence_refs', '[]'::jsonb)
          is distinct from to_jsonb(v_claim.evidence_refs)
      ) then
        raise exception using errcode = '22023',
          message = 'company_discovery_safety_evidence_ack_required';
      end if;

      if v_claim.claim_class = 'operational' and v_claim.claim_type = 'service' then
        if jsonb_typeof(v_value) <> 'object'
           or (v_value - array[
             'service_type', 'service_names', 'price_mode',
             'negotiation_mode', 'price_target', 'price_min', 'duration_min'
           ]::text[]) <> '{}'::jsonb
           or coalesce(v_value->>'service_type', '') !~ '^[a-z0-9][a-z0-9_]{0,199}$'
           or jsonb_typeof(v_value->'service_names') <> 'array'
           or jsonb_array_length(v_value->'service_names') not between 1 and 20
           or exists (
             select 1 from jsonb_array_elements(v_value->'service_names') name
             where jsonb_typeof(name) <> 'string'
               or length(name #>> '{}') not between 1 and 200
           )
           or v_value->>'price_mode' not in ('fixed', 'starting_at')
           or v_value->>'negotiation_mode' not in ('negotiable', 'non_negotiable')
           or jsonb_typeof(v_value->'price_target') <> 'number'
           or jsonb_typeof(v_value->'price_min') <> 'number'
           or jsonb_typeof(v_value->'duration_min') <> 'number'
           or (v_value->>'price_target')::numeric < 0
           or (v_value->>'price_min')::numeric < 0
           or (v_value->>'price_min')::numeric > (v_value->>'price_target')::numeric
           or (v_value->>'duration_min')::numeric <= 0
           or (
             v_value->>'negotiation_mode' = 'non_negotiable'
             and (v_value->>'price_min')::numeric is distinct from
               (v_value->>'price_target')::numeric
           ) then
          raise exception using errcode = '22023',
            message = 'company_discovery_service_value_invalid';
        end if;
        v_service_type := v_value->>'service_type';
        v_derived_category := 'preco';
        v_derived_scope := 'servico';
        v_derived_schema := 'ligou.rule.service.v2';
        v_materialization_key := 'service:' || v_service_type;
        v_derived_text := format(
          'Serviço %s: preço público %s; duração %s minutos.',
          v_service_type, v_value->>'price_target', v_value->>'duration_min'
        );
        v_derived_structured := jsonb_build_object(
          'schema', v_derived_schema,
          'materialization_key', v_materialization_key,
          'materialization_eligible', true,
          'review_ready', true,
          'operational_state', 'active',
          'service_type', v_service_type,
          'service_names', v_value->'service_names',
          'price_mode', v_value->>'price_mode',
          'negotiation_mode', v_value->>'negotiation_mode',
          'quoteable', true,
          'negotiable', v_value->>'negotiation_mode' = 'negotiable',
          'price_target', v_value->'price_target',
          'price_min', v_value->'price_min',
          'duration_min', v_value->'duration_min',
          'owner_review_fields', '[]'::jsonb
        );
      elsif v_claim.claim_class = 'safety_critical'
            and v_claim.claim_type = 'emergency' then
        if jsonb_typeof(v_value) <> 'object'
           or (v_value - array['guidance']::text[]) <> '{}'::jsonb
           or jsonb_typeof(v_value->'guidance') <> 'string'
           or length(v_value->>'guidance') not between 1 and 2000 then
          raise exception using errcode = '22023',
            message = 'company_discovery_emergency_value_invalid';
        end if;
        v_derived_category := 'emergencia';
        v_derived_scope := 'geral';
        v_derived_schema := 'ligou.rule.emergency.v2';
        v_materialization_key := 'domain:emergency';
        v_derived_text := v_value->>'guidance';
        v_derived_structured := jsonb_build_object(
          'schema', v_derived_schema,
          'materialization_key', v_materialization_key,
          'materialization_eligible', true,
          'review_ready', true,
          'operational_state', 'active',
          'owner_review_fields', '[]'::jsonb,
          'fields', jsonb_build_object(
            'safety_escalation', v_value->>'guidance'
          )
        );
      else
        raise exception using errcode = '22023',
          message = 'company_discovery_claim_materialization_type_invalid';
      end if;

      select array_agg(distinct r.rule_group_id order by r.rule_group_id)
        into v_rule_group_ids
      from public.rules r
      where r.tenant_id = v_job.tenant_id
        and r.structured->>'materialization_key' = v_materialization_key;
      if coalesce(cardinality(v_rule_group_ids), 0) > 1 then
        raise exception using errcode = '55000',
          message = 'company_discovery_materialization_group_ambiguous';
      end if;
      if cardinality(v_rule_group_ids) = 1 then
        v_rule_group_id := v_rule_group_ids[1];
      else
        v_group_hex := md5(
          v_job.tenant_id::text || '|company_discovery|' || v_materialization_key
        );
        v_rule_group_id := (
          substr(v_group_hex, 1, 8) || '-' ||
          substr(v_group_hex, 9, 4) || '-' ||
          substr(v_group_hex, 13, 4) || '-' ||
          substr(v_group_hex, 17, 4) || '-' ||
          substr(v_group_hex, 21, 12)
        )::uuid;
      end if;
      select coalesce(max(r.version), 0) + 1 into v_rule_version
      from public.rules r
      where r.tenant_id = v_job.tenant_id
        and r.rule_group_id = v_rule_group_id;

      v_structured := v_derived_structured || jsonb_build_object(
        'source_kind', 'company_discovery',
        'source_job_id', v_job.id,
        'source_result_id', p_result,
        'source_claim_id', v_claim.id,
        'source_decision_id', v_decision_id,
        'source_refs', to_jsonb(v_claim.evidence_refs)
      );
      v_structured := v_structured || jsonb_build_object(
        'materialization_hash', encode(extensions.digest(
          convert_to((jsonb_build_object(
            'category', v_derived_category,
            'scope', v_derived_scope,
            'text', v_derived_text,
            'structured', v_structured - 'materialization_hash'
          ))::text, 'utf8'), 'sha256'
        ), 'hex')
      );
      insert into public.rules (
        tenant_id, rule_group_id, version, origem, escopo, status,
        category, text, structured,
        evidence_quote, related_call_id, approved_by, approved_at
      ) values (
        v_job.tenant_id, v_rule_group_id, v_rule_version,
        'company_discovery', v_derived_scope,
        'aprovado', v_derived_category,
        v_derived_text, v_structured,
        (
          select string_agg(s.excerpt, E'\n' order by s.crawl_order)
          from public.discovery_source_snapshots s
          where s.id = any(v_claim.evidence_refs)
        ),
        null, v_owner, clock_timestamp()
      ) returning id into v_rule_id;
    end if;

    insert into public.discovery_decisions (
      id, tenant_id, job_id, result_id, claim_id, decision, decided_value,
      confirmation_nonce_id, evidence_acknowledged, resulting_rule_id,
      resulting_profile_version_id, decided_by
    ) values (
      v_decision_id, v_job.tenant_id, v_job.id, p_result, v_claim.id,
      v_decision_kind, case when v_decision_kind = 'reject' then null else v_value end,
      v_nonce.id,
      coalesce((v_decision->>'evidence_acknowledged')::boolean, false),
      v_rule_id, v_profile_id, v_owner
    );
    v_reviewed := v_reviewed + 1;
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
  set status = case
        when exists (
          select 1 from public.discovery_claims c
          where c.result_id = p_result
            and not exists (
              select 1 from public.discovery_decisions d where d.claim_id = c.id
            )
        ) then 'awaiting_review'
        else 'reviewed'
      end,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'result_id', p_result, 'reviewed', v_reviewed,
    'version', v_job.version + 1
  );
end;
$$;

revoke all on function public.review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.review_company_discovery_claims(uuid,uuid,bigint,jsonb,text)
  to authenticated;

-- ---------------------------------------------------------------- supervisor RPCs
create or replace function public.claim_company_discovery_attempt(
  p_worker_id text,
  p_lease_seconds integer
) returns table (
  job_id uuid,
  attempt_id uuid,
  attempt_number integer,
  fence_generation bigint,
  claim_token text,
  normalized_origin text,
  deadline_at timestamp with time zone,
  budget jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.worker_jobs;
  v_slot public.worker_runtime_slots;
  v_attempt uuid := gen_random_uuid();
  v_attempt_number integer;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_lease_seconds not between 1 and 600 then
    raise exception using errcode = '22023',
      message = 'company_discovery_claim_invalid';
  end if;
  insert into public.worker_runtime_slots (
    slot_name, supervisor_worker_id, status
  ) values (btrim(p_worker_id), btrim(p_worker_id), 'available')
  on conflict (slot_name) do nothing;
  select s.* into v_slot
  from public.worker_runtime_slots s
  where s.slot_name = btrim(p_worker_id) and s.status = 'available'
  for update skip locked;
  if v_slot.id is null then return; end if;
  select j.* into v_job
  from public.worker_jobs j
  where j.status = 'queued' and j.deadline_at > clock_timestamp()
    and exists (
      select 1 from public.company_discovery_controls c
      where c.singleton and c.enabled
    )
    and exists (
      select 1 from public.company_discovery_allowlist a
      where a.tenant_id = j.tenant_id and a.active
        and (a.expires_at is null or a.expires_at > clock_timestamp())
    )
  order by j.created_at, j.id
  limit 1
  for update skip locked;
  if v_job.id is null then return; end if;
  select coalesce(max(a.attempt_number), 0) + 1
    into v_attempt_number
  from public.worker_attempts a where a.job_id = v_job.id;
  insert into public.worker_attempts (
    id, tenant_id, job_id, attempt_number, adapter_id,
    fence_generation, claim_token_hash, claimed_by, lease_until,
    runtime_slot_id, runtime_identity
  ) values (
    v_attempt, v_job.tenant_id, v_job.id, v_attempt_number, v_slot.adapter_id,
    v_job.fence_generation, extensions.digest(v_token, 'sha256'), btrim(p_worker_id),
    clock_timestamp() + make_interval(secs => p_lease_seconds),
    v_slot.id, jsonb_build_object('slot_id', v_slot.id, 'worker_id', btrim(p_worker_id))
  );
  update public.worker_jobs
  set status = 'running', current_attempt_id = v_attempt,
      version = version + 1, updated_at = clock_timestamp()
  where id = v_job.id;
  update public.worker_runtime_slots
  set tenant_id = v_job.tenant_id, status = 'busy',
      current_attempt_id = v_attempt, updated_at = clock_timestamp()
  where id = v_slot.id;
  return query select
    v_job.id, v_attempt, v_attempt_number, v_job.fence_generation,
    v_token, v_job.normalized_origin, v_job.deadline_at, v_job.budget;
end;
$$;

revoke all on function public.claim_company_discovery_attempt(text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_company_discovery_attempt(text,integer)
  to service_role;

create or replace function public.commit_company_discovery_result(
  p_attempt_id uuid,
  p_fence_generation bigint,
  p_claim_token text,
  p_result jsonb,
  p_result_hash text
) returns uuid
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
  v_claim jsonb;
  v_snapshot_ids uuid[] := '{}'::uuid[];
  v_evidence_ids uuid[];
  v_order integer;
begin
  select a.* into v_attempt
  from public.worker_attempts a
  where a.id = p_attempt_id
  for update;
  if v_attempt.id is null then
    raise exception using errcode = '55000', message = 'company_discovery_attempt_not_found';
  end if;
  select j.* into v_job
  from public.worker_jobs j where j.id = v_attempt.job_id
  for update;
  if v_attempt.status <> 'running' then
    raise exception using errcode = '55000', message = 'company_discovery_attempt_terminal';
  end if;
  if v_job.current_attempt_id is distinct from v_attempt.id then
    raise exception using errcode = '55000', message = 'company_discovery_attempt_not_current';
  end if;
  if v_job.fence_generation is distinct from p_fence_generation
     or v_attempt.fence_generation is distinct from p_fence_generation then
    raise exception using errcode = '40001', message = 'company_discovery_stale_fence';
  end if;
  if v_attempt.claim_token_hash is distinct from extensions.digest(p_claim_token, 'sha256') then
    raise exception using errcode = '42501', message = 'company_discovery_claim_token_invalid';
  end if;
  if v_attempt.lease_until <= clock_timestamp()
     or v_job.deadline_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'company_discovery_attempt_lease_expired';
  end if;
  if jsonb_typeof(p_result) <> 'object'
     or not (p_result ?& array[
       'schema_version', 'source_snapshots', 'candidate_facts',
       'missing_questions', 'contradictions', 'uncertainty'
     ])
     or (p_result - array[
       'schema_version', 'source_snapshots', 'candidate_facts',
       'missing_questions', 'contradictions', 'uncertainty'
     ]::text[]) <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_top_level_invalid';
  end if;
  if octet_length(p_result::text) > 10485760 then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_payload_too_large';
  end if;
  if p_result->>'schema_version' <> 'company_discovery.result.v1'
     or jsonb_typeof(p_result->'source_snapshots') <> 'array'
     or jsonb_typeof(p_result->'candidate_facts') <> 'array'
     or jsonb_typeof(p_result->'missing_questions') <> 'array'
     or jsonb_typeof(p_result->'contradictions') <> 'array'
     or jsonb_typeof(p_result->'uncertainty') <> 'object' then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_schema_invalid';
  end if;
  if public.company_discovery_json_has_forbidden_keys(p_result) then
    raise exception using errcode = '22023',
      message = 'company_discovery_forbidden_result_field';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_result->'candidate_facts') fact
    where fact->>'claim_class' = 'owner_private'
  ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_owner_private_fact_forbidden';
  end if;
  if jsonb_array_length(p_result->'source_snapshots') not between 1 and 25 then
    raise exception using errcode = '22023', message = 'company_discovery_source_limit_exceeded';
  end if;
  if jsonb_array_length(p_result->'candidate_facts') > 100
     or jsonb_array_length(p_result->'missing_questions') > 50
     or jsonb_array_length(p_result->'contradictions') > 50
     or octet_length((p_result->'uncertainty')::text) > 4096 then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_collection_limit_exceeded';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_result->'missing_questions') item
    where jsonb_typeof(item) <> 'string'
      or length(item #>> '{}') not between 1 and 1000
  ) or exists (
    select 1 from jsonb_array_elements(p_result->'contradictions') item
    where jsonb_typeof(item) <> 'string'
      or length(item #>> '{}') not between 1 and 2000
  ) then
    raise exception using errcode = '22023',
      message = 'company_discovery_result_collection_item_invalid';
  end if;

  -- Validate the complete candidate envelope before the immutable result row exists.
  for v_snapshot in select value from jsonb_array_elements(p_result->'source_snapshots')
  loop
    if jsonb_typeof(v_snapshot) <> 'object'
       or not (v_snapshot ?& array[
         'url','retrieved_at','http_status','mime_type','byte_length','content_hash',
         'excerpt','crawl_order','crawl_depth'
       ])
       or (v_snapshot - array[
         'url','retrieved_at','http_status','mime_type','byte_length','content_hash',
         'excerpt','crawl_order','crawl_depth'
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
  for v_claim in select value from jsonb_array_elements(p_result->'candidate_facts')
  loop
    if jsonb_typeof(v_claim) <> 'object'
       or not (v_claim ?& array[
         'claim_class','claim_type','normalized_value','evidence_refs',
         'contradictions','uncertainty'
       ])
       or (v_claim - array[
         'claim_class','claim_type','normalized_value','evidence_refs',
         'contradictions','uncertainty'
       ]::text[]) <> '{}'::jsonb
       or v_claim->>'claim_class' not in ('descriptive','operational','safety_critical')
       or jsonb_typeof(v_claim->'claim_type') <> 'string'
       or length(v_claim->>'claim_type') not between 1 and 200
       or jsonb_typeof(v_claim->'evidence_refs') <> 'array'
       or jsonb_array_length(v_claim->'evidence_refs') not between 1 and 25
       or exists (
         select 1 from jsonb_array_elements(v_claim->'evidence_refs') ref
         where jsonb_typeof(ref) <> 'number' or (ref #>> '{}') !~ '^[0-9]+$'
       )
       or jsonb_typeof(v_claim->'contradictions') <> 'array'
       or jsonb_array_length(v_claim->'contradictions') > 20
       or exists (
         select 1 from jsonb_array_elements(v_claim->'contradictions') item
         where jsonb_typeof(item) <> 'string'
           or length(item #>> '{}') not between 1 and 2000
       )
       or jsonb_typeof(v_claim->'uncertainty') <> 'object'
       or octet_length((v_claim->'uncertainty')::text) > 4096 then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_schema_invalid';
    end if;
    if octet_length((v_claim->'normalized_value')::text) > 65536 then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_value_too_large';
    end if;
    if not (
      (
        v_claim->>'claim_class' = 'descriptive'
        and v_claim->>'claim_type' in (
          'business_name', 'business_description', 'public_phone',
          'public_email', 'public_address', 'public_website'
        )
        and jsonb_typeof(v_claim->'normalized_value') = 'string'
        and length(v_claim->'normalized_value' #>> '{}') between 1 and 2000
      ) or (
        v_claim->>'claim_class' = 'operational'
        and v_claim->>'claim_type' = 'service'
        and jsonb_typeof(v_claim->'normalized_value') = 'object'
        and (v_claim->'normalized_value' ?& array[
          'service_type', 'service_names', 'price_mode', 'negotiation_mode',
          'price_target', 'price_min', 'duration_min'
        ])
        and ((v_claim->'normalized_value') - array[
          'service_type', 'service_names', 'price_mode', 'negotiation_mode',
          'price_target', 'price_min', 'duration_min'
        ]::text[]) = '{}'::jsonb
      ) or (
        v_claim->>'claim_class' = 'safety_critical'
        and v_claim->>'claim_type' = 'emergency'
        and jsonb_typeof(v_claim->'normalized_value') = 'object'
        and ((v_claim->'normalized_value') - array['guidance']::text[]) = '{}'::jsonb
        and jsonb_typeof(v_claim->'normalized_value'->'guidance') = 'string'
        and length(v_claim->'normalized_value'->>'guidance') between 1 and 2000
      )
    ) then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_materialization_type_invalid';
    end if;
  end loop;
  v_actual_hash := encode(extensions.digest(convert_to(p_result::text, 'utf8'), 'sha256'), 'hex');
  if p_result_hash is distinct from v_actual_hash then
    raise exception using errcode = '22000', message = 'company_discovery_result_hash_mismatch';
  end if;
  insert into public.worker_results (
    id, tenant_id, job_id, attempt_id, fence_generation,
    candidate_result, result_hash
  ) values (
    v_result_id, v_job.tenant_id, v_job.id, v_attempt.id,
    p_fence_generation, p_result, p_result_hash
  );
  for v_snapshot in select value from jsonb_array_elements(p_result->'source_snapshots')
  loop
    if (v_snapshot - array[
      'url','retrieved_at','http_status','mime_type','byte_length','content_hash',
      'excerpt','crawl_order','crawl_depth'
    ]::text[]) <> '{}'::jsonb then
      raise exception using errcode = '22023',
        message = 'company_discovery_source_schema_invalid';
    end if;
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
      v_snapshot->>'url', (v_snapshot->>'retrieved_at')::timestamp with time zone,
      (v_snapshot->>'http_status')::integer, v_snapshot->>'mime_type',
      (v_snapshot->>'byte_length')::integer, v_snapshot->>'content_hash',
      v_snapshot->>'excerpt', (v_snapshot->>'crawl_order')::integer,
      (v_snapshot->>'crawl_depth')::integer
    ) returning id into v_snapshot_id;
    v_snapshot_ids := array_append(v_snapshot_ids, v_snapshot_id);
  end loop;
  for v_claim in select value from jsonb_array_elements(p_result->'candidate_facts')
  loop
    if (v_claim - array[
      'claim_class','claim_type','normalized_value','evidence_refs',
      'contradictions','uncertainty'
    ]::text[]) <> '{}'::jsonb
       or v_claim->>'claim_class' not in ('descriptive','operational','safety_critical')
       or coalesce(v_claim->>'claim_type', '') = ''
       or jsonb_typeof(v_claim->'evidence_refs') <> 'array' then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_schema_invalid';
    end if;
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
      v_evidence_ids := array_append(v_evidence_ids, v_snapshot_ids[v_order + 1]);
    end loop;
    select array_agg(distinct evidence_id order by evidence_id)
      into v_evidence_ids from unnest(v_evidence_ids) evidence_id;
    if coalesce(cardinality(v_evidence_ids), 0) = 0 then
      raise exception using errcode = '22023',
        message = 'company_discovery_claim_evidence_invalid';
    end if;
    insert into public.discovery_claims (
      tenant_id, job_id, attempt_id, result_id, claim_class, claim_type,
      normalized_value, evidence_refs, contradictions, uncertainty
    ) values (
      v_job.tenant_id, v_job.id, v_attempt.id, v_result_id,
      v_claim->>'claim_class', v_claim->>'claim_type',
      v_claim->'normalized_value', v_evidence_ids,
      coalesce(v_claim->'contradictions', '[]'::jsonb),
      coalesce(v_claim->'uncertainty', '{}'::jsonb)
    );
  end loop;
  update public.worker_attempts
  set status = 'validated', result_id = v_result_id,
      terminal_at = clock_timestamp()
  where id = v_attempt.id;
  update public.worker_jobs
  set status = 'awaiting_review', version = version + 1,
      fallback_state = 'discovery_available', updated_at = clock_timestamp()
  where id = v_job.id;
  return v_result_id;
end;
$$;

revoke all on function public.commit_company_discovery_result(uuid,bigint,text,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.commit_company_discovery_result(uuid,bigint,text,jsonb,text)
  to service_role;

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
begin
  select j.* into v_job from public.worker_jobs j
  where j.id = p_job_id for update;
  if v_job.id is null then
    raise exception using errcode = '55000', message = 'company_discovery_job_not_found';
  end if;
  if v_job.version is distinct from p_expected_version then
    raise exception using errcode = '40001', message = 'company_discovery_stale_version';
  end if;
  if v_job.selected_attempt_id is not null then
    raise exception using errcode = '55000',
      message = 'company_discovery_result_already_selected';
  end if;
  select a.* into v_attempt from public.worker_attempts a
  where a.id = p_attempt_id and a.job_id = v_job.id for update;
  if v_attempt.id is null or v_job.current_attempt_id is distinct from v_attempt.id then
    raise exception using errcode = '55000', message = 'company_discovery_attempt_not_current';
  end if;
  if v_attempt.fence_generation is distinct from v_job.fence_generation then
    raise exception using errcode = '40001', message = 'company_discovery_stale_fence';
  end if;
  select wr.* into v_result from public.worker_results wr
  where wr.attempt_id = v_attempt.id for update;
  if v_result.id is null or v_result.validation_state <> 'validated'
     or v_attempt.status <> 'validated' then
    raise exception using errcode = '55000',
      message = 'company_discovery_result_not_validated';
  end if;
  update public.worker_attempts set status = 'selected' where id = v_attempt.id;
  update public.worker_jobs
  set selected_attempt_id = v_attempt.id, status = 'awaiting_review',
      fence_generation = fence_generation + 1, version = version + 1,
      fallback_state = 'discovery_selected', updated_at = clock_timestamp()
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'attempt_id', v_attempt.id, 'result_id', v_result.id,
    'version', v_job.version + 1,
    'fence_generation', v_job.fence_generation + 1
  );
end;
$$;

revoke all on function public.select_company_discovery_result(uuid,uuid,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.select_company_discovery_result(uuid,uuid,bigint)
  to service_role;

create or replace function public.record_company_discovery_cleanup(
  p_attempt_id uuid,
  p_fence_generation bigint,
  p_claim_token text,
  p_proof jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.worker_attempts;
  v_proved boolean;
  v_slot_rows integer := 0;
  v_slot_updated boolean := false;
begin
  select a.* into v_attempt from public.worker_attempts a
  where a.id = p_attempt_id for update;
  if v_attempt.id is null then
    raise exception using errcode = '55000', message = 'company_discovery_attempt_not_found';
  end if;
  if v_attempt.fence_generation is distinct from p_fence_generation then
    raise exception using errcode = '40001', message = 'company_discovery_stale_fence';
  end if;
  if v_attempt.claim_token_hash is distinct from extensions.digest(p_claim_token, 'sha256') then
    raise exception using errcode = '42501', message = 'company_discovery_claim_token_invalid';
  end if;
  if v_attempt.status not in ('validated', 'selected', 'cancelled', 'failed', 'superseded') then
    raise exception using errcode = '55000',
      message = 'company_discovery_cleanup_attempt_not_terminal';
  end if;
  if v_attempt.cleanup_state <> 'pending' then
    raise exception using errcode = '55000', message = 'company_discovery_cleanup_already_recorded';
  end if;
  v_proved := jsonb_typeof(p_proof) = 'object'
    and p_proof->'gateway_exited' = 'true'::jsonb
    and p_proof->'container_removed' = 'true'::jsonb
    and p_proof->'state_removed' = 'true'::jsonb
    and p_proof->'workspace_removed' = 'true'::jsonb
    and p_proof->'output_removed' = 'true'::jsonb
    and p_proof->'network_removed' = 'true'::jsonb
    and p_proof->'credential_revoked' = 'true'::jsonb
    and p_proof->'listener_closed' = 'true'::jsonb
    and p_proof->'late_result_rejected' = 'true'::jsonb;
  update public.worker_attempts
  set cleanup_state = case when v_proved then 'proved' else 'cleanup_unresolved' end,
      cleanup_proof = p_proof
  where id = v_attempt.id;
  update public.worker_runtime_slots
  set status = case when v_proved then 'available' else 'quarantined' end,
      tenant_id = case when v_proved then null else tenant_id end,
      current_attempt_id = null,
      quarantine_reason = case when v_proved then null else 'cleanup_unresolved' end,
      quarantine_proof_hash = case when v_proved then null else encode(extensions.digest(
        convert_to(coalesce(p_proof, '{}'::jsonb)::text, 'utf8'), 'sha256'
      ), 'hex') end,
      updated_at = clock_timestamp()
  where id = v_attempt.runtime_slot_id
    and current_attempt_id = v_attempt.id;
  get diagnostics v_slot_rows = row_count;
  v_slot_updated := v_slot_rows = 1;
  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'cleanup_state', case when v_proved then 'proved' else 'cleanup_unresolved' end,
    'slot_updated', v_slot_updated
  );
end;
$$;

revoke all on function public.record_company_discovery_cleanup(uuid,bigint,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_company_discovery_cleanup(uuid,bigint,text,jsonb)
  to service_role;

create or replace function public.quarantine_company_discovery_slot(
  p_slot_id uuid,
  p_reason text,
  p_proof_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null or btrim(p_reason) = ''
     or p_proof_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023',
      message = 'company_discovery_quarantine_proof_invalid';
  end if;
  update public.worker_runtime_slots
  set status = 'quarantined', quarantine_reason = btrim(p_reason),
      quarantine_proof_hash = p_proof_hash,
      updated_at = clock_timestamp()
  where id = p_slot_id;
  if not found then
    raise exception using errcode = '55000', message = 'company_discovery_slot_not_found';
  end if;
end;
$$;

revoke all on function public.quarantine_company_discovery_slot(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.quarantine_company_discovery_slot(uuid,text,text)
  to service_role;
