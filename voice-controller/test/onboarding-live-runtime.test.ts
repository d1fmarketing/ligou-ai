import {afterEach,describe,expect,test} from 'bun:test';
process.env.SUPABASE_URL??='http://127.0.0.1:1';process.env.SUPABASE_SECRET_KEY??='synthetic-service';process.env.SUPABASE_PUBLISHABLE_KEY??='synthetic-public';
const {startManagedBrowserSession,recoverManagedLiveCancellation,managedLiveSessions,setManagedLiveDiagnosticObserver,LIVE_GREETING_PT}=await import('../src/onboarding-live-runtime.ts');
const {LiveCreationError}=await import('../src/onboarding-live-protocol.ts');
const ids={userId:'10000000-0000-4000-8000-000000000001',tenantId:'10000000-0000-4000-8000-000000000002',callId:'10000000-0000-4000-8000-000000000003',requestId:'10000000-0000-4000-8000-000000000004'};
const sessionId='live_genuine_fixture',expiresAt=1_900_000_000;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred(){let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};}
class FakeSocket{
 readyState=0;listeners=new Map<string,((event:any)=>void)[]>();sent:any[]=[];finalSeconds=20;autoClose=true;
 addEventListener(type:string,handler:(event:any)=>void){this.listeners.set(type,[...(this.listeners.get(type)??[]),handler]);}
 emit(type:string,event:any={}){for(const handler of this.listeners.get(type)??[])handler(event);}
 open(){this.readyState=1;this.emit('open');}
 receive(event:any){this.emit('message',{data:JSON.stringify(event)});}
 failTypes=new Set<string>();
 send(text:string){const event=JSON.parse(text);if(this.failTypes.has(event.type))throw Error('socket details');this.sent.push(event);if(event.type==='session.close'&&this.autoClose)queueMicrotask(()=>this.receive({type:'session.closed',event_id:'evt_closed',session:{id:sessionId,model:'gpt-live-1',expires_at:expiresAt},reason:'close_requested',usage:{seconds:this.finalSeconds}}));}
 close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
}
const fixtures:any[]=[];
async function until(condition:()=>boolean,ticks=200){for(let i=0;i<ticks;i++){if(condition())return;await tick();}throw Error('condition not reached');}
const endCall=(socket:FakeSocket)=>{socket.receive({type:'response.event',delegation_id:'delegation-end',event:{type:'response.created',response:{id:'resp-end',status:'in_progress',model:'gpt-6-astra'}}});
 socket.receive({type:'response.event',delegation_id:'delegation-end',event:{type:'response.output_item.done',item:{type:'function_call',call_id:'tool-end',name:'end_call',arguments:'{}',status:'completed'}}});};
const completeEnd=(socket:FakeSocket)=>socket.receive({type:'response.event',delegation_id:'delegation-end',event:{type:'response.completed',response:{id:'resp-end',status:'completed',model:'gpt-6-astra',usage:{input_tokens:10,output_tokens:2,total_tokens:12,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}}}});
const byeCreated=(socket:FakeSocket)=>socket.receive({type:'response.event',delegation_id:'delegation-end',event:{type:'response.created',response:{id:'resp-bye',status:'in_progress',model:'gpt-6-astra'}}});
const byeCompleted=(socket:FakeSocket)=>socket.receive({type:'response.event',delegation_id:'delegation-end',event:{type:'response.completed',response:{id:'resp-bye',status:'completed',model:'gpt-6-astra',usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}}}});
const lateClosed={type:'session.closed',event_id:'evt_provider_late',session:{id:sessionId,model:'gpt-live-1',expires_at:expiresAt},reason:'close_requested',usage:{seconds:20}};
function fixture(options:any={}){let readIndex=0;
 const order:string[]=[],calls:any[]=[],terminations:any[]=[],settlements:any[]=[],events:any[]=[],executions:any[]=[],sockets:FakeSocket[]=[];
 const rows=new Map<string,any>();let cleanup:any,creationCalls=0;const business:any={voiceInstructions:'Converse naturalmente.',backendInstructions:'Use operações autorizadas.',tools:[],onStop:undefined,
  bindSession:(id:string)=>order.push(`bind:${id}`),observe:(event:any)=>events.push(event),execute:async(name:string,args:any,context:any)=>{executions.push({name,args,context});
   if(name==='end_call'){void business.onStop('owner_requested_stop');return{ok:true,stopRequested:true,onboardingCompleted:false};}
   return options.execute?options.execute(name,args,context):{saved:true};}};
 const client={from(table:string){let operation='select',payload:any,filters:any[]=[];const builder:any={
  insert(value:any){operation='insert';payload=value;return builder;},update(value:any){operation='update';payload=value;return builder;},select(){return builder;},eq(k:string,v:any){filters.push([k,v]);return builder;},
  single(){return run();},maybeSingle(){return run();},then(yes:any,no:any){return run().then(yes,no);}};
  async function run(){
   if(table==='calls'){
    if(operation==='insert'){order.push('insert');rows.set(payload.id,{...payload});calls.push(payload);return{data:{id:payload.id},error:null};}
    const row=rows.get(filters.find(([k])=>k==='id')?.[1]??ids.callId);
    if(operation==='update'){if(payload.openai_call_id)order.push('identity');if(options.holdUsage&&payload.cost_estimate_usd!==undefined)return new Promise(()=>{});if(options.dropMarker&&payload.provider_termination_state==='unknown')return{data:null,error:null};if(row&&filters.every(([k,v])=>row[k]===v)){Object.assign(row,payload);return{data:row,error:null};}return{data:null,error:null};}
    if(options.readHook)await options.readHook(readIndex++);
    return{data:row,error:null};
   }
   if(table==='browser_session_requests')return{data:{id:ids.requestId,user_id:ids.userId,tenant_id:ids.tenantId,onboarding_protocol_version:6,opening_mode_requested:'live_managed_v1'},error:null};
   return{data:null,error:null};
  }return builder;
 },async rpc(name:string,args:any){expect(name).toBe('record_website_live_termination');const index=terminations.length;terminations.push(args);if(options.holdTermination)return new Promise(()=>{});
  if(options.beforeTerminationResolve)await options.beforeTerminationResolve(args,index);
  const row=rows.get(args.p_call);const finalized=Boolean(args.p_final_event)&&!options.neverFinalize;
  if(row)Object.assign(row,{status:args.p_outcome==='startup_error'?'error':args.p_outcome,ended_at:new Date().toISOString(),provider_termination_state:finalized?'confirmed':['not_started','rejected'].includes(args.p_usage.creationState)?'not_required':'unknown',provider_usage_details:args.p_usage});
  return{data:{recorded:true,providerFinalized:finalized},error:null};}};
 const deps:any={client,apiKey:'synthetic-openai-key',openTimeoutMs:10,closeTimeoutMs:5,cleanupTimeoutMs:5,closeDrainQuietMs:20,closeDrainCapMs:150,
  resolveTenant:async()=>{order.push('resolve');if(options.tenantWait)await options.tenantWait;return{tenant:{id:ids.tenantId,name:'Fixture Company'},rules:[]};},
  reserve:async()=>{order.push('reserve');if(options.reserveWait)await options.reserveWait;return'reservation-id';},
  prepare:async()=>{order.push('prepare');return{scope:{ownerId:ids.userId,callId:ids.callId,requestId:ids.requestId},stored:{agenda:{binding:{interviewId:ids.callId}},revision:7,digest:'a'.repeat(64)}};},
  createSession:async(input:any,dependencies:any)=>{creationCalls++;order.push('create');expect(input.voice).toBe('tempo');expect(input.responses).toMatchObject({model:'gpt-6-astra',reasoning:{effort:'low'}});return options.create?options.create(input,dependencies):{sessionId,sdp:'provider-answer',expiresAt};},
  businessFactory:(factoryOptions:any)=>{business.onStop=factoryOptions.onStop;return business;},
  connect:(url:string,key:string)=>{order.push('connect');expect(url).toBe(`wss://api.openai.com/v1/live/sessions/${sessionId}/attach?graceful_close=true`);expect(key).toBe('synthetic-openai-key');const socket=new FakeSocket();if(options.socketAutoClose===false)socket.autoClose=false;sockets.push(socket);queueMicrotask(()=>{if(options.socketFailure){socket.emit('error');return;}socket.open();if(!options.deferStarted)socket.receive({type:'session.started',event_id:'event_started',session:{id:sessionId,model:'gpt-live-1',expires_at:expiresAt}});});return socket;},
  finalize:async(args:any)=>{const index=settlements.length;settlements.push(args);if(options.holdSettlement)return new Promise(()=>{});if(options.finalizeHook)await options.finalizeHook(args,index);return true;}};
 const args={...ids,sdpOffer:'v=0\r\naudio-offer',registerCleanup:(value:any)=>{order.push('register');cleanup=value;options.onRegister?.(value);}};
 const f={args,deps,order,calls,terminations,settlements,events,executions,sockets,rows,business,get cleanup(){return cleanup;},get creationCalls(){return creationCalls;}};fixtures.push(f);return f;
}
afterEach(async()=>{for(const f of fixtures.splice(0))await f.cleanup?.cancel('test_cleanup').catch(()=>{});setManagedLiveDiagnosticObserver(null);});

describe('managed browser Live runtime',()=>{
 test('SDP returns before session.started; the greeting is one instructions append whose ACK triggers the commentary kick',async()=>{
  const f=fixture({deferStarted:true});const result=await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  expect(result.sdp).toBe('provider-answer');expect(f.cleanup.startupComplete).toBe(true);expect(socket.sent).toEqual([]);
  socket.receive({type:'session.started',session:{id:'another-session',model:'gpt-live-1'}});expect(socket.sent).toEqual([]);
  socket.receive({type:'session.started',session:{id:sessionId,model:'gpt-realtime-2.1'}});expect(socket.sent).toEqual([]);
  const started={type:'session.started',event_id:'actual_started',session:{id:sessionId,model:'gpt-live-1'}};socket.receive(started);socket.receive(started);
  expect(socket.sent.map(e=>e.type)).toEqual(['session.instructions.append']);
  expect(socket.sent[0]).toMatchObject({type:'session.instructions.append',delegation_id:null});expect(socket.sent[0].content).toContain(LIVE_GREETING_PT);
  expect(LIVE_GREETING_PT).toMatch(/português/);expect(LIVE_GREETING_PT).toMatch(/sem esperar/);expect(LIVE_GREETING_PT).toMatch(/escute/);
  // Smoke A (2026-09-12, call 6c83b5f0): instructions alone left the model silent for 113 s; the ACK-triggered commentary is the kick that produces speech.
  const ack={type:'session.instructions.appended',client_event_id:socket.sent[0].event_id,start_ms:0,end_ms:100};socket.receive(ack);socket.receive(ack);
  expect(socket.sent.map(e=>e.type)).toEqual(['session.instructions.append','session.commentary.append']);expect(socket.sent[1]).toMatchObject({delegation_id:null});expect(f.executions).toEqual([]);
 });
 test('Stop before the real start event never resurrects the greeting',async()=>{
  const f=fixture({deferStarted:true});await startManagedBrowserSession(f.args,f.deps);const stopping=f.cleanup.cancel('owner_requested_stop');
  f.sockets[0].receive({type:'session.started',session:{id:sessionId,model:'gpt-live-1'}});await stopping;
  expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.close']);
 });
 test('registers cleanup first, prepares existing source, creates once, attaches and returns protocol6',async()=>{
  const f=fixture();const result=await startManagedBrowserSession(f.args,f.deps);
  expect(f.order.slice(0,6)).toEqual(['register','resolve','insert','reserve','prepare','create']);expect(f.creationCalls).toBe(1);
  expect(result).toMatchObject({sdp:'provider-answer',call_id:ids.callId,model:'gpt-live-1',fell_back:false,max_minutes:55,opening_mode_applied:'live_managed_v1',
   opening_payload:{version:6,live:{sessionId,callId:ids.callId,interviewId:ids.callId,revision:7,sourceDigest:'a'.repeat(64)}}});
  expect(f.rows.get(ids.callId).provider_usage_details.expiresAt).toBe(expiresAt);
  expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.instructions.append']);expect(managedLiveSessions.has(ids.callId)).toBe(true);
  await f.cleanup.cancel('owner_requested_stop');expect(managedLiveSessions.has(ids.callId)).toBe(false);expect(f.terminations[0].p_final_event).toMatchObject({sessionId,eventId:'evt_closed',seconds:20});
 });
 test('Stop during cleanup registration prevents even tenant lookup and paid creation',async()=>{
  const f=fixture({onRegister:(control:any)=>{void control.cancel('owner_requested_stop');}});
  await expect(startManagedBrowserSession(f.args,f.deps)).rejects.toThrow('browser_request_cancelled');
  expect(f.order).toEqual(['register']);expect(f.creationCalls).toBe(0);expect(f.terminations).toEqual([]);
 });
 test('Stop while reservation is in flight settles it without starting a provider session',async()=>{
  const reservation=deferred();const f=fixture({reserveWait:reservation.promise});const start=startManagedBrowserSession(f.args,f.deps);await tick();
  const stop=f.cleanup.cancel('owner_requested_stop');reservation.resolve();await expect(start).rejects.toThrow('browser_request_cancelled');await stop;
  expect(f.creationCalls).toBe(0);expect(f.terminations).toHaveLength(1);expect(f.settlements[0]).toMatchObject({actualCostUsd:0,usageResolved:true,outcome:'startup_error'});
 });
 test('malformed successful creation retains and closes its real session instead of losing it',async()=>{
  const f=fixture({create:()=>{throw new LiveCreationError('unknown',201,sessionId);}});
  await expect(startManagedBrowserSession(f.args,f.deps)).rejects.toThrow('live_creation_outcome_unknown');
  expect(f.creationCalls).toBe(1);expect(f.sockets).toHaveLength(1);expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.close']);
  expect(f.terminations[0]).toMatchObject({p_session:sessionId,p_usage:{creationState:'created'},p_final_event:{sessionId}});
 });
 test('unknown creation without a session handle is neither retried nor called zero-cost resolved',async()=>{
  const f=fixture({create:()=>{throw new LiveCreationError('unknown');}});await expect(startManagedBrowserSession(f.args,f.deps)).rejects.toThrow();
  expect(f.creationCalls).toBe(1);expect(f.sockets).toHaveLength(0);expect(f.terminations[0]).toMatchObject({p_session:null,p_final_event:null,p_usage:{creationState:'unknown'}});expect(f.settlements[0].usageResolved).toBe(false);
 });
 test('a missing durable provider-create marker prevents the paid call',async()=>{
  const f=fixture({dropMarker:true});await expect(startManagedBrowserSession(f.args,f.deps)).rejects.toThrow('live_provider_marker_failed');
  expect(f.creationCalls).toBe(0);expect(f.sockets).toHaveLength(0);
 });
 test('Stop during POST closes a late returned session without another create or greeting',async()=>{
  const creation=deferred();const f=fixture({create:()=>creation.promise});const start=startManagedBrowserSession(f.args,f.deps);await tick();
  const stop=f.cleanup.cancel('owner_requested_stop');creation.resolve({sessionId,sdp:'late-answer',expiresAt});
  await expect(start).rejects.toThrow('browser_request_cancelled');await stop;
  expect(f.creationCalls).toBe(1);expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.close']);expect(f.terminations).toHaveLength(1);
 });
 test('a failed sideband attachment does not fabricate provider finalization',async()=>{
  const f=fixture({socketFailure:true});await expect(startManagedBrowserSession(f.args,f.deps)).rejects.toThrow('live_sideband_open_failed');
  expect(f.terminations[0]).toMatchObject({p_session:sessionId,p_final_event:null,p_usage:{creationState:'created'}});expect(f.settlements[0].usageResolved).toBe(false);
 });
 test('Stop suppresses a pending business result while keeping actual close and usage events',async()=>{
  const work=deferred();const f=fixture({execute:()=>work.promise});await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  socket.receive({type:'response.event',delegation_id:'delegation-real',event:{type:'response.created',response:{id:'resp-real',model:'gpt-5.6-terra',status:'in_progress'}}});
  socket.receive({type:'response.event',delegation_id:'delegation-real',event:{type:'response.output_item.done',item:{type:'function_call',call_id:'tool-real',name:'save_decision',arguments:'{}',status:'completed'}}});await tick();
  expect(f.executions).toHaveLength(1);await f.cleanup.cancel('owner_requested_stop');work.resolve({saved:true});await tick();
  expect(socket.sent.map(e=>e.type)).toEqual(['session.instructions.append','session.close']);expect(f.settlements[0].usageResolved).toBe(false);expect(f.events.some(e=>e.type==='session.closed')).toBe(true);
 });
 test('counts cumulative voice and each response once, then settles without a Realtime provider argument',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  for(const seconds of [12,15,13])socket.receive({type:'session.usage.updated',usage:{seconds}});
  socket.receive({type:'response.event',delegation_id:'delegation-real',event:{type:'response.created',response:{id:'resp-real',status:'in_progress',model:'gpt-5.6-terra'}}});
  const completion={type:'response.event',delegation_id:'delegation-real',event:{type:'response.completed',response:{id:'resp-real',status:'completed',model:'gpt-5.6-terra',usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}}}};
  socket.receive(completion);socket.receive(completion);await f.cleanup.cancel('owner_requested_stop');
  expect(f.settlements).toHaveLength(1);expect(f.settlements[0]).toMatchObject({usageResolved:true,minutes:20/60,actualCostUsd:0.01698667});expect(f.settlements[0]).not.toHaveProperty('provider');
 });
 test('the existing hard budget stops the call from observed managed backend costs',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);f.sockets[0].receive({type:'response.event',delegation_id:'delegation-real',event:{type:'response.created',response:{id:'resp-budget',status:'in_progress',model:'gpt-5.6-terra'}}});
  f.sockets[0].receive({type:'response.event',delegation_id:'delegation-real',event:{type:'response.completed',response:{id:'resp-budget',status:'completed',model:'gpt-5.6-terra',usage:{input_tokens:0,output_tokens:700000,total_tokens:700000,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}}}});
  await tick();await f.cleanup.cancel('test_cleanup');expect(f.terminations[0]).toMatchObject({p_reason:'budget_limit',p_outcome:'killed_budget'});expect(f.settlements[0].actualCostUsd).toBeGreaterThan(7.5);
 });
 test('diagnostic capture is opt-in and receives actual transport events without changing commands',async()=>{
  const captured:any[]=[];setManagedLiveDiagnosticObserver(record=>captured.push(record));const f=fixture();await startManagedBrowserSession(f.args,f.deps);
  f.sockets[0].receive({type:'session.input_audio.delta',delta:'fixture-only',start_ms:0,end_ms:20});await f.cleanup.cancel('owner_requested_stop');
  expect(captured.some(row=>row.event.type==='session.input_audio.delta')).toBe(true);expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.instructions.append','session.close']);
 });
 test('recovery attaches to the persisted Live ID and observes a genuine close without a new creation',async()=>{
  const f=fixture();f.rows.set(ids.callId,{id:ids.callId,tenant_id:ids.tenantId,model:'gpt-live-1',channel:'browser',session_type:'onboarding',openai_call_id:sessionId,provider_termination_state:'unknown',provider_usage_details:{voiceSeconds:12,expiresAt,responses:[]}});
  expect(await recoverManagedLiveCancellation(ids.callId,'owner_requested_stop',f.deps)).toBe(true);expect(f.creationCalls).toBe(0);
  expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.close']);expect(f.terminations[0].p_final_event.eventId).toBe('evt_closed');
 });
 test('recovery persists a session.closed that arrives during its termination write',async()=>{
  const f=fixture({socketAutoClose:false,beforeTerminationResolve:(_args:any,index:number)=>{if(index===0)f.sockets[0].receive(lateClosed);}});
  f.rows.set(ids.callId,{id:ids.callId,tenant_id:ids.tenantId,model:'gpt-live-1',channel:'browser',session_type:'onboarding',openai_call_id:sessionId,provider_termination_state:'unknown',provider_usage_details:{voiceSeconds:12,expiresAt,responses:[]}});
  expect(await recoverManagedLiveCancellation(ids.callId,'owner_requested_stop',f.deps)).toBe(true);
  expect(f.terminations).toHaveLength(2);expect(f.terminations[0].p_final_event).toBe(null);expect(f.terminations[1].p_final_event).toMatchObject({eventId:'evt_provider_late'});
  expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');expect(f.settlements.at(-1).usageResolved).toBe(true);expect(f.sockets[0].readyState).toBe(3);
 });
 test('recovery persists a session.closed that arrives during its settlement',async()=>{
  const f=fixture({socketAutoClose:false,finalizeHook:(_args:any,index:number)=>{if(index===0)f.sockets[0].receive(lateClosed);}});
  f.rows.set(ids.callId,{id:ids.callId,tenant_id:ids.tenantId,model:'gpt-live-1',channel:'browser',session_type:'onboarding',openai_call_id:sessionId,provider_termination_state:'unknown',provider_usage_details:{voiceSeconds:12,expiresAt,responses:[]}});
  expect(await recoverManagedLiveCancellation(ids.callId,'owner_requested_stop',f.deps)).toBe(true);
  expect(f.terminations).toHaveLength(2);expect(f.settlements).toHaveLength(2);expect(f.settlements[1].usageResolved).toBe(true);expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');
 });
 test('recovery persists a session.closed that arrives during its final readback',async()=>{
  const f=fixture({socketAutoClose:false,readHook:(index:number)=>{if(index===1)f.sockets[0].receive(lateClosed);}});
  f.rows.set(ids.callId,{id:ids.callId,tenant_id:ids.tenantId,model:'gpt-live-1',channel:'browser',session_type:'onboarding',openai_call_id:sessionId,provider_termination_state:'unknown',provider_usage_details:{voiceSeconds:12,expiresAt,responses:[]}});
  expect(await recoverManagedLiveCancellation(ids.callId,'owner_requested_stop',f.deps)).toBe(true);
  expect(f.terminations).toHaveLength(2);expect(f.terminations[0].p_final_event).toBe(null);expect(f.terminations[1].p_final_event).toMatchObject({eventId:'evt_provider_late'});
  expect(f.settlements).toHaveLength(2);expect(f.settlements[1].usageResolved).toBe(true);expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');expect(f.sockets[0].readyState).toBe(3);
 });
 test('recovery never handles a stored Realtime call or a missing provider handle',async()=>{
  const f=fixture();for(const [model,openai_call_id]of [['gpt-realtime-2.1','rtc_id'],['gpt-live-1',null]]){
   f.rows.set(ids.callId,{id:ids.callId,tenant_id:ids.tenantId,model,channel:'browser',session_type:'onboarding',openai_call_id,provider_termination_state:'unknown'});
   expect(await recoverManagedLiveCancellation(ids.callId,'owner_requested_stop',f.deps)).toBe(false);
  }expect(f.sockets).toHaveLength(0);expect(f.creationCalls).toBe(0);
 });
 test('in-process recovery returns false when close times out and the database retains unknown termination',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);f.sockets[0].autoClose=false;
  expect(await recoverManagedLiveCancellation(ids.callId,'owner_requested_stop',f.deps)).toBe(false);
  expect(f.terminations[0].p_final_event).toBe(null);expect(f.rows.get(ids.callId).provider_termination_state).toBe('unknown');
 });
 test('genuine session.closed with missing duration still proves closure, never resolved billing',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);
  f.sockets[0].receive({type:'session.closed',event_id:'evt_provider_closed',session:{id:sessionId,model:'gpt-live-1'},reason:'remote_hangup'});await tick();await f.cleanup.cancel('test_cleanup');
  expect(f.terminations[0].p_final_event).toEqual({eventId:'evt_provider_closed',sessionId,reason:'remote_hangup',seconds:null});
  expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');expect(f.settlements[0].usageResolved).toBe(false);
 });
 test('a hanging periodic usage write does not hold finalization or the active-session set',async()=>{
  const f=fixture({holdUsage:true});await startManagedBrowserSession(f.args,f.deps);f.sockets[0].receive({type:'session.usage.updated',usage:{seconds:12}});await tick();
  await f.cleanup.cancel('owner_requested_stop');expect(managedLiveSessions.has(ids.callId)).toBe(false);expect(f.terminations).toHaveLength(1);
  expect(f.terminations[0].p_usage.voiceSeconds).toBe(20);expect(f.sockets[0].readyState).toBe(3);
 });
 test('an unresponsive terminal receipt releases local resources without claiming persistence',async()=>{
  const f=fixture({holdTermination:true});await startManagedBrowserSession(f.args,f.deps);
  await expect(f.cleanup.cancel('owner_requested_stop')).rejects.toThrow('live_termination_receipt_unproven');
  expect(managedLiveSessions.has(ids.callId)).toBe(false);expect(f.sockets[0].readyState).toBe(3);expect(f.settlements).toEqual([]);
 });
 test('unresponsive settlement observation does not retain a closed voice session',async()=>{
  const f=fixture({holdSettlement:true});await startManagedBrowserSession(f.args,f.deps);await f.cleanup.cancel('owner_requested_stop');
  expect(managedLiveSessions.has(ids.callId)).toBe(false);expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');expect(f.settlements).toHaveLength(1);
 });
 test('non-object sideband JSON cannot throw into the session event loop or disable Stop',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);for(const value of [null,[],false,'unexpected'])expect(()=>f.sockets[0].receive(value)).not.toThrow();
  await f.cleanup.cancel('owner_requested_stop');expect(f.terminations[0].p_final_event).not.toBe(null);
 });
});

describe('managed browser Live graceful end_call and late finalization',()=>{
 test('end_call submits its result, waits for the delegated farewell to complete, then closes and confirms',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  endCall(socket);await tick();await tick();
  expect(f.executions.map(e=>e.name)).toEqual(['end_call']);
  expect(socket.sent.map(e=>e.type)).toEqual(['session.instructions.append','response.item.create']);
  expect(JSON.parse(socket.sent[1].item.output)).toMatchObject({ok:true,stopRequested:true});
  completeEnd(socket);await tick();expect(socket.sent.map(e=>e.type)).toEqual(['session.instructions.append','response.item.create','response.create']);
  byeCreated(socket);await tick();expect(socket.sent.at(-1).type).toBe('response.create');
  byeCompleted(socket);await until(()=>f.terminations.length===1);
  expect(socket.sent.at(-1).type).toBe('session.close');expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);
  expect(f.terminations[0].p_final_event).toMatchObject({eventId:'evt_closed'});expect(f.terminations[0].p_usage.close).toMatchObject({delegatedWork:'completed',outcome:'closed',lateFinalPersisted:false});
  expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');expect(f.settlements.at(-1).usageResolved).toBe(true);
 });
 test('the spoken farewell is drained: output transcript deltas defer session.close until quiet',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  endCall(socket);await tick();await tick();completeEnd(socket);await tick();byeCreated(socket);byeCompleted(socket);
  const delta=(i:number)=>({type:'session.output_transcript.delta',event_id:`evt_bye_${i}`,delta:'Até ',start_ms:i*100,end_ms:i*100+100});
  for(let i=0;i<10;i++){socket.receive(delta(i));await new Promise(r=>setTimeout(r,5));expect(socket.sent.some(e=>e.type==='session.close')).toBe(false);}
  await until(()=>f.terminations.length===1);
  expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);
  expect(f.terminations[0].p_usage.close).toMatchObject({delegatedWork:'completed',outcome:'closed',drain:{quietMs:20,capMs:150,endedBy:'quiet'}});
  expect(f.terminations[0].p_usage.close.drain.lastOutputDeltaAt).not.toBe(null);
 });
 test('the drain cap bounds a farewell whose transcript never goes quiet',async()=>{
  const f=fixture();await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  endCall(socket);await tick();await tick();completeEnd(socket);await tick();byeCreated(socket);byeCompleted(socket);
  let i=0;const feeder=setInterval(()=>{if(socket.readyState===1)socket.receive({type:'session.output_transcript.delta',event_id:`evt_loop_${i}`,delta:'x',start_ms:i*100,end_ms:i++*100+100});},5);
  try{await until(()=>f.terminations.length===1,2000);}finally{clearInterval(feeder);}
  expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);expect(f.terminations[0].p_usage.close.drain).toMatchObject({endedBy:'cap'});
 });
 test('a browser cancel during the drain is immediate and closes once',async()=>{
  const f=fixture();f.deps.closeDrainQuietMs=5_000;f.deps.closeDrainCapMs=10_000;await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  endCall(socket);await tick();await tick();completeEnd(socket);await tick();byeCreated(socket);byeCompleted(socket);await tick();
  expect(socket.sent.some(e=>e.type==='session.close')).toBe(false);
  await f.cleanup.cancel('owner_requested_stop');
  expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);expect(f.terminations).toHaveLength(1);expect(f.terminations[0].p_usage.close.drain).toMatchObject({endedBy:'cancel'});
 });
 test('the delegated-work cap bounds the wait for the farewell',async()=>{
  const f=fixture();f.deps.farewellMaxMs=20;await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  endCall(socket);await tick();await tick();completeEnd(socket);await tick();byeCreated(socket);
  await until(()=>f.terminations.length===1);
  expect(socket.sent.at(-1).type).toBe('session.close');expect(f.terminations[0].p_usage.close).toMatchObject({delegatedWork:'capped'});
 });
 test('a browser cancel during the farewell wait is immediate and closes once',async()=>{
  const f=fixture();f.deps.farewellMaxMs=5_000;await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  endCall(socket);await tick();await tick();completeEnd(socket);await tick();
  await f.cleanup.cancel('owner_requested_stop');
  expect(socket.sent.filter(e=>e.type==='session.close')).toHaveLength(1);expect(f.terminations).toHaveLength(1);
 });
 test('a close timeout records unknown termination with no hangup request',async()=>{
  const f=fixture();let fetches=0;f.deps.fetch=async()=>{fetches++;throw Error('never');};await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];socket.autoClose=false;
  endCall(socket);await tick();await tick();completeEnd(socket);await tick();byeCreated(socket);byeCompleted(socket);
  await until(()=>f.terminations.length===1);
  expect(f.terminations[0].p_final_event).toBe(null);expect(f.terminations[0].p_usage.close).toMatchObject({outcome:'finalization_timeout',delegatedWork:'completed'});
  expect(fetches).toBe(0);expect(f.rows.get(ids.callId).provider_termination_state).toBe('unknown');expect(f.settlements.at(-1).usageResolved).toBe(false);
 });
 test('session.closed arriving during the termination write is persisted before the socket closes',async()=>{
  const f=fixture({beforeTerminationResolve:(_args:any,index:number)=>{if(index===0)f.sockets[0].receive(lateClosed);}});
  await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];socket.autoClose=false;
  await f.cleanup.cancel('owner_requested_stop');
  expect(f.terminations).toHaveLength(2);expect(f.terminations[0].p_final_event).toBe(null);expect(f.terminations[1].p_final_event).toMatchObject({eventId:'evt_provider_late'});
  expect(f.terminations[1].p_usage.close.lateFinalPersisted).toBe(true);expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');
  expect(f.settlements.at(-1).usageResolved).toBe(true);
 });
 test('session.closed arriving during settlement is persisted before the socket closes',async()=>{
  const states:number[]=[];
  const f=fixture({finalizeHook:(_args:any,index:number)=>{if(index===0)f.sockets[0].receive(lateClosed);},beforeTerminationResolve:(_args:any,index:number)=>{if(index===1)states.push(f.sockets[0].readyState);}});
  await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];socket.autoClose=false;
  await f.cleanup.cancel('owner_requested_stop');
  expect(f.terminations).toHaveLength(2);expect(f.terminations[1].p_final_event).toMatchObject({eventId:'evt_provider_late'});expect(states).toEqual([1]);
  expect(f.settlements).toHaveLength(2);expect(f.settlements[1].usageResolved).toBe(true);expect(f.rows.get(ids.callId).provider_termination_state).toBe('confirmed');
 });
 test('internal stops never enter the graceful path even with delegated work pending',async()=>{
  const f=fixture();f.deps.farewellMaxMs=5_000;await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];
  socket.receive({type:'response.event',delegation_id:'delegation-real',event:{type:'response.created',response:{id:'resp-real',status:'in_progress',model:'gpt-6-astra'}}});
  await f.cleanup.cancel('test_cleanup');
  expect(socket.sent.at(-1).type).toBe('session.close');expect(f.terminations[0].p_usage.close).toMatchObject({delegatedWork:'not_awaited',outcome:'closed'});
 });
 test('an owner stop before startup completes falls back to cancellation',async()=>{
  const creation=deferred();const f=fixture({create:()=>creation.promise});const start=startManagedBrowserSession(f.args,f.deps);await tick();
  const stopping=f.business.onStop('owner_requested_stop');creation.resolve({sessionId,sdp:'late-answer',expiresAt});
  await expect(start).rejects.toThrow('browser_request_cancelled');await stopping;
  expect(f.terminations).toHaveLength(1);expect(f.sockets[0].sent.map(e=>e.type)).toEqual(['session.close']);
 });
 test('a failed local result send ends the wait without the cap',async()=>{
  const f=fixture();f.deps.farewellMaxMs=5_000;await startManagedBrowserSession(f.args,f.deps);const socket=f.sockets[0];socket.failTypes.add('response.item.create');
  endCall(socket);await until(()=>f.terminations.length===1,50);
  expect(socket.sent.at(-1).type).toBe('session.close');expect(f.terminations[0].p_usage.close.delegatedWork).toBe('completed');
 });
 test('the late-final persistence loop is bounded',async()=>{
  const f=fixture({neverFinalize:true,beforeTerminationResolve:()=>{f.sockets[0].receive({...lateClosed,event_id:`evt_${f.terminations.length}`});}});
  await startManagedBrowserSession(f.args,f.deps);f.sockets[0].autoClose=false;
  await f.cleanup.cancel('owner_requested_stop');expect(f.terminations).toHaveLength(3);
 });
});
