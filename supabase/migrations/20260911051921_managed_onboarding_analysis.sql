-- Source-only structured analysis: OpenAI owns the harness; Ligou owns jobs/results.
-- No global Discovery enable, source crawl, source selection or owner approval here.
begin;

alter table public.worker_attempts drop constraint worker_attempts_adapter_id_check;
alter table public.worker_attempts add constraint worker_attempts_adapter_id_check
  check (adapter_id in ('openclaw', 'direct_model', 'openai_agents'));

create table public.company_discovery_managed_runs (
  job_id uuid primary key,
  tenant_id uuid not null,
  attempt_id uuid not null unique,
  source_result_id uuid not null,
  input_version text not null check (input_version ~ '^[a-f0-9]{64}$'),
  launch_token uuid not null default gen_random_uuid(),
  state text not null default 'prepared' check (state in
    ('prepared','launching','running','completed','failed','cancel_requested','cancelled')),
  session_id text unique,
  turn_id text,
  observation jsonb not null default '{}'::jsonb,
  retention_delete_at timestamptz,
  provider_deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (job_id, tenant_id) references public.worker_jobs(id, tenant_id),
  foreign key (attempt_id, tenant_id) references public.worker_attempts(id, tenant_id),
  foreign key (source_result_id, tenant_id) references public.worker_results(id, tenant_id),
  check (session_id is null or length(session_id) between 1 and 200),
  check (turn_id is null or length(turn_id) between 1 and 200),
  check (jsonb_typeof(observation) = 'object')
);
alter table public.company_discovery_managed_runs enable row level security;
alter table public.company_discovery_managed_runs force row level security;
revoke all on public.company_discovery_managed_runs from public, anon, authenticated, service_role;
grant select on public.company_discovery_managed_runs to service_role;

-- A copied analysis is a report until explicitly selected. Do not let its newer
-- worker_job hide the currently selected website in the owner's setup page.
do $managed_setup_selection$
declare item record; body text; anchor text:='where j.tenant_id = v_tenant.id'; changed integer:=0;
begin
  for item in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'company_discovery_setup_status%' or p.proname='start_company_discovery_setup')
  loop
    body:=pg_get_functiondef(item.oid);
    if position(anchor in body)>0 then
      body:=replace(body,anchor,anchor||'
      and (j.selected_attempt_id is not null or not exists (
        select 1 from public.company_discovery_managed_runs managed where managed.job_id=j.id
      ))');
      execute body;changed:=changed+1;
    end if;
  end loop;
  if changed<1 then raise exception 'managed_setup_selector_contract_missing';end if;
end;
$managed_setup_selection$;

create function public.guard_managed_analysis_executor() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='queued' and exists(select 1 from public.company_discovery_managed_runs m where m.job_id=new.id) then
    raise exception 'managed_analysis_requires_session_reconciliation';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_managed_analysis_executor() from public,anon,authenticated,service_role;
create trigger managed_analysis_no_legacy_executor before update of status on public.worker_jobs
  for each row execute function public.guard_managed_analysis_executor();

-- Reuse the product's existing validation and candidate persistence. Only the
-- transport authority and provenance differ; direct-model rollback remains intact.
do $managed_contract$
declare body text; before text; after text;
begin
  select pg_get_functiondef('public.commit_company_discovery_result_v2(uuid,bigint,text,jsonb,text)'::regprocedure) into body;
  before := 'if not (v_attempt.adapter_id = ''direct_model'') then';
  if position(before in body) = 0 then raise exception 'managed_commit_adapter_contract_missing'; end if;
  body := replace(body, before, 'if v_attempt.adapter_id not in (''direct_model'', ''openai_agents'') then');
  before := 'or v_attempt.runtime_identity->>''runtime_kind''
       <> ''direct_model_subscription'' then';
  after := 'or (v_attempt.adapter_id = ''direct_model'' and v_attempt.runtime_identity->>''runtime_kind'' <> ''direct_model_subscription'')
     or (v_attempt.adapter_id = ''openai_agents'' and not exists (
       select 1 from public.company_discovery_managed_runs m
       join public.worker_results src on src.id=m.source_result_id and src.tenant_id=m.tenant_id
       where m.attempt_id=v_attempt.id and m.job_id=v_job.id and m.tenant_id=v_job.tenant_id
         and m.state=''completed'' and m.session_id is not null and m.turn_id is not null
         and m.observation->>''provider_status''=''completed''
         and m.input_version=src.result_hash
         and p_result->''source_snapshots''=src.candidate_result->''source_snapshots''
         and v_attempt.runtime_identity->>''runtime_kind''=''openai_agents_none''
     )) then';
  if position(before in body)=0 then raise exception 'managed_commit_runtime_contract_missing'; end if;
  body := replace(body,before,after);
  before := 'if v_attempt.lease_until <= clock_timestamp()
     or v_job.deadline_at <= clock_timestamp() then';
  if position(before in body)=0 then raise exception 'managed_commit_lease_contract_missing'; end if;
  body := replace(body,before,'if v_attempt.adapter_id <> ''openai_agents'' and (v_attempt.lease_until <= clock_timestamp()
     or v_job.deadline_at <= clock_timestamp()) then');
  before := '''direct_model'', ''openai-codex'', ''gpt-5.6-sol'',';
  if position(before in body)=0 then raise exception 'managed_commit_provenance_contract_missing'; end if;
  body := replace(body,before,'v_attempt.adapter_id, case when v_attempt.adapter_id=''openai_agents'' then ''openai'' else ''openai-codex'' end,
      case when v_attempt.adapter_id=''openai_agents'' then ''gpt-5.6-terra'' else ''gpt-5.6-sol'' end,');
  before := 'provider_metadata = jsonb_build_object(';
  if position(before in body)=0 then raise exception 'managed_commit_metadata_contract_missing'; end if;
  body := replace(body,before,'provider_metadata = case when v_attempt.adapter_id=''openai_agents'' then v_attempt.provider_metadata else jsonb_build_object(');
  before := '''result_schema'', ''company_discovery.result.v2''
      ),';
  if position(before in body)=0 then raise exception 'managed_commit_metadata_end_missing'; end if;
  body := replace(body,before,'''result_schema'', ''company_discovery.result.v2''
      ) end,');
  execute body;

  select pg_get_functiondef(p.oid) into body from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='review_company_discovery_claims_v2';
  before := 'and c.adapter_id = ''direct_model''
      and c.provider = ''openai-codex''
      and c.model = ''gpt-5.6-sol''';
  if position(before in body)=0 then raise exception 'managed_review_provenance_contract_missing'; end if;
  body := replace(body,before,'and ((c.adapter_id=''direct_model'' and c.provider=''openai-codex'' and c.model=''gpt-5.6-sol'')
        or (c.adapter_id=''openai_agents'' and c.provider=''openai'' and c.model=''gpt-5.6-terra''))');
  execute body;
end;
$managed_contract$;

alter table public.discovery_claims drop constraint discovery_claims_stage0b_provenance_check;
alter table public.discovery_claims add constraint discovery_claims_stage0b_provenance_check check (
  (claim_schema_version='company_discovery.claim.v1' and adapter_id is null and provider is null
    and model is null and confidence is null and contradiction_status is null)
  or (claim_schema_version='company_discovery.claim.v2' and confidence in ('high','medium','low')
    and contradiction_status in ('none','possible','confirmed')
    and ((adapter_id='direct_model' and provider='openai-codex' and model='gpt-5.6-sol')
      or (adapter_id='openai_agents' and provider='openai' and model='gpt-5.6-terra')))
);

create function public.find_company_discovery_managed_session(p_session_id text)
returns jsonb language sql security definer set search_path='' as $$
  select (to_jsonb(m)-array['launch_token','observation','provider_deleted_at']) || jsonb_build_object(
    'result_id',a.result_id,'source_snapshots',r.candidate_result->'source_snapshots',
    'usage',m.observation->'usage','provider_status',m.observation->>'provider_status','cost_state','unreconciled')
  from public.company_discovery_managed_runs m
  join public.worker_attempts a on a.id=m.attempt_id
  join public.worker_results r on r.id=m.source_result_id and r.tenant_id=m.tenant_id
  where m.session_id=p_session_id;
$$;
revoke all on function public.find_company_discovery_managed_session(text) from public,anon,authenticated;
grant execute on function public.find_company_discovery_managed_session(text) to service_role;

create function public.company_discovery_managed_job(p_action text,p_job_id uuid,p_tenant_id uuid,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  m public.company_discovery_managed_runs; j public.worker_jobs; a public.worker_attempts;
  src public.worker_results; source_job public.worker_jobs;
  new_job uuid:=gen_random_uuid(); new_attempt uuid:=gen_random_uuid(); token uuid:=gen_random_uuid();
  claim_won boolean:=false; obs jsonb; result jsonb; receipt jsonb; requested_deadline timestamptz;
begin
  if p_action='prepare' then
    select * into src from public.worker_results where id=p_job_id and tenant_id=p_tenant_id;
    if src.id is null or src.result_hash is distinct from p_payload->>'input_version'
      or jsonb_array_length(src.candidate_result->'source_snapshots') not between 1 and 25 then
      raise exception 'managed_analysis_source_version_invalid'; end if;
    select * into source_job from public.worker_jobs where id=src.job_id and tenant_id=p_tenant_id;
    if length(coalesce(p_payload->>'idempotency_key','')) not between 1 and 180 then raise exception 'managed_analysis_key_invalid'; end if;
    requested_deadline:=(p_payload->>'deadline_at')::timestamptz;
    if requested_deadline is null or requested_deadline<=clock_timestamp() then raise exception 'managed_analysis_deadline_invalid'; end if;
    perform pg_advisory_xact_lock(hashtextextended('ligou.managed.analysis:'||p_tenant_id::text||':'||(p_payload->>'idempotency_key'),0));
    select * into j from public.worker_jobs where tenant_id=p_tenant_id and idempotency_key='managed:'||(p_payload->>'idempotency_key');
    if j.id is not null then
      select * into m from public.company_discovery_managed_runs where job_id=j.id and tenant_id=p_tenant_id;
      if m.input_version is distinct from src.result_hash or m.source_result_id is distinct from src.id then raise exception 'managed_analysis_idempotency_conflict'; end if;
      new_job:=j.id;
    else
      -- Source-only jobs never enter the legacy supervisor's queued-work selector.
      insert into public.worker_jobs(id,tenant_id,normalized_origin,origin_host,registrable_domain,idempotency_key,request_hash,status,deadline_at,budget,processing_stage)
      values(new_job,p_tenant_id,source_job.normalized_origin,source_job.origin_host,source_job.registrable_domain,
        'managed:'||(p_payload->>'idempotency_key'),src.result_hash,'running',requested_deadline,source_job.budget,'analyzing');
      insert into public.worker_attempts(id,tenant_id,job_id,attempt_number,adapter_id,fence_generation,claim_token_hash,claimed_by,
        lease_until,runtime_identity,runtime_identity_hash,cleanup_state,cleanup_outcome,cleanup_proof)
      values(new_attempt,p_tenant_id,new_job,1,'openai_agents',1,extensions.digest(token::text,'sha256'),'openai-managed-analysis',
        requested_deadline,'{"runtime_kind":"openai_agents_none"}'::jsonb,
        encode(extensions.digest('{"runtime_kind":"openai_agents_none"}','sha256'),'hex'),'proved','runtime_cleanup_proved',
        '{"environment":"none","local_executor_created":false}'::jsonb);
      update public.worker_jobs set current_attempt_id=new_attempt,processing_stage='analyzing' where id=new_job;
      insert into public.company_discovery_managed_runs(job_id,tenant_id,attempt_id,source_result_id,input_version,launch_token,retention_delete_at)
      values(new_job,p_tenant_id,new_attempt,src.id,src.result_hash,token,(p_payload->>'retention_delete_at')::timestamptz);
    end if;
    p_job_id:=new_job;
  end if;
  select * into m from public.company_discovery_managed_runs where job_id=p_job_id and tenant_id=p_tenant_id for update;
  if m.job_id is null then raise exception 'managed_analysis_job_not_found'; end if;
  select * into j from public.worker_jobs where id=m.job_id and tenant_id=m.tenant_id for update;
  select * into a from public.worker_attempts where id=m.attempt_id and tenant_id=m.tenant_id for update;
  if j.current_attempt_id is distinct from a.id then raise exception 'managed_analysis_stale_attempt'; end if;
  if p_action='claim' then
    if m.state='prepared' and j.status='running' and j.deadline_at>clock_timestamp() then
      update public.company_discovery_managed_runs set state='launching',updated_at=clock_timestamp() where job_id=m.job_id returning * into m;
      claim_won:=true;
    end if;
  elsif p_action='bind' then
    if length(coalesce(p_payload->>'session_id','')) not between 1 and 200 or m.state='prepared' then raise exception 'managed_analysis_binding_invalid'; end if;
    if m.session_id is not null and m.session_id is distinct from p_payload->>'session_id' then raise exception 'managed_analysis_session_conflict'; end if;
    update public.company_discovery_managed_runs set session_id=p_payload->>'session_id',
      state=case when state='launching' then 'running' else state end,updated_at=clock_timestamp() where job_id=m.job_id returning * into m;
  elsif p_action='cancel' then
    if m.state not in ('completed','failed','cancelled') then
      update public.company_discovery_managed_runs set state=case when state='prepared' then 'cancelled' else 'cancel_requested' end,
        updated_at=clock_timestamp() where job_id=m.job_id returning * into m;
      update public.worker_jobs set status='cancelled',version=version+1,fence_generation=fence_generation+1,updated_at=clock_timestamp() where id=m.job_id;
      update public.worker_attempts set status='cancelled',terminal_reason='owner_cancelled',terminal_at=clock_timestamp() where id=m.attempt_id;
    end if;
  elsif p_action='observe' then
    obs:=p_payload->'observation'; result:=p_payload->'result';
    if m.session_id is null or obs->>'session_id' is distinct from m.session_id
      or (m.turn_id is not null and obs->>'turn_id' is distinct from m.turn_id)
      or jsonb_typeof(obs)<>'object' or (obs-array['session_id','turn_id','state','provider_status','usage','output_item_id','output_sha256','error_code'])<>'{}'::jsonb
      or obs->>'state' not in ('running','completed','failed','cancel_requested','cancelled') then raise exception 'managed_analysis_observation_invalid'; end if;
    -- Provider usage is a cumulative snapshot, never added to its previous value.
    update public.company_discovery_managed_runs set turn_id=obs->>'turn_id',observation=obs,updated_at=clock_timestamp(),
      state=case when m.state in ('completed','cancelled','failed') then m.state
        when m.state='cancel_requested' and obs->>'state' not in ('cancelled','failed') then m.state else obs->>'state' end
      where job_id=m.job_id returning * into m;
    update public.worker_attempts set provider_metadata=jsonb_build_object('provider','openai','api','agents',
      'model','gpt-5.6-terra','billing_basis','paid_api','session_id',m.session_id,'turn_id',m.turn_id,
      'input_version',m.input_version,'usage',obs->'usage','usage_basis','provider_snapshot',
      'cost_usd',null,'cost_state','unreconciled','provider_status',obs->>'provider_status') where id=m.attempt_id;
    if m.state='completed' and a.result_id is null then
      if result is null or result='null'::jsonb or obs->>'provider_status'<>'completed' or m.turn_id is null
        or j.status<>'running' or a.status<>'running' or j.fence_generation<>a.fence_generation then raise exception 'managed_analysis_commit_not_authorized'; end if;
      receipt:=public.commit_company_discovery_result_v2(m.attempt_id,a.fence_generation,m.launch_token::text,result,
        encode(extensions.digest(convert_to(result::text,'utf8'),'sha256'),'hex'));
    elsif m.state in ('failed','cancelled') and a.result_id is null then
      update public.worker_attempts set status=m.state,terminal_at=coalesce(terminal_at,clock_timestamp()),terminal_reason=coalesce(obs->>'error_code',m.state) where id=m.attempt_id;
      update public.worker_jobs set status=m.state,updated_at=clock_timestamp() where id=m.job_id;
    end if;
  elsif p_action not in ('read','prepare') then raise exception 'managed_analysis_action_invalid';
  end if;
  select * into a from public.worker_attempts where id=m.attempt_id;
  select * into src from public.worker_results where id=m.source_result_id and tenant_id=m.tenant_id;
  result:=(to_jsonb(m)-array['launch_token','observation','provider_deleted_at']) || jsonb_build_object(
    'result_id',a.result_id,'source_snapshots',src.candidate_result->'source_snapshots',
    'usage',m.observation->'usage','provider_status',m.observation->>'provider_status','cost_state','unreconciled');
  if p_action='claim' then return jsonb_build_object('claimed',claim_won,'job',result); end if;
  return result;
end;
$$;
revoke all on function public.company_discovery_managed_job(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.company_discovery_managed_job(text,uuid,uuid,jsonb) to service_role;

commit;
