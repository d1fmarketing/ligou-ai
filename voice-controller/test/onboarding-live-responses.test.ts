import {describe,expect,test} from 'bun:test';
import {createLiveResponsesBridge} from '../src/onboarding-live-responses.ts';

const delegationId='item_delegation',responseId='resp_first';
let eventSequence=0;
const envelope=(event:Record<string,unknown>,id:string|null=delegationId)=>({type:'response.event',event_id:`event_${++eventSequence}`,delegation_id:id,event});
const created=(id=responseId,delegation=delegationId)=>envelope({type:'response.created',response:{id,status:'in_progress',output:[]}},delegation);
const done=(callId='call_1',args='{"answer":"domingo fechado"}',name='save_answer',delegation=delegationId)=>envelope({type:'response.output_item.done',output_index:0,item:{type:'function_call',id:`fc_${callId}`,call_id:callId,name,arguments:args,status:'completed'}},delegation);
const completed=(id=responseId,delegation=delegationId)=>envelope({type:'response.completed',response:{id,status:'completed',model:'gpt-5.6-terra',output:[],tools:[],instructions:null,usage:{input_tokens:30,output_tokens:8,total_tokens:38}}},delegation);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve!:(result:unknown)=>void;const promise=new Promise<unknown>(r=>resolve=r);return{promise,resolve};};

function fixture(execute:(name:string,args:Record<string,unknown>,context:any)=>Promise<unknown>=async()=>({saved:true,receiptId:'receipt-1'}),send?:(event:any)=>void){
 const sent:any[]=[],errors:any[]=[],usage:any[]=[];let idle=0;
 const bridge=createLiveResponsesBridge({send:send??(event=>sent.push(event)),execute,onError:error=>errors.push(error),onUsage:value=>usage.push(value),onIdle:()=>{idle++;}});
 return{bridge,sent,errors,usage,idle:()=>idle};
}

describe('managed Live Responses function transport',()=>{
 test('executes the complete function once, retains provider references, and continues after an empty terminal snapshot',async()=>{
  const calls:any[]=[];const f=fixture(async(name,args,context)=>{calls.push({name,args,context});return{saved:true};});
  f.bridge.observe({type:'session.delegation.created',offset_ms:251,delegation:{id:delegationId,target:'responses',response_id:responseId}});
  f.bridge.observe(created());const item=done();f.bridge.observe(item);f.bridge.observe(item);f.bridge.observe(done());await tick();
  expect(calls).toEqual([{name:'save_answer',args:{answer:'domingo fechado'},context:{delegationId,responseId,toolCallId:'call_1',delegationOffsetMs:251}}]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({type:'response.item.create',item:{type:'function_call_output',call_id:'call_1',output:'{"saved":true}'}});
  f.bridge.observe(completed());f.bridge.observe(completed());await tick();
  expect(f.sent.map(e=>e.type)).toEqual(['response.item.create','response.create']);
  expect(Object.keys(f.sent[1]).sort()).toEqual(['event_id','type']);
  expect(f.usage).toHaveLength(1);expect(f.usage[0]).toMatchObject({delegationId,responseId,model:'gpt-5.6-terra',usage:{total_tokens:38}});
 });
 test('waits for every function result while returning completed results promptly',async()=>{
  const first=deferred(),second=deferred();const f=fixture(async(_name,args)=>args.number===1?first.promise:second.promise);
  f.bridge.observe(created());f.bridge.observe(done('call_1','{"number":1}'));f.bridge.observe(done('call_2','{"number":2}'));f.bridge.observe(completed());await tick();
  second.resolve({saved:2});await tick();expect(f.sent.map(e=>e.type)).toEqual(['response.item.create']);
  first.resolve({saved:1});await tick();expect(f.sent.map(e=>e.type)).toEqual(['response.item.create','response.item.create','response.create']);
 });
 test('never executes arguments-done, partial function items, or unwrapped Realtime/Responses events',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return{};});
  f.bridge.observe(created());
  f.bridge.observe(envelope({type:'response.function_call_arguments.done',item_id:'fc_call_1',arguments:'{}'}));
  f.bridge.observe(envelope({type:'response.output_item.added',item:{type:'function_call',call_id:'call_1',name:'save_answer',arguments:'{}'}}));
  f.bridge.observe((done().event));f.bridge.observe({type:'response.done',response:{output:[done().event]}});
  f.bridge.observe(completed());await tick();expect(calls).toBe(0);expect(f.sent).toEqual([]);
 });
 test('does not infer tool calls from output in terminal snapshots',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return{};});f.bridge.observe(created());
  f.bridge.observe(envelope({type:'response.completed',response:{id:responseId,status:'completed',output:[(done().event as any).item]}}));
  await tick();expect(calls).toBe(0);expect(f.sent).toEqual([]);
 });
 test('tolerates additional nested lifecycle events and uncorrelated non-actionable events',()=>{
  const f=fixture();f.bridge.observe(envelope({type:'response.future.lifecycle'},null));f.bridge.observe(created());
  f.bridge.observe(envelope({type:'response.reasoning_summary_text.delta',delta:'ignored'}));
  expect(f.errors).toEqual([]);expect(f.sent).toEqual([]);
 });
 test('a following tool round starts from its new response ID without resubmitting the first round',async()=>{
  const contexts:any[]=[];const f=fixture(async(_name,_args,context)=>{contexts.push(context);return{};});
  f.bridge.observe(created());f.bridge.observe(done());f.bridge.observe(completed());await tick();
  f.bridge.observe(created('resp_second'));f.bridge.observe(done('call_2','{"answer":"domingo sob consulta"}','correct_answer'));f.bridge.observe(completed('resp_second'));await tick();
  expect(contexts.map(c=>c.responseId)).toEqual([responseId,'resp_second']);
  expect(f.sent.map(e=>e.type)).toEqual(['response.item.create','response.create','response.item.create','response.create']);expect(f.usage).toHaveLength(2);
 });
 test('a session-scoped continuation waits for other observed responses and batches ready results once',async()=>{
  const f=fixture();f.bridge.observe(created());f.bridge.observe(done());f.bridge.observe(created('resp_other','delegation_other'));f.bridge.observe(completed());await tick();
  expect(f.sent.map(e=>e.type)).toEqual(['response.item.create']);
  f.bridge.observe(done('call_2','{}','save_answer','delegation_other'));f.bridge.observe(completed('resp_other','delegation_other'));await tick();
  expect(f.sent.map(e=>e.type)).toEqual(['response.item.create','response.item.create','response.create']);
 });
 test('returns invalid JSON as a tool failure without invoking business code or exposing the raw string',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return{};});f.bridge.observe(created());f.bridge.observe(done('call_1','private-malformed-input'));f.bridge.observe(completed());await tick();
  expect(calls).toBe(0);expect(JSON.parse(f.sent[0].item.output)).toEqual({ok:false,code:'invalid_tool_arguments'});
  expect(f.sent.at(-1).type).toBe('response.create');expect(JSON.stringify(f.errors)).not.toContain('private-malformed-input');
 });
 test('a rejected business callback becomes an honest unknown outcome, never a repeated operation',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;throw Error('private database connection details');});f.bridge.observe(created());f.bridge.observe(done());f.bridge.observe(completed());await tick();f.bridge.observe(done());await tick();
  expect(calls).toBe(1);expect(JSON.parse(f.sent[0].item.output)).toEqual({ok:false,code:'tool_execution_failed',outcome:'unknown',retryable:false});
  expect(f.sent.at(-1).type).toBe('response.create');expect(JSON.stringify(f.errors)).not.toContain('private database');
 });
 test('Stop suppresses pending results and later tool execution but preserves drained backend usage',async()=>{
  const work=deferred();let calls=0;const f=fixture(async()=>{calls++;return work.promise;});
  f.bridge.observe(created());f.bridge.observe(done());await tick();f.bridge.stop();f.bridge.stop();
  work.resolve({saved:true});f.bridge.observe(done('call_2'));f.bridge.observe(completed());await tick();
  expect(calls).toBe(1);expect(f.sent).toEqual([]);expect(f.usage).toHaveLength(1);
 });
 test('session.closed has the same stale-callback protection as Stop',async()=>{
  const work=deferred();const f=fixture(async()=>work.promise);f.bridge.observe(created());f.bridge.observe(done());await tick();
  f.bridge.observe({type:'session.closed'});work.resolve({saved:true});f.bridge.observe(completed());await tick();expect(f.sent).toEqual([]);
 });
 test('failed or cancelled responses cannot continue from a later business callback',async()=>{
  for(const type of ['response.failed','response.incomplete','response.cancelled']){
   const work=deferred();const f=fixture(async()=>work.promise);f.bridge.observe(created());f.bridge.observe(done());await tick();
   f.bridge.observe(envelope({type,response:{id:responseId,status:type.slice(9),output:[]}}));work.resolve({saved:true});await tick();expect(f.sent).toEqual([]);expect(f.errors).toHaveLength(1);
  }
 });
 test('a newer response in the same delegation suppresses the stale callback',async()=>{
  const work=deferred();const f=fixture(async()=>work.promise);f.bridge.observe(created());f.bridge.observe(done());await tick();
  f.bridge.observe(created('resp_new'));work.resolve({saved:true});f.bridge.observe(completed(responseId));await tick();expect(f.sent).toEqual([]);
 });
 test('unrelated delegation IDs do not inherit each other\'s response context',async()=>{
  const calls:any[]=[];const f=fixture(async(_name,_args,context)=>{calls.push(context);return{};});
  f.bridge.observe(created());f.bridge.observe(done('call_unknown','{}','save_answer','other_delegation'));await tick();
  expect(calls).toEqual([]);expect(f.errors).toHaveLength(1);expect(f.sent).toEqual([]);
 });
 test('errors correlate to the outgoing result and prevent continuation without replay',async()=>{
  const f=fixture();f.bridge.observe(created());f.bridge.observe(done());await tick();
  f.bridge.observe({type:'error',error:{code:'invalid_request',client_event_id:f.sent[0].event_id,message:'private details'}});
  f.bridge.observe(completed());await tick();expect(f.sent).toHaveLength(1);expect(f.errors).toContainEqual(expect.objectContaining({code:'invalid_request',responseId,delegationId}));
  expect(JSON.stringify(f.errors)).not.toContain('private details');
 });
 test('uncorrelated moderation errors remain observable without pretending the session is closed',async()=>{
  const f=fixture();f.bridge.observe(created());f.bridge.observe({type:'error',error:{code:null,message:'details'}});f.bridge.observe(done());f.bridge.observe(completed());await tick();
  expect(f.errors).toContainEqual(expect.objectContaining({code:null,source:'provider'}));expect(f.sent.at(-1).type).toBe('response.create');
 });
 test('a failed send is reported, not retried or mistaken for a submitted result',async()=>{
  const sent:any[]=[],errors:any[]=[];const bridge=createLiveResponsesBridge({send:event=>{sent.push(event);throw Error('socket details');},execute:async()=>({saved:true}),onError:error=>errors.push(error)});
  bridge.observe(created());bridge.observe(done());bridge.observe(completed());await tick();
  expect(sent).toHaveLength(1);expect(errors).toContainEqual(expect.objectContaining({source:'transport',code:'live_responses_send_failed'}));expect(JSON.stringify(errors)).not.toContain('socket details');
 });
 test('a duplicate call ID with changed arguments is not executed again or continued',async()=>{
  let calls=0;const work=deferred();const f=fixture(async()=>{calls++;return work.promise;});f.bridge.observe(created());f.bridge.observe(done());await tick();
  f.bridge.observe(done('call_1','{"answer":"domingo aberto"}'));f.bridge.observe(completed());work.resolve({saved:true});await tick();
  expect(calls).toBe(1);expect(f.sent).toEqual([]);expect(f.errors).toContainEqual(expect.objectContaining({code:'live_responses_call_conflict'}));
 });
 test('usage and error observers throwing cannot replay or block the transport',async()=>{
  const sent:any[]=[];const bridge=createLiveResponsesBridge({send:event=>sent.push(event),execute:async()=>({saved:true}),onUsage:()=>{throw Error('reporter failed');},onError:()=>{throw Error('reporter failed');}});
  bridge.observe(created());bridge.observe({type:'error',error:{code:null}});bridge.observe(done());bridge.observe(completed());await tick();
  expect(sent.map(e=>e.type)).toEqual(['response.item.create','response.create']);
 });
});

describe('managed Live Responses delegated-work tracking',()=>{
 test('busy() reflects open rounds, unsubmitted results, and the continuation pending for that delegation',async()=>{
  const work=deferred();const f=fixture(async()=>work.promise);
  expect(f.bridge.busy()).toBe(false);
  f.bridge.observe(created());expect(f.bridge.busy()).toBe(true);
  f.bridge.observe(done());await tick();expect(f.bridge.busy()).toBe(true);
  f.bridge.observe(completed());await tick();expect(f.bridge.busy()).toBe(true); // result still unsubmitted
  work.resolve({saved:true});await tick();
  expect(f.sent.map(e=>e.type)).toEqual(['response.item.create','response.create']);
  expect(f.bridge.busy()).toBe(true); // continuation sent, its response.created not yet observed
  f.bridge.observe(created('resp_bye'));expect(f.bridge.busy()).toBe(true);
  f.bridge.observe(completed('resp_bye'));await tick();expect(f.bridge.busy()).toBe(false);expect(f.idle()).toBe(1);
 });
 test('a continuation pending for one delegation is not consumed by another delegation response',async()=>{
  const f=fixture();f.bridge.observe(created());f.bridge.observe(done());f.bridge.observe(completed());await tick();
  expect(f.sent.map(e=>e.type)).toEqual(['response.item.create','response.create']);expect(f.bridge.busy()).toBe(true);
  f.bridge.observe(created('resp_other','delegation_other'));f.bridge.observe(completed('resp_other','delegation_other'));await tick();
  expect(f.bridge.busy()).toBe(true);expect(f.idle()).toBe(0);
  f.bridge.observe(created('resp_bye'));f.bridge.observe(completed('resp_bye'));await tick();
  expect(f.bridge.busy()).toBe(false);expect(f.idle()).toBe(1);
 });
 test('a failed result send ends the delegated work and notifies idle exactly once',async()=>{
  const f=fixture(async()=>({saved:true}),event=>{throw Error('socket details');});
  f.bridge.observe(created());expect(f.bridge.busy()).toBe(true);f.bridge.observe(done());await tick();
  expect(f.bridge.busy()).toBe(false);expect(f.idle()).toBe(1);
  f.bridge.observe(completed());await tick();expect(f.idle()).toBe(1);
 });
 test('stop() notifies idle once and idle never fires while work remains',async()=>{
  const work=deferred();const f=fixture(async()=>work.promise);f.bridge.observe(created());f.bridge.observe(done());await tick();
  expect(f.idle()).toBe(0);f.bridge.stop();f.bridge.stop();expect(f.bridge.busy()).toBe(false);await tick();expect(f.idle()).toBe(1);
  work.resolve({saved:true});await tick();expect(f.idle()).toBe(1);
 });
 test('two busy cycles notify idle twice',async()=>{
  const f=fixture();
  f.bridge.observe(created());f.bridge.observe(completed());await tick();expect(f.idle()).toBe(1);
  f.bridge.observe(created('resp_second'));f.bridge.observe(completed('resp_second'));await tick();expect(f.idle()).toBe(2);
 });
});
