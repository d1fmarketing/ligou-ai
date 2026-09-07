import { createHash } from "node:crypto";
import { speechActionIsInternallyValid, speechPayloadIsInternallyValid, type OnboardingSpeechAction, type OnboardingSpeechPayload } from "./onboarding-speech.ts";
import type { InterviewScope } from "./onboarding-agenda-store.ts";
import type { AgendaProposal } from "./onboarding-agenda.ts";
import {streamAuthorizationIsValid,streamMediaEvidenceIsValid,STREAM_UUID,type StreamAuthorization,type StreamProof,type StreamMediaEvidence} from './onboarding-stream.ts';

type Client = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string;code?:string } | null;status?:number }> };
export interface SpeechClaim {
  status: "preparing" | "ready" | "played" | "failed" | "superseded";
  claimed: boolean; action: OnboardingSpeechAction; payload?: OnboardingSpeechPayload | null;
  noticeId: string; receiptId?: string | null;
  resumedFromActionId?: string; providerItemId?: string; rendition?: number; interruptionReceiptId?: string;
}
export interface SpeechInterruptionProof { callId: string; actionId: string; providerItemId: string; status: "superseded"; receiptId: string; replayed: boolean }
export interface EmptyInputProof { receiptId: string; callId: string; actionId: string; providerItemId: string; replayed: boolean }
export interface InterviewAmendmentProof { receiptId: string; interviewId: string; callId: string; approvalReceiptId: string; providerItemId: string; proposal: Extract<AgendaProposal,{kind:"correction"}>; state: "pending_amendment"; replayed: boolean }
export interface InterviewSummaryProof { summaryId: string; summaryHash: string; revision: number; digest: string; parts: string[]; receiptId: string }
export function createInterviewEvidenceStore(client: Client) {
  const scope = (s: InterviewScope) => ({ p_owner: s.ownerId, p_call: s.callId, p_request: s.requestId });
  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.rpc(name,args);
    if (r.error || !r.data) throw Object.assign(new Error(r.error?.message ?? "Interview evidence proof missing"),{code:r.error?.code,status:r.status});
    return r.data;
  }
  function speechResult(value: unknown, action?: OnboardingSpeechAction): SpeechClaim {
    const r = value as SpeechClaim;
    if (!r || !["preparing","ready","played","failed","superseded"].includes(r.status) || !speechActionIsInternallyValid(r.action) || (action && JSON.stringify(r.action) !== JSON.stringify(action) && Object.keys(action).some(k=>r.action[k as keyof OnboardingSpeechAction] !== action[k as keyof OnboardingSpeechAction]))) throw new Error("Invalid persisted speech action");
    if ((r.status === "ready" || r.status === "played") && !speechPayloadIsInternallyValid(r.payload,r.action)) throw new Error("Invalid persisted speech payload");
    return r;
  }
  return {
    async claimStream(input:InterviewScope&{action:OnboardingSpeechAction;summaryId?:string;partIndex?:number;clarificationTurnId?:string}):Promise<StreamAuthorization>{
      const r=await rpc('claim_website_interview_stream',{...scope(input),p_action:input.action,p_summary:input.summaryId??null,p_part:input.partIndex??null,p_clarification_turn:input.clarificationTurnId??null});
      if(!streamAuthorizationIsValid(r,input.action))throw new Error('stream_authorization_invalid');return r;
    },
    async authorizeStream(input:InterviewScope&{stream:StreamAuthorization}):Promise<StreamAuthorization>{
      const r=await rpc('authorize_website_interview_stream',{...scope(input),p_action:input.stream.action.actionId,p_dispatch:input.stream.dispatchId});
      if(!streamAuthorizationIsValid(r,input.stream.action)||r.dispatchId!==input.stream.dispatchId||r.receiptId!==input.stream.receiptId)throw new Error('stream_authorization_changed');return r;
    },
    async recordStreamResponse(input:InterviewScope&{stream:StreamAuthorization;responseId:string;itemId:string;transcript:string;status:'completed'}):Promise<StreamProof>{
      return streamProof(await rpc('record_website_interview_stream_response',{...scope(input),p_action:input.stream.action.actionId,p_dispatch:input.stream.dispatchId,
        p_response:input.responseId,p_item:input.itemId,p_transcript:input.transcript,p_status:input.status}),input);
    },
    async recordStreamPlayout(input:InterviewScope&{stream:StreamAuthorization;responseId:string;itemId:string;bufferStoppedEventId:string;mediaEvidence:StreamMediaEvidence}):Promise<StreamProof>{
      if(!streamMediaEvidenceIsValid(input.mediaEvidence))throw new Error('stream_media_evidence_invalid');
      return streamProof(await rpc('record_website_interview_stream_playout',{...scope(input),p_action:input.stream.action.actionId,p_dispatch:input.stream.dispatchId,
        p_response:input.responseId,p_item:input.itemId,p_buffer_event:input.bufferStoppedEventId,p_media_evidence:input.mediaEvidence}),input);
    },
    async resumeStream(input:InterviewScope&{actionId:string;providerItemId:string|null}):Promise<StreamAuthorization>{
      const r=await rpc('resume_website_interview_stream',{...scope(input),p_action:input.actionId,p_item:input.providerItemId});
      if(!streamAuthorizationIsValid(r)||r.action.callId!==input.callId||r.action.actionId===input.actionId)throw new Error('stream_resume_invalid');return r;
    },
    async prepareSummary(input: InterviewScope & { summaryId: string; expectedRevision: number; expectedStoreVersion: number; expectedDigest: string; expectedReceiptId: string; parts: string[] }): Promise<InterviewSummaryProof> {
      const r = await rpc("prepare_website_interview_summary",{...scope(input),p_summary:input.summaryId,p_revision:input.expectedRevision,p_store_version:input.expectedStoreVersion,p_digest:input.expectedDigest,p_receipt:input.expectedReceiptId,p_parts:input.parts});
      const expected=createHash("sha256").update(JSON.stringify([input.summaryId,input.expectedRevision,input.expectedDigest,input.parts])).digest("hex");
      if (r.summaryId!==input.summaryId || r.summaryHash!==expected || r.revision!==input.expectedRevision || r.digest!==input.expectedDigest || JSON.stringify(r.parts)!==JSON.stringify(input.parts)) throw new Error("Summary proof mismatch");
      return r;
    },
    async claimSpeech(input: InterviewScope & { action: OnboardingSpeechAction; summaryId?: string; partIndex?: number; clarificationTurnId?: string }): Promise<SpeechClaim> {
      if (!speechActionIsInternallyValid(input.action)) throw new Error("Invalid speech action");
      return speechResult(await rpc("claim_website_interview_speech",{...scope(input),p_action:input.action,p_summary:input.summaryId??null,p_part:input.partIndex??null,p_clarification_turn:input.clarificationTurnId??null}),input.action);
    },
    async completeSpeech(input: InterviewScope & { actionId: string; payload: OnboardingSpeechPayload }): Promise<SpeechClaim> {
      const p=input.payload;
      const action={actionId:p.actionId,interviewId:p.interviewId,callId:p.callId,revision:p.revision,kind:p.kind,text:p.text,sourceDigest:p.sourceDigest};
      if (input.actionId!==p.actionId || !speechPayloadIsInternallyValid(p,action)) throw new Error("Invalid speech payload");
      return speechResult(await rpc("complete_website_interview_speech",{...scope(input),p_action:input.actionId,p_payload:p}),action);
    },
    async failSpeech(input: InterviewScope & { actionId: string; reason: string }): Promise<SpeechClaim> {
      return speechResult(await rpc("fail_website_interview_speech",{...scope(input),p_action:input.actionId,p_reason:input.reason}));
    },
    async interruptSpeech(input: InterviewScope & { actionId: string; providerItemId: string }): Promise<SpeechInterruptionProof> {
      const r = await rpc("interrupt_website_interview_speech", {...scope(input),p_action:input.actionId,p_item:input.providerItemId});
      if (r.callId!==input.callId || r.actionId!==input.actionId || r.providerItemId!==input.providerItemId || r.status!=="superseded" || typeof r.receiptId!=="string" || !/^[0-9a-f-]{36}$/i.test(r.receiptId)) throw new Error("Invalid interruption proof");
      return r;
    },
    async recordEmptyInput(input: InterviewScope & { actionId: string; providerItemId: string }): Promise<EmptyInputProof> {
      const r = await rpc("record_website_interview_empty_input", {...scope(input),p_action:input.actionId,p_item:input.providerItemId});
      if (r.callId!==input.callId || r.actionId!==input.actionId || r.providerItemId!==input.providerItemId || typeof r.receiptId!=="string" || !/^[0-9a-f-]{36}$/i.test(r.receiptId)) throw new Error("Invalid empty input proof");
      return r;
    },
    async resumeSpeech(input: InterviewScope & { actionId: string; providerItemId: string }): Promise<SpeechClaim> {
      const r = speechResult(await rpc("resume_website_interview_speech", {...scope(input),p_action:input.actionId,p_item:input.providerItemId}));
      if (r.action.callId!==input.callId || r.action.actionId===input.actionId || r.resumedFromActionId!==input.actionId || r.providerItemId!==input.providerItemId || ![1,2].includes(r.rendition??0) || !r.interruptionReceiptId) throw new Error("Invalid resumed speech proof");
      return r;
    },
    async requestAmendment(input: InterviewScope & { approvalReceiptId: string; providerItemId: string; proposal: Extract<AgendaProposal,{kind:"correction"}> }): Promise<InterviewAmendmentProof> {
      const r = await rpc("request_website_interview_amendment", {...scope(input),p_approval:input.approvalReceiptId,p_item:input.providerItemId,p_proposal:input.proposal});
      const targets=(p: typeof input.proposal)=>JSON.stringify([p.kind,(p.affectedItems??[]).map(x=>[x.itemId,x.disposition]),(p.affectedCandidates??[]).map(x=>[x.candidateId,x.disposition])]);
      if (r.callId!==input.callId || r.approvalReceiptId!==input.approvalReceiptId || r.providerItemId!==input.providerItemId || r.state!=="pending_amendment" || !r.receiptId || !r.interviewId || !r.proposal || targets(r.proposal)!==targets(input.proposal)) throw new Error("Invalid amendment proof");
      return r;
    },
    async recordSpeechPlayed(input: InterviewScope & { actionId: string; assistantItemId: string; assistantText: string; textSha256: string; audioSha256: string }) {
      return rpc("record_website_interview_speech_played",{...scope(input),p_action:input.actionId,p_assistant_item:input.assistantItemId,p_assistant_text:input.assistantText,p_text_hash:input.textSha256,p_audio_hash:input.audioSha256});
    },
    async approveSummary(input: InterviewScope & { summaryId: string; summaryHash: string; providerItemId: string; expectedRevision: number; expectedStoreVersion: number; expectedDigest: string }) {
      return rpc("approve_website_interview_summary",{...scope(input),p_summary:input.summaryId,p_summary_hash:input.summaryHash,p_item:input.providerItemId,p_revision:input.expectedRevision,p_store_version:input.expectedStoreVersion,p_digest:input.expectedDigest});
    },
    async recordCompletion(input: InterviewScope & { outcome: "complete" | "unfinished"; approvalReceiptId?: string }) {
      return rpc("record_website_interview_completion",{...scope(input),p_outcome:input.outcome,p_approval:input.approvalReceiptId??null});
    },
  };
}

function streamProof(value:unknown,input:{stream:StreamAuthorization;responseId:string;itemId:string}):StreamProof{
  const r=value as StreamProof;
  if(!r||r.actionId!==input.stream.action.actionId||r.dispatchId!==input.stream.dispatchId||r.responseId!==input.responseId||r.itemId!==input.itemId
    ||!['preparing','ready','played','rejected'].includes(r.status))throw new Error('stream_proof_mismatch');
  if(['ready','played','rejected'].includes(r.status)&&!STREAM_UUID.test(r.generationReceiptId??''))throw new Error('stream_generation_receipt_missing');
  if(r.status==='preparing'&&!STREAM_UUID.test(r.playoutReceiptId??''))throw new Error('stream_client_receipt_missing');
  if(r.status==='played'&&(!STREAM_UUID.test(r.playoutReceiptId??'')||!STREAM_UUID.test(r.receiptId??'')
    ||new Set([r.generationReceiptId,r.playoutReceiptId,r.receiptId]).size!==3))throw new Error('stream_playout_join_missing');
  if(r.status==='rejected'&&r.reason!=='transcript_mismatch')throw new Error('stream_rejection_invalid');
  return r;
}
