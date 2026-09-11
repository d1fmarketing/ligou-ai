import {randomBytes} from 'node:crypto';

/** Read-only existence check for a Live session. It performs the documented
 * sideband attach handshake (wss://api.openai.com/v1/live/sessions/{id}/attach)
 * as an HTTP upgrade request and only classifies the provider's answer:
 * 404 session_id_not_found / invalid_request_error => the session is gone.
 * Anything else is 'exists' (101) or 'unknown'. It never creates, closes or
 * confirms anything, and never throws. */
export type LiveSessionProbe={outcome:'not_found'|'exists'|'unknown';status:number|null;code:string|null;type:string|null;checkedAt:string};
type ProviderFetch=(url:string,init?:RequestInit)=>Promise<Response>;
const MAX_BODY_BYTES=65_536,DEFAULT_TIMEOUT_MS=5_000;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

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
    const response=await(deps.fetch??fetch)(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,{
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
