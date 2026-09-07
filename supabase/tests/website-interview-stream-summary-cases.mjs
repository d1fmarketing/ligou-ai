// Synthetic provider/media proof, actual SQL summary/approval/amendment gates.
// Every operation rolls back; these tests do not claim a spoken interview.
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const jq=value=>`${q(JSON.stringify(value))}::jsonb`;
export async function runWebsiteStreamSummaryCases({runSql,owner,tenant,call,request,prelude='',parts=['Área confirmada no documento atual.','Pendências permanecem para revisão do dono.']}) {
  const scope=`${q(owner)},${q(call)},${q(request)}`,summary='9d000000-0000-4000-8000-000000000001';
  const approvalQuestion='Está tudo correto no resumo e você confirma essas informações? Se precisar, diga o que devo corrigir.';
  const signoff='Perfeito. Seu onboarding foi concluído e suas informações foram salvas. Até logo.';
  const media=jq({schema:'onboarding.stream.media.v1',nonzeroSamples:48,observedMs:1600,firstSampleAtMs:100,lastSampleAtMs:1700,unmuted:true,playbackStarted:true});
  const completeQueue=`do $queue$ declare i public.website_interviews; item jsonb; items jsonb; new_agenda jsonb; turn jsonb; input_id text; words text; counter integer:=0;begin
    loop
      i:=public.website_interview_current(${scope});
      select value into item from jsonb_array_elements(i.agenda->'items') with ordinality a(value,pos) where value->>'status' in ('open','awaiting_clarification') order by pos limit 1;
      exit when item is null;counter:=counter+1;input_id:='stream-test-defer-'||counter;words:='Deixe este ponto explicitamente para revisão: '||(item->>'id')||'.';
      perform public.record_website_interview_owner_turn(${scope},input_id,words);
      turn:=jsonb_build_object('turnId',${q(call)}||':'||input_id,'text',words);
      select jsonb_agg(case when x->>'id'=item->>'id' then x||jsonb_build_object('status','deferred_owner_review','evidence',x->'evidence'||jsonb_build_array(turn)) else x end order by pos)
        into items from jsonb_array_elements(i.agenda->'items') with ordinality a(x,pos);
      new_agenda:=i.agenda||jsonb_build_object('revision',(i.agenda->>'revision')::bigint+1,'ownerTurns',i.agenda->'ownerTurns'||jsonb_build_array(turn),'items',items);
      perform public.commit_website_interview_turn(${scope},(i.agenda->>'revision')::bigint,i.db_version,i.digest,input_id,new_agenda,'defer','[]'::jsonb);
    end loop;
    if i.state<>'reviewing' then raise exception 'stream_review_queue_not_finished';end if;
  end $queue$;`;
  const speechFunction=`create function pg_temp.stream_test_say(kind text,spoken text,slot text,part integer default null) returns jsonb language plpgsql as $say$
    declare i public.website_interviews;act jsonb;a jsonb;proof jsonb;begin
      i:=public.website_interview_current(${scope});
      act:=jsonb_build_object('actionId',encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(i.interview_id,(i.agenda->>'revision')::bigint,kind,slot,spoken)),'sha256'),'hex'),
        'interviewId',i.interview_id,'callId',${q(call)},'revision',i.agenda->'revision','kind',kind,'text',spoken,'sourceDigest',i.digest);
      a:=public.claim_website_interview_stream(${scope},act,${q(summary)},part,null);
      if (select status from public.browser_session_requests where id=${q(request)})='processing' then
        update public.browser_session_requests set status='ready',answer_sdp='stream-summary-answer',opening_mode_applied='realtime_stream_v1',opening_payload=jsonb_build_object('version',4,'stream',a) where id=${q(request)};
      end if;
      perform public.authorize_website_interview_stream(${scope},act->>'actionId',(a->>'dispatchId')::uuid);
      proof:=public.record_website_interview_stream_response(${scope},act->>'actionId',(a->>'dispatchId')::uuid,'response-'||(a->>'dispatchId'),'item-'||(a->>'dispatchId'),spoken,'completed');
      if proof->>'status'<>'ready' then raise exception 'stream_summary_generation_advanced';end if;
      proof:=public.record_website_interview_stream_playout(${scope},act->>'actionId',(a->>'dispatchId')::uuid,'response-'||(a->>'dispatchId'),'item-'||(a->>'dispatchId'),'buffer-'||(a->>'dispatchId'),${media});
      if proof->>'status'<>'played' then raise exception 'stream_summary_playout_missing';end if;
      return proof;
    end $say$;`;
  const setup=`${completeQueue}
    update public.calls set openai_call_id='rtc_stream_summary_fixture',provider_termination_state='active',provider_usage_state='unknown' where id=${q(call)};
    create temporary table stream_summary_case(summary jsonb,approval jsonb) on commit drop;
    do $summary$ declare i public.website_interviews;s jsonb;begin
      i:=public.website_interview_current(${scope});
      s:=public.prepare_website_interview_summary(${scope},${q(summary)},(i.agenda->>'revision')::bigint,i.db_version,i.digest,i.receipt_id,${jq(parts)});
      insert into stream_summary_case(summary) values(s);
    end $summary$;
    ${speechFunction}
    select public.record_website_interview_owner_turn(${scope},'too-early-approval','Eu aprovo esta configuração.');
    do $ordering$ declare i public.website_interviews;s jsonb:=(select summary from stream_summary_case);begin
      i:=public.website_interview_current(${scope});
      begin perform pg_temp.stream_test_say('REQUEST_FINAL_APPROVAL',${q(approvalQuestion)},'premature-approval');raise exception 'stream_approval_question_before_recap';
      exception when others then if sqlerrm not like '%summary_not_fully_played%' then raise;end if;end;
      begin perform pg_temp.stream_test_say('SPEAK_FINAL_SIGNOFF',${q(signoff)},'premature-signoff');raise exception 'stream_signoff_before_approval';
      exception when others then if sqlerrm not like '%signoff_requires_approval%' then raise;end if;end;
      begin perform public.approve_website_interview_summary(${scope},${q(summary)},s->>'summaryHash','too-early-approval',(i.agenda->>'revision')::bigint,i.db_version,i.digest);raise exception 'stream_approval_before_recap';
      exception when others then if sqlerrm not like '%summary_not_fully_played%' then raise;end if;end;
    end $ordering$;
    do $parts$ declare part text;n integer:=0;begin
      for part in select jsonb_array_elements_text(${jq(parts)}) loop
        perform pg_temp.stream_test_say('GENERATE_FINAL_SUMMARY',part,'part-'||n,n);n:=n+1;
      end loop;
      perform pg_temp.stream_test_say('REQUEST_FINAL_APPROVAL',${q(approvalQuestion)},'approval');
    end $parts$;
    do $approval$ declare i public.website_interviews;s jsonb:=(select summary from stream_summary_case);a jsonb;begin
      i:=public.website_interview_current(${scope});
      begin perform public.approve_website_interview_summary(${scope},${q(summary)},s->>'summaryHash','too-early-approval',(i.agenda->>'revision')::bigint,i.db_version,i.digest);raise exception 'stream_early_owner_turn_approved';
      exception when others then if sqlerrm not like '%turn_not_after_question%' then raise;end if;end;
      perform public.record_website_interview_owner_turn(${scope},'mixed-approval','Sim, mas altere a área.');
      begin perform public.approve_website_interview_summary(${scope},${q(summary)},s->>'summaryHash','mixed-approval',(i.agenda->>'revision')::bigint,i.db_version,i.digest);raise exception 'stream_mixed_owner_turn_approved';
      exception when others then if sqlerrm not like '%not_strict_affirmation%' then raise;end if;end;
      perform public.record_website_interview_owner_turn(${scope},'stream-approval','Eu aprovo esta configuração.');
      a:=public.approve_website_interview_summary(${scope},${q(summary)},s->>'summaryHash','stream-approval',(i.agenda->>'revision')::bigint,i.db_version,i.digest);
      update stream_summary_case set approval=a;
      if a is distinct from public.approve_website_interview_summary(${scope},${q(summary)},s->>'summaryHash','stream-approval',(i.agenda->>'revision')::bigint,i.db_version,i.digest) then raise exception 'stream_approval_not_idempotent';end if;
    end $approval$;`;
  const execute=body=>runSql(`begin;set local request.jwt.claim.role='service_role';${prelude}${setup}${body}rollback;`);
  await runSql(`begin;set local request.jwt.claim.role='service_role';${prelude}${completeQueue}
    do $resume$ declare i public.website_interviews;interview uuid;before_agenda jsonb;got jsonb;next_call uuid:='9d000000-0000-4000-8000-000000000021';next_request uuid:='9d000000-0000-4000-8000-000000000022';
      final_call uuid:='9d000000-0000-4000-8000-000000000023';final_request uuid:='9d000000-0000-4000-8000-000000000024';begin
      i:=public.website_interview_current(${scope});interview:=i.interview_id;before_agenda:=i.agenda;
      update public.calls set status='ended',ended_at=clock_timestamp(),duration_seconds=0,openai_call_id='rtc_prior_review_fixture',provider_termination_state='confirmed',provider_termination_reason='fixture_review_paused',provider_usage_state='resolved',cost_estimate_usd=0 where id=${q(call)};
      update public.browser_session_requests set status='error',error='fixture_review_paused' where id=${q(request)};
      update public.budget_reservations set status='settled',outcome='ended',final_cost_usd=0,final_minutes=0,settled_at=clock_timestamp() where call_id=${q(call)};
      -- Model separate sequential starts inside this one rollback transaction.
      insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,provider_usage_state,started_at) values(next_call,${q(tenant)},'browser','onboarding','active',2,'not_applicable',clock_timestamp());
      if (select started_at from public.calls where id=${q(call)}) >= (select started_at from public.calls where id=next_call) then
        raise exception 'stream_fixture_call_chronology_invalid: %',jsonb_build_object('priorStartedAt',(select started_at from public.calls where id=${q(call)}),'nextStartedAt',(select started_at from public.calls where id=next_call));
      end if;
      insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version,test_memory_generation)
        values(next_request,${q(tenant)},${q(owner)},'onboarding','stream-review-resume','processing',next_call,'realtime_stream_v1',4,2);
      insert into public.budget_reservations(tenant_id,call_id,budget_day,reserved_cost_usd,reserved_minutes,status) values(${q(tenant)},next_call,current_date,7.5,55,'active');
      perform public.resolve_prepared_website_source(${q(owner)},next_call,next_request);
      got:=public.attach_website_interview(${q(owner)},next_call,next_request,interview,${q(call)});
      if got->>'state'<>'reviewing' or got->'agenda'->'ownerTurns'<>before_agenda->'ownerTurns' or got->'nextAction'->>'type'<>'GENERATE_FINAL_SUMMARY' then raise exception 'stream_review_resume_lost_agenda';end if;
      update public.calls set status='error',ended_at=clock_timestamp(),duration_seconds=0,provider_termination_state='not_required',provider_termination_reason='realtime_unavailable',provider_usage_state='not_applicable',cost_estimate_usd=0 where id=next_call;
      update public.browser_session_requests set status='error',error='realtime_unavailable' where id=next_request;
      update public.budget_reservations set status='settled',outcome='startup_error',final_cost_usd=0,final_minutes=0,settled_at=clock_timestamp() where call_id=next_call;
      if not public.website_interview_prior_settled(${q(tenant)},${q(owner)},next_call,2) or not public.website_interview_resume_eligible(interview,${q(owner)},false) then raise exception 'stream_review_zero_rejection_stranded';end if;
      insert into public.calls(id,tenant_id,channel,session_type,status,test_memory_generation,provider_usage_state,started_at) values(final_call,${q(tenant)},'browser','onboarding','active',2,'not_applicable',clock_timestamp());
      if (select started_at from public.calls where id=next_call) >= (select started_at from public.calls where id=final_call) then
        raise exception 'stream_fixture_call_chronology_invalid: %',jsonb_build_object('priorStartedAt',(select started_at from public.calls where id=next_call),'nextStartedAt',(select started_at from public.calls where id=final_call));
      end if;
      insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version,test_memory_generation)
        values(final_request,${q(tenant)},${q(owner)},'onboarding','stream-review-retry','processing',final_call,'realtime_stream_v1',4,2);
      perform public.resolve_prepared_website_source(${q(owner)},final_call,final_request);
      got:=public.attach_website_interview(${q(owner)},final_call,final_request,interview,next_call);
      if got->>'state'<>'reviewing' or got->'agenda'->'ownerTurns'<>before_agenda->'ownerTurns' or exists(select 1 from public.website_interview_approvals where interview_id=interview) then raise exception 'stream_review_retry_changed_owner_authority';end if;
    end $resume$;rollback;`);
  await execute(`select pg_temp.stream_test_say('SPEAK_FINAL_SIGNOFF',${q(signoff)},'final-signoff');
    do $not_terminal$ begin begin perform public.record_website_interview_completion(${scope},'complete',(select (approval->>'approvalReceiptId')::uuid from stream_summary_case));raise exception 'stream_unclosed_call_completed';
      exception when others then if sqlerrm not like '%terminal_proof_pending%' then raise;end if;end;end $not_terminal$;
    update public.calls set status='ended',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='agent_ended_session',provider_usage_state='resolved',cost_estimate_usd=0.25 where id=${q(call)};
    update public.budget_reservations set status='settled',outcome='ended',final_cost_usd=0.25,final_minutes=1,settled_at=clock_timestamp() where call_id=${q(call)};
    do $completed$ declare r jsonb;begin
      r:=public.record_website_interview_completion(${scope},'complete',(select (approval->>'approvalReceiptId')::uuid from stream_summary_case));
      if r->>'outcome'<>'complete' or r->'providerConfirmed'<>'true'::jsonb or r->'budgetSettled'<>'true'::jsonb then raise exception 'stream_terminal_proof_incomplete';end if;
      if exists(select 1 from public.rules where tenant_id=${q(tenant)}) or exists(select 1 from public.powers where tenant_id=${q(tenant)}) then raise exception 'stream_granted_operating_authority';end if;
    end $completed$;`);
  await execute(`do $amendment$ declare i public.website_interviews;a jsonb:=(select approval from stream_summary_case);before_snapshot jsonb;proposal jsonb;act jsonb;stream jsonb;begin
    i:=public.website_interview_current(${scope});select finalized_draft into before_snapshot from public.website_interview_approvals where interview_id=i.interview_id;
    act:=jsonb_build_object('actionId',repeat('a',64),'interviewId',i.interview_id,'callId',${q(call)},'revision',i.agenda->'revision','kind','SPEAK_FINAL_SIGNOFF','text',${q(signoff)},'sourceDigest',i.digest);
    stream:=public.claim_website_interview_stream(${scope},act,${q(summary)},null,null);
    perform public.authorize_website_interview_stream(${scope},act->>'actionId',(stream->>'dispatchId')::uuid);
    perform public.record_website_interview_owner_turn(${scope},'late-correction','Espera, corrija a área antes de concluir.');
    proposal:=jsonb_build_object('kind','correction','affectedItems',jsonb_build_array(jsonb_build_object('itemId',i.agenda->'items'->0->>'id','disposition','reopen')));
    perform public.request_website_interview_amendment(${scope},(a->>'approvalReceiptId')::uuid,'late-correction',proposal);
    begin perform public.record_website_interview_stream_response(${scope},act->>'actionId',(stream->>'dispatchId')::uuid,'late-signoff','late-signoff-item',${q(signoff)},'completed');raise exception 'stream_amendment_admitted_late_signoff';
    exception when others then if sqlerrm not like '%stream_not_current%' then raise;end if;end;
    if (select finalized_draft from public.website_interview_approvals where interview_id=i.interview_id) is distinct from before_snapshot then raise exception 'stream_amendment_changed_approved_snapshot';end if;
    begin perform public.record_website_interview_completion(${scope},'complete',(a->>'approvalReceiptId')::uuid);raise exception 'stream_amendment_completed';
    exception when others then if sqlerrm not like '%amendment_pending%' then raise;end if;end;
  end $amendment$;`);
  return {scenarios:['stream-reviewing-resume-and-zero-provider-rejection-preserve-all-owner-history','stream-current-summary-order-fresh-explicit-approval-signoff-terminal-budget','stream-closing-correction-preserves-approved-snapshot-and-blocks-late-signoff'],summaryParts:parts.length,providerCalls:0};
}
