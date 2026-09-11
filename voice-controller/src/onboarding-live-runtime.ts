import {config,sessionBudgetEnvelope} from './config.ts';
import {supa} from './rules.ts';
import {resolveSessionTenant} from './session-tenant.ts';
import {finalizeTerminalBudget,reserveCallBudget,type BudgetOutcome} from './budget.ts';
import {prepareWebsiteInterview,type PreparedWebsiteInterview} from './onboarding-website-bootstrap.ts';
import {createLiveLifecycle,createLiveWebRtcSession,LiveCreationError,type LiveFunctionTool} from './onboarding-live-protocol.ts';
import {createLiveResponsesBridge,type LiveResponsesToolContext} from './onboarding-live-responses.ts';
import {createLiveUsageLedger} from './onboarding-live-usage.ts';

type Event=Record<string,any>;
type Client={from:(table:string)=>any;rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:any;error:any}>};
type Socket={readyState:number;send:(text:string)=>void;close:()=>void;addEventListener:(type:string,listener:(event:any)=>void)=>void};
export type ManagedLiveCleanup={callId:string;startupComplete:boolean;cancel:(reason:string)=>Promise<void>};
export type ManagedLiveStart={userId:string;sdpOffer:string;tenantId?:string;callId:string;requestId:string;registerCleanup?:(control:ManagedLiveCleanup)=>void};
type Business={voiceInstructions:string;backendInstructions:string;tools:LiveFunctionTool[];observe:(event:Event)=>void;
  execute:(name:string,args:Record<string,unknown>,context:LiveResponsesToolContext)=>Promise<unknown>;bindSession?:(sessionId:string)=>void};
type BusinessFactory=(options:{prepared:PreparedWebsiteInterview;businessName:string;client:Client;onStop:(reason?:string)=>Promise<void>})=>Business;
type Dependencies={client?:Client;apiKey?:string;resolveTenant?:typeof resolveSessionTenant;reserve?:typeof reserveCallBudget;prepare?:typeof prepareWebsiteInterview;
  createSession?:typeof createLiveWebRtcSession;businessFactory?:BusinessFactory;connect?:(url:string,apiKey:string)=>Socket;
  finalize?:typeof finalizeTerminalBudget;openTimeoutMs?:number;closeTimeoutMs?:number;cleanupTimeoutMs?:number};
type FinalEvent={eventId:string;sessionId:string;reason:string;seconds:number|null;expiresAt?:number}|null;
type CreationState='not_started'|'rejected'|'unknown'|'created';
const MODEL='gpt-live-1',BACKEND='gpt-5.6-terra',MAX_MINUTES=55;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const managedLiveSessions=new Set<string>();
const controls=new Map<string,ManagedLiveCleanup>();
type DiagnosticObserver=(record:{callId:string;sessionId:string|null;direction:'inbound'|'outbound';event:unknown})=>void;
let diagnosticObserver:DiagnosticObserver|null=null;
/** Explicit host diagnostic opt-in. No recording storage or broad log sink. */
export function setManagedLiveDiagnosticObserver(observer:DiagnosticObserver|null){diagnosticObserver=observer;}
function diagnostic(callId:string,sessionId:string|null,direction:'inbound'|'outbound',event:unknown){
  try{diagnosticObserver?.({callId,sessionId,direction,event});}catch{/* Recording failures cannot hold audio. */}
}
const connectDefault=(url:string,apiKey:string)=>new WebSocket(url,{headers:{Authorization:`Bearer ${apiKey}`}} as any) as unknown as Socket;
// Same bounded terminal-proof window used by budget.ts. This limits receipt
// observation after Stop, never voice delivery or delegated reasoning.
async function boundedReceipt<T>(work:(signal:AbortSignal)=>PromiseLike<T>,timeoutMs=8_000):Promise<T|null>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),new Promise<null>(resolve=>{
    timer=setTimeout(()=>{controller.abort();resolve(null);},timeoutMs);
  })]);}catch{return null;}finally{clearTimeout(timer);}
}
function withSignal<T>(request:PromiseLike<T>&{abortSignal?:(signal:AbortSignal)=>PromiseLike<T>},signal:AbortSignal){
  return request.abortSignal?request.abortSignal(signal):request;
}
function observeUsage(ledger:ReturnType<typeof createLiveUsageLedger>,event:Event){
  if(event.type==='session.usage.updated')ledger.observeVoice(event.usage?.seconds);
  if(event.type==='session.closed')ledger.observeVoice(event.usage?.seconds,true);
  if(event.type==='response.event'&&['response.created','response.completed','response.failed','response.incomplete','response.cancelled'].includes(event.event?.type)){
    const response=event.event.response;
    if(response&&typeof response.id==='string')ledger.observeResponse({responseId:response.id,model:typeof response.model==='string'?response.model:null,
      status:typeof response.status==='string'?response.status:event.event.type.slice('response.'.length),usage:response.usage,serviceTier:response.service_tier});
  }
}
function finalEvent(event:Event,sessionId:string):FinalEvent{
  if(event.type!=='session.closed'||event.session?.id!==sessionId||typeof event.event_id!=='string'
    ||typeof event.reason!=='string')return null;
  return{eventId:event.event_id,sessionId,reason:event.reason,
    seconds:typeof event.usage?.seconds==='number'&&Number.isFinite(event.usage.seconds)&&event.usage.seconds>=0?event.usage.seconds:null,
    ...(typeof event.session.expires_at==='number'&&Number.isFinite(event.session.expires_at)?{expiresAt:event.session.expires_at}:{})};
}
function attach(sessionId:string,apiKey:string,deps:Dependencies,onEvent:(event:Event)=>void,onDisconnect:()=>void,onRaw?:(data:unknown)=>void){
  const socket=(deps.connect??connectDefault)(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach?graceful_close=true`,apiKey);
  let opened=false,settled=false,resolve!:()=>void,reject!:(error:Error)=>void;
  const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  const timer=setTimeout(()=>{if(!settled){settled=true;reject(Error('live_sideband_open_timeout'));socket.close();}},deps.openTimeoutMs??config.sidebandOpenTimeoutMs);
  socket.addEventListener('open',()=>{opened=true;if(!settled){settled=true;clearTimeout(timer);resolve();}});
  socket.addEventListener('message',message=>{let event:Event;try{event=JSON.parse(String(message.data));}catch{onRaw?.(message.data);return;}
    if(event&&typeof event==='object'&&!Array.isArray(event))onEvent(event);});
  const disconnected=()=>{clearTimeout(timer);if(!settled){settled=true;reject(Error('live_sideband_open_failed'));}if(opened)onDisconnect();};
  socket.addEventListener('error',disconnected);socket.addEventListener('close',disconnected);
  return{socket,ready};
}

/** Native WebRTC + official Live sideband. No Realtime fallback, delegated model
 * connection, speech buffer, transcription gate, or microphone manipulation. */
export async function startManagedBrowserSession(args:ManagedLiveStart,deps:Dependencies={}){
  if(![args.userId,args.callId,args.requestId].every(value=>uuid.test(value))||typeof args.sdpOffer!=='string'||!args.sdpOffer.trim())throw Error('live_start_scope_invalid');
  if(managedLiveSessions.has(args.callId))throw Error('live_call_already_running');
  const client=deps.client??supa(),apiKey=deps.apiKey??config.openaiKey,budget=sessionBudgetEnvelope('onboarding');
  const ledger=createLiveUsageLedger({created:false,backendModel:BACKEND}),controller=new AbortController(),usageController=new AbortController();
  let sessionId:string|null=null,expiresAt:number|null=null,tenantId:string|undefined,callWriteStarted=false,reservationAttempted=false;
  let creationState:CreationState='not_started',stopReason:string|null=null,final:FinalEvent=null;
  let business:Business|undefined,bridge:ReturnType<typeof createLiveResponsesBridge>|undefined,lifecycle:ReturnType<typeof createLiveLifecycle>|undefined;
  let socket:Socket|undefined,deadline:ReturnType<typeof setTimeout>|undefined,softNotified=false,cleaning=false;
  let usageWrites:Promise<void>=Promise.resolve(),finishWork:Promise<void>|undefined;
  let resolveStartup!:()=>void;const startupSettled=new Promise<void>(resolve=>{resolveStartup=resolve;});
  const usage=()=>({...ledger.snapshot(),creationState,expiresAt});
  function persistUsage(){
    if(!tenantId||!callWriteStarted||cleaning)return;
    const snapshot=usage();
    usageWrites=usageWrites.then(async()=>{
      if(cleaning)return;
      const result=await withSignal(client.from('calls').update({provider_usage_details:snapshot,cost_estimate_usd:snapshot.totalObservedCostUsd})
        .eq('id',args.callId).eq('tenant_id',tenantId).eq('status','active'),usageController.signal) as any;
      if(result.error)console.error('live_usage_persist_failed',args.callId);
    }).catch(()=>{console.error('live_usage_persist_failed',args.callId);});
  }
  const outcome=():BudgetOutcome=>stopReason==='budget_limit'?'killed_budget':stopReason==='session_deadline'?'killed_deadline':control.startupComplete?'ended':'startup_error';
  function finish(){
    if(finishWork)return finishWork;
    cleaning=true;usageController.abort();
    finishWork=(async()=>{
      try{
        bridge?.stop();clearTimeout(deadline);
        if(lifecycle&&!final)await lifecycle.close();
        if(!callWriteStarted||!tenantId)return;
        // The final RPC carries the current in-memory snapshot. A delayed
        // periodic write is restricted to status=active and cannot overwrite it.
        const snapshot=usage();
        const result=await boundedReceipt(signal=>withSignal(client.rpc('record_website_live_termination',{p_owner:args.userId,p_call:args.callId,p_request:args.requestId,p_session:sessionId,
          p_reason:stopReason??final?.reason??'connection_lost',p_outcome:outcome(),p_usage:snapshot,p_final_event:final}),signal),deps.cleanupTimeoutMs);
        if(!result||result.error||!result.data)throw Error('live_termination_receipt_unproven');
        if(reservationAttempted)await boundedReceipt(()=>(deps.finalize??finalizeTerminalBudget)({tenantId:tenantId!,callId:args.callId,actualCostUsd:snapshot.totalObservedCostUsd,
          minutes:snapshot.voiceSeconds/60,outcome:outcome(),detail:{protocol:'live',...snapshot},
          usageResolved:creationState==='not_started'||creationState==='rejected'||Boolean(final&&snapshot.usageResolved)}),deps.cleanupTimeoutMs);
      }finally{try{socket?.close();}finally{managedLiveSessions.delete(args.callId);controls.delete(args.callId);}}
    })();return finishWork;
  }
  const control:ManagedLiveCleanup={callId:args.callId,startupComplete:false,cancel(reason){
    stopReason??=reason;bridge?.stop();controller.abort();return startupSettled.then(()=>finish());
  }};
  const stop=(reason='owner_requested_stop')=>control.cancel(reason);
  const backgroundStop=(reason:string)=>{void stop(reason).catch(()=>console.error('live_termination_persist_failed',args.callId));};
  controls.set(args.callId,control);managedLiveSessions.add(args.callId);
  try{args.registerCleanup?.(control);}catch(error){controls.delete(args.callId);managedLiveSessions.delete(args.callId);throw error;}
  const checkCancelled=()=>{if(stopReason)throw Object.assign(Error('browser_request_cancelled'),{status:499,startupCancelled:true});};
  const send=(event:Event)=>{
    if(!socket||socket.readyState!==1)throw Error('live_transport_unavailable');
    diagnostic(args.callId,sessionId,'outbound',event);socket.send(JSON.stringify(event));
  };
  const observe=(event:Event)=>{
    diagnostic(args.callId,sessionId,'inbound',event);
    if(event.type==='session.closed'&&event.session?.id!==sessionId)return;
    if(['session.started','session.closed'].includes(event.type)&&event.session?.id===sessionId
      &&typeof event.session.expires_at==='number'&&Number.isFinite(event.session.expires_at))expiresAt=event.session.expires_at;
    observeUsage(ledger,event);
    if(sessionId){const observed=finalEvent(event,sessionId);if(observed)final=observed;}
    lifecycle?.observe(event);
    try{business?.observe(event);}catch{console.error('live_business_observe_failed',args.callId);}
    bridge?.observe(event);
    if(event.type==='session.usage.updated'||event.type==='response.event'&&['response.completed','response.failed','response.incomplete'].includes(event.event?.type))persistUsage();
    if(event.type==='session.closed'){backgroundStop(stopReason??'provider_session_closed');return;}
    const cost=ledger.snapshot().totalObservedCostUsd;
    if(!stopReason&&cost>=budget.hardLimitUsd)backgroundStop('budget_limit');
    else if(!stopReason&&!softNotified&&cost>=budget.softLimitUsd){softNotified=true;try{lifecycle?.thinking(null,'O limite de custo desta sessão está próximo. Preserve o progresso e conclua brevemente.');}catch{}}
  };
  let answer:{sdp:string;call_id:string;max_minutes:number;model:typeof MODEL;fell_back:false;opening_mode_applied:'live_managed_v1';opening_payload:{version:6;live:{callId:string;interviewId:string;revision:number;sourceDigest:string;sessionId:string}}}|undefined;
  let failure:unknown;
  try{
    checkCancelled();const resolved=await(deps.resolveTenant??resolveSessionTenant)(args.userId,args.tenantId);checkCancelled();tenantId=resolved.tenant.id;
    callWriteStarted=true;
    const inserted=await client.from('calls').insert({id:args.callId,tenant_id:tenantId,channel:'browser',session_type:'onboarding',model:MODEL,status:'active',
      provider_termination_state:'not_required',provider_usage_state:'not_applicable'}).select('id').single();
    if(inserted.error||inserted.data?.id!==args.callId){callWriteStarted=false;throw Error('live_call_insert_failed');}checkCancelled();
    reservationAttempted=true;await(deps.reserve??reserveCallBudget)(tenantId,args.callId,budget.reservationUsd);checkCancelled();
    if(!apiKey)throw Error('openai_key_missing');
    const prepared=await(deps.prepare??prepareWebsiteInterview)({ownerId:args.userId,tenantId,callId:args.callId,requestId:args.requestId,signal:controller.signal},client);
    if(!prepared)throw Error('website_interview_prepared_source_required');checkCancelled();
    const factory=deps.businessFactory??(await import('./onboarding-live-business.ts')).createLiveBusinessSession;
    business=factory({prepared,businessName:resolved.tenant.name,client,onStop:stop});
    const marker=await client.from('calls').update({provider_termination_state:'unknown',provider_usage_state:'unknown',provider_usage_details:{...usage(),creationState:'unknown'}})
      .eq('id',args.callId).eq('tenant_id',tenantId).eq('status','active').select('id').maybeSingle();
    if(marker.error||marker.data?.id!==args.callId)throw Error('live_provider_marker_failed');checkCancelled();
    creationState='unknown';
    let created:Awaited<ReturnType<typeof createLiveWebRtcSession>>;
    try{created=await(deps.createSession??createLiveWebRtcSession)({sdp:args.sdpOffer,voice:'bossa',instructions:business.voiceInstructions,
      responses:{model:BACKEND,instructions:business.backendInstructions,tools:business.tools,reasoning:{effort:'low'}}},{apiKey,signal:controller.signal});}
    catch(error){if(error instanceof LiveCreationError){if(error.outcome==='rejected')creationState='rejected';if(error.sessionId){sessionId=error.sessionId;creationState='created';ledger.markCreated();}}throw error;}
    const knownSessionId:string=created.sessionId;sessionId=knownSessionId;creationState='created';ledger.markCreated();
    expiresAt=typeof (created as any).expiresAt==='number'&&Number.isFinite((created as any).expiresAt)?(created as any).expiresAt:null;
    const identity=await client.from('calls').update({openai_call_id:sessionId,provider_termination_state:'active',provider_usage_state:'unknown',provider_usage_details:usage()})
      .eq('id',args.callId).eq('tenant_id',tenantId).eq('status','active').select('id,openai_call_id').maybeSingle();
    if(identity.error||identity.data?.id!==args.callId||identity.data?.openai_call_id!==sessionId)throw Error('live_provider_identity_failed');
    business.bindSession?.(knownSessionId);
    lifecycle=createLiveLifecycle({sessionId:knownSessionId,send,closeTimeoutMs:deps.closeTimeoutMs});
    bridge=createLiveResponsesBridge({send,execute:business.execute,onError:error=>console.error('live_responses_error',JSON.stringify({callId:args.callId,...error}))});
    const attached=attach(knownSessionId,apiKey,deps,observe,()=>{if(!cleaning)backgroundStop('live_sideband_disconnected');},data=>diagnostic(args.callId,sessionId,'inbound',{type:'transport.raw',data}));socket=attached.socket;
    await attached.ready;lifecycle.readyFromAttachment();checkCancelled();
    deadline=setTimeout(()=>backgroundStop('session_deadline'),MAX_MINUTES*60_000);
    lifecycle.greet('Cumprimente o dono em português brasileiro, explique brevemente a entrevista e avance usando o contexto atual.');
    control.startupComplete=true;
    answer={sdp:created.sdp,call_id:args.callId,max_minutes:MAX_MINUTES,model:MODEL,fell_back:false,opening_mode_applied:'live_managed_v1',
      opening_payload:{version:6,live:{callId:args.callId,interviewId:prepared.stored.agenda.binding.interviewId,revision:prepared.stored.revision,sourceDigest:prepared.stored.digest,sessionId:knownSessionId}}};
  }catch(error){failure=error;stopReason??='live_startup_failed';}
  if(failure){
    // A known ID from malformed creation still belongs to this call's cleanup.
    if(sessionId&&!lifecycle){
      try{
        const identity=await client.from('calls').update({openai_call_id:sessionId,provider_termination_state:'active',provider_usage_state:'unknown',provider_usage_details:usage()})
          .eq('id',args.callId).eq('tenant_id',tenantId).eq('status','active');
        if(identity.error)console.error('live_cleanup_identity_unproven',args.callId);
        lifecycle=createLiveLifecycle({sessionId,send,closeTimeoutMs:deps.closeTimeoutMs});
        const attached=attach(sessionId,apiKey,deps,observe,()=>{});socket=attached.socket;await attached.ready;lifecycle.readyFromAttachment();
      }catch{/* Unknown provider finalization remains unknown in the receipt. */}
    }
    resolveStartup();
    await finish().catch(()=>console.error('live_startup_cleanup_unproven',args.callId));throw failure;
  }
  resolveStartup();
  return answer!;
}

/** Recover only the stored Live session, never create another voice session or
 * call Realtime's hangup endpoint. Business work is not resumed by this observer. */
export async function recoverManagedLiveCancellation(callId:string,reason:string,deps:Dependencies={}){
  if(!uuid.test(callId))return false;
  const client=deps.client??supa(),apiKey=deps.apiKey??config.openaiKey;
  const isFinal=(row:any)=>row?.id===callId&&row.model===MODEL&&row.channel==='browser'&&row.session_type==='onboarding'
    &&['ended','error','killed_budget','killed_deadline'].includes(row.status)&&Boolean(row.ended_at)
    &&(row.provider_termination_state==='confirmed'||(row.provider_termination_state==='not_required'&&!row.openai_call_id));
  const readCall=()=>boundedReceipt(signal=>withSignal(client.from('calls').select('id,tenant_id,model,channel,session_type,status,ended_at,openai_call_id,provider_termination_state,provider_usage_details').eq('id',callId).maybeSingle(),signal),deps.cleanupTimeoutMs) as Promise<any>;
  const active=controls.get(callId);
  if(active){try{await active.cancel(reason);const readback=await readCall();return Boolean(readback&&!readback.error&&isFinal(readback.data));}catch{return false;}}
  const callResult=await readCall();
  const call=callResult?.data;
  if(!callResult||callResult.error||!call||call.model!==MODEL||call.channel!=='browser'||call.session_type!=='onboarding')return false;
  if(isFinal(call))return true;
  if(!apiKey||typeof call.openai_call_id!=='string'||!call.openai_call_id)return false;
  const requestResult=await boundedReceipt(signal=>withSignal(client.from('browser_session_requests').select('id,user_id,tenant_id,onboarding_protocol_version,opening_mode_requested').eq('call_id',callId).maybeSingle(),signal),deps.cleanupTimeoutMs) as any;
  const request=requestResult?.data;
  if(!requestResult||requestResult.error||request?.tenant_id!==call.tenant_id||request?.onboarding_protocol_version!==6||request?.opening_mode_requested!=='live_managed_v1')return false;
  const sessionId=call.openai_call_id,ledger=createLiveUsageLedger({created:true,backendModel:BACKEND});
  const prior=call.provider_usage_details;
  if(typeof prior?.voiceSeconds==='number')ledger.observeVoice(prior.voiceSeconds);
  if(prior?.invalidObservations>0)ledger.observeVoice(NaN);
  for(const response of Array.isArray(prior?.responses)?prior.responses:[]){
    // Reconciliation cannot upgrade unknown pricing/conflicting observations to
    // a resolved bill by merely replaying normalized token counts.
    const usage=response.cost?.costUsd!==null&&!response.conflict?response.cost?.usage:null;
    ledger.observeResponse({responseId:response.responseId,model:response.model,status:response.status,usage:usage?{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,
      total_tokens:usage.totalTokens,input_tokens_details:{cached_tokens:usage.cachedInputTokens,cache_write_tokens:usage.cacheWriteTokens}}:undefined});
  }
  let final:FinalEvent=null,socket:Socket|undefined;
  const lifecycle=createLiveLifecycle({sessionId,closeTimeoutMs:deps.closeTimeoutMs,send:event=>{
    if(socket?.readyState!==1)throw Error('live_transport_unavailable');socket.send(JSON.stringify(event));
  }});
  try{
    const attached=attach(sessionId,apiKey,deps,event=>{if(event.type==='session.closed'&&event.session?.id!==sessionId)return;observeUsage(ledger,event);final=finalEvent(event,sessionId)??final;lifecycle.observe(event);},()=>{});
    socket=attached.socket;await attached.ready;lifecycle.readyFromAttachment();await lifecycle.close();
    const usage={...ledger.snapshot(),creationState:'created',expiresAt:typeof prior?.expiresAt==='number'?prior.expiresAt:null};
    const result=await boundedReceipt(signal=>withSignal(client.rpc('record_website_live_termination',{p_owner:request.user_id,p_call:callId,p_request:request.id,p_session:sessionId,p_reason:reason,p_outcome:'ended',p_usage:usage,p_final_event:final}),signal),deps.cleanupTimeoutMs);
    if(!result||result.error||!result.data)return false;
    await boundedReceipt(()=>(deps.finalize??finalizeTerminalBudget)({tenantId:call.tenant_id,callId,actualCostUsd:usage.totalObservedCostUsd,minutes:usage.voiceSeconds/60,outcome:'ended',detail:usage,usageResolved:Boolean(final&&usage.usageResolved)}),deps.cleanupTimeoutMs);
    const readback=await readCall();return Boolean(final&&readback&&!readback.error&&isFinal(readback.data));
  }catch{return false;}finally{socket?.close();}
}
