import {createHash} from 'node:crypto';

export type LiveScope={tenantId:string;interviewId:string;callId:string;providerSessionId:string};
export type LiveFragment={eventId:string;speaker:'owner'|'assistant';text:string;startMs:number;endMs:number;arrival:number};
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Evidence for business operations/consent only. Managed Responses owns the
 * conversational context. This collector never schedules work or controls audio. */
export function createLiveEvidence(binding:LiveScope){
  if(![binding.tenantId,binding.interviewId,binding.callId,binding.providerSessionId].every(id))throw Error('live_scope_invalid');
  const fragments:LiveFragment[]=[],events=new Map<string,string>();
  return{
    observe(event:Record<string,any>){
      const owner=event.type==='session.input_transcript.delta';
      if(!owner&&event.type!=='session.output_transcript.delta')return;
      if(!id(event.event_id))throw Error('live_event_identity_missing');
      if(typeof event.delta!=='string'||!time(event.start_ms)||!time(event.end_ms)||event.end_ms<event.start_ms)throw Error('live_transcript_invalid');
      const value=JSON.stringify([event.type,event.delta,event.start_ms,event.end_ms]),prior=events.get(event.event_id);
      if(prior){if(prior!==value)throw Error('live_event_conflict');return;}
      events.set(event.event_id,value);
      if(event.delta.length)fragments.push({eventId:event.event_id,speaker:owner?'owner':'assistant',text:event.delta,startMs:event.start_ms,endMs:event.end_ms,arrival:fragments.length});
    },
    fragments:()=>fragments.map(f=>({...f})).sort((a,b)=>a.startMs-b.startMs||a.arrival-b.arrival),
  };
}

/** Persist the operation reference separately from provider event/delegation IDs.
 * The store checks payload conflicts, including a changed interpretation on retry. */
export function liveOperationReference(input:{scope:LiveScope;kind:string;targetIds:string[];sourceEventIds:string[];interpretation:string}){
  const s=input.scope;
  if(![s.tenantId,s.interviewId,s.callId,s.providerSessionId,input.kind].every(id)||!input.targetIds.length||!input.sourceEventIds.length
    ||!input.targetIds.every(id)||!input.sourceEventIds.every(id)||typeof input.interpretation!=='string'||!input.interpretation.trim())throw Error('live_operation_invalid');
  return'ligou-live-op:'+hash([1,s.tenantId,s.interviewId,s.callId,s.providerSessionId,input.kind,
    [...new Set(input.targetIds)].sort(),[...new Set(input.sourceEventIds)].sort()]);
}
