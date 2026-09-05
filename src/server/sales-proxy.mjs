import {isIP} from 'node:net';
const reply=(error,status)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});
export async function proxySalesSession(request,config,fetchImpl=fetch){
  if(request.method!=='POST')return reply('method_not_allowed',405);
  const origin=request.headers.get('origin')||'';
  if(!config.allowedOrigins?.includes(origin))return reply('origin_not_allowed',403);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return reply('invalid_request',415);
  if(!config.edgeUrl||!config.proxySecret||!isIP(config.networkIp||''))return reply('network_unavailable',503);
  let target;try{target=new URL(config.edgeUrl);}catch{return reply('service_unavailable',503);}
  if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash||target.pathname!=='/functions/v1/sales-session')return reply('service_unavailable',503);
  if(Number(request.headers.get('content-length')||0)>98304)return reply('request_too_large',413);
  const reader=request.body?.getReader();if(!reader)return reply('invalid_request',400);
  let size=0;const chunks=[];
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>98304){await reader.cancel();return reply('request_too_large',413);}chunks.push(value);}
  }catch{return reply('invalid_request',400);}
  const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const upstream=await fetchImpl(target.href,{method:'POST',headers:{'content-type':'application/json',origin,authorization:request.headers.get('authorization')||'','x-sales-proxy-secret':config.proxySecret,'x-sales-network-ip':config.networkIp},body,signal:controller.signal,redirect:'error'});
    const data=await upstream.json().catch(()=>null);
    if(!data||typeof data!=='object'||Array.isArray(data))return reply('service_unavailable',502);
    // Edge already projects public state; restrict the final boundary as well.
    const output={};for(const key of ['session_id','status','max_minutes','expires_at','sdp','error','provider_termination_state'])if(data[key]!==undefined)output[key]=data[key];
    return Response.json(output,{status:upstream.status,headers:{'cache-control':'no-store'}});
  }catch{return reply('network_error',502);}
  finally{clearTimeout(timeout);}
}
