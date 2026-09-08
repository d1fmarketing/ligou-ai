import { test, expect } from 'bun:test';
import {createHash} from 'node:crypto';
import fixture from './fixtures/foghorn-website-first-voice.json';
import { buildWebsiteAgendaSeeds } from '../src/onboarding-agenda-seed.ts';
import { createOnboardingAgenda, getAgendaAction, applyVerifiedOwnerTurn } from '../src/onboarding-agenda.ts';
import { buildWebsiteCandidateContext } from '../src/onboarding-website-summary.ts';
import { onboardingAgendaDigest, type StoredWebsiteInterview } from '../src/onboarding-agenda-store.ts';
import { createNativeWebsiteInterviewRuntime } from '../src/onboarding-native-runtime.ts';
import {validateWebsiteTypedFacts} from '../src/onboarding-website-facts.ts';
import {canonicalizeLocalityInput} from '../src/onboarding-coverage.ts';

const ownerId='05495cf9-239d-4f9e-ac45-8d4f6b5e2cc9',requestId='d934be85-6f4c-4738-996b-4b02c1bda552';
const territoryInterpretation='Atendimento somente em Novato, San Rafael e Petaluma. Fora dessas cidades, apenas com aprovação explícita do dono.';
function harness(options:{commitAfterTimeout?:boolean;denied?:boolean;reviewing?:boolean;lastOpen?:boolean;checkpointAfterTimeout?:boolean;approvalAfterTimeout?:boolean;contentFixture?:boolean}={}) {
  const {tenant_id:_,...draftReadback}=fixture.draft_row;
  const projection=buildWebsiteAgendaSeeds({draftReadback,initialCoverage:fixture.initial_coverage.snapshot as any});
  const callId=projection.provenance.callId;
  let agenda=createOnboardingAgenda({interviewId:callId,callId,draftId:projection.provenance.draftId,draftHash:projection.provenance.draftHash,
    sourceResultId:projection.provenance.sourceResultId,sourceResultHash:projection.provenance.sourceResultHash},options.contentFixture?[
      {id:'current',source:'missing_website_information',subject:'area',questionPt:'O que acontece fora da área?',coverageRefs:['area.out_of_area_policy'],relatedItemIds:['extra'],blocking:true},
      {id:'extra',source:'missing_website_information',subject:'area',questionPt:'Existe taxa de deslocamento?',coverageRefs:['area.travel_fee'],relatedItemIds:[],blocking:true},
    ]:projection.seeds,buildWebsiteCandidateContext(projection));
  if(options.reviewing||options.lastOpen)while(getAgendaAction(agenda).itemId&&(!options.lastOpen||agenda.items.filter(x=>['open','awaiting_clarification'].includes(x.status)).length>1)){
    agenda=applyVerifiedOwnerTurn(agenda,{type:'verified_owner_turn',binding:agenda.binding,turnId:`prior-${agenda.revision}`,
      text:'Ainda preciso verificar este ponto.',proposal:{kind:'defer',itemId:getAgendaAction(agenda).itemId!}}).agenda;
  }
  let stored:StoredWebsiteInterview={agenda,revision:agenda.revision,storeVersion:agenda.revision,digest:onboardingAgendaDigest(agenda),receiptId:requestId,
    state:getAgendaAction(agenda).itemId?'unfinished':'reviewing',nextAction:getAgendaAction(agenda),replayed:false};
  const sent:any[]=[],records:any[]=[],commits:any[]=[],terminations:any[]=[],captions:any[]=[],checkpoints:any[]=[],approvals:any[]=[],amendments:any[]=[],completions:any[]=[],usages:any[]=[];
  const checkpointProofs=new Map<string,any>();let approvalProof:any;
  const operations=new Map<string,{proposal:any;interpretation:string;facts:any[];receiptId:string;revision:number}>();
  const operationKey=(value:any)=>JSON.stringify([value.proposal,value.interpretation,value.facts??[]]);
  const approvalId='e47017d3-c223-4d1f-bce9-00e77e65728f';
  const deps:any={model:'gpt-realtime-2.1',send:(frame:any)=>sent.push(frame),enqueue:async(task:any)=>task(),
    onState:()=>{},onDiagnostic:()=>{},onTranscript:(value:any)=>captions.push(value),onUsage:(value:any)=>usages.push(value),onUsageUnknown:()=>{},
    onCost:()=>{throw Error('native speech must not synthesize')},synthesize:()=>{throw Error('native speech must not synthesize')},
    onTerminate:(value:any)=>terminations.push(value),evidenceStore:{
      prepareSummary:()=>{throw Error('native recap must be spoken before persistence')},claimStream:()=>{throw Error('native never delegates playback')},
      recordNativeCheckpoint:async(value:any)=>{
        checkpoints.push(value);if(checkpointProofs.has(value.checkpointId))return checkpointProofs.get(value.checkpointId);
        const receiptId=value.kind==='review'?'c3d170e1-65ec-4a6c-a924-e7c84f9e4a16':'b590e1a2-0508-4b41-adab-ce841485917d';
        if(value.kind==='review')stored={...stored,storeVersion:stored.storeVersion+1,receiptId};
        const proof={schema:'onboarding.native.checkpoint.v1',receiptId,checkpointId:value.checkpointId,kind:value.kind,callId,interviewId:agenda.binding.interviewId,
          revision:value.expectedRevision,digest:value.expectedDigest,storeVersion:stored.storeVersion,responseId:value.responseId,itemId:value.itemId,
          agendaReceiptId:stored.receiptId,transcript:value.transcript,bufferStoppedEventId:value.bufferStoppedEventId,mediaEvidence:value.mediaEvidence,
          ...(value.kind==='review'?{summaryId:value.checkpointId,summaryHash:createHash('sha256').update(JSON.stringify([value.checkpointId,value.expectedRevision,value.expectedDigest,[value.transcript]])).digest('hex'),parts:[value.transcript]}:{approvalReceiptId:value.approvalReceiptId})};
        checkpointProofs.set(value.checkpointId,proof);
        if(options.checkpointAfterTimeout&&checkpoints.length===1)throw Object.assign(Error('lost checkpoint receipt'),{status:503});
        return proof;
      },
      approveSummary:async(value:any)=>{
        approvals.push(value);if(approvalProof)return approvalProof;
        stored={...stored,state:'closing',storeVersion:stored.storeVersion+1,receiptId:approvalId};
        approvalProof={approvalReceiptId:approvalId,receiptId:approvalId,turnId:`${callId}:${value.providerItemId}`,summaryId:value.summaryId,
          summaryHash:value.summaryHash,revision:value.expectedRevision,digest:value.expectedDigest,storeVersion:stored.storeVersion};
        if(options.approvalAfterTimeout)throw Object.assign(Error('lost approval receipt'),{status:503});return approvalProof;
      },
      requestNativeAmendment:async(value:any)=>{amendments.push(value);return{receiptId:'c66d376a-157a-4f91-8a18-68218701bc8a',interviewId:agenda.binding.interviewId,
        callId,approvalReceiptId:approvalId,providerItemId:value.providerItemId,proposal:value.proposal,state:'pending_amendment',replayed:false};},
      recordCompletion:async(value:any)=>{completions.push(value);return{receiptId:'d414fb12-0b56-4da9-9403-2b0dbf9a390f',callId,interviewId:agenda.binding.interviewId,
        approvalReceiptId:value.approvalReceiptId??null,outcome:value.outcome,providerConfirmed:true,budgetSettled:true};},
    },
    agendaStore:{readWebsiteInterview:async()=>stored,
      recordOwnerTranscript:async(value:any)=>{records.push(value);return {...value,turnId:`${callId}:${value.providerItemId}`,replayed:false};},
      commitOwnerTurn:async()=>{throw Error('native ordinary writes cannot use literal-ASR commit')},
      replayNativeOwnerTurn:async(value:any)=>{
        const prior=operations.get(value.providerItemId);if(!prior)return null;
        if(operationKey(prior)!==operationKey(value))throw Error('native_operation_conflict');
        return{...stored,replayed:true,operationReceiptId:prior.receiptId,operationRevision:prior.revision};
      },
      commitNativeOwnerTurn:async(value:any)=>{
        commits.push(value);
        if(options.denied)throw Object.assign(Error('permission denied'),{code:'42501',status:403});
        stored={...stored,agenda:value.agenda,revision:value.agenda.revision,storeVersion:stored.storeVersion+1,
          receiptId:`00000000-0000-4000-8000-${String(value.agenda.revision).padStart(12,'0')}`,
          digest:onboardingAgendaDigest(value.agenda),nextAction:getAgendaAction(value.agenda),state:getAgendaAction(value.agenda).itemId?'unfinished':'reviewing'};
        operations.set(value.providerItemId,{proposal:value.proposal,interpretation:value.interpretation,facts:value.facts??[],receiptId:stored.receiptId,revision:stored.revision});
        if(options.commitAfterTimeout && commits.length===1)throw Object.assign(Error('lost response'),{status:503});
        return{...stored,operationReceiptId:stored.receiptId,operationRevision:stored.revision};
      }} };
  const runtime=createNativeWebsiteInterviewRuntime({native:true,prepared:{scope:{ownerId,callId,requestId},stored,projection},businessName:'Foghorn Air, Inc.'},deps);
  const emit=async(event:any)=>{runtime.observeEvent(event);await runtime.handleEvent(event);};
  const ready=()=>emit({type:'conversation.item.created',item:{id:`lnr-${callId.replaceAll('-','').slice(0,28)}`,role:'system',
    content:[{type:'input_text',text:`ligou.website_native_ready:${JSON.stringify({callId,interviewId:callId})}`}]}});
  const input=async()=>{await emit({type:'input_audio_buffer.speech_started',item_id:'owner_1'});await emit({type:'input_audio_buffer.committed',item_id:'owner_1'});};
  const proposal=async(kind='completed',itemId=agenda.items[0].id)=>{
    await emit({type:'response.created',response:{id:'resp_owner_1',status:'in_progress'}});
    await emit({type:'response.done',response:{id:'resp_owner_1',status:kind,output:[{type:'function_call',status:'completed',
      id:'tool_item_1',call_id:'tool_call_1',name:'submit_website_interview_proposal',arguments:JSON.stringify({proposal:{kind:'answer',itemId},facts:[],interpretation:territoryInterpretation})}]}});
  };
  const asr=()=>emit({type:'conversation.item.input_audio_transcription.completed',item_id:'owner_1',transcript:'Atendemos somente Novato, San Rafael e Petaluma. Fora dessas cidades, somente com aprovação explícita do dono.'});
  return {runtime,emit,ready,input,proposal,asr,sent,records,commits,terminations,captions,checkpoints,approvals,amendments,completions,usages,deps,
    stored:()=>stored,callId,agenda,approvalId,operations};
}

test('native opening waits for the real browser ready signal and emits only one audio response',async()=>{
  const h=harness();await h.runtime.attach();
  expect(h.sent.filter(x=>x.type==='response.create')).toHaveLength(0);
  expect(h.sent.find(x=>x.type==='session.update').session.output_modalities).toEqual(['audio']);
  await h.ready();await h.ready();
  const outputs=h.sent.filter(x=>x.type==='response.create');
  expect(outputs).toHaveLength(1);expect(outputs[0].response.output_modalities).toEqual(['audio']);
  expect(outputs[0].response.instructions).toContain('Foghorn Air, Inc.');
  expect(outputs[0].response.instructions).toContain(h.agenda.items[0].questionPt);
  expect(h.records).toHaveLength(0);expect(h.commits).toHaveLength(0);h.runtime.stop();
});

test('native tool commits, returns its receipt and begins next audio before final ASR; ASR only appends literal evidence',async()=>{
  const h=harness();await h.runtime.attach();await h.ready();
  const opening=await beginIssued(h,'opening');await h.emit({type:'response.done',response:{id:'opening',status:'completed',metadata:opening.response.metadata,output:[]}});
  await h.input();await h.proposal();
  expect(h.records).toHaveLength(0);expect(h.commits).toHaveLength(1);
  const revision=h.stored().revision,digest=h.stored().digest;
  const continuation=await beginIssued(h,'next_question');await h.emit({type:'output_audio_buffer.started',response_id:'next_question'});
  expect(continuation.response.output_modalities).toEqual(['audio']);
  const output=h.sent.find(x=>x.item?.type==='function_call_output');
  expect(output.item.call_id).toBe('tool_call_1');expect(JSON.parse(output.item.output)).toMatchObject({saved:true,savedRevision:revision});
  await h.asr();
  await settleEvidence();
  expect(h.records).toHaveLength(1);expect(h.commits).toHaveLength(1);
  expect(h.commits[0].providerItemId).toBe('owner_1');
  expect(h.commits[0].agenda.ownerTurns.at(-1)).toMatchObject({text:territoryInterpretation,provenance:'model_interpretation'});
  expect(h.records[0].text).not.toBe(territoryInterpretation);expect(h.stored().revision).toBe(revision);expect(h.stored().digest).toBe(digest);
  expect(h.sent.filter(x=>x.type==='response.create').every(x=>x.response.output_modalities?.[0]==='audio')).toBe(true);
  h.runtime.stop();
});

test('a lost successful write response is reconciled without a second commit',async()=>{
  const h=harness({commitAfterTimeout:true});await h.runtime.attach();await h.input();await h.asr();await h.proposal();
  expect(h.commits).toHaveLength(1);expect(h.stored().revision).toBe(1);
  const output=h.sent.find(x=>x.item?.type==='function_call_output');expect(JSON.parse(output.item.output).saved).toBe(true);
  h.runtime.stop();
});

test('cancelled provider responses and ownerless tool calls cannot write a draft',async()=>{
  const h=harness();await h.runtime.attach();await h.proposal();
  expect(h.commits).toHaveLength(0);
  await h.input();await h.asr();await h.proposal('cancelled');
  expect(h.commits).toHaveLength(0);h.runtime.stop();
});

test('an invalid target produces a failed tool result without saving or claiming completion',async()=>{
  const h=harness();await h.runtime.attach();await h.input();await h.asr();await h.proposal('completed','unknown_target');
  expect(h.commits).toHaveLength(0);expect(h.terminations).toHaveLength(0);
  const output=h.sent.find(x=>x.item?.type==='function_call_output');expect(JSON.parse(output.item.output).saved).toBe(false);
  h.runtime.stop();
});

test('authorization loss does not retry the write or continue pretending it was saved',async()=>{
  const h=harness({denied:true});await h.runtime.attach();await h.input();await h.asr();await h.proposal();
  expect(h.commits).toHaveLength(1);expect(h.terminations).toHaveLength(1);
  expect(h.terminations[0].outcome).toBe('unfinished');h.runtime.stop();
});

test('Stop fences late transcripts and tool responses',async()=>{
  const h=harness();await h.runtime.attach();await h.input();h.runtime.stop();await h.asr();await h.proposal();
  expect(h.records).toHaveLength(0);expect(h.commits).toHaveLength(0);
});

test('a turn that began on an older question cannot become an answer to the newly selected question',async()=>{
  const h=harness();await h.runtime.attach();await h.input();
  await h.emit({type:'response.created',response:{id:'first_response'}});
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'owner_2'});
  await h.asr();
  await h.emit({type:'response.done',response:{id:'first_response',status:'completed',output:[{type:'function_call',status:'completed',
    call_id:'first_tool',name:'submit_website_interview_proposal',arguments:JSON.stringify({proposal:{kind:'answer',itemId:h.agenda.items[0].id},interpretation:territoryInterpretation})}]}});
  expect(h.commits).toHaveLength(1);
  await h.emit({type:'input_audio_buffer.committed',item_id:'owner_2'});
  await h.emit({type:'response.created',response:{id:'second_response'}});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'owner_2',transcript:'Isso ainda era sobre a primeira pergunta.'});
  await h.emit({type:'response.done',response:{id:'second_response',status:'completed',output:[{type:'function_call',status:'completed',
    call_id:'second_tool',name:'submit_website_interview_proposal',arguments:JSON.stringify({proposal:{kind:'answer',itemId:h.stored().nextAction.itemId},interpretation:'Isso ainda era sobre a primeira pergunta.'})}]}});
  expect(h.commits).toHaveLength(1);
  const result=h.sent.find(x=>x.item?.call_id==='second_tool');expect(JSON.parse(result.item.output).code).toBe('draft_version_changed');h.runtime.stop();
});

test('native startup rejects a mismatched call scope before any model request',()=>{
  const h=harness();const bad:any={native:true,businessName:'Foghorn Air, Inc.',prepared:{scope:{ownerId,requestId,callId:requestId},stored:h.stored(),projection:{}}};
  expect(()=>createNativeWebsiteInterviewRuntime(bad,{} as any)).toThrow();h.runtime.stop();
});

type Harness=ReturnType<typeof harness>;
const settleEvidence=()=>new Promise<void>(resolve=>setImmediate(resolve));
const media={schema:'onboarding.stream.media.v1',nonzeroSamples:120,observedMs:800,firstSampleAtMs:100,lastSampleAtMs:780,unmuted:true,playbackStarted:true};
const lastRequest=(h:Harness)=>h.sent.filter(x=>x.type==='response.create').at(-1);
async function beginIssued(h:Harness,id:string){
 const request=lastRequest(h);expect(request).toBeTruthy();
 await h.emit({type:'response.created',response:{id,metadata:request.response.metadata}});return request;
}
async function generation(h:Harness,id:string,request:any,text='Atendemos as cidades confirmadas; exceções dependem do dono. Os outros pontos continuam pendentes. Você aprova este resumo?'){
 const itemId=`item_${id}`;
 await h.emit({type:'output_audio_buffer.started',response_id:id});
 await h.emit({type:'response.output_audio_transcript.done',response_id:id,item_id:itemId,transcript:text});
 await h.emit({type:'response.done',response:{id,status:'completed',metadata:request.response.metadata,
  output:[{id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'audio',transcript:text}]}]}});
 return itemId;
}
async function played(h:Harness,id:string,request:any,itemId=`item_${id}`,change:Record<string,unknown>={}){
 const body={callId:h.callId,interviewId:h.agenda.binding.interviewId,responseId:id,itemId,checkpoint:request.response.metadata.native_checkpoint,mediaEvidence:media,...change};
 return h.emit({type:'conversation.item.created',item:{id:`lnp-${request.response.metadata.native_request_id.replaceAll('-','').slice(0,28)}`,
  type:'message',role:'system',status:'completed',content:[{type:'input_text',text:'ligou.website_native_played:'+JSON.stringify(body)}]}});
}
async function completeCheckpoint(h:Harness,id:string,text?:string){
 const request=await beginIssued(h,id);await generation(h,id,request,text);
 await h.emit({type:'output_audio_buffer.stopped',event_id:`evt_stopped_${id}`,response_id:id});await played(h,id,request);return request;
}
async function ownerTool(h:Harness,id:string,text:string,name:string,args:unknown){
 await h.emit({type:'input_audio_buffer.speech_started',item_id:id});await h.emit({type:'input_audio_buffer.committed',item_id:id});
 await h.emit({type:'response.created',response:{id:`resp_${id}`}});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});
 await settleEvidence();
 await h.emit({type:'response.done',response:{id:`resp_${id}`,status:'completed',output:[{type:'function_call',status:'completed',
  call_id:`tool_${id}`,name,arguments:JSON.stringify(name==='submit_website_interview_proposal'?{interpretation:text,...args as object}:args)}]}});
}

test('native last answer, direct recap, fresh approval, natural signoff and durable finalization form one audio lifecycle',async()=>{
 const h=harness({lastOpen:true});try{
  await h.runtime.attach();await h.ready();const opening=await beginIssued(h,'opening');
  await h.emit({type:'response.done',response:{id:'opening',status:'completed',metadata:opening.response.metadata,output:[]}});
  await ownerTool(h,'last_answer','Esse ponto não se aplica à nossa empresa.','submit_website_interview_proposal',
   {proposal:{kind:'not_applicable',itemId:h.stored().nextAction.itemId},facts:[]});
  expect(h.commits).toHaveLength(1);expect(lastRequest(h).response.metadata.native_checkpoint).toBe('review');
  expect(lastRequest(h).response.tools).toEqual([]);expect(lastRequest(h).response.output_modalities).toEqual(['audio']);
  const reviewVersion=h.stored().storeVersion;
  await completeCheckpoint(h,'review');expect(h.checkpoints).toHaveLength(1);
  expect(h.checkpoints[0].expectedStoreVersion).toBe(reviewVersion);expect(h.runtime.state.stored.storeVersion).toBe(reviewVersion+1);
  expect(h.approvals).toHaveLength(0);expect(h.completions).toHaveLength(0);
  await ownerTool(h,'approval','Eu aprovo este resumo.','approve_website_interview',{});
  expect(h.approvals).toHaveLength(1);expect(h.approvals[0].providerItemId).toBe('approval');
  expect(h.approvals[0].expectedStoreVersion).toBe(reviewVersion+1);expect(lastRequest(h).response.metadata.native_checkpoint).toBe('signoff');
  await completeCheckpoint(h,'signoff','Obrigada pela conversa; sua aprovação foi registrada e podemos encerrar.');
  expect(h.checkpoints[1].approvalReceiptId).toBe(h.approvalId);expect(h.terminations).toHaveLength(1);
  expect(h.terminations[0].outcome).toBe('complete');expect(h.completions).toHaveLength(0);
  const proof={providerReceiptId:'5b4a7a38-73c2-45bf-a8f5-686f0f79716b',budgetReceiptId:'973e3b13-9833-40bb-af70-23cc52873396'};
  await h.runtime.finalized(proof);await h.runtime.finalized(proof);
  expect(h.completions).toHaveLength(1);expect(h.completions[0]).toMatchObject({outcome:'complete',approvalReceiptId:h.approvalId});
 }finally{h.runtime.stop();}
});

test('native checkpoint waits for actual client media and joins reordered duplicate evidence only once',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const request=await beginIssued(h,'review_join');
  await played(h,'review_join',request);expect(h.checkpoints).toHaveLength(0);
  await generation(h,'review_join',request);expect(h.checkpoints).toHaveLength(0);
  const stop={type:'output_audio_buffer.stopped',event_id:'evt_join_stop',response_id:'review_join'};
  await h.emit(stop);expect(h.checkpoints).toHaveLength(1);
  await h.emit(stop);await played(h,'review_join',request);expect(h.checkpoints).toHaveLength(1);
  expect(h.checkpoints[0].bufferStoppedEventId).toBe('evt_join_stop');expect(h.checkpoints[0].mediaEvidence).toEqual(media);
 }finally{h.runtime.stop();}
});

test.each(['Eu aprovo este resumo.','Sim, mas corrija os preços.'])('approval cannot be conferred by early or negative tool call: %s',async text=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();
  if(text.startsWith('Sim'))await completeCheckpoint(h,'negative_review');
  await ownerTool(h,'bad_approval',text,'approve_website_interview',{});
  expect(h.approvals).toHaveLength(0);expect(h.terminations).toHaveLength(0);
  const result=h.sent.find(x=>x.item?.call_id==='tool_bad_approval');expect(JSON.parse(result.item.output).saved).toBe(false);
 }finally{h.runtime.stop();}
});

test('barged recap and wrong or zero-media client proofs never create a durable recap',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const request=await beginIssued(h,'barged');await generation(h,'barged',request);
  await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_barged_stop',response_id:'barged'});
  await played(h,'barged',request,'item_barged',{mediaEvidence:{...media,nonzeroSamples:0}});
  await played(h,'barged',request,'item_barged',{callId:requestId});expect(h.checkpoints).toHaveLength(0);
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'interrupting_owner'});
  await h.emit({type:'output_audio_buffer.cleared',event_id:'evt_barged_clear',response_id:'barged'});
  await played(h,'barged',request);expect(h.checkpoints).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('unissued checkpoint metadata and a mismatched completed response cannot acquire checkpoint authority',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const request=lastRequest(h);
  const wrong={...request,response:{...request.response,metadata:{native_request_id:requestId,native_checkpoint:'review'}}};
  await h.emit({type:'response.created',response:{id:'unissued',metadata:wrong.response.metadata}});
  await generation(h,'unissued',wrong);await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_unissued',response_id:'unissued'});
  await played(h,'unissued',wrong);expect(h.checkpoints).toHaveLength(0);
  await h.emit({type:'response.created',response:{id:'mismatched',metadata:request.response.metadata}});
  await generation(h,'mismatched',wrong);await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_mismatched',response_id:'mismatched'});
  await played(h,'mismatched',request);expect(h.checkpoints).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('checkpoint and approval retries reuse their original expected snapshot after a lost successful receipt',async()=>{
 const h=harness({reviewing:true,checkpointAfterTimeout:true,approvalAfterTimeout:true});try{
  await h.runtime.attach();await h.ready();await completeCheckpoint(h,'retry_review');
  expect(h.checkpoints).toHaveLength(2);expect(h.checkpoints[0]).toMatchObject(h.checkpoints[1]);
  await ownerTool(h,'retry_approval','Eu aprovo este resumo.','approve_website_interview',{});
  expect(h.approvals).toHaveLength(2);expect(h.approvals[0]).toMatchObject(h.approvals[1]);
  expect(h.runtime.state.stored.state).toBe('closing');
 }finally{h.runtime.stop();}
});

test('closing correction requests an amendment without mutating the approved agenda',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();await completeCheckpoint(h,'amend_review');
  await ownerTool(h,'amend_approval','Eu aprovo este resumo.','approve_website_interview',{});
  const before=h.stored().digest;
  await ownerTool(h,'amend_owner','Corrija a área de atendimento para incluir Sonoma.','submit_website_interview_proposal',
   {proposal:{kind:'correction',affectedItems:[{itemId:h.agenda.items[0].id,disposition:'corrected'}]},facts:[]});
  expect(h.amendments).toHaveLength(1);expect(h.amendments[0].approvalReceiptId).toBe(h.approvalId);
  expect(h.amendments[0].proposal.affectedItems[0].disposition).toBe('reopen');expect(h.commits).toHaveLength(0);
  expect(h.stored().digest).toBe(before);expect(h.approvals).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('Stop fences late checkpoint proof while still accounting each completed provider response once',async()=>{
 const h=harness({reviewing:true});await h.runtime.attach();await h.ready();const request=await beginIssued(h,'stopped_review');
 await generation(h,'stopped_review',request);h.runtime.stop();
 await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_late_stop',response_id:'stopped_review'});await played(h,'stopped_review',request);
 const late={type:'response.done',response:{id:'late_usage',status:'cancelled',output:[]}};await h.emit(late);await h.emit(late);
 expect(h.checkpoints).toHaveLength(0);expect(h.approvals).toHaveLength(0);expect(h.usages.filter(x=>x.id==='late_usage')).toHaveLength(1);
});

test('a rejected stale turn remains bound to its old question on controller-issued repair',async()=>{
 const h=harness();try{
  await h.runtime.attach();await h.ready();await beginIssued(h,'repair_opening');
  await h.emit({type:'response.done',response:{id:'repair_opening',status:'completed',output:[]}});
  await h.input();await h.emit({type:'response.created',response:{id:'repair_first'}});
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'repair_owner_2'});await h.asr();
  const tool=(id:string,call:string,itemId:string)=>h.emit({type:'response.done',response:{id,status:'completed',output:[{
   type:'function_call',status:'completed',call_id:call,name:'submit_website_interview_proposal',arguments:JSON.stringify({proposal:{kind:'answer',itemId},facts:[],interpretation:territoryInterpretation})}]}});
  await tool('repair_first','repair_first_tool',h.agenda.items[0].id);expect(h.commits).toHaveLength(1);
  await beginIssued(h,'saved_continuation');await h.emit({type:'response.done',response:{id:'saved_continuation',status:'completed',output:[]}});
  await h.emit({type:'input_audio_buffer.committed',item_id:'repair_owner_2'});
  await h.emit({type:'response.created',response:{id:'repair_second'}});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'repair_owner_2',transcript:'Isso ainda era sobre a primeira pergunta.'});
  await tool('repair_second','repair_second_tool',h.stored().nextAction.itemId!);expect(h.commits).toHaveLength(1);
  await beginIssued(h,'repair_attempt');await tool('repair_attempt','repair_attempt_tool',h.stored().nextAction.itemId!);
  expect(h.commits).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('a retired checkpoint that is created late is cancelled and never acquires playback authority',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const request=lastRequest(h);
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'early_barge'});
  await h.emit({type:'response.created',response:{id:'late_checkpoint',metadata:request.response.metadata}});
  expect(h.sent.some(x=>x.type==='response.cancel'&&x.response_id==='late_checkpoint')).toBe(true);
  await generation(h,'late_checkpoint',request);await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_late_created',response_id:'late_checkpoint'});
  await played(h,'late_checkpoint',request);expect(h.checkpoints).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('an interrupted native review can continue with a newly issued recap after the owner turn',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const first=await beginIssued(h,'interrupted_review');await generation(h,'interrupted_review',first);
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'clarify_review'});
  await h.emit({type:'output_audio_buffer.cleared',response_id:'interrupted_review'});
  await h.emit({type:'input_audio_buffer.committed',item_id:'clarify_review'});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'clarify_review',transcript:'Pode continuar o resumo, por favor.'});
  await h.emit({type:'response.created',response:{id:'clarify_response'}});
  await h.emit({type:'response.done',response:{id:'clarify_response',status:'completed',output:[]}});
  const next=lastRequest(h);expect(next.response.metadata.native_request_id).not.toBe(first.response.metadata.native_request_id);
  expect(next.response.metadata.native_checkpoint).toBe('review');
  await completeCheckpoint(h,'continued_review');expect(h.checkpoints).toHaveLength(1);
  await ownerTool(h,'continued_approval','Eu aprovo este resumo.','approve_website_interview',{});expect(h.approvals).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('owner speech after real recap playback remains fresh while its durable receipt is pending',async()=>{
 const h=harness({reviewing:true});let release!:()=>void;
 const wait=new Promise<void>(resolve=>release=resolve),record=h.deps.evidenceStore.recordNativeCheckpoint;
 h.deps.evidenceStore.recordNativeCheckpoint=async(value:any)=>{await wait;return record(value);};
 try{
  await h.runtime.attach();await h.ready();const request=await beginIssued(h,'slow_checkpoint');await generation(h,'slow_checkpoint',request);
  await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_slow_stop',response_id:'slow_checkpoint'});
  const writing=played(h,'slow_checkpoint',request);
  h.runtime.observeEvent({type:'input_audio_buffer.speech_started',item_id:'approval_during_receipt'});
  h.runtime.observeEvent({type:'output_audio_buffer.cleared',response_id:'slow_checkpoint'});
  release();await writing;
  await h.emit({type:'input_audio_buffer.committed',item_id:'approval_during_receipt'});
  await h.emit({type:'response.created',response:{id:'slow_receipt_response'}});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'approval_during_receipt',transcript:'Eu aprovo este resumo.'});
  await h.emit({type:'response.done',response:{id:'slow_receipt_response',status:'completed',output:[{type:'function_call',status:'completed',
   call_id:'slow_receipt_approval',name:'approve_website_interview',arguments:'{}'}]}});
  expect(h.approvals).toHaveLength(1);
 }finally{release();h.runtime.stop();}
});

test('Stop while asynchronous ASR evidence is pending leaves the prior native save intact and fences late continuation',async()=>{
 const h=harness();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve),record=h.deps.agendaStore.recordOwnerTranscript;
 h.deps.agendaStore.recordOwnerTranscript=async(value:any)=>{await wait;return record(value);};
 await h.runtime.attach();await h.input();await h.proposal();const before=h.sent.length,writing=h.asr();
 h.runtime.stop();release();await writing;
 await settleEvidence();expect(h.commits).toHaveLength(1);expect(h.sent).toHaveLength(before);
});

test('an automatic response does not release a still-unacknowledged backend checkpoint request',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const request=lastRequest(h);
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'pending_barge'});
  await h.emit({type:'input_audio_buffer.committed',item_id:'pending_barge'});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'pending_barge',transcript:'Pode continuar, por favor.'});
  await h.emit({type:'response.created',response:{id:'automatic_during_pending'}});
  await h.emit({type:'response.done',response:{id:'automatic_during_pending',status:'completed',output:[]}});
  expect(h.sent.filter(x=>x.type==='response.create')).toHaveLength(1);
  await h.emit({type:'response.created',response:{id:'late_pending_checkpoint',metadata:request.response.metadata}});
  await h.emit({type:'response.done',response:{id:'late_pending_checkpoint',status:'cancelled',metadata:request.response.metadata,output:[]}});
  expect(h.sent.filter(x=>x.type==='response.create')).toHaveLength(2);
  expect(lastRequest(h).response.metadata.native_checkpoint).toBe('review');
 }finally{h.runtime.stop();}
});

test('missing local playout proof after provider stop gets one bounded native retry and never approval',async()=>{
 const timers=new Map<object,{callback:()=>void;ms:number}>(),originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 globalThis.setTimeout=((callback:()=>void,ms:number)=>{const id={};timers.set(id,{callback,ms});return id;}) as any;
 globalThis.clearTimeout=((id:object)=>timers.delete(id)) as any;
 const h=harness({reviewing:true});let queued=Promise.resolve();h.deps.enqueue=(task:()=>Promise<void>)=>queued=Promise.resolve().then(task);
 const fire=async()=>{
  const timer=[...timers.entries()].find(([,value])=>value.ms===5000);expect(timer).toBeTruthy();
  timers.delete(timer![0]);timer![1].callback();await queued;
 };
 try{
  await h.runtime.attach();await h.ready();const first=await beginIssued(h,'missing_playout_first');await generation(h,'missing_playout_first',first);
  const stop={type:'output_audio_buffer.stopped',event_id:'evt_missing_first',response_id:'missing_playout_first'};await h.emit(stop);
  const deadline=[...timers.entries()].find(([,value])=>value.ms===5000)?.[0];await h.emit(stop);
  expect([...timers.entries()].find(([,value])=>value.ms===5000)?.[0]).toBe(deadline);
  await fire();expect(h.terminations).toHaveLength(0);expect(h.checkpoints).toHaveLength(0);
  expect(lastRequest(h).response.metadata.native_request_id).not.toBe(first.response.metadata.native_request_id);
  const second=await beginIssued(h,'missing_playout_second');await generation(h,'missing_playout_second',second);
  await h.emit({type:'output_audio_buffer.stopped',event_id:'evt_missing_second',response_id:'missing_playout_second'});
  await fire();expect(h.terminations).toHaveLength(1);expect(h.terminations[0].outcome).toBe('unfinished');
  expect(h.approvals).toHaveLength(0);expect(h.checkpoints).toHaveLength(0);
 }finally{h.runtime.stop();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('a malformed native checkpoint retries once instead of leaving review permanently pending',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const first=await beginIssued(h,'malformed_first');
  await h.emit({type:'response.done',response:{id:'malformed_first',status:'completed',metadata:first.response.metadata,
   output:[{id:'wrong_output',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'A text-only recap is not audio.'}]}]}});
  expect(lastRequest(h).response.metadata.native_request_id).not.toBe(first.response.metadata.native_request_id);
  expect(lastRequest(h).response.metadata.native_checkpoint).toBe('review');expect(h.checkpoints).toHaveLength(0);
  const second=await beginIssued(h,'malformed_second');
  await h.emit({type:'response.done',response:{id:'malformed_second',status:'completed',metadata:second.response.metadata,output:[]}});
  expect(h.terminations).toHaveLength(1);expect(h.terminations[0].outcome).toBe('unfinished');expect(h.checkpoints).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('wrong created-checkpoint metadata is cancelled before a correctly bound retry',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();const first=lastRequest(h);
  await h.emit({type:'response.created',response:{id:'wrong_created',metadata:{...first.response.metadata,native_checkpoint:'signoff'}}});
  expect(h.sent.some(x=>x.type==='response.cancel'&&x.response_id==='wrong_created')).toBe(true);
  await h.emit({type:'response.done',response:{id:'wrong_created',status:'cancelled',metadata:first.response.metadata,output:[]}});
  expect(lastRequest(h).response.metadata.native_request_id).not.toBe(first.response.metadata.native_request_id);
  expect(lastRequest(h).response.metadata.native_checkpoint).toBe('review');expect(h.checkpoints).toHaveLength(0);
 }finally{h.runtime.stop();}
});

async function ordinaryWithoutAsr(h:Harness,ownerId:string,args:unknown,responseId=`native_${ownerId}`,toolId=`tool_${ownerId}`){
 await h.emit({type:'input_audio_buffer.speech_started',item_id:ownerId});await h.emit({type:'input_audio_buffer.committed',item_id:ownerId});
 await h.emit({type:'response.created',response:{id:responseId}});
 await h.emit({type:'response.done',response:{id:responseId,status:'completed',output:[{type:'function_call',status:'completed',
  call_id:toolId,name:'submit_website_interview_proposal',arguments:JSON.stringify(args)}]}});
}

test('ordinary answers survive missing, out-of-order and duplicate ASR without extra revisions or overwrite',async()=>{
 const h=harness();try{
  await h.runtime.attach();
  await ordinaryWithoutAsr(h,'first_untranscribed',{proposal:{kind:'answer',itemId:h.stored().nextAction.itemId},interpretation:territoryInterpretation});
  const firstItem=h.agenda.items[0].id,nextItem=h.stored().nextAction.itemId!;
  await ordinaryWithoutAsr(h,'second_untranscribed',{proposal:{kind:'answer',itemId:nextItem},interpretation:'A garantia só se aplica quando o defeito decorre da instalação.'});
  expect(h.commits).toHaveLength(2);expect(h.records).toHaveLength(0);
  const before=JSON.stringify(h.stored());
  const second={type:'conversation.item.input_audio_transcription.completed',item_id:'second_untranscribed',transcript:'Nossa garantia cobre defeito da instalação.'};
  const first={type:'conversation.item.input_audio_transcription.completed',item_id:'first_untranscribed',transcript:'O ASR tardio divergiu e citou outra cidade.'};
  await h.emit(second);await settleEvidence();await h.emit(first);await settleEvidence();await h.emit(second);await settleEvidence();
  expect(h.records.map(x=>x.providerItemId)).toEqual(['second_untranscribed','first_untranscribed']);
  expect(h.commits).toHaveLength(2);expect(JSON.stringify(h.stored())).toBe(before);
  expect(h.stored().agenda.items.find(x=>x.id===firstItem)!.evidence.at(-1)).toMatchObject({text:territoryInterpretation,provenance:'model_interpretation'});
  expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('an ASR storage request already in flight does not hold an ordinary tool or its next audio request',async()=>{
 const h=harness();let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve),record=h.deps.agendaStore.recordOwnerTranscript;
 h.deps.agendaStore.recordOwnerTranscript=async(value:any)=>{await wait;return record(value);};
 try{
  await h.runtime.attach();await h.ready();await beginIssued(h,'slow_asr_opening');await h.emit({type:'response.done',response:{id:'slow_asr_opening',status:'completed',output:[]}});
  await h.input();
  const final=h.asr();let returned=false;void final.then(()=>{returned=true;});await settleEvidence();
  expect(returned).toBe(true);
  await h.proposal();expect(h.commits).toHaveLength(1);expect(h.records).toHaveLength(0);
  expect(lastRequest(h).response.metadata.native_request_id).toBeTruthy();expect(h.sent.find(x=>x.item?.call_id==='tool_call_1')).toBeTruthy();
  release();await final;await settleEvidence();expect(h.records).toHaveLength(1);expect(h.commits).toHaveLength(1);
 }finally{release();h.runtime.stop();}
});

test.each(['answer','not_applicable','correction'] as const)('empty %s content cannot resolve a question even when ASR exists',async kind=>{
 const h=harness();try{
  await h.runtime.attach();await h.input();await h.asr();await settleEvidence();
  const proposal=kind==='correction'?{kind,affectedItems:[{itemId:h.agenda.items[0].id,disposition:'corrected'}]}:{kind,itemId:h.agenda.items[0].id};
  await h.emit({type:'response.created',response:{id:'empty_response'}});
  await h.emit({type:'response.done',response:{id:'empty_response',status:'completed',output:[{type:'function_call',status:'completed',call_id:'empty_tool',
   name:'submit_website_interview_proposal',arguments:JSON.stringify({proposal,facts:[]})}]}});
  expect(h.commits).toHaveLength(0);expect(h.stored().agenda.items[0].status).toBe('open');expect(h.terminations).toHaveLength(0);
  expect(JSON.parse(h.sent.find(x=>x.item?.call_id==='empty_tool').item.output)).toMatchObject({saved:false,code:'proposal_content_missing'});
 }finally{h.runtime.stop();}
});

test('validated structured values suffice without a redundant interpretation field',async()=>{
 const h=harness();try{
  await h.runtime.attach();
  const fact={topic:'area',field:'area.coverage',disposition:'answered',rule_text:'Atendemos apenas Novato, San Rafael e Petaluma, na Califórnia, Estados Unidos.',
   structured:{value:{localities:['Novato','San Rafael','Petaluma'].map(display_name=>canonicalizeLocalityInput({display_name,region_code:'CA',country_code:'US'}))}}};
  expect(validateWebsiteTypedFacts({agenda:h.agenda,currentItemId:h.agenda.items[0].id,ownerTranscript:fact.rule_text,
   proposal:{kind:'answer',itemId:h.agenda.items[0].id},facts:[fact]})).toHaveLength(1);
  await ordinaryWithoutAsr(h,'facts_only',{proposal:{kind:'answer',itemId:h.agenda.items[0].id},facts:[fact]});
  expect(h.commits).toHaveLength(1);expect(h.commits[0].interpretation).toBe(fact.rule_text);expect(h.records).toHaveLength(0);
  expect(h.commits[0].facts[0].structured).toEqual(fact.structured);expect(h.commits[0].agenda.ownerTurns.at(-1).provenance).toBe('model_interpretation');
 }finally{h.runtime.stop();}
});

test('a new tool ID replay returns the durable original operation receipt without a second effect',async()=>{
 const h=harness();try{
  await h.runtime.attach();await h.ready();await beginIssued(h,'replay_opening');await h.emit({type:'response.done',response:{id:'replay_opening',status:'completed',output:[]}});
  const args={proposal:{kind:'answer',itemId:h.agenda.items[0].id},interpretation:territoryInterpretation,facts:[]};
  await ordinaryWithoutAsr(h,'replayed_owner',args);
  const saved=h.operations.get('replayed_owner')!;
  await beginIssued(h,'replay_continuation');
  await h.emit({type:'response.done',response:{id:'replay_continuation',status:'completed',output:[{type:'function_call',status:'completed',
   call_id:'replay_new_tool_id',name:'submit_website_interview_proposal',arguments:JSON.stringify(args)}]}});
  expect(h.commits).toHaveLength(1);
  expect(JSON.parse(h.sent.find(x=>x.item?.call_id==='replay_new_tool_id').item.output)).toMatchObject({saved:true,replayed:true,
   savedReceiptId:saved.receiptId,savedRevision:saved.revision});
  const request=await beginIssued(h,'conflicting_replay');
  await h.emit({type:'response.done',response:{id:'conflicting_replay',status:'completed',metadata:request.response.metadata,output:[{type:'function_call',status:'completed',
   call_id:'conflicting_new_id',name:'submit_website_interview_proposal',arguments:JSON.stringify({...args,interpretation:'Podemos atender todo o país sem autorização.'})}]}});
  expect(h.commits).toHaveLength(1);expect(JSON.parse(h.sent.find(x=>x.item?.call_id==='conflicting_new_id').item.output).saved).toBe(false);
 }finally{h.runtime.stop();}
});

test('a real new owner correction creates a new interpreted revision without waiting for either ASR',async()=>{
 const h=harness();try{
  await h.runtime.attach();await ordinaryWithoutAsr(h,'original',{proposal:{kind:'answer',itemId:h.agenda.items[0].id},interpretation:territoryInterpretation});
  await ordinaryWithoutAsr(h,'new_correction',{proposal:{kind:'correction',affectedItems:[{itemId:h.agenda.items[0].id,disposition:'corrected'}]},
   interpretation:'Corrija: atendemos também Sonoma. Qualquer cidade além das quatro ainda exige minha aprovação.'});
  expect(h.commits).toHaveLength(2);expect(h.records).toHaveLength(0);expect(h.stored().revision).toBe(2);
  expect(h.stored().agenda.items[0].status).toBe('corrected');expect(h.stored().agenda.items[0].evidence.at(-1).text).toContain('Sonoma');
 }finally{h.runtime.stop();}
});

test('final consent alone waits for actual recorded ASR and cannot use interpretation as approval',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();await completeCheckpoint(h,'consent_review');
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'consent_without_asr'});await h.emit({type:'input_audio_buffer.committed',item_id:'consent_without_asr'});
  await h.emit({type:'response.created',response:{id:'consent_response'}});
  await h.emit({type:'response.done',response:{id:'consent_response',status:'completed',output:[{type:'function_call',status:'completed',call_id:'consent_tool',
   name:'approve_website_interview',arguments:'{}'}]}});
  expect(h.approvals).toHaveLength(0);expect(h.records).toHaveLength(0);
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'consent_without_asr',transcript:'Eu aprovo este resumo.'});await settleEvidence();
  expect(h.approvals).toHaveLength(1);expect(h.records[0].text).toBe('Eu aprovo este resumo.');
 }finally{h.runtime.stop();}
});

test('facts-only primary answer saves while an optional target without content stays open',async()=>{
 const h=harness({contentFixture:true});try{
  await h.runtime.attach();const fact={topic:'area',field:'area.out_of_area_policy',disposition:'answered',rule_text:'Fora da área somente com aprovação explícita do dono.',structured:{value:'Somente após aprovação explícita do dono.'}};
  await ordinaryWithoutAsr(h,'partial',{proposal:{kind:'answer',itemId:'current',relatedItemIds:['extra']},facts:[fact]});
  expect(h.commits).toHaveLength(1);expect(h.stored().agenda.items[0].status).toBe('answered');expect(h.stored().agenda.items[1].status).toBe('open');
  expect(h.commits[0].proposal.relatedItemIds).toEqual([]);expect(h.commits[0].facts[0]).not.toHaveProperty('owner_words');
  expect(JSON.parse(h.sent.find(x=>x.item?.call_id==='tool_partial').item.output).omittedRelatedItemIds).toEqual(['extra']);
 }finally{h.runtime.stop();}
});

test('malformed or forbidden optional facts do not become an indiscriminate partial commit',async()=>{
 const h=harness({contentFixture:true});try{
  await h.runtime.attach();
  await ordinaryWithoutAsr(h,'invalid_fact',{proposal:{kind:'answer',itemId:'current',relatedItemIds:['extra']},facts:[
   {topic:'area',field:'area.out_of_area_policy',disposition:'answered',rule_text:'Exige aprovação.',structured:{value:'Exige aprovação.'}},
   {topic:'authority',field:'authority.book',disposition:'answered',rule_text:'Pode agendar.',structured:{value:'Pode agendar sem consultar o dono.'}},
  ]});
  expect(h.commits).toHaveLength(0);expect(h.stored().agenda.items.every(item=>item.status==='open')).toBe(true);
 }finally{h.runtime.stop();}
});

test('defer without invented answer content remains an explicit pending disposition',async()=>{
 const h=harness();try{
  await h.runtime.attach();await ordinaryWithoutAsr(h,'deferred_only',{proposal:{kind:'defer',itemId:h.agenda.items[0].id}});
  expect(h.commits).toHaveLength(1);expect(h.records).toHaveLength(0);expect(h.stored().agenda.items[0].status).toBe('deferred_owner_review');
  const evidence=h.stored().agenda.items[0].evidence.at(-1);expect(evidence.provenance).toBe('model_interpretation');
  expect(JSON.parse(evidence.text)).toEqual({kind:'defer',itemId:h.agenda.items[0].id});
 }finally{h.runtime.stop();}
});

test('replay after a later write returns the first operation receipt and the latest authoritative context',async()=>{
 const h=harness();try{
  await h.runtime.attach();await h.ready();await beginIssued(h,'later_replay_opening');await h.emit({type:'response.done',response:{id:'later_replay_opening',status:'completed',output:[]}});
  const args={proposal:{kind:'answer',itemId:h.agenda.items[0].id},interpretation:territoryInterpretation};
  await ordinaryWithoutAsr(h,'old_operation',args);const oldRequest=lastRequest(h),oldReceipt=h.operations.get('old_operation')!;
  await ordinaryWithoutAsr(h,'later_operation',{proposal:{kind:'answer',itemId:h.stored().nextAction.itemId},interpretation:'A garantia depende da instalação feita por nossa equipe.'});
  const currentReceipt=h.stored().receiptId;expect(currentReceipt).not.toBe(oldReceipt.receiptId);
  await h.emit({type:'response.created',response:{id:'late_old_operation',metadata:oldRequest.response.metadata}});
  await h.emit({type:'response.done',response:{id:'late_old_operation',status:'completed',output:[{type:'function_call',status:'completed',call_id:'new_id_old_operation',
   name:'submit_website_interview_proposal',arguments:JSON.stringify(args)}]}});
  const result=JSON.parse(h.sent.find(x=>x.item?.call_id==='new_id_old_operation').item.output);
  expect(h.commits).toHaveLength(2);expect(result).toMatchObject({saved:true,replayed:true,savedReceiptId:oldReceipt.receiptId,savedRevision:1,revision:2});
  expect(result.context.revision).toBe(2);expect(h.stored().receiptId).toBe(currentReceipt);
 }finally{h.runtime.stop();}
});

test('late ordinary ASR cannot invalidate a recorded recap or a later genuine approval',async()=>{
 const h=harness({lastOpen:true});try{
  await h.runtime.attach();await h.ready();await beginIssued(h,'late_asr_opening');await h.emit({type:'response.done',response:{id:'late_asr_opening',status:'completed',output:[]}});
  await ordinaryWithoutAsr(h,'answer_without_asr',{proposal:{kind:'not_applicable',itemId:h.stored().nextAction.itemId},interpretation:'Este requisito não se aplica à empresa.'});
  await completeCheckpoint(h,'late_asr_review');await ownerTool(h,'fresh_consent','Eu aprovo este resumo.','approve_website_interview',{});
  const before=JSON.stringify(h.stored());expect(h.approvals).toHaveLength(1);
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'answer_without_asr',transcript:'Esse requisito não se aplica.'});await settleEvidence();
  expect(JSON.stringify(h.stored())).toBe(before);expect(h.approvals).toHaveLength(1);expect(h.commits).toHaveLength(1);
  expect(h.records.map(x=>x.providerItemId)).toEqual(['fresh_consent','answer_without_asr']);
 }finally{h.runtime.stop();}
});

test('closing amendment can persist interpreted correction before its final ASR',async()=>{
 const h=harness({reviewing:true});try{
  await h.runtime.attach();await h.ready();await completeCheckpoint(h,'native_amendment_review');
  await ownerTool(h,'native_amendment_consent','Eu aprovo este resumo.','approve_website_interview',{});
  await ordinaryWithoutAsr(h,'native_closing_correction',{proposal:{kind:'correction',affectedItems:[{itemId:h.agenda.items[0].id,disposition:'corrected'}]},interpretation:'Corrija a cidade: inclua Sonoma.'});
  expect(h.amendments).toHaveLength(1);expect(h.amendments[0].interpretation).toBe('Corrija a cidade: inclua Sonoma.');
  expect(h.records.map(x=>x.providerItemId)).toEqual(['native_amendment_consent']);expect(h.commits).toHaveLength(0);expect(h.approvals).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('missing approval ASR has a bounded cancelable wait and never approves from the tool alone',async()=>{
 const timers=new Map<object,{callback:()=>void;ms:number}>(),originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 globalThis.setTimeout=((callback:()=>void,ms:number)=>{const id={};timers.set(id,{callback,ms});return id;}) as any;
 globalThis.clearTimeout=((id:object)=>timers.delete(id)) as any;
 const h=harness({reviewing:true});let queued=Promise.resolve();h.deps.enqueue=(task:()=>Promise<void>)=>queued=Promise.resolve().then(task);
 try{
  await h.runtime.attach();await h.ready();await completeCheckpoint(h,'no_asr_consent_review');
  await h.emit({type:'input_audio_buffer.speech_started',item_id:'no_asr_consent'});await h.emit({type:'input_audio_buffer.committed',item_id:'no_asr_consent'});
  await h.emit({type:'response.created',response:{id:'no_asr_consent_response'}});
  await h.emit({type:'response.done',response:{id:'no_asr_consent_response',status:'completed',output:[{type:'function_call',status:'completed',
   call_id:'no_asr_consent_tool',name:'approve_website_interview',arguments:'{}'}]}});
  expect(h.approvals).toHaveLength(0);const deadline=[...timers.entries()].find(([,value])=>value.ms===8000);expect(deadline).toBeTruthy();
  timers.delete(deadline![0]);deadline![1].callback();await queued;
  expect(h.approvals).toHaveLength(0);expect(h.stored().state).toBe('reviewing');
  expect(JSON.parse(h.sent.find(x=>x.item?.call_id==='no_asr_consent_tool').item.output)).toMatchObject({saved:false,code:'owner_evidence_unavailable'});
  const sent=h.sent.length;h.runtime.stop();await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'no_asr_consent',transcript:'Eu aprovo este resumo.'});
  expect(h.approvals).toHaveLength(0);expect(h.sent).toHaveLength(sent);
 }finally{h.runtime.stop();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('ASR failure or a conflicting duplicate preserves interpreted state and does not overwrite evidence',async()=>{
 const h=harness();try{
  await h.runtime.attach();await ordinaryWithoutAsr(h,'asr_failure',{proposal:{kind:'answer',itemId:h.agenda.items[0].id},interpretation:territoryInterpretation});
  const before=JSON.stringify(h.stored());
  await h.emit({type:'conversation.item.input_audio_transcription.failed',item_id:'asr_failure',error:{code:'transcription_failed'}});
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'asr_failure',transcript:'Primeira transcrição real.'});await settleEvidence();
  await h.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'asr_failure',transcript:'Outra transcrição conflitante.'});await settleEvidence();
  expect(h.records).toHaveLength(1);expect(h.records[0].text).toBe('Primeira transcrição real.');
  expect(h.commits).toHaveLength(1);expect(JSON.stringify(h.stored())).toBe(before);expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});
