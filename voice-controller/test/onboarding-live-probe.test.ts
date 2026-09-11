import {describe,expect,test} from 'bun:test';
import http from 'node:http';
import {probeLiveSession,upgradeProbeFetch} from '../src/onboarding-live-probe.ts';

const key='synthetic-probe-key-0123456789';
const response=(status:number,body:unknown)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function fakeFetch(handler:(url:string,init:any)=>Promise<Response>|Response){
  const calls:any[]=[];
  const fetchImpl=async(url:any,init:any)=>{calls.push({url:String(url),init});return handler(String(url),init);};
  return{fetchImpl:fetchImpl as any,calls};
}

describe('read-only Live session existence probe',()=>{
  test('a 404 session_id_not_found in the nested error shape means the session is gone',async()=>{
    const f=fakeFetch(()=>response(404,{error:{message:'No session found for the provided session_id',type:'invalid_request_error',code:'session_id_not_found',param:'session_id'}}));
    const probe=await probeLiveSession('live_u1_x',{apiKey:key,fetch:f.fetchImpl});
    expect(probe).toMatchObject({outcome:'not_found',status:404,code:'session_id_not_found',type:'invalid_request_error'});
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/live/sessions/live_u1_x/attach');
    const headers=f.calls[0].init.headers;
    expect(headers.Upgrade).toBe('websocket');expect(headers.Connection).toBe('Upgrade');expect(headers['Sec-WebSocket-Version']).toBe('13');
    expect(Buffer.from(headers['Sec-WebSocket-Key'],'base64')).toHaveLength(16);expect(headers.Authorization).toBe(`Bearer ${key}`);
    expect(Math.abs(Date.parse(probe.checkedAt)-Date.now())).toBeLessThan(1000);
    expect(JSON.stringify(probe)).not.toContain(key);
  });
  test('a 404 with a top-level code/type shape is also recognised',async()=>{
    const f=fakeFetch(()=>response(404,{code:'session_id_not_found',type:'invalid_request_error'}));
    expect((await probeLiveSession('live_u1_x',{apiKey:key,fetch:f.fetchImpl})).outcome).toBe('not_found');
  });
  test('other statuses and codes never claim absence',async()=>{
    for(const [status,body,outcome,code] of [[404,{error:{code:'other',type:'invalid_request_error'}},'unknown','other'],[500,{error:{code:'server_error',type:'server_error'}},'unknown','server_error'],[101,'','exists',null],[401,{error:{code:'invalid_api_key',type:'invalid_request_error'}},'unknown','invalid_api_key']] as const){
      const f=fakeFetch(()=>response(status as number,body));
      const probe=await probeLiveSession('live_u1_x',{apiKey:key,fetch:f.fetchImpl});
      expect(probe.outcome).toBe(outcome);expect(probe.status).toBe(status);expect(probe.code).toBe(code);
    }
  });
  test('transport failures, oversized bodies and timeouts are unknown, never absence',async()=>{
    const failing=fakeFetch(()=>{throw Error('socket details');});
    expect(await probeLiveSession('live_u1_x',{apiKey:key,fetch:failing.fetchImpl})).toMatchObject({outcome:'unknown',status:null,code:null});
    const oversized=fakeFetch(()=>response(404,JSON.stringify({error:{code:'session_id_not_found',type:'invalid_request_error',pad:'x'.repeat(70_000)}})));
    expect((await probeLiveSession('live_u1_x',{apiKey:key,fetch:oversized.fetchImpl})).outcome).toBe('unknown');
    let aborted=false;const hanging=fakeFetch((_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));});}));
    const probe=await probeLiveSession('live_u1_x',{apiKey:key,fetch:hanging.fetchImpl,timeoutMs:10});
    expect(probe.outcome).toBe('unknown');expect(aborted).toBe(true);
  });
  test('rejects an empty key or session id without calling the provider',async()=>{
    const f=fakeFetch(()=>response(404,{}));
    expect((await probeLiveSession('',{apiKey:key,fetch:f.fetchImpl})).outcome).toBe('unknown');
    expect((await probeLiveSession('live_u1_x',{apiKey:'',fetch:f.fetchImpl})).outcome).toBe('unknown');
    expect(f.calls).toHaveLength(0);
  });
});

describe('node:http(s) upgrade probe transport',()=>{
  function fakeRequest(behaviour:{status?:number;body?:string;hang?:boolean}){
    const seen:any={options:null,ended:false,destroyed:null as any};
    const requestImpl:any=(options:any,callback:(response:any)=>void)=>{
      seen.options=options;const listeners=new Map<string,Function[]>();
      const request:any={on(type:string,fn:Function){listeners.set(type,[...(listeners.get(type)??[]),fn]);return request;},
        end(){seen.ended=true;if(behaviour.hang)return;queueMicrotask(()=>{const rl=new Map<string,Function[]>();const response:any={statusCode:behaviour.status??404,on(type:string,fn:Function){rl.set(type,[...(rl.get(type)??[]),fn]);return response;}};
          callback(response);for(const fn of rl.get('data')??[])fn(Buffer.from(behaviour.body??''));for(const fn of rl.get('end')??[])fn();});},
        destroy(error:Error){seen.destroyed=error;for(const fn of listeners.get('close')??[])fn();}}; // Bun: destroy emits close, never error
      return request;
    };
    return{requestImpl,seen};
  }
  test('sends the handshake headers verbatim and returns the provider status and body',async()=>{
    const body=JSON.stringify({error:{code:'session_id_not_found',type:'invalid_request_error'}});const f=fakeRequest({status:404,body});
    const response=await upgradeProbeFetch('https://api.openai.com/v1/live/sessions/live_x/attach',{method:'GET',headers:{Authorization:`Bearer ${key}`,Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ=='}},f.requestImpl);
    expect(response.status).toBe(404);expect(JSON.parse(await response.text())).toMatchObject({error:{code:'session_id_not_found'}});
    expect(f.seen.options).toMatchObject({host:'api.openai.com',path:'/v1/live/sessions/live_x/attach',method:'GET',headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Version':'13',Authorization:`Bearer ${key}`}});
    expect(f.seen.ended).toBe(true);expect(f.seen.destroyed).toBe(null);
  });
  test('an abort signal destroys a hanging request and the promise rejects',async()=>{
    const f=fakeRequest({hang:true});const controller=new AbortController();setTimeout(()=>controller.abort(),10);
    await expect(upgradeProbeFetch('https://api.openai.com/attach',{signal:controller.signal},f.requestImpl)).rejects.toThrow(/aborted|upgrade_probe_closed/);
    expect(f.seen.destroyed).toBeInstanceOf(Error);
  });
});
