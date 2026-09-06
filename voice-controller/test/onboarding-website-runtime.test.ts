import { describe, expect, test } from "bun:test";
import { createWebsiteInterviewRuntime, websiteInterpretationRequest } from "../src/onboarding-website-runtime.ts";
import { createWebsiteAgendaCoordinator, buildWebsiteOpeningAction, reduceWebsiteAgenda } from "../src/onboarding-agenda-coordinator.ts";
import { createOnboardingAgenda, getAgendaAction } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";
import { createHash } from "node:crypto";
const callId="11111111-1111-4111-8111-111111111111",requestId="22222222-2222-4222-8222-222222222222";
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
function base(){
 const agenda=createOnboardingAgenda({callId,interviewId:callId,draftId:requestId,draftHash:'a'.repeat(64),sourceResultId:requestId,sourceResultHash:'b'.repeat(64)},[
  {id:'cities',subject:'area',source:'ambiguity',questionPt:'Quais cidades exatas atende?',coverageRefs:['area.coverage'],relatedItemIds:[],blocking:true},
  {id:'hours',subject:'agenda',source:'contradiction',questionPt:'Qual o horário de sábado?',coverageRefs:['schedule.business_hours'],relatedItemIds:[],blocking:true},
 ]);
 const stored={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:requestId,nextAction:getAgendaAction(agenda),state:'unfinished' as const,replayed:false};
 const openingAction=buildWebsiteOpeningAction(stored,'D1F Marketing');
 const bytes=Buffer.from('ID3sample-audio');
 const payload=(a:any)=>({...a,schema:'onboarding.speech.v1',text_sha256:hash(a.text),audio_base64:bytes.toString('base64'),audio_sha256:hash(bytes),mime:'audio/mpeg',voice:'ash',tts_model:'tts-1-hd',cost_usd:Number(([...a.text].length*30/1e6).toFixed(8))});
 return{stored,openingAction,openingPayload:payload(openingAction),payload};
}
describe('website interview serialized transport adapter',()=>{
 test('interpretation is silent out-of-band one tool with only current relevant context',()=>{
  const b=base();let state=createWebsiteAgendaCoordinator(b.stored,{nowMs:0,openingAction:b.openingAction});
  state=reduceWebsiteAgenda(state,{type:'opening.played',nowMs:1}).state;
  let r=reduceWebsiteAgenda(state,{type:'owner.transcript',providerItemId:'owner1',text:'Somente Novato.',nowMs:2});
  const c=r.commands[0] as any;
  r=reduceWebsiteAgenda(r.state,{type:'owner_turn.recorded',requestId:c.requestId,providerItemId:c.providerItemId,turnId:c.turnId,text:c.text,nowMs:3});
  const request=websiteInterpretationRequest(r.commands[0] as any);
  expect(request.response.conversation).toBe('none');expect(request.response.output_modalities).toEqual(['text']);
  expect(request.response.tools).toHaveLength(1);expect(request.response.tool_choice.name).toBe('submit_website_interview_proposal');
  expect(JSON.stringify(request)).not.toContain('Qual o horário de sábado?');
  expect(JSON.stringify(request)).toContain('Somente Novato.');
 });
 test('exact played ACK then ASR->proposal->CAS->one controlled speech; duplicate events no repeat',async()=>{
  const b=base(),sent:any[]=[],spoken:any[]=[],transcripts:any[]=[],commits:any[]=[];
  let runtime:any;
  const scope={ownerId:requestId,callId,requestId};
  const evidence={
   recordSpeechPlayed:async()=>({receiptId:requestId}),
   claimSpeech:async({action}:any)=>({status:'preparing',claimed:true,action,noticeId:`lsn-${action.actionId.slice(0,28)}`}),
   completeSpeech:async({payload}:any)=>({status:'ready',payload,action:payload}),failSpeech:async()=>({}),
  };
  runtime=createWebsiteInterviewRuntime({prepared:{scope,stored:b.stored,projection:{} as any},openingAction:b.openingAction,openingPayload:b.openingPayload as any}, {
   agendaStore:{recordOwnerTranscript:async(x:any)=>({...x,turnId:`${callId}:${x.providerItemId}`}),commitOwnerTurn:async(x:any)=>{
    commits.push(x);return{...b.stored,agenda:x.agenda,revision:x.agenda.revision,storeVersion:1,digest:onboardingAgendaDigest(x.agenda),nextAction:Object.fromEntries(Object.entries(x.nextAction).reverse())};
   }},evidenceStore:evidence,synthesize:async(a:any)=>{spoken.push(a);return b.payload(a);},
   send:e=>sent.push(e),enqueue:async f=>f(),onTranscript:t=>transcripts.push(t),onCost:()=>{},onUsage:()=>{},onTerminate:()=>{},onState:()=>{},now:()=>Date.now(),
  } as any);
  await runtime.attach();
  await runtime.handleEvent({type:'conversation.item.created',item:{id:`lgs-${b.openingAction.actionId.slice(0,28)}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:b.openingAction.text}]}});
  await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'owner1'});
  await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner1',transcript:'Somente Novato.'});
  const request=sent.find(e=>e.type==='response.create');expect(request).toBeDefined();
  const response={id:'resp_1',status:'completed',metadata:request.response.metadata,
   output:[{type:'function_call',name:'submit_website_interview_proposal',call_id:'tool_1',status:'completed',arguments:JSON.stringify({proposal:{kind:'answer',itemId:'cities'}})}]};
  await runtime.handleEvent({type:'response.created',response});await runtime.handleEvent({type:'response.done',response});
  await runtime.handleEvent({type:'response.done',response});
  expect(commits).toHaveLength(1);expect(spoken).toHaveLength(1);
  expect(spoken[0].text).toContain('Qual o horário de sábado?');
  expect(sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  expect(transcripts.map(t=>t.role)).toEqual(['agent','caller']);
  await runtime.attach();
  expect(sent.filter(e=>e.type==='conversation.item.create' && e.item?.role==='system')).toHaveLength(1);
  expect(sent.at(-1).type).toBe('conversation.item.retrieve');runtime.stop();
 });
 test('stopping during TTS marks usage unknown and prevents a late publication or detached ledger mutation',async()=>{
  const b=base(),sent:any[]=[],costs:number[]=[],published:any[]=[],unknown:number[]=[];
  let finish!:(value:any)=>void,started=false;
  const runtime=createWebsiteInterviewRuntime({prepared:{scope:{ownerId:requestId,callId,requestId},stored:b.stored,projection:{} as any},
   openingAction:b.openingAction,openingPayload:b.openingPayload as any},{
   agendaStore:{} as any,evidenceStore:{claimSpeech:async({action}:any)=>({status:'preparing',claimed:true,action}),
    completeSpeech:async(x:any)=>{published.push(x);return{status:'ready',payload:x.payload};},failSpeech:async()=>({})} as any,
   synthesize:async()=>{started=true;return new Promise(resolve=>{finish=resolve;});},
   send:e=>sent.push(e),enqueue:async f=>f(),onTranscript:()=>{},onCost:cost=>costs.push(cost),onUsage:()=>{},
   onUsageUnknown:()=>unknown.push(1),onTerminate:()=>{},onState:()=>{},
  });
  const pending=runtime.handleEvent({type:'session.updated',session:{output_modalities:['audio'],audio:{input:{turn_detection:{create_response:true,interrupt_response:true}}}}});
  for(let i=0;i<100&&!started;i++)await Promise.resolve();
  expect(started).toBe(true);runtime.stop();finish(b.payload(runtime.state.speech!.action));await pending;
  expect(unknown).toHaveLength(1);expect(costs).toHaveLength(0);expect(published).toHaveLength(0);
  expect(sent.filter(e=>e.type==='conversation.item.create')).toHaveLength(0);
 });
});

function recoveryHarness(){
 const b=base(),sent:any[]=[],spoken:any[]=[],receipts:any[]=[],transcripts:any[]=[],terminations:any[]=[],completions:any[]=[];
 let stored:any=b.stored,clock=Date.now(),sequence=0;
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):value;
 const body={version:1,provenance:{...b.stored.agenda.binding,authority:{}},candidateRecap:[],seeds:b.stored.agenda.items.map(({id,source,subject,questionPt,coverageRefs,relatedItemIds,blocking})=>({id,source,subject,questionPt,coverageRefs,relatedItemIds,blocking}))};
 const projection={...body,seedsHash:hash(JSON.stringify(canonical(body)))};
 const payloads=new Map<string,any>([[b.openingAction.actionId,b.openingPayload]]);
 const providerItems=new Map<string,any>(),plays:string[]=[];
 const runtime=createWebsiteInterviewRuntime({prepared:{scope:{ownerId:requestId,callId,requestId},stored,projection:projection as any},openingAction:b.openingAction,openingPayload:b.openingPayload as any},{
  agendaStore:{recordOwnerTranscript:async(x:any)=>({...x,turnId:`${callId}:${x.providerItemId}`}),
   commitOwnerTurn:async(x:any)=>{stored={...stored,agenda:x.agenda,revision:x.agenda.revision,storeVersion:stored.storeVersion+1,digest:onboardingAgendaDigest(x.agenda),nextAction:x.nextAction,state:x.nextAction.type==='GENERATE_FINAL_SUMMARY'?'reviewing':'unfinished'};return stored;},
   readWebsiteInterview:async()=>stored} as any,
  evidenceStore:{recordSpeechPlayed:async(x:any)=>{receipts.push(x);return{receiptId:requestId};},
   claimSpeech:async({action}:any)=>({status:'preparing',claimed:true,action}),completeSpeech:async({payload}:any)=>({status:'ready',payload}),failSpeech:async()=>({}),
   prepareSummary:async(x:any)=>({summaryId:x.summaryId,revision:x.expectedRevision,digest:x.expectedDigest,parts:x.parts,summaryHash:hash(JSON.stringify([x.summaryId,x.expectedRevision,x.expectedDigest,x.parts])),receiptId:requestId}),
   approveSummary:async(x:any)=>({approvalReceiptId:requestId,turnId:`${callId}:${x.providerItemId}`,summaryId:x.summaryId,summaryHash:x.summaryHash,revision:x.expectedRevision,digest:x.expectedDigest,storeVersion:x.expectedStoreVersion+1}),
   recordCompletion:async(x:any)=>{completions.push(x);return{receiptId:requestId,interviewId:callId,callId,outcome:x.outcome,approvalReceiptId:x.approvalReceiptId};}} as any,
  synthesize:async(a:any)=>{spoken.push(a);const p=b.payload(a);payloads.set(a.actionId,p);return p as any;},
  send:e=>sent.push(e),enqueue:async f=>f(),onTranscript:t=>transcripts.push(t),onCost:()=>{},onUsage:()=>{},onUsageUnknown:()=>{},onTerminate:t=>terminations.push(t),onState:()=>{},now:()=>clock,
 });
 const current=()=>runtime.state.phase==='opening'?b.openingPayload:payloads.get(runtime.state.speech!.action.actionId);
 async function play(deliver=true){const p=current(),id=`lgs-${p.actionId.slice(0,28)}`;if(providerItems.has(id))throw new Error('browser must never replay');
  const item={id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:p.text}]};providerItems.set(id,item);plays.push(p.actionId);
  if(deliver)await runtime.handleEvent({type:'conversation.item.created',item});return item;}
 async function answer(itemId:string){const id=`owner-${++sequence}`;await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:id});
  await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:`Minha resposta sobre ${itemId}.`});
  const request=sent.filter(e=>e.type==='response.create').at(-1);
  await runtime.handleEvent({type:'response.done',response:{id:`response-${sequence}`,status:'completed',metadata:request.response.metadata,output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',call_id:`tool-${sequence}`,arguments:JSON.stringify({proposal:{kind:'answer',itemId},facts:[]})}]}});}
 async function recover(){const frame=sent.filter(e=>e.type==='conversation.item.retrieve' && e.item_id?.startsWith('lgs-')).at(-1);expect(frame).toBeDefined();
  const item=providerItems.get(frame.item_id);expect(item).toBeDefined();await runtime.handleEvent({type:'conversation.item.retrieved',event_id:'provider-generated-event',item});return {frame,item};}
 return{runtime,sent,spoken,receipts,transcripts,terminations,completions,plays,current,play,answer,recover,advance:(ms:number)=>{clock+=ms;}};
}

test('lost opening ACK is recovered by exact lgs retrieval without replay or deadline extension',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();const deadline=h.runtime.state.openingDeadlineAtMs;await h.play(false);h.advance(500);
  await h.runtime.attach();expect(h.runtime.state.openingDeadlineAtMs).toBe(deadline);
  const {item}=await h.recover();await h.runtime.handleEvent({type:'conversation.item.retrieved',item});
  expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.plays).toHaveLength(1);expect(h.spoken).toHaveLength(0);expect(h.receipts).toHaveLength(1);expect(h.transcripts).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('lost ordinary speech ACK recovers current action once and retires old action proof',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();const opening=await h.play();await h.answer('cities');expect(h.runtime.state.speech?.action.kind).toBe('CONFIRM_AND_ASK_NEXT');
  const action=h.current(),deadline=h.runtime.state.speech!.deadlineAtMs;await h.play(false);await h.runtime.attach();
  await h.runtime.handleEvent({type:'conversation.item.retrieved',item:opening});expect(h.receipts).toHaveLength(1);expect(h.runtime.state.speech!.action.actionId).toBe(action.actionId);
  expect(h.runtime.state.speech!.deadlineAtMs).toBe(deadline);const {item}=await h.recover();await h.runtime.handleEvent({type:'conversation.item.retrieved',item});
  expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.plays).toHaveLength(2);expect(h.spoken).toHaveLength(1);expect(h.receipts).toHaveLength(2);
  expect(h.sent.filter(e=>e.type==='conversation.item.create' && e.item?.role==='system')).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('lost final signoff ACK recovers existing provider proof and terminates exactly once',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.play();await h.answer('cities');await h.play();await h.answer('hours');
  for(let part=0;part<16 && h.runtime.state.speech?.action.kind==='GENERATE_FINAL_SUMMARY';part++)await h.play();
  expect(h.runtime.state.speech?.action.kind).toBe('REQUEST_FINAL_APPROVAL');await h.play();
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'approval'});
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'approval',transcript:'Está tudo correto. Confirmo.'});
  expect(h.runtime.state.speech?.action.kind).toBe('SPEAK_FINAL_SIGNOFF');const signoff=h.current();await h.play(false);await h.runtime.attach();
  const {item}=await h.recover();await h.runtime.handleEvent({type:'conversation.item.retrieved',item});
  expect(h.spoken.filter(a=>a.kind==='SPEAK_FINAL_SIGNOFF')).toHaveLength(1);expect(h.plays.filter(id=>id===signoff.actionId)).toHaveLength(1);
  expect(h.receipts.filter(r=>r.actionId===signoff.actionId)).toHaveLength(1);expect(h.terminations).toHaveLength(1);expect(h.terminations[0].outcome).toBe('complete');
  await h.runtime.finalized({providerReceiptId:'provider-proof',budgetReceiptId:'budget-proof'});expect(h.completions).toHaveLength(1);expect(h.runtime.state.phase).toBe('complete');
 }finally{h.runtime.stop();}
});

test('retrieve misses are only fenced negative evidence and stale or wrong errors cannot advance',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.runtime.attach();const frame=h.sent.find(e=>e.item_id?.startsWith('lgs-'));expect(frame).toBeDefined();
  const deadline=h.runtime.state.openingDeadlineAtMs;
  const miss={type:'error',error:{event_id:frame.event_id,code:'item_not_found'}};
  expect((h.runtime as any).ownsSpeechRetrieveMiss(miss)).toBe(true);await h.runtime.handleEvent(miss);
  const fallback={type:'error',error:{event_id:frame.event_id,type:'invalid_request_error',param:'item_id',code:'invalid_request_error',message:`Item '${frame.item_id}' does not exist.`}};
  expect((h.runtime as any).ownsSpeechRetrieveMiss(fallback)).toBe(true);
  await h.runtime.handleEvent(fallback);
  expect((h.runtime as any).ownsSpeechRetrieveMiss({...fallback,error:{...fallback.error,message:`Item '${frame.item_id}' not found.`}})).toBe(true);
  for(const changed of [{event_id:'stale'},{type:'server_error'},{param:'other'},{code:'other_error'},{message:'Item not found.'},{message:`Item '${frame.item_id}x' not found.`},{message:`Item '${frame.item_id}' is invalid.`}])
   expect((h.runtime as any).ownsSpeechRetrieveMiss({...fallback,error:{...fallback.error,...changed}})).toBe(false);
  await h.runtime.handleEvent({type:'conversation.item.retrieved',item:{id:'lgs-wrong-action'}});expect(h.receipts).toHaveLength(0);expect(h.spoken).toHaveLength(0);
  expect(h.runtime.state.phase).toBe('opening');expect(h.runtime.state.openingDeadlineAtMs).toBe(deadline);
  await h.runtime.attach();expect((h.runtime as any).ownsSpeechRetrieveMiss(miss)).toBe(false);
  const currentFrame=h.sent.filter(e=>e.item_id?.startsWith('lgs-')).at(-1);const currentMiss={...miss,error:{...miss.error,event_id:currentFrame.event_id}};
  await h.play();expect((h.runtime as any).ownsSpeechRetrieveMiss(currentMiss)).toBe(false);
  h.runtime.stop();const count=h.sent.length;await expect(h.runtime.attach()).rejects.toThrow('website_runtime_stopped');expect(h.sent).toHaveLength(count);
 }finally{h.runtime.stop();}
});

test('retrieved current lgs item with altered text cannot record playback or keep old retrieve authority',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.runtime.attach();const frame=h.sent.find(e=>e.item_id?.startsWith('lgs-'));
  const miss={type:'error',error:{event_id:frame.event_id,code:'item_not_found'}};
  expect((h.runtime as any).ownsSpeechRetrieveMiss(miss)).toBe(true);
  await h.runtime.handleEvent({type:'conversation.item.retrieved',item:{id:frame.item_id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Outra fala, não reproduzida.'}]}});
  expect(h.receipts).toHaveLength(0);expect(h.runtime.state.phase).not.toBe('awaiting_owner');
  expect((h.runtime as any).ownsSpeechRetrieveMiss(miss)).toBe(false);
 }finally{h.runtime.stop();}
});
