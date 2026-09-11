begin;
set local lock_timeout='5s';

-- Live IDs and timeline fragments are not Realtime input-item IDs. Keep the
-- historical tables intact and attach explicit evidence to the same interview.
create function public.website_browser_opening_v6_valid(p_payload jsonb,p_call uuid) returns boolean
language sql immutable security invoker set search_path='' as $$
 select coalesce(jsonb_typeof(p_payload)='object' and p_payload-array['version','live']='{}'
  and p_payload->'version'='6' and jsonb_typeof(p_payload->'live'->'sessionId')='string'
  and length(p_payload->'live'->>'sessionId') between 1 and 512
  and public.website_browser_opening_v5_valid(jsonb_build_object('version',5,'native',(p_payload->'live')-'sessionId'),p_call),false);
$$;
revoke all on function public.website_browser_opening_v6_valid(jsonb,uuid) from public;
grant execute on function public.website_browser_opening_v6_valid(jsonb,uuid) to authenticated,service_role;

do $live_profile$
declare prior text;definition text;name text;signature text;begin
 select pg_get_expr(conbin,conrelid) into strict prior from pg_constraint where conrelid='public.browser_session_requests'::regclass and conname='browser_session_requests_opening_state_check';
 alter table public.browser_session_requests drop constraint browser_session_requests_opening_state_check;
 execute 'alter table public.browser_session_requests add constraint browser_session_requests_opening_state_check check ((onboarding_protocol_version is distinct from 6 and ('||prior||')) or '
 ||$v6$(onboarding_protocol_version=6 and session_type='onboarding' and opening_mode_requested='live_managed_v1' and coalesce((
   (status in ('pending','processing','error','expired') and opening_mode_applied is null and opening_payload is null
     and (status<>'pending' or call_id is null) and (status<>'processing' or answer_sdp is null))
   or (status='cancel_requested' and call_id is not null and answer_sdp is null and opening_mode_applied is null and opening_payload is null)
   or (status in ('ready','cancel_requested') and call_id is not null and coalesce(answer_sdp,'')<>''
     and opening_mode_applied='live_managed_v1' and public.website_browser_opening_v6_valid(opening_payload,call_id))
 ),false)))$v6$;
 select pg_get_expr(conbin,conrelid) into strict prior from pg_constraint where conrelid='public.browser_session_requests'::regclass and conname='browser_session_requests_onboarding_protocol_check';
 alter table public.browser_session_requests drop constraint browser_session_requests_onboarding_protocol_check;
 execute 'alter table public.browser_session_requests add constraint browser_session_requests_onboarding_protocol_check check ((onboarding_protocol_version is distinct from 6 and ('||prior||')) or (onboarding_protocol_version=6 and session_type=''onboarding'' and opening_mode_requested=''live_managed_v1''))';
 foreach name in array array['browser_session_requests_opening_mode_requested_check','browser_session_requests_application_opening_scope_check'] loop
  select pg_get_expr(conbin,conrelid) into strict prior from pg_constraint where conrelid='public.browser_session_requests'::regclass and conname=name;
  execute format('alter table public.browser_session_requests drop constraint %I',name);
  execute format('alter table public.browser_session_requests add constraint %I check ((opening_mode_requested<>''live_managed_v1'' and (%s)) or (opening_mode_requested=''live_managed_v1'' and session_type=''onboarding'' and onboarding_protocol_version=6))',name,prior);
 end loop;
 foreach name in array array['enforce_browser_session_call_binding_v1','enforce_browser_session_cancel_transition_v1'] loop
  select pg_get_functiondef(p.oid) into strict definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name and p.pronargs=0;
  definition:=replace(definition,'''application_tts_v1'',''realtime_stream_v1'',''realtime_native_v1''','''application_tts_v1'',''realtime_stream_v1'',''realtime_native_v1'',''live_managed_v1''');
  execute definition;
 end loop;
 -- Broaden only the recognized protocol predicate; owner/source/CAS/lineage
 -- checks are unchanged. The public default remains Realtime until rollout.
 foreach signature in array array['public.initialize_website_interview(uuid,uuid,uuid,uuid,jsonb)',
  'public.website_interview_scope(uuid,uuid,uuid,boolean)',
  'public.resolve_prepared_website_source_before_amendment(uuid,uuid,uuid)',
  'public.attach_website_interview_before_amendment(uuid,uuid,uuid,uuid,uuid)',
  'public.website_interview_prior_settled(uuid,uuid,uuid,bigint)',
  'public.website_interview_prior_settled_before_stream_resume(uuid,uuid,uuid,bigint)',
  'public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint)'] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  definition:=replace(definition,'br.onboarding_protocol_version=5 and br.opening_mode_requested=''realtime_native_v1''',
   '(br.onboarding_protocol_version=5 and br.opening_mode_requested=''realtime_native_v1'' or br.onboarding_protocol_version=6 and br.opening_mode_requested=''live_managed_v1'')');
  definition:=replace(definition,'next_request.onboarding_protocol_version=5 and next_request.opening_mode_requested=''realtime_native_v1''',
   '(next_request.onboarding_protocol_version=5 and next_request.opening_mode_requested=''realtime_native_v1'' or next_request.onboarding_protocol_version=6 and next_request.opening_mode_requested=''live_managed_v1'')');
  definition:=replace(definition,'onboarding_protocol_version=5 and opening_mode_requested=''realtime_native_v1''',
   '(onboarding_protocol_version=5 and opening_mode_requested=''realtime_native_v1'' or onboarding_protocol_version=6 and opening_mode_requested=''live_managed_v1'')');
  execute definition;
 end loop;
end $live_profile$;

create table public.website_interview_live_fragments (
 call_id uuid not null references public.website_interview_calls(call_id),
 tenant_id uuid not null references public.tenants(id),provider_session_id text not null,
 event_id text not null check(length(event_id) between 1 and 512),
 speaker text not null check(speaker in ('owner','assistant')),delta text not null check(length(delta) between 1 and 32768),
 start_ms double precision not null check(start_ms>=0),end_ms double precision not null check(end_ms>=start_ms and end_ms<=9007199254740991),
 arrival_order bigint generated always as identity,
 recorded_at timestamptz not null default clock_timestamp(),primary key(call_id,event_id)
);
create table public.website_interview_live_operations (
 call_id uuid not null references public.website_interview_calls(call_id),tenant_id uuid not null references public.tenants(id),
 interview_id uuid not null references public.website_interviews(interview_id),provider_session_id text not null,
 operation_ref text not null check(operation_ref ~ '^ligou-live-op:[a-f0-9]{64}$'),
 kind text not null check(kind in ('answer','correction','defer','not_applicable','reopen')),
 target_id text not null,source_event_ids text[] not null,source_text text not null,interpretation text not null,
 revision bigint not null,receipt_id uuid not null references public.receipts(id),
 recorded_at timestamptz not null default clock_timestamp(),primary key(call_id,operation_ref)
);
create index website_live_fragments_tenant on public.website_interview_live_fragments(tenant_id);
create index website_live_operations_interview on public.website_interview_live_operations(interview_id,revision);
create index website_live_operations_tenant on public.website_interview_live_operations(tenant_id);
do $$declare name text;begin
 foreach name in array array['website_interview_live_fragments','website_interview_live_operations'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('alter table public.%I force row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);
  execute format('grant select on public.%I to service_role',name);
  execute format('create trigger %I before update or delete on public.%I for each row execute function public.block_mutation()',name||'_append_only',name);
 end loop;
end $$;

create function public.website_interview_live_actor(p_owner uuid,p_call uuid,p_request uuid,p_session text) returns public.website_interviews
language plpgsql security definer set search_path='' as $$
declare i public.website_interviews;p public.website_interview_preparations;begin
 i:=public.website_interview_current(p_owner,p_call,p_request);
 select * into p from public.website_interview_preparations where id=i.preparation_id;
 if not public.website_interview_source_valid(i.tenant_id,p_owner,p.draft_id,p.draft_hash,p.result_id,p.result_hash)
  or not exists(select 1 from public.calls c join public.browser_session_requests br on br.call_id=c.id
    join public.budget_reservations b on b.call_id=c.id and b.tenant_id=c.tenant_id
    where c.id=p_call and c.openai_call_id=p_session and c.model='gpt-live-1' and c.provider_termination_state='active'
     and br.id=p_request and br.onboarding_protocol_version=6 and br.opening_mode_requested='live_managed_v1'
     and br.status='ready' and br.opening_mode_applied='live_managed_v1' and br.opening_payload->'live'->>'sessionId'=p_session
     and b.status='active') then raise exception using errcode='42501',message='live_interview_scope_invalid';end if;
 return i;
end $$;
revoke all on function public.website_interview_live_actor(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.record_website_live_fragments(p_owner uuid,p_call uuid,p_request uuid,p_session text,p_fragments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.website_interviews;f jsonb;old public.website_interview_live_fragments;added integer:=0;begin
 i:=public.website_interview_live_actor(p_owner,p_call,p_request,p_session);
 if p_fragments is null or jsonb_typeof(p_fragments)<>'array' or jsonb_array_length(p_fragments)>512 or octet_length(p_fragments::text)>2097152 then raise exception 'live_fragments_invalid';end if;
 for f in select value from jsonb_array_elements(p_fragments) loop
  if jsonb_typeof(f)<>'object' or not(f ?& array['eventId','speaker','text','startMs','endMs']) or f-array['eventId','speaker','text','startMs','endMs']<>'{}'
   or jsonb_typeof(f->'eventId')<>'string' or jsonb_typeof(f->'text')<>'string' or jsonb_typeof(f->'speaker')<>'string'
   or jsonb_typeof(f->'startMs')<>'number' or jsonb_typeof(f->'endMs')<>'number' then raise exception 'live_fragment_invalid';end if;
  select * into old from public.website_interview_live_fragments where call_id=p_call and event_id=f->>'eventId';
  if found then
   if row(old.provider_session_id,old.speaker,old.delta,old.start_ms,old.end_ms) is distinct from row(p_session,f->>'speaker',f->>'text',(f->>'startMs')::double precision,(f->>'endMs')::double precision) then raise exception 'live_fragment_conflict';end if;
  else
   insert into public.website_interview_live_fragments(call_id,tenant_id,provider_session_id,event_id,speaker,delta,start_ms,end_ms)
    values(p_call,i.tenant_id,p_session,f->>'eventId',f->>'speaker',f->>'text',(f->>'startMs')::double precision,(f->>'endMs')::double precision);
   added:=added+1;
  end if;
 end loop;
 return jsonb_build_object('callId',p_call,'providerSessionId',p_session,'added',added);
end $$;
revoke all on function public.record_website_live_fragments(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_website_live_fragments(uuid,uuid,uuid,text,jsonb) to service_role;

-- Set an explicitly named business decision. No model-supplied whole-agenda
-- payload, automatic next-question targeting, or invented provider input ID.
create function public.commit_website_live_decision(p_owner uuid,p_call uuid,p_request uuid,p_session text,p_operation text,
 p_revision bigint,p_store_version bigint,p_digest text,p_kind text,p_target text,p_source_ids text[],p_interpretation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.website_interviews;old public.website_interview_live_operations;refs text[];literal text;expected text;
 a jsonb;item jsonb;updated jsonb;evidence jsonb;queue text;idx integer;status text;v_digest text;action jsonb;receipt uuid:=gen_random_uuid();begin
 i:=public.website_interview_live_actor(p_owner,p_call,p_request,p_session);
 if coalesce(p_kind,'') not in ('answer','correction','defer','not_applicable','reopen') or p_target is null
  or p_interpretation is null or length(btrim(p_interpretation)) not between 1 and 32768
  or coalesce(cardinality(p_source_ids),0)<1 or octet_length(p_source_ids::text)>2097152 or array_position(p_source_ids,null) is not null then raise exception 'live_operation_invalid';end if;
 select array_agg(x order by x) into refs from (select distinct unnest(p_source_ids) x) s;
 if cardinality(refs)<>cardinality(p_source_ids) then raise exception 'live_source_invalid';end if;
 select string_agg(delta,'' order by start_ms,end_ms,arrival_order) into literal from public.website_interview_live_fragments
  where call_id=p_call and provider_session_id=p_session and speaker='owner' and event_id=any(refs);
 if (select count(*) from public.website_interview_live_fragments where call_id=p_call and provider_session_id=p_session and speaker='owner' and event_id=any(refs))<>cardinality(refs)
  or length(btrim(coalesce(literal,'')))=0 then raise exception 'live_source_missing';end if;
 expected:='ligou-live-op:'||encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(1,i.tenant_id,i.interview_id,p_call,p_session,p_kind,jsonb_build_array(p_target),to_jsonb(refs))),'sha256'),'hex');
 if p_operation is distinct from expected then raise exception 'live_operation_identity_invalid';end if;
 select * into old from public.website_interview_live_operations where call_id=p_call and operation_ref=p_operation;
 if found then
  if row(old.kind,old.target_id,old.source_event_ids,old.interpretation) is distinct from row(p_kind,p_target,refs,p_interpretation) then raise exception 'live_operation_conflict';end if;
  return public.website_interview_readback(i.interview_id,true)||jsonb_build_object('operationRef',p_operation,'operationReceiptId',old.receipt_id,'operationRevision',old.revision);
 end if;
 if i.state in ('closing','complete') then raise exception 'live_approved_snapshot_requires_amendment';end if;
 if i.db_version is distinct from p_store_version or i.digest is distinct from p_digest or (i.agenda->>'revision')::bigint is distinct from p_revision then raise exception using errcode='40001',message='interview_revision_changed';end if;
 a:=i.agenda;
 select 'items',(ordinality-1)::int,value into queue,idx,item from jsonb_array_elements(a->'items') with ordinality where value->>'id'=p_target;
 if item is null then
  select 'candidateOverrides',(ordinality-1)::int,value into queue,idx,item from jsonb_array_elements(a->'candidateOverrides') with ordinality where value->>'id'=p_target;
 end if;
 if item is null and p_kind in ('correction','reopen') then
  select value||jsonb_build_object('source','contradiction','relatedItemIds','[]'::jsonb,'blocking',true,'status','open','answerRevision',0,'clarificationCount',0,'lastQuestionPt',value->>'questionPt','evidence','[]'::jsonb)
   into item from jsonb_array_elements(a->'candidateContext') where value->>'id'=p_target;
  if item is not null then queue:='candidateOverrides';idx:=jsonb_array_length(a->queue);a:=jsonb_set(a,array[queue],(a->queue)||jsonb_build_array(item));end if;
 end if;
 if item is null then raise exception 'live_target_not_in_catalogue';end if;
 if p_kind in ('answer','defer','not_applicable') and item->>'status' in ('answered','corrected','not_applicable','context_resolved') then raise exception 'live_resolved_target_requires_correction';end if;
 status:=case p_kind when 'answer' then case when (item->>'answerRevision')::bigint>0 then 'corrected' else 'answered' end
  when 'correction' then 'corrected' when 'reopen' then 'open' when 'defer' then 'deferred_owner_review' else 'not_applicable' end;
 evidence:=jsonb_build_object('turnId',p_call::text||':'||p_operation,'text',p_interpretation,'provenance','model_interpretation');
 updated:=item||jsonb_build_object('status',status,'answerRevision',(item->>'answerRevision')::bigint+case when p_kind='defer' then 0 else 1 end,'evidence',(item->'evidence')||jsonb_build_array(evidence));
 a:=jsonb_set(a,array[queue,idx::text],updated);
 a:=jsonb_set(jsonb_set(a,'{revision}',to_jsonb(p_revision+1)),'{ownerTurns}',(a->'ownerTurns')||jsonb_build_array(evidence));
 if queue='candidateOverrides' then
  a:=jsonb_set(a,'{candidateOverrides}',(select coalesce(jsonb_agg(o.value order by c.ordinality),'[]'::jsonb)
   from jsonb_array_elements(a->'candidateContext') with ordinality c(value,ordinality)
   join jsonb_array_elements(a->'candidateOverrides') o(value) on o.value->>'id'=c.value->>'id'));
 end if;
 if p_kind in ('correction','reopen') and a->'contextTimezone'->>'itemId'=p_target then a:=a-'contextTimezone';end if;
 perform public.website_interview_validate_agenda(a);
 v_digest:=encode(extensions.digest(public.onboarding_canonical_json_v1(a),'sha256'),'hex');
 action:=public.website_interview_action(a,case when p_kind='reopen' then 'correction' else p_kind end);
 insert into public.receipts(id,tenant_id,call_id,kind,outcome,external_id,payload_hash,readback,detail)
 values(receipt,i.tenant_id,p_call,'website_interview','accepted',p_operation,v_digest,jsonb_build_object('agenda',a,'nextAction',action),
  jsonb_build_object('sourceKind','live_fragments','operationRef',p_operation,'providerSessionId',p_session,'sourceEventIds',refs,'targetId',p_target,'interpretation',p_interpretation,'expectedRevision',p_revision,'expectedDigest',p_digest,'expectedStoreVersion',p_store_version));
 insert into public.website_interview_live_operations(call_id,tenant_id,interview_id,provider_session_id,operation_ref,kind,target_id,source_event_ids,source_text,interpretation,revision,receipt_id)
 values(p_call,i.tenant_id,i.interview_id,p_session,p_operation,p_kind,p_target,refs,literal,p_interpretation,p_revision+1,receipt);
 update public.website_interviews set agenda=a,next_action=action,digest=v_digest,db_version=db_version+1,receipt_id=receipt,
  state=case when exists(select 1 from jsonb_array_elements(a->'items'||(a->'candidateOverrides')) x where x->>'status' in ('open','awaiting_clarification')) then 'unfinished' else 'reviewing' end
  where interview_id=i.interview_id;
 return public.website_interview_readback(i.interview_id,false)||jsonb_build_object('operationRef',p_operation,'operationReceiptId',receipt,'operationRevision',p_revision+1);
end $$;
revoke all on function public.commit_website_live_decision(uuid,uuid,uuid,text,text,bigint,bigint,text,text,text,text[],text) from public,anon,authenticated;
grant execute on function public.commit_website_live_decision(uuid,uuid,uuid,text,text,bigint,bigint,text,text,text,text[],text) to service_role;

-- Structured duration/model usage is not a Realtime audio-token estimate.
alter table public.calls add column provider_usage_details jsonb
 check(provider_usage_details is null or (jsonb_typeof(provider_usage_details)='object' and octet_length(provider_usage_details::text)<=262144));

create function public.read_website_live_operation(p_owner uuid,p_call uuid,p_request uuid,p_operation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tenant uuid;op public.website_interview_live_operations;begin
 tenant:=public.website_interview_scope(p_owner,p_call,p_request,false);
 select * into op from public.website_interview_live_operations where call_id=p_call and tenant_id=tenant and operation_ref=p_operation;
 if not found then return null;end if;
 return jsonb_build_object('callId',p_call,'providerSessionId',op.provider_session_id,'operationRef',op.operation_ref,
  'operationReceiptId',op.receipt_id,'operationRevision',op.revision,'kind',op.kind,'targetId',op.target_id,
  'sourceEventIds',op.source_event_ids,'interpretation',op.interpretation);
end $$;
revoke all on function public.read_website_live_operation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.read_website_live_operation(uuid,uuid,uuid,text) to service_role;

create function public.record_website_live_termination(p_owner uuid,p_call uuid,p_request uuid,p_session text,
 p_reason text,p_outcome text,p_usage jsonb,p_final_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tenant uuid;c public.calls;created text;finalized boolean:=false;resolved boolean:=false;voice_seconds numeric;observed_cost numeric;details jsonb;begin
 tenant:=public.website_interview_scope(p_owner,p_call,p_request,false);
 select * into c from public.calls where id=p_call and tenant_id=tenant for update;
 if c.model is distinct from 'gpt-live-1' or not exists(select 1 from public.browser_session_requests where id=p_request and onboarding_protocol_version=6 and opening_mode_requested='live_managed_v1')
  or (c.openai_call_id is not null and c.openai_call_id is distinct from p_session)
  or (p_session is not null and length(btrim(p_session)) not between 1 and 512) then raise exception 'live_termination_identity_invalid';end if;
 if p_usage is null or jsonb_typeof(p_usage)<>'object' or octet_length(p_usage::text)>262000
  or coalesce(p_usage->>'creationState','') not in ('not_started','rejected','unknown','created')
  or jsonb_typeof(p_usage->'voiceSeconds') is distinct from 'number'
  or jsonb_typeof(p_usage->'totalObservedCostUsd') is distinct from 'number'
  or coalesce(p_outcome,'') not in ('ended','startup_error','killed_budget','killed_deadline','error')
  or p_reason is null or length(btrim(p_reason)) not between 1 and 200 then raise exception 'live_termination_invalid';end if;
 created:=p_usage->>'creationState';voice_seconds:=(p_usage->>'voiceSeconds')::numeric;observed_cost:=(p_usage->>'totalObservedCostUsd')::numeric;
 if voice_seconds<0 or voice_seconds>2147483647 or observed_cost<0 or observed_cost>1000000
  or (created in ('not_started','rejected') and p_session is not null) then raise exception 'live_usage_invalid';end if;
 if p_final_event is not null and p_final_event<>'null'::jsonb then
  if jsonb_typeof(p_final_event)<>'object' or not(p_final_event ?& array['eventId','sessionId','reason'])
   or p_final_event-array['eventId','sessionId','reason','seconds','expiresAt']<>'{}'
   or jsonb_typeof(p_final_event->'eventId') is distinct from 'string' or length(p_final_event->>'eventId') not between 1 and 512
   or p_final_event->>'sessionId' is distinct from p_session or p_session is null
   or coalesce(p_final_event->>'reason','') not in ('close_requested','expired','content','remote_hangup','connection_lost') then raise exception 'live_final_event_invalid';end if;
  finalized:=true;
  resolved:=coalesce(p_usage->'usageResolved'='true'::jsonb,false) and jsonb_typeof(p_final_event->'seconds')='number'
    and (p_final_event->>'seconds')::numeric=voice_seconds;
 end if;
 if created in ('not_started','rejected') then resolved:=true;end if;
 details:=p_usage||jsonb_build_object('finalEvent',p_final_event,'providerFinalized',finalized);
 if c.provider_termination_state='confirmed' then
  -- Late cleanup cannot downgrade a recorded final event or overwrite final usage.
  return jsonb_build_object('callId',c.id,'providerFinalized',true,'usageResolved',c.provider_usage_state='resolved','replayed',true);
 end if;
 update public.calls set
  openai_call_id=coalesce(c.openai_call_id,p_session),
  status=case when c.status<>'active' then c.status when p_outcome='startup_error' then 'error' else p_outcome end,
  ended_at=coalesce(c.ended_at,clock_timestamp()),duration_seconds=ceil(voice_seconds)::integer,
  cost_estimate_usd=greatest(coalesce(c.cost_estimate_usd,0),observed_cost),
  provider_termination_state=case when finalized then 'confirmed' when created in ('not_started','rejected') then 'not_required' else 'unknown' end,
  provider_termination_mode=case when p_session is null then null else 'hangup' end,
  provider_termination_reason=p_reason,provider_terminated_at=case when finalized then clock_timestamp() else null end,
  provider_usage_state=case when resolved then 'resolved' else 'unknown' end,provider_usage_details=details
 where id=p_call and tenant_id=tenant;
 return jsonb_build_object('callId',p_call,'providerFinalized',finalized,'usageResolved',resolved,'replayed',false);
end $$;
revoke all on function public.record_website_live_termination(uuid,uuid,uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_website_live_termination(uuid,uuid,uuid,text,text,text,jsonb,jsonb) to service_role;

-- Existing reconciliation must dispatch by the persisted provider protocol.
-- No new scheduler or polling loop is introduced.
do $claims$ declare signature text;definition text;begin
 foreach signature in array array['public.claim_budget_reconciliation(text)','public.claim_provider_termination_reconciliation(text)'] loop
  if to_regprocedure(signature) is null then continue;end if;
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position($needle$'openai_call_id', v_call.openai_call_id$needle$ in definition)=0 then raise exception 'live_claim_readback_missing:%',signature;end if;
  execute replace(definition,$needle$'openai_call_id', v_call.openai_call_id$needle$,$replacement$'model', v_call.model, 'channel', v_call.channel, 'session_type', v_call.session_type, 'provider_usage_details', v_call.provider_usage_details, 'openai_call_id', v_call.openai_call_id$replacement$);
 end loop;
end $claims$;
commit;
