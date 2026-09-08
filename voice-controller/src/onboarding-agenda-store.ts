import { createHash } from "node:crypto";
import { parseOnboardingAgenda, getAgendaAction, websiteTerritoryConfirmation, type OnboardingAgenda, type AgendaAction, type AgendaProposal } from "./onboarding-agenda.ts";

export interface InterviewScope { ownerId: string; callId: string; requestId: string; signal?: AbortSignal }
export interface FreshWebsiteInterviewPreparation {
  preparationId: string; ownerId: string; expectedTenantId: string; expectedGeneration: number;
  priorCallId: string; draftId: string; draftHash: string; sourceResultId: string; sourceResultHash: string;
}
export interface StoredWebsiteInterview {
  agenda: OnboardingAgenda; revision: number; storeVersion: number; digest: string; receiptId: string;
  nextAction: AgendaAction; state: "unfinished" | "reviewing" | "closing" | "complete"; replayed: boolean;
}
export interface StoredNativeOwnerTurn extends StoredWebsiteInterview { operationReceiptId: string; operationRevision: number }
export interface StoredRecordedOwnerTurn extends StoredWebsiteInterview { operationReceiptId: string; operationRevision: number }
export interface NativeOwnerTurnInput extends InterviewScope { providerItemId: string; proposal: AgendaProposal; interpretation: string; facts?: readonly Record<string, unknown>[] }
type RpcResult = { data: unknown; error: { message?: string; code?: string } | null; status?: number };
type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcResult> & { abortSignal?(signal: AbortSignal): PromiseLike<RpcResult> } };
const MAX_BYTES = 2 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function onboardingAgendaDigest(agenda: OnboardingAgenda): string {
  return createHash("sha256").update(canonical(agenda)).digest("hex");
}
function scoped(input: InterviewScope) {
  if (![input.ownerId, input.callId, input.requestId].every(id => uuid.test(id))) throw new Error("Invalid interview scope");
  return { p_owner: input.ownerId, p_call: input.callId, p_request: input.requestId };
}
function checkedAgenda(value: OnboardingAgenda): OnboardingAgenda {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error("Interview agenda byte limit");
  return parseOnboardingAgenda(value, value.binding);
}
function readback(value: unknown, callId: string): StoredWebsiteInterview {
  const raw = value as Record<string, any>;
  if (!raw?.agenda?.binding || raw.agenda.binding.callId !== callId) throw new Error("Interview call binding mismatch");
  const agenda = checkedAgenda(raw.agenda);
  if (raw.digest !== onboardingAgendaDigest(agenda) || raw.revision !== agenda.revision || !Number.isSafeInteger(raw.storeVersion) || raw.storeVersion < 0 || !uuid.test(raw.receiptId)) throw new Error("Interview readback proof mismatch");
  if (!["unfinished", "reviewing", "closing", "complete"].includes(raw.state)) throw new Error("Invalid interview state");
  const current = getAgendaAction(agenda);
  const prefixes: Record<AgendaAction["type"], string> = {
    ASK_NEXT_GAP: "", CLARIFY_CURRENT_GAP: "Para esclarecer: ", CONFIRM_AND_ASK_NEXT: websiteTerritoryConfirmation(agenda),
    DEFER_OFF_SCOPE_AND_CONTINUE: "Podemos tratar disso depois; agora vamos concluir sua configuração. ",
    GENERATE_FINAL_SUMMARY: "Vou preparar o resumo para sua revisão.", HANDLE_OWNER_CORRECTION: "Registrei sua correção. ",
  };
  const type = raw.nextAction?.type as AgendaAction["type"];
  if (!Object.hasOwn(prefixes, type) || raw.nextAction?.itemId !== current.itemId || raw.nextAction?.questionPt !== current.questionPt) throw new Error("Interview next action mismatch");
  const b = agenda.binding;
  const actionId = createHash("sha256").update(JSON.stringify([1,b.interviewId,b.callId,b.draftId,b.draftHash,b.sourceResultId,b.sourceResultHash,agenda.revision,current.itemId ?? null,type])).digest("hex");
  const spokenPt = prefixes[type] + (current.questionPt ?? (type === "GENERATE_FINAL_SUMMARY" ? "" : "Vou preparar o resumo para sua revisão."));
  // Existing persisted actions retain their original generic acknowledgment;
  // accepting that exact historical form does not rewrite its receipt or words.
  const legacySpokenPt = "Obrigado, registrei sua resposta. " + (current.questionPt ?? "Vou preparar o resumo para sua revisão.");
  const legacy = type === "CONFIRM_AND_ASK_NEXT" && raw.nextAction.spokenPt === legacySpokenPt;
  if (raw.nextAction.actionId !== actionId || (raw.nextAction.spokenPt !== spokenPt && !legacy)) throw new Error("Interview action proof mismatch");
  const nextAction: AgendaAction = Object.freeze({ ...raw.nextAction });
  return { agenda, revision: agenda.revision, storeVersion: raw.storeVersion, digest: raw.digest, receiptId: raw.receiptId, nextAction, state: raw.state, replayed: raw.replayed === true };
}
export function createOnboardingAgendaStore(client: RpcClient) {
  async function rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal, allowMissing=false) {
    signal?.throwIfAborted();
    const request = client.rpc(name, args);
    const result = await (signal && request.abortSignal ? request.abortSignal(signal) : request);
    if (result.error) throw Object.assign(new Error(result.error.message ?? "Interview persistence failed"), { code: result.error.code, status: result.status });
    if(allowMissing && result.data===null)return null;
    if (!result.data) throw new Error("Interview persistence returned no proof");
    return result.data;
  }
  function nativeArgs(input:NativeOwnerTurnInput) {
    if(!input.providerItemId?.trim() || input.providerItemId.length>400 || typeof input.interpretation!=='string'
      || !input.interpretation.trim() || input.interpretation.length>32768)throw new Error('Invalid native interpretation');
    return{...scoped(input),p_item:input.providerItemId,p_interpretation:input.interpretation,p_proposal:input.proposal,p_facts:input.facts??[]};
  }
  function nativeReadback(value:unknown,input:NativeOwnerTurnInput):StoredNativeOwnerTurn {
    const stored=readback(value,input.callId),raw=value as Record<string,unknown>;
    const index=stored.agenda.ownerTurns.findIndex(t=>t.turnId===`${input.callId}:${input.providerItemId}`);
    const turn=stored.agenda.ownerTurns[index];
    if(!turn || turn.text!==input.interpretation || turn.provenance!=='model_interpretation'
      || typeof raw.operationReceiptId!=='string' || !uuid.test(raw.operationReceiptId) || raw.operationRevision!==index+1)
      throw new Error('Native operation proof mismatch');
    return{...stored,operationReceiptId:raw.operationReceiptId,operationRevision:index+1};
  }
  return {
    async recoverRecordedOwnerTurn(input:InterviewScope&{providerItemId:string;expectedRevision:number;expectedStoreVersion:number;expectedDigest:string;agenda:OnboardingAgenda}):Promise<StoredRecordedOwnerTurn> {
      const agenda=checkedAgenda(input.agenda),expectedTurn=agenda.ownerTurns.at(-1);
      if(!input.providerItemId?.trim() || input.providerItemId.length>400 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0
        || !Number.isSafeInteger(input.expectedStoreVersion) || input.expectedStoreVersion<0 || !/^[a-f0-9]{64}$/.test(input.expectedDigest)
        || agenda.revision!==input.expectedRevision+1 || agenda.binding.callId!==input.callId
        || expectedTurn?.turnId!==`${input.callId}:${input.providerItemId}` || expectedTurn.provenance!==undefined)
        throw new Error('Recorded recovery binding mismatch');
      const raw=await rpc('recover_website_interview_recorded_turn',{...scoped(input),p_revision:input.expectedRevision,p_store_version:input.expectedStoreVersion,
        p_digest:input.expectedDigest,p_item:input.providerItemId,p_agenda:agenda},input.signal) as Record<string,unknown>;
      const stored=readback(raw,input.callId),index=stored.agenda.ownerTurns.findIndex(turn=>turn.turnId===expectedTurn.turnId),turn=stored.agenda.ownerTurns[index];
      if(!turn || turn.text!==expectedTurn.text || turn.provenance!==undefined || typeof raw.operationReceiptId!=='string' || !uuid.test(raw.operationReceiptId)
        || raw.operationRevision!==input.expectedRevision+1 || raw.operationRevision!==index+1)throw new Error('Recorded recovery operation proof mismatch');
      return{...stored,operationReceiptId:raw.operationReceiptId,operationRevision:index+1};
    },
    async commitNativeOwnerTurn(input:NativeOwnerTurnInput&{expectedRevision:number;expectedStoreVersion:number;expectedDigest:string;agenda:OnboardingAgenda}):Promise<StoredNativeOwnerTurn> {
      const args=nativeArgs(input),agenda=checkedAgenda(input.agenda);
      const turn=agenda.ownerTurns.at(-1);
      if(!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0 || !Number.isSafeInteger(input.expectedStoreVersion) || input.expectedStoreVersion<0
        || !/^[a-f0-9]{64}$/.test(input.expectedDigest) || agenda.revision!==input.expectedRevision+1
        || turn?.turnId!==`${input.callId}:${input.providerItemId}` || turn.text!==input.interpretation || turn.provenance!=='model_interpretation')
        throw new Error('Native interpretation binding mismatch');
      return nativeReadback(await rpc('commit_website_interview_native_turn',{...args,p_revision:input.expectedRevision,p_store_version:input.expectedStoreVersion,p_digest:input.expectedDigest,p_agenda:agenda},input.signal),input);
    },
    async replayNativeOwnerTurn(input:NativeOwnerTurnInput):Promise<StoredNativeOwnerTurn|null> {
      const result=await rpc('replay_website_interview_native_turn',nativeArgs(input),input.signal,true);
      return result===null?null:nativeReadback(result,input);
    },
    async prepareFreshWebsiteInterview(input: FreshWebsiteInterviewPreparation) {
      if (![input.preparationId, input.ownerId, input.expectedTenantId, input.priorCallId, input.draftId, input.sourceResultId].every(id => uuid.test(id)) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) throw new Error("Invalid interview preparation");
      return rpc("prepare_fresh_website_interview", { p_preparation: input.preparationId, p_owner: input.ownerId, p_expected_tenant: input.expectedTenantId, p_generation: input.expectedGeneration, p_prior_call: input.priorCallId, p_draft: input.draftId, p_draft_hash: input.draftHash, p_result: input.sourceResultId, p_result_hash: input.sourceResultHash });
    },
    async initializeWebsiteInterview(input: InterviewScope & { preparationId: string; agenda: OnboardingAgenda }) {
      const agenda = checkedAgenda(input.agenda);
      return readback(await rpc("initialize_website_interview", { ...scoped(input), p_preparation: input.preparationId, p_agenda: agenda }), input.callId);
    },
    async resolvePreparedWebsiteSource(input: InterviewScope) {
      const result = await rpc("resolve_prepared_website_source", scoped(input)) as Record<string, any>;
      if (result.prepared === false) return null;
      if (result.prepared !== true || !uuid.test(result.preparationId) || !result.draft_readback) throw new Error("Invalid prepared interview source");
      return result as { prepared: true; preparationId: string; draftId: string; draftHash: string; sourceResultId: string; sourceResultHash: string; draft_readback: unknown; resume?: { interviewId: string; priorCallId: string } | null };
    },
    async readWebsiteInterview(input: InterviewScope) {
      return readback(await rpc("read_website_interview", scoped(input), input.signal), input.callId);
    },
    async attachWebsiteInterview(input: InterviewScope & { interviewId: string; priorCallId: string }) {
      return readback(await rpc("attach_website_interview", { ...scoped(input), p_interview: input.interviewId, p_prior_call: input.priorCallId }), input.callId);
    },
    async recordOwnerTranscript(input: InterviewScope & { providerItemId: string; text: string }) {
      if (!input.providerItemId?.trim() || input.providerItemId.length > 400 || !input.text?.trim() || input.text.length > 32768) throw new Error("Invalid owner transcript");
      const result = await rpc("record_website_interview_owner_turn", { ...scoped(input), p_item: input.providerItemId, p_text: input.text }, input.signal) as Record<string, unknown>;
      if (result.callId !== input.callId || result.providerItemId !== input.providerItemId || result.turnId !== `${input.callId}:${input.providerItemId}` || result.text !== input.text) throw new Error("Owner transcript proof mismatch");
      return result as { callId: string; providerItemId: string; turnId: string; text: string; replayed: boolean };
    },
    async commitOwnerTurn(input: InterviewScope & { expectedRevision: number; expectedStoreVersion: number; expectedDigest: string; providerItemId: string; proposal: AgendaProposal; agenda: OnboardingAgenda; facts?: readonly Record<string, unknown>[] }) {
      const agenda = checkedAgenda(input.agenda);
      if (!Number.isSafeInteger(input.expectedStoreVersion) || input.expectedStoreVersion < 0) throw new Error("Invalid interview store version");
      return readback(await rpc("commit_website_interview_turn", { ...scoped(input), p_revision: input.expectedRevision, p_store_version: input.expectedStoreVersion, p_digest: input.expectedDigest, p_item: input.providerItemId, p_agenda: agenda, p_proposal_kind: input.proposal.kind, p_facts: input.facts ?? [] }, input.signal), input.callId);
    },
  };
}
