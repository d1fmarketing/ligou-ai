import {config} from '../config.ts';

type Receipt = {http_status:number;received_at:string;provider_error_code?:string;provider_error_type?:string;provider_request_id?:string};
export type SalesTerminationResult = {confirmed:boolean;error?:string;receipt?:Receipt};
const safeCode=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)?value:undefined;
async function errorFields(response:Response):Promise<{provider_error_code?:string;provider_error_type?:string}>{
 const reader=response.body?.getReader();if(!reader)return {};
 const decoder=new TextDecoder();let body='',size=0;
 try{
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096)return {};body+=decoder.decode(value,{stream:true});}
  const error=JSON.parse(body+decoder.decode())?.error;
  return {provider_error_code:safeCode(error?.code),provider_error_type:safeCode(error?.type)};
 }catch{return {};}finally{void reader.cancel().catch(()=>{});}
}
/** Sales-specific transport: keep safe HTTP evidence, never treat generic 404 as a hangup ACK. */
export async function requestSalesTermination(args:{openaiCallId:string|null;mode:'hangup'|'reject';requestId:string;timeoutMs?:number;fetchImpl?:typeof fetch}):Promise<SalesTerminationResult>{
 if(!args.openaiCallId)return {confirmed:false,error:'provider_call_id_unknown'};
 if(!args.requestId?.trim())return {confirmed:false,error:'provider_request_id_required'};
 if(args.mode!=='hangup')return {confirmed:false,error:'sales_termination_mode_forbidden'};
 const timeoutMs=args.timeoutMs??5000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>=15000)return {confirmed:false,error:'provider_termination_timeout_invalid'};
 const abort=new AbortController();let receipt:Receipt|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const request=(async():Promise<SalesTerminationResult>=>{
  try{
   const response=await (args.fetchImpl??fetch)(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(args.openaiCallId!)}/hangup`,{
    method:'POST',headers:{Authorization:`Bearer ${config.openaiKey}`,'X-Client-Request-Id':args.requestId},signal:abort.signal,
   });
   receipt={http_status:response.status,received_at:new Date().toISOString(),provider_request_id:safeCode(response.headers.get('x-request-id'))};
   if(response.ok)return {confirmed:true,receipt};
   receipt={...receipt,...await errorFields(response)};
   return {confirmed:false,error:`provider_hangup_failed: ${response.status}`,receipt};
  }catch{return {confirmed:false,error:abort.signal.aborted?'provider_hangup_timeout':'provider_hangup_transport_unknown',receipt};}
 })();
 const timeout=new Promise<SalesTerminationResult>(resolve=>{timer=setTimeout(()=>{abort.abort();resolve({confirmed:false,error:'provider_hangup_timeout',receipt});},timeoutMs);});
 try{return await Promise.race([request,timeout]);}finally{if(timer)clearTimeout(timer);}
}
