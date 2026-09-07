import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingAgendaStore} from '../../voice-controller/src/onboarding-agenda-store.ts';
import {createInterviewEvidenceStore} from '../../voice-controller/src/onboarding-interview-evidence-store.ts';
import {createWebsiteInterviewRuntime,prepareWebsiteStreamOpening} from '../../voice-controller/src/onboarding-website-runtime.ts';
import {getAgendaAction} from '../../voice-controller/src/onboarding-agenda.ts';
import {streamControlId} from '../../voice-controller/src/onboarding-stream.ts';

const q=value=>`'${String(value).replaceAll("'","''")}'`;
const jq=value=>`${q(JSON.stringify(value))}::jsonb`;

// Actual runtime/store/RPC calls against the disposable production-shaped DB.
// Provider generation and browser media evidence below are explicit simulations;
// this does not claim a real voice/audio test. Old completed evidence is retained.
export async function runWebsiteStreamRuntimeActualSchemaProbe({runSql,rpc,owner,other,tenant,priorCall,source,initialAgenda,projection}){
  const call=randomUUID(),request=randomUUID(),preparation=randomUUID(),scope={ownerId:owner,callId:call,requestId:request};
  let callCreated=false,reserved=false,runtime,lostPlayout=false,playoutInvocations=0;
  const sent=[],transcripts=[],diagnostics=[],invocations=[];
  const client={rpc:async(name,args)=>{
    invocations.push({name,args});
    try{
      const data=await rpc(name,args);
      if(name==='record_website_interview_stream_playout'){
        playoutInvocations++;
        if(!lostPlayout){lostPlayout=true;return{data:null,error:{message:'synthetic response lost after real SQL COMMIT',code:'08006'}};}
      }
      return{data,error:null};
    }catch(error){return{data:null,error:{message:error.message,code:error.code}};}
  }};
  const store=createOnboardingAgendaStore(client),evidence=createInterviewEvidenceStore(client);
  const preservedState=()=>runSql(`select jsonb_build_object(
    'draft',(select to_jsonb(d) from public.company_discovery_onboarding_drafts d where id=${q(source.draftId)}),
    'result',(select to_jsonb(r) from public.worker_results r where id=${q(source.sourceResultId)}),
    'job',(select to_jsonb(j) from public.worker_jobs j where id=${q(projection.provenance.sourceJobId)}),
    'attempt',(select to_jsonb(a) from public.worker_attempts a where id=${q(projection.provenance.sourceAttemptId)}),
    'rules',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from public.rules r where tenant_id=${q(tenant)}),
    'powers',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.powers p where tenant_id=${q(tenant)}),
    'tenantAuthority',(select jsonb_build_array(status,operational_mode,test_memory_generation,auth_epoch,policy_epoch) from public.tenants where id=${q(tenant)}));`);
  const sourceBefore=await preservedState();
  try{
    await store.prepareFreshWebsiteInterview({preparationId:preparation,ownerId:owner,expectedTenantId:tenant,expectedGeneration:2,priorCallId:priorCall,
      draftId:source.draftId,draftHash:source.draftHash,sourceResultId:source.sourceResultId,sourceResultHash:source.sourceResultHash});
    await runSql(`begin; insert into public.calls(id,tenant_id,channel,session_type,status,model,openai_call_id,provider_termination_state,provider_termination_mode,provider_usage_state,cost_estimate_usd)
      values(${q(call)},${q(tenant)},'browser','onboarding','active','gpt-realtime-2.1',${q('rtc_isolated_stream_'+call)},'active','hangup','unknown',0);
      insert into public.browser_session_requests(id,tenant_id,user_id,session_type,offer_sdp,status,call_id,opening_mode_requested,onboarding_protocol_version)
      values(${q(request)},${q(tenant)},${q(owner)},'onboarding','isolated-stream-offer','processing',${q(call)},'realtime_stream_v1',4);commit;`);
    callCreated=true;
    await rpc('reserve_call_budget',{p_tenant:tenant,p_call:call,p_est_cost:7.5,p_reserved_minutes:55});reserved=true;
    const agenda=structuredClone(initialAgenda);agenda.binding.callId=call;agenda.binding.interviewId=call;
    assert.equal(agenda.items.length,114);assert.equal(agenda.ownerTurns.length,0);
    const stored=await store.initializeWebsiteInterview({...scope,preparationId:preparation,agenda});
    const prepared={scope,stored,projection};
    const tenantName=JSON.parse(await runSql(`select to_jsonb(name) from public.tenants where id=${q(tenant)};`));
    const input=await prepareWebsiteStreamOpening(prepared,tenantName,{evidence});
    await runSql(`update public.browser_session_requests set status='ready',answer_sdp='isolated-stream-answer',opening_mode_applied='realtime_stream_v1',
      opening_payload=${jq({version:4,stream:input.openingStream})} where id=${q(request)};`);
    await assert.rejects(()=>evidence.authorizeStream({...scope,ownerId:other,stream:input.openingStream}),/owner_bound|owner|scope/);
    runtime=createWebsiteInterviewRuntime(input,{
      agendaStore:store,evidenceStore:evidence,synthesize:async()=>{throw new Error('No TTS permitted in stream actual-schema probe');},
      send:event=>sent.push(event),enqueue:async task=>task(),onTranscript:event=>transcripts.push(event),onCost:()=>{throw new Error('No TTS charge permitted');},
      onUsage:()=>{},onUsageUnknown:()=>{},onState:()=>{},onDiagnostic:event=>diagnostics.push(event),onTerminate:()=>{},
    });
    await runtime.attach();
    const control=(kind,stream,value)=>({type:'conversation.item.done',item:{id:streamControlId(kind,stream.dispatchId),type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_stream_${kind}:${JSON.stringify(value)}`}]}});
    async function speech(stream){
      await runtime.handleEvent(control('ready',stream,{actionId:stream.action.actionId,dispatchId:stream.dispatchId}));
      const frame=sent.filter(event=>event.type==='response.create'&&event.response.output_modalities[0]==='audio').at(-1);
      assert.ok(frame);assert.equal(frame.response.conversation,'none');assert.deepEqual(frame.response.tools,[]);
      const responseId='response-'+stream.dispatchId,itemId='item-'+stream.dispatchId;
      await runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
      await runtime.handleEvent({type:'response.output_item.added',response_id:responseId,output_index:0,item:{id:itemId,type:'message',role:'assistant',status:'in_progress',content:[]}});
      await runtime.handleEvent({type:'output_audio_buffer.started',response_id:responseId,event_id:'start-'+stream.dispatchId});
      await runtime.handleEvent({type:'response.output_audio_transcript.done',response_id:responseId,item_id:itemId,output_index:0,content_index:0,transcript:stream.action.text});
      await runtime.handleEvent({type:'response.done',response:{id:responseId,metadata:frame.response.metadata,status:'completed',output:[{id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'output_audio',transcript:stream.action.text}]}]}});
      await runtime.handleEvent({type:'output_audio_buffer.stopped',response_id:responseId,event_id:'server-stop-'+stream.dispatchId});
      await runtime.handleEvent(control('played',stream,{actionId:stream.action.actionId,dispatchId:stream.dispatchId,responseId,itemId,bufferStoppedEventId:'client-stop-'+stream.dispatchId,
        mediaEvidence:{schema:'onboarding.stream.media.v1',nonzeroSamples:100,observedMs:500,firstSampleAtMs:100,lastSampleAtMs:600,unmuted:true,playbackStarted:true}}));
      assert.equal(runtime.state.error,undefined,JSON.stringify(diagnostics));
    }
    async function answer(providerItemId,text,relatedItemIds=[],{directAcknowledgment=false}={}){
      const before=runtime.state.stored,sentBefore=sent.length,invocationsBefore=invocations.length;
      await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:providerItemId});
      await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:providerItemId,transcript:text});
      const textRequests=sent.slice(sentBefore).filter(event=>event.type==='response.create'&&event.response.output_modalities[0]==='text');
      assert.equal(textRequests.length,directAcknowledgment?0:1,JSON.stringify(diagnostics));
      if(directAcknowledgment){
        const durableAck=await store.readWebsiteInterview(scope),itemId=getAgendaAction(before.agenda).itemId;
        assert.deepEqual(durableAck.agenda,runtime.state.stored.agenda);assert.equal(durableAck.revision,before.revision+1);
        assert.equal(durableAck.receiptId,runtime.state.stored.receiptId);
        const item=durableAck.agenda.items.find(item=>item.id===itemId);
        assert.equal(item.status,'awaiting_clarification');assert.equal(item.answerRevision,0);
        assert.equal(durableAck.nextAction.itemId,itemId);assert.equal(runtime.state.speech.action.kind,'CLARIFY_CURRENT_GAP');
        const ownerTurn=JSON.parse(await runSql(`select jsonb_build_object('callId',call_id,'providerItemId',provider_item_id,'text',owner_text)
          from public.website_interview_owner_turns where call_id=${q(call)} and provider_item_id=${q(providerItemId)} and tenant_id=${q(tenant)};`));
        assert.deepEqual(ownerTurn,{callId:call,providerItemId,text});
        assert.deepEqual(item.evidence.at(-1),{turnId:call+':'+providerItemId,text});
        const receipt=JSON.parse(await runSql(`select jsonb_build_object('id',id,'payloadHash',payload_hash,'readback',readback,'detail',detail)
          from public.receipts where id=${q(durableAck.receiptId)} and tenant_id=${q(tenant)} and call_id=${q(call)} and kind='website_interview'
          and outcome='accepted' and external_id=${q('website-interview:'+call+':turn:'+providerItemId)};`));
        assert.equal(receipt.payloadHash,durableAck.digest);assert.deepEqual(receipt.readback.agenda,durableAck.agenda);
        assert.equal(receipt.detail.proposalKind,'clarification');assert.equal(receipt.detail.expectedDigest,before.digest);
        const work=invocations.slice(invocationsBefore),recordIndex=work.findIndex(({name,args})=>name==='record_website_interview_owner_turn'&&args.p_item===providerItemId);
        const commitIndex=work.findIndex(({name,args})=>name==='commit_website_interview_turn'&&args.p_item===providerItemId);
        const speechIndex=work.findIndex(({name})=>name==='claim_website_interview_stream');
        assert.ok(recordIndex>=0&&commitIndex>recordIndex&&speechIndex>commitIndex,'owner and agenda receipts precede subsequent speech claim');
        assert.equal(work[commitIndex].args.p_proposal_kind,'clarification');assert.deepEqual(work[commitIndex].args.p_facts,[]);
        assert.equal(sent.slice(sentBefore).some(event=>event.type==='response.create'),false,'no model or audio request before the durable ACK receipts are checked');
        assert.equal(runtime.state.error,undefined,JSON.stringify(diagnostics));
        return {interpreterRequests:0,ownerTurnId:call+':'+providerItemId,agendaReceiptId:durableAck.receiptId};
      }
      const frame=textRequests[0];
      const itemId=JSON.parse(frame.response.input[0].content[0].text).current_item_id;
      await runtime.handleEvent({type:'response.done',response:{id:'interpret-'+providerItemId,status:'completed',metadata:frame.response.metadata,
        output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',arguments:JSON.stringify({proposal:{kind:'answer',itemId,relatedItemIds},facts:[]})}]}});
      assert.equal(runtime.state.error,undefined,JSON.stringify(diagnostics));
      return {interpreterRequests:textRequests.length};
    }
    await speech(input.openingStream);assert.equal(runtime.state.phase,'awaiting_owner');
    const acknowledgment=await answer('stream-ack','Ah, entendi.',[],{directAcknowledgment:true});
    assert.equal(runtime.state.stored.agenda.items[0].status,'awaiting_clarification');
    await speech(runtime.state.speech.stream);
    const text='Hum, olha, atendi só novato, San Rafael e Petaluma, nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?';
    const beforeTerritory=runtime.state.stored;
    const territory=beforeTerritory.agenda.items.find(item=>item.coverageRefs.includes('area.coverage'));assert.ok(territory);
    assert.equal(getAgendaAction(beforeTerritory.agenda).itemId,territory.id);
    const related=territory.relatedItemIds.map(id=>beforeTerritory.agenda.items.find(item=>item.id===id));
    assert.equal(related.length,1);assert.ok(related[0]?.coverageRefs.some(ref=>ref.startsWith('discovery.owner_question.')));
    const territoryInterpretation=await answer('stream-territory',text,related.map(item=>item.id));
    const durable=await store.readWebsiteInterview(scope);
    assert.deepEqual(durable.agenda,runtime.state.stored.agenda);assert.equal(durable.digest,runtime.state.stored.digest);
    assert.equal(durable.receiptId,runtime.state.stored.receiptId);assert.equal(durable.revision,2);
    const answeredIds=[territory.id,...related.map(item=>item.id)],turn={turnId:call+':stream-territory',text};
    for(const id of answeredIds){
      const item=durable.agenda.items.find(item=>item.id===id);
      assert.equal(item.status,'answered');assert.equal(item.answerRevision,1);assert.deepEqual(item.evidence.at(-1),turn);
    }
    for(const item of durable.agenda.items.filter(item=>!answeredIds.includes(item.id)))
      assert.deepEqual(item,beforeTerritory.agenda.items.find(before=>before.id===item.id),'unrelated policy/authority item unchanged');
    assert.deepEqual(durable.agenda.ownerTurns.at(-1),turn);
    const next=getAgendaAction(durable.agenda);assert.match(next.questionPt,/fuso horário oficial/);
    assert.equal(durable.nextAction.itemId,next.itemId);assert.equal(runtime.state.speech.action.kind,'CONFIRM_AND_ASK_NEXT');
    assert.equal(runtime.state.approval,undefined);assert.equal(runtime.state.stored.state,'unfinished');
    const commitReceipt=JSON.parse(await runSql(`select jsonb_build_object('id',id,'payloadHash',payload_hash,'readback',readback,'detail',detail)
      from public.receipts where id=${q(durable.receiptId)} and tenant_id=${q(tenant)} and call_id=${q(call)} and kind='website_interview'
      and outcome='accepted' and external_id=${q('website-interview:'+call+':turn:stream-territory')};`));
    assert.equal(commitReceipt.payloadHash,durable.digest);assert.deepEqual(commitReceipt.readback.agenda,durable.agenda);
    assert.equal(commitReceipt.detail.proposalKind,'answer');assert.equal(commitReceipt.detail.expectedDigest,beforeTerritory.digest);
    assert.equal(commitReceipt.detail.expectedStoreVersion,beforeTerritory.storeVersion);
    assert.equal(commitReceipt.detail.dbVersion,durable.storeVersion);
    const facts=JSON.parse(await runSql(`select jsonb_build_object('receiptId',agenda_receipt_id,'ownerText',owner_text,'refs',coverage_refs,'facts',facts)
      from public.website_interview_fact_batches where call_id=${q(call)} and provider_item_id='stream-territory';`));
    assert.equal(facts.receiptId,durable.receiptId);assert.equal(facts.ownerText,text);assert.deepEqual(facts.facts,[]);
    for(const ref of [territory,...related].flatMap(item=>item.coverageRefs))assert.ok(facts.refs.includes(ref));
    await speech(runtime.state.speech.stream);
    assert.equal(playoutInvocations,4);assert.equal(diagnostics.filter(event=>event.stage==='stream.receipt_retry').length,1);
    assert.equal(await runSql(`select count(*) from public.website_interview_speech where call_id=${q(call)} and transport='realtime_stream_v1' and status='played';`),'3');
    assert.equal(await runSql(`select count(*) from public.website_interview_speech where call_id=${q(call)} and payload is not null;`),'0');
    assert.equal(await runSql(`select count(*) from public.website_interview_approvals where call_id=${q(call)};`),'0');
    const speechReceipts=JSON.parse(await runSql(`select jsonb_agg(jsonb_build_object('actionId',s.action_id,'authorization',s.stream_authorization_receipt_id,
      'generation',s.stream_generation_receipt_id,'playout',s.stream_playout_receipt_id,'played',s.played_receipt_id,
      'acceptedReceipts',(select count(*) from public.receipts r where r.id in (s.stream_authorization_receipt_id,s.stream_generation_receipt_id,s.stream_playout_receipt_id,s.played_receipt_id)
        and r.call_id=s.call_id and r.tenant_id=s.tenant_id and r.kind='website_interview' and r.outcome='accepted')) order by s.created_at)
      from public.website_interview_speech s where call_id=${q(call)} and transport='realtime_stream_v1' and status='played';`));
    assert.equal(speechReceipts.length,3);
    for(const receipt of speechReceipts){assert.equal(receipt.acceptedReceipts,4);assert.equal(new Set([receipt.authorization,receipt.generation,receipt.playout,receipt.played]).size,4);}
    assert.equal(invocations.some(({name})=>name==='approve_website_interview_summary'),false);
    assert.equal(sent.filter(event=>event.type==='response.create'&&event.response.output_modalities[0]==='text').length,1);
    assert.deepEqual(JSON.parse(await preservedState()),JSON.parse(sourceBefore));
    return {tests:4,scenarios:['actual-runtime-store-sql-stream-opening-with-zero-tts','actual-stream-playout-commit-response-loss-reconciled','actual-stream-ack-and-related-territory-durable-next-timezone','actual-stream-source-and-approval-boundaries-preserved'],providerCalls:0,browserMedia:'explicit synthetic attestation',agendaItems:114,callId:call,
      acknowledgment,territoryInterpretation,answeredItemIds:answeredIds,nextItemId:next.itemId,nextQuestionPt:next.questionPt,agendaReceiptId:durable.receiptId,speechReceipts};
  }finally{
    runtime?.stop();
    if(callCreated)await runSql(`update public.calls set status='error',ended_at=clock_timestamp(),provider_termination_state='confirmed',provider_termination_reason='isolated_stream_probe_finished',provider_usage_state='resolved',cost_estimate_usd=0.025 where id=${q(call)};`);
    if(reserved)await rpc('settle_call_budget',{p_tenant:tenant,p_call:call,p_actual_cost:0.025,p_minutes:1,p_outcome:'error',p_detail:{fixture:'synthetic-stream-actual-schema-cleanup'}});
    if(reserved)assert.equal(await runSql(`select status from public.budget_reservations where call_id=${q(call)};`),'settled');
  }
}
