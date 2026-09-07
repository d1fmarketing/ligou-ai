import { describe, expect, test } from "bun:test";
import { createWebsiteInterviewRuntime, websiteInterpretationRequest } from "../src/onboarding-website-runtime.ts";
import { createWebsiteAgendaCoordinator, buildWebsiteOpeningAction, reduceWebsiteAgenda } from "../src/onboarding-agenda-coordinator.ts";
import { createOnboardingAgenda, getAgendaAction, applyVerifiedOwnerTurn } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest, createOnboardingAgendaStore } from "../src/onboarding-agenda-store.ts";
import { createHash } from "node:crypto";
import { createWebsiteSpeechPlayer } from "../../dashboard/src/voice/website-speech.js";
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
 test.each([
  'Olha, atende só Novato, San Rafael e Petaluma. Nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?',
  'Olha, atende só novatos São Rafael e Petaluma, nada além dessas três. Já teve pedido de gente de outras cidades, mas não é pra atender. Se pintar alguma coisa fora, é só com aprovação explícita do dono, combinado?',
  'Nossa área fica restrita a Novato, San Rafael e Petaluma. Para sair dessas cidades precisa falar comigo e ter minha autorização.',
 ])('owner answer reaches the real store under the authenticated browser request: %s',async text=>{
  const b=base(),sent:any[]=[],requests:any[]=[],spoken:any[]=[];
  const scope={ownerId:requestId,callId,requestId};
  const client={rpc:async(name:string,args:any)=>{
   requests.push({name,args});
   // This is the real SQL scope invariant; the transport itself stays real.
   if(args.p_owner!==scope.ownerId || args.p_call!==callId || args.p_request!==requestId)
    return{data:null,error:{code:'42501',message:'interview_call_not_owner_bound'}};
   if(name==='record_website_interview_owner_turn')return{data:{callId,providerItemId:args.p_item,turnId:`${callId}:${args.p_item}`,text:args.p_text,replayed:false},error:null};
   if(name==='commit_website_interview_turn'){
    const transition=applyVerifiedOwnerTurn(b.stored.agenda,{type:'verified_owner_turn',binding:b.stored.agenda.binding,
     turnId:`${callId}:${args.p_item}`,text,proposal:{kind:'answer',itemId:'cities'}});
    return{data:{...b.stored,agenda:args.p_agenda,revision:1,storeVersion:1,digest:onboardingAgendaDigest(args.p_agenda),nextAction:transition.action},error:null};
   }
   throw new Error(`Unexpected RPC ${name}`);
  }};
  const runtime=createWebsiteInterviewRuntime({prepared:{scope,stored:b.stored,projection:{} as any},openingAction:b.openingAction,openingPayload:b.openingPayload as any},{
   agendaStore:createOnboardingAgendaStore(client),
   evidenceStore:{recordSpeechPlayed:async()=>({receiptId:requestId}),claimSpeech:async({action}:any)=>({status:'preparing',claimed:true,action}),
    completeSpeech:async({payload}:any)=>({status:'ready',payload}),failSpeech:async()=>({})} as any,
   synthesize:async action=>{spoken.push(action);return b.payload(action) as any;},send:event=>sent.push(event),enqueue:async f=>f(),
   onTranscript:()=>{},onCost:()=>{},onUsage:()=>{},onUsageUnknown:()=>{},onTerminate:()=>{},onState:()=>{},
  });
  try{
   await runtime.attach();
   await runtime.handleEvent({type:'conversation.item.created',item:{id:`lgs-${b.openingAction.actionId.slice(0,28)}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:b.openingAction.text}]}});
   await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'territory'});
   await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'territory',transcript:text});
   const request=sent.find(e=>e.type==='response.create');
   await runtime.handleEvent({type:'response.done',response:{id:'resp-territory',status:'completed',metadata:request.response.metadata,
    output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',call_id:'tool-territory',arguments:JSON.stringify({proposal:{kind:'answer',itemId:'cities'},facts:[]})}]}});
   expect(runtime.state.stored.revision).toBe(1);
   expect(runtime.state.stored.agenda.items[0].evidence[0].text).toBe(text);
   expect(runtime.state.stored.nextAction.itemId).toBe('hours');
   expect(runtime.state.speech?.action.kind).toBe('CONFIRM_AND_ASK_NEXT');
   expect(runtime.state.approval).toBeUndefined();
   expect(requests.filter(r=>r.name==='commit_website_interview_turn').map(r=>r.args.p_request)).toEqual([requestId]);
   expect(spoken.some(action=>action.kind==='SPEAK_TERMINAL_ERROR')).toBe(false);
  }finally{runtime.stop();}
 });
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

function recoveryHarness(options:{commitFailure?:'transient'|'after_commit'|'auth'|'exhausted'|'http_unavailable';holdPlaybackReceipt?:boolean;holdNextQuestion?:boolean;throwDiagnostics?:boolean}={}){
 const b=base(),sent:any[]=[],spoken:any[]=[],receipts:any[]=[],transcripts:any[]=[],terminations:any[]=[],completions:any[]=[];
 const diagnostics:any[]=[],commitRequests:any[]=[],interruptions:any[]=[],emptyInputs:any[]=[],resumptions:any[]=[],costs:number[]=[];let reads=0;
 let releasePlayback=()=>{};
 let releaseQuestion=()=>{};
 let stored:any=b.stored,clock=Date.now(),sequence=0;
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):value;
 const body={version:1,provenance:{...b.stored.agenda.binding,authority:{}},candidateRecap:[],seeds:b.stored.agenda.items.map(({id,source,subject,questionPt,coverageRefs,relatedItemIds,blocking})=>({id,source,subject,questionPt,coverageRefs,relatedItemIds,blocking}))};
 const projection={...body,seedsHash:hash(JSON.stringify(canonical(body)))};
 const payloads=new Map<string,any>([[b.openingAction.actionId,b.openingPayload]]);
 const providerItems=new Map<string,any>(),plays:string[]=[];
 const runtime=createWebsiteInterviewRuntime({prepared:{scope:{ownerId:requestId,callId,requestId},stored,projection:projection as any},openingAction:b.openingAction,openingPayload:b.openingPayload as any},{
  agendaStore:{recordOwnerTranscript:async(x:any)=>({...x,turnId:`${callId}:${x.providerItemId}`}),
   commitOwnerTurn:async(x:any)=>{
    commitRequests.push(x);
    const failure=options.commitFailure;
    if(failure==='http_unavailable' && commitRequests.length===1)throw Object.assign(new Error('Service Unavailable'),{status:503});
    if(failure==='auth' || failure==='exhausted' || (failure==='transient' && commitRequests.length===1))
     throw Object.assign(new Error('private diagnostic text must not be logged'),{code:failure==='auth'?'42501':'08006'});
    stored={...stored,agenda:x.agenda,revision:x.agenda.revision,storeVersion:stored.storeVersion+1,digest:onboardingAgendaDigest(x.agenda),nextAction:x.nextAction,state:x.nextAction.type==='GENERATE_FINAL_SUMMARY'?'reviewing':'unfinished'};
    if(failure==='after_commit' && commitRequests.length===1)throw Object.assign(new Error('response timed out after COMMIT'),{code:'ETIMEDOUT'});
    return stored;},
   readWebsiteInterview:async()=>{reads++;return stored;}} as any,
  evidenceStore:{recordSpeechPlayed:async(x:any)=>{receipts.push(x);if(options.holdPlaybackReceipt && receipts.length===1)await new Promise<void>(resolve=>{releasePlayback=resolve;});return{receiptId:requestId};},
   interruptSpeech:async(x:any)=>{interruptions.push(x);if(receipts.some(r=>r.actionId===x.actionId))throw new Error('interview_speech_not_interruptible');return{receiptId:requestId,actionId:x.actionId,providerItemId:x.providerItemId};},
   recordEmptyInput:async(x:any)=>{emptyInputs.push(x);return{receiptId:requestId,actionId:x.actionId,providerItemId:x.providerItemId};},
   resumeSpeech:async(x:any)=>{resumptions.push(x);const old=payloads.get(x.actionId),action={actionId:hash([x.actionId,x.providerItemId].join(':')),
    interviewId:old.interviewId,callId:old.callId,revision:old.revision,kind:old.kind,text:old.text,sourceDigest:old.sourceDigest};
    const p=b.payload(action);payloads.set(action.actionId,p);return{action,payload:p,status:'ready',claimed:false};},
   claimSpeech:async({action}:any)=>({status:'preparing',claimed:true,action}),completeSpeech:async({payload}:any)=>({status:'ready',payload}),failSpeech:async()=>({}),
   prepareSummary:async(x:any)=>({summaryId:x.summaryId,revision:x.expectedRevision,digest:x.expectedDigest,parts:x.parts,summaryHash:hash(JSON.stringify([x.summaryId,x.expectedRevision,x.expectedDigest,x.parts])),receiptId:requestId}),
   approveSummary:async(x:any)=>({approvalReceiptId:requestId,turnId:`${callId}:${x.providerItemId}`,summaryId:x.summaryId,summaryHash:x.summaryHash,revision:x.expectedRevision,digest:x.expectedDigest,storeVersion:x.expectedStoreVersion+1}),
   recordCompletion:async(x:any)=>{completions.push(x);return{receiptId:requestId,interviewId:callId,callId,outcome:x.outcome,approvalReceiptId:x.approvalReceiptId};}} as any,
  synthesize:async(a:any)=>{spoken.push(a);if(options.holdNextQuestion && a.kind==='CONFIRM_AND_ASK_NEXT')await new Promise<void>(resolve=>{releaseQuestion=resolve;});const p=b.payload(a);payloads.set(a.actionId,p);return p as any;},
  send:e=>sent.push(e),enqueue:async f=>f(),onTranscript:t=>transcripts.push(t),onCost:cost=>costs.push(cost),onUsage:()=>{},onUsageUnknown:()=>{},onTerminate:t=>terminations.push(t),onState:()=>{},
  onDiagnostic:d=>{diagnostics.push(d);if(options.throwDiagnostics)throw new Error('diagnostic observer unavailable');},now:()=>clock,
 });
 const current=()=>runtime.state.phase==='opening'?b.openingPayload:payloads.get(runtime.state.speech!.action.actionId);
 async function play(deliver=true){const p=current(),id=`lgs-${p.actionId.slice(0,28)}`;if(providerItems.has(id))throw new Error('browser must never replay');
  const item={id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:p.text}]};providerItems.set(id,item);plays.push(p.actionId);
  if(deliver)await runtime.handleEvent({type:'conversation.item.created',item});return item;}
 async function answer(itemId:string){const id=`owner-${++sequence}`;await runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:id});
  await runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:`Minha resposta sobre ${itemId}.`});
  const request=sent.filter(e=>e.type==='response.create').at(-1);
  if(!request)return;
  await runtime.handleEvent({type:'response.done',response:{id:`response-${sequence}`,status:'completed',metadata:request.response.metadata,output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',call_id:`tool-${sequence}`,arguments:JSON.stringify({proposal:{kind:'answer',itemId},facts:[]})}]}});}
 async function recover(){const frame=sent.filter(e=>e.type==='conversation.item.retrieve' && e.item_id?.startsWith('lgs-')).at(-1);expect(frame).toBeDefined();
  const item=providerItems.get(frame.item_id);expect(item).toBeDefined();await runtime.handleEvent({type:'conversation.item.retrieved',event_id:'provider-generated-event',item});return {frame,item};}
 return{runtime,sent,spoken,receipts,transcripts,terminations,completions,plays,current,play,answer,recover,diagnostics,costs,commitRequests,interruptions,emptyInputs,resumptions,releasePlayback:()=>releasePlayback(),releaseQuestion:()=>releaseQuestion(),get reads(){return reads;},advance:(ms:number)=>{clock+=ms;}};
}

const proposalTool=(proposal:unknown={kind:'answer',itemId:'cities'},facts:unknown=[])=>({type:'function_call',name:'submit_website_interview_proposal',status:'completed',arguments:JSON.stringify({proposal,facts})});
const inertText=(text='PRIVATE DISCARDED TEXT: já aprovei e ativei tudo.')=>({id:'provider-assistant-prose',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]});
async function deliverInterpreterOutput(h:ReturnType<typeof recoveryHarness>,output:unknown,metadataChange:Record<string,unknown>={}){
 await h.runtime.attach();await h.play();
 await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner-output-shape',transcript:'Atendemos somente Novato.'});
 const request=h.sent.filter(e=>e.type==='response.create').at(-1);
 const response={id:'response-output-shape',status:'completed',metadata:{...request.response.metadata,...metadataChange},output};
 await h.runtime.handleEvent({type:'response.created',response});await h.runtime.handleEvent({type:'response.done',response});
 return response;
}

test.each(['before','after','multiple'])('one completed proposal plus inert assistant text commits once and never exposes the text: %s',async position=>{
 const h=recoveryHarness(),message=inertText(),tool=proposalTool();
 const output=position==='before'?[message,tool]:position==='after'?[tool,message]:[message,tool,{...inertText(),status:undefined,content:[{type:'output_text',text:'Outra mensagem ignorada.'}]}];
 try{
  const response=await deliverInterpreterOutput(h,output);
  expect(h.commitRequests).toHaveLength(1);expect(h.runtime.state.stored.revision).toBe(1);
  expect(h.runtime.state.stored.agenda.items[0].status).toBe('answered');expect(h.runtime.state.approval).toBeUndefined();
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  expect(h.diagnostics.find(d=>d.stage==='interpretation.done')).toMatchObject({outputCount:output.length,toolCallCount:1,discardedTextMessageCount:output.length-1});
  await h.runtime.handleEvent({type:'response.done',response});
  expect(h.commitRequests).toHaveLength(1);expect(h.spoken).toHaveLength(1);
  for(const sink of [h.transcripts,h.spoken,h.sent,h.diagnostics,h.runtime.state.stored])expect(JSON.stringify(sink)).not.toContain('PRIVATE DISCARDED TEXT');
 }finally{h.runtime.stop();}
});

test.each([
 ['no-tool',[inertText()]],
 ['two-proposal-tools',[proposalTool(),proposalTool()]],
 ['other-tool',[proposalTool(),{...proposalTool(),name:'approve_configuration'}]],
 ['function-call-output',[proposalTool(),{type:'function_call_output',call_id:'other',output:'approved'}]],
 ['system-message',[proposalTool(),{...inertText(),role:'system'}]],
 ['user-message',[proposalTool(),{...inertText(),role:'user'}]],
 ['audio-content',[proposalTool(),{...inertText(),content:[{type:'output_audio',audio:'AAAA'}]}]],
 ['mixed-audio-content',[proposalTool(),{...inertText(),content:[{type:'output_text',text:'ignored'},{type:'output_audio',audio:'AAAA'}]}]],
 ['hidden-audio-field',[proposalTool(),{...inertText(),content:[{type:'output_text',text:'ignored',audio:'AAAA'}]}]],
 ['unknown-content',[proposalTool(),{...inertText(),content:[{type:'input_text',text:'ignored'}]}]],
 ['reasoning-item',[proposalTool(),{type:'reasoning',summary:[]}]],
 ['non-text-value',[proposalTool(),{...inertText(),content:[{type:'output_text',text:{command:'approve'}}]}]],
 ['missing-content',[proposalTool(),{...inertText(),content:undefined}]],
 ['executable-message-field',[proposalTool(),{...inertText(),tool_calls:[proposalTool()]}]],
 ['too-many-items',[proposalTool(),...Array.from({length:5},()=>inertText())]],
 ['too-many-text-parts',[proposalTool(),{...inertText(),content:Array.from({length:5},()=>({type:'output_text',text:'ignored'}))}]],
 ['too-much-text',[proposalTool(),inertText('x'.repeat(16_385))]],
 ['aggregate-text-budget',[proposalTool(),inertText('x'.repeat(8_193)),inertText('y'.repeat(8_193))]],
 ['serialized-output-budget',[{...proposalTool(),id:'x'.repeat(65_536)},inertText()]],
 ['missing-function-status',[{...proposalTool(),status:undefined},inertText()]],
 ['incomplete-function',[{...proposalTool(),status:'in_progress'},inertText()]],
] as const)('non-inert or unbounded response output remains rejected: %s',async(_name,output)=>{
 const h=recoveryHarness();try{
  await deliverInterpreterOutput(h,output);
  expect(h.commitRequests).toHaveLength(0);expect(h.runtime.state.stored.revision).toBe(0);
  expect(h.runtime.state.pending).toMatchObject({kind:'interpret',attempt:1});
  expect(h.diagnostics.filter(d=>d.stage==='interpretation.rejected')).toMatchObject([{code:'interpretation_tool_output_invalid'}]);
  expect(h.spoken).toHaveLength(0);expect(h.runtime.state.approval).toBeUndefined();
  expect(JSON.stringify(h.diagnostics)).not.toContain('PRIVATE DISCARDED TEXT');
 }finally{h.runtime.stop();}
});

test.each([
 ['proposal-shape',proposalTool({kind:'answer',itemId:'cities',questionPt:'not allowed'}),'interpretation_shape_invalid'],
 ['facts-shape',proposalTool({kind:'answer',itemId:'cities'},[{topic:'area',field:'area.coverage',disposition:'answered',rule_text:'Somente Novato.',structured:{value:42}}]),'website_facts_typed_value_invalid'],
 ['item-binding',proposalTool({kind:'answer',itemId:'hours'}),'website_applicability_current_item_mismatch'],
] as const)('discarding text never bypasses proposal validation: %s',async(_name,tool,code)=>{
 const h=recoveryHarness();try{
  await deliverInterpreterOutput(h,[inertText(),tool]);
  expect(h.commitRequests).toHaveLength(0);expect(h.runtime.state.stored.revision).toBe(0);
  expect(h.diagnostics.filter(d=>d.stage==='interpretation.rejected')).toMatchObject([{code}]);
 }finally{h.runtime.stop();}
});

test.each(['website_request_id','website_turn_id','website_item_id','website_digest'])('inert text cannot rescue wrong interpreter metadata: %s',async key=>{
 const h=recoveryHarness();try{
  await deliverInterpreterOutput(h,[inertText(),proposalTool()],{[key]:'foreign'});
  expect(h.commitRequests).toHaveLength(0);expect(h.runtime.state.error).toBe('unsolicited_website_response');
  expect(h.runtime.state.approval).toBeUndefined();
 }finally{h.runtime.stop();}
});

test('text bounds admit their exact boundary and stopped attempts ignore late tool-plus-text output',async()=>{
 const h=recoveryHarness();try{
  const messages=Array.from({length:4},()=>({...inertText(),content:Array.from({length:4},()=>({type:'output_text',text:'x'.repeat(1024)}))}));
  await deliverInterpreterOutput(h,[proposalTool(),...messages]);expect(h.commitRequests).toHaveLength(1);
  expect(h.diagnostics.find(d=>d.stage==='interpretation.done')).toMatchObject({toolCallCount:1,discardedTextMessageCount:4});
 }finally{h.runtime.stop();}
 const stopped=recoveryHarness();try{
  await stopped.runtime.attach();await stopped.play();
  await stopped.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner-before-stop',transcript:'Somente Novato.'});
  const request=stopped.sent.filter(e=>e.type==='response.create').at(-1);stopped.runtime.stop();
  await stopped.runtime.handleEvent({type:'response.done',response:{id:'late-response',status:'completed',metadata:request.response.metadata,output:[inertText(),proposalTool()]}});
  expect(stopped.commitRequests).toHaveLength(0);expect(stopped.spoken).toHaveLength(0);expect(stopped.runtime.state.approval).toBeUndefined();
 }finally{stopped.runtime.stop();}
});

test('the actual website speech player ignores discarded provider text in every delivery form',async()=>{
 const b=base(),plays:unknown[]=[],captions:unknown[]=[],sent:unknown[]=[];
 const player=createWebsiteSpeechPlayer({callId,interviewId:callId,
  readSpeech:async()=>b.openingPayload,play:async(bytes:unknown)=>{plays.push(bytes);},
  send:(event:any)=>{sent.push(event);queueMicrotask(()=>player.handleEvent({type:'conversation.item.created',item:event.item}));},
  setMicrophone:()=>{},onCaption:(event:unknown)=>captions.push(event),onFailure:(error:unknown)=>{throw error;},
 });
 try{
  player.handleEvent({type:'session.updated',session:{output_modalities:['text'],audio:{input:{turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}});
  await player.start(b.openingPayload);const baseline={plays:plays.length,captions:captions.length,sent:sent.length};
  expect(baseline).toEqual({plays:1,captions:1,sent:1});
  const message=inertText();
  for(const event of [
   {type:'response.output_text.delta',delta:message.content[0].text},
   {type:'response.output_text.done',text:message.content[0].text},
   {type:'response.output_audio_transcript.done',transcript:message.content[0].text},
   {type:'response.output_item.done',item:message},
   {type:'conversation.item.created',item:message},
   {type:'conversation.item.done',item:message},
   {type:'response.done',response:{output:[proposalTool(),message]}},
  ])player.handleEvent(event);
  await player.idle();
  expect({plays:plays.length,captions:captions.length,sent:sent.length}).toEqual(baseline);
  expect(JSON.stringify(captions)).not.toContain('PRIVATE DISCARDED TEXT');
 }finally{player.stop();}
});

test('a throwing diagnostic observer cannot alter accepted TTS accounting or owner progress',async()=>{
 const h=recoveryHarness({throwDiagnostics:true});try{
  await h.runtime.attach();await h.play();await h.answer('cities');
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.commitRequests).toHaveLength(1);
  expect(h.runtime.state.error).toBeUndefined();expect(h.runtime.state.speech?.action.kind).toBe('CONFIRM_AND_ASK_NEXT');
  expect(h.diagnostics.some(d=>d.stage==='tts.ready')).toBe(true);
  expect(h.costs).toEqual([h.current().cost_usd]);expect(h.costs[0]).toBeGreaterThan(0);
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
 }finally{h.runtime.stop();}
});

test('interpreter diagnostics separate rejected output, selected proposal and TTS time without owner data',async()=>{
 const h=recoveryHarness({holdNextQuestion:true});
 const text='Somente Novato. Fora da cidade, só com autorização do dono.';
 try{
  await h.runtime.attach();await h.play();
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'private-owner-123'});
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'private-owner-123',transcript:text});
  const first=h.sent.filter(e=>e.type==='response.create').at(-1);
  h.advance(5);
  await h.runtime.handleEvent({type:'response.created',response:{id:'private-response-1',metadata:first.response.metadata}});
  h.advance(7);
  await h.runtime.handleEvent({type:'response.done',response:{id:'private-response-1',status:'completed',metadata:first.response.metadata,
   output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',arguments:JSON.stringify({
    proposal:{kind:'answer',itemId:'cities',questionPt:'private-output-456'},facts:[]})}]}});
  const retry=h.sent.filter(e=>e.type==='response.create').at(-1);
  expect(retry.response.metadata.website_request_id).not.toBe(first.response.metadata.website_request_id);
  expect(retry.response.instructions).toContain('interpretation_shape_invalid');
  expect(retry.response.instructions).not.toContain('private-output-456');
  expect(h.commitRequests).toHaveLength(0);
  h.advance(3);
  const completed=h.runtime.handleEvent({type:'response.done',response:{id:'private-response-2',status:'completed',metadata:retry.response.metadata,
   output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',arguments:JSON.stringify({proposal:{kind:'answer',itemId:'cities'},facts:[]})}]}});
  for(let i=0;i<100 && !h.spoken.length;i++)await Promise.resolve();
  expect(h.spoken).toHaveLength(1);h.advance(23);h.releaseQuestion();await completed;
  const stages=h.diagnostics.map(d=>d.stage);
  expect(stages.filter(s=>s==='interpretation.requested')).toHaveLength(2);
  expect(h.diagnostics.find(d=>d.stage==='interpretation.created')).toMatchObject({attempt:0,durationMs:5});
  expect(h.diagnostics.filter(d=>d.stage==='interpretation.done')).toMatchObject([
   {attempt:0,durationMs:12,proposalKind:'answer',factCount:0,outputCount:1},
   {attempt:1,durationMs:3,proposalKind:'answer',factCount:0,outputCount:1},
  ]);
  expect(h.diagnostics.filter(d=>d.stage==='interpretation.rejected')).toMatchObject([{attempt:0,code:'interpretation_shape_invalid'}]);
  expect(h.diagnostics.filter(d=>d.stage==='interpretation.selected')).toMatchObject([{attempt:1,proposalKind:'answer',factCount:0,targetCount:1}]);
  expect(stages.indexOf('interpretation.selected')).toBeLessThan(stages.indexOf('answer.commit'));
  expect(stages).toContain('tts.requested');
  expect(h.diagnostics.find(d=>d.stage==='tts.ready')).toMatchObject({durationMs:23});
  expect(h.runtime.state.stored.revision).toBe(1);
  for(const secret of [text,'private-owner-123','private-response-1','private-output-456','owner_transcript','arguments'])
   expect(JSON.stringify(h.diagnostics)).not.toContain(secret);
  expect(h.diagnostics.every((entry,index)=>index===0 || entry.elapsedMs>=h.diagnostics[index-1].elapsedMs)).toBe(true);
 }finally{h.releaseQuestion();h.runtime.stop();}
});

test('failed interpreter responses exhaust technically without inventing a clarification or changing the agenda',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.play();
  const before=structuredClone(h.runtime.state.stored),text='Atendemos somente Novato, San Rafael e Petaluma.';
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'preserved-owner',transcript:text});
  for(let attempt=0;attempt<2;attempt++){
   const request=h.sent.filter(e=>e.type==='response.create').at(-1);
   await h.runtime.handleEvent({type:'response.done',response:{id:`failed-${attempt}`,metadata:request.response.metadata,status:'failed',
    status_details:{error:{code:'private-code-secret',message:'private provider response'}},output:[]}});
  }
  expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(2);
  expect(h.commitRequests).toHaveLength(0);expect(h.runtime.state.stored).toEqual(before);
  expect(h.runtime.state.turns.at(-1)).toMatchObject({text,recorded:true,processed:false});
  expect(h.runtime.state.error).toBe('interpretation_exhausted');
  expect(h.runtime.state.speech?.action.kind).toBe('SPEAK_TERMINAL_ERROR');
  expect(h.diagnostics.filter(d=>d.stage==='interpretation.rejected')).toMatchObject([
   {attempt:0,code:'interpretation_provider_failed'},{attempt:1,code:'interpretation_provider_failed'},
  ]);
  expect(JSON.stringify(h.diagnostics)).not.toContain('private');
  await h.play();expect(h.terminations).toHaveLength(1);
  expect(h.terminations[0]).toMatchObject({outcome:'unfinished',reason:'interpretation_exhausted'});
 }finally{h.runtime.stop();}
});

test.each(['clarification','invalid_kind'])('diagnostics distinguish a selected clarification from malformed output: %s',async variant=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.play();
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'owner-unclear',transcript:'Ainda preciso entender esse ponto.'});
  const request=h.sent.filter(e=>e.type==='response.create').at(-1);
  const proposal=variant==='clarification'?{kind:'clarification',itemId:'cities'}:{kind:{toString:null},itemId:'cities'};
  await h.runtime.handleEvent({type:'response.done',response:{id:'response-unclear',status:'completed',metadata:request.response.metadata,
   output:[{type:'function_call',name:'submit_website_interview_proposal',status:'completed',arguments:JSON.stringify({proposal,facts:[]})}]}});
  if(variant==='clarification'){
   expect(h.commitRequests).toHaveLength(1);expect(h.commitRequests[0].proposal).toEqual(proposal);
   expect(h.runtime.state.stored.agenda.items[0].clarificationCount).toBe(1);
   expect(h.diagnostics.filter(d=>d.stage==='interpretation.selected')).toMatchObject([{attempt:0,proposalKind:'clarification',factCount:0}]);
   expect(h.diagnostics.filter(d=>d.stage==='interpretation.rejected')).toHaveLength(0);
  }else{
   expect(h.commitRequests).toHaveLength(0);
   expect(h.diagnostics.filter(d=>d.stage==='interpretation.selected')).toHaveLength(0);
   expect(h.diagnostics.filter(d=>d.stage==='interpretation.rejected')).toMatchObject([{attempt:0,code:'interpretation_shape_invalid'}]);
   expect(h.sent.filter(e=>e.type==='response.create')).toHaveLength(2);
  }
 }finally{h.runtime.stop();}
});

test('barge-in answer to the published next question binds to that question before its played ACK',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.play();await h.answer('cities');
  expect(h.runtime.state.speech?.action.text).toContain('Qual o horário de sábado?');
  await h.answer('hours');
  expect(h.runtime.state.turns.at(-1)?.capturedItemId).toBe('hours');
  expect(h.runtime.state.stored.revision).toBe(2);expect(h.runtime.state.error).toBeUndefined();
  expect(h.runtime.state.speech?.action.kind).toBe('GENERATE_FINAL_SUMMARY');
 }finally{h.runtime.stop();}
});

test('owner continuation before next-question audio is ready retains the preceding question context',async()=>{
 const h=recoveryHarness({holdNextQuestion:true});try{
  await h.runtime.attach();await h.play();const pending=h.answer('cities');
  for(let n=0;n<100&&!h.spoken.length;n++)await Promise.resolve();
  expect(h.spoken[0]?.kind).toBe('CONFIRM_AND_ASK_NEXT');
  h.runtime.observeEvent({type:'input_audio_buffer.speech_started',item_id:'city-continuation'});
  h.releaseQuestion();await pending;
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'city-continuation',transcript:'E fora dessas cidades, só com minha aprovação explícita.'});
  expect(h.runtime.state.turns.at(-1)?.capturedItemId).toBe('cities');
  expect(h.sent.filter(e=>e.type==='response.create').at(-1)?.response.input[0].content[0].text).toContain('"mode":"correction"');
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.runtime.state.error).toBeUndefined();
 }finally{h.releaseQuestion();h.runtime.stop();}
});

test('empty final ASR resumes interrupted audio once without inventing owner words or approval',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'noise'});
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_stopped',item_id:'noise'});
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'noise',transcript:''});
  expect(h.emptyInputs).toHaveLength(1);expect(h.resumptions).toHaveLength(1);expect(h.runtime.state.activeOwnerItemId).toBeUndefined();
  expect(h.runtime.state.speech?.action.kind).toBe('ASK_NEXT_GAP');expect(h.runtime.state.stored.revision).toBe(0);
  expect(h.runtime.state.turns).toHaveLength(0);expect(h.transcripts.filter(t=>t.role==='caller')).toHaveLength(0);
  expect(h.spoken).toHaveLength(0);expect(h.runtime.state.approval).toBeUndefined();
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'noise'});
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'noise',transcript:''});
  expect(h.interruptions).toHaveLength(1);expect(h.emptyInputs).toHaveLength(1);
  await h.play();expect(h.runtime.state.phase).toBe('awaiting_owner');
 }finally{h.runtime.stop();}
});

test('a missing final ASR gets one bounded probe; retrieved text never invents a final owner answer',async()=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 const timers=new Map<any,{callback:()=>void;ms:number}>();
 globalThis.setTimeout=((callback:()=>void,ms:number)=>{const id={};timers.set(id,{callback,ms});return id;}) as any;
 globalThis.clearTimeout=((id:any)=>{timers.delete(id);}) as any;
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'missing-final'});
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_stopped',item_id:'missing-final'});
  const retry=[...timers.values()].find(t=>t.ms===5000);expect(retry).toBeDefined();
  const deadline=[...timers.values()].find(t=>t.ms===10000);expect(deadline).toBeDefined();
  h.advance(5000);retry!.callback();
  const probe=h.sent.filter(e=>e.type==='conversation.item.retrieve' && e.item_id==='missing-final');expect(probe).toHaveLength(1);
  expect(h.runtime.ownsSpeechRetrieveMiss({type:'error',error:{event_id:probe[0].event_id,code:'item_not_found'}})).toBe(true);
  await h.runtime.handleEvent({type:'conversation.item.retrieved',item:{id:'missing-final',type:'message',role:'user',status:'completed',content:[{type:'input_audio',transcript:'Sim. Confirmo.'}]}});
  expect(h.runtime.state.stored.revision).toBe(0);expect(h.runtime.state.turns).toHaveLength(0);
  h.advance(5000);deadline!.callback();for(let n=0;n<60;n++)await Promise.resolve();
  expect(h.runtime.state.error).toBe('website_asr_deadline_exceeded');expect(h.runtime.state.activeOwnerItemId).toBeUndefined();
  expect(h.emptyInputs).toHaveLength(0);expect(h.runtime.state.approval).toBeUndefined();
  await h.runtime.handleEvent({type:'conversation.item.input_audio_transcription.completed',item_id:'missing-final',transcript:'Sim. Confirmo.'});
  expect(h.runtime.state.turns).toHaveLength(0);
 }finally{h.runtime.stop();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('a retired ASR deadline cannot cut off an already selected failure signoff',async()=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 const timers=new Map<any,{callback:()=>void;ms:number}>();
 globalThis.setTimeout=((callback:()=>void,ms:number)=>{const id={};timers.set(id,{callback,ms});return id;}) as any;
 globalThis.clearTimeout=((id:any)=>timers.delete(id)) as any;
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.runtime.handleEvent({type:'input_audio_buffer.speech_started',item_id:'pending-asr'});
  await h.runtime.handleEvent({type:'input_audio_buffer.speech_stopped',item_id:'pending-asr'});
  const deadline=[...timers.values()].find(t=>t.ms===10000)!;
  await h.runtime.handleEvent({type:'session.updated',session:{output_modalities:['audio'],audio:{input:{turn_detection:{create_response:true,interrupt_response:true}}}}});
  expect(h.runtime.state.speech?.action.kind).toBe('SPEAK_TERMINAL_ERROR');
  h.advance(10000);deadline.callback();for(let n=0;n<50;n++)await Promise.resolve();
  expect(h.terminations).toHaveLength(0);await h.play();expect(h.terminations).toHaveLength(1);
 }finally{h.runtime.stop();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('owner speech after the browser played ACK waits for its durable receipt without interrupting played audio',async()=>{
 const h=recoveryHarness({holdPlaybackReceipt:true});try{
  await h.runtime.attach();const played=h.play();
  for(let n=0;n<20 && h.receipts.length===0;n++)await Promise.resolve();
  expect(h.receipts).toHaveLength(1);
  h.runtime.observeEvent({type:'input_audio_buffer.speech_started',item_id:'owner-1'});
  h.releasePlayback();await played;await h.answer('cities');
  expect(h.interruptions).toHaveLength(0);expect(h.runtime.state.error).toBeUndefined();
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.runtime.state.stored.nextAction.itemId).toBe('hours');
 }finally{h.releasePlayback();h.runtime.stop();}
});

test('owner audio during the opening is retained without falsely acknowledging the interrupted audio',async()=>{
 const h=recoveryHarness();try{
  await h.runtime.attach();await h.answer('cities');
  expect(h.interruptions).toHaveLength(1);expect(h.receipts).toHaveLength(0);
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.runtime.state.stored.nextAction.itemId).toBe('hours');
  expect(h.transcripts.some(t=>t.role==='caller')).toBe(true);expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('transient persistence failure reconciles then retries the same operation and continues',async()=>{
 const h=recoveryHarness({commitFailure:'transient'});try{
  await h.runtime.attach();await h.play();await h.answer('cities');
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.runtime.state.speech?.action.kind).toBe('CONFIRM_AND_ASK_NEXT');
  expect(h.commitRequests).toHaveLength(2);expect(h.commitRequests[1]).toEqual(h.commitRequests[0]);expect(h.reads).toBe(1);
  expect(h.sent.some(e=>e.item?.content?.[0]?.text?.startsWith('ligou.website_progress:'))).toBe(true);
  expect(JSON.stringify(h.diagnostics)).not.toContain('private diagnostic text');
  expect(h.diagnostics.some(d=>d.code==='08006')).toBe(true);
 }finally{h.runtime.stop();}
});

test('timeout after commit uses durable readback and never applies an answer twice',async()=>{
 const h=recoveryHarness({commitFailure:'after_commit'});try{
  await h.runtime.attach();await h.play();await h.answer('cities');
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.runtime.state.stored.agenda.ownerTurns).toHaveLength(1);
  expect(h.runtime.state.speech?.action.kind).toBe('CONFIRM_AND_ASK_NEXT');
  expect(h.commitRequests).toHaveLength(1);expect(h.reads).toBe(1);expect(h.terminations).toHaveLength(0);
 }finally{h.runtime.stop();}
});

test('HTTP gateway failure without a database code recovers through durable readback',async()=>{
 const h=recoveryHarness({commitFailure:'http_unavailable'});try{
  await h.runtime.attach();await h.play();await h.answer('cities');
  expect(h.runtime.state.stored.revision).toBe(1);expect(h.commitRequests).toHaveLength(2);expect(h.reads).toBe(1);
 }finally{h.runtime.stop();}
});

test('authorization failure is blocked without retry or approval, while transient exhaustion is bounded',async()=>{
 for(const commitFailure of ['auth','exhausted'] as const){
  const h=recoveryHarness({commitFailure});try{
   await h.runtime.attach();await h.play();await h.answer('cities');
   expect(h.commitRequests.length).toBe(commitFailure==='auth'?1:3);
   expect(h.runtime.state.stored.revision).toBe(0);expect(h.runtime.state.approval).toBeUndefined();
   expect(h.runtime.state.speech?.action.kind).toBe('SPEAK_TERMINAL_ERROR');
  }finally{h.runtime.stop();}
 }
});

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
