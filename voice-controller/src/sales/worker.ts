import {requestSalesTermination,type SalesTerminationResult} from './termination.ts';
import {createSalesCall} from './provider.ts';
import {attachSalesSocket,type SalesSocket} from './socket.ts';
import type {SalesStore,WorkerSession} from './store.ts';
export interface SalesWorkerDependencies {
 store:SalesStore;workerId:string;create?:typeof createSalesCall;attach?:typeof attachSalesSocket;
 terminate?:typeof requestSalesTermination;fetchImpl?:typeof fetch;tickMs?:number;signal?:AbortSignal;
}
export async function runSalesSession(initial:WorkerSession,d:SalesWorkerDependencies):Promise<void> {
 let row=initial,socket:SalesSocket|null=null,knownId=row.provider_call_id;
 let stopping:Promise<void>|null=null;
 let tickRunning=false,done!:()=>void;
 const finished=new Promise<void>(r=>{done=r;});
 const write=async(op:string,payload:Record<string,unknown>={})=>{row=await d.store.apply(row,op,payload);return row;};
 const expired=()=>Date.now()>=Math.min(Date.parse(row.expires_at),Date.parse(row.created_at)+300000);
 const stop=(reason:string):Promise<void>=>{
   if(stopping)return stopping;
   stopping=(async()=>{
     try{
       if(knownId){
         if(row.provider_call_id!==knownId)try{await write('quarantine',{error:reason,provider_call_id:knownId});}catch{}
         // An emergency hangup is still required if persistence/lease was lost.
         // The known identity is only from this claimed row or this create receipt.
         try{await write('termination',{state:'requested',error:reason});}catch{}
         let result:SalesTerminationResult;
         try{result=await (d.terminate??requestSalesTermination)({openaiCallId:knownId,mode:'hangup',requestId:`sales-${row.session_id}-${row.claim_token}`,fetchImpl:d.fetchImpl});}
         catch{result={confirmed:false,error:'provider_hangup_transport_unknown'};}
         console.info(JSON.stringify({event:'sales_provider_termination',session_id:row.session_id,confirmed:result.confirmed,...(result.receipt?{receipt:result.receipt}:{}),...(result.error?{error:result.error}:{} )}));
         try{await write('termination',{state:result.confirmed?'confirmed':'unknown',error:result.error??reason});}catch{}
       }else if(row.create_intent_at){await write('quarantine',{error:reason});}
       else{await write('fail',{error:reason});}
     }finally{socket?.close();done();}
   })();
   return stopping;
 };
 const aborted=()=>{void stop('runtime_shutdown').catch(()=>{});};
 d.signal?.addEventListener('abort',aborted,{once:true});
 let timer:ReturnType<typeof setInterval>|null=null;
 let deadline:ReturnType<typeof setTimeout>|null=null;
 try{
   if(row.provider_termination_state==='confirmed'||row.provider_termination_state==='expired')return;
   // Reclaimed calls are drained, not recreated or resumed with incomplete local evidence.
   if(knownId){await stop('recovered_session');return;}
   if(row.create_intent_at){await stop('recovered_create_unknown');return;}
   const heartbeat=await d.store.heartbeat(d.workerId);
   if(d.signal?.aborted||!heartbeat.enabled||row.stop_requested||expired()){await stop('session_unavailable');return;}
   deadline=setTimeout(()=>{void stop('session_deadline').catch(()=>{});},Math.max(0,Math.min(Date.parse(row.expires_at),Date.parse(row.created_at)+300000)-Date.now()));
   timer=setInterval(()=>{
    if(tickRunning||stopping)return;tickRunning=true;
    void (async()=>{
      const heartbeat=await d.store.heartbeat(d.workerId);await write('renew');
      if(!heartbeat.enabled||row.stop_requested||expired())await stop('session_limit_or_cancel');
    })().catch(()=>stop('runtime_heartbeat_failed')).catch(()=>{}).finally(()=>{tickRunning=false;});
   },d.tickMs??5000);
   const outcome=await (d.create??createSalesCall)(row.offer_sdp,row.request_id,d.fetchImpl,{
     beforeAttempt:async model=>{
       if(stopping||d.signal?.aborted||row.stop_requested||expired())throw new Error('sales_cancelled');
       await write('create_intent',{model});
     },
     rejected:async()=>{await write('provider_rejected',{error:'explicit_nonacceptance'});},
   });
   // Capture identity even if cancellation happened while provider POST was in flight.
   knownId=outcome.callId;
   if(outcome.outcome==='unknown'){
     await write('quarantine',{error:outcome.error,...(knownId?{provider_call_id:knownId}:{})});
     if(knownId){stopping=null;await stop('provider_create_unknown');}return;
   }
   if(outcome.outcome==='rejected'){if(!stopping)await stop('realtime_unavailable');return;}
   await write('provider_ready',{provider_call_id:knownId,answer_sdp:outcome.answer,model:outcome.model,ready:false});
   if(stopping||d.signal?.aborted||row.stop_requested||expired()){stopping=null;await stop('cancelled_after_create');return;}
   socket=await (d.attach??attachSalesSocket)(row,d.store,stop);
   if(stopping){socket.close();return;}
   await write('activate');
   if(row.stop_requested||row.status!=='ready'||expired()){await stop('cancelled_before_ready');return;}
   // The browser confirms its actual RTC connected state after applying the SDP.
   // Public ready stays available before this acknowledgement to avoid a deadlock.
   while(!stopping&&!row.client_connected_at){
     let poll:ReturnType<typeof setTimeout>|undefined;
     await Promise.race([finished,new Promise<void>(resolve=>{poll=setTimeout(resolve,d.tickMs??500);})]);
     if(poll)clearTimeout(poll);
     if(stopping)break;
     await write('renew');
     if(row.stop_requested||row.status!=='ready'||expired())await stop('cancelled_before_connected');
   }
   if(stopping)return;
   socket.greet();
   await finished;
 }catch{
   if(knownId&&stopping){stopping=null;}
   await stop('sales_runtime_failed').catch(()=>{});
 }finally{
   if(timer)clearInterval(timer);
   if(deadline)clearTimeout(deadline);
   d.signal?.removeEventListener('abort',aborted);
   socket?.close();
 }
}

export async function salesWorkerLoop(store:SalesStore,workerId:string,signal:AbortSignal) {
 while(!signal.aborted){
   try{
     await store.heartbeat(workerId);
     const row=await store.claim(workerId);
     if(row)await runSalesSession(row,{store,workerId,signal});
   }catch{console.error('sales_worker_cycle_failed');}
   if(!signal.aborted)await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,1000);signal.addEventListener('abort',finish,{once:true});});
 }
}
