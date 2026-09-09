import {expect,test} from 'bun:test';
import {attachSideband,liveSessions} from '../src/sideband.ts';
import {makeCapability} from '../src/tools.ts';
import {_setClient} from '../src/rules.ts';
import {createOnboardingAgenda,getAgendaAction} from '../src/onboarding-agenda.ts';
import {onboardingAgendaDigest} from '../src/onboarding-agenda-store.ts';
import {createHash} from 'node:crypto';
import {projectNativeTraceEvent} from '../src/onboarding-native-trace.ts';

const callId='33333333-3333-4333-8333-333333333333',ownerId='11111111-1111-4111-8111-111111111111',tenantId='22222222-2222-4222-8222-222222222222',requestId='44444444-4444-4444-8444-444444444444';
class Socket{
 static instances:Socket[]=[];listeners=new Map<string,Function[]>();sent:any[]=[];closed=false;sendError?:Error;
 constructor(){Socket.instances.push(this);}
 addEventListener(type:string,fn:Function){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
 send(text:string){if(this.sendError)throw this.sendError;this.sent.push(JSON.parse(text));}
 close(){if(!this.closed){this.closed=true;this.emit('close',{code:1000});}}
 emit(type:string,event:any={}){for(const fn of this.listeners.get(type)??[])fn(event);}
 message(value:any){this.emit('message',{data:JSON.stringify(value)});}
}
async function flush(){for(let i=0;i<20;i++)await new Promise<void>(resolve=>setImmediate(resolve));}
function harness(){
 const oldSocket=globalThis.WebSocket,oldInfo=console.info,logs:any[]=[],rpcs:string[]=[];let failLogger=false;
 Socket.instances=[];globalThis.WebSocket=Socket as any;
 console.info=((text:string)=>{logs.push(JSON.parse(text));if(failLogger)throw Error('logger failure');}) as any;
 const agenda=createOnboardingAgenda({interviewId:callId,callId,draftId:requestId,draftHash:'a'.repeat(64),sourceResultId:requestId,sourceResultHash:'b'.repeat(64)},
  [{id:'area',source:'owner_private_requirement',subject:'area',questionPt:'Quais cidades atende?',coverageRefs:[],relatedItemIds:[],blocking:true}]);
 const stored={agenda,revision:0,storeVersion:0,digest:onboardingAgendaDigest(agenda),receiptId:requestId,nextAction:getAgendaAction(agenda),state:'unfinished' as const,replayed:false};
 _setClient({rpc:async(name:string)=>{rpcs.push(name);return{data:name==='begin_provider_termination_attempt'?{should_attempt:false}:null,error:null};},
  from(table:string){const query:any={update(){return query;},select(){return query;},eq(){return query;},maybeSingle:async()=>({data:table==='calls'?{id:callId,tenant_id:tenantId,status:'ended',ended_at:new Date().toISOString(),openai_call_id:'rtc-test',provider_termination_state:'confirmed'}:null,error:null}),then(resolve:Function){return Promise.resolve({data:null,error:null}).then(resolve as any);}};return query;}} as any);
 const cap=makeCapability('foghorn-air',tenantId,callId,30,'onboarding',{authEpoch:1,policyEpoch:1,simulation:true},ownerId);
 const control=attachSideband(cap,'rtc-test','gpt-realtime-2.1-mini',{onboarding:{expectedBusinessName:'Foghorn Air',openingMode:'realtime_native_v1',websiteInterview:{native:true,businessName:'Foghorn Air',prepared:{scope:{ownerId,callId,requestId},stored,projection:{}}}},externalCostUsd:0,fetchImpl:async()=>{throw Error('provider forbidden');}} as any);
 const socket=Socket.instances[0];socket.emit('open');
 return{control,socket,logs,rpcs,stored,failLogger(){failLogger=true;},async restore(){control.cancel();await flush();globalThis.WebSocket=oldSocket;console.info=oldInfo;_setClient(null);liveSessions.delete(callId);}};
}
const controlItem=(prefix:string,id:string)=>({type:'conversation.item.done',event_id:'event_control',item:{id,type:'message',role:'system',status:'completed',content:[{type:'input_text',text:prefix}]}});
const ready=()=>controlItem('ligou.website_native_ready:'+JSON.stringify({callId,interviewId:callId}),'lnr-'+callId.replaceAll('-','').slice(0,28));
const stop=()=>controlItem('ligou.website_stop:'+callId,'lgt-'+callId.replaceAll('-','').slice(0,28));

test('trace observes each wire receipt once and binds issued and automatic responses to their real snapshots',async()=>{
 const h=harness();try{
  await h.control.opened;h.socket.message(ready());await flush();const opening=h.socket.sent.find(e=>e.type==='response.create');
  const created={type:'response.created',event_id:'event_created',response:{id:'resp_issued',status:'in_progress',metadata:opening.response.metadata}};
  h.socket.message(created);await flush();
  expect(h.logs.filter(e=>e.stage==='native.transport'&&e.direction==='inbound'&&e.providerEventId==='event_created')).toHaveLength(1);
  expect(h.logs.find(e=>e.stage==='native.response_bound'&&e.responseId==='resp_issued')).toMatchObject({origin:'issued',nativeRequestId:opening.response.metadata.native_request_id,ownerItemId:null,capturedRevision:0,capturedDigest:h.stored.digest});
  h.socket.message({type:'input_audio_buffer.speech_started',event_id:'event_speech',item_id:'item_owner',audio_start_ms:123});
  h.socket.message({type:'input_audio_buffer.committed',event_id:'event_commit',item_id:'item_owner'});
  h.socket.message({type:'response.created',event_id:'event_auto',response:{id:'resp_auto',status:'in_progress'}});await flush();
  expect(h.logs.find(e=>e.stage==='native.response_bound'&&e.responseId==='resp_auto')).toMatchObject({origin:'automatic',nativeRequestId:null,ownerItemId:'item_owner',capturedRevision:0,capturedDigest:h.stored.digest});
  h.socket.message(created);await flush();
  expect(h.logs.filter(e=>e.stage==='native.transport'&&e.providerEventId==='event_created')).toHaveLength(2);
  expect(h.logs.filter(e=>e.stage==='native.response_bound'&&e.responseId==='resp_issued')).toHaveLength(1);
  const traces=h.logs.filter(e=>e.traceSeq!==undefined);expect(traces.length).toBeGreaterThan(5);
  expect(traces.map(e=>e.traceSeq)).toEqual(traces.map((_,i)=>i+1));
  for(const event of traces){expect(event).toMatchObject({callId,requestId,interviewId:callId,revision:0,sourceDigest:h.stored.digest});expect(Number.isFinite(event.serverMonoMs)).toBe(true);expect(Number.isFinite(Date.parse(event.atUtc))).toBe(true);}
 }finally{await h.restore();}
});

test('trace projects configuration, cancellation and safe tool results without secret or free-text payloads',async()=>{
 const h=harness();try{
  await h.control.opened;const trace=(h.control.ledger.websiteInterviewRuntime as any).traceTransport?.bind(h.control.ledger.websiteInterviewRuntime);
  const secret='CANARY_PRIVATE_PAYLOAD',session={model:'gpt-realtime-2.1-mini',instructions:secret,client_secret:{value:secret},sdp:secret,audio:{input:{transcription:{model:'gpt-live-transcribe',languages:['pt'],prompt:secret},turn_detection:{type:'semantic_vad',eagerness:'medium',create_response:true,interrupt_response:true}},output:{voice:'ash'}}};
  trace?.('inbound',{type:'session.updated',event_id:'event_config',session,Authorization:secret});
  trace?.('inbound',{type:'response.done',event_id:'event_cancelled',response:{id:'resp_cancelled',status:'cancelled',status_details:{type:'cancelled',reason:'turn_detected',error:{code:'server_error',message:secret}},output:[{id:'item_call',type:'function_call',name:'submit_website_interview_proposal',status:'completed',call_id:'call_tool',arguments:secret}]}});
  trace?.('outbound',{type:'conversation.item.create',item:{type:'function_call_output',call_id:'call_tool',output:JSON.stringify({saved:true,replayed:false,savedReceiptId:requestId,savedRevision:1,revision:1,digest:'c'.repeat(64),interpretation:secret,context:{state:'unfinished',instructions:secret}})}},{sendOutcome:'socket_queued'});
  trace?.('inbound',{type:'response.output_audio_transcript.done',event_id:'event_transcript',response_id:'resp_audio',item_id:'item_audio',transcript:secret});
  trace?.('inbound',{type:'response.output_audio.delta',delta:secret});
  const traces=h.logs.filter(e=>e.stage==='native.transport');
  expect(traces.find(e=>e.providerEventId==='event_config')?.sessionConfig).toMatchObject({model:'gpt-realtime-2.1-mini',outputVoice:'ash',instructionsSha256:createHash('sha256').update(secret).digest('hex')});
  expect(traces.find(e=>e.providerEventId==='event_cancelled')).toMatchObject({responseId:'resp_cancelled',status:'cancelled',statusReason:'turn_detected'});
  expect(traces.find(e=>e.direction==='outbound'&&e.toolCallId==='call_tool')?.toolResult).toMatchObject({saved:true,savedReceiptId:requestId,revision:1,state:'unfinished'});
  expect(JSON.stringify(traces)).not.toContain(secret);expect(JSON.stringify(traces)).not.toContain('client_secret');
  expect(traces.some(e=>e.eventType==='response.output_audio.delta')).toBe(false);
 }finally{await h.restore();}
});

test('known credential forms cannot enter ID fields, session identity or error parameters',()=>{
 const canary=['trace','canary'].join('_').repeat(6),jwt=[{alg:'HS256'},{private:canary}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).concat(Buffer.from(canary).toString('base64url')).join('.');
 for(const secret of ['sk-'+canary,'sk_live_'+canary,'ek_'+canary,'sb_secret_'+canary,'Bearer '+canary,'Bearer:'+canary,jwt]){
  const projected=projectNativeTraceEvent('inbound',{type:'response.done',event_id:secret,item_id:secret,call_id:secret,
   error:{event_id:secret,param:secret,message:secret},response:{id:secret,output:[{id:secret,type:'function_call',call_id:secret}]},
   item:{id:secret,type:'function_call_output',call_id:secret,output:JSON.stringify({sourceItemId:secret})}})!;
  expect(projected).toMatchObject({providerEventId:null,clientEventId:null,responseId:null,itemId:null,toolCallId:null,errorParam:null});
  expect(JSON.stringify(projected)).not.toContain(secret);
  const session=projectNativeTraceEvent('inbound',{type:'session.updated',session:{id:secret}})!;
  expect(session.providerSessionId).toBeNull();expect(JSON.stringify(session)).not.toContain(secret);
 }
});

test('valid opaque IDs and bounded error field paths remain available for correlation',()=>{
 for(const value of ['event_EL123','item_owner','call_tool','pending-owner','native-cancel-'+requestId,'opaque_'+('a'.repeat(150))]){
  expect(projectNativeTraceEvent('inbound',{type:'error',event_id:value,error:{event_id:value,param:'session.audio.input.turn_detection'}})).toMatchObject({providerEventId:value,clientEventId:value,errorParam:'session.audio.input.turn_detection'});
 }
 expect(projectNativeTraceEvent('inbound',{type:'session.updated',session:{id:'sess_EL123'}})).toMatchObject({providerSessionId:'sess_EL123'});
 expect(projectNativeTraceEvent('inbound',{type:'error',error:{param:'response.tools[0].parameters',message:'private'}})).toMatchObject({errorParam:'response.tools[0].parameters'});
 for(const param of ['error contains private text','session.'+'x'.repeat(256),'secret=value'])expect(projectNativeTraceEvent('inbound',{type:'error',error:{param}})?.errorParam).toBeNull();
});

test('correlated response-bound diagnostics use the same secret-safe ID projection',async()=>{
 const h=harness();try{
  await h.control.opened;const secret='sk-'+['bound','canary'].join('_').repeat(6);
  h.socket.message({type:'input_audio_buffer.committed',event_id:'event_secret_owner',item_id:secret});
  h.socket.message({type:'response.created',event_id:'event_secret_response',response:{id:secret}});await flush();
  const bound=h.logs.find(e=>e.stage==='native.response_bound');expect(bound).toMatchObject({responseId:null,ownerItemId:null});
  expect(JSON.stringify(h.logs)).not.toContain(secret);
 }finally{await h.restore();}
});

test('throwing diagnostics cannot prevent native sends or immediate audited Stop',async()=>{
 const h=harness();try{
  await h.control.opened;h.failLogger();h.socket.message(ready());await flush();
  expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(1);
  h.socket.message(stop());await flush();
  expect(h.control.ledger.status).toBe('ended');expect(h.socket.closed).toBe(true);
  expect(h.logs.find(e=>e.stage==='native.transport'&&e.direction==='inbound'&&e.controlKind==='website_stop')).toBeDefined();
  expect(h.rpcs).not.toContain('approve_website_interview_summary');
 }finally{await h.restore();}
});

test('send failure is traced as failed and preserves the original thrown exception and frames',async()=>{
 const h=harness();try{
  await h.control.opened;const error=Error('CANARY_SEND_ERROR'),before=h.socket.sent.length;h.socket.sendError=error;
  let caught:unknown;try{await h.control.ledger.websiteInterviewRuntime!.attach();}catch(e){caught=e;}
  expect(caught).toBe(error);expect(h.socket.sent).toHaveLength(before);
  const failed=h.logs.filter(e=>e.stage==='native.transport'&&e.sendOutcome==='send_failed');expect(failed).toHaveLength(1);
  expect(JSON.stringify(failed)).not.toContain(error.message);
 }finally{await h.restore();}
});
