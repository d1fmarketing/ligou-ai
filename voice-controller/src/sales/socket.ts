import {config} from '../config.ts';
import {SalesConversation,isSalesSessionIntact} from './conversation.ts';
import {salesSessionConfig} from './provider.ts';
import type {SalesStore,WorkerSession} from './store.ts';
export interface SalesSocket {send(event:unknown):void;close():void}
export async function attachSalesSocket(row:WorkerSession,store:SalesStore,stop:(reason:string)=>Promise<void>,socketFactory=(url:string,options:any)=>new WebSocket(url,options)):Promise<SalesSocket> {
 const ws=socketFactory(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(row.provider_call_id!)}`,{headers:{Authorization:`Bearer ${config.openaiKey}`}});
 const send=(event:unknown)=>ws.send(JSON.stringify(event));
 const conversation=new SalesConversation(row,store,send,stop);
 let closed=false, acknowledged=false;
 let queue=Promise.resolve();
 let resolve!:()=>void,reject!:(reason:Error)=>void;
 const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
 const fail=(reason:string)=>{reject(new Error(reason));void stop(reason).catch(()=>{});};
 const timer=setTimeout(()=>fail('sideband_open_timeout'),config.sidebandOpenTimeoutMs);
 ws.addEventListener('open',()=>{try{const {model:_immutableModel,...session}=salesSessionConfig(String(row.model));send({type:'session.update',session});}catch{fail('sideband_setup_failed');}});
 ws.addEventListener('message',(event:any)=>{
   queue=queue.then(async()=>{
    if(closed)return;
    const message=JSON.parse(String(event.data));
    if(message.type==='session.updated'&&!acknowledged){
      if(!isSalesSessionIntact(message.session,String(row.model))){fail('session_authority_changed');return;}
      acknowledged=true;resolve();
    }
    await conversation.handle(message);
   }).catch(()=>fail('sideband_evidence_failed'));
 });
 ws.addEventListener('close',()=>{if(!closed)fail('sideband_disconnected');});
 ws.addEventListener('error',()=>{if(!closed)fail('sideband_error');});
 try{await ready;}catch(error){closed=true;try{ws.close();}catch{}throw error;}finally{clearTimeout(timer);}
 return {send,close(){closed=true;try{ws.close();}catch{}}};
}
