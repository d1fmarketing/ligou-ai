// Transactional production-schema probe. The caller supplies its already prepared
// summary; every synthetic owner event and rendition is rolled back afterward.
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const jq=value=>`${q(JSON.stringify(value))}::jsonb`;
export async function runWebsiteInterruptionActualSchemaProbe({runSql,owner,call,request,summaryId,parts,revision,digest,interviewId=call}) {
  if(!parts?.[0])throw new Error('prepared summary part required');
  const action={actionId:sha([call,summaryId,'actual-interruption-probe']),interviewId,callId:call,revision,kind:'GENERATE_FINAL_SUMMARY',text:parts[0],sourceDigest:digest};
  const payload={schema:'onboarding.speech.v1',...action,text_sha256:sha(action.text),audio_base64:'SUQzBA==',audio_sha256:createHash('sha256').update(Buffer.from('SUQzBA==','base64')).digest('hex'),mime:'audio/mpeg',voice:'ash',tts_model:'tts-1-hd',cost_usd:Number(([...action.text].length*30/1000000).toFixed(8))};
  const scope=[owner,call,request].map(q).join(',');
  await runSql(`begin; set local role service_role; set local request.jwt.claim.role='service_role';
    do $probe$ declare v_original jsonb; v_interrupt jsonb; v_resume jsonb; v_replay jsonb; v_played jsonb; v_empty jsonb; begin
      v_original:=public.read_website_interview(${scope});
      perform public.claim_website_interview_speech(${scope},${jq(action)},${q(summaryId)},0,null);
      perform public.complete_website_interview_speech(${scope},${q(action.actionId)},${jq(payload)});
      v_interrupt:=public.interrupt_website_interview_speech(${scope},${q(action.actionId)},'actual-summary-interruption');
      if v_interrupt->>'status'<>'superseded' or v_interrupt->>'providerItemId'<>'actual-summary-interruption' then raise exception 'actual_interruption_proof_mismatch'; end if;
      begin
        perform public.record_website_interview_speech_played(${scope},${q(action.actionId)},${q(`lgs-${action.actionId.slice(0,28)}`)},${q(action.text)},${q(payload.text_sha256)},${q(payload.audio_sha256)});
        raise exception 'actual_stale_ack_was_accepted';
      exception when others then if sqlerrm not like '%interview_speech_not_ready%' then raise; end if; end;
      begin
        perform public.resume_website_interview_speech(${scope},${q(action.actionId)},'actual-summary-interruption');
        raise exception 'actual_resume_without_turn_was_accepted';
      exception when others then if sqlerrm not like '%interview_interruption_owner_turn_pending%' then raise; end if; end;
      perform public.record_website_interview_owner_turn(${scope},'actual-summary-interruption','Ah, entendi. Pode continuar.');
      v_resume:=public.resume_website_interview_speech(${scope},${q(action.actionId)},'actual-summary-interruption');
      v_replay:=public.resume_website_interview_speech(${scope},${q(action.actionId)},'actual-summary-interruption');
      if v_resume->>'status'<>'ready' or v_resume->'claimed'<>'false'::jsonb or v_resume->'action'->>'actionId'=${q(action.actionId)}
        or v_resume->'action'->>'text'<>${q(action.text)} or v_resume->'payload'->>'audio_sha256'<>${q(payload.audio_sha256)} or v_resume<>v_replay then raise exception 'actual_resumed_payload_or_idempotency_mismatch'; end if;
      perform public.interrupt_website_interview_speech(${scope},v_resume->'action'->>'actionId','actual-empty-interruption');
      v_empty:=public.record_website_interview_empty_input(${scope},v_resume->'action'->>'actionId','actual-empty-interruption');
      if v_empty->>'receiptId' is null or exists(select 1 from public.website_interview_owner_turns where call_id=${q(call)} and provider_item_id='actual-empty-interruption') then raise exception 'actual_empty_input_fabricated_owner_words'; end if;
      v_resume:=public.resume_website_interview_speech(${scope},v_resume->'action'->>'actionId','actual-empty-interruption');
      if v_resume->'rendition'<>'2'::jsonb or v_resume->>'status'<>'ready' or v_resume->'claimed'<>'false'::jsonb then raise exception 'actual_empty_input_resume_mismatch'; end if;
      v_played:=public.record_website_interview_speech_played(${scope},v_resume->'action'->>'actionId','lgs-'||left(v_resume->'action'->>'actionId',28),${q(action.text)},${q(payload.text_sha256)},${q(payload.audio_sha256)});
      if v_played->>'receiptId' is null then raise exception 'actual_resumed_playback_receipt_missing'; end if;
      if (public.read_website_interview(${scope})->'agenda') is distinct from v_original->'agenda' then raise exception 'actual_interruption_mutated_agenda'; end if;
      if exists(select 1 from public.website_interview_approvals where interview_id=${q(interviewId)}) then raise exception 'actual_ack_created_approval'; end if;
    end $probe$;
    rollback;`);
  return {scenarios:['actual-schema-summary-interruption','actual-schema-old-ack-rejection','actual-schema-resume-requires-final-input-proof','actual-schema-cached-rendition-idempotency','actual-schema-empty-input-without-owner-words','actual-schema-resumed-playback-receipt','actual-schema-ack-preserves-agenda-and-approval-boundary'],providerCalls:0,rolledBack:true};
}
