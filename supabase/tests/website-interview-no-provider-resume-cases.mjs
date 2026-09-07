// Shared with the full production-schema gate. Every fixture mutation, including
// successful attaches, is rolled back. No network/provider identity is obtained.
import assert from 'node:assert/strict';
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const id=n=>`99000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

export async function runWebsiteNoProviderResumeCases({runSql,owner,tenant,call,request,other}) {
  const scenarios=[],constraintRejections=[];
  const current=`where id=${q(call)}`;
  const interview=`where interview_id=${q(call)}`;
  const prior=`public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(call)},2)`;
  const eligible=`public.website_interview_resume_eligible(${q(call)},${q(owner)})`;
  const rejection=(failedCall=call,failedRequest=request)=>`
    update public.calls set status='error',ended_at=clock_timestamp(),duration_seconds=0,
      provider_termination_state='not_required',provider_termination_mode=null,
      provider_termination_reason='realtime_unavailable',provider_usage_state='resolved',
      openai_call_id=null,provider_termination_attempt_id=null,provider_termination_request_id=null,provider_termination_attempted_at=null,
      cost_estimate_usd=0.00162,transcript='[]' where id=${q(failedCall)};
    update public.browser_session_requests set status='error',error='realtime_unavailable',
      answer_sdp=null,opening_mode_applied=null,opening_payload=null where id=${q(failedRequest)};
    update public.budget_reservations set status='settled',outcome='startup_error',
      final_cost_usd=0.00162,final_minutes=0,settled_at=clock_timestamp() where call_id=${q(failedCall)};`;
  const successor=(nextCall=id(1),nextRequest=id(2))=>`
    insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,provider_termination_state,provider_usage_state)
      values(${q(nextCall)},${q(tenant)},'browser','onboarding','active',2,'not_required','not_applicable');
    insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version,test_memory_generation)
      values(${q(nextRequest)},${q(tenant)},${q(owner)},'onboarding','isolated-no-provider-offer','processing',${q(nextCall)},'application_tts_v1',3,2);`;
  const inspect=async(mutation='',expression=prior)=>JSON.parse(await runSql(`begin;
    set local request.jwt.claim.role='service_role'; ${rejection()} ${mutation}
    select to_jsonb(${expression}); rollback;`));
  assert.equal(await inspect(),true,'initialized definitive rejection must be settled/resumable without a provider ID');
  assert.equal(await inspect('',eligible),true,'dashboard preflight must offer genuine resume');
  scenarios.push('definitive-rejection-with-paid-tts-is-resumable');
  const opening=`do $opening$ declare i public.website_interviews; spoken text; action_id text; action jsonb; payload jsonb; begin
    select * into i from public.website_interviews where interview_id=${q(call)};
    select 'Oi! Aqui é o Ligou, agente de inteligência artificial da '||name||'. Eu já analisei seu website. '||(i.next_action->>'spokenPt') into spoken from public.tenants where id=${q(tenant)};
    action_id:=encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(i.next_action->>'actionId','opening',spoken)),'sha256'),'hex');
    action:=jsonb_build_object('actionId',action_id,'interviewId',${q(call)},'callId',${q(call)},'revision',0,'kind','ASK_NEXT_GAP','text',spoken,'sourceDigest',i.digest);
    perform public.claim_website_interview_speech(${q(owner)},${q(call)},${q(request)},action);
    payload:=action||jsonb_build_object('schema','onboarding.speech.v1','text_sha256',encode(extensions.digest(spoken,'sha256'),'hex'),
      'audio_base64','SUQzBA==','audio_sha256',encode(extensions.digest(decode('SUQzBA==','base64'),'sha256'),'hex'),
      'mime','audio/mpeg','voice','ash','tts_model','tts-1-hd','cost_usd',round(length(spoken)*30::numeric/1000000,8));
    perform public.complete_website_interview_speech(${q(owner)},${q(call)},${q(request)},action_id,payload);
  end $opening$;`;
  await runSql(`begin;set local request.jwt.claim.role='service_role';${opening} ${rejection()}
    update public.calls set cost_estimate_usd=(select (payload->>'cost_usd')::numeric from public.website_interview_speech where call_id=${q(call)}) ${current};
    update public.budget_reservations set final_cost_usd=(select cost_estimate_usd from public.calls ${current}) where call_id=${q(call)};
    do $probe$ begin if not ${prior} then raise exception 'paid_unplayed_opening_blocks_resume'; end if; end $probe$;
    ${successor()}
    do $probe$ begin
      perform public.resolve_prepared_website_source(${q(owner)},${q(id(1))},${q(id(2))});
      perform public.attach_website_interview(${q(owner)},${q(id(1))},${q(id(2))},${q(call)},${q(call)});
      if not exists(select 1 from public.website_interview_speech where call_id=${q(call)} and status='superseded'
        and ready_receipt_id is not null and payload->>'audio_base64'='SUQzBA==') then raise exception 'paid_opening_receipt_or_bytes_lost'; end if;
    end $probe$;rollback;`);
  scenarios.push('paid-ready-opening-resumes-with-receipt-and-bytes-preserved');
  assert.equal(JSON.parse(await runSql(`begin;set local request.jwt.claim.role='service_role';${opening}
    do $played$ declare s public.website_interview_speech; begin
      select * into s from public.website_interview_speech where call_id=${q(call)};
      perform public.record_website_interview_speech_played(${q(owner)},${q(call)},${q(request)},s.action_id,
        'lgs-'||left(s.action_id,28),s.action->>'text',s.payload->>'text_sha256',s.payload->>'audio_sha256');
    end $played$;${rejection()} select to_jsonb(${prior});rollback;`)),false);
  scenarios.push('played-opening-cannot-use-no-provider-recovery');
  const ownerTurn=`insert into public.website_interview_owner_turns(call_id,provider_item_id,tenant_id,owner_text)
    values(${q(call)},'isolated-owner-turn',${q(tenant)},'Somente Novato.');`;
  const summary=`insert into public.website_interview_summaries(id,interview_id,tenant_id,call_id,revision,store_version,digest,agenda_receipt_id,draft_id,parts,summary_hash,receipt_id)
    select ${q(id(30))},interview_id,tenant_id,current_call_id,0,db_version,digest,receipt_id,(agenda->'binding'->>'draftId')::uuid,'["Isolated summary fixture"]',repeat('c',64),receipt_id from public.website_interviews ${interview};`;
  const approval=`${ownerTurn} ${summary}
    insert into public.website_interview_approvals(interview_id,tenant_id,call_id,summary_id,provider_item_id,owner_text,receipt_id,finalized_draft)
      select interview_id,tenant_id,current_call_id,${q(id(30))},'isolated-owner-turn','Somente Novato.',receipt_id,'{}' from public.website_interviews ${interview};`;

  const cases=[
    ['unknown-provider',`update public.calls set provider_termination_state='unknown' ${current};`],
    ['pending-provider',`update public.calls set provider_termination_state='pending' ${current};`],
    ['active-provider',`update public.calls set provider_termination_state='active' ${current};`],
    ['unproven-expiry',`update public.calls set provider_termination_state='external_evidence_required' ${current};`],
    ['accepted-provider-id',`update public.calls set openai_call_id='isolated-accepted-provider' ${current};`],
    ['termination-attempt',`update public.calls set provider_termination_attempt_id=${q(id(9))},provider_termination_request_id=${q(id(9))},provider_termination_attempted_at=clock_timestamp() ${current};`],
    ['termination-attempt-time',`update public.calls set provider_termination_attempted_at=clock_timestamp() ${current};`,/calls_provider_termination_attempt_check/],
    ['termination-receipt-time',`update public.calls set provider_terminated_at=clock_timestamp() ${current};`],
    ['termination-mode',`update public.calls set provider_termination_mode='hangup' ${current};`],
    ['non-rejection-reason',`update public.calls set provider_termination_reason='provider_outcome_unknown' ${current};`],
    ['unknown-usage',`update public.calls set provider_usage_state='unknown' ${current};`],
    ['missing-known-cost',`update public.calls set cost_estimate_usd=null ${current};`],
    ['unsettled-budget',`update public.budget_reservations set status='active',outcome=null,final_cost_usd=null,final_minutes=null,settled_at=null where call_id=${q(call)};`],
    ['mismatched-settled-cost',`update public.budget_reservations set final_cost_usd=0 where call_id=${q(call)};`],
    ['wrong-budget-outcome',`update public.budget_reservations set outcome='ended' where call_id=${q(call)};`],
    ['wrong-budget-tenant',`insert into public.tenants(id,slug,name,owner_user_id,status,operational_mode,test_memory_generation) values(${q(id(8))},'isolated-no-provider-other','Other isolated tenant',${q(other)},'onboarding','simulation_only',2);
      update public.budget_reservations set tenant_id=${q(id(8))} where call_id=${q(call)};`],
    ['nonzero-duration',`update public.calls set duration_seconds=1 ${current};`],
    ['non-error-terminal',`update public.calls set status='ended' ${current};`],
    ['no-terminal-time',`update public.calls set ended_at=null ${current};`],
    ['wrong-generation',`update public.tenants set test_memory_generation=3 where id=${q(tenant)};`],
    ['wrong-tenant-owner',`update public.tenants set owner_user_id=${q(other)} where id=${q(tenant)};`],
    ['wrong-call-channel',`update public.calls set channel='phone' ${current};`,/calls_channel_check/],
    ['owner-transcript',`update public.calls set transcript='[{"role":"caller","text":"Somente Novato."}]' ${current};`],
    ['owner-turn-not-committed',ownerTurn],
    ['summary-progress',summary],
    ['existing-approval',approval],
    ['changed-agenda',`update public.website_interviews set agenda=jsonb_set(agenda,'{items,0,lastQuestionPt}','"Pergunta diferente?"') ${interview};`],
    ['changed-digest',`update public.website_interviews set digest=repeat('e',64) ${interview};`],
    ['reviewing-interview',`update public.website_interviews set state='reviewing' ${interview};`],
    ['closing-interview',`update public.website_interviews set state='closing' ${interview};`],
    ['changed-source-hash',`update public.website_interview_preparations set draft_hash=repeat('e',64) where consumed_call_id=${q(call)};`],
    ['changed-source-owner',`update public.website_interview_preparations set owner_id=${q(other)} where consumed_call_id=${q(call)};`],
    ['changed-source-generation',`update public.website_interview_preparations set generation=3 where consumed_call_id=${q(call)};`],
    ['wrong-request-owner',`update public.browser_session_requests set user_id=${q(other)} where id=${q(request)};`],
    ['wrong-request-generation',`update public.browser_session_requests set test_memory_generation=3 where id=${q(request)};`,/test_memory_generation_immutable/],
    ['old-protocol-request',`update public.browser_session_requests set onboarding_protocol_version=2 where id=${q(request)};`,/browser_session_protocol_identity_invalid/],
    ['missing-request-call-binding',`update public.browser_session_requests set call_id=null where id=${q(request)};`],
    ['request-not-rejected',`update public.browser_session_requests set status='processing' where id=${q(request)};`],
    ['request-missing-rejection-reason',`update public.browser_session_requests set error=null where id=${q(request)};`],
    ['request-has-answer',`update public.browser_session_requests set answer_sdp='isolated-answer' where id=${q(request)};`,/browser_session_requests_.*check/],
    ['request-has-opening',`update public.browser_session_requests set opening_payload='{}' where id=${q(request)};`,/browser_session_requests_.*check/],
    ['changed-preparation-consumption',`update public.website_interview_preparations set consumed_call_id=null,consumed_at=null where consumed_call_id=${q(call)};`],
    ['amendment-child',`update public.website_interviews set parent_interview_id=interview_id ${interview};`],
    ['amendment-receipt',`update public.website_interviews set amendment_request_receipt_id=receipt_id ${interview};`],
    ['pending-preparation',`insert into public.website_interview_preparations(id,tenant_id,owner_id,generation,prior_call_id,draft_id,draft_hash,result_id,result_hash)
      select ${q(id(31))},tenant_id,owner_id,generation,${q(call)},draft_id,draft_hash,result_id,result_hash from public.website_interview_preparations where consumed_call_id=${q(call)};`],
    ['competing-active-successors',`${successor()} ${successor(id(3),id(4))}`],
    ['later-failed-unattached-attempt',`${successor()} update public.calls set status='error',ended_at=clock_timestamp() where id=${q(id(1))}; update public.browser_session_requests set status='error' where id=${q(id(2))};`],
    ['unbound-competing-request',`insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,opening_mode_requested,onboarding_protocol_version,test_memory_generation)
      values(${q(id(2))},${q(tenant)},${q(owner)},'onboarding','isolated-competing-offer','pending','application_tts_v1',3,2);`],
  ];
  for(const [name,mutation,constraint] of cases) {
    try {assert.equal(await inspect(mutation),false,`${name} must not qualify for the no-provider branch`);}
    catch(error) {
      if(!constraint?.test(error.message))throw error;
      constraintRejections.push(name);
    }
    scenarios.push(`blocks-${name}`);
  }
  assert.equal(await inspect('',`public.website_interview_prior_settled(${q(tenant)},${q(other)},${q(call)},2)`),false);
  assert.equal(await inspect('',`public.website_interview_prior_settled(${q(id(8))},${q(owner)},${q(call)},2)`),false);
  assert.equal(await inspect('',`public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(call)},3)`),false);
  scenarios.push('blocks-wrong-predicate-owner-tenant-generation');

  const next=id(1),nextRequest=id(2),third=id(3),thirdRequest=id(4);
  await runSql(`begin; set local request.jwt.claim.role='service_role'; ${rejection()}
    create temporary table no_provider_snapshot on commit drop as select i.agenda,
      (select to_jsonb(c) from public.calls c where c.id=${q(call)}) failed_call,
      (select to_jsonb(b) from public.budget_reservations b where b.call_id=${q(call)}) budget,
      (select to_jsonb(p) from public.website_interview_preparations p where p.id=i.preparation_id) preparation,
      (select to_jsonb(d) from public.company_discovery_onboarding_drafts d where d.id=(i.agenda->'binding'->>'draftId')::uuid) draft
      from public.website_interviews i ${interview};
    ${successor()}
    do $probe$ declare resolved jsonb; attached jsonb; expected jsonb; begin
      resolved:=public.resolve_prepared_website_source(${q(owner)},${q(next)},${q(nextRequest)});
      if resolved->'resume' is distinct from jsonb_build_object('interviewId',${q(call)}::text,'priorCallId',${q(call)}::text) then raise exception 'no_provider_resume_not_resolved'; end if;
      attached:=public.attach_website_interview(${q(owner)},${q(next)},${q(nextRequest)},${q(call)},${q(call)});
      select jsonb_set(agenda,'{binding,callId}',to_jsonb(${q(next)}::text)) into expected from no_provider_snapshot;
      if attached->'agenda' is distinct from expected or attached->'nextAction' is distinct from public.website_interview_action(expected,'initial') then raise exception 'no_provider_resume_changed_agenda_or_next_question'; end if;
      if (public.attach_website_interview(${q(owner)},${q(next)},${q(nextRequest)},${q(call)},${q(call)})->>'replayed') is distinct from 'true' then raise exception 'no_provider_attach_not_idempotent'; end if;
      if ${prior} then raise exception 'superseded_failed_call_still_qualifies'; end if;
    end $probe$;
    ${rejection(next,nextRequest)}
    do $probe$ begin
      if public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(next)},2) then raise exception 'missing_budget_qualified'; end if;
    end $probe$;
    insert into public.budget_reservations(tenant_id,call_id,budget_day,reserved_cost_usd,reserved_minutes,status) values(${q(tenant)},${q(next)},current_date,1,55,'active');
    ${rejection(next,nextRequest)}
    do $probe$ begin
      if not public.website_interview_resume_eligible(${q(call)},${q(owner)}) then raise exception 'second_empty_rejection_not_resumable'; end if;
    end $probe$;
    ${successor(third,thirdRequest)}
    do $probe$ declare attached jsonb; expected jsonb; begin
      perform public.resolve_prepared_website_source(${q(owner)},${q(third)},${q(thirdRequest)});
      attached:=public.attach_website_interview(${q(owner)},${q(third)},${q(thirdRequest)},${q(call)},${q(next)});
      select jsonb_set(agenda,'{binding,callId}',to_jsonb(${q(third)}::text)) into expected from no_provider_snapshot;
      if attached->'agenda' is distinct from expected then raise exception 'second_rejection_resume_changed_agenda'; end if;
      if (select count(*) from public.website_interview_calls where interview_id=${q(call)})<>3 then raise exception 'resume_history_missing_or_duplicated'; end if;
      if (select to_jsonb(c) from public.calls c where c.id=${q(call)}) is distinct from (select failed_call from no_provider_snapshot)
        or (select to_jsonb(b) from public.budget_reservations b where b.call_id=${q(call)}) is distinct from (select budget from no_provider_snapshot)
        or (select to_jsonb(p) from public.website_interview_preparations p where p.consumed_call_id=${q(call)}) is distinct from (select preparation from no_provider_snapshot)
        or (select to_jsonb(d) from public.company_discovery_onboarding_drafts d where d.id=(expected->'binding'->>'draftId')::uuid) is distinct from (select draft from no_provider_snapshot)
        then raise exception 'recovery_mutated_failed_attempt_budget_preparation_or_source'; end if;
      if exists(select 1 from public.website_interview_owner_turns t join public.website_interview_calls wc using(call_id) where wc.interview_id=${q(call)})
        or exists(select 1 from public.website_interview_approvals where interview_id=${q(call)})
        or exists(select 1 from public.website_interview_fact_batches where interview_id=${q(call)})
        then raise exception 'recovery_fabricated_owner_progress_or_authority'; end if;
    end $probe$; rollback;`);
  scenarios.push('resolve-and-attach-unchanged-initial-agenda','attach-idempotency-and-stale-actor-fence','missing-budget-remains-blocked','second-empty-rejection-resumes','failed-attempt-budget-source-and-history-preserved','no-fabricated-owner-progress-or-approval');

  // The established accepted-provider branch keeps its previous behavior.
  assert.equal(await inspect(`update public.calls set provider_termination_state='confirmed',provider_termination_reason='fixture-confirmed' ${current};`),true);
  scenarios.push('existing-confirmed-provider-branch-preserved');
  // Synthetic accepted-call data exercises the existing expiry RPC itself;
  // this is not a claim of a live provider 404 or a forged production receipt.
  const expired=id(40),expiryRequest=id(41),termination=id(42);
  await runSql(`begin;set local request.jwt.claim.role='service_role';${rejection()}
    insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,started_at,ended_at,
      model,openai_call_id,provider_termination_state,provider_termination_mode,provider_termination_attempt_id,provider_termination_request_id,provider_termination_attempted_at)
      values(${q(expired)},${q(tenant)},'browser','onboarding','error',2,clock_timestamp()-interval '121 minutes',clock_timestamp()-interval '119 minutes',
      'gpt-realtime-2.1','isolated-expiry-provider','external_evidence_required','hangup',${q(termination)},${q(termination)},clock_timestamp()-interval '120 minutes');
    insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,opening_mode_applied,answer_sdp,test_memory_generation)
      values(${q(expiryRequest)},${q(tenant)},${q(owner)},'onboarding','isolated-expiry-offer','ready',${q(expired)},'provider_model_v1','provider_model_v1','isolated-expiry-answer',2);
    insert into public.budget_reservations(tenant_id,call_id,budget_day,reserved_cost_usd,reserved_minutes,status,outcome,final_cost_usd,final_minutes,settled_at)
      values(${q(tenant)},${q(expired)},current_date,1,55,'settled','error',0.01,1,clock_timestamp());
    do $probe$ begin
      if public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(expired)},2) then raise exception 'expiry_without_receipt_qualified'; end if;
      perform public.reconcile_browser_interview_expiry(${q(expired)},'isolated-expiry-provider',clock_timestamp(),404,'call_id_not_found','invalid_request_error','local-fixture:expiry');
      if not public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(expired)},2) then raise exception 'recorded_expiry_branch_regressed'; end if;
      if public.website_interview_prior_settled(${q(tenant)},${q(other)},${q(expired)},2)
        or public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(expired)},3) then raise exception 'expiry_owner_generation_binding_regressed'; end if;
    end $probe$;rollback;`);
  scenarios.push('existing-expiry-requires-recorded-matching-proof','existing-expiry-rpc-and-owner-generation-binding-preserved');
  assert.equal(await runSql(`select has_function_privilege('service_role','public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint)','execute');`),'f');
  assert.equal(await runSql(`select has_function_privilege('authenticated','public.website_interview_prior_settled_noninitial(uuid,uuid,uuid,bigint)','execute');`),'f');
  scenarios.push('private-helper-acl-preserved');
  return {tests:scenarios.length,scenarios,constraintRejections,providerCalls:0,rolledBack:true};
}
