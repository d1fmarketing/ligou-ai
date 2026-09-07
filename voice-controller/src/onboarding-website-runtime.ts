import { createWebsiteAgendaCoordinator, reduceWebsiteAgenda, type WebsiteAgendaCommand, type WebsiteAgendaEvent, type WebsiteAgendaState } from "./onboarding-agenda-coordinator.ts";
import { createOnboardingAgendaStore, onboardingAgendaDigest } from "./onboarding-agenda-store.ts";
import { createInterviewEvidenceStore } from "./onboarding-interview-evidence-store.ts";
import { synthesizeOnboardingSpeech, speechPayloadIsInternallyValid, type OnboardingSpeechAction, type OnboardingSpeechPayload } from "./onboarding-speech.ts";
import type { PreparedWebsiteInterview } from "./onboarding-website-bootstrap.ts";
import { generateWebsiteSummaryParts } from "./onboarding-website-summary.ts";
import { validateWebsiteInterpretationFacts } from "./onboarding-website-facts.ts";
import { getAgendaItems, getAgendaAction } from "./onboarding-agenda.ts";
import { randomUUID } from "node:crypto";

type Interpret = Extract<WebsiteAgendaCommand,{type:"interpret_owner_turn"}>;
export interface WebsiteInterviewRuntimeConfig {
  prepared: PreparedWebsiteInterview;
  openingAction: OnboardingSpeechAction;
  openingPayload: OnboardingSpeechPayload;
}
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
  onDiagnostic?(event:{callId:string;requestId:string;stage:string;elapsedMs:number;code?:string;attempt?:number;durationMs?:number;effectId?:string}):void;
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

export function createWebsiteInterviewRuntime(input:WebsiteInterviewRuntimeConfig,deps:WebsiteInterviewRuntimeDependencies) {
  if(!speechPayloadIsInternallyValid(input.openingPayload,input.openingAction))throw new Error('website_runtime_opening_invalid');
  const now=deps.now??(()=>performance.now()),scope=input.prepared.scope,abort=new AbortController(),startedAt=now();
  let state=createWebsiteAgendaCoordinator(input.prepared.stored,{nowMs:now(),openingAction:input.openingAction});
  let payload:OnboardingSpeechPayload|null=input.openingPayload,stopped=false,deadline:ReturnType<typeof setTimeout>|undefined;
  let noticeTimer:ReturnType<typeof setTimeout>|undefined,noticeAttempts=0;
  let attachGeneration=0;
  let speechRetrieve:{actionId:string;eventId:string;generation:number}|undefined;
  const terminalResponses=new Set<string>(),callerItems=new Set<string>(),ownerTranscripts=new Map<string,string>();
  const retiredInterpretations=new Set<string>();
  let interpreter:Interpret|undefined,activeResponseId:string|undefined,ttsInFlight=false;
  let speechAbort:AbortController|undefined;
  const observedCommands:WebsiteAgendaCommand[]=[];
  const retiredSpeech=new Set<string>();
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
  function diagnostic(stage:string,detail:{code?:string;attempt?:number;durationMs?:number;effectId?:string}={}){
    deps.onDiagnostic?.({callId:scope.callId,requestId:scope.requestId,stage,elapsedMs:Math.max(0,now()-startedAt),...detail});
  }
  function clearAsrWait(itemId:string){const wait=asrWaiting.get(itemId);if(wait){clearTimeout(wait.retry);clearTimeout(wait.deadline);asrWaiting.delete(itemId);}}
  function clearTimers(){if(deadline)clearTimeout(deadline);if(noticeTimer)clearTimeout(noticeTimer);deadline=undefined;noticeTimer=undefined;for(const itemId of asrWaiting.keys())clearAsrWait(itemId);}
  function stop(){if(ttsInFlight)deps.onUsageUnknown();stopped=true;speechRetrieve=undefined;clearTimers();abort.abort();}
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
    const currentQuestionPublished=state.speech?.after==='owner' && payload?.actionId===previousAction;
    ownerContexts.set(event.item_id,{capturedItemId:state.summary || currentQuestionPublished?getAgendaAction(state.stored.agenda).itemId??null:lastHeardQuestionItemId,
      approvalSummaryId:asrWaiting.size===0 && (state.phase==='awaiting_approval' || (afterPlayedAck && state.speech?.after==='approval'))?state.summary?.summaryId??null:null});
    callerItems.add(event.item_id);
    const reduced=reduceWebsiteAgenda(state,{type:'owner.speech_started',providerItemId:event.item_id,
      ...(afterPlayedAck?{afterPlaybackActionId:previousAction}:{}),nowMs:now()});
    state=reduced.state;observedCommands.push(...reduced.commands);
    if(previousAction && reduced.commands.some(command=>command.type==='interrupt_speech')){
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
          interpreter=command;deps.send(websiteInterpretationRequest(command));break;
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
              ready=await deps.synthesize(command.action,AbortSignal.any([abort.signal,renditionAbort.signal]));requireLive();ttsInFlight=false;
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
        case 'telemetry':break;
      }
    }catch(error){
      diagnostic('effect.failed',{code:errorCode(error),...('requestId'in command?{effectId:command.requestId}:{})});
      if(command.type==='interrupt_speech')await dispatch({type:'adapter.failed',code:'interruption_persistence_failed',nowMs:now()});
      else if(command.type==='request_speech')await dispatch({type:'speech.failed',actionId:command.action.actionId,code:'speech_effect_failed',nowMs:now()});
      else if('requestId'in command)await dispatch({type:'effect.failed',requestId:command.requestId,code:'website_effect_failed',nowMs:now()});
    }
  }
  async function handleEvent(event:any):Promise<void>{
    if(stopped)return;
    observeEvent(event);
    for(const command of observedCommands.splice(0))await execute(command);
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
      if(!p || item?.id!==`lgs-${p.actionId.slice(0,28)}`)return;
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
      activeResponseId=response.id;
      await dispatch({type:'interpretation.created',requestId:command.requestId,responseId:response.id,nowMs:now()});
      if(event.type==='response.created')return;
      terminalResponses.add(response.id);activeResponseId=undefined;deps.onUsage(response);
      const output=response.output;
      let result:unknown;
      if(response.status==='completed' && Array.isArray(output) && output.length===1
        && output[0]?.type==='function_call' && output[0].name===command.toolName && output[0].status==='completed'
        && typeof output[0].arguments==='string' && Buffer.byteLength(output[0].arguments)<=65_536){try{result=JSON.parse(output[0].arguments);}catch{}}
      if(result!==undefined){
        try{
          const raw=result as {proposal:any;facts?:unknown};
          // Validate before the reducer commits the proposal so a bad optional
          // typed shape gets the same single bounded interpreter repair.
          validateWebsiteInterpretationFacts({facts:raw.facts??[],proposal:raw.proposal,currentItemId:command.itemId,
            agenda:state.stored.agenda,ownerTranscript:command.transcript});
        }catch{result=undefined;}
      }
      if(result===undefined)await dispatch({type:'interpretation.failed',requestId:command.requestId,code:'invalid_interpretation_output',nowMs:now()});
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
  return {observeEvent,handleEvent,attach,stop,finalized,ownsSpeechRetrieveMiss,get state(){return state;}};
}
