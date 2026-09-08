begin;
set local lock_timeout='5s';

-- Native admission carries only the already prepared, current website context.
-- No ordinary speech action, generated audio, dispatch or TTS receipt is needed.
create function public.website_browser_opening_v5_valid(p_payload jsonb,p_call uuid) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare v_native jsonb; begin
  if p_call is null or jsonb_typeof(p_payload) is distinct from 'object'
    or not (p_payload ?& array['version','native']) or p_payload-array['version','native']<>'{}'::jsonb
    or p_payload->'version' is distinct from '5'::jsonb or octet_length(p_payload::text)>1024 then return false; end if;
  v_native:=p_payload->'native';
  return coalesce(jsonb_typeof(v_native)='object'
    and v_native ?& array['callId','interviewId','revision','sourceDigest']
    and v_native-array['callId','interviewId','revision','sourceDigest']='{}'::jsonb
    and jsonb_typeof(v_native->'callId')='string' and v_native->>'callId'=p_call::text
    and jsonb_typeof(v_native->'interviewId')='string'
    and v_native->>'interviewId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and jsonb_typeof(v_native->'revision')='number' and v_native->>'revision' ~ '^[0-9]+$'
    and (v_native->>'revision')::numeric between 0 and 9007199254740991
    and jsonb_typeof(v_native->'sourceDigest')='string' and v_native->>'sourceDigest' ~ '^[0-9a-f]{64}$',false);
exception when others then return false;
end $$;
revoke all on function public.website_browser_opening_v5_valid(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.website_browser_opening_v5_valid(jsonb,uuid) to authenticated,service_role;

-- Retain every historical constraint branch, including explicit protocol4.
do $native_browser_contract$
declare v_opening text; v_protocol text; v_sql text; v_name text; begin
  select pg_get_expr(conbin,conrelid) into strict v_opening from pg_constraint
    where conrelid='public.browser_session_requests'::regclass and conname='browser_session_requests_opening_state_check';
  select pg_get_expr(conbin,conrelid) into strict v_protocol from pg_constraint
    where conrelid='public.browser_session_requests'::regclass and conname='browser_session_requests_onboarding_protocol_check';
  if position('website_browser_opening_v4_valid' in v_opening)=0 or position('realtime_stream_v1' in v_protocol)=0 then
    raise exception 'native_browser_prior_contract_missing'; end if;
  alter table public.browser_session_requests drop constraint browser_session_requests_opening_state_check;
  execute 'alter table public.browser_session_requests add constraint browser_session_requests_opening_state_check check ('
    ||'(onboarding_protocol_version is distinct from 5 and ('||v_opening||')) or '
    ||$v5$(onboarding_protocol_version=5 and session_type='onboarding' and opening_mode_requested='realtime_native_v1' and coalesce((
      (status in ('pending','processing','error','expired') and opening_mode_applied is null and opening_payload is null
        and (status<>'pending' or call_id is null) and (status<>'processing' or answer_sdp is null))
      or (status='cancel_requested' and call_id is not null and answer_sdp is null and opening_mode_applied is null and opening_payload is null)
      or (status in ('ready','cancel_requested') and call_id is not null and coalesce(answer_sdp,'')<>''
        and opening_mode_applied='realtime_native_v1' and public.website_browser_opening_v5_valid(opening_payload,call_id))
    ),false))) not valid$v5$;
  alter table public.browser_session_requests drop constraint browser_session_requests_onboarding_protocol_check;
  execute 'alter table public.browser_session_requests add constraint browser_session_requests_onboarding_protocol_check check ('
    ||'(onboarding_protocol_version is distinct from 5 and ('||v_protocol||')) or '
    ||$v5$(onboarding_protocol_version=5 and session_type='onboarding' and opening_mode_requested='realtime_native_v1')) not valid$v5$;
  alter table public.browser_session_requests drop constraint browser_session_requests_opening_mode_requested_check;
  alter table public.browser_session_requests add constraint browser_session_requests_opening_mode_requested_check
    check(opening_mode_requested in ('provider_model_v1','application_tts_v1','realtime_stream_v1','realtime_native_v1')) not valid;
  alter table public.browser_session_requests drop constraint browser_session_requests_application_opening_scope_check;
  alter table public.browser_session_requests add constraint browser_session_requests_application_opening_scope_check
    check((opening_mode_requested not in ('application_tts_v1','realtime_stream_v1','realtime_native_v1') or session_type='onboarding')
      and (opening_mode_requested<>'realtime_stream_v1' or onboarding_protocol_version is not distinct from 4)
      and (opening_mode_requested<>'realtime_native_v1' or onboarding_protocol_version is not distinct from 5)) not valid;
  foreach v_name in array array['enforce_browser_session_call_binding_v1','enforce_browser_session_cancel_transition_v1'] loop
    select pg_get_functiondef(p.oid) into strict v_sql from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name and p.pronargs=0;
    if position('opening_mode_requested not in (''application_tts_v1'',''realtime_stream_v1'')' in v_sql)=0 then
      raise exception 'native_browser_prior_trigger_missing:%',v_name; end if;
    v_sql:=replace(v_sql,'opening_mode_requested not in (''application_tts_v1'',''realtime_stream_v1'')','opening_mode_requested not in (''application_tts_v1'',''realtime_stream_v1'',''realtime_native_v1'')');
    v_sql:=replace(v_sql,'opening_mode_applied not in (''application_tts_v1'',''realtime_stream_v1'')','opening_mode_applied not in (''application_tts_v1'',''realtime_stream_v1'',''realtime_native_v1'')');
    execute v_sql;
  end loop;
end $native_browser_contract$;
alter table public.browser_session_requests validate constraint browser_session_requests_opening_state_check;
alter table public.browser_session_requests validate constraint browser_session_requests_onboarding_protocol_check;
alter table public.browser_session_requests validate constraint browser_session_requests_opening_mode_requested_check;
alter table public.browser_session_requests validate constraint browser_session_requests_application_opening_scope_check;

-- Replace only exact mode/version predicates. All owner, source, generation,
-- active-call, reservation, immutable-receipt and settled-resume fences survive.
do $native_profile_scope$
declare v_signature text; v_sql text; v_before text; v_after text; begin
  v_before:='br.onboarding_protocol_version=4 and br.opening_mode_requested=''realtime_stream_v1''';
  v_after:='((br.onboarding_protocol_version=4 and br.opening_mode_requested=''realtime_stream_v1'') or (br.onboarding_protocol_version=5 and br.opening_mode_requested=''realtime_native_v1''))';
  foreach v_signature in array array[
    'public.website_interview_scope(uuid,uuid,uuid,boolean)',
    'public.resolve_prepared_website_source_before_amendment(uuid,uuid,uuid)',
    'public.attach_website_interview_before_amendment(uuid,uuid,uuid,uuid,uuid)',
    'public.website_interview_prior_settled(uuid,uuid,uuid,bigint)',
    'public.website_interview_prior_settled_before_stream_resume(uuid,uuid,uuid,bigint)',
    'public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_sql;
    if position(v_before in v_sql)=0 then raise exception 'native_prior_scope_missing:%',v_signature; end if;
    v_sql:=replace(v_sql,v_before,v_after);
    v_sql:=replace(v_sql,'next_request.onboarding_protocol_version=4 and next_request.opening_mode_requested=''realtime_stream_v1''',
      '((next_request.onboarding_protocol_version=4 and next_request.opening_mode_requested=''realtime_stream_v1'') or (next_request.onboarding_protocol_version=5 and next_request.opening_mode_requested=''realtime_native_v1''))');
    execute v_sql;
  end loop;
  select pg_get_functiondef('public.claim_website_interview_speech(uuid,uuid,uuid,jsonb,uuid,integer,text)'::regprocedure) into v_sql;
  if position('onboarding_protocol_version=4' in v_sql)=0 then raise exception 'native_mp3_prior_guard_missing'; end if;
  execute replace(v_sql,'onboarding_protocol_version=4','onboarding_protocol_version in (4,5)');
  select pg_get_functiondef('public.company_discovery_setup_status()'::regprocedure) into v_sql;
  if position('''{voice_protocol_version}'',''4''::jsonb' in v_sql)=0 then raise exception 'native_setup_prior_contract_missing'; end if;
  execute replace(v_sql,'''{voice_protocol_version}'',''4''::jsonb','''{voice_protocol_version}'',''5''::jsonb');
end $native_profile_scope$;

-- Native checkpoints attest to actual provider-completed speech and actual
-- client playout. They do not authorize, select or compare spoken wording.
create function public.website_interview_native_actor(p_owner uuid,p_call uuid,p_request uuid) returns public.website_interviews
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_preparation public.website_interview_preparations; v_budget public.budget_reservations; begin
  v_i:=public.website_interview_current(p_owner,p_call,p_request);
  if not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5 and opening_mode_requested='realtime_native_v1') then
    raise exception using errcode='42501',message='interview_native_protocol_not_current'; end if;
  select * into v_preparation from public.website_interview_preparations where id=v_i.preparation_id;
  if v_i.state='complete' or v_preparation.owner_id is distinct from p_owner or v_preparation.tenant_id is distinct from v_i.tenant_id
    or v_preparation.generation is distinct from v_i.generation
    or not public.website_interview_source_valid(v_i.tenant_id,p_owner,v_preparation.draft_id,v_preparation.draft_hash,v_preparation.result_id,v_preparation.result_hash) then
    raise exception using errcode='42501',message='interview_native_source_not_current'; end if;
  select * into v_budget from public.budget_reservations where call_id=p_call and tenant_id=v_i.tenant_id for update;
  if v_budget.status is distinct from 'active' or not exists(select 1 from public.calls c join public.browser_session_requests br on br.id=p_request and br.call_id=c.id
    where c.id=p_call and c.status='active' and c.ended_at is null and length(btrim(coalesce(c.openai_call_id,'')))>0
      and c.provider_termination_state='active' and br.status='ready' and br.opening_mode_applied='realtime_native_v1') then
    raise exception using errcode='42501',message='interview_native_provider_not_active'; end if;
  return v_i;
end $$;

create function public.record_website_interview_native_checkpoint(
  p_owner uuid,p_call uuid,p_request uuid,p_checkpoint uuid,p_kind text,p_revision bigint,p_store_version bigint,p_digest text,p_receipt uuid,
  p_response text,p_item text,p_transcript text,p_buffer_event text,p_media_evidence jsonb,p_approval uuid default null
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_i public.website_interviews; v_a public.website_interview_approvals; v_existing public.receipts;
  v_receipt uuid:=gen_random_uuid(); v_snapshot uuid:=gen_random_uuid(); v_version bigint; v_summary_hash text; v_proof jsonb; v_input jsonb;
  v_key text; v_played_at timestamptz; begin
  v_i:=public.website_interview_native_actor(p_owner,p_call,p_request);
  if p_checkpoint is null or p_kind is null or p_kind not in ('review','signoff')
    or p_revision is null or p_revision<0 or p_store_version is null or p_store_version<0 or p_receipt is null
    or p_digest is null or p_digest !~ '^[0-9a-f]{64}$'
    or p_response is null or length(p_response) not between 1 and 400 or btrim(p_response)=''
    or p_item is null or length(p_item) not between 1 and 400 or btrim(p_item)=''
    or p_buffer_event is null or length(p_buffer_event) not between 1 and 400 or btrim(p_buffer_event)=''
    or p_transcript is null or length(p_transcript) not between 1 and 8192 or btrim(p_transcript)=''
    or not public.website_stream_media_valid(p_media_evidence)
    or (p_kind='review' and p_approval is not null) or (p_kind='signoff' and p_approval is null) then
    raise exception 'interview_native_checkpoint_invalid'; end if;
  if v_i.digest is distinct from p_digest or (v_i.agenda->>'revision')::bigint is distinct from p_revision then
    raise exception using errcode='40001',message='interview_native_snapshot_changed'; end if;
  v_key:='website-native-checkpoint:'||p_call::text||':'||p_checkpoint::text;
  v_input:=jsonb_build_object('schema','onboarding.native.checkpoint.v1','checkpointId',p_checkpoint,'kind',p_kind,'requestId',p_request,
    'revision',p_revision,'digest',p_digest,'expectedStoreVersion',p_store_version,'expectedReceiptId',p_receipt,'generation',v_i.generation,
    'responseId',p_response,'itemId',p_item,'transcript',p_transcript,'bufferStoppedEventId',p_buffer_event,'mediaEvidence',p_media_evidence,'approvalReceiptId',p_approval);
  select * into v_existing from public.receipts where tenant_id=v_i.tenant_id and call_id=p_call and kind='website_interview' and external_id=v_key;
  if v_existing.id is not null then
    if v_existing.outcome<>'accepted' or v_existing.detail->'input' is distinct from v_input then raise exception 'interview_native_checkpoint_conflict'; end if;
    return v_existing.readback;
  end if;
  if v_i.db_version is distinct from p_store_version or v_i.receipt_id is distinct from p_receipt then
    raise exception using errcode='40001',message='interview_native_snapshot_changed'; end if;
  if exists(select 1 from public.receipts where call_id=p_call and kind='website_interview' and detail->'input'->>'schema'='onboarding.native.checkpoint.v1'
    and (detail->'input'->>'responseId'=p_response or detail->'input'->>'itemId'=p_item or detail->'input'->>'bufferStoppedEventId'=p_buffer_event)) then
    raise exception 'interview_native_generation_reused'; end if;
  if exists(select 1 from public.website_interview_amendment_requests where interview_id=v_i.interview_id) then raise exception 'interview_amendment_pending'; end if;
  select * into v_a from public.website_interview_approvals where interview_id=v_i.interview_id;
  v_played_at:=clock_timestamp();
  if p_kind='review' then
    if v_a.receipt_id is not null or v_i.state in ('closing','complete') then raise exception 'interview_already_approved'; end if;
    if v_i.state<>'reviewing' or exists(select 1 from jsonb_array_elements(v_i.agenda->'items'||v_i.agenda->'candidateOverrides') x where x->>'status' in ('open','awaiting_clarification')) then
      raise exception 'interview_summary_queue_unfinished'; end if;
    v_version:=v_i.db_version+1;
    v_summary_hash:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(p_checkpoint,p_revision,p_digest,jsonb_build_array(p_transcript))),'sha256'),'hex');
    insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
      values(v_snapshot,v_i.tenant_id,p_call,'website_interview','accepted','website-native-review-snapshot:'||p_call::text||':'||p_checkpoint::text,p_digest,
        jsonb_build_object('agenda',v_i.agenda,'nextAction',v_i.next_action),
        jsonb_build_object('checkpointId',p_checkpoint,'expectedReceiptId',p_receipt,'expectedStoreVersion',p_store_version,'dbVersion',v_version));
    v_proof:=jsonb_build_object('summaryId',p_checkpoint,'summaryHash',v_summary_hash,'parts',jsonb_build_array(p_transcript));
  else
    if v_a.receipt_id is distinct from p_approval or v_a.call_id is distinct from p_call or v_i.state<>'closing' or v_played_at<=v_a.created_at then
      raise exception 'interview_native_signoff_requires_approval'; end if;
    v_version:=v_i.db_version; v_snapshot:=v_i.receipt_id;
    v_proof:=jsonb_build_object('approvalReceiptId',p_approval);
  end if;
  v_proof:=v_proof||jsonb_build_object('schema','onboarding.native.checkpoint.v1','receiptId',v_receipt,'checkpointId',p_checkpoint,'kind',p_kind,
    'callId',p_call,'interviewId',v_i.interview_id,'revision',p_revision,'digest',p_digest,'storeVersion',v_version,'agendaReceiptId',v_snapshot,
    'responseId',p_response,'itemId',p_item,'transcript',p_transcript,'bufferStoppedEventId',p_buffer_event,'mediaEvidence',p_media_evidence);
  insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
    values(v_receipt,v_i.tenant_id,p_call,'website_interview','accepted',v_key,encode(extensions.digest(public.onboarding_canonical_json_v1(v_proof),'sha256'),'hex'),
      v_proof,jsonb_build_object('input',v_input,'playedAt',v_played_at,'providerGenerationStatus','completed'));
  if p_kind='review' then
    insert into public.website_interview_summaries(id,interview_id,tenant_id,call_id,revision,store_version,digest,agenda_receipt_id,draft_id,parts,summary_hash,receipt_id)
      values(p_checkpoint,v_i.interview_id,v_i.tenant_id,p_call,p_revision,v_version,p_digest,v_snapshot,(v_i.agenda->'binding'->>'draftId')::uuid,jsonb_build_array(p_transcript),v_summary_hash,v_receipt);
    update public.website_interviews set db_version=v_version,receipt_id=v_snapshot where interview_id=v_i.interview_id;
  end if;
  return v_proof;
end $$;

create function public.website_interview_native_signoff_played(p_call uuid,p_digest text,p_approval uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.receipts r
    join public.website_interviews i on i.current_call_id=r.call_id and i.tenant_id=r.tenant_id
    join public.website_interview_approvals a on a.interview_id=i.interview_id and a.call_id=r.call_id and a.receipt_id=p_approval
    join public.website_interview_calls wc on wc.call_id=r.call_id and wc.interview_id=i.interview_id
    join public.browser_session_requests br on br.id=wc.request_id and br.call_id=r.call_id
    where r.call_id=p_call and r.kind='website_interview' and r.outcome='accepted'
      and br.onboarding_protocol_version=5 and br.opening_mode_requested='realtime_native_v1'
      and r.readback->>'schema'='onboarding.native.checkpoint.v1' and r.readback->>'kind'='signoff'
      and r.external_id='website-native-checkpoint:'||p_call::text||':'||(r.readback->>'checkpointId')
      and r.detail->'input'->>'schema'='onboarding.native.checkpoint.v1' and r.detail->'input'->>'kind'='signoff'
      and r.detail->'input'->>'requestId'=wc.request_id::text and r.detail->'input'->>'approvalReceiptId'=p_approval::text
      and r.readback->>'digest'=p_digest and r.readback->'revision'=i.agenda->'revision'
      and r.readback->>'approvalReceiptId'=p_approval::text and r.detail->'input'->'generation'=to_jsonb(i.generation)
      and r.detail->>'providerGenerationStatus'='completed' and (r.detail->>'playedAt')::timestamptz>a.created_at
      and public.website_stream_media_valid(r.readback->'mediaEvidence'));
$$;

-- Only the native profile uses actual-checkpoint evidence. Existing owner
-- affirmation classification, immutable final snapshot and teardown rules stay.
do $native_approval_and_completion$
declare v_sql text; v_before text; v_after text; begin
  select pg_get_functiondef('public.approve_website_interview_summary(uuid,uuid,uuid,uuid,text,text,bigint,bigint,text)'::regprocedure) into v_sql;
  v_before:='v_i:=public.website_interview_current(p_owner,p_call,p_request);';
  v_after:=v_before||E'\n  if exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5) then v_i:=public.website_interview_native_actor(p_owner,p_call,p_request); end if;';
  if position(v_before in v_sql)=0 then raise exception 'native_approval_scope_missing'; end if;
  v_sql:=replace(v_sql,v_before,v_after);
  v_before:=$old$  if exists(select 1 from generate_series(0,jsonb_array_length(v_s.parts)-1) n where not exists(select 1 from public.website_interview_speech s where s.summary_id=p_summary and s.part_index=n and s.action->>'kind'='GENERATE_FINAL_SUMMARY' and s.status='played')) then raise exception 'interview_summary_not_fully_played'; end if;
  select max(played_at) into v_played_at from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL' and status='played';$old$;
  v_after:=$new$  if exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5) then
    select (r.detail->>'playedAt')::timestamptz into v_played_at from public.receipts r
      where r.id=v_s.receipt_id and r.call_id=p_call and r.tenant_id=v_i.tenant_id and r.kind='website_interview' and r.outcome='accepted'
        and r.readback->>'schema'='onboarding.native.checkpoint.v1' and r.readback->>'kind'='review'
        and r.external_id='website-native-checkpoint:'||p_call::text||':'||p_summary::text
        and r.detail->'input'->>'schema'='onboarding.native.checkpoint.v1' and r.detail->'input'->>'kind'='review'
        and r.detail->'input'->>'requestId'=p_request::text
        and r.readback->>'summaryId'=p_summary::text and r.readback->>'summaryHash'=p_summary_hash
        and r.readback->>'digest'=p_digest and r.readback->'revision'=to_jsonb(p_revision) and r.readback->'storeVersion'=to_jsonb(p_store_version)
        and r.readback->'parts'=v_s.parts and r.readback->>'agendaReceiptId'=v_i.receipt_id::text
        and r.detail->'input'->'generation'=to_jsonb(v_i.generation) and r.detail->>'providerGenerationStatus'='completed'
        and public.website_stream_media_valid(r.readback->'mediaEvidence');
    if v_played_at is null then raise exception 'interview_native_review_not_fully_played'; end if;
  else
    if exists(select 1 from generate_series(0,jsonb_array_length(v_s.parts)-1) n where not exists(select 1 from public.website_interview_speech s where s.summary_id=p_summary and s.part_index=n and s.action->>'kind'='GENERATE_FINAL_SUMMARY' and s.status='played')) then raise exception 'interview_summary_not_fully_played'; end if;
    select max(played_at) into v_played_at from public.website_interview_speech where summary_id=p_summary and action->>'kind'='REQUEST_FINAL_APPROVAL' and status='played';
  end if;$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_approval_playback_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.record_website_interview_completion_before_amendment(uuid,uuid,uuid,text,uuid)'::regprocedure) into v_sql;
  v_before:=$old$not exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and action->>'kind'='SPEAK_FINAL_SIGNOFF' and status='played' and played_at>v_a.created_at)$old$;
  v_after:=$new$(case when exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=5)
      then not public.website_interview_native_signoff_played(p_call,v_i.digest,p_approval)
      else not exists(select 1 from public.website_interview_speech where call_id=p_call and digest=v_i.digest and action->>'kind'='SPEAK_FINAL_SIGNOFF' and status='played' and played_at>v_a.created_at) end)$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_completion_signoff_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
  select pg_get_functiondef('public.list_website_interview_terminal_candidates_before_amendment(integer)'::regprocedure) into v_sql;
  v_before:=$old$exists(select 1 from public.website_interview_speech s where s.call_id=c.id and s.digest=i.digest and s.action->>'kind'='SPEAK_FINAL_SIGNOFF' and s.status='played' and s.played_at>a.created_at)$old$;
  v_after:=$new$(case when exists(select 1 from public.browser_session_requests where id=wc.request_id and onboarding_protocol_version=5)
        then public.website_interview_native_signoff_played(c.id,i.digest,a.receipt_id)
        else exists(select 1 from public.website_interview_speech s where s.call_id=c.id and s.digest=i.digest and s.action->>'kind'='SPEAK_FINAL_SIGNOFF' and s.status='played' and s.played_at>a.created_at) end)$new$;
  if position(v_before in v_sql)=0 then raise exception 'native_terminal_candidate_signoff_contract_missing'; end if;
  execute replace(v_sql,v_before,v_after);
end $native_approval_and_completion$;

revoke all on function public.website_interview_native_actor(uuid,uuid,uuid),public.website_interview_native_signoff_played(uuid,text,uuid),
  public.record_website_interview_native_checkpoint(uuid,uuid,uuid,uuid,text,bigint,bigint,text,uuid,text,text,text,text,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_website_interview_native_checkpoint(uuid,uuid,uuid,uuid,text,bigint,bigint,text,uuid,text,text,text,text,jsonb,uuid) to service_role;

commit;
