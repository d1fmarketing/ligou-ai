begin;
set local lock_timeout='5s';

-- An authorization descriptor contains no generated audio or TTS price. This
-- pure CHECK validates wire shape; live authorization is rechecked by the RPC.
create function public.website_browser_opening_v4_valid(p_payload jsonb,p_call uuid) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_stream jsonb; v_action jsonb; v_entry record; begin
  if p_call is null or jsonb_typeof(p_payload) is distinct from 'object'
    or not (p_payload ?& array['version','stream']) or p_payload-array['version','stream']<>'{}'::jsonb
    or p_payload->'version' is distinct from '4'::jsonb or octet_length(p_payload::text)>32768 then return false; end if;
  v_stream:=p_payload->'stream';
  if jsonb_typeof(v_stream) is distinct from 'object' or not (v_stream ?& array['schema','action','dispatchId','receiptId'])
    or v_stream-array['schema','action','dispatchId','receiptId']<>'{}'::jsonb
    or v_stream->>'schema' is distinct from 'onboarding.stream.v1'
    or jsonb_typeof(v_stream->'dispatchId') is distinct from 'string' or jsonb_typeof(v_stream->'receiptId') is distinct from 'string'
    or v_stream->>'dispatchId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_stream->>'receiptId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return false; end if;
  v_action:=v_stream->'action';
  if jsonb_typeof(v_action) is distinct from 'object'
    or not (v_action ?& array['actionId','interviewId','callId','revision','kind','text','sourceDigest'])
    or v_action-array['actionId','interviewId','callId','revision','kind','text','sourceDigest']<>'{}'::jsonb then return false; end if;
  for v_entry in select key,value from jsonb_each(v_action) loop
    if jsonb_typeof(v_entry.value) is distinct from (case when v_entry.key='revision' then 'number' else 'string' end) then return false; end if;
  end loop;
  return coalesce(v_action->>'callId'=p_call::text
    and v_action->>'interviewId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and v_action->>'actionId' ~ '^[0-9a-f]{64}$' and v_action->>'sourceDigest' ~ '^[0-9a-f]{64}$'
    and v_action->>'kind' in ('ASK_NEXT_GAP','GENERATE_FINAL_SUMMARY') and v_action->>'revision' ~ '^[0-9]+$'
    and (v_action->>'revision')::numeric between 0 and 9007199254740991
    and length(v_action->>'text') between 1 and 4096 and btrim(v_action->>'text')<>''
    and translate(v_action->>'text',E'\n\r\t','') !~ '[[:cntrl:]]',false);
exception when others then return false;
end $$;
revoke all on function public.website_browser_opening_v4_valid(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.website_browser_opening_v4_valid(jsonb,uuid) to authenticated,service_role;

-- Keep all historical protocol/MP3 constraints intact inside their old branch.
do $stream_browser_contract$
declare v_opening text; v_protocol text; v_sql text; v_name text; begin
  select pg_get_expr(conbin,conrelid) into strict v_opening from pg_constraint
    where conrelid='public.browser_session_requests'::regclass and conname='browser_session_requests_opening_state_check';
  select pg_get_expr(conbin,conrelid) into strict v_protocol from pg_constraint
    where conrelid='public.browser_session_requests'::regclass and conname='browser_session_requests_onboarding_protocol_check';
  if position('website_browser_opening_v3_valid' in v_opening)=0 or position('onboarding_protocol_version' in v_protocol)=0 then
    raise exception 'stream_browser_prior_contract_missing'; end if;
  alter table public.browser_session_requests drop constraint browser_session_requests_opening_state_check;
  execute 'alter table public.browser_session_requests add constraint browser_session_requests_opening_state_check check ('
    ||'(onboarding_protocol_version is distinct from 4 and ('||v_opening||')) or '
    ||$v4$(onboarding_protocol_version=4 and session_type='onboarding' and opening_mode_requested='realtime_stream_v1' and coalesce((
      (status in ('pending','processing','error','expired') and opening_mode_applied is null and opening_payload is null
        and (status<>'pending' or call_id is null) and (status<>'processing' or answer_sdp is null))
      or (status='cancel_requested' and call_id is not null and answer_sdp is null and opening_mode_applied is null and opening_payload is null)
      or (status in ('ready','cancel_requested') and call_id is not null and coalesce(answer_sdp,'')<>''
        and opening_mode_applied='realtime_stream_v1' and public.website_browser_opening_v4_valid(opening_payload,call_id))
    ),false))) not valid$v4$;
  alter table public.browser_session_requests drop constraint browser_session_requests_onboarding_protocol_check;
  execute 'alter table public.browser_session_requests add constraint browser_session_requests_onboarding_protocol_check check ('
    ||'(onboarding_protocol_version is distinct from 4 and ('||v_protocol||')) or '
    ||$v4$(onboarding_protocol_version=4 and session_type='onboarding' and opening_mode_requested='realtime_stream_v1')) not valid$v4$;
  alter table public.browser_session_requests drop constraint browser_session_requests_opening_mode_requested_check;
  alter table public.browser_session_requests add constraint browser_session_requests_opening_mode_requested_check
    check(opening_mode_requested in ('provider_model_v1','application_tts_v1','realtime_stream_v1')) not valid;
  alter table public.browser_session_requests drop constraint browser_session_requests_application_opening_scope_check;
  alter table public.browser_session_requests add constraint browser_session_requests_application_opening_scope_check
    check((opening_mode_requested not in ('application_tts_v1','realtime_stream_v1') or session_type='onboarding')
      and (opening_mode_requested<>'realtime_stream_v1' or onboarding_protocol_version is not distinct from 4)) not valid;
  -- The protocol CHECK above pairs each mode/version. Preserve every immutable
  -- actor/payload/cancellation predicate while admitting the new paired mode.
  foreach v_name in array array['enforce_browser_session_call_binding_v1','enforce_browser_session_cancel_transition_v1'] loop
    select pg_get_functiondef(p.oid) into strict v_sql from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name and p.pronargs=0;
    if position('opening_mode_requested <> ''application_tts_v1''' in v_sql)=0 then raise exception 'stream_browser_prior_trigger_missing:%',v_name; end if;
    v_sql:=replace(v_sql,'opening_mode_requested <> ''application_tts_v1''','opening_mode_requested not in (''application_tts_v1'',''realtime_stream_v1'')');
    v_sql:=replace(v_sql,'opening_mode_applied <> ''application_tts_v1''','opening_mode_applied not in (''application_tts_v1'',''realtime_stream_v1'')');
    execute v_sql;
  end loop;
end $stream_browser_contract$;
alter table public.browser_session_requests validate constraint browser_session_requests_opening_state_check;
alter table public.browser_session_requests validate constraint browser_session_requests_onboarding_protocol_check;
alter table public.browser_session_requests validate constraint browser_session_requests_opening_mode_requested_check;
alter table public.browser_session_requests validate constraint browser_session_requests_application_opening_scope_check;

create or replace function public.website_interview_scope(p_owner uuid,p_call uuid,p_request uuid,p_active boolean default true) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_tenant uuid; v_found uuid; begin
  perform public.website_interview_service_guard();
  select c.tenant_id into v_tenant from public.calls c where c.id=p_call;
  if v_tenant is null then raise exception using errcode='42501',message='interview_call_not_owner_bound'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ligou.company_discovery.onboarding_draft:'||v_tenant::text,0));
  perform 1 from public.tenants t where t.id=v_tenant for update;
  select c.id into v_found from public.tenants t join public.calls c on c.tenant_id=t.id
    join public.browser_session_requests br on br.call_id=c.id and br.tenant_id=t.id
    where t.id=v_tenant and t.owner_user_id=p_owner and t.status='onboarding' and t.operational_mode='simulation_only'
      and c.id=p_call and c.channel='browser' and c.session_type='onboarding'
      and c.test_memory_generation=t.test_memory_generation and (not p_active or (c.status='active' and c.ended_at is null))
      and br.id=p_request and br.user_id=p_owner and br.session_type='onboarding'
      and br.test_memory_generation=t.test_memory_generation
      and ((br.onboarding_protocol_version in (2,3) and br.opening_mode_requested='application_tts_v1')
        or (br.onboarding_protocol_version=4 and br.opening_mode_requested='realtime_stream_v1'))
      and (not p_active or br.status in ('processing','ready')) for update of c,br;
  if v_found is null then raise exception using errcode='42501',message='interview_call_not_owner_bound'; end if;
  return v_tenant;
end $$;

-- Expand only the paired protocol and truly zero-cost rejection branch. Keep
-- every current-source, immutable initialization, no-progress and settled fence.
do $stream_empty_start$
declare v_sql text; v_before text; v_after text; begin
  select pg_get_functiondef('public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint)'::regprocedure) into v_sql;
  v_before:='and v_call.provider_usage_state=''resolved'' and v_call.cost_estimate_usd>=0';
  v_after:='and ((v_call.provider_usage_state=''resolved'' and v_call.cost_estimate_usd>=0) or (v_call.provider_usage_state=''not_applicable'' and v_call.cost_estimate_usd=0))';
  if position(v_before in v_sql)=0 then raise exception 'stream_no_provider_usage_contract_missing'; end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:='br.onboarding_protocol_version=3 and br.opening_mode_requested=''application_tts_v1''';
  v_after:='((br.onboarding_protocol_version=3 and br.opening_mode_requested=''application_tts_v1'' and v_call.provider_usage_state=''resolved'') or (br.onboarding_protocol_version=4 and br.opening_mode_requested=''realtime_stream_v1'' and v_call.cost_estimate_usd=0 and v_call.provider_usage_state in (''not_applicable'',''resolved'')))';
  if position(v_before in v_sql)=0 then raise exception 'stream_no_provider_protocol_contract_missing'; end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:='next_request.onboarding_protocol_version=3'||E'\n            and next_request.opening_mode_requested=''application_tts_v1''';
  v_after:='((next_request.onboarding_protocol_version=3 and next_request.opening_mode_requested=''application_tts_v1'') or (next_request.onboarding_protocol_version=4 and next_request.opening_mode_requested=''realtime_stream_v1''))';
  if position(v_before in v_sql)=0 then raise exception 'stream_no_provider_successor_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.website_interview_prior_settled(uuid,uuid,uuid,bigint)'::regprocedure) into v_sql;
  v_before:='br.onboarding_protocol_version=3'||E'\n      and br.opening_mode_requested=''application_tts_v1''';
  v_after:='((br.onboarding_protocol_version=3 and br.opening_mode_requested=''application_tts_v1'') or (br.onboarding_protocol_version=4 and br.opening_mode_requested=''realtime_stream_v1''))';
  if position(v_before in v_sql)=0 then raise exception 'stream_initial_retry_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
end $stream_empty_start$;

-- An exhausted queue with no approval is still resumable: a new stream starts
-- from a newly prepared, current summary rather than inventing another gap.
do $stream_review_resume$
declare v_sql text; v_before text; v_after text; begin
  select pg_get_functiondef('public.resolve_prepared_website_source_before_amendment(uuid,uuid,uuid)'::regprocedure) into v_sql;
  v_before:='and i.state=''unfinished'' and i.current_call_id<>p_call';
  v_after:='and (i.state=''unfinished'' or (i.state=''reviewing'' and exists(select 1 from public.browser_session_requests br where br.id=p_request and br.onboarding_protocol_version=4 and br.opening_mode_requested=''realtime_stream_v1'') and not exists(select 1 from public.website_interview_approvals a where a.interview_id=i.interview_id))) and i.current_call_id<>p_call';
  if position(v_before in v_sql)=0 then raise exception 'stream_review_resolve_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.attach_website_interview_before_amendment(uuid,uuid,uuid,uuid,uuid)'::regprocedure) into v_sql;
  v_before:='v_i.interview_id is null or v_i.state<>''unfinished''';
  v_after:='v_i.interview_id is null or (v_i.state<>''unfinished'' and not (v_i.state=''reviewing'' and exists(select 1 from public.browser_session_requests br where br.id=p_request and br.onboarding_protocol_version=4 and br.opening_mode_requested=''realtime_stream_v1'') and not exists(select 1 from public.website_interview_approvals a where a.interview_id=v_i.interview_id)))';
  if position(v_before in v_sql)=0 then raise exception 'stream_review_attach_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.website_interview_resume_eligible(uuid,uuid,boolean)'::regprocedure) into v_sql;
  v_before:='elsif v_i.state<>''unfinished'' or exists';
  v_after:='elsif v_i.state not in (''unfinished'',''reviewing'') or exists';
  if position(v_before in v_sql)=0 then raise exception 'stream_review_eligibility_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.get_website_interview_status(uuid)'::regprocedure) into v_sql;
  v_before:='''resumeEligible'',v_i.state=''unfinished'' and v_settled';
  v_after:='''resumeEligible'',v_i.state in (''unfinished'',''reviewing'') and v_settled';
  if position(v_before in v_sql)=0 then raise exception 'stream_review_status_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
end $stream_review_resume$;

alter function public.company_discovery_setup_status() rename to company_discovery_setup_status_before_streaming;
create function public.company_discovery_setup_status() returns jsonb
language plpgsql security definer volatile set search_path='' as $$
declare v_result jsonb; begin
  v_result:=public.company_discovery_setup_status_before_streaming();
  if v_result ? 'voice_protocol_version' then v_result:=jsonb_set(v_result,'{voice_protocol_version}','4'::jsonb); end if;
  return v_result;
end $$;
revoke all on function public.company_discovery_setup_status_before_streaming(),public.company_discovery_setup_status() from public,anon,authenticated,service_role;
grant execute on function public.company_discovery_setup_status() to authenticated;
commit;
