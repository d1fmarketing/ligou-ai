import { createHash } from "node:crypto";
import { speechActionIsInternallyValid, speechPayloadIsInternallyValid, type OnboardingSpeechAction, type OnboardingSpeechPayload } from "./onboarding-speech.ts";
import type { InterviewScope } from "./onboarding-agenda-store.ts";

type Client = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> };
export interface SpeechClaim {
  status: "preparing" | "ready" | "played" | "failed" | "superseded";
  claimed: boolean; action: OnboardingSpeechAction; payload?: OnboardingSpeechPayload | null;
  noticeId: string; receiptId?: string | null;
}
export interface InterviewSummaryProof { summaryId: string; summaryHash: string; revision: number; digest: string; parts: string[]; receiptId: string }
export function createInterviewEvidenceStore(client: Client) {
  const scope = (s: InterviewScope) => ({ p_owner: s.ownerId, p_call: s.callId, p_request: s.requestId });
  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.rpc(name,args);
    if (r.error || !r.data) throw new Error(r.error?.message ?? "Interview evidence proof missing");
    return r.data;
  }
  function speechResult(value: unknown, action?: OnboardingSpeechAction): SpeechClaim {
    const r = value as SpeechClaim;
    if (!r || !["preparing","ready","played","failed","superseded"].includes(r.status) || !speechActionIsInternallyValid(r.action) || (action && JSON.stringify(r.action) !== JSON.stringify(action) && Object.keys(action).some(k=>r.action[k as keyof OnboardingSpeechAction] !== action[k as keyof OnboardingSpeechAction]))) throw new Error("Invalid persisted speech action");
    if ((r.status === "ready" || r.status === "played") && !speechPayloadIsInternallyValid(r.payload,r.action)) throw new Error("Invalid persisted speech payload");
    return r;
  }
  return {
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
