import {randomUUID} from 'node:crypto';

type Event=Record<string,any>;
export type LiveResponsesToolContext={delegationId:string;responseId:string;toolCallId:string;delegationOffsetMs:number|null};
export type LiveResponsesUsage={delegationId:string;responseId:string;model:string|null;status:string;usage:Record<string,unknown>};
export type LiveResponsesError={source:'provider'|'protocol'|'transport'|'tool';code:string|null;
  delegationId?:string;responseId?:string;toolCallId?:string;clientEventId?:string};
type Options={send:(event:Event)=>void;execute:(name:string,args:Record<string,unknown>,context:LiveResponsesToolContext)=>Promise<unknown>;
  onUsage?:(value:LiveResponsesUsage)=>void;onError?:(error:LiveResponsesError)=>void;onIdle?:()=>void};
type Round={delegationId:string;responseId:string;delegationOffsetMs:number|null;calls:Set<string>;
  terminal:boolean;failed:boolean;stale:boolean;continued:boolean;usageReported:boolean};
type Call={round:Round;name:string;arguments:string;submitted:boolean};
const object=(value:unknown):value is Event=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;

/** Thin function transport for the managed Live Responses backend.
 * Official contract: live-delegation#complete-a-client-actionable-function-call.
 * Live owns context preparation and reasoning. The injected business executor owns
 * authorization, operation idempotency, revisions, and reconciliation of effects.
 */
export function createLiveResponsesBridge(options:Options){
  const rounds=new Map<string,Round>(),current=new Map<string,Round>(),offsets=new Map<string,number>();
  const calls=new Map<string,Call>(),commands=new Map<string,Round>(),seenEvents=new Set<string>();
  // Continuations are session-scoped commands; only a new response observed for
  // the SAME delegation consumes the pending count. Other delegations never do.
  const pendingContinuations=new Map<string,number>(),continuationEvents=new Map<string,string>();
  let stopped=false,wasBusy=false;
  function busy(){
    if(stopped)return false;
    for(const round of current.values()){
      if(round.failed||round.stale)continue;
      if(!round.terminal||[...round.calls].some(callId=>!calls.get(callId)?.submitted))return true;
    }
    for(const count of pendingContinuations.values())if(count>0)return true;
    return false;
  }
  // Fires once per busy->idle transition (including local failures), so the
  // host never waits for a provider event that will not come.
  function syncIdle(){
    const now=busy();
    if(wasBusy&&!now)queueMicrotask(()=>{try{options.onIdle?.();}catch{/* Observers cannot control the transport. */}});
    wasBusy=now;
  }
  function report(error:LiveResponsesError){try{options.onError?.(error);}catch{/* Observability cannot control voice or repeat operations. */}}
  function fail(round:Round,source:LiveResponsesError['source'],code:string|null,extra:Partial<LiveResponsesError>={}){
    round.failed=true;report({source,code,delegationId:round.delegationId,responseId:round.responseId,...extra});syncIdle();
  }
  const active=(round:Round)=>!stopped&&!round.failed&&!round.stale;
  function send(round:Round,event:Event){
    if(!active(round))return false;
    commands.set(event.event_id,round);
    try{options.send(event);return active(round);}
    catch{fail(round,'transport','live_responses_send_failed',{clientEventId:event.event_id});return false;}
  }
  function continueReady(){
    if(stopped)return;
    const pending=[...current.values()].filter(round=>!round.failed&&!round.stale&&!round.continued);
    // response.create is session-scoped, not delegation-scoped. Never start it
    // while another observed response or one of its required results is pending.
    if(pending.some(round=>!round.terminal||[...round.calls].some(callId=>!calls.get(callId)?.submitted)))return;
    const ready=pending.filter(round=>round.calls.size>0);
    if(!ready.length)return;
    for(const round of ready)round.continued=true;
    const event={type:'response.create',event_id:randomUUID()};
    if(send(ready[0],event)){
      pendingContinuations.set(ready[0].delegationId,(pendingContinuations.get(ready[0].delegationId)??0)+1);
      continuationEvents.set(event.event_id,ready[0].delegationId);
    }
    syncIdle();
  }
  function submit(round:Round,callId:string,result:unknown){
    if(!active(round))return;
    let output:string|undefined;
    try{output=JSON.stringify(result);}catch{/* Invalid results must not become fabricated success. */}
    if(output===undefined){
      report({source:'tool',code:'live_responses_tool_result_invalid',delegationId:round.delegationId,responseId:round.responseId,toolCallId:callId});
      output=JSON.stringify({ok:false,code:'tool_result_invalid',outcome:'unknown',retryable:false});
    }
    const call=calls.get(callId)!;
    if(send(round,{type:'response.item.create',event_id:randomUUID(),item:{type:'function_call_output',call_id:callId,output}}))call.submitted=true;
    continueReady();syncIdle();
  }
  function functionDone(round:Round,item:Event){
    if(!active(round)||round.continued)return;
    if(!id(item.call_id)||!id(item.name)||typeof item.arguments!=='string'||(item.status&&item.status!=='completed')){
      fail(round,'protocol','live_responses_function_item_invalid');return;
    }
    const previous=calls.get(item.call_id);
    if(previous){
      if(previous.round!==round||previous.name!==item.name||previous.arguments!==item.arguments)fail(round,'protocol','live_responses_call_conflict',{toolCallId:item.call_id});
      return;
    }
    calls.set(item.call_id,{round,name:item.name,arguments:item.arguments,submitted:false});round.calls.add(item.call_id);
    let args:Record<string,unknown>;
    try{args=JSON.parse(item.arguments);if(!object(args))throw Error();}
    catch{submit(round,item.call_id,{ok:false,code:'invalid_tool_arguments'});return;}
    const context:LiveResponsesToolContext={delegationId:round.delegationId,responseId:round.responseId,toolCallId:item.call_id,delegationOffsetMs:round.delegationOffsetMs};
    // Catch synchronous and asynchronous executor failures. Stop can invalidate
    // submission but cannot undo a commit; business receipts remain authoritative.
    void Promise.resolve().then(()=>active(round)?options.execute(item.name,args,context):undefined).then(result=>submit(round,item.call_id,result),()=>{
      if(!active(round))return;
      report({source:'tool',code:'live_responses_tool_execution_failed',...context});
      submit(round,item.call_id,{ok:false,code:'tool_execution_failed',outcome:'unknown',retryable:false});
    });
  }
  function observe(envelope:Event){observeEvent(envelope);syncIdle();}
  function observeEvent(envelope:Event){
    if(!object(envelope))return;
    if(!['session.closed','session.delegation.created','response.event','error'].includes(envelope.type))return;
    if(envelope.type==='response.event'&&object(envelope.event)
      &&!['response.created','response.output_item.done','response.completed','response.failed','response.incomplete','response.cancelled','error'].includes(envelope.event.type))return;
    if(id(envelope.event_id)){
      if(seenEvents.has(envelope.event_id))return;
      seenEvents.add(envelope.event_id);
    }
    if(envelope.type==='session.closed'){stopped=true;return;}
    if(envelope.type==='error'){
      const error=object(envelope.error)?envelope.error:{};
      const clientEventId=id(error.client_event_id)?error.client_event_id:id(envelope.client_event_id)?envelope.client_event_id:undefined;
      const code=typeof error.code==='string'?error.code:null,round=clientEventId?commands.get(clientEventId):undefined;
      const continuation=clientEventId?continuationEvents.get(clientEventId):undefined;
      if(continuation){continuationEvents.delete(clientEventId!);pendingContinuations.set(continuation,Math.max(0,(pendingContinuations.get(continuation)??0)-1));}
      if(round)fail(round,'provider',code,{clientEventId});
      else report({source:'provider',code,...(clientEventId?{clientEventId}:{})});
      return;
    }
    if(envelope.type==='session.delegation.created'){
      if(stopped)return;
      const delegation=envelope.delegation;
      if(object(delegation)&&delegation.target==='responses'&&id(delegation.id)&&Number.isFinite(envelope.offset_ms)&&envelope.offset_ms>=0)offsets.set(delegation.id,envelope.offset_ms);
      return;
    }
    if(envelope.type!=='response.event'||!object(envelope.event))return;
    const event=envelope.event,delegationId=envelope.delegation_id;
    if(!id(delegationId)){
      if(!stopped&&(event.type==='response.created'||(event.type==='response.output_item.done'&&event.item?.type==='function_call')))
        report({source:'protocol',code:'live_responses_delegation_missing'});
      return;
    }
    if(event.type==='response.created'){
      if(stopped)return;
      const responseId=event.response?.id;
      if(!id(responseId)){report({source:'protocol',code:'live_responses_response_missing',delegationId});return;}
      const existing=rounds.get(responseId);
      if(existing){
        if(existing.delegationId!==delegationId)fail(existing,'protocol','live_responses_response_conflict');
        return;
      }
      const previous=current.get(delegationId);
      if(previous)previous.stale=true;
      const pending=pendingContinuations.get(delegationId)??0;
      if(pending>0)pendingContinuations.set(delegationId,pending-1);
      const round:Round={delegationId,responseId,delegationOffsetMs:offsets.get(delegationId)??null,calls:new Set(),terminal:false,failed:false,stale:false,continued:false,usageReported:false};
      rounds.set(responseId,round);current.set(delegationId,round);return;
    }
    const responseId=event.response?.id??event.response_id;
    const round=id(responseId)?rounds.get(responseId):current.get(delegationId);
    if(!round||round.delegationId!==delegationId){
      if(!stopped&&(event.type==='response.output_item.done'||event.type==='response.completed'))report({source:'protocol',code:'live_responses_response_missing',delegationId});
      return;
    }
    const terminal=['response.completed','response.failed','response.incomplete','response.cancelled'].includes(event.type);
    if(terminal){
      // Final usage can arrive during close. Report one snapshot per response,
      // never sum duplicate completion events as additional backend consumption.
      if(!round.usageReported&&object(event.response?.usage)){
        round.usageReported=true;
        try{options.onUsage?.({delegationId,responseId:round.responseId,model:typeof event.response.model==='string'?event.response.model:null,
          status:typeof event.response.status==='string'?event.response.status:event.type.slice('response.'.length),usage:event.response.usage});}catch{/* Fail open for usage observers. */}
      }
      if(round.terminal)return;
      round.terminal=true;
      if(event.type!=='response.completed'||(event.response?.status&&event.response.status!=='completed'))fail(round,'provider','live_responses_response_failed');
      continueReady();return;
    }
    if(!active(round))return;
    if(event.type==='error'){fail(round,'provider',typeof event.code==='string'?event.code:null);return;}
    if(event.type==='response.output_item.done'&&object(event.item)&&event.item.type==='function_call')functionDone(round,event.item);
  }
  return{observe,busy,stop(){stopped=true;syncIdle();}};
}
