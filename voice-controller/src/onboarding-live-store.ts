import { onboardingAgendaDigest, type InterviewScope, type StoredWebsiteInterview } from './onboarding-agenda-store.ts';
import { parseOnboardingAgenda, type AgendaBinding } from './onboarding-agenda.ts';
import { liveOperationReference, type LiveFragment, type LiveScope } from './onboarding-live-context.ts';

export type LiveBusinessRpcClient = { rpc(name:string,args:Record<string,unknown>):PromiseLike<{data:unknown;error:{message?:string;code?:string}|null;status?:number}> };
export type LiveDecisionKind = 'answer'|'correction'|'defer'|'not_applicable'|'reopen';
export type LiveBusinessScope = InterviewScope & LiveScope;
export type LiveDecision = {kind:LiveDecisionKind;targetId:string;sourceEventIds:string[];interpretation:string};
export type LiveOperationProof = {operationRef:string;operationReceiptId:string;operationRevision:number;kind:LiveDecisionKind;
  targetId:string;sourceEventIds:string[];interpretation:string;providerSessionId:string};
export type LiveDecisionReadback = StoredWebsiteInterview & Pick<LiveOperationProof,'operationRef'|'operationReceiptId'|'operationRevision'>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ref=/^ligou-live-op:[a-f0-9]{64}$/;
const kinds=new Set(['answer','correction','defer','not_applicable','reopen']);
const object=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** PostgREST rolls back an RPC transaction on a database error. An explicit
 * SQL rejection is distinct from losing the response after a possible commit.
 * https://docs.postgrest.org/en/v12/references/transactions.html#aborting-transactions
 */
export class LivePersistenceError extends Error {
  readonly operationRejected:boolean;
  constructor(message:string,readonly code:string|undefined,readonly status:number|undefined){
    super(message);
    this.operationRejected=typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)&&!code.startsWith('08');
  }
}

/** Business readback integrity only: this never validates or authorizes speech. */
export function parseLiveInterviewReadback(value:unknown,binding:AgendaBinding):StoredWebsiteInterview {
  if(!object(value)||!object(value.agenda))throw Error('live_readback_invalid');
  const agenda=parseOnboardingAgenda(value.agenda,binding);
  if(value.revision!==agenda.revision||value.digest!==onboardingAgendaDigest(agenda)||!Number.isSafeInteger(value.storeVersion)||value.storeVersion<0
    ||!uuid.test(value.receiptId)||!['unfinished','reviewing','closing','complete'].includes(value.state)||!object(value.nextAction))throw Error('live_readback_proof_invalid');
  return{agenda,revision:value.revision,storeVersion:value.storeVersion,digest:value.digest,receiptId:value.receiptId,nextAction:value.nextAction as StoredWebsiteInterview['nextAction'],state:value.state,replayed:value.replayed===true};
}

export function createLiveInterviewStore(client:LiveBusinessRpcClient,scope:LiveBusinessScope,binding:AgendaBinding){
  if(![scope.ownerId,scope.tenantId,scope.interviewId,scope.callId,scope.requestId].every(id=>uuid.test(id))
    ||scope.callId!==binding.callId||scope.interviewId!==binding.interviewId||!scope.providerSessionId?.trim())throw Error('live_store_scope_invalid');
  const actor={p_owner:scope.ownerId,p_call:scope.callId,p_request:scope.requestId};
  async function rpc(name:string,args:Record<string,unknown>,missing=false){
    const response=await client.rpc(name,args);
    if(response.error)throw new LivePersistenceError(response.error.message??'live_persistence_failed',response.error.code,response.status);
    if(response.data===null&&missing)return null;
    if(!response.data)throw Error('live_persistence_proof_missing');
    return response.data;
  }
  function verifyOperation(raw:unknown,operationRef:string):LiveOperationProof {
    if(!object(raw)||raw.operationRef!==operationRef||!uuid.test(raw.operationReceiptId)||!Number.isSafeInteger(raw.operationRevision)||raw.operationRevision<1
      ||raw.providerSessionId!==scope.providerSessionId||!kinds.has(raw.kind)||typeof raw.targetId!=='string'||!Array.isArray(raw.sourceEventIds)
      ||!raw.sourceEventIds.length||!raw.sourceEventIds.every((id:unknown)=>typeof id==='string'&&id.length>0)||typeof raw.interpretation!=='string'
      ||liveOperationReference({scope,kind:raw.kind,targetIds:[raw.targetId],sourceEventIds:raw.sourceEventIds,interpretation:raw.interpretation})!==operationRef)throw Error('live_operation_proof_invalid');
    return{operationRef,operationReceiptId:raw.operationReceiptId,operationRevision:raw.operationRevision,kind:raw.kind,targetId:raw.targetId,
      sourceEventIds:[...raw.sourceEventIds],interpretation:raw.interpretation,providerSessionId:raw.providerSessionId};
  }
  return{
    read:async()=>parseLiveInterviewReadback(await rpc('read_website_interview',actor),binding),
    async recordFragments(fragments:readonly LiveFragment[]){
      if(fragments.length>512)throw Error('live_fragment_batch_too_large');
      const data=await rpc('record_website_live_fragments',{...actor,p_session:scope.providerSessionId,
        p_fragments:fragments.map(({eventId,speaker,text,startMs,endMs})=>({eventId,speaker,text,startMs,endMs}))});
      if(!object(data)||data.callId!==scope.callId||data.providerSessionId!==scope.providerSessionId||!Number.isSafeInteger(data.added)||data.added<0||data.added>fragments.length)throw Error('live_fragment_receipt_invalid');
    },
    async readOperation(operationRef:string,expected?:LiveDecision){
      if(!ref.test(operationRef))throw Error('live_operation_reference_invalid');
      const data=await rpc('read_website_live_operation',{...actor,p_operation:operationRef},true);
      if(data===null)return null;
      const proof=verifyOperation(data,operationRef);
      if(expected&&(!same([...new Set(expected.sourceEventIds)].sort(),[...proof.sourceEventIds].sort())||proof.kind!==expected.kind
        ||proof.targetId!==expected.targetId||proof.interpretation!==expected.interpretation))throw Error('live_operation_payload_conflict');
      return proof;
    },
    async commit(snapshot:StoredWebsiteInterview,decision:LiveDecision):Promise<LiveDecisionReadback>{
      const operationRef=liveOperationReference({scope,kind:decision.kind,targetIds:[decision.targetId],sourceEventIds:decision.sourceEventIds,interpretation:decision.interpretation});
      const raw=await rpc('commit_website_live_decision',{...actor,p_session:scope.providerSessionId,p_operation:operationRef,
        p_revision:snapshot.revision,p_store_version:snapshot.storeVersion,p_digest:snapshot.digest,p_kind:decision.kind,p_target:decision.targetId,
        p_source_ids:[...new Set(decision.sourceEventIds)].sort(),p_interpretation:decision.interpretation});
      const stored=parseLiveInterviewReadback(raw,binding);
      if(!object(raw)||raw.operationRef!==operationRef||!uuid.test(raw.operationReceiptId)||!Number.isSafeInteger(raw.operationRevision)||raw.operationRevision<1||raw.operationRevision>stored.revision)throw Error('live_operation_readback_invalid');
      const evidence=stored.agenda.ownerTurns[raw.operationRevision-1];
      const target=[...stored.agenda.items,...stored.agenda.candidateOverrides].find(item=>item.id===decision.targetId);
      if(evidence?.turnId!==`${scope.callId}:${operationRef}`||evidence.text!==decision.interpretation||evidence.provenance!=='model_interpretation'
        ||!target?.evidence.some(item=>same(item,evidence)))throw Error('live_operation_evidence_mismatch');
      return{...stored,operationRef,operationReceiptId:raw.operationReceiptId,operationRevision:raw.operationRevision};
    },
  };
}
