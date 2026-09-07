import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { attachSideband, liveSessions } from "../src/sideband.ts";
import { makeCapability } from "../src/tools.ts";
import { _setClient } from "../src/rules.ts";
import { createOnboardingAgenda, getAgendaAction } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";
import { buildWebsiteOpeningAction } from "../src/onboarding-agenda-coordinator.ts";

const callId = "33333333-3333-4333-8333-333333333333", ownerId="11111111-1111-4111-8111-111111111111", tenantId="22222222-2222-4222-8222-222222222222", requestId="44444444-4444-4444-8444-444444444444";
const hash = (s:string|Uint8Array)=>createHash("sha256").update(s).digest("hex");
function fixture(){
  const agenda=createOnboardingAgenda({interviewId:callId,callId,draftId:requestId,draftHash:"a".repeat(64),sourceResultId:requestId,sourceResultHash:"b".repeat(64)},[{id:"area",source:"owner_private_requirement",subject:"area",questionPt:"Quais cidades atende?",coverageRefs:[],relatedItemIds:[],blocking:true}]);
  const stored={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:requestId,nextAction:getAgendaAction(agenda),state:"unfinished" as const,replayed:false};
  const openingAction=buildWebsiteOpeningAction(stored,"Foghorn Air");
  const audio=Buffer.from([73,68,51,4,0]);
  return {prepared:{scope:{ownerId,callId,requestId},stored,projection:{} as any},openingAction,openingPayload:{...openingAction,schema:"onboarding.speech.v1" as const,text_sha256:hash(openingAction.text),audio_sha256:hash(audio),audio_base64:audio.toString("base64"),mime:"audio/mpeg" as const,voice:"ash" as const,tts_model:"tts-1-hd" as const,cost_usd:Number(([...openingAction.text].length*30/1e6).toFixed(8))}};
}
class Socket {
  static instances:Socket[]=[];listeners=new Map<string,Function[]>();sent:any[]=[];closed=false;
  constructor(){Socket.instances.push(this);}
  addEventListener(type:string,fn:Function){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
  send(text:string){this.sent.push(JSON.parse(text));}
  close(){if(this.closed)return;this.closed=true;this.emit("close",{code:1000});}
  emit(type:string,event:any={}){for(const fn of this.listeners.get(type)??[])fn(event);}
  message(event:any){this.emit("message",{data:JSON.stringify(event)});}
}
async function flush(){for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));}
function harness(){
  const original=globalThis.WebSocket;Socket.instances=[];globalThis.WebSocket=Socket as any;
  const updates:any[]=[],rpcs:any[]=[];const website=fixture();
  _setClient({
    rpc:async(name:string,args:any)=>{rpcs.push({name,args});
      if(name==="record_website_interview_speech_played")return {data:{receiptId:requestId},error:null};
      if(name==="record_website_interview_owner_turn")return {data:{callId,providerItemId:args.p_item,turnId:`${callId}:${args.p_item}`,text:args.p_text,replayed:false},error:null};
      if(name==="begin_provider_termination_attempt")return {data:{should_attempt:false},error:null};
      return {data:null,error:null};},
    from(table:string){let patch:any;const query:any={update(value:any){patch=value;updates.push({table,...value});return query;},select(){return query;},eq(){return query;},maybeSingle:async()=>({data:table==="calls"?{id:callId,tenant_id:tenantId,ended_at:new Date().toISOString(),status:"error",openai_call_id:"rtc-test",provider_termination_state:"confirmed"}:null,error:null}),then(resolve:Function){return Promise.resolve({data:null,error:null}).then(resolve as any);}};return query;},
  } as any);
  const cap=makeCapability("foghorn-air",tenantId,callId,30,"onboarding",{authEpoch:1,policyEpoch:1,simulation:true},ownerId);
  let control:ReturnType<typeof attachSideband>|undefined;
  return {website,updates,rpcs,attach(){control=attachSideband(cap,"rtc-test","gpt-realtime-2.1",{onboarding:{expectedBusinessName:"Foghorn Air",openingMode:"application_tts_v1",websiteInterview:website},externalCostUsd:website.openingPayload.cost_usd,fetchImpl:async()=>{throw new Error("provider request forbidden");}} as any);return control;},restore(){control?.cancel();globalThis.WebSocket=original;_setClient(null);liveSessions.delete(callId);}};
}

test("website sideband boot bypasses legacy opening activation and owns every audible transcript",async()=>{
  const h=harness();try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit("open");await control.opened;
    expect(control.ledger.applicationOpening).toBeUndefined();
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].session).toMatchObject({output_modalities:["text"],tools:[],tool_choice:"none",audio:{input:{turn_detection:{create_response:false,interrupt_response:false}}}});
    sock.message({type:"response.output_audio_transcript.done",transcript:"Se quiser, posso ajudar com seu site."});
    sock.message({type:"conversation.item.done",item:{id:`lgs-${h.website.openingAction.actionId.slice(0,28)}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:h.website.openingPayload.text}]}});
    await flush();
    expect(control.ledger.phase).toBe("awaiting_owner");
    expect(control.ledger.transcript.map(x=>x.text)).toEqual([h.website.openingPayload.text]);
    expect(sock.sent.filter(x=>x.type==="response.create")).toHaveLength(0);
    sock.message({type:"input_audio_buffer.speech_started",item_id:"owner-1"});
    sock.message({type:"conversation.item.input_audio_transcription.completed",item_id:"owner-1",transcript:"Atendemos Concord."});await flush();
    const interpretation=sock.sent.find(x=>x.type==="response.create");
    expect(interpretation.response.conversation).toBe("none");
    expect(interpretation.response.output_modalities).toEqual(["text"]);
    expect(h.rpcs.filter(x=>x.name==="record_website_interview_owner_turn")).toHaveLength(1);
  }finally{h.restore();}
});

test("website timeout finalizes without waiting for a subsequent provider message",async()=>{
  const h=harness();const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,originalNow=Date.now;
  const originalMonotonic=Object.getOwnPropertyDescriptor(performance,'now');
  let now=0;const timers=new Map<any,{callback:Function,ms:number}>();
  globalThis.setTimeout=((callback:Function,ms:number)=>{const id={};timers.set(id,{callback,ms});return id;}) as any;
  globalThis.clearTimeout=((id:any)=>timers.delete(id)) as any;
  Object.defineProperty(performance,'now',{value:()=>now,configurable:true});
  try{
    const control=h.attach();Socket.instances[0]!.emit("open");await control.opened;
    const deadline=[...timers.values()].find(x=>x.ms<=30_000)!;expect(deadline).toBeDefined();
    Date.now=()=>originalNow()+3_600_000;deadline.callback();await flush();
    expect(liveSessions.has(callId)).toBe(true);
    now+=40_000;deadline.callback();await flush();
    expect(h.updates.some(x=>x.table==="calls" && x.status==="error")).toBe(true);
    expect(liveSessions.has(callId)).toBe(false);
    expect(timers.size).toBe(0);
  }finally{h.restore();Date.now=originalNow;globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;
    if(originalMonotonic)Object.defineProperty(performance,'now',originalMonotonic);else delete (performance as any).now;}
});

test("silent interpretation usage is counted once without inventing terminal usage",async()=>{
  const h=harness();try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit("open");await control.opened;
    sock.message({type:"conversation.item.done",item:{id:`lgs-${h.website.openingAction.actionId.slice(0,28)}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:h.website.openingPayload.text}]}});await flush();
    sock.message({type:"input_audio_buffer.speech_started",item_id:"owner-usage"});
    sock.message({type:"conversation.item.input_audio_transcription.completed",item_id:"owner-usage",transcript:"Concord"});await flush();
    const sent=sock.sent.find(x=>x.type==="response.create");
    const response={id:"silent-response",metadata:sent.response.metadata,status:"failed",output:[],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_token_details:{text_tokens:10,audio_tokens:0,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:5,audio_tokens:0}}};
    sock.message({type:"response.created",response});sock.message({type:"response.done",response});sock.message({type:"response.done",response});await flush();
    expect(control.ledger.usage.textIn).toBe(10);expect(control.ledger.usage.textOut).toBe(5);
    expect(control.ledger.providerUsageEvidence.eventCount).toBe(1);
    expect(control.ledger.providerUsageEvidence.terminal).toBe(false);
  }finally{h.restore();}
});

test("website reattach preserves runtime state and never enables legacy auto response",async()=>{
  const h=harness();try{
    const control=h.attach(),first=Socket.instances[0]!;first.emit("open");await control.opened;
    const runtime=control.ledger.websiteInterviewRuntime;
    first.close();await new Promise(resolve=>setTimeout(resolve,550));
    const second=Socket.instances[1]!;expect(second).toBeDefined();second.emit("open");await flush();
    expect(control.ledger.websiteInterviewRuntime).toBe(runtime);
    expect(second.sent).toHaveLength(2);
    expect(second.sent[0].session.audio.input.turn_detection).toMatchObject({create_response:false,interrupt_response:false});
    const retrieve=second.sent[1];expect(retrieve.item_id).toBe(`lgs-${h.website.openingAction.actionId.slice(0,28)}`);
    second.message({type:'error',error:{event_id:retrieve.event_id,code:'item_not_found'}});await flush();expect(control.ledger.status).toBe('active');
    second.message({type:'error',error:{event_id:retrieve.event_id,type:'invalid_request_error',param:'item_id',code:'invalid_request_error',message:`Item '${retrieve.item_id}' does not exist.`}});await flush();expect(control.ledger.status).toBe('active');
    second.message({type:'conversation.item.retrieved',item:{id:retrieve.item_id,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:h.website.openingPayload.text}]}});await flush();
    expect(control.ledger.phase).toBe('awaiting_owner');expect(h.rpcs.filter(x=>x.name==='record_website_interview_speech_played')).toHaveLength(1);
    expect(control.ledger.providerUsageEvidence.continuous).toBe(false);
  }finally{h.restore();}
});

test("website silent usage still trips the existing hard session budget",async()=>{
  const h=harness();try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit("open");await control.opened;
    sock.message({type:"conversation.item.done",item:{id:`lgs-${h.website.openingAction.actionId.slice(0,28)}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:h.website.openingPayload.text}]}});await flush();
    sock.message({type:"input_audio_buffer.speech_started",item_id:"owner-budget"});
    sock.message({type:"conversation.item.input_audio_transcription.completed",item_id:"owner-budget",transcript:"Concord"});await flush();
    control.ledger.budgetEnvelope!.hardLimitUsd=0;
    const sent=sock.sent.find(x=>x.type==="response.create");
    sock.message({type:"response.done",response:{id:"cost-response",metadata:sent.response.metadata,status:"failed",output:[],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_token_details:{text_tokens:10,audio_tokens:0,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:5,audio_tokens:0}}}});await flush();
    expect(control.ledger.status).toBe("killed_budget");
    expect(liveSessions.has(callId)).toBe(false);
  }finally{h.restore();}
});
