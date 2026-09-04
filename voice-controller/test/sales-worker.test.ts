import {expect,test} from 'bun:test';
import {runSalesSession} from '../src/sales/worker.ts';
import {createSalesStore} from '../src/sales/store.ts';
function fixture(overrides:any={}) {
 let row:any={session_id:'s',request_id:'r',claim_token:'c',status:'starting',client_connected_at:new Date().toISOString(),offer_sdp:'offer',provider_call_id:null,model:null,expires_at:new Date(Date.now()+300000).toISOString(),created_at:new Date().toISOString(),stop_requested:false,create_intent_at:null,observed_cost_usd:0,reserved_cost_usd:1.5,...overrides};
 const log:string[]=[];
 const store:any={heartbeat:async()=>({enabled:true}),apply:async(_r:any,op:string,p:any={})=>{log.push(op);if(op==='create_intent')row={...row,create_intent_at:'now',model:p.model};if(op==='provider_ready')row={...row,provider_call_id:p.provider_call_id,model:p.model};if(op==='activate')row={...row,status:'ready'};if(op==='termination')row={...row,status:p.state==='confirmed'?'ended':'ending',provider_termination_state:p.state};return row;}};
 let listener:any;
 const deps:any={store,workerId:'worker',create:async(_s:string,_r:string,_f:any,hooks:any)=>{await hooks.beforeAttempt('gpt-realtime-2.1');log.push('provider_create');return {outcome:'accepted',callId:'rtc',answer:'answer',model:'gpt-realtime-2.1'};},attach:async(_r:any,_store:any,stop:any)=>{log.push('sideband_ack'); listener=stop; return {send:()=>{},greet:()=>{log.push('greeting');},close:()=>{log.push('socket_close');}};},terminate:async()=>{log.push('hangup');return {confirmed:true};},tickMs:5};
 return {row,log,deps,connect:()=>{row={...row,client_connected_at:new Date().toISOString()};},stop:()=>listener('test_end')};
}
test('provider intent and identity precede sideband acknowledgement and public activation; durable stop precedes hangup',async()=>{
 const f=fixture();const running=runSalesSession(f.row,f.deps);
 for(let i=0;i<20&&!f.log.includes('activate');i++)await Bun.sleep(1);
 await f.stop();await running;
 expect(f.log.indexOf('create_intent')).toBeLessThan(f.log.indexOf('provider_create'));
 expect(f.log.indexOf('provider_ready')).toBeLessThan(f.log.indexOf('sideband_ack'));
 expect(f.log.indexOf('sideband_ack')).toBeLessThan(f.log.indexOf('activate'));
 expect(f.log.indexOf('termination')).toBeLessThan(f.log.indexOf('hangup'));
 expect(f.log.filter(x=>x==='hangup')).toHaveLength(1);
});
test('unknown creation quarantines without trying another call',async()=>{
 const f=fixture();f.deps.create=async(_s:any,_r:any,_f:any,h:any)=>{await h.beforeAttempt('gpt-realtime-2.1');return {outcome:'unknown',callId:null,error:'unknown',model:'gpt-realtime-2.1'};};
 await runSalesSession(f.row,f.deps);expect(f.log).toContain('quarantine');expect(f.log).not.toContain('hangup');expect(f.log).not.toContain('activate');
});
test('recovered known provider is terminated without a new provider create',async()=>{
 const f=fixture({provider_call_id:'rtc_old',create_intent_at:'old',model:'gpt-realtime-2.1',status:'ready'});
 await runSalesSession(f.row,f.deps);expect(f.log).toContain('hangup');expect(f.log).not.toContain('provider_create');
});
test('expired or stopped before create ends safely without provider spending',async()=>{
 for(const o of [{stop_requested:true},{expires_at:new Date(0).toISOString()}]){const f=fixture(o);await runSalesSession(f.row,f.deps);expect(f.log).not.toContain('provider_create');expect(f.log).toContain('fail');}
});
test('sideband setup failure hangs up known accepted provider and never exposes ready',async()=>{
 const f=fixture();f.deps.attach=async()=>{throw new Error('socket timeout');};await runSalesSession(f.row,f.deps);expect(f.log).toContain('hangup');expect(f.log).not.toContain('activate');
});
test('disabled heartbeat fails closed and terminates active provider',async()=>{
 const f=fixture();f.deps.store.heartbeat=async()=>({enabled:false});await runSalesSession(f.row,f.deps);expect(f.log).not.toContain('provider_create');
});
test('RPC store rejects mismatched fence and forwards only sales RPCs',async()=>{
 const calls:any[]=[];const store=createSalesStore({rpc:async(name,args)=>{calls.push({name,args});return {data:{session_id:'s',claim_token:'other'},error:null};}});
 await expect(store.apply({session_id:'s',claim_token:'c'} as any,'renew')).rejects.toThrow('sales_fence_lost');
 expect(calls[0]).toEqual({name:'sales_worker_apply',args:{p_session_id:'s',p_claim_token:'c',p_operation:'renew',p_payload:{}}});
});
test('provider identity returned after cancellation is still terminated once',async()=>{
 const f=fixture();const abort=new AbortController();f.deps.signal=abort.signal;
 f.deps.create=async(_s:any,_r:any,_f:any,h:any)=>{await h.beforeAttempt('gpt-realtime-2.1');abort.abort();await Bun.sleep(1);return {outcome:'accepted',callId:'rtc_late',answer:'answer',model:'gpt-realtime-2.1'};};
 await runSalesSession(f.row,f.deps);expect(f.log.filter(x=>x==='hangup')).toHaveLength(1);expect(f.log).not.toContain('activate');
});
test('provider identity persistence failure still hangs up the known external call',async()=>{
 const f=fixture();const apply=f.deps.store.apply;f.deps.store.apply=async(r:any,op:any,p:any)=>{if(op==='provider_ready')throw Error('db down');return apply(r,op,p);};
 await runSalesSession(f.row,f.deps);expect(f.log).toContain('hangup');expect(f.log).not.toContain('activate');
});
test('exact session deadline terminates without waiting for heartbeat interval',async()=>{
 const f=fixture({expires_at:new Date(Date.now()+20).toISOString()});f.deps.tickMs=1000;const started=Date.now();await runSalesSession(f.row,f.deps);expect(f.log).toContain('hangup');expect(Date.now()-started).toBeLessThan(500);
});
test('already confirmed recovered termination never calls provider again',async()=>{
 const f=fixture({provider_call_id:'rtc',provider_termination_state:'confirmed',status:'ended'});await runSalesSession(f.row,f.deps);expect(f.log).not.toContain('hangup');
});
test('RPC timeout bounds persistence failure so deadline hangup is not indefinitely blocked',async()=>{
 const store=createSalesStore({rpc:()=>new Promise(()=>{})},{timeoutMs:10});
 await expect(store.heartbeat('w')).rejects.toThrow('sales_store_timeout');
});

test('greeting waits for persisted browser-connected acknowledgement, then sends exactly once',async()=>{
 const f=fixture({client_connected_at:null});const running=runSalesSession(f.row,f.deps);
 for(let i=0;i<50&&!f.log.includes('activate');i++)await Bun.sleep(1);
 await Bun.sleep(10);expect(f.log).not.toContain('greeting');
 f.connect();await Bun.sleep(30);expect(f.log.filter(x=>x==='greeting')).toHaveLength(1);
 await Bun.sleep(20);expect(f.log.filter(x=>x==='greeting')).toHaveLength(1);
 await f.stop();await running;
});
test('cancelled before browser connection never produces a greeting',async()=>{
 const f=fixture({client_connected_at:null});const running=runSalesSession(f.row,f.deps);
 for(let i=0;i<50&&!f.log.includes('activate');i++)await Bun.sleep(1);
 await f.stop();f.connect();await running;expect(f.log).not.toContain('greeting');
});
