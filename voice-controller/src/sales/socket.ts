import {config} from '../config.ts';
import {SalesConversation,isSalesSessionIntact,salesDiagnosticEvent} from './conversation.ts';
import {salesSessionConfig} from './provider.ts';
import type {SalesStore,WorkerSession} from './store.ts';
export interface SalesSocket {send(event:unknown):void;greet():void;close():void}
export async function attachSalesSocket(row:WorkerSession,store:SalesStore,stop:(reason:string)=>Promise<void>,socketFactory=(url:string,options:any)=>new WebSocket(url,options),options:{transcriptionTimeoutMs?:number}={}):Promise<SalesSocket> {
 const ws=socketFactory(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(row.provider_call_id!)}`,{headers:{Authorization:`Bearer ${config.openaiKey}`}});
 const send=(event:any)=>{if(closed||failed)return;ws.send(JSON.stringify(event));if(event.type==='response.create')conversationStarted=true;};
 const conversation=new SalesConversation(row,store,send,stop);
 let closed=false, acknowledged=false, conversationStarted=false,failed=false,visitorSpeaking=false,greetingRequested=false;
 const pendingTranscriptions=new Map<string,ReturnType<typeof setTimeout>>();
 const completedTranscriptions=new Set<string>();
 const clearTranscriptions=()=>{for(const timer of pendingTranscriptions.values())clearTimeout(timer);pendingTranscriptions.clear();};
 let queue=Promise.resolve();
 let resolve!:()=>void,reject!:(reason:Error)=>void;
 const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
 const fail=(reason:string)=>{if(failed||closed)return;if(reason==='transcription_timeout')try{send(salesDiagnosticEvent('transcription_timeout'));}catch{}failed=true;clearTranscriptions();reject(new Error(reason));void stop(reason).catch(()=>{});};
 const maybeGreet=()=>{if(greetingRequested&&!closed&&!failed&&!conversationStarted&&!visitorSpeaking&&!pendingTranscriptions.size)conversation.greet();};
 const timer=setTimeout(()=>fail('sideband_open_timeout'),config.sidebandOpenTimeoutMs);
 ws.addEventListener('open',()=>{try{const {model:_immutableModel,...session}=salesSessionConfig(String(row.model));send({type:'session.update',session});}catch{fail('sideband_setup_failed');}});
 ws.addEventListener('message',(event:any)=>{
   queue=queue.then(async()=>{
    if(closed||failed)return;
    const message=JSON.parse(String(event.data));
    if(message.type==='input_audio_buffer.committed'&&message.item_id&&!completedTranscriptions.has(message.item_id)&&!pendingTranscriptions.has(message.item_id)){
      pendingTranscriptions.set(message.item_id,setTimeout(()=>fail('transcription_timeout'),options.transcriptionTimeoutMs??10000));
    }
    if(message.type==='input_audio_buffer.speech_started')visitorSpeaking=true;
    if(message.type==='response.created')conversationStarted=true;
    if(message.type==='session.updated'&&!acknowledged){
      if(!isSalesSessionIntact(message.session,String(row.model))){fail('session_authority_changed');return;}
      acknowledged=true;resolve();
    }
    await conversation.handle(message);
    if(message.type==='conversation.item.input_audio_transcription.completed'&&message.item_id){
      completedTranscriptions.add(message.item_id);
      clearTimeout(pendingTranscriptions.get(message.item_id));pendingTranscriptions.delete(message.item_id);
      visitorSpeaking=false;maybeGreet();
    }
   }).catch(()=>fail('sideband_evidence_failed'));
 });
 ws.addEventListener('close',()=>{if(!closed)fail('sideband_disconnected');});
 ws.addEventListener('error',()=>{if(!closed)fail('sideband_error');});
 try{await ready;}catch(error){closed=true;clearTranscriptions();try{ws.close();}catch{}throw error;}finally{clearTimeout(timer);}
 return {send,greet(){greetingRequested=true;maybeGreet();},close(){closed=true;clearTranscriptions();try{ws.close();}catch{}}};
}
