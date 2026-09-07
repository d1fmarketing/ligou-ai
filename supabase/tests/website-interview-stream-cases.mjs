// Shared rollback-only checks for the isolated PG16 and complete PG17 schema.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeWebsiteStreamTranscript} from '../../voice-controller/src/onboarding-stream.ts';
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const jq=value=>`${q(JSON.stringify(value))}::jsonb`;
const otherDispatch='99999999-9999-4999-8999-999999999999';
export async function runWebsiteStreamCases({runSql,owner,other,tenant,call,request,prelude=''}) {
  const scenarios=[];
  const scope=`${q(owner)},${q(call)},${q(request)}`;
  const action=`(select descriptor->'action'->>'actionId' from website_stream_case)`;
  const dispatch=`(select (descriptor->>'dispatchId')::uuid from website_stream_case)`;
  const transcript=`(select descriptor->'action'->>'text' from website_stream_case)`;
  const media={schema:'onboarding.stream.media.v1',nonzeroSamples:32,observedMs:1500,firstSampleAtMs:100,lastSampleAtMs:1600,unmuted:true,playbackStarted:true};
  const response=(text=transcript,responseId='response-current',itemId='assistant-current',status='completed')=>
    `public.record_website_interview_stream_response(${scope},${action},${dispatch},${q(responseId)},${q(itemId)},${text},${q(status)})`;
  const playout=(evidence=media,responseId='response-current',itemId='assistant-current',eventId='buffer-stopped-current')=>
    `public.record_website_interview_stream_playout(${scope},${action},${dispatch},${q(responseId)},${q(itemId)},${q(eventId)},${evidence===null?'null':jq(evidence)})`;
  const authorize=`public.authorize_website_interview_stream(${scope},${action},${dispatch})`;
  const setup=({started=true,provider=true,published=true}={})=>`
    create temporary table website_stream_case(descriptor jsonb) on commit drop;
    do $setup$ declare i public.website_interviews; spoken text; act jsonb; authz jsonb; begin
      i:=public.website_interview_current(${scope});
      select 'Oi! Aqui é o Ligou, agente de inteligência artificial da '||name||'. Eu já analisei seu website. '||(i.next_action->>'spokenPt') into spoken from public.tenants where id=${q(tenant)};
      act:=jsonb_build_object('actionId',encode(extensions.digest(public.onboarding_canonical_json_v1(jsonb_build_array(i.next_action->>'actionId','opening',spoken)),'sha256'),'hex'),
        'interviewId',i.interview_id,'callId',${q(call)},'revision',(i.agenda->>'revision')::bigint,'kind','ASK_NEXT_GAP','text',spoken,'sourceDigest',i.digest);
      authz:=public.claim_website_interview_stream(${scope},act);
      if authz is distinct from public.claim_website_interview_stream(${scope},act) then raise exception 'stream_claim_not_idempotent'; end if;
      if authz-array['schema','action','dispatchId','receiptId']<>'{}'::jsonb or authz->>'schema'<>'onboarding.stream.v1'
        or authz->'action'<>act or authz->>'dispatchId' is null or authz->>'receiptId' is null then raise exception 'stream_descriptor_invalid'; end if;
      insert into website_stream_case values(authz);
      ${published?`update public.browser_session_requests set status='ready',answer_sdp='isolated-stream-answer',opening_mode_applied='realtime_stream_v1',opening_payload=jsonb_build_object('version',4,'stream',authz) where id=${q(request)};`:''}
    end $setup$;
    ${provider?`update public.calls set openai_call_id='rtc_isolated_stream',provider_termination_state='active',provider_usage_state='unknown' where id=${q(call)};`:''}
    ${started?`select ${authorize};`:''}`;
  const inspect=async(body,options)=>runSql(`begin;set local request.jwt.claim.role='service_role';${prelude}${setup(options)}${body}rollback;`);
  const reject=async(name,body,pattern,options)=>{await assert.rejects(()=>inspect(body,options),pattern,name);scenarios.push(name);};
  const prove=async(name,body,options)=>{await inspect(body,options);scenarios.push(name);};
  const fixtures=JSON.parse(await readFile(new URL('../../voice-controller/test/fixtures/website-stream-transcript-cases.json',import.meta.url),'utf8'));
  for(const entry of fixtures){
    const got=JSON.parse(await runSql(`select jsonb_build_object('matches',public.website_stream_transcript_matches(${q(entry.expected)},${q(entry.actual)}),'expected',public.website_stream_transcript_normalize(${q(entry.expected)}),'actual',public.website_stream_transcript_normalize(${q(entry.actual)}));`));
    assert.equal(got.matches,entry.valid,entry.name);
    assert.equal(got.expected,normalizeWebsiteStreamTranscript(entry.expected),entry.name);
    assert.equal(got.actual,normalizeWebsiteStreamTranscript(entry.actual),entry.name);
  }
  scenarios.push(`stream-transcript-${fixtures.length}-case-sql-ts-parity`);
  for(const text of ['東京 e São Paulo.','Αθήνα e Recife.','Łódź e Recife.','Recife 😀 e Olinda.'])
    assert.equal(JSON.parse(await runSql(`select to_jsonb(public.website_stream_transcript_normalize(${q(text)}));`)),normalizeWebsiteStreamTranscript(text),'Unicode names remain evidence');
  scenarios.push('stream-unicode-names-and-numeric-tokens-preserved');
  for(const first of ['response','playout'])await prove(`stream-${first}-first-joins-only-two-valid-proofs`, `
    do $proof$ declare a jsonb; b jsonb; s public.website_interview_speech; begin
      a:=${first==='response'?response():playout()};
      if a->>'status' is distinct from '${first==='response'?'ready':'preparing'}' or a ? 'receiptId' then raise exception 'stream_premature_played'; end if;
      b:=${first==='response'?playout():response()};
      if b->>'status' is distinct from 'played' or b->>'receiptId' is null or b->>'generationReceiptId' is null or b->>'playoutReceiptId' is null
        or b->>'receiptId'=b->>'generationReceiptId' or b->>'receiptId'=b->>'playoutReceiptId' or b->>'generationReceiptId'=b->>'playoutReceiptId' then raise exception 'stream_proofs_not_distinct'; end if;
      if b is distinct from ${response()} or b is distinct from ${playout()} then raise exception 'stream_duplicate_changed_proof'; end if;
      select * into s from public.website_interview_speech where call_id=${q(call)} and action_id=${action};
      if s.payload is not null or s.played_at is null or s.stream_generation_status<>'completed' then raise exception 'stream_fabricated_mp3_or_playback'; end if;
      if exists(select 1 from public.website_interview_approvals where call_id=${q(call)}) then raise exception 'stream_fabricated_approval'; end if;
    end $proof$;`);
  await reject('stream-dispatch-start-is-one-time',`select ${authorize};`,/dispatch_already_started/);
  await reject('stream-response-before-start-rejected',`select ${response()};`,/stream_not_current/,{started:false});
  await reject('stream-playout-before-start-rejected',`select ${playout()};`,/stream_not_current/,{started:false});
  await reject('stream-row-cannot-claim-ready-without-generation',`update public.website_interview_speech set status='ready' where call_id=${q(call)};`,/website_stream_progress_proof/,{started:false});
  await reject('stream-row-cannot-claim-played-without-joined-receipts',`update public.website_interview_speech set status='played' where call_id=${q(call)};`,/website_stream_progress_proof/,{started:false});
  await reject('stream-no-provider-cannot-start',`select ${authorize};`,/provider_not_active/,{started:false,provider:false});
  await reject('stream-settled-budget-cannot-start',`update public.budget_reservations set status='settled',outcome='ended',final_cost_usd=0,final_minutes=0,settled_at=clock_timestamp() where call_id=${q(call)};select ${authorize};`,/provider_not_active/,{started:false});
  await reject('stream-wrong-owner-cannot-start',`select public.authorize_website_interview_stream(${q(other)},${q(call)},${q(request)},${action},${dispatch});`,/not_owner_bound/,{started:false});
  await reject('stream-wrong-request-cannot-start',`select public.authorize_website_interview_stream(${q(owner)},${q(call)},${q(otherDispatch)},${action},${dispatch});`,/not_owner_bound/,{started:false});
  await reject('stream-stale-dispatch-cannot-start',`select public.authorize_website_interview_stream(${scope},${action},${q(otherDispatch)});`,/stream_not_current/,{started:false});
  await reject('stream-generation-change-cannot-start',`update public.tenants set test_memory_generation=test_memory_generation+1 where id=${q(tenant)};select ${authorize};`,/not_owner_bound/,{started:false});
  await reject('stream-source-change-cannot-start',`update public.website_interview_preparations set draft_hash=repeat('f',64) where id=(select preparation_id from public.website_interviews where current_call_id=${q(call)});select ${authorize};`,/source_not_current/,{started:false});
  await reject('stream-cancelled-browser-cannot-start',`update public.browser_session_requests set status='cancel_requested' where id=${q(request)};select ${authorize};`,/not_owner_bound/,{started:false});
  await reject('stream-mode-cannot-omit-protocol',`insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,opening_mode_requested,onboarding_protocol_version,test_memory_generation)
    values('9e000000-0000-4000-8000-000000000001',${q(tenant)},${q(owner)},'onboarding','missing-protocol-fixture','pending','realtime_stream_v1',null,2);`,/application_opening_scope_check/,{started:false});
  await reject('stream-wrong-response-after-generation-rejected',`select ${response()};select ${playout(media,'wrong-response')};`,/playout_response_mismatch/);
  await reject('stream-conflicting-generation-rejected',`select ${response()};select ${response(transcript,'second-response')};`,/generation_conflict/);
  await reject('stream-conflicting-playout-rejected',`select ${playout()};select ${playout({...media,nonzeroSamples:64})};`,/playout_conflict/);
  for(const status of ['failed','cancelled','incomplete'])await reject(`stream-${status}-generation-cannot-prove-playback`,`select ${response(transcript,'response-current','assistant-current',status)};`,/generation_invalid/);
  for(const key of Object.keys(media)){
    const changed={...media};delete changed[key];
    await reject(`stream-playout-missing-${key}-rejected`,`select ${playout(changed)};`,/playout_invalid/);
  }
  for(const changed of [{...media,nonzeroSamples:0},{...media,nonzeroSamples:1.2},{...media,nonzeroSamples:9007199254740992},
    {...media,unmuted:false},{...media,playbackStarted:false},{...media,lastSampleAtMs:99},{...media,observedMs:180001},{...media,cleared:true},null])
    await reject('stream-invalid-or-cleared-media-rejected',`select ${playout(changed)};`,/playout_invalid/);
  await reject('stream-legacy-null-hash-ACK-cannot-play',`select ${response()};select public.record_website_interview_speech_played(${scope},${action},'lgs-'||left(${action},28),${transcript},null,null);`,/mp3_transport_mismatch/);
  await reject('stream-cannot-enter-MP3-generation',`select public.complete_website_interview_speech(${scope},${action},'{}');`,/mp3_transport_mismatch/);
  await reject('stream-cannot-use-MP3-resume',`select public.resume_website_interview_speech(${scope},${action},'owner-input');`,/mp3_transport_mismatch/);
  await prove('stream-transcript-mismatch-is-technical-and-new-dispatch-reread-is-bounded',`
    do $retry$ declare r jsonb; next jsonb; n integer; original text:=${action}; begin
      for n in 0..2 loop
        r:=public.record_website_interview_stream_response(${scope},${action},${dispatch},'rejected-'||n,'rejected-item-'||n,'Texto com decisão inventada.','completed');
        if r->>'status'<>'rejected' or r->>'reason'<>'transcript_mismatch' or r ? 'receiptId' then raise exception 'stream_mismatch_fabricated_playback'; end if;
        if exists(select 1 from public.website_interview_owner_turns where call_id=${q(call)}) then raise exception 'stream_retry_invented_owner_input'; end if;
        if n<2 then
          next:=public.resume_website_interview_stream(${scope},${action},null);
          if next->>'dispatchId'=(select descriptor->>'dispatchId' from website_stream_case) or next->'action'->>'actionId'=${action} then raise exception 'stream_retry_reused_dispatch'; end if;
          if next->'action'->>'text' like 'Oi!%' then raise exception 'stream_retry_repeated_opening_intro'; end if;
          update website_stream_case set descriptor=next;
          perform ${authorize};
        else
          begin perform public.resume_website_interview_stream(${scope},${action},null);raise exception 'stream_retry_bound_not_enforced';
          exception when others then if sqlerrm not like '%resume_exhausted%' then raise; end if;end;
        end if;
      end loop;
      if (select count(*) from public.website_interview_speech where call_id=${q(call)} and status='played')<>0 then raise exception 'stream_rejected_speech_played'; end if;
    end $retry$;`);
  await reject('stream-retry-without-rejected-generation-blocked',`select public.resume_website_interview_stream(${scope},${action},null);`,/retry_requires_rejection/);
  await prove('stream-mismatched-playout-first-cannot-join-provider-proof',`
    select ${playout(media,'wrong-first-response')};
    do $mismatch$ declare r jsonb;begin r:=${response()};
      if r->>'status'<>'ready' or r ? 'receiptId' or r->>'generationReceiptId' is null then raise exception 'stream_mismatched_ids_played';end if;
    end $mismatch$;`);
  await reject('stream-current-digest-change-rejects-late-proof',`update public.website_interviews set digest=repeat('e',64) where current_call_id=${q(call)};select ${response()};`,/stream_not_current/);
  await prove('stream-opening-wire-contract-requires-every-transport-field',`
    do $shape$ declare e jsonb:=jsonb_build_object('version',4,'stream',(select descriptor from website_stream_case));k text;begin
      if not public.website_browser_opening_v4_valid(e,${q(call)}) then raise exception 'stream_valid_opening_rejected';end if;
      foreach k in array array['schema','action','dispatchId','receiptId'] loop
        if public.website_browser_opening_v4_valid(jsonb_set(e,'{stream}',(e->'stream')-k),${q(call)}) then raise exception 'stream_missing_descriptor_field:%',k;end if;
        if public.website_browser_opening_v4_valid(jsonb_set(e,array['stream',k],'null'::jsonb),${q(call)}) then raise exception 'stream_null_descriptor_field:%',k;end if;
      end loop;
      foreach k in array array['actionId','interviewId','callId','revision','kind','text','sourceDigest'] loop
        if public.website_browser_opening_v4_valid(jsonb_set(e,'{stream,action}',(e->'stream'->'action')-k),${q(call)}) then raise exception 'stream_missing_action_field:%',k;end if;
      end loop;
      if public.website_browser_opening_v4_valid(e||'{"audio_base64":"fake"}'::jsonb,${q(call)})
        or public.website_browser_opening_v4_valid(jsonb_set(e,'{stream,action,callId}',to_jsonb(${q(other)}::text)),${q(call)}) then raise exception 'stream_extra_or_foreign_opening_accepted';end if;
    end $shape$;`,{started:false});
  await prove('stream-ready-cancellation-preserves-identity-until-expired',`
    update public.browser_session_requests set status='cancel_requested' where id=${q(request)};
    update public.browser_session_requests set status='expired',answer_sdp=null,opening_mode_applied=null,opening_payload=null where id=${q(request)};
    do $cancel$ begin if not exists(select 1 from public.browser_session_requests where id=${q(request)} and call_id=${q(call)} and onboarding_protocol_version=4 and status='expired') then raise exception 'stream_cancel_lost_identity';end if;end $cancel$;`,{started:false});
  const rejectedStartup=`update public.calls set status='error',ended_at=clock_timestamp(),duration_seconds=0,
    provider_termination_state='not_required',provider_termination_reason='realtime_unavailable',provider_termination_mode=null,
    openai_call_id=null,provider_termination_attempt_id=null,provider_termination_request_id=null,provider_termination_attempted_at=null,
    provider_terminated_at=null,provider_usage_state='not_applicable',cost_estimate_usd=0,transcript='[]' where id=${q(call)};
    update public.browser_session_requests set status='error',error='realtime_unavailable',answer_sdp=null,opening_mode_applied=null,opening_payload=null where id=${q(request)};
    update public.budget_reservations set status='settled',outcome='startup_error',final_cost_usd=0,final_minutes=0,settled_at=clock_timestamp() where call_id=${q(call)};`;
  const prior=`public.website_interview_prior_settled(${q(tenant)},${q(owner)},${q(call)},2)`;
  await prove('stream-definitive-zero-cost-rejection-preserves-resume',`${rejectedStartup}
    do $zero$ begin if not ${prior} then raise exception 'stream_zero_rejection_not_resumable';end if;end $zero$;`,{started:false,provider:false,published:false});
  await prove('stream-rejection-cannot-invent-TTS-cost',`${rejectedStartup}
    update public.calls set provider_usage_state='resolved',cost_estimate_usd=0.01 where id=${q(call)};
    update public.budget_reservations set final_cost_usd=0.01 where call_id=${q(call)};
    do $zero$ begin if ${prior} then raise exception 'stream_fake_tts_cost_resumable';end if;end $zero$;`,{started:false,provider:false,published:false});
  await prove('stream-consumed-dispatch-cannot-claim-no-provider-recovery',`${rejectedStartup}
    update public.website_interview_speech set stream_dispatch_started_at=clock_timestamp() where call_id=${q(call)};
    do $zero$ begin if ${prior} then raise exception 'stream_consumed_dispatch_resumable_as_rejection';end if;end $zero$;`,{started:false,provider:false,published:false});
  await prove('stream-rejection-resume-requires-the-exact-saved-store-version',`${rejectedStartup}
    update public.website_interviews set db_version=db_version+1 where current_call_id=${q(call)};
    do $zero$ begin if ${prior} then raise exception 'stream_changed_store_version_resumable';end if;end $zero$;`,{started:false,provider:false,published:false});
  await prove('stream-interruption-requires-final-owner-evidence-and-retires-old-response',`
    select public.interrupt_website_interview_speech(${scope},${action},'owner-barge');
    do $interrupted$ declare next jsonb; old_action text:=${action};old_dispatch uuid:=${dispatch};begin
      begin perform public.resume_website_interview_stream(${scope},old_action,'owner-barge');raise exception 'stream_unfinished_owner_input_resumed';
      exception when others then if sqlerrm not like '%owner_turn_pending%' then raise; end if;end;
      perform public.record_website_interview_empty_input(${scope},old_action,'owner-barge');
      next:=public.resume_website_interview_stream(${scope},old_action,'owner-barge');
      if next is distinct from public.resume_website_interview_stream(${scope},old_action,'owner-barge') then raise exception 'stream_resume_not_idempotent'; end if;
      if next->>'dispatchId'=old_dispatch::text or next->'action'->>'text' like 'Oi!%' then raise exception 'stream_resume_reused_old_audio_authority';end if;
      begin perform ${response()};raise exception 'stream_late_old_generation_admitted';
      exception when others then if sqlerrm not like '%stream_not_current%' then raise; end if;end;
      begin perform ${playout()};raise exception 'stream_late_old_playout_admitted';
      exception when others then if sqlerrm not like '%stream_not_current%' then raise; end if;end;
    end $interrupted$;`);
  await prove('stream-authenticated-read-and-RPC-ACL-isolation',`
    grant select on website_stream_case to authenticated;
    set local role authenticated;set local request.jwt.claim.role='authenticated';set local request.jwt.claim.sub=${q(owner)};
    do $read$ begin
      if public.read_website_interview_stream(${q(call)},${action},${dispatch}) is distinct from (select descriptor from website_stream_case) then raise exception 'stream_read_descriptor_changed';end if;
      begin perform ${authorize};raise exception 'stream_authenticated_wrote_authority';
      exception when insufficient_privilege then null;end;
    end $read$;
    set local request.jwt.claim.sub=${q(other)};
    do $other$ begin begin perform public.read_website_interview_stream(${q(call)},${action},${dispatch});raise exception 'stream_foreign_owner_read';exception when insufficient_privilege then null;end;end $other$;
    reset role;set local request.jwt.claim.role='service_role';`);
  return {scenarios,transcriptCases:fixtures.length,providerCalls:0};
}
