-- Extra scenarios use independent tenants in the same isolated PostgreSQL fixture.
-- They exercise real migration functions; none of these IDs are provider evidence.
do $$
declare
 o uuid:='9c000000-0000-4000-8000-000000000001';t uuid:='9c000000-0000-4000-8000-000000000002';
 c uuid:='9c000000-0000-4000-8000-000000000003';r uuid:='9c000000-0000-4000-8000-000000000004';
 d uuid:='9c000000-0000-4000-8000-000000000005';w uuid:='9c000000-0000-4000-8000-000000000006';
 j uuid:='9c000000-0000-4000-8000-000000000007';attempt uuid:='9c000000-0000-4000-8000-000000000008';
 preparation uuid:='9c000000-0000-4000-8000-000000000009';hours uuid:='9c000000-0000-4000-8000-000000000010';
 price uuid:='9c000000-0000-4000-8000-000000000011';evidence_ref uuid:='9c000000-0000-4000-8000-000000000012';
 draft jsonb;agenda jsonb;timezone_context jsonb;proof jsonb;before_items jsonb;operation text;target text;source_id text;
 i public.website_interviews;position integer;interpretation text;
begin
 insert into auth.users values(o);
 insert into public.tenants(id,owner_user_id,status,operational_mode,test_memory_generation)
  values(t,o,'onboarding','simulation_only',2);
 insert into public.worker_jobs(id,tenant_id,selected_attempt_id,status) values(j,t,attempt,'awaiting_review');
 insert into public.worker_results(id,tenant_id,job_id,attempt_id,result_hash,validation_state,result_schema)
  values(w,t,j,attempt,repeat('b',64),'validated','company_discovery.result.v2');
 draft:=jsonb_build_object('schema_version','company_discovery.onboarding_draft.v2','source_result_hash',repeat('b',64),
  'missing_information',jsonb_build_array('Qual é o fuso horário?'),
  'candidate_facts',jsonb_build_array(
   jsonb_build_object('claim_id',hours,'claim_type','business_hours','value',jsonb_build_object('timezone','America/Los_Angeles'),
    'contradiction_status','none','missing_fields','[]'::jsonb,'ambiguous_fields','[]'::jsonb,'evidence_refs',jsonb_build_array(evidence_ref)),
   jsonb_build_object('claim_id',price,'claim_type','service','value',jsonb_build_object('service_type','Limpeza','public_price','149.00'))));
 insert into public.company_discovery_onboarding_drafts(id,tenant_id,source_job_id,source_result_id,created_by,draft_hash,draft,version)
  values(d,t,j,w,o,repeat('a',64),draft,1);
 perform public.prepare_initial_website_interview(preparation,o,t,2,d,repeat('a',64),w,repeat('b',64));
 insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,model,started_at)
  values(c,t,'browser','onboarding','active',2,'gpt-live-1',clock_timestamp());
 insert into public.browser_session_requests(id,tenant_id,call_id,user_id,session_type,test_memory_generation,onboarding_protocol_version,opening_mode_requested,status,offer_sdp)
  values(r,t,c,o,'onboarding',2,6,'live_managed_v1','processing','isolated-context-offer');
 insert into public.budget_reservations(tenant_id,call_id,status,budget_day,reserved_cost_usd,reserved_minutes)
  values(t,c,'active',current_date,7.5,55);
 timezone_context:=public.website_timezone_context_for_draft(draft,'timezone');
 if timezone_context is null or timezone_context->>'timeZone' is distinct from 'America/Los_Angeles' then raise exception 'live_timezone_fixture_invalid';end if;
 agenda:=jsonb_build_object('version',1,'binding',jsonb_build_object('interviewId',c,'callId',c,'draftId',d,'draftHash',repeat('a',64),'sourceResultId',w,'sourceResultHash',repeat('b',64)),
  'revision',0,'ownerTurns','[]'::jsonb,'candidateOverrides','[]'::jsonb,'contextTimezone',timezone_context,
  'items',jsonb_build_array(
   jsonb_build_object('id','timezone','source','missing_website_information','subject','timezone','questionPt','Qual é o fuso horário?',
    'coverageRefs',jsonb_build_array('hours.timezone'),'relatedItemIds','[]'::jsonb,'blocking',true,'status','context_resolved','answerRevision',0,'clarificationCount',0,'lastQuestionPt','Qual é o fuso horário?','evidence','[]'::jsonb),
   jsonb_build_object('id','area','source','ambiguity','subject','area','questionPt','Qual a área de atendimento?',
    'coverageRefs',jsonb_build_array('area'),'relatedItemIds','[]'::jsonb,'blocking',true,'status','open','answerRevision',0,'clarificationCount',0,'lastQuestionPt','Qual a área de atendimento?','evidence','[]'::jsonb)),
  'candidateContext',jsonb_build_array(
   jsonb_build_object('id','candidate:'||hours,'subject','business_hours','questionPt','Quais são os horários publicados?','coverageRefs',jsonb_build_array('discovery.candidate.'||replace(hours::text,'-',''))),
   jsonb_build_object('id','candidate:'||price,'subject','service','questionPt','Qual é o preço da limpeza?','coverageRefs',jsonb_build_array('discovery.candidate.'||replace(price::text,'-','')))));
 proof:=public.initialize_website_interview(o,c,r,preparation,agenda);
 if proof->'agenda'->'contextTimezone' is distinct from timezone_context or proof->'nextAction'->>'itemId' is distinct from 'area'
  or proof->'agenda'->'items'->0->>'status' is distinct from 'context_resolved' then raise exception 'live_timezone_was_reasked';end if;
 before_items:=proof->'agenda'->'items';
 update public.browser_session_requests set status='ready',answer_sdp='isolated-live-answer',opening_mode_applied='live_managed_v1',
  opening_payload=jsonb_build_object('version',6,'live',jsonb_build_object('callId',c,'interviewId',c,'revision',0,'sourceDigest',proof->>'digest','sessionId','live-extra-fixture')) where id=r;
 update public.calls set openai_call_id='live-extra-fixture',provider_termination_state='active',provider_usage_state='unknown' where id=c;
 -- Correct the second original candidate first, then the first candidate.
 for position in 1..2 loop
  target:='candidate:'||case when position=1 then price else hours end;
  source_id:=case when position=1 then 'actual-fixture-price' else 'actual-fixture-hours' end;
  interpretation:=case when position=1 then 'Limpeza custa USD 180.00.' else 'Segunda a sexta das 9h às 17h.' end;
  perform public.record_website_live_fragments(o,c,r,'live-extra-fixture',jsonb_build_array(jsonb_build_object('eventId',source_id,'speaker','owner','text',interpretation,'startMs',position*1000,'endMs',position*1000+500)));
  select * into i from public.website_interviews where interview_id=c;
  operation:='ligou-live-op:'||encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(1,t,c,c,'live-extra-fixture','correction',jsonb_build_array(target),jsonb_build_array(source_id))),'sha256'),'hex');
  proof:=public.commit_website_live_decision(o,c,r,'live-extra-fixture',operation,(i.agenda->>'revision')::bigint,i.db_version,i.digest,'correction',target,array[source_id],interpretation);
 end loop;
 if proof->'agenda'->'candidateOverrides'->0->>'id' is distinct from 'candidate:'||hours
  or proof->'agenda'->'candidateOverrides'->1->>'id' is distinct from 'candidate:'||price
  or proof->'agenda'->'candidateOverrides'->0->'evidence'->-1->>'text' is distinct from 'Segunda a sexta das 9h às 17h.'
  or proof->'agenda'->'candidateOverrides'->1->'evidence'->-1->>'text' is distinct from 'Limpeza custa USD 180.00.' then raise exception 'live_candidate_correction_order_wrong';end if;
 if proof->'agenda'->'items' is distinct from before_items or proof->'agenda'->'contextTimezone' is distinct from timezone_context
  or (select source.draft from public.company_discovery_onboarding_drafts source where source.id=d) is distinct from draft then raise exception 'live_correction_changed_unrelated_source';end if;
 if (select count(*) from public.website_interview_live_operations where call_id=c)<>2 or (proof->>'revision')::int is distinct from 2 then raise exception 'live_candidate_correction_receipts_missing';end if;
end $$;
select 'live_timezone_initialization_and_candidate_order_passed';

do $$
declare o uuid:='9d000000-0000-4000-8000-000000000001';t uuid:='9d000000-0000-4000-8000-000000000002';
 c uuid:='9d000000-0000-4000-8000-000000000003';r uuid:='9d000000-0000-4000-8000-000000000004';proof jsonb;
begin
 insert into auth.users values(o);
 insert into public.tenants(id,owner_user_id,status,operational_mode,test_memory_generation) values(t,o,'onboarding','simulation_only',2);
 insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,model)
  values(c,t,'browser','onboarding','active',2,'gpt-live-1');
 insert into public.browser_session_requests(id,tenant_id,call_id,user_id,session_type,test_memory_generation,onboarding_protocol_version,opening_mode_requested,status,offer_sdp)
  values(r,t,c,o,'onboarding',2,6,'live_managed_v1','processing','isolated-startup-offer');
 insert into public.budget_reservations(tenant_id,call_id,status,budget_day,reserved_cost_usd,reserved_minutes)
  values(t,c,'active',current_date,7.5,55);
 if exists(select 1 from public.website_interview_calls where call_id=c) then raise exception 'startup_failure_fixture_initialized';end if;
 proof:=public.record_website_live_termination(o,c,r,null,'website_context_unavailable','startup_error',
  '{"creationState":"not_started","voiceSeconds":0,"totalObservedCostUsd":0,"usageResolved":true}',null);
 if proof->>'providerFinalized' is distinct from 'false' or proof->>'usageResolved' is distinct from 'true' then raise exception 'startup_failure_termination_proof_wrong';end if;
 if not exists(select 1 from public.calls where id=c and status='error' and ended_at is not null and openai_call_id is null
  and provider_termination_state='not_required' and provider_usage_state='resolved' and cost_estimate_usd=0 and duration_seconds=0) then raise exception 'startup_failure_call_not_terminal';end if;
 if exists(select 1 from public.website_interviews where tenant_id=t) or exists(select 1 from public.website_interview_approvals where tenant_id=t)
  then raise exception 'startup_failure_fabricated_interview';end if;
end $$;
select 'live_preinterview_startup_failure_termination_passed';
