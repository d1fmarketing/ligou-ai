import { createWebsiteAgendaCoordinator, reduceWebsiteAgenda, parseWebsiteInterpretation, websiteInterpretationFailureCode, buildWebsiteOpeningAction,buildWebsiteSummaryOpening,websiteSummaryPreparationId,type WebsiteSummaryReceipt,type WebsiteAgendaCommand, type WebsiteAgendaEvent, type WebsiteAgendaState } from "./onboarding-agenda-coordinator.ts";
import { createOnboardingAgendaStore, onboardingAgendaDigest } from "./onboarding-agenda-store.ts";
import { createInterviewEvidenceStore } from "./onboarding-interview-evidence-store.ts";
import { synthesizeOnboardingSpeech, speechPayloadIsInternallyValid, type OnboardingSpeechAction, type OnboardingSpeechPayload } from "./onboarding-speech.ts";
import type { PreparedWebsiteInterview } from "./onboarding-website-bootstrap.ts";
import { generateWebsiteSummaryParts } from "./onboarding-website-summary.ts";
import { validateWebsiteInterpretationFacts } from "./onboarding-website-facts.ts";
import { getAgendaItems, getAgendaAction, type AgendaProposal } from "./onboarding-agenda.ts";
import { randomUUID } from "node:crypto";
import {streamAuthorizationIsValid,streamControlId,streamResponseMatches,streamMediaEvidenceIsValid,normalizeWebsiteStreamTranscript,type StreamAuthorization,type StreamMediaEvidence,type StreamProof} from './onboarding-stream.ts';
import {requestResponse,type CoordinatedLedger} from './response-coordinator.ts';

type Interpret = Extract<WebsiteAgendaCommand,{type:"interpret_owner_turn"}>;
type DiagnosticDetail = {code?:string;attempt?:number;durationMs?:number;effectId?:string;
  proposalKind?:AgendaProposal['kind'];factCount?:number;targetCount?:number;outputCount?:number;
  toolCallCount?:number;discardedTextMessageCount?:number;parserRejectReason?:string};
interface WebsiteInterviewRuntimeBase {
  prepared: PreparedWebsiteInterview;
  openingAction: OnboardingSpeechAction;
  initialSummary?:WebsiteSummaryReceipt;
}
export type WebsiteInterviewRuntimeConfig=WebsiteInterviewRuntimeBase&(
  {openingPayload:OnboardingSpeechPayload;openingStream?:never}|{openingStream:StreamAuthorization;openingPayload?:never});
export interface WebsiteInterviewRuntimeDependencies {
  agendaStore: ReturnType<typeof createOnboardingAgendaStore>;
  evidenceStore: ReturnType<typeof createInterviewEvidenceStore>;
  synthesize(action: OnboardingSpeechAction, signal: AbortSignal): ReturnType<typeof synthesizeOnboardingSpeech>;
  /** Reuses the existing sideband's serialized onboarding queue. */
  enqueue(task:()=>Promise<void>): Promise<void>;
  send(event: Record<string,unknown>): void;
  onTranscript(entry:{role:"caller"|"agent";text:string;at:string}):void;
  onCost(cost:number):void;
  onUsage(response:unknown):void;
  onUsageUnknown():void;
  onTerminate(command:Extract<WebsiteAgendaCommand,{type:"terminate_session"}>):void;
  onState(state:WebsiteAgendaState):void;
  onDiagnostic?(event:{callId:string;requestId:string;stage:string;elapsedMs:number}&DiagnosticDetail):void;
  now?:()=>number;
}

export function websiteInterpretationRequest(command: Interpret) {
  const allItems=getAgendaItems(command.agenda);
  const current=allItems.find(item=>item.id===command.itemId);
  const related=new Set(current?.relatedItemIds??[]);
  const items=command.mode==='correction' ? allItems : allItems.filter(item=>item.id===command.itemId || related.has(item.id));
  const context={current_item_id:command.itemId,mode:command.mode,owner_transcript:command.transcript,
    items:items.map(item=>({id:item.id,source:item.source,subject:item.subject,question:item.questionPt,
      status:item.status,coverageRefs:item.coverageRefs,relatedItemIds:item.relatedItemIds,
      latest_evidence:item.evidence.at(-1)??null})),
    ...(command.mode==='correction'?{candidate_context:command.agenda.candidateContext}:{})};
  const input=JSON.stringify(context);
  if(Buffer.byteLength(input)>2_097_152)throw new Error('website_interpretation_context_too_large');
  return {type:'response.create',event_id:command.requestId,response:{conversation:'none',output_modalities:['text'],
    metadata:{website_request_id:command.requestId,website_turn_id:command.turnId,website_digest:command.digest,
      website_item_id:command.itemId??'',website_mode:'finite_onboarding_v1'},
    instructions:`${command.instructions} Typed facts are optional. Use facts:[] unless the existing field's exact value schema is known; the full literal owner answer is preserved independently. Never guess a typed value shape.`,tools:[{type:'function',name:command.toolName,
      description:'Return only the interpretation of the exact stored owner turn. This is not an approval or an executable action.',parameters:command.toolSchema}],
    tool_choice:{type:'function',name:command.toolName},max_output_tokens:4096,
    input:[{type:'message',role:'user',content:[{type:'input_text',text:input}]}]}};
}

export async function prepareWebsiteStreamOpening(prepared:PreparedWebsiteInterview,tenantName:string,dependencies:{evidence:ReturnType<typeof createInterviewEvidenceStore>}):Promise<WebsiteInterviewRuntimeBase&{openingStream:StreamAuthorization}>{
  let initialSummary:WebsiteSummaryReceipt|undefined;
  if(prepared.stored.state==='reviewing'){
    const stored=prepared.stored,parts=generateWebsiteSummaryParts({stored,projection:prepared.projection});
    initialSummary=await dependencies.evidence.prepareSummary({...prepared.scope,summaryId:websiteSummaryPreparationId(stored),
      expectedRevision:stored.revision,expectedStoreVersion:stored.storeVersion,expectedDigest:stored.digest,expectedReceiptId:stored.receiptId,parts});
  }
  const openingAction=initialSummary?buildWebsiteSummaryOpening(prepared.stored,initialSummary):buildWebsiteOpeningAction(prepared.stored,tenantName);
  const openingStream=await dependencies.evidence.claimStream({...prepared.scope,action:openingAction,
    ...(initialSummary?{summaryId:initialSummary.summaryId,partIndex:0}:{})});
  createWebsiteAgendaCoordinator(prepared.stored,{nowMs:performance.now(),openingAction,openingStream,initialSummary});
  return{prepared,openingAction,openingStream,...(initialSummary?{initialSummary}:{})};
}

/** Realtime may accompany a tool with assistant prose. Only the single named
 * completed tool can propose an effect; inert text is discarded at this boundary
 * and never reaches transcripts, captions, speech generation or commands. */
function websiteProposalOutput(output:unknown,toolName:string):{
  arguments?:string;toolCallCount?:number;discardedTextMessageCount?:number;parserRejectReason?:string;
}{
  if(!Array.isArray(output) || output.length<1 || output.length>5)return {parserRejectReason:'item_count'};
  const object=(value:unknown):value is Record<string,unknown>=>Boolean(value) && typeof value==='object' && !Array.isArray(value);
  const nonempty=(value:unknown)=>value!==undefined&&value!==null&&value!==''&&!(Array.isArray(value)&&value.length===0);
  const embeddedTool=(value:Record<string,unknown>)=>['tool_calls','tool_call','function_calls','function_call'].some(key=>nonempty(value[key]));
  const toolCallCount=output.filter(item=>object(item) && item.type==='function_call').length;
  let discardedTextMessageCount=0,textBytes=0,args:string|undefined;
  const counts=()=>({toolCallCount,discardedTextMessageCount});
  const reject=(parserRejectReason:string)=>({...counts(),parserRejectReason});
  // Preserve the existing 64 KiB proposal boundary as a whole-output bound;
  // at most four ignored messages/parts per message and 16 KiB combined text.
  try{if(Buffer.byteLength(JSON.stringify(output))>65_536)return reject('serialized_output_limit');}catch{return reject('serialization_failed');}
  for(const item of output){
    if(!object(item))return reject('item_shape');
    if(item.type==='function_call'){
      if(item.name!==toolName || item.status!=='completed' || typeof item.arguments!=='string'
        || Buffer.byteLength(item.arguments)>65_536)return reject('tool_contract');
      args=item.arguments;
      continue;
    }
    if(item.type!=='message' || item.role!=='assistant')return reject('message_role_or_type');
    if(!Array.isArray(item.content)||item.content.length>4)return reject('content_shape');
    if(embeddedTool(item))return reject('embedded_tool');
    // Only the text payload's kind and bounds matter here. Optional provider
    // metadata is discarded with the message; none of it can propose an effect.
    for(const part of item.content){
      if(!object(part)||part.type!=='output_text'||typeof part.text!=='string')return reject('text_part_contract');
      if(embeddedTool(part))return reject('embedded_tool');
      if(['audio','audio_base64'].some(key=>nonempty(part[key])))return reject('hidden_audio');
      textBytes+=Buffer.byteLength(part.text);
      if(textBytes>16_384)return reject('text_limit');
    }
    discardedTextMessageCount++;
  }
  return toolCallCount===1?{...counts(),arguments:args}:reject('tool_count');
}

export function createWebsiteInterviewRuntime(input:WebsiteInterviewRuntimeConfig,deps:WebsiteInterviewRuntimeDependencies) {
  const streaming=Boolean(input.openingStream);
  if(streaming?!streamAuthorizationIsValid(input.openingStream,input.openingAction):!speechPayloadIsInternallyValid(input.openingPayload,input.openingAction))throw new Error('website_runtime_opening_invalid');
  const now=deps.now??(()=>performance.now()),scope=input.prepared.scope,abort=new AbortController(),startedAt=now();
  let state=createWebsiteAgendaCoordinator(input.prepared.stored,{nowMs:now(),openingAction:input.openingAction,openingStream:input.openingStream,initialSummary:input.initialSummary});
  let payload:OnboardingSpeechPayload|null=input.openingPayload??null,stopped=false,deadline:ReturnType<typeof setTimeout>|undefined;
  let noticeTimer:ReturnType<typeof setTimeout>|undefined,noticeAttempts=0;
  let attachGeneration=0;
  let speechRetrieve:{actionId:string;eventId:string;generation:number}|undefined;
  const terminalResponses=new Set<string>(),callerItems=new Set<string>(),ownerTranscripts=new Map<string,string>();
  const retiredInterpretations=new Set<string>();
  let interpreter:Interpret|undefined,activeResponseId:string|undefined,ttsInFlight=false;
  let interpretationTiming:{requestId:string;requestedAtMs:number;created:boolean}|undefined;
  let speechAbort:AbortController|undefined;
  const observedCommands:WebsiteAgendaCommand[]=[];
  const retiredSpeech=new Set<string>();
  type Rendition={authorization:StreamAuthorization;authorizationAttempted?:boolean;readyRequested?:boolean;dispatched?:boolean;responseId?:string;itemId?:string;
    generationDone?:boolean;generationStatus?:string;transcript?:string;responseTranscript?:string;generationRecorded?:boolean;playoutRecorded?:boolean;played?:boolean;joinedProof?:StreamProof;
    bufferStarted?:boolean;bufferStopped?:boolean;cleared?:boolean;retired?:boolean;clearSent?:boolean;cancelEventId?:string;clearEventId?:string;
    clientPlayout?:{responseId:string;itemId:string;bufferStoppedEventId:string;mediaEvidence:StreamMediaEvidence};};
  const streamRenditions=new Map<string,Rendition>();
  let currentStream:Rendition|undefined=input.openingStream?{authorization:input.openingStream}:undefined;
  if(currentStream)streamRenditions.set(currentStream.authorization.dispatchId,currentStream);
  let clearBarrier:Rendition|undefined,clearTimer:ReturnType<typeof setTimeout>|undefined,interpreterInFlight=false;
  const streamIntents:CoordinatedLedger={callId:scope.callId,status:'active',requestedResponseIntentKeys:[]};
  const streamNotices=new Set<string>();
  const resumedStreams=new Map<string,StreamAuthorization>();
  const ownerContexts=new Map<string,{capturedItemId:string|null;approvalSummaryId:string|null}>();
  const resumedClaims=new Map<string,Awaited<ReturnType<WebsiteInterviewRuntimeDependencies['evidenceStore']['resumeSpeech']>>>();
  let recordingPlaybackActionId:string|undefined;
  let lastHeardQuestionItemId=getAgendaAction(input.prepared.stored.agenda).itemId??null;
  const asrWaiting=new Map<string,{retry:ReturnType<typeof setTimeout>;deadline:ReturnType<typeof setTimeout>;eventId?:string}>();
  const asrProbes=new Map<string,{itemId:string;generation:number}>(),expiredOwnerInputs=new Set<string>();
  const transientCodes=new Set(['08000','08001','08003','08006','40001','53300','57P01','57014','ETIMEDOUT','ECONNRESET','EAI_AGAIN','408','429','500','502','503','504']);
  function errorCode(error:unknown):string{
    const e=error as {code?:unknown;message?:unknown;status?:unknown};
    if(typeof e?.code==='string' && (transientCodes.has(e.code) || ['42501','23505','PGRST301','PGRST302','PGRST303','WEBSITE_SOURCE_CHANGED'].includes(e.code)))return e.code;
    if(e?.status===401 || e?.status===403)return '42501';
    if(typeof e?.status==='number' && transientCodes.has(String(e.status)))return String(e.status);
    if(typeof e?.message==='string' && /fetch failed|network request failed|failed to fetch|connection reset|timed out/i.test(e.message))return 'ETIMEDOUT';
    return 'unclassified_effect_error';
  }
  function diagnostic(stage:string,detail:DiagnosticDetail={}){
    // Observability cannot change a selected effect or suppress incurred cost.
    try{deps.onDiagnostic?.({callId:scope.callId,requestId:scope.requestId,stage,elapsedMs:Math.max(0,now()-startedAt),...detail});}catch{}
  }
  function announceStream(r:Rendition){
    if(stopped||r.retired||streamNotices.has(r.authorization.dispatchId))return;
    streamNotices.add(r.authorization.dispatchId);
    deps.send({type:'conversation.item.create',event_id:`website-stream-notice-${r.authorization.dispatchId}`,item:{id:streamControlId('notice',r.authorization.dispatchId),
      type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_stream:${JSON.stringify(r.authorization)}`}]}});
  }
  function clearStream(r:Rendition){
    if(!r.dispatched||r.cleared||(r.generationDone&&r.bufferStopped))return;
    clearBarrier=r;
    if(!clearTimer)clearTimer=setTimeout(()=>{void deps.enqueue(async()=>{
      if(clearBarrier===r&&!stopped){diagnostic('stream.clear_timeout');await dispatch({type:'stream.transport_failed',code:'stream_clear_unconfirmed',nowMs:now()});}
    }).catch(()=>{});},3000);
    if(!r.responseId||r.clearSent)return;
    r.clearSent=true;r.cancelEventId=`website-stream-cancel-${r.authorization.dispatchId}`;r.clearEventId=`website-stream-clear-${r.authorization.dispatchId}`;
    try{
      if(!r.generationDone)deps.send({type:'response.cancel',response_id:r.responseId,event_id:r.cancelEventId});
      deps.send({type:'output_audio_buffer.clear',event_id:r.clearEventId});
    }catch{diagnostic('stream.clear_send_unconfirmed',{effectId:r.authorization.dispatchId});}
  }
  function retireStream(r:Rendition){r.retired=true;retiredSpeech.add(r.authorization.action.actionId);clearStream(r);}
  async function streamFault(r:Rendition|undefined,code:string){
    if(stopped)return;
    if(r){retireStream(r);await bounded(()=>deps.evidenceStore.failSpeech({...scope,actionId:r.authorization.action.actionId,reason:code})).catch(()=>{});}
    await dispatch({type:'adapter.failed',code,nowMs:now()});
  }
  async function unsafeStreamResponse(responseId:unknown,code:string){
    if(typeof responseId==='string'&&responseId!==currentStream?.responseId)try{deps.send({type:'response.cancel',response_id:responseId});}catch{}
    if(currentStream)retireStream(currentStream);
    deps.onUsageUnknown();await dispatch({type:'stream.transport_failed',code,nowMs:now()});
  }
  async function releaseClear(r:Rendition){
    if(clearBarrier!==r)return;clearBarrier=undefined;if(clearTimer)clearTimeout(clearTimer);clearTimer=undefined;
    await maybeDispatchStream();
  }
  async function maybeDispatchStream(){
    const r=currentStream;
    if(!streaming||stopped||!r||r.retired||!r.readyRequested||r.authorizationAttempted||clearBarrier||interpreterInFlight
      ||currentSpeechActionId()!==r.authorization.action.actionId)return;
    if(!['error','amendment'].includes(state.speech?.after??'')&&(state.activeOwnerItemId||state.turns.some(turn=>!turn.processed)))return;
    r.authorizationAttempted=true;
    try{
      const proof=await bounded(()=>deps.evidenceStore.authorizeStream({...scope,stream:r.authorization}));
      if(stopped||r.retired||r!==currentStream||currentSpeechActionId()!==r.authorization.action.actionId)return;
      if(!streamAuthorizationIsValid(proof,r.authorization.action)||proof.dispatchId!==r.authorization.dispatchId||proof.receiptId!==r.authorization.receiptId)throw new Error('stream_authorization_changed');
      streamIntents.status='active';streamIntents.responseActive=interpreterInFlight;
      const requested=requestResponse(streamIntents,{send:frame=>deps.send(JSON.parse(frame))},{intentKey:r.authorization.dispatchId,
        purpose:r.authorization.action.kind==='SPEAK_FINAL_SIGNOFF'?'final_signoff':r.authorization.action.kind==='GENERATE_FINAL_SUMMARY'?'summary':'recovery',
        websiteStream:r.authorization,snapshotDigest:r.authorization.action.sourceDigest,
        instructions:'Fale em português brasileiro somente a fala selecionada pela aplicação. Preserve integralmente nomes, números, perguntas, condições, negações e conteúdo do resumo. Não acrescente ofertas, perguntas, decisões, aprovação ou ferramentas. Use entonação natural; não narre instruções, chaves ou metadados. Leia o conteúdo fornecido, sem omitir ou resumir informações.'});
      if(!requested)throw new Error('stream_dispatch_not_admitted');r.dispatched=true;
      diagnostic('stream.requested',{effectId:r.authorization.dispatchId});
      await dispatch({type:'stream.dispatched',actionId:r.authorization.action.actionId,dispatchId:r.authorization.dispatchId,nowMs:now()});
    }catch{await streamFault(r,'stream_dispatch_unconfirmed');}
  }
  async function acceptStreamProof(r:Rendition,proof:StreamProof){
    if(stopped||r.retired||r!==currentStream)return;
    if(proof.status==='rejected'){
      // The browser needs to distinguish this durable rejection from an
      // unexplained transport clear. It correlates the two in either order.
      deps.send({type:'conversation.item.create',event_id:`website-stream-retire-${r.authorization.dispatchId}`,item:{id:streamControlId('retire',r.authorization.dispatchId),
        type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_stream_retire:${JSON.stringify({
          actionId:r.authorization.action.actionId,dispatchId:r.authorization.dispatchId,responseId:r.responseId,
          generationReceiptId:proof.generationReceiptId,reason:'transcript_mismatch'})}`}]}});
      retireStream(r);diagnostic('stream.transcript_rejected',{effectId:r.authorization.dispatchId});
      await dispatch({type:'stream.rejected',actionId:r.authorization.action.actionId,dispatchId:r.authorization.dispatchId,generationReceiptId:proof.generationReceiptId!,nowMs:now()});return;
    }
    if(proof.status==='played')r.joinedProof=proof;
    if(!r.joinedProof||r.played||!r.generationRecorded||!r.generationDone||!r.clientPlayout)return;
    r.played=true;
    if(['ASK_NEXT_GAP','CLARIFY_CURRENT_GAP','CONFIRM_AND_ASK_NEXT','DEFER_OFF_SCOPE_AND_CONTINUE','HANDLE_OWNER_CORRECTION'].includes(r.authorization.action.kind))
      lastHeardQuestionItemId=getAgendaAction(state.stored.agenda).itemId??null;
    deps.onTranscript({role:'agent',text:r.transcript!,at:new Date().toISOString()});diagnostic('stream.played',{effectId:r.authorization.dispatchId});
    await dispatch({type:'stream.played',...r.joinedProof,nowMs:now()});
  }
  async function writeStreamProof(operation:()=>Promise<StreamProof>,r:Rendition):Promise<StreamProof>{
    for(let attempt=0;;attempt++)try{return await bounded(operation,2500);}catch(error){
      requireLive();if(attempt>0||r.retired||!transientCodes.has(errorCode(error)))throw error;
      diagnostic('stream.receipt_retry',{effectId:r.authorization.dispatchId,attempt:1,code:errorCode(error)});
    }
  }
  async function persistStreamGeneration(r:Rendition){
    if(r.retired||r.generationRecorded||!r.generationDone||!r.transcript||!r.responseId||!r.itemId)return;
    if(r.generationStatus!=='completed'||typeof r.responseTranscript!=='string'
      ||normalizeWebsiteStreamTranscript(r.responseTranscript)!==normalizeWebsiteStreamTranscript(r.transcript)){await streamFault(r,'stream_generation_invalid');return;}
    r.generationRecorded=true;
    if(r.clientPlayout)recordingPlaybackActionId=r.authorization.action.actionId;
    try{const proof=await writeStreamProof(()=>deps.evidenceStore.recordStreamResponse({...scope,stream:r.authorization,responseId:r.responseId!,itemId:r.itemId!,transcript:r.transcript!,status:'completed'}),r);
      await acceptStreamProof(r,proof);
    }finally{if(recordingPlaybackActionId===r.authorization.action.actionId)recordingPlaybackActionId=undefined;}
  }
  async function persistStreamPlayout(r:Rendition){
    if(r.retired||r.playoutRecorded||!r.clientPlayout||!r.responseId||!r.itemId)return;
    if(r.clientPlayout.responseId!==r.responseId||r.clientPlayout.itemId!==r.itemId){await streamFault(r,'stream_client_playout_mismatch');return;}
    r.playoutRecorded=true;
    if(r.generationDone)recordingPlaybackActionId=r.authorization.action.actionId;
    try{const proof=await writeStreamProof(()=>deps.evidenceStore.recordStreamPlayout({...scope,stream:r.authorization,...r.clientPlayout!}),r);await acceptStreamProof(r,proof);}
    finally{if(recordingPlaybackActionId===r.authorization.action.actionId)recordingPlaybackActionId=undefined;}
  }
  function streamControl(event:any):{kind:'ready'|'played'|'interrupted';r:Rendition;value:any}|null{
    if(!['conversation.item.created','conversation.item.done'].includes(event?.type))return null;
    const item=event.item;
    if(!item||item.type!=='message'||item.role!=='system'||item.status!=='completed'||!Array.isArray(item.content)||item.content.length!==1
      ||Object.keys(item).some(key=>!['id','object','type','role','status','content'].includes(key))||item.content[0]?.type!=='input_text'
      ||(item.object!==undefined&&item.object!=='realtime.item')
      ||Object.keys(item.content[0]).some(key=>!['type','text'].includes(key))||typeof item.content[0].text!=='string'||item.content[0].text.length>4096)return null;
    const match=/^ligou\.website_stream_(ready|played|interrupted):(.*)$/s.exec(item.content[0].text);if(!match)return null;
    try{const value=JSON.parse(match[2]!),r=streamRenditions.get(value?.dispatchId),kind=match[1] as 'ready'|'played'|'interrupted';
      if(!r||value.actionId!==r.authorization.action.actionId||item.id!==streamControlId(kind,r.authorization.dispatchId))return null;
      return{kind,r,value};}catch{return null;}
  }
  async function handleStreamEvent(event:any):Promise<boolean>{
    if(!streaming)return false;
    const control=streamControl(event);
    if(control){const {kind,r,value}=control;if(r.retired||r.played||r!==currentStream)return true;
      if(kind==='ready'&&Object.keys(value).length===2){r.readyRequested=true;await maybeDispatchStream();}
      else if(kind==='played'&&Object.keys(value).length===6&&typeof value.responseId==='string'&&typeof value.itemId==='string'
        &&typeof value.bufferStoppedEventId==='string'&&value.bufferStoppedEventId.length>0&&value.bufferStoppedEventId.length<=512&&streamMediaEvidenceIsValid(value.mediaEvidence)){
        const playout={responseId:value.responseId,itemId:value.itemId,bufferStoppedEventId:value.bufferStoppedEventId,mediaEvidence:value.mediaEvidence};
        if(r.clientPlayout&&JSON.stringify(r.clientPlayout)!==JSON.stringify(playout)){await streamFault(r,'stream_playout_conflict');return true;}
        r.clientPlayout=playout;await persistStreamPlayout(r);
      }else if(kind==='interrupted'&&Object.keys(value).length===4&&typeof value.providerItemId==='string'&&value.providerItemId.length>0&&value.providerItemId.length<=400
        &&(value.responseId===null||value.responseId===r.responseId)){
        observeEvent({type:'input_audio_buffer.speech_started',item_id:value.providerItemId});
        for(const command of observedCommands.splice(0))await execute(command);
      }
      return true;
    }
    if(event?.type==='response.created'||event?.type==='response.done'){
      const response=event.response,metadata=response?.metadata;
      const r=streamRenditions.get(metadata?.ligou_dispatch_id);
      if(!r&&metadata?.ligou_transport!=='realtime_stream_v1')return false;
      if(!r||!r.dispatched||!streamResponseMatches(metadata,r.authorization)||typeof response?.id!=='string'){
        if(event.type==='response.done'&&!terminalResponses.has(response?.id)){terminalResponses.add(response?.id);deps.onUsage(response);}
        await unsafeStreamResponse(response?.id,'unsolicited_stream_response');return true;
      }
      if(r.responseId&&r.responseId!==response.id){await unsafeStreamResponse(response.id,'concurrent_stream_response');return true;}
      r.responseId=response.id;
      if(event.type==='response.created'){if(r.retired)clearStream(r);diagnostic('stream.created',{effectId:r.authorization.dispatchId});return true;}
      if(terminalResponses.has(response.id))return true;terminalResponses.add(response.id);deps.onUsage(response);
      r.generationDone=true;r.generationStatus=response.status;streamIntents.responseActive=interpreterInFlight;
      if(r.retired)return true;
      const outputs=response.output,item=Array.isArray(outputs)&&outputs.length===1?outputs[0]:null,part=item?.content?.[0];
      if(response.status!=='completed'||item?.type!=='message'||item.role!=='assistant'||item.status!=='completed'||typeof item.id!=='string'
        ||!Array.isArray(item.content)||item.content.length!==1||part?.type!=='output_audio'||typeof part.transcript!=='string'||!part.transcript.trim()||part.transcript.length>8192
        ||(r.itemId&&r.itemId!==item.id)){await streamFault(r,'stream_response_shape_invalid');return true;}
      r.itemId=item.id;r.responseTranscript=part.transcript;
      // response.done contains the final audio transcript too. Use that actual
      // provider value if its standalone transcript-done event arrives later.
      r.transcript??=part.transcript;diagnostic('stream.generated',{effectId:r.authorization.dispatchId});
      await persistStreamGeneration(r);await persistStreamPlayout(r);return true;
    }
    const type=String(event?.type??'');
    if(!type.startsWith('output_audio_buffer.')&&!type.startsWith('response.output_audio.')&&!type.startsWith('response.output_audio_transcript.')
      &&!['response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done'].includes(type))return false;
    const r=[...streamRenditions.values()].find(value=>value.responseId===event.response_id);
    if(!r){if(type.startsWith('output_audio_buffer.')||type.startsWith('response.output_audio.')){await unsafeStreamResponse(event.response_id,'unbound_stream_audio');return true;}return false;}
    if(type==='output_audio_buffer.cleared'){const expected=r.retired;r.cleared=true;r.retired=true;await releaseClear(r);if(!expected&&!r.played)await streamFault(r,'unexpected_stream_clear');return true;}
    if(type==='output_audio_buffer.stopped'){r.bufferStopped=true;await releaseClear(r);return true;}
    if(r.retired||r.played)return true;
    if(type==='output_audio_buffer.started'){r.bufferStarted=true;diagnostic('stream.buffer_started',{effectId:r.authorization.dispatchId});return true;}
    if(type==='response.output_item.added'||type==='response.output_item.done'){
      if(event.output_index!==0||event.item?.type!=='message'||event.item.role!=='assistant'||typeof event.item.id!=='string'||(r.itemId&&r.itemId!==event.item.id)){
        await streamFault(r,'stream_output_item_invalid');return true;}
      r.itemId=event.item.id;await persistStreamPlayout(r);return true;
    }
    if(type==='response.content_part.added'||type==='response.content_part.done'){
      // GA content-part events say "audio"; the final response item's content
      // says "output_audio". They are distinct provider schemas.
      if(event.output_index!==0||event.content_index!==0||event.item_id!==r.itemId||event.part?.type!=='audio')await streamFault(r,'stream_content_part_invalid');return true;
    }
    if(event.output_index!==0||event.content_index!==0||event.item_id!==r.itemId){await streamFault(r,'stream_audio_binding_invalid');return true;}
    if(type==='response.output_audio_transcript.done'){
      if(typeof event.transcript!=='string'||!event.transcript.trim()||event.transcript.length>8192
        ||(r.transcript&&normalizeWebsiteStreamTranscript(r.transcript)!==normalizeWebsiteStreamTranscript(event.transcript))){await streamFault(r,'stream_transcript_conflict');return true;}
      r.transcript=event.transcript;await persistStreamGeneration(r);
    }
    return true;
  }
  function clearAsrWait(itemId:string){const wait=asrWaiting.get(itemId);if(wait){clearTimeout(wait.retry);clearTimeout(wait.deadline);asrWaiting.delete(itemId);}}
  function clearTimers(){if(deadline)clearTimeout(deadline);if(noticeTimer)clearTimeout(noticeTimer);if(clearTimer)clearTimeout(clearTimer);deadline=undefined;noticeTimer=undefined;clearTimer=undefined;for(const itemId of asrWaiting.keys())clearAsrWait(itemId);}
  function stop(){if(stopped)return;if(ttsInFlight)deps.onUsageUnknown();if(streaming&&currentStream&&!currentStream.played)retireStream(currentStream);stopped=true;streamIntents.status='ended';speechRetrieve=undefined;clearTimers();abort.abort();}
  function requireLive(){if(stopped || abort.signal.aborted)throw new Error('website_runtime_stopped');}
  function currentSpeechActionId(){return state.phase==='opening'?state.openingAction.actionId:state.speech?.action.actionId;}
  function publish(){
    if(speechRetrieve && (payload?.actionId!==speechRetrieve.actionId || currentSpeechActionId()!==speechRetrieve.actionId))speechRetrieve=undefined;
    if(state.termination || ['error','amendment'].includes(state.speech?.after??'')){
      for(const itemId of asrWaiting.keys()){expiredOwnerInputs.add(itemId);callerItems.delete(itemId);clearAsrWait(itemId);}
    }
    deps.onState(state);scheduleDeadline();
  }
  function waitForFinalTranscript(itemId:string){
    if(asrWaiting.has(itemId) || ownerTranscripts.has(itemId) || expiredOwnerInputs.has(itemId) || !callerItems.has(itemId) || state.termination || ['error','amendment'].includes(state.speech?.after??''))return;
    const wait={retry:undefined as unknown as ReturnType<typeof setTimeout>,deadline:undefined as unknown as ReturnType<typeof setTimeout>,eventId:undefined as string|undefined};
    wait.retry=setTimeout(()=>{
      if(stopped || asrWaiting.get(itemId)!==wait)return;
      const id=randomUUID();wait.eventId=`website-asr-retrieve-${id}`;
      asrProbes.set(wait.eventId,{itemId,generation:attachGeneration});
      diagnostic('owner.asr_retrieve',{effectId:id});
      try{
        deps.send({type:'conversation.item.retrieve',event_id:wait.eventId,item_id:itemId});
        deps.send({type:'conversation.item.create',item:{id:`lsp-${id.slice(0,28)}`,type:'message',role:'system',status:'completed',
          content:[{type:'input_text',text:`ligou.website_progress:${JSON.stringify({requestId:id,stage:'retrying'})}`}]}});
      }catch{diagnostic('owner.asr_retrieve_unavailable');}
    },5000);
    wait.deadline=setTimeout(()=>{
      if(stopped || asrWaiting.get(itemId)!==wait)return;
      clearAsrWait(itemId);expiredOwnerInputs.add(itemId);callerItems.delete(itemId);
      diagnostic('owner.asr_deadline');
      // Fence the late event immediately, even if serialized IO is still busy.
      let reduced=reduceWebsiteAgenda(state,{type:'owner.speech_finished',providerItemId:itemId,nowMs:now()});
      state=reduced.state;
      reduced=reduceWebsiteAgenda(state,{type:'adapter.failed',code:'website_asr_deadline_exceeded',nowMs:now()});
      state=reduced.state;publish();
      void deps.enqueue(async()=>{for(const command of reduced.commands)await execute(command);}).catch(()=>{});
    },10000);
    asrWaiting.set(itemId,wait);
  }
  /** Observe speech immediately, before the serialized queue finishes remote
   * work. Only final provider transcripts may subsequently change the draft. */
  function observeEvent(event:any):void{
    if(stopped)return;
    if(typeof event?.item_id==='string'){
      if(event.type==='conversation.item.input_audio_transcription.failed' ||
        (event.type==='conversation.item.input_audio_transcription.completed' && typeof event.transcript==='string'))clearAsrWait(event.item_id);
      if(event.type==='input_audio_buffer.speech_stopped'){waitForFinalTranscript(event.item_id);return;}
    }
    if(stopped || event?.type!=='input_audio_buffer.speech_started' || typeof event.item_id!=='string' ||
      callerItems.has(event.item_id) || ownerTranscripts.has(event.item_id) || expiredOwnerInputs.has(event.item_id) || state.termination || ['failed','complete'].includes(state.phase))return;
    if(state.speech?.after==='error' || state.speech?.after==='amendment')return;
    const previousAction=currentSpeechActionId();
    const afterPlayedAck=Boolean(previousAction && recordingPlaybackActionId===previousAction);
    // The next question can be answered while its published audio is playing.
    // Until that audio exists, a continuation still belongs to the heard question.
    const currentQuestionPublished=state.speech?.after==='owner' && (streaming?currentStream?.authorization.action.actionId===previousAction&&currentStream.bufferStarted:payload?.actionId===previousAction);
    ownerContexts.set(event.item_id,{capturedItemId:state.summary || currentQuestionPublished?getAgendaAction(state.stored.agenda).itemId??null:lastHeardQuestionItemId,
      approvalSummaryId:asrWaiting.size===0 && (state.phase==='awaiting_approval' || (afterPlayedAck && state.speech?.after==='approval'))?state.summary?.summaryId??null:null});
    callerItems.add(event.item_id);
    const reduced=reduceWebsiteAgenda(state,{type:'owner.speech_started',providerItemId:event.item_id,
      ...(afterPlayedAck?{afterPlaybackActionId:previousAction}:{}),nowMs:now()});
    state=reduced.state;observedCommands.push(...reduced.commands);
    if(previousAction && reduced.commands.some(command=>command.type==='interrupt_speech')){
      if(streaming&&currentStream&&currentStream.authorization.action.actionId===previousAction)retireStream(currentStream);
      retiredSpeech.add(previousAction);speechAbort?.abort();payload=null;speechRetrieve=undefined;
      if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=undefined;
      diagnostic('speech.interrupted');
    }
    diagnostic('owner.speech_started');publish();
  }
  /** Only this exact live retrieve request may explain a missing item while
   * browser playback is still pending. It never proves playback or advances. */
  function ownsSpeechRetrieveMiss(event:any):boolean{
    const error=event?.error;
    const asr=asrProbes.get(error?.event_id);
    const ownsSpeech=!!payload && !!speechRetrieve
      && speechRetrieve.generation===attachGeneration
      && speechRetrieve.actionId===payload.actionId
      && speechRetrieve.actionId===currentSpeechActionId()
      && error?.event_id===speechRetrieve.eventId;
    const itemId=asr?.itemId??(ownsSpeech?`lgs-${payload!.actionId.slice(0,28)}`:'');
    const escaped=itemId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    // Known old read misses are ignored, never promoted to successful evidence.
    return !stopped && (Boolean(asr) || ownsSpeech) && event?.type==='error'
      && (error?.code==='item_not_found' ||
        (error?.type==='invalid_request_error' && error?.param==='item_id'
          && (error.code===undefined || error.code===null || error.code==='invalid_request_error')
          && typeof error.message==='string'
          && new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`).test(error.message)
          && /\b(?:not found|does not exist)\b/i.test(error.message)));
  }
  function scheduleDeadline(){
    if(deadline)clearTimeout(deadline);deadline=undefined;
    if(stopped || state.phase==='complete' || state.phase==='failed')return;
    const pendingOwner=state.turns.find(turn=>!turn.recorded);
    const due=state.pending?{id:state.pending.requestId,at:state.pending.deadlineAtMs}
      :pendingOwner?{id:pendingOwner.requestId,at:pendingOwner.deadlineAtMs}
      :state.speech?{id:state.speech.action.actionId,at:state.speech.deadlineAtMs}
      :state.phase==='opening'?{id:state.openingAction.actionId,at:state.openingDeadlineAtMs}
      :state.termination?{id:state.termination.requestId,at:state.termination.deadlineAtMs}:null;
    if(due)deadline=setTimeout(()=>{void deps.enqueue(()=>dispatch({type:'deadline',requestId:due.id,nowMs:now()})).catch(()=>{});},Math.max(1,due.at-now()));
  }
  async function bounded<T>(operation:(signal:AbortSignal)=>Promise<T>,timeoutMs=15_000):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const operationAbort=new AbortController();
    const cancel=()=>operationAbort.abort();abort.signal.addEventListener('abort',cancel,{once:true});
    try{requireLive();const result=await Promise.race([operation(operationAbort.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
      operationAbort.abort();reject(Object.assign(new Error('website_effect_timeout'),{code:'ETIMEDOUT'}));
    },timeoutMs);})]);requireLive();return result;}
    finally{if(timer)clearTimeout(timer);abort.signal.removeEventListener('abort',cancel);}
  }
  async function commitWithRecovery(command:Extract<WebsiteAgendaCommand,{type:'persist_agenda'}>,facts:ReturnType<typeof validateWebsiteInterpretationFacts>){
    const start=now(),deadlineAt=start+10_000;
    const expectedDigest=onboardingAgendaDigest(command.agenda);
    let lastError:unknown;
    for(let attempt=0;attempt<3 && now()<deadlineAt;attempt++){
      requireLive();
      try{
        // The effect requestId deduplicates work; the browser requestId authorizes it.
        const result=await bounded(signal=>deps.agendaStore.commitOwnerTurn({...command,...scope,signal,facts}),Math.min(2500,deadlineAt-now()));
        diagnostic('answer.commit',{attempt,durationMs:now()-start,effectId:command.requestId});return result;
      }catch(error){
        requireLive();lastError=error;const code=errorCode(error);
        diagnostic('answer.commit_failed',{code,attempt,durationMs:now()-start,effectId:command.requestId});
        if(!transientCodes.has(code))throw error;
        // A timeout is not proof of rollback. Read the authoritative receipt
        // before replaying this exact idempotent owner operation.
        try{
          const stored=await bounded(signal=>deps.agendaStore.readWebsiteInterview({...scope,signal}),Math.min(2500,Math.max(1,deadlineAt-now())));
          if(stored.digest===expectedDigest && stored.revision===command.agenda.revision && stored.storeVersion===command.expectedStoreVersion+1){
            diagnostic('answer.reconciled',{attempt,durationMs:now()-start,effectId:command.requestId});return stored;
          }
          if(stored.digest!==command.expectedDigest || stored.storeVersion!==command.expectedStoreVersion)
            throw Object.assign(new Error('website_answer_source_changed'),{code:'WEBSITE_SOURCE_CHANGED'});
        }catch(readError){
          requireLive();if(!transientCodes.has(errorCode(readError)))throw readError;
          diagnostic('answer.reconcile_unavailable',{code:errorCode(readError),attempt,effectId:command.requestId});
        }
        if(attempt<2 && now()<deadlineAt){
          if(attempt===0)deps.send({type:'conversation.item.create',item:{id:`lsp-${command.requestId.slice(0,28)}`,type:'message',role:'system',status:'completed',
            content:[{type:'input_text',text:`ligou.website_progress:${JSON.stringify({requestId:command.requestId,stage:'retrying'})}`}]}});
          await new Promise<void>(resolve=>setTimeout(resolve,Math.min(100*(attempt+1),Math.max(1,deadlineAt-now()))));
        }
      }
    }
    throw lastError??Object.assign(new Error('website_recovery_exhausted'),{code:'ETIMEDOUT'});
  }
  function notice(){
    if(stopped || !payload)return;
    if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=undefined;
    const id=payload.actionId;
    // A repeated deterministic notice never creates another TTS request or play.
    if(noticeAttempts===0)deps.send({type:'conversation.item.create',event_id:`website-notice-${id.slice(0,24)}`,
      item:{id:`lsn-${id.slice(0,28)}`,type:'message',role:'system',status:'completed',content:[{type:'input_text',text:`ligou.website_speech:${id}`} ]}});
    else deps.send({type:'conversation.item.retrieve',event_id:`website-notice-retrieve-${id.slice(0,24)}-${noticeAttempts}`,item_id:`lsn-${id.slice(0,28)}`});
    if(noticeAttempts++<2)noticeTimer=setTimeout(()=>{void deps.enqueue(async()=>{
      if(payload?.actionId===id && !stopped)notice();
    }).catch(()=>{});},5000);
  }
  async function dispatch(event:WebsiteAgendaEvent):Promise<void>{
    if(stopped)return;
    const reduced=reduceWebsiteAgenda(state,event);state=reduced.state;publish();
    for(const command of reduced.commands)await execute(command);
    if(streaming)await maybeDispatchStream();
  }
  async function execute(command:WebsiteAgendaCommand):Promise<void>{
    if(stopped)return;
    try{
      switch(command.type){
        case 'record_empty_input':{
          const receipt=await bounded(()=>deps.evidenceStore.recordEmptyInput({...scope,actionId:command.actionId,providerItemId:command.providerItemId}));
          await dispatch({type:'empty_input.recorded',requestId:command.requestId,...receipt,nowMs:now()});break;
        }
        case 'interrupt_speech':{
          const receipt=await bounded(()=>deps.evidenceStore.interruptSpeech({...scope,actionId:command.actionId,providerItemId:command.providerItemId}));
          if(!receipt?.receiptId || receipt.actionId!==command.actionId || receipt.providerItemId!==command.providerItemId)
            throw new Error('website_interruption_receipt_mismatch');
          break;
        }
        case 'resume_speech':{
          if(streaming){
            const authorization=await bounded(()=>deps.evidenceStore.resumeStream({...scope,actionId:command.actionId,providerItemId:command.providerItemId}));
            resumedStreams.set(authorization.action.actionId,authorization);
            await dispatch({type:'speech.resumed',requestId:command.requestId,action:authorization.action,nowMs:now()});break;
          }
          const receipt=await bounded(()=>deps.evidenceStore.resumeSpeech({...scope,actionId:command.actionId,providerItemId:command.providerItemId}));
          resumedClaims.set(receipt.action.actionId,receipt);
          await dispatch({type:'speech.resumed',requestId:command.requestId,action:receipt.action,nowMs:now()});break;
        }
        case 'request_amendment':{
          const receipt=await bounded(()=>deps.evidenceStore.requestAmendment({...scope,approvalReceiptId:command.approvalReceiptId,
            providerItemId:command.providerItemId,proposal:command.proposal}));
          await dispatch({type:'amendment.requested',requestId:command.requestId,...receipt,nowMs:now()});break;
        }
        case 'record_owner_turn':{
          const result=await bounded(signal=>deps.agendaStore.recordOwnerTranscript({...scope,signal,providerItemId:command.providerItemId,text:command.text}));
          await dispatch({type:'owner_turn.recorded',...result,requestId:command.requestId,nowMs:now()});break;
        }
        case 'interpret_owner_turn':
          if(interpreter && interpreter.requestId!==command.requestId){
            retiredInterpretations.add(interpreter.requestId);
            if(activeResponseId)deps.send({type:'response.cancel',response_id:activeResponseId});
          }
          activeResponseId=undefined;
          interpreterInFlight=true;
          interpreter=command;
          interpretationTiming={requestId:command.requestId,requestedAtMs:now(),created:false};
          diagnostic('interpretation.requested',{attempt:command.attempt,effectId:command.requestId});
          deps.send(websiteInterpretationRequest(command));break;
        case 'persist_agenda':{
          const ownerTranscript=state.turns.find(turn=>turn.turnId===command.turnId)?.text;
          if(!ownerTranscript)throw new Error('website_owner_transcript_missing');
          const facts=validateWebsiteInterpretationFacts({facts:command.facts,proposal:command.proposal,
            currentItemId:command.currentItemId,agenda:state.stored.agenda,ownerTranscript});
          const stored=await commitWithRecovery(command,facts);
          await dispatch({type:'agenda.persisted',requestId:command.requestId,stored,nowMs:now()});break;
        }
        case 'prepare_summary':{
          const stored=await bounded(()=>deps.agendaStore.readWebsiteInterview(scope));
          if(stored.digest!==command.digest || stored.receiptId!==command.receiptId || stored.storeVersion!==command.storeVersion)
            throw new Error('website_summary_source_changed');
          const parts=generateWebsiteSummaryParts({stored,projection:input.prepared.projection});
          const receipt=await bounded(()=>deps.evidenceStore.prepareSummary({...scope,summaryId:command.requestId,
            expectedRevision:command.revision,expectedStoreVersion:command.storeVersion,expectedDigest:command.digest,
            expectedReceiptId:command.receiptId,parts}));
          await dispatch({type:'summary.ready',requestId:command.requestId,...receipt,nowMs:now()});break;
        }
        case 'persist_approval':{
          const receipt=await bounded(()=>deps.evidenceStore.approveSummary({...scope,summaryId:command.summaryId,
            summaryHash:command.summaryHash,providerItemId:command.providerItemId,expectedRevision:command.revision,
            expectedStoreVersion:command.expectedStoreVersion,expectedDigest:command.digest}));
          await dispatch({type:'approval.persisted',requestId:command.requestId,...receipt,nowMs:now()});break;
        }
        case 'request_speech':{
          if(retiredSpeech.has(command.action.actionId))return;
          if(streaming){
            const authorization=resumedStreams.get(command.action.actionId)??await bounded(()=>deps.evidenceStore.claimStream({...scope,action:command.action,
              summaryId:command.summaryId,partIndex:command.partIndex,clarificationTurnId:command.clarificationTurnId}));
            resumedStreams.delete(command.action.actionId);
            if(stopped||retiredSpeech.has(command.action.actionId))return;
            const rendition={authorization};currentStream=rendition;streamRenditions.set(authorization.dispatchId,rendition);
            await dispatch({type:'stream.authorized',stream:authorization,nowMs:now()});announceStream(rendition);break;
          }
          const renditionAbort=new AbortController();speechAbort=renditionAbort;
          const summary=state.summary;
          const latestTurn=state.turns.at(-1);
          const association=summary && ['GENERATE_FINAL_SUMMARY','REQUEST_FINAL_APPROVAL'].includes(command.action.kind)
            ?{summaryId:summary.summaryId,...(command.action.kind==='GENERATE_FINAL_SUMMARY'?{partIndex:summary.partIndex}:{}),
              ...(command.action.kind==='REQUEST_FINAL_APPROVAL' && state.approvalClarifications>0 && latestTurn?{clarificationTurnId:latestTurn.turnId}:{})}:{};
          const claim=resumedClaims.get(command.action.actionId)??await bounded(()=>deps.evidenceStore.claimSpeech({...scope,action:command.action,...association}));
          resumedClaims.delete(command.action.actionId);
          if(retiredSpeech.has(command.action.actionId))return;
          let ready=claim.payload;
          if(claim.status==='preparing' && claim.claimed){
            try{
              ttsInFlight=true;
              const synthesisStartedAt=now();diagnostic('tts.requested');
              ready=await deps.synthesize(command.action,AbortSignal.any([abort.signal,renditionAbort.signal]));requireLive();ttsInFlight=false;
              diagnostic('tts.ready',{durationMs:Math.max(0,now()-synthesisStartedAt)});
              deps.onCost(ready.cost_usd);
              if(retiredSpeech.has(command.action.actionId))return;
              const completed=await bounded(()=>deps.evidenceStore.completeSpeech({...scope,actionId:command.action.actionId,payload:ready!}));
              ready=completed.payload;
            }catch(error){
              ttsInFlight=false;
              if(stopped)return;
              const failure=error as {usageResolved?:boolean;costUsd?:number};
              if(!ready && failure.usageResolved && typeof failure.costUsd==='number')deps.onCost(failure.costUsd);
              if(!ready && failure.usageResolved!==true)deps.onUsageUnknown();
              if(retiredSpeech.has(command.action.actionId))return;
              await bounded(()=>deps.evidenceStore.failSpeech({...scope,actionId:command.action.actionId,reason:'tts_or_persistence_failed'})).catch(()=>{});
              throw error;
            }
          }else if(claim.status!=='ready'){
            if(claim.status==='preparing')deps.onUsageUnknown();
            throw new Error('website_speech_not_publishable');
          }
          if(!ready || !speechPayloadIsInternallyValid(ready,command.action))throw new Error('website_speech_readback_invalid');
          if(retiredSpeech.has(command.action.actionId))return;
          payload=ready;noticeAttempts=0;
          await dispatch({type:'speech.ready',actionId:ready.actionId,textSha256:ready.text_sha256,audioSha256:ready.audio_sha256,nowMs:now()});
          notice();break;
        }
        case 'terminate_session':clearTimers();deps.onTerminate(command);break;
        case 'record_completion':{
          const receipt=await bounded(()=>deps.evidenceStore.recordCompletion({...scope,outcome:command.outcome,approvalReceiptId:command.approvalReceiptId}));
          await dispatch({type:'completion.recorded',requestId:command.requestId,...receipt,nowMs:now()});break;
        }
        case 'telemetry':
          diagnostic(command.code,{attempt:command.attempt,effectId:command.requestId,
            ...(command.reason?{code:websiteInterpretationFailureCode(command.reason)}:{}),
            ...(command.proposalKind?{proposalKind:command.proposalKind,factCount:command.factCount,targetCount:command.targetCount}:{})});
          break;
      }
    }catch(error){
      diagnostic('effect.failed',{code:errorCode(error),...('requestId'in command?{effectId:command.requestId}:{})});
      if(command.type==='interrupt_speech')await dispatch({type:'adapter.failed',code:'interruption_persistence_failed',nowMs:now()});
      else if(command.type==='request_speech')await dispatch({type:'speech.failed',actionId:command.action.actionId,code:'speech_effect_failed',nowMs:now()});
      else if('requestId'in command)await dispatch({type:'effect.failed',requestId:command.requestId,code:'website_effect_failed',nowMs:now()});
    }
  }
  async function handleEvent(event:any):Promise<void>{
    if(stopped){if(streaming&&event?.type==='response.done'&&typeof event.response?.id==='string'&&!terminalResponses.has(event.response.id)){
      terminalResponses.add(event.response.id);deps.onUsage(event.response);}return;}
    observeEvent(event);
    for(const command of observedCommands.splice(0))await execute(command);
    if(streaming){try{if(await handleStreamEvent(event))return;}catch{await streamFault(currentStream,'stream_evidence_unconfirmed');return;}}
    if(event?.type==='input_audio_buffer.speech_started'){
      return;
    }
    if(event?.type==='input_audio_buffer.speech_stopped'){diagnostic('owner.speech_stopped');return;}
    if(event?.type==='conversation.item.input_audio_transcription.completed'){
      if(expiredOwnerInputs.has(event.item_id))return;
      const previous=ownerTranscripts.get(event.item_id);
      if(previous!==undefined){
        if(previous!==event.transcript && (previous.trim() || String(event.transcript??'').trim()))
          await dispatch({type:'adapter.failed',code:'conflicting_owner_transcript',nowMs:now()});
        return;
      }
      if(typeof event.item_id!=='string' || typeof event.transcript!=='string')return;
      callerItems.delete(event.item_id);
      if(!event.transcript.trim()){
        ownerTranscripts.set(event.item_id,event.transcript);
        diagnostic('owner.transcript_empty');
        await dispatch({type:'owner.transcript_empty',providerItemId:event.item_id,nowMs:now()});return;
      }
      const captured=ownerContexts.get(event.item_id)??{capturedItemId:getAgendaAction(state.stored.agenda).itemId??null,approvalSummaryId:null};
      ownerTranscripts.set(event.item_id,event.transcript);
      diagnostic('owner.transcript_final');
      deps.onTranscript({role:'caller',text:event.transcript,at:new Date().toISOString()});
      await dispatch({type:'owner.transcript',providerItemId:event.item_id,text:event.transcript,...captured,nowMs:now()});return;
    }
    if(['conversation.item.created','conversation.item.done','conversation.item.retrieved'].includes(event?.type)){
      const item=event.item,p=payload;
      if(event.type==='conversation.item.retrieved' && asrWaiting.has(item?.id) &&
        [...asrProbes.values()].some(probe=>probe.itemId===item.id && probe.generation===attachGeneration)){
        // The API documents this as an attached transcript, not final ASR.
        // Only the completed transcription event can become an owner answer.
        diagnostic('owner.asr_retrieved',{code:item?.role==='user' && item.content?.some((c:any)=>c.type==='input_audio' && typeof c.transcript==='string')
          ?'attached_transcript_unverified':'attached_transcript_absent'});return;
      }
      if(streaming||!p || item?.id!==`lgs-${p.actionId.slice(0,28)}`)return;
      if(item.type!=='message' || item.role!=='assistant' || item.status!=='completed'
        || item.content?.length!==1 || item.content[0]?.type!=='output_text' || item.content[0]?.text!==p.text){
        await dispatch({type:'adapter.failed',code:'website_speech_ack_mismatch',nowMs:now()});return;
      }
      recordingPlaybackActionId=p.actionId;
      let receipt;
      try{receipt=await bounded(()=>deps.evidenceStore.recordSpeechPlayed({...scope,actionId:p.actionId,
        assistantItemId:item.id,assistantText:p.text,textSha256:p.text_sha256,audioSha256:p.audio_sha256}));}
      finally{if(recordingPlaybackActionId===p.actionId)recordingPlaybackActionId=undefined;}
      if(!receipt?.receiptId)throw new Error('website_playback_receipt_missing');
      if(['ASK_NEXT_GAP','CLARIFY_CURRENT_GAP','CONFIRM_AND_ASK_NEXT','DEFER_OFF_SCOPE_AND_CONTINUE','HANDLE_OWNER_CORRECTION'].includes(p.kind))
        lastHeardQuestionItemId=getAgendaAction(state.stored.agenda).itemId??null;
      payload=null;speechRetrieve=undefined;if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=undefined;
      diagnostic('speech.played');
      deps.onTranscript({role:'agent',text:p.text,at:new Date().toISOString()});
      await dispatch(state.phase==='opening'?{type:'opening.played',nowMs:now()}:
        {type:'speech.played',actionId:p.actionId,textSha256:p.text_sha256,audioSha256:p.audio_sha256,nowMs:now()});return;
    }
    if(event?.type==='response.created' || event?.type==='response.done'){
      const response=event.response,metadata=response?.metadata;
      if(typeof response?.id!=='string' || terminalResponses.has(response.id))return;
      if(retiredInterpretations.has(metadata?.website_request_id)){
        if(event.type==='response.done'){terminalResponses.add(response.id);deps.onUsage(response);}
        return;
      }
      if(!interpreter || metadata?.website_request_id!==interpreter.requestId || metadata.website_turn_id!==interpreter.turnId
        || metadata.website_digest!==interpreter.digest || metadata.website_item_id!==(interpreter.itemId??'')){
        if(event.type==='response.created')deps.send({type:'response.cancel',response_id:response.id});
        else{terminalResponses.add(response.id);deps.onUsage(response);}
        deps.onUsageUnknown();
        await dispatch({type:'adapter.failed',code:'unsolicited_website_response',nowMs:now()});return;
      }
      const command=interpreter;
      const timing=interpretationTiming?.requestId===command.requestId?interpretationTiming:undefined;
      if(event.type==='response.created'){
        activeResponseId=response.id;
        if(timing && !timing.created){
          timing.created=true;
          diagnostic('interpretation.created',{attempt:command.attempt,effectId:command.requestId,durationMs:Math.max(0,now()-timing.requestedAtMs)});
        }
      }else{terminalResponses.add(response.id);activeResponseId=undefined;interpreterInFlight=false;deps.onUsage(response);}
      await dispatch({type:'interpretation.created',requestId:command.requestId,responseId:response.id,nowMs:now()});
      if(event.type==='response.created')return;
      if(state.pending?.kind!=='interpret' || state.pending.requestId!==command.requestId)return;
      const output=response.output;
      const selectedOutput=websiteProposalOutput(output,command.toolName);
      let raw:unknown,result:ReturnType<typeof parseWebsiteInterpretation>=null;
      let rejectionCode='interpretation_tool_output_invalid';
      if(['failed','cancelled','incomplete'].includes(response.status))rejectionCode=`interpretation_provider_${response.status}`;
      else if(response.status==='completed' && selectedOutput.arguments!==undefined){
        try{raw=JSON.parse(selectedOutput.arguments);}catch{rejectionCode='interpretation_json_invalid';}
      }
      if(raw!==undefined){
        result=parseWebsiteInterpretation(raw);
        if(!result)rejectionCode='interpretation_shape_invalid';
        else try{
          // Validate before the reducer commits the proposal so a bad optional
          // typed shape gets the same single bounded interpreter repair.
          validateWebsiteInterpretationFacts({facts:result.facts??[],proposal:result.proposal,currentItemId:command.itemId,
            agenda:state.stored.agenda,ownerTranscript:command.transcript});
        }catch(error){rejectionCode=websiteInterpretationFailureCode(error);result=null;}
      }
      const shape=raw as {proposal?:{kind?:unknown};facts?:unknown}|null;
      const kind=shape?.proposal?.kind;
      diagnostic('interpretation.done',{attempt:command.attempt,effectId:command.requestId,
        ...(timing?{durationMs:Math.max(0,now()-timing.requestedAtMs)}:{}),
        ...(Array.isArray(output)?{outputCount:output.length}:{}),
        ...(selectedOutput.toolCallCount!==undefined?{toolCallCount:selectedOutput.toolCallCount,discardedTextMessageCount:selectedOutput.discardedTextMessageCount}:{}),
        ...(selectedOutput.parserRejectReason?{parserRejectReason:selectedOutput.parserRejectReason}:{}),
        ...(typeof kind==='string' && ['answer','clarification','defer','not_applicable','off_scope','correction'].includes(kind)?{proposalKind:kind as AgendaProposal['kind']}:{}),
        ...(Array.isArray(shape?.facts)?{factCount:shape.facts.length}:{})});
      if(!result)await dispatch({type:'interpretation.failed',requestId:command.requestId,code:rejectionCode,nowMs:now()});
      else await dispatch({type:'interpretation.completed',requestId:command.requestId,responseId:response.id,
        turnId:command.turnId,itemId:command.itemId,digest:command.digest,result,nowMs:now()});
      return;
    }
    if(event?.type==='session.updated'){
      const d=event.session?.audio?.input?.turn_detection;
      if(event.session?.output_modalities?.length!==1 || event.session.output_modalities[0]!=='text'
        || d?.create_response!==false || d?.interrupt_response!==false)
        await dispatch({type:'adapter.failed',code:'website_session_mode_drift',nowMs:now()});
    }
    if(event?.type==='conversation.item.input_audio_transcription.failed'){
      if(typeof event.item_id==='string'){
        callerItems.delete(event.item_id);
        await dispatch({type:'owner.speech_finished',providerItemId:event.item_id,nowMs:now()});
      }
      await dispatch({type:'adapter.failed',code:'website_transcription_failed',nowMs:now()});
    }
  }
  async function attach(){
    requireLive();attachGeneration+=1;
    deps.send({type:'session.update',session:{type:'realtime',output_modalities:['text'],tools:[],tool_choice:'none',
      audio:{input:{transcription:{model:'gpt-live-transcribe'},turn_detection:{type:'semantic_vad',eagerness:'low',create_response:false,interrupt_response:false}}}}});
    publish();
    if(streaming){if(currentStream)announceStream(currentStream);return;}
    if(attachGeneration>1 && payload && currentSpeechActionId()===payload.actionId){
      const eventId=`website-speech-retrieve-${payload.actionId.slice(0,24)}-${attachGeneration}`;
      speechRetrieve={actionId:payload.actionId,eventId,generation:attachGeneration};
      deps.send({type:'conversation.item.retrieve',event_id:eventId,item_id:`lgs-${payload.actionId.slice(0,28)}`});
    }
    if(payload && state.phase!=='opening')notice();
  }
  async function finalized(proof:{providerReceiptId:string;budgetReceiptId:string}){
    if(!state.termination)return;
    const requestId=state.termination.requestId;
    await dispatch({type:'provider.termination_confirmed',requestId,receiptId:proof.providerReceiptId,nowMs:now()});
    await dispatch({type:'budget.settled',requestId,receiptId:proof.budgetReceiptId,nowMs:now()});
  }
  function ownsControlError(event:any):boolean{
    if(!streaming||event?.type!=='error')return false;
    const eventId=event.error?.event_id;
    if(event.error?.code==='conversation_item_already_exists'&&[...streamNotices].some(id=>eventId===`website-stream-notice-${id}`))return true;
    return [...streamRenditions.values()].some(r=>r.retired&&r.generationDone&&eventId===r.cancelEventId&&event.error?.code==='response_cancel_not_active');
  }
  return {observeEvent,handleEvent,attach,stop,finalized,ownsSpeechRetrieveMiss,ownsControlError,streaming,get state(){return state;}};
}
