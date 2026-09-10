import {createHash} from 'node:crypto';

export type LiveScope={tenantId:string;interviewId:string;callId:string;providerSessionId:string};
export type LiveFragment={eventId:string;speaker:'owner'|'assistant';text:string;startMs:number;endMs:number;arrival:number};
type Delegation={id:string;offsetMs:number;status:'pending'|'resolved'|'superseded';supersededBy?:string};
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Original fragments are evidence, not completed turns or permission to write. */
export function createLiveConversation(binding:LiveScope){
  if(![binding.tenantId,binding.interviewId,binding.callId,binding.providerSessionId].every(id))throw Error('live_scope_invalid');
  const scope={...binding},fragments:LiveFragment[]=[],events=new Map<string,string>(),delegations=new Map<string,Delegation>();
  function observe(event:Record<string,any>){
    const isInput=event.type==='session.input_transcript.delta',isOutput=event.type==='session.output_transcript.delta';
    const isDelegation=event.type==='session.delegation.created'&&event.delegation?.target==='client';
    if(!isInput&&!isOutput&&!isDelegation)return;
    if(!id(event.event_id))throw Error('live_event_identity_missing');
    // Compare only the actual contract, not optional transport/debug properties.
    const payload=isDelegation?[event.type,event.delegation?.id,event.delegation?.type,event.offset_ms]
      :[event.type,event.delta,event.start_ms,event.end_ms];
    const digest=hash(payload),prior=events.get(event.event_id);
    if(prior){if(prior!==digest)throw Error('live_event_conflict');return;}
    if(isDelegation){
      if(!id(event.delegation.id)||event.delegation.type!=='delegation'||!time(event.offset_ms))throw Error('live_delegation_invalid');
      const existing=delegations.get(event.delegation.id);
      if(existing&&existing.offsetMs!==event.offset_ms)throw Error('live_delegation_conflict');
      if(!existing)delegations.set(event.delegation.id,{id:event.delegation.id,offsetMs:event.offset_ms,status:'pending'});
    }else{
      if(typeof event.delta!=='string'||!time(event.start_ms)||!time(event.end_ms)||event.end_ms<event.start_ms)throw Error('live_transcript_invalid');
      if(event.delta.length)fragments.push({eventId:event.event_id,speaker:isInput?'owner':'assistant',text:event.delta,
        startMs:event.start_ms,endMs:event.end_ms,arrival:fragments.length});
    }
    events.set(event.event_id,digest);
  }
  function required(delegationId:string){const d=delegations.get(delegationId);if(!d)throw Error('live_delegation_unknown');return d;}
  return{
    observe,
    pending:()=>[...delegations.values()].filter(d=>d.status==='pending').map(d=>d.id),
    forDelegation(delegationId:string){
      const d=delegations.get(delegationId);
      if(!d||!fragments.some(f=>f.speaker==='owner'))return null;
      // Late transcript delivery must be included. Do not cut context at offsetMs
      // or replace the latest fragment with an invented utterance/task payload.
      return{scope:{...scope},delegation:{...d},fragments:fragments.map(f=>({...f})).sort((a,b)=>a.startMs-b.startMs||a.arrival-b.arrival)};
    },
    resolve(delegationId:string){const d=required(delegationId);if(d.status==='pending')d.status='resolved';},
    supersede(delegationId:string,replacementId:string){
      if(delegationId===replacementId)throw Error('live_supersession_invalid');
      const d=required(delegationId);required(replacementId);d.status='superseded';d.supersededBy=replacementId;
    },
  };
}

/** Persist this reference with the effect and reuse it when reconciling retries.
 * A delegation ID requests work; it is deliberately not a new operation ID.
 */
export function liveOperationReference(input:{scope:LiveScope;kind:string;targetIds:string[];sourceEventIds:string[];interpretation:string}){
  const s=input.scope;
  if(![s.tenantId,s.interviewId,s.callId,s.providerSessionId,input.kind].every(id)||!input.targetIds.length||!input.sourceEventIds.length
    ||!input.targetIds.every(id)||!input.sourceEventIds.every(id)||typeof input.interpretation!=='string'||!input.interpretation.trim())throw Error('live_operation_invalid');
  return'ligou-live-op:'+hash([1,s.tenantId,s.interviewId,s.callId,s.providerSessionId,input.kind,
    [...new Set(input.targetIds)].sort(),[...new Set(input.sourceEventIds)].sort()]);
}
