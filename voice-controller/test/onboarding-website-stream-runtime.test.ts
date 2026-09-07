import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createWebsiteInterviewRuntime,prepareWebsiteStreamOpening} from '../src/onboarding-website-runtime.ts';
import {buildWebsiteOpeningAction} from '../src/onboarding-agenda-coordinator.ts';
import {createOnboardingAgenda,getAgendaAction} from '../src/onboarding-agenda.ts';
import {onboardingAgendaDigest} from '../src/onboarding-agenda-store.ts';
import {streamControlId,websiteStreamTranscriptMatches,type StreamAuthorization} from '../src/onboarding-stream.ts';
import {createWebsiteStreamPlayer} from '../../dashboard/src/voice/website-stream.js';
const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function harness(model?:string,relatedTerritory=false){
 const scope={ownerId:id(1),callId:id(2),requestId:id(3)};
 const agenda=createOnboardingAgenda({callId:scope.callId,interviewId:scope.callId,draftId:id(4),draftHash:'a'.repeat(64),sourceResultId:id(5),sourceResultHash:'b'.repeat(64)},[
  {id:'cities',source:'ambiguity',subject:'area',questionPt:'Quais cidades atende?',coverageRefs:['area.coverage'],relatedItemIds:relatedTerritory?['source-area']:[],blocking:true},
  ...(relatedTerritory?[{id:'source-area',source:'ambiguity' as const,subject:'area',questionPt:'Quais são os limites do território?',coverageRefs:['discovery.owner_question.area'],relatedItemIds:['cities'],blocking:true}]:[]),
  {id:'hours',source:'ambiguity',subject:'schedule',questionPt:'Qual o horário de sábado?',coverageRefs:['schedule.business_hours'],relatedItemIds:[],blocking:true},
 ]);
 let stored:any={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:id(6),nextAction:getAgendaAction(agenda),state:'unfinished',replayed:false};
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):v;
 const body={version:1,provenance:{...agenda.binding,authority:{}},candidateRecap:[],seeds:agenda.items.map(({id,source,subject,questionPt,coverageRefs,relatedItemIds,blocking})=>({id,source,subject,questionPt,coverageRefs,relatedItemIds,blocking}))};
 const prepared={scope,stored,projection:{...body,seedsHash:hash(canonical(body))} as any};
 const openingAction=buildWebsiteOpeningAction(stored,'Foghorn Air');let next=10;
 const authorize=(action:any):StreamAuthorization=>({schema:'onboarding.stream.v1',action,dispatchId:id(next++),receiptId:id(next++)});
 const openingStream=authorize(openingAction),streams=new Map([[openingAction.actionId,openingStream]]),proofs=new Map<string,any>();
 const sent:any[]=[],transcripts:any[]=[],commits:any[]=[],terminations:any[]=[],diagnostics:any[]=[],calls:string[]=[],usages:any[]=[];
 const proof=(input:any,kind:'generation'|'playout')=>{const p=proofs.get(input.stream.dispatchId)??{actionId:input.stream.action.actionId,dispatchId:input.stream.dispatchId,responseId:input.responseId,itemId:input.itemId};
  p[kind==='generation'?'generationReceiptId':'playoutReceiptId']=kind==='generation'?id(90):id(91);
  p.status=p.generationReceiptId&&p.playoutReceiptId?'played':p.generationReceiptId?'ready':'preparing';if(p.status==='played')p.receiptId=id(92);proofs.set(input.stream.dispatchId,p);return {...p};};
 const evidence:any={
  claimStream:async({action}:any)=>{calls.push('claimStream');const a=authorize(action);streams.set(action.actionId,a);return a;},
  authorizeStream:async({stream}:any)=>{calls.push('authorizeStream');return stream;},
  recordStreamResponse:async(input:any)=>{calls.push('generation');if(!websiteStreamTranscriptMatches(input.stream.action,input.transcript))return{actionId:input.stream.action.actionId,dispatchId:input.stream.dispatchId,responseId:input.responseId,itemId:input.itemId,status:'rejected',generationReceiptId:id(90),reason:'transcript_mismatch'};return proof(input,'generation');},
  recordStreamPlayout:async(input:any)=>{calls.push('playout');return proof(input,'playout');},
  interruptSpeech:async(x:any)=>{calls.push('interrupt');return{receiptId:id(80),...x};},
  recordEmptyInput:async(x:any)=>({receiptId:id(81),callId:x.callId,actionId:x.actionId,providerItemId:x.providerItemId}),
  resumeStream:async({actionId,providerItemId}:any)=>{calls.push('resume');const old=streams.get(actionId)!;
   const action={...old.action,actionId:hash([actionId,providerItemId,next]),...(old.action.actionId===openingAction.actionId?{text:stored.nextAction.spokenPt}:{})};
   const stream=authorize(action);streams.set(action.actionId,stream);return stream;},
  prepareSummary:async(x:any)=>({summaryId:x.summaryId,summaryHash:hash([x.summaryId,x.expectedRevision,x.expectedDigest,x.parts]),revision:x.expectedRevision,digest:x.expectedDigest,parts:x.parts,receiptId:id(82)}),
  approveSummary:async(x:any)=>({approvalReceiptId:id(83),turnId:`${scope.callId}:${x.providerItemId}`,summaryId:x.summaryId,summaryHash:x.summaryHash,revision:x.expectedRevision,digest:x.expectedDigest,storeVersion:x.expectedStoreVersion+1}),
  recordCompletion:async(x:any)=>({receiptId:id(84),interviewId:scope.callId,callId:scope.callId,outcome:x.outcome,approvalReceiptId:x.approvalReceiptId}),
  failSpeech:async({actionId}:any)=>({status:'failed',action:streams.get(actionId)!.action}),
  requestAmendment:async(x:any)=>({approvalReceiptId:x.approvalReceiptId,providerItemId:x.providerItemId,receiptId:id(85)}),
 };
 const agendaStore:any={recordOwnerTranscript:async(x:any)=>({...x,turnId:`${scope.callId}:${x.providerItemId}`}),readWebsiteInterview:async()=>stored,
  commitOwnerTurn:async(x:any)=>{commits.push(x);stored={...stored,agenda:x.agenda,revision:x.agenda.revision,digest:onboardingAgendaDigest(x.agenda),storeVersion:stored.storeVersion+1,nextAction:x.nextAction,state:x.nextAction.type==='GENERATE_FINAL_SUMMARY'?'reviewing':'unfinished'};return stored;}};
 const runtime=createWebsiteInterviewRuntime({prepared,openingAction,openingStream} as any,{
  model,evidenceStore:evidence,agendaStore,
  synthesize:async()=>{throw new Error('TTS forbidden');},enqueue:async f=>f(),send:e=>sent.push(e),onTranscript:e=>transcripts.push(e),onCost:()=>{throw new Error('TTS charge forbidden');},
  onUsage:r=>usages.push(r),onUsageUnknown:()=>{},onTerminate:c=>terminations.push(c),onState:()=>{},onDiagnostic:d=>diagnostics.push(d),
 });
 const control=(kind:'ready'|'played',stream:StreamAuthorization,value:any)=>({type:'conversation.item.done',item:{id:streamControlId(kind,stream.dispatchId),type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_stream_${kind}:${JSON.stringify(value)}`}]}});
 async function ready(stream=openingStream){await runtime.handleEvent(control('ready',stream,{actionId:stream.action.actionId,dispatchId:stream.dispatchId}));return sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='audio').at(-1);}
 async function generation(frame:any,stream=openingStream,text=stream.action.text){const responseId=`resp-${stream.dispatchId}`,itemId=`item-${stream.dispatchId}`;
  await runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
  await runtime.handleEvent({type:'response.output_item.added',response_id:responseId,output_index:0,item:{id:itemId,type:'message',role:'assistant',status:'in_progress',content:[]}});
  await runtime.handleEvent({type:'output_audio_buffer.started',event_id:'started-'+responseId,response_id:responseId});
  await runtime.handleEvent({type:'response.output_audio_transcript.done',response_id:responseId,item_id:itemId,output_index:0,content_index:0,transcript:text});
  await runtime.handleEvent({type:'response.done',response:{id:responseId,metadata:frame.response.metadata,status:'completed',output:[{id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'output_audio',transcript:text}]}]}});
  return{responseId,itemId};}
 async function played(stream=openingStream){const responseId=`resp-${stream.dispatchId}`,itemId=`item-${stream.dispatchId}`;
  await runtime.handleEvent(control('played',stream,{actionId:stream.action.actionId,dispatchId:stream.dispatchId,responseId,itemId,bufferStoppedEventId:'buffer-'+responseId,
   mediaEvidence:{schema:'onboarding.stream.media.v1',nonzeroSamples:100,observedMs:1000,firstSampleAtMs:10,lastSampleAtMs:1010,unmuted:true,playbackStarted:true}}));}
 const current=()=>streams.get(runtime.state.speech?.action.actionId??runtime.state.openingAction.actionId)!;
 async function say(stream=current()){const frame=await ready(stream);await generation(frame,stream);await played(stream);}
 async function owner(text:string,proposal?:unknown,facts:unknown[]=[]){const item=`owner-${next++}`;
  await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:item});
  await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:item,transcript:text});
  if(proposal){const frame=sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='text').at(-1);
   await runtime.handleEvent({type:'response.done',response:{id:'interpret-'+item,metadata:frame.response.metadata,status:'completed',output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',arguments:JSON.stringify({proposal,facts})}]}});}
 }
 return{runtime,prepared,openingAction,openingStream,streams,sent,calls,transcripts,commits,terminations,diagnostics,usages,ready,generation,played,evidence,agendaStore,current,say,owner,control};
}
test('stream opening waits for browser readiness, dispatches once with no TTS, and joins generation with client playout',async()=>{
 const h=harness();try{
  await h.runtime.attach();expect(h.sent.some(e=>e.type==='response.create')).toBe(false);
  expect(h.sent.find(e=>e.type==='session.update')?.session.audio.input.transcription).toEqual({model:'gpt-live-transcribe',languages:['pt']});
  const frame=await h.ready();await h.ready();
  expect(frame.response).toMatchObject({conversation:'none',output_modalities:['audio'],tools:[],tool_choice:'none'});
  expect(h.calls.filter(x=>x==='authorizeStream')).toHaveLength(1);
  await h.generation(frame);expect(h.runtime.state.phase).toBe('opening');
  expect(h.transcripts).toHaveLength(0);await h.played();
  expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.transcripts).toHaveLength(1);
  await h.played();expect(h.transcripts).toHaveLength(1);expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});

for(const model of ['gpt-realtime-2.1','gpt-realtime-2.1-mini'])test(`selected streamed speech uses minimal reasoning on ${model}, without changing owner interpretation`,async()=>{
 const h=harness(model);try{
  await h.runtime.attach();const frame=await h.ready();
  expect(frame.response.reasoning).toEqual({effort:'minimal'});
  expect(h.sent.find(e=>e.type==='session.update')?.session).not.toHaveProperty('reasoning');
  await h.generation(frame);await h.played();
  await h.owner('Atendemos apenas Novato e Petaluma.');
  const interpretation=h.sent.find(e=>e.type==='response.create'&&e.response.output_modalities[0]==='text');
  expect(interpretation).toBeDefined();expect(interpretation.response).not.toHaveProperty('reasoning');
 }finally{h.runtime.stop();}
});

for(const model of [undefined,'gpt-realtime','gpt-realtime-mini','gpt-realtime-2.1-unknown'])test(`selected streamed speech preserves compatibility with ${model??'unknown model'}`,async()=>{
 const h=harness(model);try{
  await h.runtime.attach();const frame=await h.ready();
  expect(frame.response).not.toHaveProperty('reasoning');
 }finally{h.runtime.stop();}
});

test('an unsupported optional territory expansion keeps the literal primary answer and asks the still-open related question',async()=>{
 const h=harness(undefined,true);try{
  const text='Hã, atendi só Recife e Olinda. Fora dessas cidades, não é para atender.';
  await h.runtime.attach();await h.say();await h.owner(text,{kind:'answer',itemId:'cities',relatedItemIds:['source-area']});
  expect(h.commits).toHaveLength(1);expect(h.commits[0].proposal).toEqual({kind:'answer',itemId:'cities',relatedItemIds:[]});
  expect(h.commits[0].ownerTranscript).toBe(text);expect(h.commits[0].facts).toEqual([]);
  expect(h.commits[0].nextAction.itemId).toBe('source-area');
  expect(h.runtime.state.stored.agenda.items.find(i=>i.id==='source-area')?.status).toBe('open');
  expect(h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='text')).toHaveLength(1);
  expect(h.diagnostics.some(d=>d.stage==='interpretation.related_targets_narrowed'&&d.targetCount===1)).toBe(true);
  expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('optional narrowing does not conceal a later illegal target or discard nonempty typed facts',async()=>{
 for(const [relatedItemIds,facts] of [[['source-area','hours'],[]],[['source-area'],[{}]]] as const){
  const h=harness(undefined,true);try{
   await h.runtime.attach();await h.say();await h.owner('Hã, atendi só Recife e Olinda. Fora dessas cidades, não é para atender.',
    {kind:'answer',itemId:'cities',relatedItemIds:[...relatedItemIds]},[...facts]);
   expect(h.commits).toHaveLength(0);expect(h.diagnostics.some(d=>d.stage==='interpretation.related_targets_narrowed')).toBe(false);
   expect(h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='text')).toHaveLength(2);
  }finally{h.runtime.stop();}
 }
});

test('client playout can arrive before generation, but only the joined proof advances',async()=>{
 const h=harness();try{
  await h.runtime.attach();const frame=await h.ready();await h.played();expect(h.calls).not.toContain('playout');
  await h.generation(frame);expect(h.runtime.state.phase).toBe('awaiting_owner');
  expect(h.calls.indexOf('playout')).toBeLessThan(h.calls.indexOf('generation'));
  expect(h.transcripts).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('GA content-part events use audio while the final assistant item uses output_audio',async()=>{
 const h=harness();try{
  await h.runtime.attach();const frame=await h.ready(),responseId=`resp-${h.openingStream.dispatchId}`,itemId=`item-${h.openingStream.dispatchId}`;
  await h.runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
  await h.runtime.handleEvent({type:'response.output_item.added',response_id:responseId,output_index:0,item:{id:itemId,type:'message',role:'assistant',status:'in_progress',content:[]}});
  for(const type of ['response.content_part.added','response.content_part.done']){
   await h.runtime.handleEvent({type,response_id:responseId,item_id:itemId,output_index:0,content_index:0,part:{type:'audio',transcript:type.endsWith('.done')?h.openingAction.text:''}});
   expect(h.runtime.state.error).toBeUndefined();
  }
  await h.generation(frame);await h.played();expect(h.runtime.state.phase).toBe('awaiting_owner');
  expect(h.transcripts).toHaveLength(1);expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('completed response carries final transcript when its standalone event is delayed',async()=>{
 const h=harness();try{
  await h.runtime.attach();const frame=await h.ready(),s=h.openingStream,responseId=`resp-${s.dispatchId}`,itemId=`item-${s.dispatchId}`;
  await h.runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
  await h.runtime.handleEvent({type:'response.done',response:{id:responseId,metadata:frame.response.metadata,status:'completed',output:[{id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'output_audio',transcript:s.action.text}]}]}});
  expect(h.calls).toContain('generation');expect(h.transcripts).toHaveLength(0);await h.played();
  await h.runtime.handleEvent({type:'response.output_audio_transcript.done',response_id:responseId,item_id:itemId,output_index:0,content_index:0,transcript:s.action.text});
  expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.calls.filter(x=>x==='generation')).toHaveLength(1);expect(h.transcripts).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('owner speech during the generation/playout join write does not interrupt already heard audio',async()=>{
 const h=harness();let release!:()=>void;
 const original=h.evidence.recordStreamResponse;
 h.evidence.recordStreamResponse=async(input:any)=>{const proof=await original(input);await new Promise<void>(resolve=>{release=resolve;});return proof;};
 try{
  await h.runtime.attach();const frame=await h.ready();await h.played();
  const generating=h.generation(frame);for(let i=0;i<100&&!release;i++)await Promise.resolve();expect(release).toBeDefined();
  h.runtime.observeEvent({type:'input_audio_buffer.speech_started',item_id:'after-local-playback'});
  expect(h.sent.some(e=>e.type==='response.cancel')).toBe(false);release();await generating;
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'after-local-playback',transcript:'Atendemos somente Novato.'});
  expect(h.calls).not.toContain('interrupt');expect(h.runtime.state.phase).toBe('interpreting');expect(h.runtime.state.error).toBeUndefined();
 }finally{release?.();h.runtime.stop();}
});

test.each(['recordStreamResponse','recordStreamPlayout'])('uncertain %s reconciles the same receipt without new speech or owner effects',async method=>{
 const h=harness();const original=h.evidence[method];let attempts=0;
 h.evidence[method]=async(input:any)=>{const result=await original(input);if(attempts++===0)throw Object.assign(new Error('private response lost after commit'),{code:'08006'});return result;};
 try{
  await h.runtime.attach();await h.say();
  expect(attempts).toBe(2);expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.transcripts).toHaveLength(1);
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(1);expect(h.commits).toHaveLength(0);
  expect(h.diagnostics.filter(d=>d.stage==='stream.receipt_retry')).toMatchObject([{attempt:1,code:'08006'}]);
  expect(JSON.stringify(h.diagnostics)).not.toContain('private response');
 }finally{h.runtime.stop();}
});

test('barge-in cancels and clears old audio before a new question-only rendition can start',async()=>{
 const h=harness();try{
  await h.runtime.attach();const old=h.openingStream,frame=await h.ready(),responseId=`resp-${old.dispatchId}`;
  await h.runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
  await h.runtime.handleEvent({type:'output_audio_buffer.started',event_id:'started',response_id:responseId});
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'empty-barge'});
  expect(h.sent.filter(e=>e.type==='response.cancel')).toMatchObject([{response_id:responseId}]);
  expect(h.sent.filter(e=>e.type==='output_audio_buffer.clear')).toHaveLength(1);
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'empty-barge',transcript:''});
  const resumed=h.current();expect(resumed.dispatchId).not.toBe(old.dispatchId);
  expect(resumed.action.text).toBe(h.runtime.state.stored.nextAction.spokenPt);expect(resumed.action.text).not.toContain('Aqui é o Ligou');
  await h.ready(resumed);expect(h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='audio')).toHaveLength(1);
  await h.runtime.handleEvent({type:'output_audio_buffer.cleared',event_id:'cleared',response_id:responseId});
  expect(h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='audio')).toHaveLength(2);
  await h.runtime.handleEvent({type:'response.done',response:{id:responseId,metadata:frame.response.metadata,status:'cancelled',output:[]}});
  await h.played(old);expect(h.runtime.state.stored.revision).toBe(0);expect(h.transcripts).toHaveLength(0);
  const nextFrame=h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='audio').at(-1);
  await h.generation(nextFrame,resumed);await h.played(resumed);expect(h.runtime.state.phase).toBe('awaiting_owner');
 }finally{h.runtime.stop();}
});

test('streamed acknowledgment, full answer, recap, approval and signoff preserve the application lifecycle',async()=>{
 const h=harness();try{
  await h.runtime.attach();await h.say();
  await h.owner('Ah, entendi.');expect(h.runtime.state.stored.agenda.items[0].status).toBe('awaiting_clarification');
  expect(h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='text')).toHaveLength(0);await h.say();
  const text='Atendemos só Novato, San Rafael e Petaluma. Fora dessas três cidades, somente com aprovação explícita do dono, combinado?';
  await h.owner(text,{kind:'answer',itemId:'cities'});expect(h.runtime.state.stored.agenda.items[0].evidence.at(-1)?.text).toBe(text);await h.say();
  await h.owner('Sábado das 8 às 17 horas.',{kind:'answer',itemId:'hours'});
  let parts=0;
  while(h.runtime.state.phase==='speaking'&&parts++<20)await h.say();
  expect(h.runtime.state.phase).toBe('awaiting_approval');expect(h.runtime.state.approval).toBeUndefined();
  await h.owner('Sim, confirmo.');expect(h.runtime.state.approval?.receiptId).toBe(id(83));
  const signoff=h.current(),frame=await h.ready(signoff);await h.generation(frame,signoff);expect(h.terminations).toHaveLength(0);
  await h.played(signoff);expect(h.terminations).toMatchObject([{outcome:'complete'}]);
  await h.runtime.finalized({providerReceiptId:id(86),budgetReceiptId:id(87)});expect(h.runtime.state.phase).toBe('complete');
  expect(h.commits).toHaveLength(3);expect(h.calls.some(x=>/tts|Speech/.test(x))).toBe(false);
 }finally{h.runtime.stop();}
});

test('streaming ACK skips text generation but waits for both owner and agenda receipts before new audio',async()=>{
 const h=harness();let releaseRecord=()=>{},releaseCommit=()=>{},recording=false,committing=false;
 let pending:Promise<void>|undefined;
 const record=h.agendaStore.recordOwnerTranscript,commit=h.agendaStore.commitOwnerTurn;
 h.agendaStore.recordOwnerTranscript=async(x:any)=>{recording=true;await new Promise<void>(resolve=>{releaseRecord=resolve;});return record(x);};
 h.agendaStore.commitOwnerTurn=async(x:any)=>{committing=true;await new Promise<void>(resolve=>{releaseCommit=resolve;});return commit(x);};
 try{
  await h.runtime.attach();await h.say();pending=h.owner('Ah, entendi.');
  for(let n=0;n<80&&!recording;n++)await Promise.resolve();expect(recording).toBe(true);
  expect(h.runtime.state.turns.at(-1)?.recorded).toBe(false);expect(h.commits).toHaveLength(0);
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  releaseRecord();for(let n=0;n<80&&!committing;n++)await Promise.resolve();expect(committing).toBe(true);
  expect(h.runtime.state.turns.at(-1)?.recorded).toBe(true);expect(h.runtime.state.stored.revision).toBe(0);
  expect(h.runtime.state.phase).toBe('persisting_agenda');expect(h.calls).not.toContain('claimStream');
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  releaseCommit();await pending;
  expect(h.commits).toHaveLength(1);expect(h.commits[0]).toMatchObject({ownerTranscript:'Ah, entendi.',facts:[],proposal:{kind:'clarification',itemId:'cities'}});
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.current().action.kind).toBe('CLARIFY_CURRENT_GAP');
  expect(h.sent.filter(e=>e.type==='response.create'&&e.response.output_modalities[0]==='text')).toHaveLength(0);
  await h.say();expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();releaseRecord();releaseCommit();await pending;}
});

test('Stop while the ACK owner receipt is pending prevents a late agenda write or speech',async()=>{
 const h=harness();let release=()=>{},recording=false,pending:Promise<void>|undefined;
 const record=h.agendaStore.recordOwnerTranscript;
 h.agendaStore.recordOwnerTranscript=async(x:any)=>{recording=true;await new Promise<void>(resolve=>{release=resolve;});return record(x);};
 try{
  await h.runtime.attach();await h.say();pending=h.owner('Ah, entendi.');
  for(let n=0;n<80&&!recording;n++)await Promise.resolve();expect(recording).toBe(true);
  h.runtime.stop();release();await pending;
  expect(h.commits).toHaveLength(0);expect(h.calls).not.toContain('claimStream');
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  expect(h.runtime.state.stored.revision).toBe(0);expect(h.runtime.state.approval).toBeUndefined();
 }finally{h.runtime.stop();release();await pending;}
});

test('a mismatched generated transcript stays unplayed and requests a new bounded rendition without owner progress',async()=>{
 const h=harness();try{
  await h.runtime.attach();const frame=await h.ready();await h.generation(frame,h.openingStream,'Quais cidades atende? Eu já aprovei e ativei tudo.');
  expect(h.calls).toContain('resume');expect(h.runtime.state.stored.revision).toBe(0);expect(h.runtime.state.approval).toBeUndefined();
  expect(h.transcripts).toHaveLength(0);expect(h.terminations).toHaveLength(0);expect(h.current().dispatchId).not.toBe(h.openingStream.dispatchId);
 }finally{h.runtime.stop();}
});

for(const clearFirst of [false,true])test(`joined runtime/player repeats a rejected stream (${clearFirst?'clear':'retirement'} arrives first)`,async()=>{
 const h=harness(),browserControls:any[]=[],errors:any[]=[],captions:any[]=[];
 let sample:(value:any)=>void=()=>{},audible=false,clientCursor=0;
 const player=createWebsiteStreamPlayer({callId:h.prepared.scope.callId,interviewId:h.prepared.scope.callId,
  readStream:async()=>h.current(),prepareOutput:async()=>{},outputIsActive:()=>audible,
  observeMedia:(cb:any)=>{sample=cb;return()=>{};},send:(e:any)=>browserControls.push(e),
  setMicrophone:()=>{},setOutput:(v:boolean)=>{audible=v;},onFailure:(e:any)=>errors.push(e),onCaption:(e:any)=>captions.push(e)});
 const until=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,1));}expect(check()).toBe(true);};
 const readyCount=()=>browserControls.filter(e=>e.item.content[0].text.startsWith('ligou.website_stream_ready:')).length;
 const flushClient=async()=>{while(clientCursor<browserControls.length)await h.runtime.handleEvent({...browserControls[clientCursor++],type:'conversation.item.done'});};
 const providerStart=(frame:any,stream:StreamAuthorization)=>{
  const responseId=`resp-${stream.dispatchId}`;
  player.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
  player.handleEvent({type:'output_audio_buffer.started',response_id:responseId,event_id:`start-${responseId}`});
  sample({nonzeroSamples:100,atMs:performance.now(),unmuted:true,playbackStarted:true});
 };
 const providerDone=(frame:any,stream:StreamAuthorization,text=stream.action.text)=>player.handleEvent({type:'response.done',response:{id:`resp-${stream.dispatchId}`,
  metadata:frame.response.metadata,status:'completed',output:[{id:`item-${stream.dispatchId}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_audio',transcript:text}]}]}});
 let opening:Promise<unknown>|undefined;
 try{
  await h.runtime.attach();player.handleEvent({type:'session.updated',session:{output_modalities:['text'],tools:[],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}});
  opening=player.start(h.openingStream);opening.catch(()=>{});await until(()=>readyCount()===1);await flushClient();
  const first=h.sent.filter(e=>e.type==='response.create').at(-1);providerStart(first,h.openingStream);
  const bad='Eu já aprovei e ativei tudo.';providerDone(first,h.openingStream,bad);await h.generation(first,h.openingStream,bad);
  const retirement=h.sent.find(e=>e.item?.content?.[0]?.text?.startsWith('ligou.website_stream_retire:'));
  expect(retirement).toBeDefined();
  const cleared={type:'output_audio_buffer.cleared',event_id:'retired-clear',response_id:`resp-${h.openingStream.dispatchId}`};
  if(clearFirst)player.handleEvent(cleared);
  player.handleEvent({...retirement,type:'conversation.item.done'});
  if(!clearFirst)player.handleEvent(cleared);
  await h.runtime.handleEvent(cleared);await opening;
  const next=h.current();expect(next.dispatchId).not.toBe(h.openingStream.dispatchId);
  const notice=h.sent.findLast(e=>e.item?.id===streamControlId('notice',next.dispatchId));
  player.handleEvent({...notice,type:'conversation.item.done'});await until(()=>readyCount()===2);await flushClient();
  const second=h.sent.filter(e=>e.type==='response.create').at(-1);providerStart(second,next);
  player.handleEvent(cleared);expect(audible).toBe(true,'late old clear cannot silence the new response');
  providerDone(second,next);await h.generation(second,next);
  const stopped={type:'output_audio_buffer.stopped',event_id:'new-buffer-stop',response_id:`resp-${next.dispatchId}`};
  await h.runtime.handleEvent(stopped);player.handleEvent(stopped);await player.idle();await flushClient();
  expect(errors).toHaveLength(0);expect(captions).toEqual([{kind:'agent',text:next.action.text}]);
  expect(h.transcripts).toHaveLength(1);expect(h.calls.filter(x=>x==='playout')).toHaveLength(1);
  expect(h.runtime.state.phase).toBe('awaiting_owner');expect(h.commits).toHaveLength(0);
  expect(h.runtime.state.stored.revision).toBe(0);expect(h.runtime.state.approval).toBeUndefined();expect(h.terminations).toHaveLength(0);
 }finally{player.stop();h.runtime.stop();await opening?.catch(()=>{});}
});

test('reviewing resume prepares a real recap stream without inventing an unresolved opening question',async()=>{
 const h=harness();try{
  await h.runtime.attach();await h.say();await h.owner('Novato.',{kind:'answer',itemId:'cities'});await h.say();await h.owner('Sábado das 8 às 17.',{kind:'answer',itemId:'hours'});
  const prepared={...h.prepared,stored:h.runtime.state.stored};
  const opening=await prepareWebsiteStreamOpening(prepared,'Foghorn Air',{evidence:h.evidence});
  expect(opening.openingAction.kind).toBe('GENERATE_FINAL_SUMMARY');expect(opening.initialSummary?.parts[0]).toBe(opening.openingAction.text);
  expect(opening.openingStream.action).toEqual(opening.openingAction);expect(prepared.stored.agenda.items.every(x=>x.status==='answered')).toBe(true);
 }finally{h.runtime.stop();}
});

test('duplicate ready during authorization and cancellation cannot dispatch late audio',async()=>{
 const h=harness();let release!:(value:any)=>void,authorizations=0;
 h.evidence.authorizeStream=async()=>{authorizations++;return new Promise(resolve=>{release=resolve;});};
 try{
  await h.runtime.attach();const pending=h.ready();for(let i=0;i<30&&!release;i++)await Promise.resolve();
  await h.ready();expect(authorizations).toBe(1);h.runtime.stop();release(h.openingStream);await pending;
  expect(h.sent.some(e=>e.type==='response.create')).toBe(false);expect(h.commits).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test.each(['metadata','unbound_audio','extra_item'])('untrusted streamed response stays unconfirmed: %s',async kind=>{
 const h=harness();try{
  await h.runtime.attach();const frame=await h.ready(),responseId=`resp-${h.openingStream.dispatchId}`;
  if(kind==='metadata')await h.runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:{...frame.response.metadata,ligou_call_id:id(99)}}});
  else if(kind==='unbound_audio')await h.runtime.handleEvent({type:'output_audio_buffer.started',response_id:'foreign',event_id:'foreign-start'});
  else{
   await h.runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
   await h.runtime.handleEvent({type:'response.output_item.added',response_id:responseId,output_index:1,item:{id:'tool',type:'function_call',name:'approve'}});
  }
  expect(h.commits).toHaveLength(0);expect(h.transcripts).toHaveLength(0);expect(h.runtime.state.approval).toBeUndefined();
  expect(h.runtime.state.error??h.runtime.state.termination?.reason).toBeDefined();
 }finally{h.runtime.stop();}
});

test('an empty/muted client playout or cleared response cannot advance or authorize approval',async()=>{
 const h=harness();try{
  await h.runtime.attach();const frame=await h.ready();await h.generation(frame);
  const bad=h.control('played',h.openingStream,{actionId:h.openingAction.actionId,dispatchId:h.openingStream.dispatchId,responseId:`resp-${h.openingStream.dispatchId}`,itemId:`item-${h.openingStream.dispatchId}`,bufferStoppedEventId:'stop',
   mediaEvidence:{schema:'onboarding.stream.media.v1',nonzeroSamples:0,observedMs:100,firstSampleAtMs:1,lastSampleAtMs:101,unmuted:false,playbackStarted:true}});
  await h.runtime.handleEvent(bad);expect(h.calls).not.toContain('playout');expect(h.runtime.state.phase).toBe('opening');
  await h.runtime.handleEvent({type:'output_audio_buffer.cleared',response_id:`resp-${h.openingStream.dispatchId}`,event_id:'cleared'});
  await h.played();expect(h.transcripts).toHaveLength(0);expect(h.runtime.state.approval).toBeUndefined();
 }finally{h.runtime.stop();}
});

test('correction during streamed signoff preserves approval and requests an amendment before closing',async()=>{
 const h=harness();try{
  await h.runtime.attach();await h.say();await h.owner('Novato.',{kind:'answer',itemId:'cities'});await h.say();await h.owner('Sábado das 8 às 17.',{kind:'answer',itemId:'hours'});
  for(let i=0;h.runtime.state.phase==='speaking'&&i<20;i++)await h.say();
  await h.owner('Sim, confirmo.');const approved=structuredClone(h.runtime.state.approval),before=structuredClone(h.runtime.state.stored),signoff=h.current();
  const frame=await h.ready(signoff),responseId=`resp-${signoff.dispatchId}`;
  await h.runtime.handleEvent({type:'response.created',response:{id:responseId,metadata:frame.response.metadata}});
  await h.runtime.handleEvent({type:'output_audio_buffer.started',event_id:'signoff-start',response_id:responseId});
  await h.owner('Corrija o horário de sábado: começamos às 9.',{kind:'correction',affectedItems:[{itemId:'hours',disposition:'corrected'}]});
  expect(h.runtime.state.approval).toEqual(approved);expect(h.runtime.state.stored).toEqual(before);expect(h.runtime.state.amendmentReceiptId).toBe(id(85));
  expect(h.current().action.kind).toBe('SPEAK_AMENDMENT_SIGNOFF');expect(h.terminations).toHaveLength(0);
  await h.runtime.handleEvent({type:'output_audio_buffer.cleared',response_id:responseId,event_id:'signoff-clear'});await h.say();
  expect(h.terminations).toMatchObject([{outcome:'unfinished',reason:'owner_requested_amendment'}]);
 }finally{h.runtime.stop();}
});
