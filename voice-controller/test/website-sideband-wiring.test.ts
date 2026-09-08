import { expect, test } from "bun:test";
import { attachSideband, liveSessions } from "../src/sideband.ts";
import { makeCapability } from "../src/tools.ts";
import { _setClient } from "../src/rules.ts";
import { createOnboardingAgenda, getAgendaAction } from "../src/onboarding-agenda.ts";
import { onboardingAgendaDigest } from "../src/onboarding-agenda-store.ts";

const callId = "33333333-3333-4333-8333-333333333333", ownerId="11111111-1111-4111-8111-111111111111", tenantId="22222222-2222-4222-8222-222222222222", requestId="44444444-4444-4444-8444-444444444444";
function fixture(){
  const agenda=createOnboardingAgenda({interviewId:callId,callId,draftId:requestId,draftHash:"a".repeat(64),sourceResultId:requestId,sourceResultHash:"b".repeat(64)},[{id:"area",source:"owner_private_requirement",subject:"area",questionPt:"Quais cidades atende?",coverageRefs:[],relatedItemIds:[],blocking:true}]);
  const stored={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:requestId,nextAction:getAgendaAction(agenda),state:"unfinished" as const,replayed:false};
  return {native:true as const,businessName:"Foghorn Air",prepared:{scope:{ownerId,callId,requestId},stored,projection:{} as any}};
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
function harness(options:{rpc?:(name:string,args:any)=>any;fetchImpl?:typeof fetch;callRow?:()=>Record<string,unknown>;legacy?:boolean;terminalWrite?:()=>any}={}){
  const original=globalThis.WebSocket;Socket.instances=[];globalThis.WebSocket=Socket as any;
  const updates:any[]=[],rpcs:any[]=[];const website:any=fixture();
  _setClient({
    rpc:async(name:string,args:any)=>{rpcs.push({name,args});
      const override=options.rpc?.(name,args);if(override!==undefined)return await override;
      if(name==="record_website_interview_speech_played")return {data:{receiptId:requestId},error:null};
      if(name==="record_website_interview_owner_turn")return {data:{callId,providerItemId:args.p_item,turnId:`${callId}:${args.p_item}`,text:args.p_text,replayed:false},error:null};
      if(name==="begin_provider_termination_attempt")return {data:{should_attempt:false},error:null};
      return {data:null,error:null};},
    from(table:string){let patch:any;const query:any={update(value:any){patch=value;updates.push({table,...value});return query;},select(){return query;},eq(){return query;},maybeSingle:async()=>({data:table==="calls"?{id:callId,tenant_id:tenantId,ended_at:new Date().toISOString(),status:"error",openai_call_id:"rtc-test",provider_termination_state:"confirmed",...options.callRow?.()}:null,error:null}),then(resolve:Function,reject?:Function){const result=table==='calls'&&patch?.status?options.terminalWrite?.():undefined;return Promise.resolve(result??{data:null,error:null}).then(resolve as any,reject as any);}};return query;},
  } as any);
  const cap=makeCapability("foghorn-air",tenantId,callId,30,options.legacy?"customer":"onboarding",{authEpoch:1,policyEpoch:1,simulation:true},ownerId);
  let control:ReturnType<typeof attachSideband>|undefined;
  return {website,updates,rpcs,attach(){control=attachSideband(cap,"rtc-test","gpt-realtime-2.1",{...(options.legacy?{}:{onboarding:{expectedBusinessName:"Foghorn Air",openingMode:"realtime_native_v1",websiteInterview:website},externalCostUsd:0}),fetchImpl:options.fetchImpl??(async()=>{throw new Error("provider request forbidden");})} as any);return control;},restore(){control?.cancel();globalThis.WebSocket=original;_setClient(null);liveSessions.delete(callId);}};
}

const readyControl=()=>({type:'conversation.item.done',item:{id:'lnr-'+callId.replaceAll('-','').slice(0,28),type:'message',role:'system',status:'completed',content:[{type:'input_text',text:'ligou.website_native_ready:'+JSON.stringify({callId,interviewId:callId})}]}});
test('native sideband starts audio once after browser readiness without any speech authorization RPC',async()=>{
 const h=harness();try{
  const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
  expect(control.ledger.externalCostUsd).toBe(0);expect(sock.sent.some(e=>e.type==='response.create')).toBe(false);
  expect(sock.sent.find(e=>e.type==='session.update').session).toMatchObject({output_modalities:['audio'],tool_choice:'auto'});
  sock.message(readyControl());sock.message(readyControl());await flush();
  const requests=sock.sent.filter(e=>e.type==='response.create');expect(requests).toHaveLength(1);
  expect(requests[0].response.output_modalities).toEqual(['audio']);expect(requests[0].response.conversation).toBeUndefined();
  sock.message({type:'response.created',response:{id:'native-response',metadata:requests[0].response.metadata}});
  sock.message({type:'response.output_audio.delta',response_id:'native-response',item_id:'native-item',delta:'AAAA'});await flush();
  expect(control.ledger.status).toBe('active');expect(h.rpcs.some(x=>/speech|stream/.test(x.name))).toBe(false);
 }finally{h.restore();}
});

const stopControl=()=>({type:'conversation.item.done',item:{id:`lgt-${callId.replaceAll('-','').slice(0,28)}`,type:'message',status:'completed',role:'system',content:[{type:'input_text',text:`ligou.website_stop:${callId}`}]}});
test.each(['error','held'])('audited Stop hangup is independent of terminal bookkeeping %s',async mode=>{
  let hangups=0,providerState='active',expireWrite:(()=>void)|undefined,expireHold:(()=>void)|undefined;
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,writeTimer={} as any,holdTimer={} as any;
  globalThis.setTimeout=((fn:()=>void,ms:number,...args:any[])=>{
    if(ms===2000){expireWrite=()=>fn(...args);return writeTimer;}
    if(ms>8000&&ms<=9000){expireHold=()=>fn(...args);return holdTimer;}
    return originalSet(fn,ms,...args);
  }) as any;
  globalThis.clearTimeout=((timer:any)=>{if(timer===writeTimer)expireWrite=undefined;else if(timer===holdTimer)expireHold=undefined;else originalClear(timer);}) as any;
  const h=harness({terminalWrite:()=>mode==='held'?new Promise(()=>{}):{data:null,error:{message:'synthetic terminal write failure'}},
    callRow:()=>({status:'active',ended_at:null,provider_termination_state:providerState}),
    rpc:name=>{
      if(name==='begin_provider_termination_attempt')return{data:{should_attempt:true,attempt_id:requestId,request_id:requestId,openai_call_id:'rtc-test',provider_termination_mode:'hangup'},error:null};
      if(name==='complete_provider_termination_attempt'){providerState='confirmed';return{data:true,error:null};}
    },fetchImpl:async()=>{hangups++;return new Response(null,{status:200});}});
  try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
    sock.message(stopControl());await flush();
    expect(hangups).toBe(1);expect(providerState).toBe('confirmed');
    expect(h.rpcs.filter(x=>x.name==='begin_provider_termination_attempt')).toHaveLength(1);
    expect(h.rpcs.filter(x=>x.name==='complete_provider_termination_attempt')).toHaveLength(1);
    if(mode==='held'){expect(sock.closed).toBe(false);expect(expireWrite).toBeDefined();expireWrite!();await flush();}
    expect(sock.closed).toBe(true);expect(control.ledger.budgetFinalized).not.toBe(true);
    expect(h.rpcs.some(x=>x.name==='settle_call_budget'||x.name==='approve_website_interview_summary')).toBe(false);
  }finally{expireWrite?.();expireHold?.();await flush();h.restore();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});
test('exact website Stop fences pending work immediately and retains sideband through one audited provider hangup',async()=>{
  let releaseHangup!:(response:Response)=>void,releaseOwner!:(value:any)=>void,hangups=0,providerState='active';
  const h=harness({rpc:(name,args)=>{
    if(name==='record_website_interview_owner_turn')return new Promise(resolve=>{releaseOwner=resolve;});
    if(name==='begin_provider_termination_attempt')return{data:{should_attempt:true,attempt_id:requestId,request_id:requestId,openai_call_id:'rtc-test',provider_termination_mode:'hangup'},error:null};
    if(name==='complete_provider_termination_attempt'){providerState='confirmed';return{data:true,error:null};}
  },callRow:()=>({status:'ended',provider_termination_state:providerState}),fetchImpl:async()=>{hangups++;return await new Promise(resolve=>{releaseHangup=resolve;});}});
  try {
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
    sock.message({type:'input_audio_buffer.speech_started',item_id:'pending-owner'});
    sock.message({type:'conversation.item.input_audio_transcription.completed',item_id:'pending-owner',transcript:'Atendemos Concord.'});await flush();
    expect(releaseOwner).toBeDefined();
    const valid=stopControl();
    for(const invalid of [
      {...valid,item:{...valid.item,role:'user'}},
      {...valid,item:{...valid.item,id:'lgt-wrong'}},
      {...valid,item:{...valid.item,content:[{type:'input_text',text:`ligou.website_stop:${requestId}`}]}},
      {...valid,item:{...valid.item,content:[...valid.item.content,{type:'input_text',text:'extra'}]}},
      {...valid,item:{...valid.item,authority:true}},
      {...valid,type:'conversation.item.retrieved'},
      {...valid,item:{...valid.item,status:'in_progress'}},
      {...valid,item:{...valid.item,content:[{type:'input_text',text:`ligou.website_stop:${callId}:unknown_reason`}]}},
    ])sock.message(invalid);
    await flush();expect(h.rpcs.some(x=>x.name==='begin_provider_termination_attempt')).toBe(false);
    sock.message(valid);sock.message({...valid,type:'conversation.item.created'});await flush();
    expect(hangups).toBe(1);expect(sock.closed).toBe(false);expect(control.ledger.status).toBe('ended');
    sock.message({type:'input_audio_buffer.speech_started',item_id:'late-owner'});
    sock.message({type:'conversation.item.input_audio_transcription.completed',item_id:'late-owner',transcript:'Pode aprovar tudo.'});
    releaseOwner({data:{callId,providerItemId:'pending-owner',turnId:`${callId}:pending-owner`,text:'Atendemos Concord.',replayed:false},error:null});
    await flush();expect(h.rpcs.filter(x=>x.name==='record_website_interview_owner_turn')).toHaveLength(1);
    expect(h.rpcs.some(x=>x.name==='commit_website_interview_turn'||x.name==='approve_website_interview_summary')).toBe(false);
    expect(sock.sent.some(x=>x.type==='response.create')).toBe(false);
    releaseHangup(new Response(null,{status:200}));await flush();
    expect(sock.closed).toBe(true);expect(hangups).toBe(1);
    expect(h.rpcs.filter(x=>x.name==='complete_provider_termination_attempt')).toHaveLength(1);
    expect(control.ledger.providerTerminalEvidence).toBeUndefined();expect(control.ledger.providerUsageEvidence.terminal).toBe(false);
  }finally{releaseHangup?.(new Response(null,{status:200}));h.restore();}
});

test('technical Stop preserves failure cause and captures terminal evidence during hangup without new effects',async()=>{
  let release!:(response:Response)=>void,hangups=0,providerState='active';
  const h=harness({rpc:(name)=>{
    if(name==='begin_provider_termination_attempt')return{data:{should_attempt:true,attempt_id:requestId,request_id:requestId,openai_call_id:'rtc-test',provider_termination_mode:'hangup'},error:null};
    if(name==='complete_provider_termination_attempt'){providerState='confirmed';return{data:true,error:null};}
    if(name==='settle_call_budget')return{data:true,error:null};
  },callRow:()=>({status:'error',provider_termination_state:providerState}),fetchImpl:async()=>{hangups++;return await new Promise(resolve=>{release=resolve;});}});
  try {
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
    const stop=stopControl();stop.item.content[0]!.text+=':technical_failure';sock.message(stop);await flush();
    expect(hangups).toBe(1);expect(sock.closed).toBe(false);expect(control.ledger.status).toBe('error');
    expect(h.rpcs.find(x=>x.name==='begin_provider_termination_attempt')?.args.p_reason).toBe('website_client_failure');
    sock.message({type:'session.ended',usage:{input_tokens:6,output_tokens:3,total_tokens:9,input_token_details:{text_tokens:6,audio_tokens:0,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:3,audio_tokens:0}}});
    sock.message({type:'input_audio_buffer.speech_started',item_id:'late'});
    sock.message({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'Aprovo.'});
    expect(control.ledger.providerTerminalEvidence?.observed).toBe(true);expect(control.ledger.providerUsageEvidence.terminal).toBe(true);
    release(new Response(null,{status:200}));await flush();
    expect(hangups).toBe(1);expect(sock.closed).toBe(true);
    expect(h.rpcs.filter(x=>x.name==='settle_call_budget')).toHaveLength(1);
    expect(h.rpcs.some(x=>x.name==='record_website_interview_owner_turn'||x.name==='approve_website_interview_summary')).toBe(false);
  }finally{release?.(new Response(null,{status:200}));h.restore();}
});

test('stale website socket cannot issue Stop for the current call',async()=>{
  const h=harness();try{
    const control=h.attach(),first=Socket.instances[0]!;first.emit('open');await control.opened;
    first.close();await new Promise(resolve=>setTimeout(resolve,550));
    const second=Socket.instances[1]!;second.emit('open');await flush();
    first.message(stopControl());await flush();
    expect(h.rpcs.some(x=>x.name==='begin_provider_termination_attempt')).toBe(false);expect(control.ledger.status).toBe('active');
    second.message(stopControl());await flush();expect(h.rpcs.filter(x=>x.name==='begin_provider_termination_attempt')).toHaveLength(1);
  }finally{h.restore();}
});

test('website Stop controls have no effect on a non-website session',async()=>{
  const h=harness({legacy:true});try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
    sock.message(stopControl());await flush();
    expect(control.ledger.websiteStopReason).toBeUndefined();expect(control.ledger.status).toBe('active');
    expect(h.rpcs.some(x=>x.name==='begin_provider_termination_attempt')).toBe(false);
  }finally{h.restore();}
});

test('native Stop cannot fabricate approval or mutate an approved draft',async()=>{
 const h=harness();try{
  const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
  const before=structuredClone(control.ledger.websiteInterviewRuntime!.state.stored);
  sock.message(stopControl());await flush();
  expect(control.ledger.websiteInterviewRuntime!.state.stored).toEqual(before);
  expect(h.rpcs.some(x=>['approve_website_interview_summary','commit_website_interview_turn','commit_native_website_interview_turn','request_website_interview_amendment'].includes(x.name))).toBe(false);
 }finally{h.restore();}
});

test('controlled website finalization releases its socket after a bounded database hold',async()=>{
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;let expire:(()=>void)|undefined;const sentinel={} as any;
  globalThis.setTimeout=((fn:()=>void,ms:number,...args:any[])=>{if(ms>8_000&&ms<=9_000){expire=()=>fn(...args);return sentinel;}return originalSet(fn,ms,...args);}) as any;
  globalThis.clearTimeout=((timer:any)=>{if(timer!==sentinel)originalClear(timer);}) as any;
  const h=harness({rpc:name=>name==='begin_provider_termination_attempt'?new Promise(()=>{}):undefined});
  try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
    sock.message(stopControl());await flush();expect(sock.closed).toBe(false);expect(expire).toBeDefined();
    expire!();await flush();expect(sock.closed).toBe(true);expect(liveSessions.has(callId)).toBe(false);
    expect(control.ledger.providerTerminalEvidence).toBeUndefined();
  }finally{h.restore();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('native transcripts remain observable without a second text interpretation',async()=>{
 const h=harness();try{
  const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
  expect(control.ledger.applicationOpening).toBeUndefined();
  sock.message({type:'response.output_audio_transcript.done',transcript:'Quais cidades vocês atendem?'});
  sock.message({type:'input_audio_buffer.speech_started',item_id:'owner-1'});
  sock.message({type:'conversation.item.input_audio_transcription.completed',item_id:'owner-1',transcript:'Atendemos Concord.'});await flush();
  expect(control.ledger.transcript.map(x=>x.text)).toEqual(['Quais cidades vocês atendem?','Atendemos Concord.']);
  expect(h.rpcs.filter(x=>x.name==='record_website_interview_owner_turn')).toHaveLength(1);
  expect(sock.sent.some(x=>x.type==='response.create'&&x.response.output_modalities?.includes('text'))).toBe(false);
 }finally{h.restore();}
});

test('provider error finalizes without waiting for another provider event',async()=>{
 const h=harness();try{
  const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
  sock.message({type:'error',error:{code:'server_error',message:'synthetic provider failure'}});await flush();
  expect(control.ledger.status).toBe('error');expect(liveSessions.has(callId)).toBe(false);
 }finally{h.restore();}
});

test("native provider usage is counted once without inventing terminal usage",async()=>{
  const h=harness();try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit("open");await control.opened;
    sock.message(readyControl());await flush();
    const sent=sock.sent.find(x=>x.type==="response.create");
    const response={id:"silent-response",metadata:sent.response.metadata,status:"failed",output:[],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_token_details:{text_tokens:10,audio_tokens:0,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:5,audio_tokens:0}}};
    sock.message({type:"response.created",response});sock.message({type:"response.done",response});sock.message({type:"response.done",response});await flush();
    expect(control.ledger.usage.textIn).toBe(10);expect(control.ledger.usage.textOut).toBe(5);
    expect(control.ledger.providerUsageEvidence.eventCount).toBe(1);
    expect(control.ledger.providerUsageEvidence.terminal).toBe(false);
  }finally{h.restore();}
});

test('native reattach preserves runtime state and does not restart the opening',async()=>{
 const h=harness();try{
  const control=h.attach(),first=Socket.instances[0]!;first.emit('open');await control.opened;
  first.message(readyControl());await flush();
  const runtime=control.ledger.websiteInterviewRuntime;
  first.close();await new Promise(resolve=>setTimeout(resolve,550));
  const second=Socket.instances[1]!;expect(second).toBeDefined();second.emit('open');await flush();
  expect(control.ledger.websiteInterviewRuntime).toBe(runtime);
  expect(second.sent.find(x=>x.type==='session.update').session.audio.input.turn_detection).toMatchObject({create_response:true,interrupt_response:true});
  expect(second.sent.some(x=>x.type==='conversation.item.retrieve'||x.type==='response.create')).toBe(false);
  expect(control.ledger.providerUsageEvidence.continuous).toBe(false);
 }finally{h.restore();}
});

test("native usage still trips the existing hard session budget",async()=>{
  const h=harness();try{
    const control=h.attach(),sock=Socket.instances[0]!;sock.emit("open");await control.opened;
    control.ledger.budgetEnvelope!.hardLimitUsd=0;
    sock.message(readyControl());await flush();
    const sent=sock.sent.find(x=>x.type==="response.create");
    sock.message({type:"response.done",response:{id:"cost-response",metadata:sent.response.metadata,status:"failed",output:[],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_token_details:{text_tokens:10,audio_tokens:0,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:5,audio_tokens:0}}}});await flush();
    expect(control.ledger.status).toBe("killed_budget");
    expect(liveSessions.has(callId)).toBe(false);
  }finally{h.restore();}
});

test('provider session end fences continuation after an already-admitted native write completes',async()=>{
 let releaseCommit!:(value:any)=>void,commitArgs:any;
 const h=harness({rpc:(name,args)=>{
  if(name==='commit_website_interview_native_turn'){commitArgs=args;return new Promise(resolve=>{releaseCommit=resolve;});}
 }});
 try{
  const control=h.attach(),sock=Socket.instances[0]!;sock.emit('open');await control.opened;
  sock.message({type:'conversation.item.done',item:{id:'lnr-'+callId.replaceAll('-','').slice(0,28),role:'system',content:[{
   type:'input_text',text:'ligou.website_native_ready:'+JSON.stringify({callId,interviewId:callId})}]}});await flush();
  const opening=sock.sent.find(x=>x.type==='response.create');
  sock.message({type:'response.created',response:{id:'opening',metadata:opening.response.metadata}});
  sock.message({type:'response.done',response:{id:'opening',status:'completed',output:[]}});await flush();
  sock.message({type:'input_audio_buffer.speech_started',item_id:'owner_before_end'});
  sock.message({type:'input_audio_buffer.committed',item_id:'owner_before_end'});
  sock.message({type:'response.created',response:{id:'answer_response'}});
  sock.message({type:'response.done',response:{id:'answer_response',status:'completed',output:[{type:'function_call',status:'completed',
   call_id:'answer_tool',name:'submit_website_interview_proposal',arguments:JSON.stringify({proposal:{kind:'answer',itemId:'area'},
    interpretation:'Atendemos somente Novato. Fora da cidade exige aprovação do dono.',facts:[]})}]}});await flush();
  expect(releaseCommit).toBeDefined();
  sock.message({type:'session.ended',usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_token_details:{text_tokens:1,audio_tokens:0,cached_tokens:0,cached_tokens_details:{text_tokens:0,audio_tokens:0}},output_token_details:{text_tokens:1,audio_tokens:0}}});
  expect(control.ledger.providerTerminalEvidence?.observed).toBe(true);
  const sentAtTerminal=sock.sent.length;
  releaseCommit({data:{agenda:commitArgs.p_agenda,revision:1,storeVersion:1,digest:onboardingAgendaDigest(commitArgs.p_agenda),
   receiptId:requestId,operationReceiptId:requestId,operationRevision:1,nextAction:getAgendaAction(commitArgs.p_agenda),state:'reviewing',replayed:false},error:null});
  await flush();
  const late=sock.sent.slice(sentAtTerminal);
  expect(control.ledger.providerUsageEvidence.terminal).toBe(true);
  expect(control.ledger.usage.textIn).toBe(1);
  expect(h.rpcs.filter(x=>x.name==='commit_website_interview_native_turn')).toHaveLength(1);
  expect(control.ledger.status).toBe('ended');
  expect(late.filter(x=>['response.create','session.update','conversation.item.create'].includes(x.type))).toHaveLength(0);
 }finally{h.restore();}
});
