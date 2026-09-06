import { createWebsiteAgendaCoordinator, reduceWebsiteAgenda, type WebsiteAgendaCommand, type WebsiteAgendaEvent, type WebsiteAgendaState } from "./onboarding-agenda-coordinator.ts";
import { createOnboardingAgendaStore } from "./onboarding-agenda-store.ts";
import { createInterviewEvidenceStore } from "./onboarding-interview-evidence-store.ts";
import { synthesizeOnboardingSpeech, speechPayloadIsInternallyValid, type OnboardingSpeechAction, type OnboardingSpeechPayload } from "./onboarding-speech.ts";
import type { PreparedWebsiteInterview } from "./onboarding-website-bootstrap.ts";
import { generateWebsiteSummaryParts } from "./onboarding-website-summary.ts";
import { validateWebsiteInterpretationFacts } from "./onboarding-website-facts.ts";
import { getAgendaItems } from "./onboarding-agenda.ts";

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
  const now=deps.now??Date.now,scope=input.prepared.scope,abort=new AbortController();
  let state=createWebsiteAgendaCoordinator(input.prepared.stored,{nowMs:now(),openingAction:input.openingAction});
  let payload:OnboardingSpeechPayload|null=input.openingPayload,stopped=false,deadline:ReturnType<typeof setTimeout>|undefined;
  let noticeTimer:ReturnType<typeof setTimeout>|undefined,noticeAttempts=0;
  let attachGeneration=0;
  let speechRetrieve:{actionId:string;eventId:string;generation:number}|undefined;
  const terminalResponses=new Set<string>(),callerItems=new Set<string>(),ownerTranscripts=new Map<string,string>();
  const retiredInterpretations=new Set<string>();
  let interpreter:Interpret|undefined,activeResponseId:string|undefined,ttsInFlight=false;
  function clearTimers(){if(deadline)clearTimeout(deadline);if(noticeTimer)clearTimeout(noticeTimer);deadline=undefined;noticeTimer=undefined;}
  function stop(){if(ttsInFlight)deps.onUsageUnknown();stopped=true;speechRetrieve=undefined;clearTimers();abort.abort();}
  function requireLive(){if(stopped || abort.signal.aborted)throw new Error('website_runtime_stopped');}
  function currentSpeechActionId(){return state.phase==='opening'?state.openingAction.actionId:state.speech?.action.actionId;}
  function publish(){
    if(speechRetrieve && (payload?.actionId!==speechRetrieve.actionId || currentSpeechActionId()!==speechRetrieve.actionId))speechRetrieve=undefined;
    deps.onState(state);scheduleDeadline();
  }
  /** Only this exact live retrieve request may explain a missing item while
   * browser playback is still pending. It never proves playback or advances. */
  function ownsSpeechRetrieveMiss(event:any):boolean{
    const itemId=payload?`lgs-${payload.actionId.slice(0,28)}`:'';
    const error=event?.error;
    return !stopped && !!payload && !!speechRetrieve
      && speechRetrieve.generation===attachGeneration
      && speechRetrieve.actionId===payload.actionId
      && speechRetrieve.actionId===currentSpeechActionId()
      && event?.type==='error'
      && error?.event_id===speechRetrieve.eventId
      && (error?.code==='item_not_found' ||
        (error?.type==='invalid_request_error' && error?.param==='item_id'
          && (error.code===undefined || error.code===null || error.code==='invalid_request_error')
          && typeof error.message==='string'
          && new RegExp(`(?:^|[^A-Za-z0-9_-])${itemId}(?:$|[^A-Za-z0-9_-])`).test(error.message)
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
  async function bounded<T>(operation:()=>Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{requireLive();const result=await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('website_effect_timeout')),15_000);})]);requireLive();return result;}
    finally{if(timer)clearTimeout(timer);}
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
        case 'record_owner_turn':{
          const result=await bounded(()=>deps.agendaStore.recordOwnerTranscript({...scope,providerItemId:command.providerItemId,text:command.text}));
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
          const stored=await bounded(()=>deps.agendaStore.commitOwnerTurn({...scope,...command,facts}));
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
          const summary=state.summary;
          const latestTurn=state.turns.at(-1);
          const association=summary && ['GENERATE_FINAL_SUMMARY','REQUEST_FINAL_APPROVAL'].includes(command.action.kind)
            ?{summaryId:summary.summaryId,...(command.action.kind==='GENERATE_FINAL_SUMMARY'?{partIndex:summary.partIndex}:{}),
              ...(command.action.kind==='REQUEST_FINAL_APPROVAL' && state.approvalClarifications>0 && latestTurn?{clarificationTurnId:latestTurn.turnId}:{})}:{};
          const claim=await bounded(()=>deps.evidenceStore.claimSpeech({...scope,action:command.action,...association}));
          let ready=claim.payload;
          if(claim.status==='preparing' && claim.claimed){
            try{
              ttsInFlight=true;
              ready=await deps.synthesize(command.action,abort.signal);requireLive();ttsInFlight=false;
              deps.onCost(ready.cost_usd);
              const completed=await bounded(()=>deps.evidenceStore.completeSpeech({...scope,actionId:command.action.actionId,payload:ready!}));
              ready=completed.payload;
            }catch(error){
              ttsInFlight=false;
              if(stopped)return;
              const failure=error as {usageResolved?:boolean;costUsd?:number};
              if(!ready && failure.usageResolved && typeof failure.costUsd==='number')deps.onCost(failure.costUsd);
              if(!ready && failure.usageResolved!==true)deps.onUsageUnknown();
              await bounded(()=>deps.evidenceStore.failSpeech({...scope,actionId:command.action.actionId,reason:'tts_or_persistence_failed'})).catch(()=>{});
              throw error;
            }
          }else if(claim.status!=='ready'){
            if(claim.status==='preparing')deps.onUsageUnknown();
            throw new Error('website_speech_not_publishable');
          }
          if(!ready || !speechPayloadIsInternallyValid(ready,command.action))throw new Error('website_speech_readback_invalid');
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
      if(command.type==='request_speech')await dispatch({type:'speech.failed',actionId:command.action.actionId,code:'speech_effect_failed',nowMs:now()});
      else if('requestId'in command)await dispatch({type:'effect.failed',requestId:command.requestId,code:'website_effect_failed',nowMs:now()});
    }
  }
  async function handleEvent(event:any):Promise<void>{
    if(stopped)return;
    if(event?.type==='input_audio_buffer.speech_started'){
      if(['awaiting_owner','awaiting_approval'].includes(state.phase) && typeof event.item_id==='string')callerItems.add(event.item_id);
      return;
    }
    if(event?.type==='conversation.item.input_audio_transcription.completed'){
      const previous=ownerTranscripts.get(event.item_id);
      if(previous!==undefined){if(previous!==event.transcript)await dispatch({type:'adapter.failed',code:'conflicting_owner_transcript',nowMs:now()});return;}
      if(!callerItems.delete(event.item_id) || typeof event.transcript!=='string' || !event.transcript.trim())return;
      ownerTranscripts.set(event.item_id,event.transcript);
      deps.onTranscript({role:'caller',text:event.transcript,at:new Date(now()).toISOString()});
      await dispatch({type:'owner.transcript',providerItemId:event.item_id,text:event.transcript,nowMs:now()});return;
    }
    if(['conversation.item.created','conversation.item.done','conversation.item.retrieved'].includes(event?.type)){
      const item=event.item,p=payload;
      if(!p || item?.id!==`lgs-${p.actionId.slice(0,28)}`)return;
      if(item.type!=='message' || item.role!=='assistant' || item.status!=='completed'
        || item.content?.length!==1 || item.content[0]?.type!=='output_text' || item.content[0]?.text!==p.text){
        await dispatch({type:'adapter.failed',code:'website_speech_ack_mismatch',nowMs:now()});return;
      }
      const receipt=await bounded(()=>deps.evidenceStore.recordSpeechPlayed({...scope,actionId:p.actionId,
        assistantItemId:item.id,assistantText:p.text,textSha256:p.text_sha256,audioSha256:p.audio_sha256}));
      if(!receipt?.receiptId)throw new Error('website_playback_receipt_missing');
      payload=null;speechRetrieve=undefined;if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=undefined;
      deps.onTranscript({role:'agent',text:p.text,at:new Date(now()).toISOString()});
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
    if(event?.type==='conversation.item.input_audio_transcription.failed')
      await dispatch({type:'adapter.failed',code:'website_transcription_failed',nowMs:now()});
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
  return {handleEvent,attach,stop,finalized,ownsSpeechRetrieveMiss,get state(){return state;}};
}
