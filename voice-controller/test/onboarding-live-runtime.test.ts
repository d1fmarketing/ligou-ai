import {afterEach,describe,expect,test} from 'bun:test';
process.env.SUPABASE_URL??='http://127.0.0.1:1';process.env.SUPABASE_SECRET_KEY??='synthetic-service';process.env.SUPABASE_PUBLISHABLE_KEY??='synthetic-public';
const {startManagedBrowserSession,recoverManagedLiveCancellation,managedLiveSessions,setManagedLiveDiagnosticObserver}=await import('../src/onboarding-live-runtime.ts');
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
 send(text:string){const event=JSON.parse(text);this.sent.push(event);if(event.type==='session.close'&&this.autoClose)queueMicrotask(()=>this.receive({type:'session.closed',event_id:'evt_closed',session:{id:sessionId,model:'gpt-live-1',expires_at:expiresAt},reason:'close_requested',usage:{seconds:this.finalSeconds}}));}
 close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
}
const fixtures:any[]=[];
function fixture(options:any={}){
 const order:string[]=[],calls:any[]=[],terminations:any[]=[],settlements:any[]=[],events:any[]=[],executions:any[]=[],sockets:FakeSocket[]=[];
 const rows=new Map<string,any>();let cleanup:any,creationCalls=0;const business={voiceInstructions:'Converse naturalmente.',backendInstructions:'Use operações autorizadas.',tools:[],
  bindSession:(id:string)=>order.push(`bind:${id}`),observe:(event:any)=>events.push(event),execute:async(name:string,args:any,context:any)=>{executions.push({name,args,context});return options.execute?options.execute(name,args,context):{saved:true};}};
 const client={from(table:string){let operation='select',payload:any,filters:any[]=[];const builder:any={
  insert(value:any){operation='insert';payload=value;return builder;},update(value:any){operation='update';payload=value;return builder;},select(){return builder;},eq(k:string,v:any){filters.push([k,v]);return builder;},
  single(){return run();},maybeSingle(){return run();},then(yes:any,no:any){return run().then(yes,no);}};
  async function run(){
   if(table==='calls'){
    if(operation==='insert'){order.push('insert');rows.set(payload.id,{...payload});calls.push(payload);return{data:{id:payload.id},error:null};}
    const row=rows.get(filters.find(([k])=>k==='id')?.[1]??ids.callId);
    if(operation==='update'){if(payload.openai_call_id)order.push('identity');if(options.holdUsage&&payload.cost_estimate_usd!==undefined)return new Promise(()=>{});if(options.dropMarker&&payload.provider_termination_state==='unknown')return{data:null,error:null};if(row&&filters.every(([k,v])=>row[k]===v)){Object.assign(row,payload);return{data:row,error:null};}return{data:null,error:null};}
    return{data:row,error:null};
   }
   if(table==='browser_session_requests')return{data:{id:ids.requestId,user_id:ids.userId,tenant_id:ids.tenantId,onboarding_protocol_version:6,opening_mode_requested:'live_managed_v1'},error:null};
   return{data:null,error:null};
  }return builder;
 },async rpc(name:string,args:any){expect(name).toBe('record_website_live_termination');terminations.push(args);if(options.holdTermination)return new Promise(()=>{});const row=rows.get(args.p_call);if(row)Object.assign(row,{status:args.p_outcome==='startup_error'?'error':args.p_outcome,ended_at:new Date().toISOString(),provider_termination_state:args.p_final_event?'confirmed':['not_started','rejected'].includes(args.p_usage.creationState)?'not_required':'unknown',provider_usage_details:args.p_usage});return{data:{recorded:true},error:null};}};
 const deps:any={client,apiKey:'synthetic-openai-key',openTimeoutMs:10,closeTimeoutMs:5,cleanupTimeoutMs:5,
  resolveTenant:async()=>{order.push('resolve');if(options.tenantWait)await options.tenantWait;return{tenant:{id:ids.tenantId,name:'Fixture Company'},rules:[]};},
  reserve:async()=>{order.push('reserve');if(options.reserveWait)await options.reserveWait;return'reservation-id';},
  prepare:async()=>{order.push('prepare');return{scope:{ownerId:ids.userId,callId:ids.callId,requestId:ids.requestId},stored:{agenda:{binding:{interviewId:ids.callId}},revision:7,digest:'a'.repeat(64)}};},
  createSession:async(input:any,dependencies:any)=>{creationCalls++;order.push('create');expect(input.responses).toMatchObject({model:'gpt-5.6-terra',reasoning:{effort:'low'}});return options.create?options.create(input,dependencies):{sessionId,sdp:'provider-answer',expiresAt};},
  businessFactory:()=>business,
  connect:(url:string,key:string)=>{order.push('connect');expect(url).toBe(`wss://api.openai.com/v1/live/sessions/${sessionId}/attach?graceful_close=true`);expect(key).toBe('synthetic-openai-key');const socket=new FakeSocket();sockets.push(socket);queueMicrotask(()=>options.socketFailure?socket.emit('error'):socket.open());return socket;},
  finalize:async(args:any)=>{settlements.push(args);if(options.holdSettlement)return new Promise(()=>{});return true;}};
 const args={...ids,sdpOffer:'v=0\r\naudio-offer',registerCleanup:(value:any)=>{order.push('register');cleanup=value;options.onRegister?.(value);}};
 const f={args,deps,order,calls,terminations,settlements,events,executions,sockets,rows,business,get cleanup(){return cleanup;},get creationCalls(){return creationCalls;}};fixtures.push(f);return f;
}
afterEach(async()=>{for(const f of fixtures.splice(0))await f.cleanup?.cancel('test_cleanup').catch(()=>{});setManagedLiveDiagnosticObserver(null);});

describe('managed browser Live runtime',()=>{
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
