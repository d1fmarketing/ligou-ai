import { createHash } from "node:crypto";
import {
  applyVerifiedOwnerTurn, getAgendaAction, getAgendaItems, parseOnboardingAgenda, projectAgendaSummary,
  MAX_AGENDA_ITEMS,
  type AgendaAction, type AgendaProposal, type OnboardingAgenda,
} from "./onboarding-agenda.ts";
import { onboardingAgendaDigest, type StoredWebsiteInterview } from "./onboarding-agenda-store.ts";
import {
  ONBOARDING_FINAL_SIGNOFF_TEXT, ONBOARDING_AMENDMENT_SIGNOFF_TEXT, speechActionIsInternallyValid,
  type OnboardingSpeechAction, type OnboardingSpeechKind,
} from "./onboarding-speech.ts";
import type { OnboardingAnswerArgs } from "./onboarding-store.ts";
import { validateWebsiteAnswerApplicability } from "./onboarding-website-applicability.ts";
import { websiteQuestionGuidance, websiteApprovalClarification } from "./onboarding-website-guidance.ts";

/** A pure mode helper for the existing serialized onboarding adapter. No socket,
 * timer, provider, database or policy-authority effect is executed here. */
export type WebsiteAgendaPhase = "opening" | "awaiting_owner" | "interpreting" |
  "persisting_agenda" | "preparing_summary" | "speaking" | "awaiting_approval" |
  "persisting_approval" | "terminating" | "recording_completion" | "complete" | "failed";
export type WebsiteInterpretationFact = Pick<OnboardingAnswerArgs,
  "topic" | "field" | "subject" | "disposition" | "rule_text" | "structured">;
export interface WebsiteInterpretationResult {
  proposal: AgendaProposal;
  facts?: WebsiteInterpretationFact[];
}
export interface WebsiteSummaryReceipt {
  summaryId: string; summaryHash: string; revision: number; digest: string; parts: string[];
}
interface OwnerTurn {
  providerItemId: string; turnId: string; text: string; requestId: string;
  recorded: boolean; processed: boolean; attempt: number; deadlineAtMs: number;
  capturedItemId: string | null; approvalSummaryId: string | null;
}
interface PendingEffect {
  requestId: string; deadlineAtMs: number; attempt: number;
  kind: "interpret" | "persist_agenda" | "prepare_summary" | "persist_approval" | "record_completion" | "resume_speech" | "request_amendment" | "empty_input";
  turnId?: string; itemId?: string | null; responseId?: string;
  command: WebsiteAgendaCommand;
}
export interface WebsiteAgendaState {
  version: 1;
  phase: WebsiteAgendaPhase;
  stored: StoredWebsiteInterview;
  timeoutMs: number;
  fieldGuidance: Record<string, string>;
  openingAction: OnboardingSpeechAction;
  openingDeadlineAtMs: number;
  turns: OwnerTurn[];
  pending?: PendingEffect;
  speech?: { action: OnboardingSpeechAction; textSha256?: string; audioSha256?: string;
    deadlineAtMs: number; after: "owner" | "summary_part" | "approval" | "signoff" | "error" | "amendment" };
  summary?: WebsiteSummaryReceipt & { partIndex: number };
  correctionRequired: boolean;
  approvalClarifications: number;
  approval?: { receiptId: string; turnId: string; summaryId: string; summaryHash: string };
  termination?: { requestId: string; outcome: "complete" | "unfinished"; reason: string;
    deadlineAtMs: number; providerReceiptId?: string; budgetReceiptId?: string };
  completionReceiptId?: string;
  amendmentReceiptId?: string;
  error?: string;
  activeOwnerItemId?: string;
  interruptedSpeech?: { action: OnboardingSpeechAction; after: NonNullable<WebsiteAgendaState["speech"]>["after"]; providerItemId: string };
  deferredSpeech?: { speech: NonNullable<WebsiteAgendaState["speech"]>; command: Extract<WebsiteAgendaCommand,{type:"request_speech"}> };
  deferredAfterPlayback?: NonNullable<WebsiteAgendaState["speech"]>["after"];
}

export type WebsiteAgendaCommand =
  | { type: "record_owner_turn"; requestId: string; providerItemId: string; turnId: string; text: string; attempt: number }
  | { type: "interpret_owner_turn"; requestId: string; turnId: string; itemId: string | null;
      digest: string; transcript: string; mode: "answer" | "correction"; attempt: number;
      outputModalities: ["text"]; conversation: "none"; toolName: "submit_website_interview_proposal";
      toolSchema: Record<string, unknown>; instructions: string; agenda: OnboardingAgenda }
  | { type: "persist_agenda"; requestId: string; turnId: string; providerItemId: string;
      currentItemId: string | null; ownerTranscript: string;
      expectedRevision: number; expectedStoreVersion: number; expectedDigest: string;
      proposal: AgendaProposal; facts: WebsiteInterpretationFact[]; agenda: OnboardingAgenda; nextAction: AgendaAction }
  | { type: "prepare_summary"; requestId: string; revision: number; digest: string; storeVersion: number; receiptId: string }
  | { type: "persist_approval"; requestId: string; turnId: string; providerItemId: string; transcript: string;
      summaryId: string; summaryHash: string; revision: number; digest: string; expectedStoreVersion: number }
  | { type: "request_speech"; action: OnboardingSpeechAction; summaryId?: string; partIndex?: number; clarificationTurnId?: string }
  | { type: "interrupt_speech"; requestId: string; actionId: string; providerItemId: string }
  | { type: "resume_speech"; requestId: string; actionId: string; providerItemId: string }
  | { type: "record_empty_input"; requestId: string; actionId: string; providerItemId: string }
  | { type: "request_amendment"; requestId: string; approvalReceiptId: string; providerItemId: string; proposal: Extract<AgendaProposal,{kind:"correction"}> }
  | { type: "terminate_session"; requestId: string; action: "TERMINATE_SESSION"; outcome: "complete" | "unfinished";
      reason: string; approvalReceiptId?: string }
  | { type: "record_completion"; requestId: string; interviewId: string; callId: string;
      outcome: "complete" | "unfinished"; providerReceiptId: string; budgetReceiptId: string; approvalReceiptId?: string }
  | { type: "telemetry"; code: "interpretation.selected" | "interpretation.rejected"; requestId: string;
      attempt: number; reason?: string; proposalKind?: AgendaProposal["kind"]; factCount?: number; targetCount?: number };

type Timed = { nowMs: number };
export type WebsiteAgendaEvent = Timed & (
  | { type: "adapter.failed"; code: string }
  | { type: "opening.played" }
  | { type: "owner.transcript"; providerItemId: string; text: string; capturedItemId?: string | null; approvalSummaryId?: string | null }
  | { type: "owner.speech_started"; providerItemId: string; afterPlaybackActionId?: string }
  | { type: "owner.speech_finished" | "owner.transcript_empty"; providerItemId: string }
  | { type: "empty_input.recorded"; requestId: string; actionId: string; providerItemId: string; receiptId: string }
  | { type: "speech.resumed"; requestId: string; action: OnboardingSpeechAction }
  | { type: "amendment.requested"; requestId: string; approvalReceiptId: string; providerItemId: string; receiptId: string }
  | { type: "owner_turn.recorded"; requestId: string; providerItemId: string; turnId: string; text: string }
  | { type: "interpretation.created"; requestId: string; responseId: string }
  | { type: "interpretation.completed"; requestId: string; responseId: string; turnId: string;
      itemId: string | null; digest: string; result: unknown }
  | { type: "effect.failed"; requestId: string; code: string }
  | { type: "interpretation.failed"; requestId: string; code: string }
  | { type: "agenda.persisted"; requestId: string; stored: StoredWebsiteInterview }
  | ({ type: "summary.ready"; requestId: string } & WebsiteSummaryReceipt)
  | { type: "approval.persisted"; requestId: string; approvalReceiptId: string; turnId: string;
      summaryId: string; summaryHash: string; revision: number; digest: string; storeVersion: number }
  | { type: "speech.ready" | "speech.played"; actionId: string; textSha256: string; audioSha256: string }
  | { type: "speech.failed"; actionId: string; code: string }
  | { type: "deadline"; requestId: string }
  | { type: "provider.termination_confirmed" | "budget.settled"; requestId: string; receiptId: string }
  | { type: "completion.recorded"; requestId: string; receiptId: string; interviewId: string;
      callId: string; approvalReceiptId?: string; outcome: "complete" | "unfinished" }
);

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export function websiteSummaryHash(value: Omit<WebsiteSummaryReceipt, "summaryHash">): string {
  return hash([value.summaryId, value.revision, value.digest, value.parts]);
}
export const WEBSITE_APPROVAL_QUESTION = "Está tudo correto no resumo e você confirma essas informações? Se precisar, diga o que devo corrigir.";
const TERMINAL_ERROR = "Tive uma falha técnica e não consegui continuar esta conversa. A configuração ainda não foi concluída. Você pode tentar novamente pelo painel. Obrigado e até logo.";
const SHA = /^[a-f0-9]{64}$/;
function requestId(state: WebsiteAgendaState, kind: string, key: unknown): string {
  const h = hash([state.stored.agenda.binding.interviewId, state.stored.agenda.binding.callId, kind, key]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function nonblank(value: unknown, limit = 512): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= limit;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function validStored(value: StoredWebsiteInterview, expected: OnboardingAgenda): boolean {
  try {
    const parsed = parseOnboardingAgenda(value.agenda, expected.binding);
    return value.revision === parsed.revision && value.digest === onboardingAgendaDigest(parsed) &&
      Number.isSafeInteger(value.storeVersion) && value.storeVersion >= 0 && nonblank(value.receiptId) &&
      (value.state === "unfinished" || (value.state === "reviewing" && projectAgendaSummary(parsed).readyForSummary));
  } catch { return false; }
}
function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}
function replyKind(text: string): "approval" | "correction" | "ambiguous" {
  const t = normalize(text);
  // Match the WHOLE affirmative construction before inspecting isolated
  // correction words. "Correções que confirmei" refers to completed changes;
  // it is not "corrija" or a condition on an approval that has not happened.
  // The SQL helper carries the same grammar. This is linguistic classification
  // only; the coordinator and RPC still bind the played/current owner recap.
  if (!/[^a-z\s.,!;:\-–—]/.test(t)) {
    const words = t.replace(/[.,!;:\-–—]+/g, " ").trim().replace(/\s+/g, " ");
    const legacy = "sim|(?:eu )?(?:aprovo|confirmo)|aprovado|aprovada|esta correto|esta correta|esta tudo correto|esta tudo correta|tudo certo|tudo correto|correto|correta|pode salvar|pode confirmar";
    const summary = "(?:este|esse|o) resumo(?: atual| apresentado)?";
    const configuration = "(?:esta|essa|a) configuracao(?: atual| apresentada)?";
    const completedCorrections = "(?: com as correcoes que (?:eu )?(?:ja )?confirmei)?";
    const direct = `(?:eu )?(?:aprovo|confirmo)(?: explicitamente)? (?:${summary}|a versao atual do resumo|${configuration})${completedCorrections}`;
    const correctness = `(?:eu )?confirmo(?: explicitamente)? que (?:${summary} esta correto|${configuration} esta correta)`;
    const reviewed = `(?:(?:eu )?(?:revisei|conferi|li) ${summary} (?:e )?)?`;
    const clause = `(?:${legacy}|${reviewed}(?:${direct}|${correctness}))`;
    if (new RegExp(`^${clause}(?: (?:e )?${clause})*$`).test(words)) return "approval";
  }
  if (/\b(?:nao|nunca|jamais|nem|tampouco|nenhum|nenhuma|negativo|negativa|discordo|recuso|rejeito|corrigir|corrija|correcao|correcoes|mude|mudar|altere|alterar|ajuste|ajustar|troque|retifique|mas|porem|contudo|errado|errada|incorreto|incorreta)\b|de (?:forma|maneira) alguma|em hipotese alguma|de (?:modo|jeito) algum/.test(t)) return "correction";
  return "ambiguous";
}
export const classifyWebsiteApprovalTranscript = replyKind;
function copyRequest(text: string): boolean {
  return /\b(?:escreva|redija|propaganda)\b|\btexto\b.*\b(?:site|script|anuncio)\b|\b(?:manda|mande|crie)\b.*\btexto\b/.test(normalize(text));
}
function explanationRequest(text: string): boolean {
  return /\b(?:o que significa|pode explicar|poderia explicar|explique|me explica|o que voce quer dizer|qual (?:e a )?diferenca|nao entendi)\b/.test(normalize(text));
}
function explicitlyUnknown(text:string):boolean {
  return /^(?:eu )?(?:ainda )?(?:nao sei|nao tenho certeza|nao tenho essa informacao|nao esta definido)(?:[.!]\s*(?:preciso|vou) (?:verificar|confirmar)(?: essa informacao)?)?[.!]*$/.test(normalize(text));
}
function acknowledgment(text:string):boolean {
  return /^(?:(?:ah|hum)[, .]*)?(?:entendi|uhum|aham|ta bom|ok|beleza|certo)[.!]*$/.test(normalize(text));
}
function ownerPauseRequest(text:string):boolean {
  const t=normalize(text);
  if(/\b(?:nao|nunca|se|mas|porem)\b|["“”]/.test(t))return false;
  const words=t.replace(/[.,!?]/g,' ').trim().replace(/\s+/g,' ');
  return /^(?:(?:eu )?(?:quero|preciso)|vamos|pode(?:mos)?) (?:pausar|parar|encerrar)(?: (?:(?:a|esta|essa) (?:conversa|sessao|entrevista|configuracao)|(?:o|este|esse) onboarding))?(?: (?:agora|por agora|por hoje|por favor|sim))*$/.test(words);
}
const closingCourtesy=(text:string)=>/^(?:obrigad[oa](?:,? (?:tchau|ate logo))?|tchau|ate logo|certo|ta bom)[.!]*$/.test(normalize(text));

/** Validate only the proposal boundary here. Existing policy parsing must still
 * validate every fact before persistence; this mode never approves a rule. */
export function parseWebsiteInterpretation(value: unknown): WebsiteInterpretationResult | null {
  if (!record(value) || !keys(value, ["proposal", "facts"], ["proposal"]) || !record(value.proposal)) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > 65_536) return null;
  const p = value.proposal;
  if (p.kind === "off_scope") {
    if (!keys(p, ["kind"], ["kind"])) return null;
  } else if (p.kind === "correction") {
    if (!keys(p, ["kind", "affectedItems", "affectedCandidates"], ["kind"])) return null;
    let targetCount = 0;
    for (const [property, idKey] of [["affectedItems", "itemId"], ["affectedCandidates", "candidateId"]] as const) {
      const targets = p[property];
      if (targets === undefined) continue;
      if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_AGENDA_ITEMS || targets.some(item => !record(item) ||
        !keys(item, [idKey, "disposition"], [idKey, "disposition"]) || !nonblank(item[idKey]) ||
        typeof item.disposition !== "string" || !["corrected", "reopen"].includes(item.disposition))) return null;
      targetCount += targets.length;
    }
    if (targetCount < 1 || targetCount > MAX_AGENDA_ITEMS) return null;
  } else if (typeof p.kind === "string" && ["answer", "clarification", "defer", "not_applicable"].includes(p.kind)) {
    if (!(p.kind === "clarification" && p.itemId === null) && !nonblank(p.itemId)) return null;
    const optional = p.kind === "answer" ? ["relatedItemIds"] : p.kind === "clarification" ? ["questionPt"] : [];
    if (!keys(p, ["kind", "itemId", ...optional], ["kind", "itemId"])) return null;
    if (p.relatedItemIds !== undefined && (!Array.isArray(p.relatedItemIds) || p.relatedItemIds.length > MAX_AGENDA_ITEMS || p.relatedItemIds.some(id => !nonblank(id)))) return null;
    if (p.questionPt !== undefined && !nonblank(p.questionPt, 4096)) return null;
  } else return null;
  const facts = value.facts ?? [];
  if (!Array.isArray(facts) || facts.length > 16 || JSON.stringify(facts).length > 65_536) return null;
  for (const fact of facts) {
    if (!record(fact) || !keys(fact, ["topic", "field", "subject", "disposition", "rule_text", "structured"],
      ["topic", "field", "disposition", "rule_text", "structured"]) || !nonblank(fact.topic) || !nonblank(fact.field) ||
      (fact.subject !== undefined && !nonblank(fact.subject)) || !nonblank(fact.disposition) ||
      !nonblank(fact.rule_text, 8192) || !record(fact.structured)) return null;
  }
  return structuredClone({ proposal: p as unknown as AgendaProposal, facts: facts as WebsiteInterpretationFact[] });
}

const boundedInterpretationText = (maxLength = 512) => ({ type: "string", minLength: 1, maxLength, pattern: "\\S" });
const PROPOSAL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["proposal"], properties: {
    proposal: { anyOf: [
      { type: "object", additionalProperties: false, required: ["kind", "itemId"], properties: {
        kind: { const: "answer" }, itemId: boundedInterpretationText(),
        relatedItemIds: { type: "array", maxItems: MAX_AGENDA_ITEMS, items: boundedInterpretationText() },
      } },
      { type: "object", additionalProperties: false, required: ["kind", "itemId"], properties: {
        kind: { const: "clarification" }, itemId: { ...boundedInterpretationText(), type: ["string", "null"] },
        questionPt: boundedInterpretationText(4096),
      } },
      { type: "object", additionalProperties: false, required: ["kind", "itemId"], properties: {
        kind: { const: "defer" }, itemId: boundedInterpretationText(),
      } },
      { type: "object", additionalProperties: false, required: ["kind", "itemId"], properties: {
        kind: { const: "not_applicable" }, itemId: boundedInterpretationText(),
      } },
      { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "off_scope" } } },
      { type: "object", additionalProperties: false, required: ["kind"], anyOf: [{ required: ["affectedItems"] }, { required: ["affectedCandidates"] }], properties: {
        kind: { const: "correction" }, affectedItems: { type: "array", minItems: 1, maxItems: MAX_AGENDA_ITEMS, items: {
          type: "object", additionalProperties: false, required: ["itemId", "disposition"], properties: {
            itemId: boundedInterpretationText(), disposition: { enum: ["corrected", "reopen"] },
          },
        } },
        affectedCandidates: { type: "array", minItems: 1, maxItems: MAX_AGENDA_ITEMS, items: {
          type: "object", additionalProperties: false, required: ["candidateId", "disposition"], properties: {
            candidateId: boundedInterpretationText(), disposition: { enum: ["corrected", "reopen"] },
          },
        } },
      } },
    ] },
    facts: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false,
      required: ["topic", "field", "disposition", "rule_text", "structured"], properties: {
        topic: boundedInterpretationText(), field: boundedInterpretationText(), subject: boundedInterpretationText(),
        disposition: boundedInterpretationText(), rule_text: boundedInterpretationText(8192), structured: { type: "object" },
      } } },
  },
};

const INTERPRETATION_FAILURE_CODES = new Set([
  "invalid_interpretation_output", "interpretation_shape_invalid", "interpretation_json_invalid",
  "interpretation_tool_output_invalid", "interpretation_provider_failed", "interpretation_provider_cancelled",
  "interpretation_provider_incomplete", "interpretation_response_conflict", "interpretation_timeout",
  "interpretation_proposal_binding_invalid", "interpretation_transition_invalid",
  "website_facts_invalid_batch", "website_facts_owner_evidence_invalid", "website_facts_proposal_cannot_stage",
  "website_facts_correction_targets_invalid", "website_facts_unknown_correction_target",
  "website_facts_current_item_mismatch", "website_facts_current_item_unknown", "website_facts_related_target_not_explicit",
  "website_facts_unrecognized_fields", "website_facts_policy_shape_invalid", "website_facts_ref_not_allowed",
  "website_facts_private_evidence_undecided", "website_facts_duplicate_ref", "website_facts_disposition_mismatch",
  "website_facts_typed_value_invalid", "website_applicability_current_item_mismatch", "website_applicability_owner_text_invalid",
  "website_applicability_targets_invalid", "website_applicability_current_graph_missing", "website_applicability_scope_unsupported",
  "website_applicability_target_not_eligible", "website_applicability_owner_evidence_missing",
]);
/** Parser errors may append an item/ref and private values. Only a known static
 * reason can enter diagnostics or the single provider repair request. */
export function websiteInterpretationFailureCode(value: unknown): string {
  const message = typeof value === "string" ? value : (value as { message?: unknown })?.message;
  const code = typeof message === "string" ? message.split(":", 1)[0] : "";
  return INTERPRETATION_FAILURE_CODES.has(code) ? code : "invalid_interpretation_output";
}

function interpretationSelected(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], result: WebsiteInterpretationResult): void {
  if (state.pending?.kind !== "interpret") return;
  const p = result.proposal;
  commands.push({ type: "telemetry", code: "interpretation.selected", requestId: state.pending.requestId,
    attempt: state.pending.attempt, proposalKind: p.kind, factCount: result.facts?.length ?? 0,
    targetCount: p.kind === "correction" ? (p.affectedItems?.length ?? 0) + (p.affectedCandidates?.length ?? 0)
      : p.kind === "answer" ? 1 + (p.relatedItemIds?.length ?? 0) : "itemId" in p && p.itemId !== null ? 1 : 0 });
}

function effect(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], command: WebsiteAgendaCommand & { requestId: string },
  kind: PendingEffect["kind"], nowMs: number, turn?: OwnerTurn, attempt = 0): void {
  state.pending = { requestId: command.requestId, kind, deadlineAtMs: nowMs + state.timeoutMs, attempt,
    ...(turn ? { turnId: turn.turnId, itemId: turn.capturedItemId } : {}), command };
  commands.push(command);
}
function speak(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], kind: OnboardingSpeechKind, text: string,
  after: NonNullable<WebsiteAgendaState["speech"]>["after"], nowMs: number, key: unknown): void {
  const action: OnboardingSpeechAction = { actionId: hash([state.stored.agenda.binding, state.stored.revision, kind, key, text]),
    interviewId: state.stored.agenda.binding.interviewId, callId: state.stored.agenda.binding.callId,
    revision: state.stored.revision, kind, text, sourceDigest: state.stored.digest };
  if (!speechActionIsInternallyValid(action)) {
    terminate(state, commands, "unfinished", "invalid_application_speech", nowMs); return;
  }
  emitSpeech(state,commands,{action,after,deadlineAtMs:nowMs+state.timeoutMs},{ type: "request_speech", action,
    ...(state.summary ? { summaryId: state.summary.summaryId } : {}),
    ...(after === "summary_part" ? { partIndex: state.summary!.partIndex } : {}),
    ...(after === "approval" && Array.isArray(key) ? { clarificationTurnId: String(key[1]) } : {}),
  });
}
function ownerWorkPending(state:WebsiteAgendaState):boolean{
  return Boolean(state.activeOwnerItemId) || state.turns.some(turn=>!turn.processed);
}
function emitSpeech(state:WebsiteAgendaState,commands:WebsiteAgendaCommand[],speech:NonNullable<WebsiteAgendaState["speech"]>,command:Extract<WebsiteAgendaCommand,{type:"request_speech"}>):void{
  if(speech.after!=="error" && ownerWorkPending(state)){
    state.deferredSpeech={speech,command};state.phase="awaiting_owner";
    if(state.summary)state.correctionRequired=true;
    return;
  }
  delete state.deferredSpeech;state.phase="speaking";state.speech=speech;commands.push(command);
}
function continueAfterPlayback(state:WebsiteAgendaState,commands:WebsiteAgendaCommand[],after:NonNullable<WebsiteAgendaState["speech"]>["after"],nowMs:number):void{
  if(after==="error"){terminate(state,commands,"unfinished",state.error??"incomplete",nowMs);return;}
  if(after==="amendment"){terminate(state,commands,"unfinished","owner_requested_amendment",nowMs);return;}
  if(ownerWorkPending(state)){
    state.deferredAfterPlayback=after;state.phase=after==="approval"?"awaiting_approval":"awaiting_owner";
    if(state.summary && after!=="approval")state.correctionRequired=true;
    pump(state,commands,nowMs);return;
  }
  delete state.deferredAfterPlayback;
  if(after==="signoff"){terminate(state,commands,"complete","approved_signoff_played",nowMs);return;}
  if(after==="summary_part" && state.summary){
    const index=state.summary.partIndex;
    if(index<state.summary.parts.length)speak(state,commands,"GENERATE_FINAL_SUMMARY",state.summary.parts[index]!,"summary_part",nowMs,[state.summary.summaryHash,index]);
    else speak(state,commands,"REQUEST_FINAL_APPROVAL",WEBSITE_APPROVAL_QUESTION,"approval",nowMs,state.summary.summaryHash);
  }else{state.phase=after==="approval"?"awaiting_approval":"awaiting_owner";pump(state,commands,nowMs);}
}
function continueDeferredSpeech(state:WebsiteAgendaState,commands:WebsiteAgendaCommand[],nowMs:number):void{
  if(ownerWorkPending(state) || state.pending)return;
  if(state.deferredAfterPlayback){continueAfterPlayback(state,commands,state.deferredAfterPlayback,nowMs);return;}
  const deferred=state.deferredSpeech;
  if(deferred){
    delete state.deferredSpeech;
    if(deferred.speech.action.sourceDigest!==state.stored.digest || deferred.speech.action.revision!==state.stored.revision){pump(state,commands,nowMs);return;}
    emitSpeech(state,commands,{...deferred.speech,deadlineAtMs:nowMs+state.timeoutMs},deferred.command);
  }
}
function terminate(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], outcome: "complete" | "unfinished", reason: string, nowMs: number): void {
  if (state.termination) return;
  delete state.speech; delete state.pending;delete state.deferredSpeech;delete state.deferredAfterPlayback;
  state.phase = "terminating";
  const id = requestId(state, "terminate", [outcome, state.approval?.receiptId ?? reason]);
  state.termination = { requestId: id, outcome, reason, deadlineAtMs: nowMs + state.timeoutMs };
  commands.push({ type: "terminate_session", action: "TERMINATE_SESSION", requestId: id, outcome, reason,
    ...(state.approval ? { approvalReceiptId: state.approval.receiptId } : {}) });
}
function fail(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], code: string, nowMs: number): void {
  if (state.termination) return;
  const mayAlreadyBeAudible = Boolean(state.speech?.audioSha256);
  state.error = code; delete state.pending;
  if (!state.approval) delete state.summary;
  if (mayAlreadyBeAudible || state.speech?.after === "error") {
    terminate(state, commands, "unfinished", code, nowMs); return;
  }
  delete state.speech;
  const explanation = state.approval
    ? "Sua configuração foi aprovada e continua salva. Tive uma falha técnica ao encerrar a conversa. Obrigado e até logo."
    : TERMINAL_ERROR;
  speak(state, commands, "SPEAK_TERMINAL_ERROR", explanation, "error", nowMs, code);
}
function prepareSummary(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], nowMs: number): void {
  if (!projectAgendaSummary(state.stored.agenda).readyForSummary || state.pending || state.speech ||
    state.turns.some(turn => !turn.processed)) return;
  state.phase = "preparing_summary";
  effect(state, commands, { type: "prepare_summary", requestId: requestId(state, "summary", [state.stored.revision, state.stored.digest]),
    revision: state.stored.revision, digest: state.stored.digest, storeVersion: state.stored.storeVersion,
    receiptId: state.stored.receiptId }, "prepare_summary", nowMs);
}
function agendaSpeech(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], action: AgendaAction, nowMs: number): void {
  if (!getAgendaAction(state.stored.agenda).itemId) {
    state.phase = "awaiting_owner"; pump(state, commands, nowMs); return;
  }
  const current = getAgendaItems(state.stored.agenda).find(item=>item.id===action.itemId);
  const guidance = action.type === "CLARIFY_CURRENT_GAP" && current
    ? state.fieldGuidance[current.id] ?? websiteQuestionGuidance(current) : "";
  speak(state, commands, action.type, `${guidance ? `${guidance} ` : ""}${action.spokenPt}`, "owner", nowMs, action.actionId);
}
function interpret(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], turn: OwnerTurn, nowMs: number, attempt = 0, repairCode?: string): void {
  state.phase = "interpreting";
  const command: Extract<WebsiteAgendaCommand, { type: "interpret_owner_turn" }> = {
    type: "interpret_owner_turn", requestId: requestId(state, "interpret", [turn.turnId, state.stored.digest, attempt]),
    turnId: turn.turnId, itemId: turn.capturedItemId, digest: state.stored.digest, transcript: turn.text,
    mode: state.correctionRequired ? "correction" : "answer", attempt, outputModalities: ["text"], conversation: "none",
    toolName: "submit_website_interview_proposal", toolSchema: PROPOSAL_SCHEMA, agenda: state.stored.agenda,
    instructions: "Interpret only the stored owner transcript into the single proposal tool. Never produce speech, chat, offers or approval. Bind the proposal to the captured current item; only explicitly related items may share an answer. Preserve business values as bounded facts without owner_words. Website candidates are not owner approval. Questions about meaning require clarification, using only application field guidance. In correction mode, a question or unclear statement without an actual factual correction returns clarification with itemId:null and facts:[]; never invent a changed target. Copywriting/off-scope requests are off_scope. Corrections require explicit affected item or candidate IDs. Do not invent facts, prices, authority or approval.",
  };
  if (attempt === 1) command.instructions += ` The previous output was rejected (${websiteInterpretationFailureCode(repairCode)}). Repair the tool output, not the owner's intent. Return exactly one proposal variant and only its allowed fields: relatedItemIds belongs only to answer; questionPt and null itemId belong only to clarification. Preserve the captured item and explicit related graph. Do not turn a valid answer into clarification or defer to fix an output error. Omit unsupported optional typed facts instead of guessing their schema.`;
  effect(state, commands, command, "interpret", nowMs, turn, attempt);
}
function persistProposal(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], turn: OwnerTurn,
  result: WebsiteInterpretationResult, nowMs: number): boolean {
  let transition;
  try {
    validateWebsiteAnswerApplicability({ agenda: state.stored.agenda, currentItemId: turn.capturedItemId,
      ownerTranscript: turn.text, proposal: result.proposal });
    transition = applyVerifiedOwnerTurn(state.stored.agenda, { type: "verified_owner_turn", binding: state.stored.agenda.binding,
      turnId: turn.turnId, text: turn.text, proposal: result.proposal });
  } catch { return false; }
  if (!transition.accepted || transition.replayed || !transition.action) return false;
  interpretationSelected(state, commands, result);
  state.phase = "persisting_agenda";
  effect(state, commands, { type: "persist_agenda", requestId: requestId(state, "persist", [turn.turnId, state.stored.digest]),
    turnId: turn.turnId, providerItemId: turn.providerItemId, expectedRevision: state.stored.revision,
    currentItemId: turn.capturedItemId, ownerTranscript: turn.text,
    expectedStoreVersion: state.stored.storeVersion, expectedDigest: state.stored.digest,
    proposal: result.proposal, facts: result.facts ?? [], agenda: transition.agenda, nextAction: transition.action }, "persist_agenda", nowMs, turn);
  return true;
}
function interpretationFailure(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], nowMs: number, reason = "invalid_interpretation_output"): void {
  const pending = state.pending;
  const turn = state.turns.find(turn => turn.turnId === pending?.turnId);
  if (!pending || !turn) return;
  const code = websiteInterpretationFailureCode(reason);
  commands.push({ type: "telemetry", code: "interpretation.rejected", requestId: pending.requestId, attempt: pending.attempt, reason: code });
  if (pending.attempt === 0) { interpret(state, commands, turn, nowMs, 1, code); return; }
  // Invalid provider output is technical failure, never evidence that the
  // owner requested clarification/defer. Keep the raw recorded turn untouched.
  fail(state, commands, "interpretation_exhausted", nowMs);
}
function repeatApproval(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], turn: OwnerTurn, nowMs: number):void {
  turn.processed=true;delete state.pending;state.correctionRequired=false;
  if(!state.summary || state.approvalClarifications++>=1){fail(state,commands,"approval_unclear",nowMs);return;}
  speak(state, commands, "REQUEST_FINAL_APPROVAL", `${websiteApprovalClarification(turn.text)} ${WEBSITE_APPROVAL_QUESTION}`,
    "approval", nowMs, [state.summary.summaryHash, turn.turnId]);
}
function resumeInterruptedSpeech(state:WebsiteAgendaState,commands:WebsiteAgendaCommand[],providerItemId:string,nowMs:number,turn?:OwnerTurn):void{
  const interrupted=state.interruptedSpeech;
  if(!interrupted){fail(state,commands,"interrupted_speech_missing",nowMs);return;}
  if(turn)turn.processed=true;delete state.pending;
  effect(state,commands,{type:"resume_speech",requestId:requestId(state,"resume-speech",[interrupted.action.actionId,providerItemId]),
    actionId:interrupted.action.actionId,providerItemId},"resume_speech",nowMs,turn);
}
function pump(state: WebsiteAgendaState, commands: WebsiteAgendaCommand[], nowMs: number): void {
  if (state.pending || state.speech || state.activeOwnerItemId || !["awaiting_owner", "awaiting_approval"].includes(state.phase)) return;
  const turn = state.turns.find(turn => !turn.processed);
  if (!turn) { if (state.phase === "awaiting_owner") prepareSummary(state, commands, nowMs); return; }
  if (!turn.recorded) return;
  if(!state.approval && ownerPauseRequest(turn.text)){
    turn.processed=true;state.error="owner_requested_pause";delete state.summary;delete state.interruptedSpeech;
    speak(state,commands,"SPEAK_TERMINAL_ERROR","Tudo bem. A configuração continua incompleta e você pode retomar pelo painel. Obrigado e até logo.","error",nowMs,turn.turnId);return;
  }
  if(state.approval){
    if(acknowledgment(turn.text) || closingCourtesy(turn.text) || replyKind(turn.text)==="approval"){
      if(state.deferredAfterPlayback || state.deferredSpeech){turn.processed=true;continueDeferredSpeech(state,commands,nowMs);}
      else if(state.interruptedSpeech)resumeInterruptedSpeech(state,commands,turn.providerItemId,nowMs,turn);
      else{turn.processed=true;speak(state,commands,"SPEAK_FINAL_SIGNOFF",ONBOARDING_FINAL_SIGNOFF_TEXT,"signoff",nowMs,state.approval.receiptId);}
      return;
    }
    state.correctionRequired=true;
  }
  if(turn.capturedItemId && turn.capturedItemId!==getAgendaAction(state.stored.agenda).itemId &&
    getAgendaItems(state.stored.agenda).some(item=>item.id===turn.capturedItemId && ["answered","corrected","not_applicable"].includes(item.status)))
    state.correctionRequired=true;
  if (state.phase === "awaiting_approval" && state.summary) {
    const kind = replyKind(turn.text);
    if (kind === "approval" && turn.approvalSummaryId === state.summary.summaryId) {
      delete state.deferredAfterPlayback;delete state.deferredSpeech;
      state.phase = "persisting_approval";
      effect(state, commands, { type: "persist_approval", requestId: requestId(state, "approval", [turn.turnId, state.summary.summaryHash]),
        turnId: turn.turnId, providerItemId: turn.providerItemId, transcript: turn.text,
        summaryId: state.summary.summaryId, summaryHash: state.summary.summaryHash,
        revision: state.stored.revision, digest: state.stored.digest, expectedStoreVersion: state.stored.storeVersion }, "persist_approval", nowMs, turn);
      return;
    }
    if (explicitlyUnknown(turn.text) ||
      /^(?:ok|beleza|entendi|aham|obrigad[oa]|continue|pode seguir)[.!]*$/.test(normalize(turn.text)) || kind === "approval") {
      repeatApproval(state, commands, turn, nowMs);
      return;
    }
    // Strict grammar alone authorizes approval; all other substantive replies
    // are interpreted against the persisted recap, not a keyword correction list.
    // Retain the played summary for clarification, but no approval can occur
    // while this interpretation/persistence is pending.
    state.correctionRequired = true;
  }
  interpret(state, commands, turn, nowMs);
}

export function buildWebsiteOpeningAction(stored: StoredWebsiteInterview, tenantName: string): OnboardingSpeechAction {
  if (!nonblank(tenantName, 200) || !validStored(stored, stored.agenda) || !getAgendaAction(stored.agenda).itemId)
    throw new Error("Invalid website opening source");
  const text = `Oi! Aqui é o Ligou, agente de inteligência artificial da ${tenantName}. Eu já analisei seu website. ${stored.nextAction.spokenPt}`;
  const action: OnboardingSpeechAction = {
    actionId: hash([stored.nextAction.actionId, "opening", text]),
    interviewId: stored.agenda.binding.interviewId, callId: stored.agenda.binding.callId,
    revision: stored.revision, kind: "ASK_NEXT_GAP", text, sourceDigest: stored.digest,
  };
  if (!speechActionIsInternallyValid(action)) throw new Error("Invalid website opening action");
  return action;
}

export function createWebsiteAgendaCoordinator(
  stored: StoredWebsiteInterview,
  options: { nowMs: number; timeoutMs?: number; fieldGuidance?: Record<string, string>; openingAction?: OnboardingSpeechAction },
): WebsiteAgendaState {
  if (!validStored(stored, stored.agenda) || !Number.isFinite(options.nowMs) || options.nowMs < 0 ||
    !Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1 || (options.timeoutMs ?? 30_000) > 30_000)
    throw new Error("Invalid website agenda coordinator initial state");
  for (const [itemId, guidance] of Object.entries(options.fieldGuidance ?? {}))
    if (!stored.agenda.items.some(item => item.id === itemId) || !nonblank(guidance, 2048)) throw new Error("Invalid application field guidance");
  const openingAction: OnboardingSpeechAction = options.openingAction ?? {
    actionId: stored.nextAction.actionId, interviewId: stored.agenda.binding.interviewId,
    callId: stored.agenda.binding.callId, revision: stored.revision,
    kind: stored.nextAction.type, text: stored.nextAction.spokenPt, sourceDigest: stored.digest,
  };
  if (!speechActionIsInternallyValid(openingAction) || openingAction.sourceDigest !== stored.digest ||
    openingAction.revision !== stored.revision || openingAction.interviewId !== stored.agenda.binding.interviewId ||
    openingAction.callId !== stored.agenda.binding.callId || !openingAction.text.endsWith(stored.nextAction.spokenPt))
    throw new Error("Opening action does not bind current agenda");
  return { version: 1, phase: "opening", stored: structuredClone(stored), timeoutMs: options.timeoutMs ?? 30_000,
    fieldGuidance: options.fieldGuidance ?? {}, openingAction, openingDeadlineAtMs: options.nowMs + (options.timeoutMs ?? 30_000),
    turns: stored.agenda.ownerTurns.map(turn => ({ ...turn, providerItemId: turn.turnId,
      requestId: "", recorded: true, processed: true, attempt: 0, deadlineAtMs: 0,
      capturedItemId: null, approvalSummaryId: null })), correctionRequired: false, approvalClarifications: 0 };
}

export function reduceWebsiteAgenda(current: WebsiteAgendaState, event: WebsiteAgendaEvent): { state: WebsiteAgendaState; commands: WebsiteAgendaCommand[] } {
  if (!Number.isFinite(event.nowMs) || event.nowMs < 0 || current.phase === "complete") return { state: current, commands: [] };
  const state = structuredClone(current);
  const commands: WebsiteAgendaCommand[] = [];
  const pending = state.pending;
  const closing = Boolean(state.termination) || state.phase==="failed" || state.speech?.after === "error" || state.speech?.after === "amendment";
  if (closing && !["adapter.failed", "approval.persisted", "speech.ready", "speech.played", "speech.failed", "deadline", "effect.failed",
    "provider.termination_confirmed", "budget.settled", "completion.recorded"].includes(event.type)) return { state: current, commands: [] };
  switch (event.type) {
    case "adapter.failed":
      fail(state, commands, event.code, event.nowMs); break;
    case "opening.played":
      if (state.phase !== "opening") break;
      state.phase = "awaiting_owner"; pump(state, commands, event.nowMs); break;
    case "owner.speech_started": {
      if(!nonblank(event.providerItemId,400) || state.activeOwnerItemId===event.providerItemId)break;
      state.activeOwnerItemId=event.providerItemId;
      const speech=state.phase==="opening"?{action:state.openingAction,after:"owner" as const}:state.speech;
      if(speech && speech.action.actionId!==event.afterPlaybackActionId){
        state.interruptedSpeech={action:speech.action,after:speech.after,providerItemId:event.providerItemId};
        delete state.speech;state.phase="awaiting_owner";
        state.correctionRequired=Boolean(state.summary);
        commands.push({type:"interrupt_speech",requestId:requestId(state,"interrupt-speech",[speech.action.actionId,event.providerItemId]),
          actionId:speech.action.actionId,providerItemId:event.providerItemId});
      }
      break;
    }
    case "owner.speech_finished":
      if(state.activeOwnerItemId===event.providerItemId)delete state.activeOwnerItemId;
      break;
    case "owner.transcript_empty": {
      if(state.activeOwnerItemId===event.providerItemId)delete state.activeOwnerItemId;
      if(state.interruptedSpeech?.providerItemId===event.providerItemId && !state.pending){
        const actionId=state.interruptedSpeech.action.actionId;
        effect(state,commands,{type:"record_empty_input",requestId:requestId(state,"empty-input",[actionId,event.providerItemId]),
          actionId,providerItemId:event.providerItemId},"empty_input",event.nowMs);
      }else{continueDeferredSpeech(state,commands,event.nowMs);pump(state,commands,event.nowMs);}
      break;
    }
    case "empty_input.recorded":
      if(pending?.kind!=="empty_input" || pending.requestId!==event.requestId || pending.command.type!=="record_empty_input")break;
      if(!nonblank(event.receiptId) || event.actionId!==pending.command.actionId || event.providerItemId!==pending.command.providerItemId){
        fail(state,commands,"empty_input_receipt_mismatch",event.nowMs);break;
      }
      resumeInterruptedSpeech(state,commands,event.providerItemId,event.nowMs);break;
    case "owner.transcript": {
      if (!nonblank(event.providerItemId, 400) || !nonblank(event.text, 32768)) { fail(state, commands, "invalid_owner_transcript", event.nowMs); break; }
      if(state.activeOwnerItemId===event.providerItemId)delete state.activeOwnerItemId;
      const turnId = `${state.stored.agenda.binding.callId}:${event.providerItemId}`;
      const previous = state.turns.find(turn => turn.turnId === turnId);
      if (previous) { if (previous.text !== event.text) fail(state, commands, "conflicting_owner_transcript", event.nowMs); break; }
      if (state.turns.filter(turn => !turn.processed).length >= 16) { fail(state, commands, "owner_turn_backlog_exceeded", event.nowMs); break; }
      const id = requestId(state, "owner-turn", turnId);
      state.turns.push({ providerItemId: event.providerItemId, turnId, text: event.text, requestId: id,
        recorded: false, processed: false, attempt: 0, deadlineAtMs: event.nowMs + state.timeoutMs,
        capturedItemId: event.capturedItemId===undefined ? getAgendaAction(state.stored.agenda).itemId ?? null : event.capturedItemId,
        approvalSummaryId: event.approvalSummaryId===undefined ? (state.phase === "awaiting_approval" ? state.summary?.summaryId ?? null : null) : event.approvalSummaryId });
      commands.push({ type: "record_owner_turn", requestId: id, turnId, providerItemId: event.providerItemId, text: event.text, attempt: 0 });
      break;
    }
    case "owner_turn.recorded": {
      const turn = state.turns.find(turn => turn.requestId === event.requestId && !turn.recorded);
      if (!turn) break;
      if (turn.turnId !== event.turnId || turn.providerItemId !== event.providerItemId || turn.text !== event.text) {
        fail(state, commands, "owner_transcript_receipt_mismatch", event.nowMs); break;
      }
      turn.recorded = true; pump(state, commands, event.nowMs); break;
    }
    case "interpretation.created":
      if (pending?.kind !== "interpret" || pending.requestId !== event.requestId || !nonblank(event.responseId)) break;
      if (pending.responseId && pending.responseId !== event.responseId) { interpretationFailure(state, commands, event.nowMs, "interpretation_response_conflict"); break; }
      state.pending!.responseId = event.responseId; break;
    case "interpretation.completed": {
      if (pending?.kind !== "interpret" || pending.requestId !== event.requestId || pending.responseId !== event.responseId ||
        pending.turnId !== event.turnId || pending.itemId !== event.itemId || state.stored.digest !== event.digest) break;
      const turn = state.turns.find(turn => turn.turnId === pending.turnId && turn.recorded)!;
      let result = parseWebsiteInterpretation(event.result);
      if(state.approval && result?.proposal.kind==="correction"){
        const proposal=result.proposal;
        if((proposal.affectedItems??[]).some(target=>!state.stored.agenda.items.some(item=>item.id===target.itemId)) ||
          (proposal.affectedCandidates??[]).some(target=>!state.stored.agenda.candidateContext.some(item=>item.id===target.candidateId))){
          interpretationFailure(state,commands,event.nowMs,"interpretation_proposal_binding_invalid");break;
        }
        const reopen:Extract<AgendaProposal,{kind:"correction"}>={kind:"correction",
          ...(proposal.affectedItems?{affectedItems:proposal.affectedItems.map(target=>({...target,disposition:"reopen" as const}))}:{}),
          ...(proposal.affectedCandidates?{affectedCandidates:proposal.affectedCandidates.map(target=>({...target,disposition:"reopen" as const}))}:{})};
        interpretationSelected(state,commands,result);
        effect(state,commands,{type:"request_amendment",requestId:requestId(state,"amendment",[state.approval.receiptId,turn.turnId]),
          approvalReceiptId:state.approval.receiptId,providerItemId:turn.providerItemId,proposal:reopen},"request_amendment",event.nowMs,turn);break;
      }
      if(state.correctionRequired && result && (result.facts?.length ?? 0)===0 &&
        (result.proposal.kind==="off_scope" || (result.proposal.kind==="clarification" && result.proposal.itemId===null))){
        interpretationSelected(state,commands,result);
        if(state.deferredAfterPlayback || state.deferredSpeech){turn.processed=true;delete state.pending;state.correctionRequired=false;continueDeferredSpeech(state,commands,event.nowMs);}
        else if(state.interruptedSpeech)resumeInterruptedSpeech(state,commands,turn.providerItemId,event.nowMs,turn);
        else repeatApproval(state,commands,turn,event.nowMs);break;
      }
      if (copyRequest(turn.text) && !state.correctionRequired) result = { proposal: { kind: "off_scope" }, facts: [] };
      else if ((explanationRequest(turn.text) || explicitlyUnknown(turn.text) || acknowledgment(turn.text)) && !state.correctionRequired && turn.capturedItemId)
        result = { proposal: { kind: "clarification", itemId: turn.capturedItemId }, facts: [] };
      if (!result) interpretationFailure(state, commands, event.nowMs, "interpretation_shape_invalid");
      else if ((state.correctionRequired && result.proposal.kind !== "correction") ||
        (!state.correctionRequired && result.proposal.kind === "correction" && replyKind(turn.text) !== "correction") ||
        ("itemId" in result.proposal && result.proposal.itemId !== turn.capturedItemId))
        interpretationFailure(state, commands, event.nowMs, "interpretation_proposal_binding_invalid");
      else if (!persistProposal(state, commands, turn, result, event.nowMs))
        interpretationFailure(state, commands, event.nowMs, "interpretation_transition_invalid");
      break;
    }
    case "interpretation.failed":
      if (pending?.kind === "interpret" && pending.requestId === event.requestId) interpretationFailure(state, commands, event.nowMs, event.code);
      break;
    case "agenda.persisted": {
      if (pending?.kind !== "persist_agenda" || pending.requestId !== event.requestId || pending.command.type !== "persist_agenda") break;
      const expected = pending.command;
      if (!validStored(event.stored, state.stored.agenda) || event.stored.storeVersion !== expected.expectedStoreVersion + 1 ||
        event.stored.digest !== onboardingAgendaDigest(expected.agenda) || event.stored.revision !== expected.agenda.revision ||
        ["type", "actionId", "itemId", "questionPt", "spokenPt"].some(key =>
          event.stored.nextAction[key as keyof AgendaAction] !== expected.nextAction[key as keyof AgendaAction]) ||
        Object.keys(event.stored.nextAction).some(key => !["type", "actionId", "itemId", "questionPt", "spokenPt"].includes(key))) {
        fail(state, commands, "agenda_receipt_mismatch", event.nowMs); break;
      }
      state.stored = structuredClone(event.stored);
      delete state.summary;
      delete state.interruptedSpeech;
      delete state.deferredSpeech;delete state.deferredAfterPlayback;
      state.approvalClarifications = 0;
      state.turns.find(turn => turn.turnId === pending.turnId)!.processed = true;
      state.correctionRequired = false;
      delete state.pending;
      if(state.activeOwnerItemId || state.turns.some(turn=>!turn.processed)){
        state.phase="awaiting_owner";pump(state,commands,event.nowMs);
      }else agendaSpeech(state, commands, event.stored.nextAction, event.nowMs); break;
    }
    case "speech.resumed": {
      if(pending?.kind!=="resume_speech" || pending.requestId!==event.requestId || !state.interruptedSpeech)break;
      const prior=state.interruptedSpeech;
      if(!speechActionIsInternallyValid(event.action) || event.action.actionId===prior.action.actionId ||
        ["interviewId","callId","revision","kind","text","sourceDigest"].some(key=>
          event.action[key as keyof OnboardingSpeechAction]!==prior.action[key as keyof OnboardingSpeechAction])){
        fail(state,commands,"resumed_speech_receipt_mismatch",event.nowMs);break;
      }
      delete state.pending;delete state.interruptedSpeech;state.correctionRequired=false;
      emitSpeech(state,commands,{action:event.action,after:prior.after,deadlineAtMs:event.nowMs+state.timeoutMs},{type:"request_speech",action:event.action,
        ...(state.summary?{summaryId:state.summary.summaryId}:{}),
        ...(prior.after==="summary_part"?{partIndex:state.summary!.partIndex}:{})});
      break;
    }
    case "amendment.requested": {
      if(pending?.kind!=="request_amendment" || pending.requestId!==event.requestId || pending.command.type!=="request_amendment")break;
      if(!nonblank(event.receiptId) || event.approvalReceiptId!==state.approval?.receiptId || event.providerItemId!==pending.command.providerItemId){
        fail(state,commands,"amendment_receipt_mismatch",event.nowMs);break;
      }
      state.amendmentReceiptId=event.receiptId;state.turns.find(turn=>turn.turnId===pending.turnId)!.processed=true;
      delete state.pending;delete state.interruptedSpeech;delete state.deferredAfterPlayback;
      speak(state,commands,"SPEAK_AMENDMENT_SIGNOFF",ONBOARDING_AMENDMENT_SIGNOFF_TEXT,"amendment",event.nowMs,event.receiptId);break;
    }
    case "summary.ready": {
      if (pending?.kind !== "prepare_summary" || pending.requestId !== event.requestId) break;
      if (!projectAgendaSummary(state.stored.agenda).readyForSummary || state.turns.some(turn => !turn.processed) ||
        event.revision !== state.stored.revision || event.digest !== state.stored.digest || !nonblank(event.summaryId) ||
        !Array.isArray(event.parts) || event.parts.length < 1 || event.parts.length > 2048 ||
        Buffer.byteLength(JSON.stringify(event.parts)) > 2_097_152 ||
        event.parts.some(part => !nonblank(part, 4096)) || event.summaryHash !== websiteSummaryHash(event)) {
        fail(state, commands, "summary_receipt_mismatch", event.nowMs); break;
      }
      delete state.pending;
      state.approvalClarifications = 0;
      state.summary = { summaryId: event.summaryId, summaryHash: event.summaryHash, revision: event.revision,
        digest: event.digest, parts: [...event.parts], partIndex: 0 };
      speak(state, commands, "GENERATE_FINAL_SUMMARY", event.parts[0]!, "summary_part", event.nowMs, [event.summaryHash, 0]); break;
    }
    case "approval.persisted": {
      if (pending?.kind !== "persist_approval" || pending.requestId !== event.requestId || pending.command.type !== "persist_approval") break;
      const expected = pending.command;
      if (!nonblank(event.approvalReceiptId) || event.turnId !== expected.turnId || event.summaryId !== expected.summaryId ||
        event.summaryHash !== expected.summaryHash || event.revision !== expected.revision || event.digest !== expected.digest ||
        event.storeVersion !== expected.expectedStoreVersion + 1 || !state.summary ||
        state.summary.summaryHash !== expected.summaryHash) {
        fail(state, commands, "approval_receipt_mismatch", event.nowMs); break;
      }
      state.approval = { receiptId: event.approvalReceiptId, turnId: event.turnId, summaryId: event.summaryId, summaryHash: event.summaryHash };
      state.turns.find(turn => turn.turnId === event.turnId)!.processed = true;
      state.stored.storeVersion = event.storeVersion; state.stored.state = "closing"; delete state.pending;
      if(state.activeOwnerItemId || state.turns.some(turn=>!turn.processed)){
        state.phase="awaiting_owner";pump(state,commands,event.nowMs);break;
      }
      speak(state, commands, "SPEAK_FINAL_SIGNOFF", ONBOARDING_FINAL_SIGNOFF_TEXT, "signoff", event.nowMs, event.approvalReceiptId); break;
    }
    case "speech.ready": {
      const speech = state.speech;
      if (!speech || speech.action.actionId !== event.actionId) break;
      if (event.textSha256 !== hash(speech.action.text) || !SHA.test(event.audioSha256) ||
        (speech.audioSha256 && speech.audioSha256 !== event.audioSha256)) { fail(state, commands, "speech_receipt_mismatch", event.nowMs); break; }
      speech.textSha256 = event.textSha256; speech.audioSha256 = event.audioSha256;
      // Preparation has a short effect deadline; exact published audio gets a
      // separate bounded playback window, including long persisted recap parts.
      speech.deadlineAtMs = event.nowMs + 180_000; break;
    }
    case "speech.played": {
      const speech = state.speech;
      if (!speech || speech.action.actionId !== event.actionId || !speech.audioSha256 ||
        speech.textSha256 !== event.textSha256 || speech.audioSha256 !== event.audioSha256) break;
      delete state.speech;
      if(speech.after==="summary_part" && state.summary)state.summary.partIndex++;
      continueAfterPlayback(state,commands,speech.after,event.nowMs);
      break;
    }
    case "speech.failed":
      if (state.speech?.action.actionId === event.actionId) fail(state, commands, "speech_failed", event.nowMs);
      break;
    case "effect.failed":
    case "deadline": {
      const due = event.type === "effect.failed";
      const turn = state.turns.find(turn => !turn.recorded && turn.requestId === event.requestId);
      if (turn && (due || event.nowMs >= turn.deadlineAtMs)) {
        if (turn.attempt++ === 0) {
          turn.deadlineAtMs = event.nowMs + state.timeoutMs;
          commands.push({ type: "record_owner_turn", requestId: turn.requestId, providerItemId: turn.providerItemId,
            turnId: turn.turnId, text: turn.text, attempt: 1 });
        } else fail(state, commands, "owner_transcript_persistence_exhausted", event.nowMs);
      } else if (pending?.requestId === event.requestId && (due || event.nowMs >= pending.deadlineAtMs)) {
        if (pending.kind === "interpret") interpretationFailure(state, commands, event.nowMs, due ? "invalid_interpretation_output" : "interpretation_timeout");
        else if (pending.kind === "record_completion") { state.phase = "failed"; state.error = "completion_receipt_missing"; delete state.pending; }
        else fail(state, commands, `${pending.kind}_failed`, event.nowMs);
      } else if (state.speech?.action.actionId === event.requestId && (due || event.nowMs >= state.speech.deadlineAtMs)) {
        fail(state, commands, "speech_deadline_exceeded", event.nowMs);
      } else if (state.phase === "opening" && event.requestId === state.openingAction.actionId && event.nowMs >= state.openingDeadlineAtMs) {
        terminate(state, commands, "unfinished", "opening_playback_unproven", event.nowMs);
      } else if (state.termination?.requestId === event.requestId && event.nowMs >= state.termination.deadlineAtMs) {
        state.phase = "failed"; state.error = "termination_or_budget_receipt_missing";
      }
      break;
    }
    case "provider.termination_confirmed":
    case "budget.settled": {
      const termination = state.termination;
      if (!termination || termination.requestId !== event.requestId || !nonblank(event.receiptId) || state.pending?.kind === "record_completion") break;
      if (event.type === "provider.termination_confirmed") termination.providerReceiptId ??= event.receiptId;
      else termination.budgetReceiptId ??= event.receiptId;
      if (termination.providerReceiptId && termination.budgetReceiptId) {
        state.phase = "recording_completion";
        effect(state, commands, { type: "record_completion", requestId: requestId(state, "completion", termination.requestId),
          interviewId: state.stored.agenda.binding.interviewId, callId: state.stored.agenda.binding.callId,
          outcome: termination.outcome, providerReceiptId: termination.providerReceiptId, budgetReceiptId: termination.budgetReceiptId,
          ...(state.approval ? { approvalReceiptId: state.approval.receiptId } : {}) }, "record_completion", event.nowMs);
      }
      break;
    }
    case "completion.recorded":
      if (pending?.kind !== "record_completion" || pending.requestId !== event.requestId || pending.command.type !== "record_completion") break;
      if (event.interviewId !== state.stored.agenda.binding.interviewId || event.callId !== state.stored.agenda.binding.callId ||
        event.outcome !== state.termination?.outcome || event.approvalReceiptId !== state.approval?.receiptId || !nonblank(event.receiptId)) break;
      state.completionReceiptId = event.receiptId; delete state.pending;
      state.phase = event.outcome === "complete" && state.approval ? "complete" : "failed";
      if (state.phase === "complete") state.stored.state = "complete";
      break;
  }
  return { state, commands };
}
