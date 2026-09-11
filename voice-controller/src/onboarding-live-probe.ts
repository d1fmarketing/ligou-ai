import {randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/** Read-only existence check for a Live session. It performs the documented
 * sideband attach handshake (wss://api.openai.com/v1/live/sessions/{id}/attach)
 * as an HTTP upgrade request and only classifies the provider's answer:
 * 404 session_id_not_found / invalid_request_error => the session is gone.
 * Anything else is 'exists' (101) or 'unknown'. It never creates, closes or
 * confirms anything, and never throws. */
export type LiveSessionProbe={outcome:'not_found'|'exists'|'unknown';status:number|null;code:string|null;type:string|null;checkedAt:string};
type ProviderFetch=(url:string,init?:RequestInit)=>Promise<Response>;
// Measured 2026-09-11: the provider answers the upgrade probe for a gone session
// with 404 after ~5.4 s. The default must exceed that with margin.
const MAX_BODY_BYTES=65_536,DEFAULT_TIMEOUT_MS=15_000;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Bun's fetch aborts immediately when Upgrade/Connection headers are combined
 * with an AbortSignal (observed on 1.2.6 and 1.2.13). node:http(s) sends the
 * handshake headers verbatim and the provider answers a regular 404 for a gone
 * session; the abort signal destroys the request. Bodies are bounded so a
 * misbehaving peer cannot grow memory. `requestImpl` is a test seam only. */
export type UpgradeRequestImpl=(options:http.RequestOptions,callback:(response:http.IncomingMessage)=>void)=>http.ClientRequest;
export function upgradeProbeFetch(url:string,init:RequestInit={},requestImpl?:UpgradeRequestImpl):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const target=new URL(url),transport=target.protocol==='http:'?http:https;
    const headers=Object.fromEntries(Object.entries(init.headers as Record<string,string>??{}).filter(([,value])=>typeof value==='string'));
    // Called through the module object: Bun's https.request misbehaves unbound.
    // No `port` key unless the URL carries one: Bun's node:https misroutes `port: undefined`.
    const options={host:target.hostname,...(target.port?{port:Number(target.port)}:{}),path:target.pathname+target.search,method:init.method??'GET',headers};
    const onResponse=(response:http.IncomingMessage)=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size<=MAX_BODY_BYTES+1)chunks.push(chunk);});
      response.on('end',()=>{const body=Buffer.concat(chunks).subarray(0,MAX_BODY_BYTES+1).toString('utf8');resolve(new Response(body,{status:response.statusCode??0}));});
      response.on('error',reject);
    };
    const request=requestImpl?requestImpl(options,onResponse):transport.request(options,onResponse);
    request.on('upgrade',(response,socket)=>{socket.destroy();resolve(new Response(null,{status:response.statusCode??101}));});
    request.on('error',reject);
    // Bun emits 'close' but no 'error' after destroy(); settle explicitly.
    request.on('close',()=>reject(Error('upgrade_probe_closed')));
    const abort=()=>{request.destroy(Error('aborted'));reject(Error('aborted'));};
    if(init.signal){if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});}
    request.end();
  });
}

function errorShape(body:unknown):{code:string|null;type:string|null}{
  if(!object(body))return{code:null,type:null};
  const source=object(body.error)?body.error:body;
  return{code:typeof source.code==='string'?source.code:null,type:typeof source.type==='string'?source.type:null};
}

export async function probeLiveSession(sessionId:string,deps:{apiKey:string;fetch?:ProviderFetch;timeoutMs?:number}):Promise<LiveSessionProbe>{
  const checkedAt=new Date().toISOString();
  const unknown=(status:number|null=null,code:string|null=null,type:string|null=null):LiveSessionProbe=>({outcome:'unknown',status,code,type,checkedAt});
  if(typeof sessionId!=='string'||!sessionId.trim()||typeof deps.apiKey!=='string'||!deps.apiKey.trim())return unknown();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),deps.timeoutMs??DEFAULT_TIMEOUT_MS);
  try{
    const response=await(deps.fetch??upgradeProbeFetch)(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,{
      method:'GET',signal:controller.signal,
      headers:{Authorization:`Bearer ${deps.apiKey}`,Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':randomBytes(16).toString('base64')},
    });
    if(response.status===101)return{outcome:'exists',status:101,code:null,type:null,checkedAt};
    const text=await response.text();
    if(Buffer.byteLength(text)>MAX_BODY_BYTES)return unknown(response.status);
    let body:unknown=null;try{body=JSON.parse(text);}catch{/* non-JSON provider answer stays unknown */}
    const {code,type}=errorShape(body);
    if(response.status===404&&code==='session_id_not_found'&&type==='invalid_request_error')return{outcome:'not_found',status:404,code,type,checkedAt};
    return unknown(response.status,code,type);
  }catch{return unknown();}
  finally{clearTimeout(timer);}
}
