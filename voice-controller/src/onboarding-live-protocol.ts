import {randomUUID} from 'node:crypto';

// Verified against openai-node/resources/live/live.ts and the Live WebRTC guide.
// This module is the Live transport contract; it does not grant business approval.
export type LiveVoice='bossa'|'tempo';
type HistoryMessage={role:'developer'|'user'|'assistant';text:string};
type LiveEvent=Record<string,any>;
type CreationInput={sdp:string;voice:LiveVoice;instructions:string;history?:HistoryMessage[]};
type ProviderFetch=(url:string,init?:RequestInit)=>Promise<Response>;

export class LiveCreationError extends Error {
  constructor(readonly outcome:'rejected'|'unknown',readonly status:number|null=null){
    super(outcome==='rejected'?'live_creation_rejected':'live_creation_outcome_unknown');
  }
}

export async function createLiveWebRtcSession(input:CreationInput,deps:{apiKey:string;fetch?:ProviderFetch;signal?:AbortSignal}){
  if(!deps.apiKey||!['bossa','tempo'].includes(input.voice)||typeof input.sdp!=='string'||!input.sdp.trim()
    ||Buffer.byteLength(input.sdp)>65536||typeof input.instructions!=='string'||!input.instructions.trim())throw Error('live_startup_invalid');
  const history=input.history??[];
  if(history.length>128||history.some(m=>!['developer','user','assistant'].includes(m.role)||typeof m.text!=='string'||!m.text.trim()))throw Error('live_history_invalid');
  deps.signal?.throwIfAborted();
  const body={session:{model:'gpt-live-1',instructions:input.instructions,delegation:{type:'client'},audio:{output:{voice:input.voice}},store:false,
    input:history.map(m=>({type:'message',role:m.role,content:[{type:m.role==='assistant'?'output_text':'input_text',text:m.text}]})),
    client:{data_channel:{
      allowed_client_events:['session.close','session.input_audio.mute','session.input_audio.unmute'],
      allowed_server_events:['session.started','session.closed','session.usage.updated','session.input_transcript.delta','session.output_transcript.delta','error','info'],
    }}},transport:{type:'webrtc',sdp:input.sdp}};
  let response:Response;
  try{response=await(deps.fetch??fetch)('https://api.openai.com/v1/live/sessions',{
    method:'POST',headers:{Authorization:`Bearer ${deps.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:deps.signal,
  });}catch{throw new LiveCreationError('unknown');}
  // No retry here: a missing response cannot establish that creation had no effect.
  if(!response.ok)throw new LiveCreationError(response.status>=500||response.status===408?'unknown':'rejected',response.status);
  let value:any;
  try{value=await response.json();}catch{throw new LiveCreationError('unknown',response.status);}
  if(typeof value?.session?.id!=='string'||!value.session.id.trim()||value.transport?.type!=='webrtc'
    ||typeof value.transport.sdp!=='string'||!value.transport.sdp.trim())throw new LiveCreationError('unknown',response.status);
  return{sessionId:value.session.id as string,sdp:value.transport.sdp as string};
}

export function liveDurationCostUsd(seconds:number,options:{created?:boolean}={}){
  if(!Number.isFinite(seconds)||seconds<0)throw Error('live_duration_invalid');
  // WebRTC initialization is a 15-second minimum, credited to running duration.
  return Math.round(Math.max(seconds,options.created?15:0)*0.05/60*1e8)/1e8;
}

export type LiveFinalization={finalized:boolean;reason:string;seconds:number};
export function createLiveLifecycle(deps:{sessionId:string;send:(event:LiveEvent)=>void;cleanup?:()=>void;closeTimeoutMs?:number}){
  let phase:'connecting'|'running'|'closing'|'closed'='connecting',seconds=0,finalized=false,finalUsageConfirmed=false,cleaned=false;
  let closePromise:Promise<LiveFinalization>|undefined,resolveClose:((r:LiveFinalization)=>void)|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,result:LiveFinalization|undefined;
  let greetingEventId:string|undefined,greetingAccepted=false;
  const duration=(value:unknown)=>{if(typeof value==='number'&&Number.isFinite(value)&&value>=0)seconds=Math.max(seconds,value);};
  function finish(value:LiveFinalization){
    if(result)return;
    result=value;phase='closed';finalized=value.finalized;clearTimeout(timer);
    if(!closePromise)closePromise=Promise.resolve(value);
    resolveClose?.(value);
    if(!cleaned){cleaned=true;try{deps.cleanup?.();}catch{/* Cleanup failure cannot erase provider finalization. */}}
  }
  function append(type:'session.instructions.append'|'session.thinking.append'|'session.commentary.append',delegationId:string|null,content:string,event_id=randomUUID()){
    if(phase!=='running')throw Error('live_not_running');
    if(typeof content!=='string'||!content.trim()||(delegationId!==null&&(typeof delegationId!=='string'||!delegationId)))throw Error('live_append_invalid');
    deps.send({type,event_id,delegation_id:delegationId,content});return event_id;
  }
  function observe(event:LiveEvent){
    if(result)return;
    if(event.type==='session.started'){
      if(event.session?.id!==deps.sessionId||event.session?.model!=='gpt-live-1')return;
      if(phase==='connecting')phase='running';
    }else if(event.type==='session.usage.updated')duration(event.usage?.seconds);
    else if(event.type==='session.instructions.appended'&&event.client_event_id===greetingEventId)greetingAccepted=true;
    else if(event.type==='session.closed'){
      if(event.session?.id!==deps.sessionId)return;
      const finalSeconds=event.usage?.seconds;
      finalUsageConfirmed=typeof finalSeconds==='number'&&Number.isFinite(finalSeconds)&&finalSeconds>=seconds;
      duration(event.usage?.seconds);
      finish({finalized:true,reason:typeof event.reason==='string'?event.reason:'unknown',seconds});
    }
  }
  function close():Promise<LiveFinalization>{
    if(closePromise)return closePromise;
    // Register resolution before sending: a synchronous or very fast final event
    // must not be lost, and repeated Stop must share one close operation.
    closePromise=new Promise(resolve=>{resolveClose=resolve;});phase='closing';
    timer=setTimeout(()=>finish({finalized:false,reason:'finalization_timeout',seconds}),deps.closeTimeoutMs??8000);
    try{deps.send({type:'session.close',event_id:randomUUID()});}
    catch{finish({finalized:false,reason:'transport_unavailable',seconds});}
    return closePromise;
  }
  return{
    observe,close,
    greet(instructions:string){
      if(phase!=='running')throw Error('live_not_started');
      if(greetingEventId)return greetingEventId;
      greetingEventId=randomUUID();
      try{append('session.instructions.append',null,`${instructions}\nComece agora, sem esperar a primeira fala, e depois escute o dono.`,greetingEventId);}
      catch(error){greetingEventId=undefined;throw error;}
      return greetingEventId;
    },
    commentary:(delegationId:string|null,content:string)=>append('session.commentary.append',delegationId,content),
    thinking:(delegationId:string|null,content:string)=>append('session.thinking.append',delegationId,content),
    status:()=>({phase,seconds,finalized,finalUsageConfirmed,greetingAccepted}),
  };
}
