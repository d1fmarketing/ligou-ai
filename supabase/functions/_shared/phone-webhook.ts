import {canonicalPhoneNumber} from './phone-number.ts';
import {hashCanonicalContact} from './privacy.ts';
const encoder=new TextEncoder();
interface Dependencies {
 webhookSecret:string;contactHashKey:string;
 persist:(row:Record<string,unknown>)=>Promise<Response>;
 now?:()=>number;persistenceTimeoutMs?:number;bodyTimeoutMs?:number;
}
const error=(code:string,status:number)=>Response.json({error:code},{status});
function keyBytes(value:string,min=32,max=32):Uint8Array {
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('invalid_key');
 const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
 if(bytes.length<min||bytes.length>max)throw Error('invalid_key');return bytes;
}
async function boundedBody(req:Request,timeoutMs:number):Promise<string>{
 if(Number(req.headers.get('content-length')??0)>65536)throw Error('body_too_large');
 const reader=req.body?.getReader();if(!reader)return '';
 let timer:ReturnType<typeof setTimeout>|undefined;
 const reading=(async()=>{const decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw Error('body_too_large');text+=decoder.decode(value,{stream:true});}return text+decoder.decode();})();
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('body_timeout')),timeoutMs);});
 try{return await Promise.race([reading,timeout]);}finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
async function signed(req:Request,raw:string,key:Uint8Array,now:number):Promise<boolean>{
 const id=req.headers.get('webhook-id')??'',ts=req.headers.get('webhook-timestamp')??'',header=req.headers.get('webhook-signature')??'';
 if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id)||!/^\d{1,13}$/.test(ts)||header.length>2048||Math.abs(now/1000-Number(ts))>300)return false;
 const imported=await crypto.subtle.importKey('raw',new Uint8Array(key).buffer,{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const payload=encoder.encode(`${id}.${ts}.${raw}`);
 for(const part of header.split(/\s+/).slice(0,5)){
   const match=part.match(/^v1,([A-Za-z0-9+/]+={0,2})$/);if(!match)continue;
   try{const signature=Uint8Array.from(atob(match[1]),c=>c.charCodeAt(0));if(await crypto.subtle.verify('HMAC',imported,signature,payload))return true;}catch{}
 }
 return false;
}
/** The same HTTP boundary is exercised by tests and deployed by the Edge entry. */
export async function handlePhoneWebhook(req:Request,d:Dependencies):Promise<Response>{
 if(req.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST'}});
 let webhookKey:Uint8Array;
 try{webhookKey=keyBytes(d.webhookSecret.replace(/^whsec_/,''),16,128);keyBytes(d.contactHashKey);}catch{return error('phone_webhook_unavailable',503);}
 let raw:string;
 try{raw=await boundedBody(req,d.bodyTimeoutMs??3000);}catch(e){return error(e instanceof Error&&e.message==='body_too_large'?'payload_too_large':'invalid_body',e instanceof Error&&e.message==='body_too_large'?413:400);}
 if(!await signed(req,raw,webhookKey,(d.now??Date.now)()))return error('invalid_signature',401);
 let event:any;try{event=JSON.parse(raw);}catch{return error('invalid_event',400);}
 if(!event||Array.isArray(event)||typeof event.type!=='string')return error('invalid_event',400);
 if(event.type!=='realtime.call.incoming')return Response.json({ignored:true});
 const id=event.data?.call_id,headers=event.data?.sip_headers;
 if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(id)||!Array.isArray(headers)||headers.length>64||headers.some(h=>!h||typeof h.name!=='string'||typeof h.value!=='string'||h.name.length>100||h.value.length>1024))return error('invalid_call_event',400);
 const named=(name:string)=>headers.filter(h=>h.name.trim().toLowerCase()===name);
 const to=named('to'),from=named('from');
 const called=to.length===1?canonicalPhoneNumber(to[0].value):null;
 const caller=from.length===1?canonicalPhoneNumber(from[0].value):null;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
   const row={openai_call_id:id,called_number:called,caller_number_hash:caller?await hashCanonicalContact(caller,d.contactHashKey):null,sip_headers:called?{to:called}:{}};
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('persistence_timeout')),d.persistenceTimeoutMs??4000);});
   const response=await Promise.race([d.persist(row),timeout]);
   return response instanceof Response?response:error('phone_event_persistence_failed',503);
 }catch{return error('phone_event_persistence_failed',503);}finally{if(timer)clearTimeout(timer);}
}
