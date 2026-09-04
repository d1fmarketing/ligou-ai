import { createHash } from "node:crypto";
import { parseOnboardingAgenda, getAgendaAction, type OnboardingAgenda, type AgendaAction, type AgendaProposal } from "./onboarding-agenda.ts";

export interface InterviewScope { ownerId: string; callId: string; requestId: string }
export interface FreshWebsiteInterviewPreparation {
  preparationId: string; ownerId: string; expectedTenantId: string; expectedGeneration: number;
  priorCallId: string; draftId: string; draftHash: string; sourceResultId: string; sourceResultHash: string;
}
export interface StoredWebsiteInterview {
  agenda: OnboardingAgenda; revision: number; storeVersion: number; digest: string; receiptId: string;
  nextAction: AgendaAction; state: "unfinished" | "reviewing" | "closing" | "complete"; replayed: boolean;
}
type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> };
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
    ASK_NEXT_GAP: "", CLARIFY_CURRENT_GAP: "Para esclarecer: ", CONFIRM_AND_ASK_NEXT: "Obrigado, registrei sua resposta. ",
    DEFER_OFF_SCOPE_AND_CONTINUE: "Podemos tratar disso depois; agora vamos concluir sua configuração. ",
    GENERATE_FINAL_SUMMARY: "Vou preparar o resumo para sua revisão.", HANDLE_OWNER_CORRECTION: "Registrei sua correção. ",
  };
  const type = raw.nextAction?.type as AgendaAction["type"];
  if (!Object.hasOwn(prefixes, type) || raw.nextAction?.itemId !== current.itemId || raw.nextAction?.questionPt !== current.questionPt) throw new Error("Interview next action mismatch");
  const b = agenda.binding;
  const actionId = createHash("sha256").update(JSON.stringify([1,b.interviewId,b.callId,b.draftId,b.draftHash,b.sourceResultId,b.sourceResultHash,agenda.revision,current.itemId ?? null,type])).digest("hex");
  const spokenPt = prefixes[type] + (current.questionPt ?? (type === "GENERATE_FINAL_SUMMARY" ? "" : "Vou preparar o resumo para sua revisão."));
  if (raw.nextAction.actionId !== actionId || raw.nextAction.spokenPt !== spokenPt) throw new Error("Interview action proof mismatch");
  const nextAction: AgendaAction = Object.freeze({ ...raw.nextAction });
  return { agenda, revision: agenda.revision, storeVersion: raw.storeVersion, digest: raw.digest, receiptId: raw.receiptId, nextAction, state: raw.state, replayed: raw.replayed === true };
}
export function createOnboardingAgendaStore(client: RpcClient) {
  async function rpc(name: string, args: Record<string, unknown>) {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(result.error.message ?? "Interview persistence failed");
    if (!result.data) throw new Error("Interview persistence returned no proof");
    return result.data;
  }
  return {
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
      return readback(await rpc("read_website_interview", scoped(input)), input.callId);
    },
    async attachWebsiteInterview(input: InterviewScope & { interviewId: string; priorCallId: string }) {
      return readback(await rpc("attach_website_interview", { ...scoped(input), p_interview: input.interviewId, p_prior_call: input.priorCallId }), input.callId);
    },
    async recordOwnerTranscript(input: InterviewScope & { providerItemId: string; text: string }) {
      if (!input.providerItemId?.trim() || input.providerItemId.length > 400 || !input.text?.trim() || input.text.length > 32768) throw new Error("Invalid owner transcript");
      const result = await rpc("record_website_interview_owner_turn", { ...scoped(input), p_item: input.providerItemId, p_text: input.text }) as Record<string, unknown>;
      if (result.callId !== input.callId || result.providerItemId !== input.providerItemId || result.turnId !== `${input.callId}:${input.providerItemId}` || result.text !== input.text) throw new Error("Owner transcript proof mismatch");
      return result as { callId: string; providerItemId: string; turnId: string; text: string; replayed: boolean };
    },
    async commitOwnerTurn(input: InterviewScope & { expectedRevision: number; expectedStoreVersion: number; expectedDigest: string; providerItemId: string; proposal: AgendaProposal; agenda: OnboardingAgenda; facts?: readonly Record<string, unknown>[] }) {
      const agenda = checkedAgenda(input.agenda);
      if (!Number.isSafeInteger(input.expectedStoreVersion) || input.expectedStoreVersion < 0) throw new Error("Invalid interview store version");
      return readback(await rpc("commit_website_interview_turn", { ...scoped(input), p_revision: input.expectedRevision, p_store_version: input.expectedStoreVersion, p_digest: input.expectedDigest, p_item: input.providerItemId, p_agenda: agenda, p_proposal_kind: input.proposal.kind, p_facts: input.facts ?? [] }), input.callId);
    },
  };
}
