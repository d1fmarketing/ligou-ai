import {expect,test} from 'bun:test';
import {createLiveCodexDelegate} from '../src/onboarding-live-codex.ts';

const scope={tenantId:'tenant-a',interviewId:'interview-a',callId:'call-a',providerSessionId:'live-a'};
const grant={accessToken:'fixture-token',chatgptAccountId:'fixture-account'};
const context={scope,revision:1,fragments:[{eventId:'e1',speaker:'owner',text:'Só emergências.',startMs:10,endMs:20}],taskState:{currentItemId:'sunday'}};
const schema={type:'object',additionalProperties:false,properties:{kind:{enum:['ask','propose','stop']}},required:['kind']};

function fixture(){
 const notifications=new Set<(m:string,p:any)=>void>();let requestHandler:((m:string,p:any)=>Promise<any>)|undefined;
 const sent:{method:string;params:any}[]=[];let starts=0;
 const emit=(method:string,params:any)=>{for(const fn of notifications)fn(method,params);};
 const connection={
  request:async(method:string,params:any)=>{sent.push({method,params});
   if(method==='account/login/start')return{type:'chatgptAuthTokens'};
   if(method==='thread/start')return{thread:{id:'codex-thread-a'}};
   if(method==='turn/start'){starts++;return{turn:{id:`turn-${starts}`}};}
   return{};
  },
  notify:(method:string,params:any)=>sent.push({method,params}),
  subscribe:(fn:(m:string,p:any)=>void)=>{notifications.add(fn);return()=>{notifications.delete(fn);};},
  handleRequests:(fn:(m:string,p:any)=>Promise<any>)=>{requestHandler=fn;},
 };
 const delegate=createLiveCodexDelegate({scope,connection,credentials:async()=>grant,instructions:'Use apenas o contexto fornecido.',outputSchema:schema});
 return{delegate,connection,sent,emit,serverRequest:(method:string,params:any)=>requestHandler!(method,params),listenerCount:()=>notifications.size};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('uses subscription auth through supported stdio protocol and gives the backend no environment',async()=>{
 const f=fixture();await f.delegate.start();
 expect(f.sent.map(x=>x.method)).toEqual(['initialize','initialized','account/login/start','thread/start']);
 expect(f.sent[0].params.capabilities.experimentalApi).toBe(true);
 expect(f.sent[2].params).toEqual({type:'chatgptAuthTokens',...grant});
 const p=f.sent[3].params;expect(p).toMatchObject({model:'gpt-6-astra',environments:[],ephemeral:true,dynamicTools:[],selectedCapabilityRoots:[],allowProviderModelFallback:false,approvalPolicy:'never'});
 expect(p.config['features.shell_tool']).toBe(false);expect(p.config['features.apps']).toBe(false);
 expect(p.config.web_search).toBe('disabled');expect(p.config['features.multi_agent']).toBe(false);
});

test('returns only completed final structured output, never commentary or private reasoning',async()=>{
 const f=fixture();await f.delegate.start();const work=f.delegate.run(context);await tick();
 f.emit('item/completed',{threadId:'codex-thread-a',turnId:'turn-1',item:{type:'reasoning',text:'private reasoning'}});
 f.emit('item/completed',{threadId:'codex-thread-a',turnId:'turn-1',item:{type:'agentMessage',phase:'commentary',text:'I will save that'}});
 f.emit('item/completed',{threadId:'other-tenant-thread',turnId:'turn-1',item:{type:'agentMessage',phase:'final_answer',text:'{"kind":"stop"}'}});
 f.emit('item/completed',{threadId:'codex-thread-a',turnId:'turn-1',item:{type:'agentMessage',phase:'final_answer',text:'{"kind":"propose"}'}});
 f.emit('turn/completed',{threadId:'codex-thread-a',turn:{id:'turn-1',status:'completed'}});
 expect(await work).toEqual({decision:{kind:'propose'},threadId:'codex-thread-a',turnId:'turn-1',billingBasis:'chatgpt_subscription'});
 expect(f.listenerCount()).toBe(0);
});

test('different customer context is rejected before creating a backend turn',async()=>{
 const f=fixture();await f.delegate.start();
 await expect(f.delegate.run({...context,scope:{...scope,tenantId:'other'}})).rejects.toThrow('live_backend_scope_mismatch');
 expect(f.sent.some(x=>x.method==='turn/start')).toBe(false);
});

test('cannot overlap two backend turns on one interpreter',async()=>{
 const f=fixture();await f.delegate.start();const first=f.delegate.run(context);await tick();
 await expect(f.delegate.run(context)).rejects.toThrow('live_backend_busy');
 f.emit('turn/completed',{threadId:'codex-thread-a',turn:{id:'turn-1',status:'failed'}});
 await expect(first).rejects.toThrow('live_backend_failed');
});

test('failed or interrupted turn never becomes an accepted result',async()=>{
 for(const status of ['failed','interrupted']){
  const f=fixture();await f.delegate.start();const work=f.delegate.run(context);await tick();
  f.emit('item/completed',{threadId:'codex-thread-a',turnId:'turn-1',item:{type:'agentMessage',text:'{"kind":"propose"}'}});
  f.emit('turn/completed',{threadId:'codex-thread-a',turn:{id:'turn-1',status}});
  await expect(work).rejects.toThrow('live_backend_'+status);
 }
});

test('fast provider completion is not lost while awaiting turn/start response',async()=>{
 const f=fixture();const request=f.connection.request;
 f.connection.request=async(method,params)=>{const result=await request(method,params);
  if(method==='turn/start'){
   f.emit('item/completed',{threadId:'codex-thread-a',turnId:result.turn.id,item:{type:'agentMessage',text:'{"kind":"ask"}'}});
   f.emit('turn/completed',{threadId:'codex-thread-a',turn:{id:result.turn.id,status:'completed'}});
  }return result;
 };
 await f.delegate.start();expect((await f.delegate.run(context)).decision).toEqual({kind:'ask'});
});

test('credential refresh remains bound to the original subscription account',async()=>{
 const f=fixture();await f.delegate.start();
 expect(await f.serverRequest('account/chatgptAuthTokens/refresh',{previousAccountId:grant.chatgptAccountId})).toEqual(grant);
 await expect(f.serverRequest('account/chatgptAuthTokens/refresh',{previousAccountId:'other'})).rejects.toThrow('live_backend_account_mismatch');
 await expect(f.serverRequest('item/tool/call',{})).rejects.toThrow('live_backend_request_not_allowed');
});

test('explicit cancellation interrupts backend work and does not return its stale final result',async()=>{
 const f=fixture();await f.delegate.start();const abort=new AbortController();const work=f.delegate.run(context,abort.signal);await tick();abort.abort();
 await expect(work).rejects.toThrow('live_backend_cancelled');
 expect(f.sent.filter(x=>x.method==='turn/interrupt')).toEqual([{method:'turn/interrupt',params:{threadId:'codex-thread-a',turnId:'turn-1'}}]);
 expect(f.listenerCount()).toBe(0);
});
