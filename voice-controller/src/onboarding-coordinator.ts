import { createHash } from "node:crypto";
import {
  evaluateCoverage,
  INITIAL_SERVICE_DISCOVERY_QUESTION_PT,
  type CoverageRef,
} from "./onboarding-coverage.ts";
import type {
  OnboardingAnswerArgs,
  SnapshotResult,
} from "./onboarding-store.ts";
import type { OnboardingOpeningMode } from "./onboarding-greeting.ts";

export type OnboardingPhase =
  | "greeting"
  | "collecting"
  | "coverage_check"
  | "follow_up"
  | "snapshot_preparing"
  | "summary_speaking"
  | "awaiting_owner_approval"
  | "approval_persisting"
  | "final_signoff_speaking"
  | "budget_pause_pending"
  | "budget_pause_speaking"
  | "budget_pause_ready_to_terminate"
  | "budget_pause_provider_terminating"
  | "budget_pause_error_ready_to_terminate"
  | "budget_error_provider_terminating"
  | "recovery_error_ready_to_terminate"
  | "recovery_error_provider_terminating"
  | "transport_error_ready_to_terminate"
  | "transport_error_provider_terminating"
  | "fatal_error_ready_to_terminate"
  | "fatal_error_provider_terminating"
  | "ready_to_terminate"
  | "provider_terminating"
  | "closed"
  | "blocked";

export type ToolOutboxState =
  | "running"
  | "executed"
  | "output_pending"
  | "output_acked";

export type OutputDelivery = "create" | "retrieve";

export interface ToolReceipt {
  toolCallId: string;
  toolName: string;
  argsHash: string;
  state: ToolOutboxState;
  providerResponseId: string;
  batchHash: string;
  resultHash?: string;
  output?: string;
  outputItemId: string;
  socketGeneration: number;
  outputRequest?: {
    delivery: OutputDelivery;
    eventId: string;
    socketGeneration: number;
  };
  approvalTurnId?: string;
  failureKind?: "deterministic" | "indeterminate";
}

export interface ToolBatch {
  providerResponseId: string;
  batchHash: string;
  toolCallIds: string[];
  closed: boolean;
  continuationRequested: boolean;
}

export interface CoverageLifecycleState {
  revision: number;
  digest?: string;
  complete: boolean;
  missing: CoverageRef[];
  ambiguous: CoverageRef[];
  nextQuestion?: {
    field: string;
    subject?: string;
    questionPt: string;
  };
}

export interface SummaryProof {
  receiptId: string;
  revision: number;
  digest: string;
  requiredAnchors: string[];
  responseId?: string;
  transcript: string;
  transcriptFinal: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  validated?: boolean;
  interrupted: boolean;
  attempt: number;
  interruptedResponseId?: string;
}

export interface GreetingProof {
  responseId?: string;
  transcript: string;
  transcriptFinal: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  interrupted: boolean;
  validated?: boolean;
  attempt: number;
  interruptedResponseId?: string;
}

export interface SignoffProof {
  approvalReceiptId: string;
  responseId?: string;
  transcript: string;
  transcriptFinal: boolean;
  validated?: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  interrupted: boolean;
  attempt: number;
  interruptedResponseId?: string;
}

export interface BudgetPauseProof {
  costUsd: number;
  softLimitUsd: number;
  hardLimitUsd: number;
  responseId?: string;
  transcript: string;
  transcriptFinal: boolean;
  validated?: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  interrupted: boolean;
  attempt: number;
  interruptedResponseId?: string;
}

export interface ApprovalCandidate {
  turnId: string;
  ownerWords: string;
}

export interface PersistedApproval {
  toolCallId: string;
  approvalReceiptId: string;
  coverageReceiptId: string;
  revision: number;
  digest: string;
}

export interface SnapshotRefreshRequest {
  requestId: string;
  toolCallId: string;
  rejectedRevision: number;
  rejectedDigest: string;
}

export interface PendingFollowup {
  sourceRevision: number;
  sourceDigest: string;
  field: string;
  subject?: string;
  questionPt: string;
  intentKey: string;
}

export interface FollowupSpeechProof {
  intentKey: string;
  questionPt: string;
  responseId?: string;
  transcript: string;
  transcriptFinal: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  interrupted: boolean;
  attempt: number;
  interruptedResponseId?: string;
  validated?: boolean;
}

export interface RecoverySpeechProof {
  intentKey: string;
  expectedTranscript: string;
  terminalAfterPlayback: boolean;
  responseId?: string;
  transcript: string;
  transcriptFinal: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  interrupted: boolean;
  attempt: number;
  interruptedResponseId?: string;
  validated?: boolean;
}

export interface ResponseIntentReceipt {
  intentKey: string;
  purpose: ResponsePurpose;
  state: "queued" | "sent" | "acknowledged" | "terminal";
  responseId?: string;
  sentSocketGeneration?: number;
}

export interface OnboardingLifecycle {
  callId: string;
  expectedBusinessName: string;
  openingMode: OnboardingOpeningMode;
  phase: OnboardingPhase;
  lifecycleRevision: number;
  socketGeneration: number;
  coverage: CoverageLifecycleState;
  toolOutbox: Record<string, ToolReceipt>;
  toolBatches: Record<string, ToolBatch>;
  responseIntents: Record<string, ResponseIntentReceipt>;
  activeResponseId?: string;
  terminalResponseIds: string[];
  preparedSnapshotDigests: string[];
  freshCallerTurnIds: string[];
  consumedCallerTurnIds: string[];
  approvalCandidate?: ApprovalCandidate;
  approval?: PersistedApproval;
  snapshotRefresh?: SnapshotRefreshRequest;
  pendingFollowup?: PendingFollowup;
  followupSpeech?: FollowupSpeechProof;
  recoverySpeech?: RecoverySpeechProof;
  greeting?: GreetingProof;
  summary?: SummaryProof;
  signoff?: SignoffProof;
  budgetPause?: BudgetPauseProof;
  invalidatedSummaryRevision?: number;
  requestedHangupKeys: string[];
  requestedBudgetHangupKeys: string[];
  requestedRecoveryHangupKeys: string[];
  requestedTransportHangupKeys: string[];
  requestedFatalHangupKeys: string[];
  budgetErrorTerminationReason?: string;
  recoveryTerminationReason?: string;
  transportTerminationReason?: string;
  fatalTerminationReason?: string;
  providerTerminationConfirmed: boolean;
}

export type ResponsePurpose =
  | "greeting"
  | "tool_continuation"
  | "recovery"
  | "summary"
  | "final_signoff"
  | "budget_pause";

export type TelemetryName =
  | "onboarding.coverage.started"
  | "onboarding.coverage.changed"
  | "onboarding.field.answered"
  | "onboarding.field.missing"
  | "onboarding.field.ambiguous"
  | "onboarding.followup.selected"
  | "onboarding.followup.validated"
  | "onboarding.followup.invalid"
  | "onboarding.recovery.validated"
  | "onboarding.recovery.invalid"
  | "onboarding.snapshot.prepare_started"
  | "onboarding.snapshot.ready"
  | "onboarding.snapshot.blocked"
  | "voice.tool.admitted"
  | "voice.tool.executed"
  | "voice.tool.output_sent"
  | "voice.tool.output_acked"
  | "voice.tool.output_retry"
  | "voice.response.intent_queued"
  | "voice.response.intent_sent"
  | "voice.response.acknowledged"
  | "voice.response.terminal"
  | "onboarding.greeting.validated"
  | "onboarding.greeting.invalid"
  | "onboarding.summary.validated"
  | "onboarding.summary.invalid"
  | "onboarding.summary.audio_done"
  | "onboarding.summary.playback_done"
  | "onboarding.approval.captured"
  | "onboarding.approval.persisted"
  | "onboarding.approval.rejected"
  | "onboarding.final_audio.done"
  | "onboarding.final_audio.playback_done"
  | "onboarding.budget_pause.requested"
  | "onboarding.budget_pause.audio_done"
  | "onboarding.budget_pause.playback_done"
  | "closing.budget_requested"
  | "closing.provider_requested"
  | "closing.provider_confirmed"
  | "onboarding.closed"
  | "invariant.violation";

const MAX_TOOL_OUTBOX_RECEIPTS = 512;
const MAX_TOOL_BATCHES = 512;
const MAX_RESPONSE_INTENTS = 512;
const MAX_TERMINAL_RESPONSE_IDS = 512;
const INITIAL_GREETING_RESPONSE_INSTRUCTIONS_PT =
  "Diga exatamente uma vez e sem alteração a saudação de identidade brasileira definida na sessão. " +
  `Em seguida, pergunte exatamente: "${INITIAL_SERVICE_DISCOVERY_QUESTION_PT}"`;
export const FINAL_SIGNOFF_SENTENCE_PT =
  "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.";
export const BUDGET_PAUSE_SENTENCE_PT =
  "Estamos chegando ao limite desta sessão. Suas informações foram salvas. Vou encerrar esta sessão agora.";
const TRUTHFUL_RECOVERY_SENTENCE_PT =
  "Não consegui confirmar o salvamento da sua resposta. Por favor, repita as informações.";
const INDETERMINATE_RECOVERY_SENTENCE_PT =
  "Não consegui confirmar o salvamento com segurança. Encerre este teste e tente novamente.";
const FOLLOWUP_RECOVERY_SENTENCE_PT =
  "Sua resposta foi salva, mas não consegui preparar a próxima pergunta. Encerre este teste e tente novamente.";
const exactRecoveryInstructions = (sentence: string) =>
  `Diga exatamente uma vez: "${sentence}"`;
const TRUTHFUL_RECOVERY_RESPONSE_INSTRUCTIONS_PT =
  exactRecoveryInstructions(TRUTHFUL_RECOVERY_SENTENCE_PT);
const INDETERMINATE_RECOVERY_RESPONSE_INSTRUCTIONS_PT =
  exactRecoveryInstructions(INDETERMINATE_RECOVERY_SENTENCE_PT);
const FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT =
  exactRecoveryInstructions(FOLLOWUP_RECOVERY_SENTENCE_PT);

function recoveryExpectedTranscript(instructions: string): string | null {
  if (instructions === TRUTHFUL_RECOVERY_RESPONSE_INSTRUCTIONS_PT)
    return TRUTHFUL_RECOVERY_SENTENCE_PT;
  if (instructions === INDETERMINATE_RECOVERY_RESPONSE_INSTRUCTIONS_PT)
    return INDETERMINATE_RECOVERY_SENTENCE_PT;
  if (instructions === FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT)
    return FOLLOWUP_RECOVERY_SENTENCE_PT;
  return null;
}

interface TelemetryCommand {
  type: "telemetry";
  name: TelemetryName;
  callIdPrefix: string;
  socketGeneration: number;
  lifecycleRevision: number;
  phase: OnboardingPhase;
  responseId?: string;
  intentKey?: string;
  toolCallId?: string;
  snapshotDigestPrefix?: string;
  elapsedMs: number;
  outcome?: string;
  errorCode?: string;
}

export type OnboardingCommand =
  | TelemetryCommand
  | {
      type: "persist_fact";
      toolCallId: string;
      argsHash: string;
      args: OnboardingAnswerArgs;
      providerResponseId: string;
      batchHash: string;
    }
  | {
      type: "execute_tool";
      toolCallId: string;
      name: string;
      argsHash: string;
      args: Record<string, unknown>;
      providerResponseId: string;
      batchHash: string;
    }
  | {
      type: "persist_approval";
      toolCallId: string;
      argsHash: string;
      ownerWords: string;
      coverageReceiptId: string;
      revision: number;
      digest: string;
    }
  | {
      type: "persist_followup";
      revision: number;
      digest: string;
      field: string;
      subject?: string;
      questionPt: string;
      intentKey: string;
    }
  | {
      type: "resend_output";
      toolCallId: string;
      output: string;
      outputItemId: string;
      replay: boolean;
      socketGeneration: number;
      delivery: OutputDelivery;
      eventId: string;
    }
  | {
      type: "ask_follow_up";
      field: string;
      subject?: string;
      questionPt: string;
      intentKey?: string;
    }
  | {
      type: "prepare_summary";
      revision: number;
      digest: string;
    }
  | {
      type: "refresh_snapshot";
      requestId: string;
      afterRevision: number;
      rejectedDigest: string;
    }
  | {
      type: "request_response";
      intentKey: string;
      purpose: ResponsePurpose;
      instructions?: string;
      snapshotDigest?: string;
      approvalReceiptId?: string;
    }
  | {
      type: "request_signoff";
      intentKey: string;
      approvalReceiptId: string;
      instructions: string;
    }
  | {
      type: "request_hangup";
      intentKey: string;
      approvalReceiptId: string;
    }
  | {
      type: "request_budget_hangup";
      intentKey: string;
      costUsd: number;
      softLimitUsd: number;
      hardLimitUsd: number;
    }
  | {
      type: "request_budget_error_hangup";
      intentKey: string;
      reason: string;
    }
  | {
      type: "request_recovery_error_hangup";
      intentKey: string;
      reason: string;
    }
  | {
      type: "request_transport_error_hangup";
      intentKey: string;
      reason: string;
    }
  | {
      type: "request_fatal_error_hangup";
      intentKey: string;
      reason: string;
    }
  | {
      type: "refuse_end_session";
      toolCallId: string;
      output: string;
      outputItemId: string;
    }
  | {
      type: "block";
      code: string;
      safeDetail: string;
      toolCallId?: string;
      recoverable: boolean;
    };

type TimedEvent = { elapsedMs?: number };
type SocketEvent = TimedEvent & { socketGeneration: number };

export type OnboardingEvent =
  | (TimedEvent & { type: "socket.attached"; socketGeneration: number })
  | (SocketEvent & { type: "application.greeting_activated" })
  | (SocketEvent & { type: "application.transport_activated" })
  | (SocketEvent & {
      type: "budget.soft_limit_reached";
      responseId: string;
      costUsd: number;
      softLimitUsd: number;
      hardLimitUsd: number;
    })
  | (TimedEvent & {
      type: "adapter.invariant_failed";
      code:
        | "tool_args_mismatch"
        | "function_item_identity_missing"
        | "function_item_after_terminal_response"
        | "tool_batch_too_large"
        | "response_not_completed"
        | "function_item_not_completed"
        | "output_index_invalid"
        | "output_index_duplicate"
        | "adapter_capacity_exceeded"
        | "reused_coverage_mismatch"
        | "tool_args_json_invalid"
        | "tool_schema_invalid"
        | "tool_not_admitted"
        | "caller_turn_correlation_mismatch"
        | "tool_output_created_invalid"
        | "tool_output_retrieved_invalid"
        | "tool_output_retrieve_failed"
        | "response_create_active_conflict"
        | "response_create_ack_timeout"
        | "tool_output_ack_timeout"
        | "terminal_response_replay_mismatch"
        | "application_opening_reactivation_indeterminate"
        | "application_opening_item_invalid"
        | "application_opening_response_forbidden"
        | "application_opening_tool_forbidden"
        | "application_opening_session_update_invalid";
      safeDetail: string;
      intentKey?: string;
      toolCallId?: string;
    })
  | (TimedEvent & {
      type: "fatal.termination_required";
      code: string;
    })
  | (SocketEvent & { type: "response.intent_sent"; intentKey: string })
  | (SocketEvent & {
      type: "response.created";
      responseId: string;
      intentKey?: string;
    })
  | (SocketEvent & {
      type: "response.transcript.delta";
      responseId: string;
      delta: string;
    })
  | (SocketEvent & {
      type: "response.transcript.done";
      responseId: string;
      transcript: string;
    })
  | (SocketEvent & {
      type: "response.output_audio.done";
      responseId: string;
    })
  | (SocketEvent & { type: "response.done"; responseId: string })
  | (SocketEvent & {
      type: "output_audio_buffer.stopped";
      responseId: string;
    })
  | (SocketEvent & {
      type: "response.audio_interrupted";
      responseId: string;
    })
  | (TimedEvent & {
      type: "coverage.changed";
      revision: number;
      digest: string;
      complete: boolean;
      missing: CoverageRef[];
      ambiguous: CoverageRef[];
      answered?: CoverageRef[];
      nextQuestion?: {
        field: string;
        subject?: string;
        questionPt: string;
      };
    })
  | (TimedEvent & {
      type: "followup.persisted";
      sourceRevision: number;
      revision: number;
      digest: string;
      field: string;
      subject?: string;
      questionPt: string;
      intentKey: string;
    })
  | (TimedEvent & {
      type: "followup.persistence_failed";
      sourceRevision: number;
      field: string;
      subject?: string;
      code:
        | "timeout"
        | "query_error"
        | "empty"
        | "coverage_incomplete"
        | "changed"
        | "not_owner_bound"
        | "invalid_fact"
        | "indeterminate";
      safeDetail: string;
    })
  | (TimedEvent & { type: "snapshot.loaded"; result: SnapshotResult })
  | (TimedEvent & {
      type: "snapshot.refresh_loaded";
      requestId: string;
      result: SnapshotResult;
    })
  | (SocketEvent & {
      type: "caller.speech_started";
      turnId: string;
    })
  | (SocketEvent & {
      type: "caller.transcript.completed";
      turnId: string;
      transcript: string;
    })
  | (SocketEvent & {
      type: "caller.turn_retired";
      turnId: string;
    })
  | (SocketEvent & {
      type: "recovery.required";
      reason:
        | "caller_turn_correlation_mismatch"
        | "owner_turn_completed_without_tool";
      recoveryKey: string;
      responseId?: string;
      retiredTurnIds?: string[];
    })
  | (SocketEvent & {
      type: "tool.called";
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      providerResponseId: string;
      batchHash: string;
      callerTurnId?: string;
    })
  | (SocketEvent & {
      type: "tool.rejected";
      toolCallId: string;
      name: string;
      argsHash: string;
      providerResponseId: string;
      batchHash: string;
      code: "caller_transcript_unavailable";
    })
  | (TimedEvent & {
      type: "tool.executed";
      toolCallId: string;
      output: string;
      resultHash: string;
    })
  | (TimedEvent & {
      type: "tool.execution_failed";
      toolCallId: string;
      code:
        | "timeout"
        | "query_error"
        | "empty"
        | "coverage_incomplete"
        | "changed"
        | "not_owner_bound"
        | "invalid_fact"
        | "indeterminate";
      safeDetail: string;
    })
  | (SocketEvent & {
      type: "tool.output_sent";
      toolCallId: string;
      delivery: OutputDelivery;
      eventId: string;
    })
  | (SocketEvent & {
      type: "tool.output_create_duplicate";
      toolCallId: string;
      eventId: string;
    })
  | (SocketEvent & {
      type: "tool.output_acked";
      toolCallId: string;
      outputItemId: string;
    })
  | (TimedEvent & {
      type: "tool.batch_closed";
      providerResponseId: string;
      batchHash: string;
      toolCallIds: string[];
    })
  | (TimedEvent & {
      type: "approval.persisted";
      toolCallId: string;
      approvalReceiptId: string;
      coverageReceiptId: string;
      revision: number;
      digest: string;
      output: string;
      resultHash: string;
    })
  | (TimedEvent & {
      type: "approval.persistence_failed";
      toolCallId: string;
      code: "timeout" | "query_error" | "empty" | "coverage_incomplete" | "changed" | "not_owner_bound" | "invalid_fact" | "indeterminate";
      safeDetail: string;
    })
  | (TimedEvent & {
      type: "provider.termination_requested";
      intentKey: string;
    })
  | (TimedEvent & {
      type: "provider.termination_confirmed";
      intentKey: string;
      terminalPersisted: boolean;
    })
  | (TimedEvent & { type: "timer.elapsed"; name: string });

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  return value;
}

export function hashOnboardingToolArgs(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(args)), "utf8")
    .digest("hex");
}

function explicitEmergencyEligibility(
  verifiedOwnerWords: string,
): boolean | null {
  const normalized = verifiedOwnerWords
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
  if (
    normalized.includes("?") ||
    /^(?:sera que|seria|por acaso|voce acha)\b/.test(normalized) ||
    /\b(?:sim\s+(?:e|ou)\s+nao|nao\s+(?:e|ou)\s+sim|pode\s+sim\s+(?:e|ou)\s+nao(?:\s+pode)?|nao\s+pode\s+(?:e|ou)\s+pode\s+sim)\b/.test(
      normalized,
    ) ||
    /\b(?:nao sei|nao tenho certeza|talvez|depende|pensando melhor|acho(?: que)?|creio(?: que)?|acredito(?: que)?|provavelmente|possivelmente|preciso (?:confirmar|verificar|avaliar|consultar)|vou (?:confirmar|verificar|avaliar|consultar))\b/.test(
      normalized,
    )
  )
    return null;
  const clauses = normalized
    .split(
      /(?:[.!?;:,]+|\b(?:mas|porem|contudo|entretanto|ou)\b|\be\s+(?=(?:(?:esse|este|o)\s+servico\s+)?(?:pode\s+sim|nao\s+pode)\b))/,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
  const polarities = new Set<boolean>();
  for (const clause of clauses) {
    if (
      /^(?:sim\b|pode\s+sim\b|(?:esse|este|o)\s+servico\s+pode\s+sim\b|(?:esse|este|o)\s+servico\s+(?:e|eh)\s+elegivel\b|(?:e|eh)\s+elegivel\b)/
        .test(clause)
    ) polarities.add(true);
    if (
      /^(?:nao$|nao\s+pode\b|(?:esse|este|o)\s+servico\s+nao\s+pode\b|(?:esse|este|o)\s+servico\s+nao\s+(?:e|eh)\s+elegivel\b|nao\s+(?:e|eh)\s+elegivel\b)/
        .test(clause)
    ) polarities.add(false);
  }
  return polarities.size === 1 ? [...polarities][0]! : null;
}

export function bindVerifiedOnboardingToolArgs(
  name: string,
  args: Record<string, unknown>,
  verifiedOwnerWords?: string,
): Record<string, unknown> {
  const ownerWords = verifiedOwnerWords?.trim();
  if (name !== "record_interview_answer")
    return structuredClone(args);
  if (!ownerWords)
    return {
      ...structuredClone(args),
      owner_words: "",
      ...(args.field === "service.emergency_eligibility"
        ? { structured: { value: "" } }
        : {}),
    };
  const bound = {
    ...structuredClone(args),
    owner_words: ownerWords,
  };
  if (
    bound.field !== "service.emergency_eligibility" ||
    bound.disposition !== "answered" ||
    !bound.structured || typeof bound.structured !== "object" ||
    Array.isArray(bound.structured)
  ) return bound;
  const eligibility = explicitEmergencyEligibility(ownerWords);
  if (eligibility === null)
    return typeof (bound.structured as Record<string, unknown>).value ===
        "boolean"
      ? { ...bound, structured: { value: ownerWords } }
      : bound;
  return {
    ...bound,
    structured: { value: eligibility },
  };
}

const batchKey = (providerResponseId: string, batchHash: string) =>
  `${providerResponseId}:${batchHash}`;
const outputItemId = (toolCallId: string) => `tlo-${createHash("sha256")
  .update(`tool-output\0${toolCallId}`, "utf8")
  .digest("hex")
  .slice(0, 28)}`;
export function onboardingOutputRequestEventId(
  lifecycle: OnboardingLifecycle,
  receipt: ToolReceipt,
  delivery: OutputDelivery,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      call_id: lifecycle.callId,
      tool_call_id: receipt.toolCallId,
      output_item_id: receipt.outputItemId,
      socket_generation: lifecycle.socketGeneration,
      delivery,
    }), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ligou-${delivery}-${digest}`;
}
const elapsed = (event: TimedEvent) =>
  Number.isFinite(event.elapsedMs) && (event.elapsedMs ?? 0) >= 0
    ? Math.floor(event.elapsedMs ?? 0)
    : 0;

function cloneLifecycle(lifecycle: OnboardingLifecycle): OnboardingLifecycle {
  return structuredClone(lifecycle);
}

function telemetry(
  lifecycle: OnboardingLifecycle,
  name: TelemetryName,
  event: TimedEvent,
  fields: Partial<Omit<TelemetryCommand, "type" | "name" | "callIdPrefix" | "socketGeneration" | "lifecycleRevision" | "phase" | "elapsedMs">> = {},
): TelemetryCommand {
  return {
    type: "telemetry",
    name,
    callIdPrefix: lifecycle.callId.slice(0, 8),
    socketGeneration: lifecycle.socketGeneration,
    lifecycleRevision: lifecycle.lifecycleRevision,
    phase: lifecycle.phase,
    elapsedMs: elapsed(event),
    ...(lifecycle.coverage.digest
      ? { snapshotDigestPrefix: lifecycle.coverage.digest.slice(0, 12) }
      : {}),
    ...fields,
  };
}

function terminalizeAuthorityResponseIntents(
  lifecycle: OnboardingLifecycle,
  predicate: (intent: ResponseIntentReceipt) => boolean = () => true,
): void {
  const invalidatedResponseIds = new Set<string>();
  for (const intent of Object.values(lifecycle.responseIntents))
    if (intent.state !== "terminal" && predicate(intent)) {
      if (intent.responseId) invalidatedResponseIds.add(intent.responseId);
      intent.state = "terminal";
    }
  if (
    lifecycle.activeResponseId &&
    invalidatedResponseIds.has(lifecycle.activeResponseId)
  ) delete lifecycle.activeResponseId;
}

function block(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  code: string,
  safeDetail: string,
  toolCallId?: string,
): void {
  lifecycle.phase = "blocked";
  terminalizeAuthorityResponseIntents(lifecycle);
  delete lifecycle.activeResponseId;
  commands.push({
    type: "block",
    code,
    safeDetail,
    ...(toolCallId ? { toolCallId } : {}),
    recoverable: true,
  });
  commands.push(
    telemetry(lifecycle, "invariant.violation", event, {
      outcome: code,
      ...(toolCallId ? { toolCallId } : {}),
    }),
  );
}

function terminalBlock(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  code: string,
  safeDetail: string,
): void {
  lifecycle.phase = "blocked";
  terminalizeAuthorityResponseIntents(lifecycle);
  delete lifecycle.activeResponseId;
  commands.push({
    type: "block",
    code,
    safeDetail,
    recoverable: false,
  });
  commands.push(
    telemetry(lifecycle, "invariant.violation", event, { outcome: code }),
  );
}

function terminateIndeterminateBudgetPause(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  code: string,
  safeDetail: string,
  reason: string,
): void {
  terminalizeAuthorityResponseIntents(lifecycle);
  delete lifecycle.activeResponseId;
  lifecycle.phase = "budget_pause_error_ready_to_terminate";
  lifecycle.budgetErrorTerminationReason = reason;
  commands.push({
    type: "block",
    code,
    safeDetail,
    recoverable: false,
  });
  commands.push(
    telemetry(lifecycle, "invariant.violation", event, { outcome: code }),
  );
  const intentKey = `budget-error-hangup:${lifecycle.callId}`;
  if (lifecycle.requestedBudgetHangupKeys.includes(intentKey)) return;
  lifecycle.requestedBudgetHangupKeys.push(intentKey);
  commands.push({
    type: "request_budget_error_hangup",
    intentKey,
    reason,
  });
}

function terminateFailedRecoveryDelivery(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  safeDetail: string,
): void {
  terminalizeAuthorityResponseIntents(lifecycle);
  delete lifecycle.activeResponseId;
  lifecycle.phase = "recovery_error_ready_to_terminate";
  lifecycle.recoveryTerminationReason = "recovery_delivery_failed";
  commands.push({
    type: "block",
    code: "recovery_delivery_failed",
    safeDetail,
    recoverable: false,
  });
  commands.push(
    telemetry(lifecycle, "invariant.violation", event, {
      outcome: "recovery_delivery_failed",
    }),
  );
  const intentKey = `recovery-error-hangup:${lifecycle.callId}`;
  if (lifecycle.requestedRecoveryHangupKeys.includes(intentKey)) return;
  lifecycle.requestedRecoveryHangupKeys.push(intentKey);
  commands.push({
    type: "request_recovery_error_hangup",
    intentKey,
    reason: "recovery_delivery_failed",
  });
}

function terminateIndeterminateTransport(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  code: string,
  safeDetail: string,
  reason: string,
  fields: { intentKey?: string; toolCallId?: string } = {},
): void {
  terminalizeAuthorityResponseIntents(lifecycle);
  delete lifecycle.activeResponseId;
  lifecycle.phase = "transport_error_ready_to_terminate";
  lifecycle.transportTerminationReason = reason;
  commands.push({
    type: "block",
    code,
    safeDetail,
    ...(fields.toolCallId ? { toolCallId: fields.toolCallId } : {}),
    recoverable: false,
  });
  commands.push(
    telemetry(lifecycle, "invariant.violation", event, {
      outcome: code,
      ...(fields.intentKey ? { intentKey: fields.intentKey } : {}),
      ...(fields.toolCallId ? { toolCallId: fields.toolCallId } : {}),
    }),
  );
  const intentKey = `transport-error-hangup:${lifecycle.callId}`;
  if (lifecycle.requestedTransportHangupKeys.includes(intentKey)) return;
  lifecycle.requestedTransportHangupKeys.push(intentKey);
  commands.push({
    type: "request_transport_error_hangup",
    intentKey,
    reason,
  });
}

function terminateFatalError(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  reason: string,
): void {
  terminalizeAuthorityResponseIntents(lifecycle);
  delete lifecycle.activeResponseId;
  lifecycle.phase = "fatal_error_ready_to_terminate";
  lifecycle.fatalTerminationReason = reason;
  const intentKey = `fatal-error-hangup:${lifecycle.callId}`;
  if (lifecycle.requestedFatalHangupKeys.includes(intentKey)) return;
  lifecycle.requestedFatalHangupKeys.push(intentKey);
  commands.push(
    telemetry(lifecycle, "closing.provider_requested", event, {
      intentKey,
      outcome: "fatal_error",
      errorCode: reason,
    }),
  );
  commands.push({
    type: "request_fatal_error_hangup",
    intentKey,
    reason,
  });
}

function queueResponse(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  request: Omit<Extract<OnboardingCommand, { type: "request_response" }>, "type">,
): boolean {
  if (lifecycle.responseIntents[request.intentKey]) return false;
  if (Object.keys(lifecycle.responseIntents).length >= MAX_RESPONSE_INTENTS) {
    block(
      lifecycle,
      commands,
      event,
      "response_intent_capacity_exceeded",
      "response intent replay registry reached its deterministic bound",
    );
    return false;
  }
  lifecycle.responseIntents[request.intentKey] = {
    intentKey: request.intentKey,
    purpose: request.purpose,
    state: "queued",
  };
  commands.push(
    telemetry(lifecycle, "voice.response.intent_queued", event, {
      intentKey: request.intentKey,
      outcome: request.purpose,
    }),
  );
  commands.push({ type: "request_response", ...request });
  return true;
}

function queueTruthfulRecovery(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  reason:
    | "caller_turn_correlation_mismatch"
    | "owner_turn_completed_without_tool"
    | "tool_persistence_failed"
    | "next_question_unavailable",
  recoveryKey: string,
  fields: { responseId?: string; toolCallId?: string; outcome?: string } = {},
  instructions = TRUTHFUL_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
  emitInvariant = true,
): void {
  if (emitInvariant)
    commands.push(
      telemetry(lifecycle, "invariant.violation", event, {
        outcome: fields.outcome ?? reason,
        ...(fields.responseId ? { responseId: fields.responseId } : {}),
        ...(fields.toolCallId ? { toolCallId: fields.toolCallId } : {}),
      }),
    );
  const intentKey = `recovery:${reason}:${recoveryKey}`;
  if (lifecycle.responseIntents[intentKey]) return;
  if (lifecycle.recoverySpeech) return;
  const recoveryAlreadyOwed = Object.values(lifecycle.responseIntents).some(
    (intent) => intent.purpose === "recovery" && intent.state !== "terminal",
  );
  if (recoveryAlreadyOwed) return;
  const expectedTranscript = recoveryExpectedTranscript(instructions);
  if (!expectedTranscript) {
    terminalBlock(
      lifecycle,
      commands,
      event,
      "recovery_contract_invalid",
      "recovery response did not have an application-owned transcript",
    );
    return;
  }
  lifecycle.phase = "follow_up";
  lifecycle.recoverySpeech = {
    intentKey,
    expectedTranscript,
    terminalAfterPlayback:
      expectedTranscript !== TRUTHFUL_RECOVERY_SENTENCE_PT,
    transcript: "",
    transcriptFinal: false,
    audioDone: false,
    responseDone: false,
    playbackStopped: false,
    interrupted: false,
    attempt: 0,
  };
  queueResponse(lifecycle, commands, event, {
    intentKey,
    purpose: "recovery",
    instructions,
  });
}

function batchIsReady(
  lifecycle: OnboardingLifecycle,
  batch: ToolBatch,
): boolean {
  return (
    batch.closed &&
    batch.toolCallIds.length > 0 &&
    batch.toolCallIds.every(
      (id) => lifecycle.toolOutbox[id]?.state === "output_acked",
    ) &&
    lifecycle.terminalResponseIds.includes(batch.providerResponseId)
  );
}

function everyAdmittedCallIsInAReadyBatch(
  lifecycle: OnboardingLifecycle,
): boolean {
  return Object.values(lifecycle.toolOutbox).every((receipt) => {
    const batch = lifecycle.toolBatches[
      batchKey(receipt.providerResponseId, receipt.batchHash)
    ];
    return (
      batch !== undefined &&
      batch.toolCallIds.includes(receipt.toolCallId) &&
      batchIsReady(lifecycle, batch)
    );
  });
}

function maybeStartBudgetPause(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): boolean {
  const pause = lifecycle.budgetPause;
  if (!pause || pause.responseId || pause.interrupted ||
    lifecycle.activeResponseId || lifecycle.pendingFollowup ||
    lifecycle.snapshotRefresh || !everyAdmittedCallIsInAReadyBatch(lifecycle))
    return false;
  lifecycle.phase = "budget_pause_speaking";
  return queueResponse(lifecycle, commands, event, {
    intentKey: `budget-pause:${lifecycle.callId}${pause.attempt > 0 ? `:retry:${pause.attempt}` : ""}`,
    purpose: "budget_pause",
    instructions: `Diga exatamente uma vez: "${BUDGET_PAUSE_SENTENCE_PT}"`,
  });
}

function maybeAdvanceCoverage(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  if (lifecycle.budgetPause) {
    maybeStartBudgetPause(lifecycle, commands, event);
    return;
  }
  if (
    lifecycle.snapshotRefresh || lifecycle.pendingFollowup ||
    lifecycle.recoverySpeech
  ) return;
  const readyBatches = Object.values(lifecycle.toolBatches).filter(
    (batch) => batchIsReady(lifecycle, batch) && !batch.continuationRequested,
  );
  if (lifecycle.coverage.complete) {
    if (lifecycle.activeResponseId) return;
    if (!everyAdmittedCallIsInAReadyBatch(lifecycle)) return;
    const digest = lifecycle.coverage.digest;
    if (!digest) return;
    if (!lifecycle.preparedSnapshotDigests.includes(digest)) {
      lifecycle.phase = "snapshot_preparing";
      lifecycle.preparedSnapshotDigests.push(digest);
      commands.push(
        telemetry(lifecycle, "onboarding.snapshot.prepare_started", event, {
          outcome: "coverage_complete",
        }),
      );
      commands.push({
        type: "prepare_summary",
        revision: lifecycle.coverage.revision,
        digest,
      });
      return;
    }
    // A refused/ordinary tool still needs exactly one model continuation after
    // its durable output is acknowledged. Prepared coverage suppresses duplicate
    // summaries, not the response required to consume the tool result.
    for (const batch of readyBatches) {
      const intentKey = `tool-batch:${batch.providerResponseId}:${batch.batchHash}`;
      if (
        queueResponse(lifecycle, commands, event, {
          intentKey,
          purpose: "tool_continuation",
        })
      )
        batch.continuationRequested = true;
    }
    return;
  }
  if (lifecycle.coverage.revision === 0 || !lifecycle.coverage.digest) {
    for (const batch of readyBatches) {
      const intentKey = `tool-batch:${batch.providerResponseId}:${batch.batchHash}`;
      if (
        queueResponse(lifecycle, commands, event, {
          intentKey,
          purpose: "tool_continuation",
        })
      ) batch.continuationRequested = true;
    }
    return;
  }
  if (readyBatches.length > 0 && !lifecycle.coverage.nextQuestion) {
    for (const batch of readyBatches) batch.continuationRequested = true;
    queueTruthfulRecovery(
      lifecycle,
      commands,
      event,
      "next_question_unavailable",
      `${lifecycle.coverage.revision}:${lifecycle.coverage.digest}`,
      { outcome: "follow_up_exhausted" },
      FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
    );
    return;
  }
  for (const batch of readyBatches) {
    const intentKey = `tool-batch:${batch.providerResponseId}:${batch.batchHash}`;
    if (lifecycle.coverage.nextQuestion) {
      lifecycle.phase = "follow_up";
      lifecycle.pendingFollowup = {
        sourceRevision: lifecycle.coverage.revision,
        sourceDigest: lifecycle.coverage.digest ?? "",
        ...lifecycle.coverage.nextQuestion,
        intentKey,
      };
      commands.push(
        telemetry(lifecycle, "onboarding.followup.selected", event, {
          intentKey,
          outcome: lifecycle.coverage.nextQuestion.field,
        }),
      );
      commands.push({
        type: "persist_followup",
        revision: lifecycle.coverage.revision,
        digest: lifecycle.coverage.digest ?? "",
        ...lifecycle.coverage.nextQuestion,
        intentKey,
      });
      return;
    }
  }
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

function ownerReplyKind(
  transcript: string,
): "approval" | "correction" | "ambiguous" {
  const normalized = normalizeText(transcript)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const clauses = normalized
    .split(/[.!?;\n]+/)
    .map((clause) => clause.match(/[a-z0-9]+/g) ?? [])
    .filter((clause) => clause.length > 0);
  const containsSequence = (tokens: string[], sequence: string[]) =>
    sequence.length <= tokens.length &&
    tokens.some((_token, start) =>
      sequence.every((expected, offset) => tokens[start + offset] === expected),
    );
  const explicitAssent = (tokens: string[]) =>
    [
      ["aprovado"],
      ["aprovada"],
      ["aprovo"],
      ["confirmo"],
      ["esta", "correto"],
      ["esta", "correta"],
      ["esta", "tudo", "correto"],
      ["esta", "tudo", "correta"],
      ["tudo", "certo"],
      ["tudo", "correto"],
      ["pode", "confirmar"],
    ].some((sequence) => containsSequence(tokens, sequence));
  const negation = (tokens: string[]) =>
    tokens.some((token) =>
      [
        "nao",
        "nunca",
        "jamais",
        "nem",
        "tampouco",
        "nenhum",
        "nenhuma",
        "negativo",
        "negativa",
        "discordo",
        "recuso",
        "rejeito",
      ].includes(token)
    );
  const negativeIdiom = (tokens: string[]) =>
    [
      ["de", "forma", "alguma"],
      ["de", "modo", "algum"],
      ["de", "jeito", "nenhum"],
      ["de", "jeito", "algum"],
      ["de", "nenhuma", "forma"],
      ["de", "nenhum", "modo"],
      ["de", "maneira", "alguma"],
      ["em", "hipotese", "alguma"],
      ["nem", "pensar"],
    ].some((sequence) => containsSequence(tokens, sequence));
  const utteranceHasRefusal = clauses.some(
    (clause) => negation(clause) || negativeIdiom(clause),
  );
  const whitelistedNegativeConfirmation =
    /^(?:nao tenho (?:correcao|correcoes)|nao ha (?:correcao|correcoes))\s*[.!;]+\s*(?:esta tudo correto|esta tudo correta|tudo certo|tudo correto|confirmo|aprovado|aprovada)\s*[.!]*$/.test(
      normalized,
    );
  if (
    (utteranceHasRefusal && !whitelistedNegativeConfirmation) ||
    (!whitelistedNegativeConfirmation &&
      /\b(nao aprovado|nao aprovo|nao esta correto|nao esta certa|incorret|errad|corrig|correcao|mude|altere|mas)\b/.test(
        normalized,
      ))
  )
    return "correction";
  if (clauses.some(explicitAssent))
    return "approval";
  return "ambiguous";
}

function normalizedBoundaryTokens(value: string): string[] {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]+/g) ?? [];
}

function tokenSequenceStarts(
  transcript: string[],
  anchor: string[],
): number[] {
  if (anchor.length === 0 || anchor.length > transcript.length) return [];
  const starts: number[] = [];
  for (let start = 0; start <= transcript.length - anchor.length; start += 1)
    if (anchor.every((token, offset) => transcript[start + offset] === token))
      starts.push(start);
  return starts;
}

function greetingTranscriptValid(
  lifecycle: OnboardingLifecycle,
  greeting: GreetingProof,
): boolean {
  const transcript = normalizedBoundaryTokens(greeting.transcript);
  const identity = normalizedBoundaryTokens(
    `Oi! Aqui é o Ligou, agente de inteligência artificial da ${lifecycle.expectedBusinessName}`,
  );
  const question = normalizedBoundaryTokens(
    INITIAL_SERVICE_DISCOVERY_QUESTION_PT,
  );
  const identityStarts = tokenSequenceStarts(transcript, identity);
  const questionStarts = tokenSequenceStarts(transcript, question);
  if (identityStarts.length !== 1 || questionStarts.length !== 1) return false;
  const identityStart = identityStarts[0]!;
  const questionStart = questionStarts[0]!;
  return identityStart === 0 &&
    questionStart === identity.length &&
    questionStart + question.length === transcript.length;
}

type RetriableAuthoritySpeechKind =
  | "greeting"
  | "summary"
  | "signoff"
  | "budget_pause";

function terminalAuthorityProofFailure(proof: {
  transcriptFinal: boolean;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
}): string | null {
  if (!proof.responseDone) return null;
  if (!proof.audioDone)
    return "response_terminal_without_audible_evidence";
  if (proof.playbackStopped && !proof.transcriptFinal)
    return "playback_terminal_without_final_transcript";
  return null;
}

function retryOrTerminateAuthoritySpeech(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  kind: RetriableAuthoritySpeechKind,
): void {
  const proof = kind === "greeting"
    ? lifecycle.greeting
    : kind === "summary"
      ? lifecycle.summary
      : kind === "signoff"
        ? lifecycle.signoff
        : lifecycle.budgetPause;
  if (!proof) return;
  if (proof.attempt >= 1) {
    block(
      lifecycle,
      commands,
      event,
      "authority_speech_retry_exhausted",
      `${kind} exhausted its single exact-audible retry`,
    );
    return;
  }

  proof.attempt = 1;
  delete proof.responseId;
  delete proof.interruptedResponseId;
  delete proof.validated;
  proof.transcript = "";
  proof.transcriptFinal = false;
  proof.audioDone = false;
  proof.responseDone = false;
  proof.playbackStopped = false;
  proof.interrupted = false;

  if (kind === "greeting") {
    lifecycle.phase = "greeting";
    queueResponse(lifecycle, commands, event, {
      intentKey: `greeting:${lifecycle.callId}:retry:1`,
      purpose: "greeting",
      instructions: INITIAL_GREETING_RESPONSE_INSTRUCTIONS_PT,
    });
    return;
  }
  if (kind === "summary") {
    const summary = lifecycle.summary!;
    delete lifecycle.approvalCandidate;
    lifecycle.freshCallerTurnIds = [];
    lifecycle.phase = "summary_speaking";
    queueResponse(lifecycle, commands, event, {
      intentKey: `summary:${summary.digest}:retry:1`,
      purpose: "summary",
      snapshotDigest: summary.digest,
      instructions: summaryResponseInstructions(summary),
    });
    return;
  }
  if (kind === "signoff") {
    const signoff = lifecycle.signoff!;
    lifecycle.phase = "final_signoff_speaking";
    queueResponse(lifecycle, commands, event, {
      intentKey:
        `final-signoff:${signoff.approvalReceiptId}:retry:1`,
      purpose: "final_signoff",
      instructions: `Diga exatamente: "${FINAL_SIGNOFF_SENTENCE_PT}"`,
      approvalReceiptId: signoff.approvalReceiptId,
    });
    return;
  }
  lifecycle.phase = "budget_pause_speaking";
  queueResponse(lifecycle, commands, event, {
    intentKey: `budget-pause:${lifecycle.callId}:retry:1`,
    purpose: "budget_pause",
    instructions: `Diga exatamente uma vez: "${BUDGET_PAUSE_SENTENCE_PT}"`,
  });
}

function maybeValidateGreeting(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const greeting = lifecycle.greeting;
  if (!greeting || greeting.validated !== undefined || greeting.interrupted)
    return;
  const terminalFailure = terminalAuthorityProofFailure(greeting);
  if (terminalFailure) {
    commands.push(
      telemetry(lifecycle, "onboarding.greeting.invalid", event, {
        responseId: greeting.responseId,
        intentKey: `greeting:${lifecycle.callId}`,
        outcome: terminalFailure,
      }),
    );
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "greeting",
    );
    return;
  }
  if (
    !greeting.transcriptFinal || !greeting.audioDone ||
    !greeting.responseDone || !greeting.playbackStopped
  ) return;
  greeting.validated = greetingTranscriptValid(lifecycle, greeting);
  if (!greeting.validated) {
    commands.push(
      telemetry(lifecycle, "onboarding.greeting.invalid", event, {
        responseId: greeting.responseId,
        intentKey: `greeting:${lifecycle.callId}`,
        outcome: "identity_or_question_proof_invalid",
      }),
    );
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "greeting",
    );
    return;
  }
  lifecycle.phase = "collecting";
  commands.push(
    telemetry(lifecycle, "onboarding.greeting.validated", event, {
      responseId: greeting.responseId,
      intentKey: `greeting:${lifecycle.callId}`,
      outcome: "spoken_opening_proven",
    }),
  );
}

function containsAnchorTokens(transcript: string[], anchor: string[]): boolean {
  if (anchor.length === 0 || anchor.length > transcript.length) return false;
  for (let start = 0; start <= transcript.length - anchor.length; start += 1)
    if (anchor.every((token, offset) => transcript[start + offset] === token))
      return true;
  return false;
}

function summaryTranscriptValid(summary: SummaryProof): boolean {
  const transcript = normalizeText(summary.transcript);
  const transcriptTokens = normalizedBoundaryTokens(transcript);
  if (
    summary.requiredAnchors.some(
      (anchor) =>
        !containsAnchorTokens(
          transcriptTokens,
          normalizedBoundaryTokens(anchor),
        ),
    )
  )
    return false;
  const plain = transcript
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (
    /\b(deixe-me|deixa eu|vou verificar|vou consultar|aguarde|so um momento|estou verificando|estou consultando|let me)\b/.test(
      plain,
    )
  )
    return false;
  return (
    transcript.includes("?") &&
    /\b(confirma|esta correto|esta tudo correto|tudo correto)\b/.test(plain)
  );
}

function maybeValidateSummary(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const summary = lifecycle.summary;
  if (!summary || summary.validated !== undefined || summary.interrupted)
    return;
  const terminalFailure = terminalAuthorityProofFailure(summary);
  if (terminalFailure) {
    commands.push(
      telemetry(lifecycle, "onboarding.summary.invalid", event, {
        responseId: summary.responseId,
        intentKey: `summary:${summary.digest}`,
        outcome: terminalFailure,
      }),
    );
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "summary",
    );
    return;
  }
  if (
    !summary.transcriptFinal || !summary.audioDone ||
    !summary.responseDone || !summary.playbackStopped
  ) return;
  summary.validated = summaryTranscriptValid(summary);
  if (!summary.validated) {
    commands.push(
      telemetry(lifecycle, "onboarding.summary.invalid", event, {
        responseId: summary.responseId,
        intentKey: `summary:${summary.digest}`,
        outcome: "factual_or_audio_proof_invalid",
      }),
    );
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "summary",
    );
    return;
  }
  lifecycle.phase = "awaiting_owner_approval";
  commands.push(
    telemetry(lifecycle, "onboarding.summary.validated", event, {
      responseId: summary.responseId,
      intentKey: `summary:${summary.digest}`,
      outcome: "spoken_summary_proven",
    }),
  );
}

function signoffTranscriptValid(transcript: string): boolean {
  return JSON.stringify(normalizedBoundaryTokens(transcript)) ===
    JSON.stringify(normalizedBoundaryTokens(FINAL_SIGNOFF_SENTENCE_PT));
}

function budgetPauseTranscriptValid(transcript: string): boolean {
  return JSON.stringify(normalizedBoundaryTokens(transcript)) ===
    JSON.stringify(normalizedBoundaryTokens(BUDGET_PAUSE_SENTENCE_PT));
}

function followupTranscriptValid(
  transcript: string,
  questionPt: string,
): boolean {
  return JSON.stringify(normalizedBoundaryTokens(transcript)) ===
    JSON.stringify(normalizedBoundaryTokens(questionPt));
}

function retryOrRecoverFollowupSpeech(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  outcome: string,
): void {
  const proof = lifecycle.followupSpeech;
  if (!proof) return;
  commands.push(
    telemetry(lifecycle, "onboarding.followup.invalid", event, {
      responseId: proof.responseId,
      intentKey: proof.intentKey,
      outcome,
    }),
  );
  if (proof.attempt >= 1) {
    const recoveryKey = `${proof.intentKey}:content-invalid`;
    delete lifecycle.followupSpeech;
    queueTruthfulRecovery(
      lifecycle,
      commands,
      event,
      "next_question_unavailable",
      recoveryKey,
      { outcome: "followup_content_invalid" },
      FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
    );
    return;
  }
  const retryIntentKey = `${proof.intentKey}:retry:1`;
  proof.intentKey = retryIntentKey;
  proof.attempt = 1;
  delete proof.responseId;
  delete proof.validated;
  proof.transcript = "";
  proof.transcriptFinal = false;
  proof.audioDone = false;
  proof.responseDone = false;
  proof.playbackStopped = false;
  proof.interrupted = false;
  lifecycle.phase = "follow_up";
  queueResponse(lifecycle, commands, event, {
    intentKey: retryIntentKey,
    purpose: "tool_continuation",
    instructions: proof.questionPt,
  });
}

function maybeFinishFollowupSpeech(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const proof = lifecycle.followupSpeech;
  if (!proof || proof.interrupted) return;
  const terminalFailure = terminalAuthorityProofFailure(proof);
  if (terminalFailure) {
    retryOrRecoverFollowupSpeech(
      lifecycle,
      commands,
      event,
      terminalFailure,
    );
    return;
  }
  if (
    !proof.transcriptFinal || !proof.audioDone ||
    !proof.responseDone || !proof.playbackStopped
  ) return;
  proof.validated = followupTranscriptValid(
    proof.transcript,
    proof.questionPt,
  );
  if (!proof.validated) {
    retryOrRecoverFollowupSpeech(
      lifecycle,
      commands,
      event,
      "expected_question_not_spoken",
    );
    return;
  }
  lifecycle.phase = "collecting";
  commands.push(
    telemetry(lifecycle, "onboarding.followup.validated", event, {
      responseId: proof.responseId,
      intentKey: proof.intentKey,
      outcome: "spoken_question_proven",
    }),
  );
  delete lifecycle.followupSpeech;
}

function retryOrFinishRecoverySpeech(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  outcome: string,
): void {
  const proof = lifecycle.recoverySpeech;
  if (!proof) return;
  commands.push(
    telemetry(lifecycle, "onboarding.recovery.invalid", event, {
      responseId: proof.responseId,
      intentKey: proof.intentKey,
      outcome,
    }),
  );
  if (proof.attempt >= 1) {
    terminateFailedRecoveryDelivery(
      lifecycle,
      commands,
      event,
      "truthful recovery did not produce exact audible playback",
    );
    return;
  }
  const baseIntentKey = proof.intentKey.replace(/:retry:1$/, "");
  proof.intentKey = `${baseIntentKey}:retry:1`;
  proof.attempt = 1;
  delete proof.responseId;
  delete proof.validated;
  proof.transcript = "";
  proof.transcriptFinal = false;
  proof.audioDone = false;
  proof.responseDone = false;
  proof.playbackStopped = false;
  proof.interrupted = false;
  delete proof.interruptedResponseId;
  lifecycle.phase = "follow_up";
  queueResponse(lifecycle, commands, event, {
    intentKey: proof.intentKey,
    purpose: "recovery",
    instructions: exactRecoveryInstructions(proof.expectedTranscript),
  });
}

function maybeFinishRecoverySpeech(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const proof = lifecycle.recoverySpeech;
  if (!proof || proof.interrupted) return;
  const terminalFailure = terminalAuthorityProofFailure(proof);
  if (terminalFailure) {
    retryOrFinishRecoverySpeech(
      lifecycle,
      commands,
      event,
      terminalFailure,
    );
    return;
  }
  if (
    !proof.transcriptFinal || !proof.audioDone ||
    !proof.responseDone || !proof.playbackStopped
  ) return;
  proof.validated =
    JSON.stringify(normalizedBoundaryTokens(proof.transcript)) ===
      JSON.stringify(normalizedBoundaryTokens(proof.expectedTranscript));
  if (!proof.validated) {
    retryOrFinishRecoverySpeech(
      lifecycle,
      commands,
      event,
      "recovery_content_invalid",
    );
    return;
  }
  commands.push(
    telemetry(lifecycle, "onboarding.recovery.validated", event, {
      responseId: proof.responseId,
      intentKey: proof.intentKey,
      outcome: "truthful_error_playback_proven",
    }),
  );
  if (proof.terminalAfterPlayback)
    terminalBlock(
      lifecycle,
      commands,
      event,
      "recovery_spoken",
      "truthful terminal recovery playback was proven",
    );
  else {
    lifecycle.phase = "collecting";
    delete lifecycle.recoverySpeech;
    maybeAdvanceCoverage(lifecycle, commands, event);
  }
}

function maybeFinishBudgetPause(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const pause = lifecycle.budgetPause;
  if (!pause || pause.interrupted) return;
  if (terminalAuthorityProofFailure(pause)) {
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "budget_pause",
    );
    return;
  }
  if (!pause.transcriptFinal || !pause.audioDone ||
    !pause.responseDone || !pause.playbackStopped) return;
  pause.validated = budgetPauseTranscriptValid(pause.transcript);
  if (!pause.validated) {
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "budget_pause",
    );
    return;
  }
  lifecycle.phase = "budget_pause_ready_to_terminate";
  const intentKey = `budget-hangup:${lifecycle.callId}`;
  if (lifecycle.requestedBudgetHangupKeys.includes(intentKey)) return;
  lifecycle.requestedBudgetHangupKeys.push(intentKey);
  commands.push(
    telemetry(lifecycle, "closing.budget_requested", event, {
      intentKey,
      responseId: pause.responseId,
      outcome: "budget_pause_playback_proven",
    }),
  );
  commands.push({
    type: "request_budget_hangup",
    intentKey,
    costUsd: pause.costUsd,
    softLimitUsd: pause.softLimitUsd,
    hardLimitUsd: pause.hardLimitUsd,
  });
}

function summaryResponseInstructions(summary: SummaryProof): string {
  const facts = summary.requiredAnchors.join("\n");
  return `Fale diretamente estes fatos, sem narrar o processo:\n${facts}\n` +
    "Ao final, pergunte explicitamente se tudo está correto.";
}

function maybeQueueInterruptedSpeechRecovery(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): boolean {
  const kind = lifecycle.greeting?.interrupted
    ? "greeting"
    : lifecycle.summary?.interrupted
      ? "summary"
      : lifecycle.signoff?.interrupted
        ? "signoff"
        : lifecycle.budgetPause?.interrupted
          ? "budget_pause"
          : lifecycle.followupSpeech?.interrupted
            ? "followup"
            : lifecycle.recoverySpeech?.interrupted
              ? "recovery"
          : null;
  if (!kind) return false;
  const proof = kind === "greeting"
    ? lifecycle.greeting!
    : kind === "summary"
      ? lifecycle.summary!
      : kind === "signoff"
      ? lifecycle.signoff!
        : kind === "budget_pause"
          ? lifecycle.budgetPause!
          : kind === "followup"
            ? lifecycle.followupSpeech!
            : lifecycle.recoverySpeech!;
  const interruptedResponseId = proof.interruptedResponseId;
  if (
    !interruptedResponseId ||
    !lifecycle.terminalResponseIds.includes(interruptedResponseId)
  ) return false;
  if ((proof.attempt ?? 0) >= 1) {
    if (kind === "followup") {
      const recoveryKey = `${proof.intentKey}:interrupted`;
      delete lifecycle.followupSpeech;
      queueTruthfulRecovery(
        lifecycle,
        commands,
        event,
        "next_question_unavailable",
        recoveryKey,
        { outcome: "followup_speech_retry_exhausted" },
        FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
      );
      return true;
    }
    if (kind === "recovery") {
      terminateFailedRecoveryDelivery(
        lifecycle,
        commands,
        event,
        "truthful recovery exhausted its single speech retry",
      );
      return false;
    }
    block(
      lifecycle,
      commands,
      event,
      "authority_speech_retry_exhausted",
      "application-owned authority speech exhausted its single retry",
    );
    return false;
  }

  proof.attempt = 1;
  delete proof.responseId;
  delete proof.interruptedResponseId;
  delete proof.validated;
  proof.transcript = "";
  proof.transcriptFinal = false;
  proof.audioDone = false;
  proof.responseDone = false;
  proof.playbackStopped = false;
  proof.interrupted = false;

  if (kind === "greeting") {
    lifecycle.phase = "greeting";
    return queueResponse(lifecycle, commands, event, {
      intentKey: `greeting:${lifecycle.callId}:retry:1`,
      purpose: "greeting",
      instructions: INITIAL_GREETING_RESPONSE_INSTRUCTIONS_PT,
    });
  }
  if (kind === "summary") {
    const summary = lifecycle.summary!;
    lifecycle.phase = "summary_speaking";
    return queueResponse(lifecycle, commands, event, {
      intentKey: `summary:${summary.digest}:retry:1`,
      purpose: "summary",
      snapshotDigest: summary.digest,
      instructions: summaryResponseInstructions(summary),
    });
  }
  if (kind === "budget_pause") {
    const pause = lifecycle.budgetPause!;
    lifecycle.phase = "budget_pause_speaking";
    return queueResponse(lifecycle, commands, event, {
      intentKey: `budget-pause:${lifecycle.callId}:retry:1`,
      purpose: "budget_pause",
      instructions: `Diga exatamente uma vez: "${BUDGET_PAUSE_SENTENCE_PT}"`,
    });
  }
  if (kind === "followup") {
    const followup = lifecycle.followupSpeech!;
    const baseIntentKey = followup.intentKey.replace(/:retry:1$/, "");
    followup.intentKey = `${baseIntentKey}:retry:1`;
    lifecycle.phase = "follow_up";
    return queueResponse(lifecycle, commands, event, {
      intentKey: followup.intentKey,
      purpose: "tool_continuation",
      instructions: followup.questionPt,
    });
  }
  if (kind === "recovery") {
    const recovery = lifecycle.recoverySpeech!;
    const baseIntentKey = recovery.intentKey.replace(/:retry:1$/, "");
    recovery.intentKey = `${baseIntentKey}:retry:1`;
    lifecycle.phase = "follow_up";
    return queueResponse(lifecycle, commands, event, {
      intentKey: recovery.intentKey,
      purpose: "recovery",
      instructions: exactRecoveryInstructions(recovery.expectedTranscript),
    });
  }
  const signoff = lifecycle.signoff!;
  lifecycle.phase = "final_signoff_speaking";
  return queueResponse(lifecycle, commands, event, {
    intentKey: `final-signoff:${signoff.approvalReceiptId}:retry:1`,
    purpose: "final_signoff",
    instructions: `Diga exatamente: "${FINAL_SIGNOFF_SENTENCE_PT}"`,
    approvalReceiptId: signoff.approvalReceiptId,
  });
}

function maybeFinishSignoff(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const signoff = lifecycle.signoff;
  const approval = lifecycle.approval;
  if (
    !signoff ||
    !approval ||
    signoff.interrupted
  )
    return;
  if (terminalAuthorityProofFailure(signoff)) {
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "signoff",
    );
    return;
  }
  if (!signoff.audioDone || !signoff.responseDone ||
    !signoff.playbackStopped) return;
  if (!signoff.transcriptFinal || signoff.validated !== true) {
    retryOrTerminateAuthoritySpeech(
      lifecycle,
      commands,
      event,
      "signoff",
    );
    return;
  }
  lifecycle.phase = "ready_to_terminate";
  const intentKey = `hangup:${approval.approvalReceiptId}`;
  if (lifecycle.requestedHangupKeys.includes(intentKey)) return;
  lifecycle.requestedHangupKeys.push(intentKey);
  commands.push(
    telemetry(lifecycle, "closing.provider_requested", event, {
      intentKey,
      responseId: signoff.responseId,
      outcome: "signoff_playback_proven",
    }),
  );
  commands.push({
    type: "request_hangup",
    intentKey,
    approvalReceiptId: approval.approvalReceiptId,
  });
}

function startSignoff(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  const approval = lifecycle.approval;
  if (!approval) return;
  lifecycle.phase = "final_signoff_speaking";
  lifecycle.signoff = {
    approvalReceiptId: approval.approvalReceiptId,
    transcript: "",
    transcriptFinal: false,
    audioDone: false,
    responseDone: false,
    playbackStopped: false,
    interrupted: false,
    attempt: 0,
  };
  const intentKey = `final-signoff:${approval.approvalReceiptId}`;
  const instructions = `Diga exatamente: "${FINAL_SIGNOFF_SENTENCE_PT}"`;
  commands.push({
    type: "request_signoff",
    intentKey,
    approvalReceiptId: approval.approvalReceiptId,
    instructions,
  });
  queueResponse(lifecycle, commands, event, {
    intentKey,
    purpose: "final_signoff",
    instructions,
    approvalReceiptId: approval.approvalReceiptId,
  });
}

function maybeStartSignoffForReadyBatch(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): boolean {
  const approval = lifecycle.approval;
  if (!approval || lifecycle.phase !== "approval_persisting") return false;
  const receipt = lifecycle.toolOutbox[approval.toolCallId];
  if (!receipt || receipt.state !== "output_acked") return false;
  const batch = lifecycle.toolBatches[
    batchKey(receipt.providerResponseId, receipt.batchHash)
  ];
  if (!batch || !batchIsReady(lifecycle, batch)) return false;
  // The approval-bound signoff is the one continuation for this batch.
  // Mark it consumed before speech so a failed/inaudible signoff cannot queue
  // an unrelated model continuation after its terminal response.
  batch.continuationRequested = true;
  startSignoff(lifecycle, commands, event);
  return true;
}

function rejectApprovalReceipt(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  receipt: ToolReceipt,
  outcome: string,
): void {
  const output = JSON.stringify({
    status: "approval_rejected",
    reason: "fresh_explicit_owner_assent_required",
  });
  receipt.state = "executed";
  receipt.output = output;
  receipt.resultHash = hashOnboardingToolArgs({ output });
  resendOutput(lifecycle, commands, event, receipt, false);
  commands.push(
    telemetry(lifecycle, "onboarding.approval.rejected", event, {
      toolCallId: receipt.toolCallId,
      outcome,
    }),
  );
}

function persistApprovalFromTranscript(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  receipt: ToolReceipt,
  ownerWords: string,
): boolean {
  const summary = lifecycle.summary;
  if (!summary?.validated || !summary.playbackStopped) return false;
  lifecycle.phase = "approval_persisting";
  commands.push({
    type: "persist_approval",
    toolCallId: receipt.toolCallId,
    argsHash: receipt.argsHash,
    ownerWords: ownerWords.trim(),
    coverageReceiptId: summary.receiptId,
    revision: summary.revision,
    digest: summary.digest,
  });
  return true;
}

function resendOutput(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  receipt: ToolReceipt,
  replay: boolean,
): void {
  if (receipt.output === undefined) return;
  const delivery: OutputDelivery = receipt.state === "output_pending"
    ? "retrieve"
    : "create";
  commands.push({
    type: "resend_output",
    toolCallId: receipt.toolCallId,
    output: receipt.output,
    outputItemId: receipt.outputItemId,
    replay,
    socketGeneration: lifecycle.socketGeneration,
    delivery,
    eventId: onboardingOutputRequestEventId(lifecycle, receipt, delivery),
  });
  if (replay)
    commands.push(
      telemetry(lifecycle, "voice.tool.output_retry", event, {
        toolCallId: receipt.toolCallId,
        outcome: receipt.state,
      }),
    );
}

function validSocketGeneration(
  lifecycle: OnboardingLifecycle,
  event: OnboardingEvent,
): boolean {
  return !(
    "socketGeneration" in event &&
    event.type !== "socket.attached" &&
    event.socketGeneration !== lifecycle.socketGeneration
  );
}

function reissuePendingTerminationAfterAttach(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
): boolean {
  const approvalIntentKey = lifecycle.approval
    ? `hangup:${lifecycle.approval.approvalReceiptId}`
    : "";
  if (
    lifecycle.phase === "ready_to_terminate" && approvalIntentKey &&
    lifecycle.requestedHangupKeys.includes(approvalIntentKey)
  ) {
    commands.push({
      type: "request_hangup",
      intentKey: approvalIntentKey,
      approvalReceiptId: lifecycle.approval!.approvalReceiptId,
    });
    return true;
  }
  const budgetIntentKey = `budget-hangup:${lifecycle.callId}`;
  if (
    lifecycle.phase === "budget_pause_ready_to_terminate" &&
    lifecycle.budgetPause &&
    lifecycle.requestedBudgetHangupKeys.includes(budgetIntentKey)
  ) {
    commands.push({
      type: "request_budget_hangup",
      intentKey: budgetIntentKey,
      costUsd: lifecycle.budgetPause.costUsd,
      softLimitUsd: lifecycle.budgetPause.softLimitUsd,
      hardLimitUsd: lifecycle.budgetPause.hardLimitUsd,
    });
    return true;
  }
  const budgetErrorIntentKey = `budget-error-hangup:${lifecycle.callId}`;
  if (
    lifecycle.phase === "budget_pause_error_ready_to_terminate" &&
    lifecycle.requestedBudgetHangupKeys.includes(budgetErrorIntentKey)
  ) {
    commands.push({
      type: "request_budget_error_hangup",
      intentKey: budgetErrorIntentKey,
      reason: lifecycle.budgetErrorTerminationReason ??
        "budget_pause_response_ack_indeterminate",
    });
    return true;
  }
  const recoveryIntentKey = `recovery-error-hangup:${lifecycle.callId}`;
  if (
    lifecycle.phase === "recovery_error_ready_to_terminate" &&
    lifecycle.requestedRecoveryHangupKeys.includes(recoveryIntentKey)
  ) {
    commands.push({
      type: "request_recovery_error_hangup",
      intentKey: recoveryIntentKey,
      reason: lifecycle.recoveryTerminationReason ?? "recovery_delivery_failed",
    });
    return true;
  }
  const transportIntentKey = `transport-error-hangup:${lifecycle.callId}`;
  if (
    lifecycle.phase === "transport_error_ready_to_terminate" &&
    lifecycle.requestedTransportHangupKeys.includes(transportIntentKey)
  ) {
    commands.push({
      type: "request_transport_error_hangup",
      intentKey: transportIntentKey,
      reason: lifecycle.transportTerminationReason ??
        "transport_indeterminate_after_reattach",
    });
    return true;
  }
  const fatalIntentKey = `fatal-error-hangup:${lifecycle.callId}`;
  if (
    lifecycle.phase === "fatal_error_ready_to_terminate" &&
    lifecycle.requestedFatalHangupKeys.includes(fatalIntentKey)
  ) {
    commands.push({
      type: "request_fatal_error_hangup",
      intentKey: fatalIntentKey,
      reason: lifecycle.fatalTerminationReason ??
        "fatal_error_after_reattach",
    });
    return true;
  }
  return false;
}

function isRepeatedLateTerminationProof(
  lifecycle: OnboardingLifecycle,
  event: OnboardingEvent,
): boolean {
  let responseId: string | undefined;
  let authorized = false;
  if (lifecycle.phase === "provider_terminating") {
    responseId = lifecycle.signoff?.responseId;
    authorized = Boolean(lifecycle.approval &&
      lifecycle.requestedHangupKeys.includes(
        `hangup:${lifecycle.approval.approvalReceiptId}`,
      ));
  } else if (lifecycle.phase === "budget_pause_provider_terminating") {
    responseId = lifecycle.budgetPause?.responseId;
    authorized = lifecycle.requestedBudgetHangupKeys.includes(
      `budget-hangup:${lifecycle.callId}`,
    );
  } else if (lifecycle.phase === "budget_error_provider_terminating") {
    responseId = lifecycle.budgetPause?.responseId;
    authorized = lifecycle.requestedBudgetHangupKeys.includes(
      `budget-error-hangup:${lifecycle.callId}`,
    );
  } else if (lifecycle.phase === "recovery_error_provider_terminating") {
    responseId = lifecycle.recoverySpeech?.responseId;
    authorized = lifecycle.requestedRecoveryHangupKeys.includes(
      `recovery-error-hangup:${lifecycle.callId}`,
    );
  }
  if (!responseId || !authorized) return false;
  return (
    event.type === "response.transcript.delta" ||
    event.type === "response.transcript.done" ||
    event.type === "response.output_audio.done" ||
    event.type === "response.done" ||
    event.type === "output_audio_buffer.stopped"
  ) && event.responseId === responseId;
}

function recordTerminalResponseId(
  lifecycle: OnboardingLifecycle,
  responseId: string,
  commands: OnboardingCommand[],
  event: TimedEvent,
): boolean {
  if (lifecycle.terminalResponseIds.includes(responseId)) return true;
  if (lifecycle.terminalResponseIds.length >= MAX_TERMINAL_RESPONSE_IDS) {
    const protectedIds = new Set<string>([
      ...Object.values(lifecycle.toolBatches)
        .map((batch) => batch.providerResponseId),
      ...(lifecycle.activeResponseId ? [lifecycle.activeResponseId] : []),
      ...(lifecycle.summary?.responseId ? [lifecycle.summary.responseId] : []),
      ...(lifecycle.signoff?.responseId ? [lifecycle.signoff.responseId] : []),
      ...(lifecycle.followupSpeech?.responseId
        ? [lifecycle.followupSpeech.responseId]
        : []),
      ...(lifecycle.recoverySpeech?.responseId
        ? [lifecycle.recoverySpeech.responseId]
        : []),
      ...Object.values(lifecycle.responseIntents)
        .filter((intent) => intent.state !== "terminal" && intent.responseId)
        .map((intent) => intent.responseId!),
    ]);
    const pruneIndex = lifecycle.terminalResponseIds.findIndex(
      (candidate) => !protectedIds.has(candidate),
    );
    if (pruneIndex < 0) {
      block(
        lifecycle,
        commands,
        event,
        "terminal_response_capacity_exceeded",
        "terminal response replay registry reached its deterministic bound",
      );
      return false;
    }
    lifecycle.terminalResponseIds.splice(pruneIndex, 1);
  }
  lifecycle.terminalResponseIds.push(responseId);
  return true;
}

function reduceBlockedBookkeeping(
  current: OnboardingLifecycle,
  event: OnboardingEvent,
): { lifecycle: OnboardingLifecycle; commands: OnboardingCommand[] } {
  if (event.type === "fatal.termination_required") {
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    const commands: OnboardingCommand[] = [];
    terminateFatalError(lifecycle, commands, event, event.code);
    return { lifecycle, commands };
  }
  if (event.type === "socket.attached") {
    if (event.socketGeneration < current.socketGeneration)
      return {
        lifecycle: current,
        commands: [telemetry(current, "invariant.violation", event, {
          outcome: "stale_socket_attach",
        })],
      };
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    lifecycle.socketGeneration = event.socketGeneration;
    terminalizeAuthorityResponseIntents(lifecycle);
    delete lifecycle.activeResponseId;
    const commands: OnboardingCommand[] = [];
    terminateFatalError(
      lifecycle,
      commands,
      event,
      "blocked_lifecycle_reattached",
    );
    return { lifecycle, commands };
  }
  if (event.type === "tool.executed") {
    const receipt = current.toolOutbox[event.toolCallId];
    if (!receipt || receipt.state !== "running")
      return {
        lifecycle: current,
        commands: [telemetry(current, "invariant.violation", event, {
          toolCallId: event.toolCallId,
          outcome: "blocked_invalid_tool_execution",
        })],
      };
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    const nextReceipt = lifecycle.toolOutbox[event.toolCallId]!;
    nextReceipt.state = "executed";
    nextReceipt.output = event.output;
    nextReceipt.resultHash = event.resultHash;
    const commands: OnboardingCommand[] = [
      telemetry(lifecycle, "voice.tool.executed", event, {
        toolCallId: event.toolCallId,
        outcome: "blocked_bookkeeping_only",
      }),
    ];
    resendOutput(lifecycle, commands, event, nextReceipt, false);
    return { lifecycle, commands };
  }
  if (event.type === "provider.termination_confirmed") {
    const expected = current.approval
      ? `hangup:${current.approval.approvalReceiptId}`
      : "";
    if (
      !expected ||
      event.intentKey !== expected ||
      !event.terminalPersisted ||
      !current.requestedHangupKeys.includes(expected)
    )
      return {
        lifecycle: current,
        commands: [telemetry(current, "invariant.violation", event, {
          intentKey: event.intentKey,
          outcome: "blocked_provider_confirmation_mismatch",
        })],
      };
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    lifecycle.providerTerminationConfirmed = true;
    lifecycle.phase = "closed";
    return {
      lifecycle,
      commands: [
        telemetry(lifecycle, "closing.provider_confirmed", event, {
          intentKey: event.intentKey,
          outcome: "provider_and_terminal_persisted",
        }),
        telemetry(lifecycle, "onboarding.closed", event, {
          intentKey: event.intentKey,
          outcome: "durable_completion",
        }),
      ],
    };
  }
  if (!validSocketGeneration(current, event))
    return {
      lifecycle: current,
      commands: [
        telemetry(current, "invariant.violation", event, {
          outcome: "stale_socket_generation",
        }),
      ],
    };
  if (event.type === "response.done") {
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    const commands: OnboardingCommand[] = [];
    recordTerminalResponseId(lifecycle, event.responseId, commands, event);
    if (lifecycle.activeResponseId === event.responseId)
      delete lifecycle.activeResponseId;
    for (const intent of Object.values(lifecycle.responseIntents))
      if (intent.responseId === event.responseId) intent.state = "terminal";
    commands.push(
      telemetry(lifecycle, "voice.response.terminal", event, {
        responseId: event.responseId,
        outcome: "blocked_bookkeeping_only",
      }),
    );
    return { lifecycle, commands };
  }
  if (event.type === "tool.output_create_duplicate") {
    const receipt = current.toolOutbox[event.toolCallId];
    if (
      !receipt ||
      receipt.state !== "output_pending" ||
      receipt.outputRequest?.delivery !== "create" ||
      receipt.outputRequest.eventId !== event.eventId ||
      receipt.outputRequest.socketGeneration !== event.socketGeneration
    ) return {
      lifecycle: current,
      commands: [telemetry(current, "invariant.violation", event, {
        toolCallId: event.toolCallId,
        outcome: "blocked_output_duplicate_correlation_invalid",
      })],
    };
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    const commands: OnboardingCommand[] = [];
    resendOutput(
      lifecycle,
      commands,
      event,
      lifecycle.toolOutbox[event.toolCallId]!,
      true,
    );
    return { lifecycle, commands };
  }
  if (event.type === "tool.output_sent") {
    const receipt = current.toolOutbox[event.toolCallId];
    if (!receipt ||
      (receipt.state !== "executed" && receipt.state !== "output_pending"))
      return {
        lifecycle: current,
        commands: [telemetry(current, "invariant.violation", event, {
          toolCallId: event.toolCallId,
          outcome: "blocked_invalid_output_send",
        })],
      };
    const expectedDelivery: OutputDelivery = receipt.state === "output_pending"
      ? "retrieve"
      : "create";
    const expectedEventId = onboardingOutputRequestEventId(
      current,
      receipt,
      expectedDelivery,
    );
    if (
      event.delivery !== expectedDelivery ||
      event.eventId !== expectedEventId
    ) return {
      lifecycle: current,
      commands: [telemetry(current, "invariant.violation", event, {
        toolCallId: event.toolCallId,
        outcome: "blocked_output_request_correlation_invalid",
      })],
    };
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    lifecycle.toolOutbox[event.toolCallId]!.state = "output_pending";
    lifecycle.toolOutbox[event.toolCallId]!.socketGeneration =
      event.socketGeneration;
    lifecycle.toolOutbox[event.toolCallId]!.outputRequest = {
      delivery: event.delivery,
      eventId: event.eventId,
      socketGeneration: event.socketGeneration,
    };
    return {
      lifecycle,
      commands: [telemetry(lifecycle, "voice.tool.output_sent", event, {
        toolCallId: event.toolCallId,
        outcome: "blocked_bookkeeping_only",
      })],
    };
  }
  if (event.type === "tool.output_acked") {
    const receipt = current.toolOutbox[event.toolCallId];
    if (!receipt || receipt.state !== "output_pending" ||
      receipt.outputItemId !== event.outputItemId)
      return {
        lifecycle: current,
        commands: [telemetry(current, "invariant.violation", event, {
          toolCallId: event.toolCallId,
          outcome: "blocked_invalid_output_ack",
        })],
      };
    const lifecycle = cloneLifecycle(current);
    lifecycle.lifecycleRevision += 1;
    lifecycle.toolOutbox[event.toolCallId]!.state = "output_acked";
    return {
      lifecycle,
      commands: [telemetry(lifecycle, "voice.tool.output_acked", event, {
        toolCallId: event.toolCallId,
        outcome: "blocked_bookkeeping_only",
      })],
    };
  }
  return {
    lifecycle: current,
    commands: [telemetry(current, "invariant.violation", event, {
      outcome: "event_ignored_while_blocked",
      ...(event.type === "tool.called" ? { toolCallId: event.toolCallId } : {}),
    })],
  };
}

export function createOnboardingLifecycle(
  callId: string,
  expectedBusinessName: string,
  openingMode: OnboardingOpeningMode = "provider_model_v1",
  initialCoverage?: CoverageLifecycleState,
): OnboardingLifecycle {
  if (!callId.trim()) throw new Error("onboarding_call_id_required");
  if (!expectedBusinessName.trim())
    throw new Error("onboarding_expected_business_name_required");
  if (initialCoverage && (
    initialCoverage.revision !== 1 ||
    !initialCoverage.digest ||
    !/^[0-9a-f]{64}$/.test(initialCoverage.digest) ||
    initialCoverage.complete !== false ||
    !Array.isArray(initialCoverage.missing) ||
    !Array.isArray(initialCoverage.ambiguous) ||
    !initialCoverage.nextQuestion ||
    typeof initialCoverage.nextQuestion.field !== "string" ||
    !initialCoverage.nextQuestion.field.trim() ||
    typeof initialCoverage.nextQuestion.questionPt !== "string" ||
    !initialCoverage.nextQuestion.questionPt.trim() ||
    (initialCoverage.nextQuestion.subject !== undefined &&
      (typeof initialCoverage.nextQuestion.subject !== "string" ||
        !initialCoverage.nextQuestion.subject.trim()))
  )) throw new Error("onboarding_resume_coverage_invalid");
  return {
    callId,
    expectedBusinessName: expectedBusinessName.trim(),
    openingMode,
    phase: "greeting",
    lifecycleRevision: 0,
    socketGeneration: 0,
    coverage: initialCoverage
      ? structuredClone(initialCoverage)
      : {
          revision: 0,
          complete: false,
          missing: [],
          ambiguous: [],
          nextQuestion: {
            field: "service.catalog_closure",
            questionPt: INITIAL_SERVICE_DISCOVERY_QUESTION_PT,
          },
        },
    toolOutbox: {},
    toolBatches: {},
    responseIntents: {},
    terminalResponseIds: [],
    preparedSnapshotDigests: [],
    freshCallerTurnIds: [],
    consumedCallerTurnIds: [],
    requestedHangupKeys: [],
    requestedBudgetHangupKeys: [],
    requestedRecoveryHangupKeys: [],
    requestedTransportHangupKeys: [],
    requestedFatalHangupKeys: [],
    providerTerminationConfirmed: false,
  };
}

export function reduceOnboarding(
  current: OnboardingLifecycle,
  event: OnboardingEvent,
): { lifecycle: OnboardingLifecycle; commands: OnboardingCommand[] } {
  if (event.type === "budget.soft_limit_reached" && current.budgetPause &&
    current.budgetPause.costUsd === event.costUsd &&
    current.budgetPause.softLimitUsd === event.softLimitUsd &&
    current.budgetPause.hardLimitUsd === event.hardLimitUsd)
    return { lifecycle: current, commands: [] };
  if (isRepeatedLateTerminationProof(current, event))
    return { lifecycle: current, commands: [] };

  if (
    event.type === "response.created" &&
    event.intentKey &&
    current.responseIntents[event.intentKey]?.state === "terminal"
  )
    return {
      lifecycle: current,
      commands: [telemetry(current, "invariant.violation", event, {
        responseId: event.responseId,
        intentKey: event.intentKey,
        outcome: "invalidated_response_intent",
      })],
    };

  if (
    event.type === "approval.persistence_failed" &&
    event.code === "changed" &&
    current.snapshotRefresh?.toolCallId === event.toolCallId
  )
    return { lifecycle: current, commands: [] };

  if (event.type === "timer.elapsed")
    return current.phase === "closed"
      ? {
          lifecycle: current,
          commands: [
            telemetry(current, "invariant.violation", event, {
              outcome: "event_after_closed",
            }),
          ],
        }
      : { lifecycle: current, commands: [] };

  if (current.phase === "blocked")
    return reduceBlockedBookkeeping(current, event);

  if (
    event.type === "snapshot.refresh_loaded" &&
    current.snapshotRefresh?.requestId !== event.requestId
  )
    return {
      lifecycle: current,
      commands: [
        telemetry(current, "invariant.violation", event, {
          outcome: "stale_snapshot_refresh_result",
        }),
      ],
    };

  if (current.phase === "closed")
    return {
      lifecycle: current,
      commands: [
        telemetry(current, "invariant.violation", event, {
          outcome: "event_after_closed",
        }),
      ],
    };

  if (!validSocketGeneration(current, event))
    return {
      lifecycle: current,
      commands: [
        telemetry(current, "invariant.violation", event, {
          outcome: "stale_socket_generation",
        }),
      ],
    };

  const lifecycle = cloneLifecycle(current);
  lifecycle.lifecycleRevision += 1;
  const commands: OnboardingCommand[] = [];

  switch (event.type) {
    case "adapter.invariant_failed": {
      if ([
        "tool_output_created_invalid",
        "tool_output_retrieved_invalid",
        "tool_output_retrieve_failed",
        "response_create_active_conflict",
        "response_create_ack_timeout",
        "tool_output_ack_timeout",
        "application_opening_reactivation_indeterminate",
      ].includes(event.code))
        terminateIndeterminateTransport(
          lifecycle,
          commands,
          event,
          event.code,
          event.safeDetail,
          event.code,
          {
            ...(event.intentKey ? { intentKey: event.intentKey } : {}),
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          },
        );
      else
        block(
          lifecycle,
          commands,
          event,
          event.code,
          event.safeDetail,
        );
      break;
    }
    case "socket.attached": {
      const firstAttach =
        lifecycle.socketGeneration === 0 &&
        Object.keys(lifecycle.responseIntents).length === 0;
      if (event.socketGeneration < lifecycle.socketGeneration) {
        commands.push(
          telemetry(lifecycle, "invariant.violation", event, {
            outcome: "stale_socket_attach",
          }),
        );
        break;
      }
      lifecycle.socketGeneration = event.socketGeneration;
      if (reissuePendingTerminationAfterAttach(lifecycle, commands)) break;
      const indeterminateIntent = Object.values(lifecycle.responseIntents)
        .find((intent) =>
          intent.state === "sent" &&
          !intent.responseId &&
          (
            intent.sentSocketGeneration === undefined ||
            intent.sentSocketGeneration < event.socketGeneration
          )
        );
      if (indeterminateIntent) {
        if (indeterminateIntent.purpose === "budget_pause")
          terminateIndeterminateBudgetPause(
            lifecycle,
            commands,
            event,
            "response_intent_ack_indeterminate",
            "sent budget pause has no provider acknowledgement after socket replacement",
            "budget_pause_response_ack_indeterminate",
          );
        else
          terminateIndeterminateTransport(
            lifecycle,
            commands,
            event,
            "response_intent_ack_indeterminate",
            "sent response intent has no provider acknowledgement after socket replacement",
            "response_intent_ack_indeterminate",
            { intentKey: indeterminateIntent.intentKey },
          );
        break;
      }
      const interruptedProof = lifecycle.greeting?.interrupted
        ? lifecycle.greeting
        : lifecycle.summary?.interrupted
          ? lifecycle.summary
          : lifecycle.signoff?.interrupted
            ? lifecycle.signoff
            : lifecycle.budgetPause?.interrupted
              ? lifecycle.budgetPause
              : lifecycle.followupSpeech?.interrupted
                ? lifecycle.followupSpeech
                : lifecycle.recoverySpeech?.interrupted
                  ? lifecycle.recoverySpeech
              : null;
      if (interruptedProof) {
        if (interruptedProof === lifecycle.budgetPause) {
          terminateIndeterminateBudgetPause(
            lifecycle,
            commands,
            event,
            "authority_speech_terminal_indeterminate",
            "budget pause playback is indeterminate after socket replacement",
            "budget_pause_playback_indeterminate",
          );
          break;
        }
        if (
          !interruptedProof.interruptedResponseId ||
          !lifecycle.terminalResponseIds.includes(
            interruptedProof.interruptedResponseId,
          )
        ) {
          terminateIndeterminateTransport(
            lifecycle,
            commands,
            event,
            "authority_speech_terminal_indeterminate",
            "interrupted authority response was not terminal before socket replacement",
            "authority_speech_terminal_indeterminate",
          );
          break;
        }
        maybeQueueInterruptedSpeechRecovery(lifecycle, commands, event);
        if (lifecycle.phase === "blocked") break;
      }
      if (firstAttach)
        commands.push(
          telemetry(lifecycle, "onboarding.coverage.started", event, {
            outcome: `coverage_revision_${lifecycle.coverage.revision}`,
          }),
        );
      if (lifecycle.openingMode === "provider_model_v1")
        for (const receipt of Object.values(lifecycle.toolOutbox))
          if (
            receipt.state === "executed" || receipt.state === "output_pending"
          )
            resendOutput(lifecycle, commands, event, receipt, true);
      if (
        lifecycle.phase === "greeting" &&
        lifecycle.openingMode === "provider_model_v1"
      )
        queueResponse(lifecycle, commands, event, {
          intentKey: `greeting:${lifecycle.callId}`,
          purpose: "greeting",
          instructions: INITIAL_GREETING_RESPONSE_INSTRUCTIONS_PT,
        });
      break;
    }
    case "budget.soft_limit_reached": {
      if (!Number.isFinite(event.costUsd) ||
        event.costUsd < event.softLimitUsd ||
        !Number.isFinite(event.softLimitUsd) || event.softLimitUsd <= 0 ||
        !Number.isFinite(event.hardLimitUsd) ||
        event.hardLimitUsd <= event.softLimitUsd) {
        block(
          lifecycle,
          commands,
          event,
          "budget_pause_envelope_invalid",
          "budget pause did not match a bounded onboarding envelope",
        );
        break;
      }
      if (lifecycle.budgetPause) {
        block(
          lifecycle,
          commands,
          event,
          "budget_pause_identity_mismatch",
          "budget pause threshold changed after it was observed",
        );
        break;
      }
      lifecycle.budgetPause = {
        costUsd: event.costUsd,
        softLimitUsd: event.softLimitUsd,
        hardLimitUsd: event.hardLimitUsd,
        transcript: "",
        transcriptFinal: false,
        audioDone: false,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      terminalizeAuthorityResponseIntents(
        lifecycle,
        (intent) => intent.responseId !== event.responseId,
      );
      lifecycle.phase = "budget_pause_pending";
      commands.push(
        telemetry(lifecycle, "onboarding.budget_pause.requested", event, {
          responseId: event.responseId,
          outcome: "soft_limit_reached",
        }),
      );
      maybeStartBudgetPause(lifecycle, commands, event);
      break;
    }
    case "application.transport_activated": {
      if (lifecycle.openingMode !== "application_tts_v1") {
        block(
          lifecycle,
          commands,
          event,
          "application_opening_session_update_invalid",
          "application transport activation used the provider opening mode",
        );
        break;
      }
      for (const receipt of Object.values(lifecycle.toolOutbox))
        if (
          receipt.state === "executed" || receipt.state === "output_pending"
        )
          resendOutput(lifecycle, commands, event, receipt, true);
      break;
    }
    case "application.greeting_activated": {
      if (
        lifecycle.openingMode !== "application_tts_v1" ||
        lifecycle.phase !== "greeting"
      ) {
        block(
          lifecycle,
          commands,
          event,
          "application_opening_session_update_invalid",
          "application opening activation did not match the greeting phase",
        );
        break;
      }
      lifecycle.phase = "collecting";
      commands.push(
        telemetry(lifecycle, "onboarding.greeting.validated", event, {
          outcome: "application_playback_and_session_update_proven",
        }),
      );
      break;
    }
    case "response.intent_sent": {
      const intent = lifecycle.responseIntents[event.intentKey];
      if (!intent) {
        block(
          lifecycle,
          commands,
          event,
          "unknown_response_intent",
          "response intent was not queued",
        );
        break;
      }
      if (intent.state !== "queued") {
        block(
          lifecycle,
          commands,
          event,
          "response_intent_send_transition_invalid",
          "response intent send did not match a queued command",
        );
        break;
      }
      intent.state = "sent";
      intent.sentSocketGeneration = event.socketGeneration;
      commands.push(
        telemetry(lifecycle, "voice.response.intent_sent", event, {
          intentKey: event.intentKey,
          outcome: intent.purpose,
        }),
      );
      break;
    }
    case "response.created": {
      lifecycle.activeResponseId = event.responseId;
      if (event.intentKey) {
        const intent = lifecycle.responseIntents[event.intentKey];
        if (!intent) {
          block(
            lifecycle,
            commands,
            event,
            "unknown_response_intent",
            "created response does not match a queued intent",
          );
          break;
        }
        if (intent.responseId && intent.responseId !== event.responseId) {
          block(
            lifecycle,
            commands,
            event,
            "response_intent_response_mismatch",
            "response intent was acknowledged by more than one response",
          );
          break;
        }
        intent.state = "acknowledged";
        intent.responseId = event.responseId;
        if (intent.purpose === "greeting" && !lifecycle.greeting)
          lifecycle.greeting = {
            responseId: event.responseId,
            transcript: "",
            transcriptFinal: false,
            audioDone: false,
            responseDone: false,
            playbackStopped: false,
            interrupted: false,
            attempt: 0,
          };
        else if (
          intent.purpose === "greeting" &&
          lifecycle.greeting &&
          !lifecycle.greeting.responseId
        ) lifecycle.greeting.responseId = event.responseId;
        if (intent.purpose === "summary" && lifecycle.summary)
          lifecycle.summary.responseId = event.responseId;
        if (intent.purpose === "final_signoff" && lifecycle.signoff)
          lifecycle.signoff.responseId = event.responseId;
        if (intent.purpose === "budget_pause" && lifecycle.budgetPause)
          lifecycle.budgetPause.responseId = event.responseId;
        if (
          intent.purpose === "tool_continuation" &&
          lifecycle.followupSpeech?.intentKey === event.intentKey
        ) lifecycle.followupSpeech.responseId = event.responseId;
        if (
          intent.purpose === "recovery" &&
          lifecycle.recoverySpeech?.intentKey === event.intentKey
        ) lifecycle.recoverySpeech.responseId = event.responseId;
        commands.push(
          telemetry(lifecycle, "voice.response.acknowledged", event, {
            responseId: event.responseId,
            intentKey: event.intentKey,
            outcome: intent.purpose,
          }),
        );
      }
      break;
    }
    case "response.transcript.delta": {
      if (
        lifecycle.greeting?.responseId === event.responseId &&
        !lifecycle.greeting.transcriptFinal
      ) lifecycle.greeting.transcript += event.delta;
      if (
        lifecycle.summary?.responseId === event.responseId &&
        !lifecycle.summary.transcriptFinal
      )
        lifecycle.summary.transcript += event.delta;
      if (
        lifecycle.signoff?.responseId === event.responseId &&
        !lifecycle.signoff.transcriptFinal
      ) lifecycle.signoff.transcript += event.delta;
      if (
        lifecycle.budgetPause?.responseId === event.responseId &&
        !lifecycle.budgetPause.transcriptFinal
      ) lifecycle.budgetPause.transcript += event.delta;
      if (
        lifecycle.followupSpeech?.responseId === event.responseId &&
        !lifecycle.followupSpeech.transcriptFinal
      ) lifecycle.followupSpeech.transcript += event.delta;
      if (
        lifecycle.recoverySpeech?.responseId === event.responseId &&
        !lifecycle.recoverySpeech.transcriptFinal
      ) lifecycle.recoverySpeech.transcript += event.delta;
      break;
    }
    case "response.transcript.done": {
      if (lifecycle.greeting?.responseId === event.responseId) {
        lifecycle.greeting.transcript = event.transcript;
        lifecycle.greeting.transcriptFinal = true;
        maybeValidateGreeting(lifecycle, commands, event);
      }
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.transcript = event.transcript;
        lifecycle.summary.transcriptFinal = true;
        maybeValidateSummary(lifecycle, commands, event);
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        lifecycle.signoff.transcript = event.transcript;
        lifecycle.signoff.transcriptFinal = true;
        lifecycle.signoff.validated = signoffTranscriptValid(event.transcript);
        maybeFinishSignoff(lifecycle, commands, event);
      }
      if (lifecycle.budgetPause?.responseId === event.responseId) {
        lifecycle.budgetPause.transcript = event.transcript;
        lifecycle.budgetPause.transcriptFinal = true;
        maybeFinishBudgetPause(lifecycle, commands, event);
      }
      if (lifecycle.followupSpeech?.responseId === event.responseId) {
        lifecycle.followupSpeech.transcript = event.transcript;
        lifecycle.followupSpeech.transcriptFinal = true;
        maybeFinishFollowupSpeech(lifecycle, commands, event);
      }
      if (lifecycle.recoverySpeech?.responseId === event.responseId) {
        lifecycle.recoverySpeech.transcript = event.transcript;
        lifecycle.recoverySpeech.transcriptFinal = true;
        maybeFinishRecoverySpeech(lifecycle, commands, event);
      }
      break;
    }
    case "response.output_audio.done": {
      if (lifecycle.greeting?.responseId === event.responseId) {
        lifecycle.greeting.audioDone = true;
        maybeValidateGreeting(lifecycle, commands, event);
      }
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.audioDone = true;
        commands.push(
          telemetry(lifecycle, "onboarding.summary.audio_done", event, {
            responseId: event.responseId,
            intentKey: `summary:${lifecycle.summary.digest}`,
            outcome: "audio_generated",
          }),
        );
        maybeValidateSummary(lifecycle, commands, event);
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        lifecycle.signoff.audioDone = true;
        commands.push(
          telemetry(lifecycle, "onboarding.final_audio.done", event, {
            responseId: event.responseId,
            intentKey: `final-signoff:${lifecycle.signoff.approvalReceiptId}`,
            outcome: "audio_generated",
          }),
        );
        maybeFinishSignoff(lifecycle, commands, event);
      }
      if (lifecycle.budgetPause?.responseId === event.responseId) {
        lifecycle.budgetPause.audioDone = true;
        commands.push(
          telemetry(lifecycle, "onboarding.budget_pause.audio_done", event, {
            responseId: event.responseId,
            intentKey: `budget-pause:${lifecycle.callId}`,
            outcome: "audio_generated",
          }),
        );
        maybeFinishBudgetPause(lifecycle, commands, event);
      }
      if (lifecycle.followupSpeech?.responseId === event.responseId) {
        lifecycle.followupSpeech.audioDone = true;
        maybeFinishFollowupSpeech(lifecycle, commands, event);
      }
      if (lifecycle.recoverySpeech?.responseId === event.responseId) {
        lifecycle.recoverySpeech.audioDone = true;
        maybeFinishRecoverySpeech(lifecycle, commands, event);
      }
      break;
    }
    case "response.done": {
      const authorityResponseDone = [
        lifecycle.greeting?.responseId,
        lifecycle.summary?.responseId,
        lifecycle.signoff?.responseId,
        lifecycle.budgetPause?.responseId,
        lifecycle.followupSpeech?.responseId,
        lifecycle.recoverySpeech?.responseId,
      ].includes(event.responseId);
      if (!recordTerminalResponseId(
        lifecycle,
        event.responseId,
        commands,
        event,
      )) break;
      if (lifecycle.activeResponseId === event.responseId)
        delete lifecycle.activeResponseId;
      for (const intent of Object.values(lifecycle.responseIntents))
        if (intent.responseId === event.responseId) intent.state = "terminal";
      if (lifecycle.greeting?.responseId === event.responseId) {
        lifecycle.greeting.responseDone = true;
        maybeValidateGreeting(lifecycle, commands, event);
      }
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.responseDone = true;
        maybeValidateSummary(lifecycle, commands, event);
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        lifecycle.signoff.responseDone = true;
        maybeFinishSignoff(lifecycle, commands, event);
      }
      if (lifecycle.budgetPause?.responseId === event.responseId) {
        lifecycle.budgetPause.responseDone = true;
        maybeFinishBudgetPause(lifecycle, commands, event);
      }
      if (lifecycle.followupSpeech?.responseId === event.responseId) {
        lifecycle.followupSpeech.responseDone = true;
        maybeFinishFollowupSpeech(lifecycle, commands, event);
      }
      if (lifecycle.recoverySpeech?.responseId === event.responseId) {
        lifecycle.recoverySpeech.responseDone = true;
        maybeFinishRecoverySpeech(lifecycle, commands, event);
      } else if (
        !lifecycle.followupSpeech && !lifecycle.recoverySpeech &&
        lifecycle.phase === "follow_up"
      ) lifecycle.phase = "collecting";
      commands.push(
        telemetry(lifecycle, "voice.response.terminal", event, {
          responseId: event.responseId,
          outcome: "response_done",
        }),
      );
      maybeQueueInterruptedSpeechRecovery(lifecycle, commands, event);
      if (!authorityResponseDone)
        maybeAdvanceCoverage(lifecycle, commands, event);
      break;
    }
    case "output_audio_buffer.stopped": {
      if (lifecycle.greeting?.responseId === event.responseId) {
        lifecycle.greeting.playbackStopped = true;
        maybeValidateGreeting(lifecycle, commands, event);
      }
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.playbackStopped = true;
        commands.push(
          telemetry(lifecycle, "onboarding.summary.playback_done", event, {
            responseId: event.responseId,
            intentKey: `summary:${lifecycle.summary.digest}`,
            outcome: "playback_stopped",
          }),
        );
        maybeValidateSummary(lifecycle, commands, event);
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        lifecycle.signoff.playbackStopped = true;
        commands.push(
          telemetry(lifecycle, "onboarding.final_audio.playback_done", event, {
            responseId: event.responseId,
            intentKey: `final-signoff:${lifecycle.signoff.approvalReceiptId}`,
            outcome: "playback_stopped",
          }),
        );
        maybeFinishSignoff(lifecycle, commands, event);
      }
      if (lifecycle.budgetPause?.responseId === event.responseId) {
        lifecycle.budgetPause.playbackStopped = true;
        commands.push(
          telemetry(lifecycle, "onboarding.budget_pause.playback_done", event, {
            responseId: event.responseId,
            intentKey: `budget-pause:${lifecycle.callId}`,
            outcome: "playback_stopped",
          }),
        );
        maybeFinishBudgetPause(lifecycle, commands, event);
      }
      if (lifecycle.followupSpeech?.responseId === event.responseId) {
        lifecycle.followupSpeech.playbackStopped = true;
        maybeFinishFollowupSpeech(lifecycle, commands, event);
      }
      if (lifecycle.recoverySpeech?.responseId === event.responseId) {
        lifecycle.recoverySpeech.playbackStopped = true;
        maybeFinishRecoverySpeech(lifecycle, commands, event);
      }
      break;
    }
    case "response.audio_interrupted": {
      if (lifecycle.greeting?.responseId === event.responseId) {
        if (lifecycle.greeting.validated === true) {
          block(
            lifecycle,
            commands,
            event,
            "greeting_proof_retracted",
            "provider interrupted an already validated greeting response",
          );
          break;
        }
        if ((lifecycle.greeting.attempt ?? 0) >= 1) {
          block(
            lifecycle,
            commands,
            event,
            "authority_speech_retry_exhausted",
            "greeting exhausted its single speech retry",
          );
          break;
        }
        lifecycle.greeting.audioDone = false;
        lifecycle.greeting.playbackStopped = false;
        lifecycle.greeting.interrupted = true;
        lifecycle.greeting.interruptedResponseId = event.responseId;
        delete lifecycle.greeting.validated;
        lifecycle.phase = "greeting";
      }
      if (lifecycle.summary?.responseId === event.responseId) {
        if ((lifecycle.summary.attempt ?? 0) >= 1) {
          block(
            lifecycle,
            commands,
            event,
            "authority_speech_retry_exhausted",
            "summary exhausted its single speech retry",
          );
          break;
        }
        lifecycle.summary.audioDone = false;
        lifecycle.summary.playbackStopped = false;
        lifecycle.summary.interrupted = true;
        lifecycle.summary.interruptedResponseId = event.responseId;
        delete lifecycle.summary.validated;
        delete lifecycle.approvalCandidate;
        lifecycle.freshCallerTurnIds = [];
        lifecycle.phase = "summary_speaking";
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        if ((lifecycle.signoff.attempt ?? 0) >= 1) {
          block(
            lifecycle,
            commands,
            event,
            "authority_speech_retry_exhausted",
            "final signoff exhausted its single speech retry",
          );
          break;
        }
        lifecycle.signoff.audioDone = false;
        lifecycle.signoff.playbackStopped = false;
        lifecycle.signoff.interrupted = true;
        lifecycle.signoff.interruptedResponseId = event.responseId;
        delete lifecycle.signoff.validated;
        lifecycle.phase = "final_signoff_speaking";
      }
      if (lifecycle.budgetPause?.responseId === event.responseId) {
        if ((lifecycle.budgetPause.attempt ?? 0) >= 1) {
          block(
            lifecycle,
            commands,
            event,
            "authority_speech_retry_exhausted",
            "budget pause exhausted its single speech retry",
          );
          break;
        }
        lifecycle.budgetPause.audioDone = false;
        lifecycle.budgetPause.playbackStopped = false;
        lifecycle.budgetPause.interrupted = true;
        lifecycle.budgetPause.interruptedResponseId = event.responseId;
        delete lifecycle.budgetPause.validated;
        lifecycle.phase = "budget_pause_speaking";
      }
      if (lifecycle.followupSpeech?.responseId === event.responseId) {
        if (lifecycle.followupSpeech.attempt >= 1) {
          const recoveryKey =
            `${lifecycle.followupSpeech.intentKey}:interrupted`;
          delete lifecycle.followupSpeech;
          queueTruthfulRecovery(
            lifecycle,
            commands,
            event,
            "next_question_unavailable",
            recoveryKey,
            { outcome: "followup_speech_retry_exhausted" },
            FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
          );
          break;
        }
        lifecycle.followupSpeech.audioDone = false;
        lifecycle.followupSpeech.playbackStopped = false;
        lifecycle.followupSpeech.interrupted = true;
        lifecycle.followupSpeech.interruptedResponseId = event.responseId;
        delete lifecycle.followupSpeech.validated;
        lifecycle.phase = "follow_up";
      }
      if (lifecycle.recoverySpeech?.responseId === event.responseId) {
        if (lifecycle.recoverySpeech.attempt >= 1) {
          terminateFailedRecoveryDelivery(
            lifecycle,
            commands,
            event,
            "truthful recovery exhausted its single speech retry",
          );
          break;
        }
        lifecycle.recoverySpeech.audioDone = false;
        lifecycle.recoverySpeech.playbackStopped = false;
        lifecycle.recoverySpeech.interrupted = true;
        lifecycle.recoverySpeech.interruptedResponseId = event.responseId;
        delete lifecycle.recoverySpeech.validated;
        lifecycle.phase = "follow_up";
      }
      maybeQueueInterruptedSpeechRecovery(lifecycle, commands, event);
      break;
    }
    case "coverage.changed": {
      if (
        !Number.isSafeInteger(event.revision) ||
        event.revision <= lifecycle.coverage.revision ||
        !event.digest
      ) {
        block(
          lifecycle,
          commands,
          event,
          "coverage_revision_invalid",
          "coverage revision did not advance",
        );
        break;
      }
      if (lifecycle.summary)
        lifecycle.invalidatedSummaryRevision = lifecycle.summary.revision;
      const invalidatedFollowupIntentKey =
        lifecycle.followupSpeech?.intentKey;
      // A new owner answer supersedes an unsent next-question recovery, not an
      // unrelated persistence/correlation failure that still needs delivery.
      // Sent speech (including response.done awaiting playback) still owns its
      // bounded delivery proof and must fence new authority until it resolves.
      const invalidatedRecoveryIntentKey = lifecycle.recoverySpeech &&
          lifecycle.recoverySpeech.intentKey.startsWith("recovery:next_question_unavailable:") &&
          lifecycle.responseIntents[lifecycle.recoverySpeech.intentKey]?.state === "queued"
        ? lifecycle.recoverySpeech.intentKey
        : undefined;
      if (invalidatedRecoveryIntentKey) delete lifecycle.recoverySpeech;
      delete lifecycle.pendingFollowup;
      delete lifecycle.followupSpeech;
      terminalizeAuthorityResponseIntents(
        lifecycle,
        (intent) =>
          intent.purpose === "final_signoff" ||
          intent.intentKey === invalidatedFollowupIntentKey ||
          intent.intentKey === invalidatedRecoveryIntentKey ||
          (
            intent.purpose === "summary" &&
            intent.intentKey !== `summary:${event.digest}`
          ),
      );
      if (
        lifecycle.snapshotRefresh &&
        event.revision > lifecycle.snapshotRefresh.rejectedRevision
      )
        delete lifecycle.snapshotRefresh;
      delete lifecycle.summary;
      delete lifecycle.approval;
      delete lifecycle.signoff;
      delete lifecycle.approvalCandidate;
      lifecycle.freshCallerTurnIds = [];
      lifecycle.coverage = {
        revision: event.revision,
        digest: event.digest,
        complete:
          event.complete &&
          event.missing.length === 0 &&
          event.ambiguous.length === 0,
        missing: structuredClone(event.missing),
        ambiguous: structuredClone(event.ambiguous),
        ...(event.nextQuestion
          ? { nextQuestion: structuredClone(event.nextQuestion) }
          : {}),
      };
      lifecycle.phase = lifecycle.recoverySpeech
        ? "follow_up"
        : lifecycle.coverage.complete ? "coverage_check" : "collecting";
      commands.push(
        telemetry(lifecycle, "onboarding.coverage.changed", event, {
          outcome: lifecycle.coverage.complete ? "complete" : "incomplete",
        }),
      );
      for (const ref of event.answered ?? [])
        commands.push(
          telemetry(lifecycle, "onboarding.field.answered", event, {
            outcome: ref.subject ? `${ref.field}:${ref.subject}` : ref.field,
          }),
        );
      for (const ref of event.missing)
        commands.push(
          telemetry(lifecycle, "onboarding.field.missing", event, {
            outcome: ref.subject ? `${ref.field}:${ref.subject}` : ref.field,
          }),
        );
      for (const ref of event.ambiguous)
        commands.push(
          telemetry(lifecycle, "onboarding.field.ambiguous", event, {
            outcome: ref.subject ? `${ref.field}:${ref.subject}` : ref.field,
          }),
        );
      maybeAdvanceCoverage(lifecycle, commands, event);
      break;
    }
    case "followup.persisted": {
      const pending = lifecycle.pendingFollowup;
      if (
        !pending ||
        pending.sourceRevision !== event.sourceRevision ||
        pending.sourceRevision !== lifecycle.coverage.revision ||
        pending.field !== event.field ||
        (pending.subject ?? "") !== (event.subject ?? "") ||
        pending.questionPt !== event.questionPt ||
        pending.intentKey !== event.intentKey ||
        !Number.isSafeInteger(event.revision) ||
        event.revision !== event.sourceRevision + 1 ||
        !event.digest
      ) {
        block(
          lifecycle,
          commands,
          event,
          "followup_receipt_mismatch",
          "directed follow-up receipt did not match the selected question",
        );
        break;
      }
      lifecycle.coverage.revision = event.revision;
      lifecycle.coverage.digest = event.digest;
      delete lifecycle.pendingFollowup;
      lifecycle.phase = "follow_up";
      lifecycle.followupSpeech = {
        intentKey: event.intentKey,
        questionPt: event.questionPt,
        transcript: "",
        transcriptFinal: false,
        audioDone: false,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      commands.push({
        type: "ask_follow_up",
        field: event.field,
        ...(event.subject ? { subject: event.subject } : {}),
        questionPt: event.questionPt,
        intentKey: event.intentKey,
      });
      if (
        queueResponse(lifecycle, commands, event, {
          intentKey: event.intentKey,
          purpose: "tool_continuation",
          instructions: event.questionPt,
        })
      ) {
        const batch = Object.values(lifecycle.toolBatches).find(
          (candidate) =>
            `tool-batch:${candidate.providerResponseId}:${candidate.batchHash}` ===
              event.intentKey,
        );
        if (batch) batch.continuationRequested = true;
      }
      break;
    }
    case "followup.persistence_failed": {
      const pending = lifecycle.pendingFollowup;
      if (
        !pending ||
        pending.sourceRevision !== event.sourceRevision ||
        pending.field !== event.field ||
        (pending.subject ?? "") !== (event.subject ?? "")
      ) {
        commands.push(
          telemetry(lifecycle, "invariant.violation", event, {
            outcome: "stale_followup_failure",
          }),
        );
        break;
      }
      delete lifecycle.pendingFollowup;
      const parentBatch = Object.values(lifecycle.toolBatches).find(
        (candidate) =>
          `tool-batch:${candidate.providerResponseId}:${candidate.batchHash}` ===
            pending.intentKey,
      );
      if (parentBatch) parentBatch.continuationRequested = true;
      queueTruthfulRecovery(
        lifecycle,
        commands,
        event,
        "next_question_unavailable",
        `${event.sourceRevision}:${event.field}:${event.subject ?? ""}`,
        { outcome: event.code },
        FOLLOWUP_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
      );
      break;
    }
    case "snapshot.loaded": {
      if (lifecycle.snapshotRefresh) {
        commands.push(
          telemetry(lifecycle, "invariant.violation", event, {
            outcome: "uncorrelated_snapshot_during_refresh",
          }),
        );
        break;
      }
      if (!event.result.ok) {
        lifecycle.phase = "blocked";
        commands.push({
          type: "block",
          code: event.result.code,
          safeDetail: event.result.safeDetail,
          recoverable: true,
        });
        commands.push(
          telemetry(lifecycle, "onboarding.snapshot.blocked", {
            elapsedMs: event.result.durationMs,
          }, {
            errorCode: event.result.code,
            outcome: "snapshot_unavailable",
          }),
        );
        break;
      }
      if (
        lifecycle.summary &&
        lifecycle.summary.digest === event.result.digest &&
        lifecycle.summary.revision === event.result.revision
      )
        break;
      const evaluated = evaluateCoverage(event.result.coverage);
      if (
        lifecycle.phase !== "snapshot_preparing" ||
        !lifecycle.coverage.complete ||
        event.result.revision !== lifecycle.coverage.revision ||
        event.result.digest !== lifecycle.coverage.digest ||
        !event.result.receiptId ||
        event.result.rules.length === 0 ||
        event.result.requiredAnchors.length === 0 ||
        !evaluated.readyForReview
      ) {
        block(
          lifecycle,
          commands,
          event,
          "snapshot_invariant_failed",
          "snapshot did not match complete current coverage",
        );
        break;
      }
      lifecycle.phase = "summary_speaking";
      lifecycle.summary = {
        receiptId: event.result.receiptId,
        revision: event.result.revision,
        digest: event.result.digest,
        requiredAnchors: [...event.result.requiredAnchors],
        transcript: "",
        transcriptFinal: false,
        audioDone: false,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      lifecycle.freshCallerTurnIds = [];
      commands.push(
        telemetry(lifecycle, "onboarding.snapshot.ready", {
          elapsedMs: event.result.durationMs,
        }, { outcome: "snapshot_ready" }),
      );
      queueResponse(lifecycle, commands, event, {
        intentKey: `summary:${event.result.digest}`,
        purpose: "summary",
        snapshotDigest: event.result.digest,
        instructions: summaryResponseInstructions(lifecycle.summary),
      });
      break;
    }
    case "snapshot.refresh_loaded": {
      const refresh = lifecycle.snapshotRefresh!;
      if (!event.result.ok) {
        delete lifecycle.snapshotRefresh;
        lifecycle.phase = "blocked";
        commands.push({
          type: "block",
          code: event.result.code,
          safeDetail: event.result.safeDetail,
          recoverable: true,
        });
        commands.push(
          telemetry(lifecycle, "onboarding.snapshot.blocked", {
            elapsedMs: event.result.durationMs,
          }, {
            errorCode: event.result.code,
            outcome: "approval_refresh_unavailable",
          }),
        );
        break;
      }
      const evaluated = evaluateCoverage(event.result.coverage);
      if (
        event.result.revision <= refresh.rejectedRevision ||
        event.result.revision <= lifecycle.coverage.revision ||
        event.result.digest === refresh.rejectedDigest ||
        !event.result.receiptId ||
        event.result.rules.length === 0 ||
        event.result.requiredAnchors.length === 0 ||
        !evaluated.readyForReview
      ) {
        delete lifecycle.snapshotRefresh;
        block(
          lifecycle,
          commands,
          event,
          "snapshot_refresh_not_newer",
          "refreshed snapshot was not a newer complete authoritative revision",
        );
        break;
      }
      lifecycle.coverage = {
        revision: event.result.revision,
        digest: event.result.digest,
        complete: true,
        missing: structuredClone(evaluated.missingRequired),
        ambiguous: structuredClone(evaluated.ambiguous),
        ...(evaluated.nextQuestion
          ? { nextQuestion: structuredClone(evaluated.nextQuestion) }
          : {}),
      };
      delete lifecycle.snapshotRefresh;
      lifecycle.phase = "coverage_check";
      commands.push(
        telemetry(lifecycle, "onboarding.coverage.changed", {
          elapsedMs: event.result.durationMs,
        }, { outcome: "approval_refresh_authoritative" }),
      );
      maybeAdvanceCoverage(lifecycle, commands, event);
      break;
    }
    case "caller.speech_started": {
      if (
        lifecycle.phase === "awaiting_owner_approval" &&
        lifecycle.summary?.validated === true &&
        lifecycle.summary.playbackStopped &&
        !lifecycle.consumedCallerTurnIds.includes(event.turnId) &&
        !lifecycle.freshCallerTurnIds.includes(event.turnId)
      )
        lifecycle.freshCallerTurnIds.push(event.turnId);
      break;
    }
    case "caller.turn_retired": {
      lifecycle.freshCallerTurnIds = lifecycle.freshCallerTurnIds.filter(
        (turnId) => turnId !== event.turnId,
      );
      break;
    }
    case "recovery.required": {
      if (event.retiredTurnIds?.length) {
        const retired = new Set(event.retiredTurnIds);
        lifecycle.freshCallerTurnIds = lifecycle.freshCallerTurnIds.filter(
          (turnId) => !retired.has(turnId),
        );
      }
      if (
        (
          event.reason === "caller_turn_correlation_mismatch" ||
          event.reason === "owner_turn_completed_without_tool"
        ) &&
        lifecycle.phase === "greeting"
      ) {
        commands.push(
          telemetry(lifecycle, "invariant.violation", event, {
            outcome: event.reason,
            ...(event.responseId ? { responseId: event.responseId } : {}),
          }),
        );
        break;
      }
      const hasResponseOwed = Object.values(lifecycle.responseIntents).some(
        (intent) => intent.state !== "terminal",
      );
      const hasToolOwed = Object.values(lifecycle.toolOutbox).some(
        (receipt) =>
          receipt.state === "running" ||
          receipt.state === "executed" ||
          receipt.state === "output_pending",
      );
      const wouldBeIdle =
        lifecycle.phase === "collecting" &&
        !lifecycle.activeResponseId &&
        !hasResponseOwed &&
        !hasToolOwed &&
        !lifecycle.pendingFollowup;
      if (
        event.reason === "owner_turn_completed_without_tool" &&
        !wouldBeIdle
      ) break;
      if (
        lifecycle.phase !== "collecting" && lifecycle.phase !== "follow_up"
      ) {
        block(
          lifecycle,
          commands,
          event,
          event.reason,
          "caller turn recovery was not admissible in the current lifecycle",
        );
        break;
      }
      queueTruthfulRecovery(
        lifecycle,
        commands,
        event,
        event.reason,
        event.recoveryKey,
        event.responseId ? { responseId: event.responseId } : {},
      );
      break;
    }
    case "caller.transcript.completed": {
      if (
        lifecycle.phase !== "awaiting_owner_approval" ||
        !lifecycle.freshCallerTurnIds.includes(event.turnId)
      ) {
        commands.push(
          telemetry(lifecycle, "onboarding.approval.rejected", event, {
            outcome: "not_fresh_after_summary_playback",
          }),
        );
        break;
      }
      lifecycle.freshCallerTurnIds = lifecycle.freshCallerTurnIds.filter(
        (turnId) => turnId !== event.turnId,
      );
      lifecycle.consumedCallerTurnIds.push(event.turnId);
      if (lifecycle.consumedCallerTurnIds.length > 500)
        lifecycle.consumedCallerTurnIds.shift();
      const pendingApprovals = Object.values(lifecycle.toolOutbox).filter(
        (receipt) =>
          receipt.toolName === "approve_onboarding_summary" &&
          receipt.state === "running" &&
          receipt.approvalTurnId === event.turnId,
      );
      if (pendingApprovals.length > 1) {
        block(
          lifecycle,
          commands,
          event,
          "approval_turn_duplicate",
          "caller turn was correlated to more than one approval tool",
        );
        break;
      }
      const pendingApproval = pendingApprovals[0];
      const kind = ownerReplyKind(event.transcript);
      if (kind === "correction") {
        lifecycle.invalidatedSummaryRevision = lifecycle.summary?.revision;
        delete lifecycle.summary;
        delete lifecycle.approvalCandidate;
        lifecycle.freshCallerTurnIds = [];
        lifecycle.coverage.complete = false;
        lifecycle.phase = "collecting";
        commands.push(
          telemetry(lifecycle, "onboarding.approval.rejected", event, {
            outcome: "owner_correction",
          }),
        );
        if (pendingApproval)
          rejectApprovalReceipt(
            lifecycle,
            commands,
            event,
            pendingApproval,
            "owner_correction",
          );
      } else if (kind === "approval") {
        lifecycle.approvalCandidate = {
          turnId: event.turnId,
          ownerWords: event.transcript.trim(),
        };
        commands.push(
          telemetry(lifecycle, "onboarding.approval.captured", event, {
            outcome: "explicit_assent",
          }),
        );
        if (
          pendingApproval &&
          !persistApprovalFromTranscript(
            lifecycle,
            commands,
            pendingApproval,
            event.transcript,
          )
        ) {
          block(
            lifecycle,
            commands,
            event,
            "approval_transcript_authority_invalid",
            "approval transcript no longer matched the proven summary",
            pendingApproval.toolCallId,
          );
        }
      } else {
        commands.push(
          telemetry(lifecycle, "onboarding.approval.rejected", event, {
            outcome: "ambiguous_owner_turn",
          }),
        );
        if (pendingApproval)
          rejectApprovalReceipt(
            lifecycle,
            commands,
            event,
            pendingApproval,
            "ambiguous_owner_turn",
          );
      }
      break;
    }
    case "tool.called": {
      if (
        lifecycle.phase === "greeting" &&
        event.name === "record_interview_answer"
      ) {
        block(
          lifecycle,
          commands,
          event,
          "greeting_proof_required",
          "onboarding facts cannot be admitted before the spoken greeting proof",
          event.toolCallId,
        );
        break;
      }
      const argsHash = hashOnboardingToolArgs(event.args);
      const existing = lifecycle.toolOutbox[event.toolCallId];
      if (existing) {
        if (
          existing.argsHash !== argsHash ||
          existing.toolName !== event.name ||
          existing.providerResponseId !== event.providerResponseId ||
          existing.batchHash !== event.batchHash ||
          (
            existing.toolName === "approve_onboarding_summary" &&
            existing.approvalTurnId !== event.callerTurnId
          )
        ) {
          block(
            lifecycle,
            commands,
            event,
            "tool_args_mismatch",
            "provider tool replay changed its payload",
            event.toolCallId,
          );
          break;
        }
        if (
          existing.state === "executed" ||
          existing.state === "output_pending"
        )
          resendOutput(lifecycle, commands, event, existing, true);
        break;
      }
      if (Object.keys(lifecycle.toolOutbox).length >= MAX_TOOL_OUTBOX_RECEIPTS) {
        block(
          lifecycle,
          commands,
          event,
          "tool_outbox_capacity_exceeded",
          "tool replay registry reached its deterministic bound",
          event.toolCallId,
        );
        break;
      }
      let approvalTurnId: string | undefined;
      if (event.name === "approve_onboarding_summary") {
        approvalTurnId = event.callerTurnId;
        const correlated = Boolean(
          approvalTurnId &&
          (
            lifecycle.freshCallerTurnIds.includes(approvalTurnId) ||
            lifecycle.approvalCandidate?.turnId === approvalTurnId
          ),
        );
        if (
          !correlated ||
          lifecycle.phase !== "awaiting_owner_approval" ||
          !lifecycle.summary?.validated ||
          !lifecycle.summary.playbackStopped
        ) {
          block(
            lifecycle,
            commands,
            event,
            "approval_turn_uncorrelated",
            "approval tool did not match one fresh caller turn after summary playback",
            event.toolCallId,
          );
          break;
        }
        if (Object.values(lifecycle.toolOutbox).some((candidate) =>
          candidate.toolName === "approve_onboarding_summary" &&
          candidate.approvalTurnId === approvalTurnId
        )) {
          block(
            lifecycle,
            commands,
            event,
            "approval_turn_duplicate",
            "caller turn produced more than one approval tool",
            event.toolCallId,
          );
          break;
        }
      }
      const receipt: ToolReceipt = {
        toolCallId: event.toolCallId,
        toolName: event.name,
        argsHash,
        state: "running",
        providerResponseId: event.providerResponseId,
        batchHash: event.batchHash,
        outputItemId: outputItemId(event.toolCallId),
        socketGeneration: event.socketGeneration,
        ...(approvalTurnId ? { approvalTurnId } : {}),
      };
      lifecycle.toolOutbox[event.toolCallId] = receipt;
      commands.push(
        telemetry(lifecycle, "voice.tool.admitted", event, {
          toolCallId: event.toolCallId,
          outcome: event.name,
        }),
      );
      if (event.name === "end_session") {
        const output = JSON.stringify({
          status: "application_owned_close",
          ending: false,
        });
        receipt.state = "executed";
        receipt.output = output;
        receipt.resultHash = hashOnboardingToolArgs({ output });
        commands.push({
          type: "refuse_end_session",
          toolCallId: event.toolCallId,
          output,
          outputItemId: receipt.outputItemId,
        });
        resendOutput(lifecycle, commands, event, receipt, false);
        break;
      }
      if (event.name === "approve_onboarding_summary") {
        const ownerWords =
          typeof event.args.owner_words === "string"
            ? event.args.owner_words.trim()
            : "";
        if (ownerReplyKind(ownerWords) !== "approval") {
          rejectApprovalReceipt(
            lifecycle,
            commands,
            event,
            receipt,
            "approval_tool_not_assent",
          );
          break;
        }
        if (
          lifecycle.approvalCandidate?.turnId === approvalTurnId &&
          !persistApprovalFromTranscript(
            lifecycle,
            commands,
            receipt,
            lifecycle.approvalCandidate.ownerWords,
          )
        )
          block(
            lifecycle,
            commands,
            event,
            "approval_transcript_authority_invalid",
            "approval transcript no longer matched the proven summary",
            event.toolCallId,
          );
        break;
      }
      if (event.name === "record_interview_answer") {
        commands.push({
          type: "persist_fact",
          toolCallId: event.toolCallId,
          argsHash,
          args: event.args as OnboardingAnswerArgs,
          providerResponseId: event.providerResponseId,
          batchHash: event.batchHash,
        });
        break;
      }
      commands.push({
        type: "execute_tool",
        toolCallId: event.toolCallId,
        name: event.name,
        argsHash,
        args: structuredClone(event.args),
        providerResponseId: event.providerResponseId,
        batchHash: event.batchHash,
      });
      break;
    }
    case "tool.rejected": {
      const existing = lifecycle.toolOutbox[event.toolCallId];
      if (existing) {
        if (
          existing.argsHash !== event.argsHash ||
          existing.toolName !== event.name ||
          existing.providerResponseId !== event.providerResponseId ||
          existing.batchHash !== event.batchHash
        ) {
          block(
            lifecycle,
            commands,
            event,
            "tool_args_mismatch",
            "rejected provider tool replay changed its identity",
            event.toolCallId,
          );
          break;
        }
        if (existing.state === "executed" || existing.state === "output_pending")
          resendOutput(lifecycle, commands, event, existing, true);
        break;
      }
      if (Object.keys(lifecycle.toolOutbox).length >= MAX_TOOL_OUTBOX_RECEIPTS) {
        block(
          lifecycle,
          commands,
          event,
          "tool_outbox_capacity_exceeded",
          "tool replay registry reached its deterministic bound",
          event.toolCallId,
        );
        break;
      }
      const output = JSON.stringify({
        status: "error",
        error: "persistence_failed",
        retry_safe: true,
      });
      const receipt: ToolReceipt = {
        toolCallId: event.toolCallId,
        toolName: event.name,
        argsHash: event.argsHash,
        state: "executed",
        providerResponseId: event.providerResponseId,
        batchHash: event.batchHash,
        output,
        resultHash: hashOnboardingToolArgs({ output }),
        outputItemId: outputItemId(event.toolCallId),
        socketGeneration: event.socketGeneration,
        failureKind: "deterministic",
      };
      lifecycle.toolOutbox[event.toolCallId] = receipt;
      commands.push(
        telemetry(lifecycle, "voice.tool.admitted", event, {
          toolCallId: event.toolCallId,
          outcome: event.name,
        }),
        telemetry(lifecycle, "invariant.violation", event, {
          toolCallId: event.toolCallId,
          outcome: event.code,
        }),
      );
      resendOutput(lifecycle, commands, event, receipt, false);
      break;
    }
    case "tool.executed": {
      const receipt = lifecycle.toolOutbox[event.toolCallId];
      if (!receipt || receipt.state !== "running") {
        block(
          lifecycle,
          commands,
          event,
          "tool_execution_transition_invalid",
          "tool result did not match a running execution",
          event.toolCallId,
        );
        break;
      }
      receipt.state = "executed";
      receipt.output = event.output;
      receipt.resultHash = event.resultHash;
      commands.push(
        telemetry(lifecycle, "voice.tool.executed", event, {
          toolCallId: event.toolCallId,
          outcome: "persisted_before_delivery",
        }),
      );
      resendOutput(lifecycle, commands, event, receipt, false);
      break;
    }
    case "tool.execution_failed": {
      const receipt = lifecycle.toolOutbox[event.toolCallId];
      if (!receipt || receipt.state !== "running") {
        block(
          lifecycle,
          commands,
          event,
          "tool_execution_transition_invalid",
          "tool failure did not match a running execution",
          event.toolCallId,
        );
        break;
      }
      const indeterminate = event.code === "indeterminate";
      const output = JSON.stringify(indeterminate
        ? {
            status: "unknown",
            error: "persistence_indeterminate",
            retry_safe: false,
          }
        : {
            status: "error",
            error: "persistence_failed",
            retry_safe: true,
          });
      receipt.state = "executed";
      receipt.failureKind = indeterminate ? "indeterminate" : "deterministic";
      receipt.output = output;
      receipt.resultHash = hashOnboardingToolArgs({ output });
      delete receipt.outputRequest;
      commands.push(
        telemetry(lifecycle, "invariant.violation", event, {
          toolCallId: event.toolCallId,
          outcome: event.code,
        }),
      );
      resendOutput(lifecycle, commands, event, receipt, false);
      break;
    }
    case "tool.output_sent": {
      const receipt = lifecycle.toolOutbox[event.toolCallId];
      if (
        !receipt ||
        (receipt.state !== "executed" && receipt.state !== "output_pending")
      ) {
        block(
          lifecycle,
          commands,
          event,
          "tool_output_transition_invalid",
          "tool output send did not match an executed result",
          event.toolCallId,
        );
        break;
      }
      const expectedDelivery: OutputDelivery =
        receipt.state === "output_pending" ? "retrieve" : "create";
      const expectedEventId = onboardingOutputRequestEventId(
        lifecycle,
        receipt,
        expectedDelivery,
      );
      if (
        event.delivery !== expectedDelivery ||
        event.eventId !== expectedEventId
      ) {
        block(
          lifecycle,
          commands,
          event,
          "tool_output_request_invalid",
          "tool output request did not match its deterministic delivery correlation",
          event.toolCallId,
        );
        break;
      }
      receipt.state = "output_pending";
      receipt.socketGeneration = event.socketGeneration;
      receipt.outputRequest = {
        delivery: event.delivery,
        eventId: event.eventId,
        socketGeneration: event.socketGeneration,
      };
      commands.push(
        telemetry(lifecycle, "voice.tool.output_sent", event, {
          toolCallId: event.toolCallId,
          outcome: "awaiting_acknowledgement",
        }),
      );
      break;
    }
    case "tool.output_create_duplicate": {
      const receipt = lifecycle.toolOutbox[event.toolCallId];
      if (
        !receipt ||
        receipt.state !== "output_pending" ||
        receipt.outputRequest?.delivery !== "create" ||
        receipt.outputRequest.eventId !== event.eventId ||
        receipt.outputRequest.socketGeneration !== event.socketGeneration
      ) {
        block(
          lifecycle,
          commands,
          event,
          "tool_output_duplicate_invalid",
          "duplicate output error did not match the active create request",
          event.toolCallId,
        );
        break;
      }
      resendOutput(lifecycle, commands, event, receipt, true);
      break;
    }
    case "tool.output_acked": {
      const receipt = lifecycle.toolOutbox[event.toolCallId];
      if (
        !receipt ||
        receipt.outputItemId !== event.outputItemId ||
        receipt.state !== "output_pending"
      ) {
        if (receipt?.state === "output_acked") break;
        block(
          lifecycle,
          commands,
          event,
          "tool_output_ack_invalid",
          "tool output acknowledgement did not match pending output",
          event.toolCallId,
        );
        break;
      }
      receipt.state = "output_acked";
      commands.push(
        telemetry(lifecycle, "voice.tool.output_acked", event, {
          toolCallId: event.toolCallId,
          outcome: "acknowledged",
        }),
      );
      const parentBatch = lifecycle.toolBatches[
        batchKey(receipt.providerResponseId, receipt.batchHash)
      ];
      if (receipt.failureKind && !parentBatch) {
          block(
            lifecycle,
            commands,
            event,
            "tool_failure_batch_missing",
            "failed tool output acknowledgement had no closed parent batch",
            event.toolCallId,
          );
          break;
      }
      const failedReceipts = (parentBatch?.toolCallIds ?? [])
        .map((toolCallId) => lifecycle.toolOutbox[toolCallId])
        .filter((candidate): candidate is ToolReceipt =>
          candidate?.failureKind !== undefined
        );
      if (failedReceipts.length > 0) {
        if (!parentBatch || !batchIsReady(lifecycle, parentBatch)) break;
        parentBatch.continuationRequested = true;
        const primaryFailure = failedReceipts[0]!;
        const indeterminate = failedReceipts.some(
          (candidate) => candidate.failureKind === "indeterminate",
        );
        queueTruthfulRecovery(
          lifecycle,
          commands,
          event,
          "tool_persistence_failed",
          primaryFailure.toolCallId,
          { toolCallId: primaryFailure.toolCallId },
          indeterminate
            ? INDETERMINATE_RECOVERY_RESPONSE_INSTRUCTIONS_PT
            : TRUTHFUL_RECOVERY_RESPONSE_INSTRUCTIONS_PT,
          false,
        );
        break;
      }
      if (!maybeStartSignoffForReadyBatch(lifecycle, commands, event))
        maybeAdvanceCoverage(lifecycle, commands, event);
      break;
    }
    case "tool.batch_closed": {
      const key = batchKey(event.providerResponseId, event.batchHash);
      const uniqueIds = [...new Set(event.toolCallIds)];
      if (
        uniqueIds.length !== event.toolCallIds.length ||
        uniqueIds.some((id) => {
          const receipt = lifecycle.toolOutbox[id];
          return (
            !receipt ||
            receipt.providerResponseId !== event.providerResponseId ||
            receipt.batchHash !== event.batchHash
          );
        })
      ) {
        block(
          lifecycle,
          commands,
          event,
          "tool_batch_invalid",
          "tool batch did not match admitted calls",
        );
        break;
      }
      const existing = lifecycle.toolBatches[key];
      if (existing) {
        if (JSON.stringify(existing.toolCallIds) !== JSON.stringify(uniqueIds))
          block(
            lifecycle,
            commands,
            event,
            "tool_batch_mismatch",
            "replayed tool batch changed membership",
          );
        break;
      }
      if (Object.keys(lifecycle.toolBatches).length >= MAX_TOOL_BATCHES) {
        block(
          lifecycle,
          commands,
          event,
          "tool_batch_capacity_exceeded",
          "tool batch replay registry reached its deterministic bound",
        );
        break;
      }
      lifecycle.toolBatches[key] = {
        providerResponseId: event.providerResponseId,
        batchHash: event.batchHash,
        toolCallIds: uniqueIds,
        closed: true,
        continuationRequested: false,
      };
      maybeAdvanceCoverage(lifecycle, commands, event);
      break;
    }
    case "approval.persisted": {
      const receipt = lifecycle.toolOutbox[event.toolCallId];
      const summary = lifecycle.summary;
      if (
        lifecycle.phase !== "approval_persisting" ||
        !receipt ||
        receipt.toolName !== "approve_onboarding_summary" ||
        receipt.state !== "running" ||
        !summary ||
        event.coverageReceiptId !== summary.receiptId ||
        event.revision !== summary.revision ||
        event.digest !== summary.digest ||
        !event.approvalReceiptId
      ) {
        block(
          lifecycle,
          commands,
          event,
          "approval_receipt_mismatch",
          "approval receipt did not match the spoken summary",
          event.toolCallId,
        );
        break;
      }
      receipt.state = "executed";
      receipt.output = event.output;
      receipt.resultHash = event.resultHash;
      lifecycle.approval = {
        toolCallId: event.toolCallId,
        approvalReceiptId: event.approvalReceiptId,
        coverageReceiptId: event.coverageReceiptId,
        revision: event.revision,
        digest: event.digest,
      };
      commands.push(
        telemetry(lifecycle, "onboarding.approval.persisted", event, {
          toolCallId: event.toolCallId,
          outcome: "immutable_receipt_bound",
        }),
      );
      resendOutput(lifecycle, commands, event, receipt, false);
      break;
    }
    case "approval.persistence_failed": {
      if (event.code === "changed") {
        const receipt = lifecycle.toolOutbox[event.toolCallId];
        if (
          !receipt ||
          receipt.toolName !== "approve_onboarding_summary" ||
          receipt.state !== "running"
        ) {
          block(
            lifecycle,
            commands,
            event,
            "approval_failure_transition_invalid",
            "changed approval did not match a running approval tool",
            event.toolCallId,
          );
          break;
        }
        const rejected = lifecycle.summary;
        if (!rejected) {
          block(
            lifecycle,
            commands,
            event,
            "approval_refresh_without_summary",
            "changed approval did not have a rejected summary identity",
            event.toolCallId,
          );
          break;
        }
        const output = JSON.stringify({
          status: "snapshot_changed",
          retrying_summary: true,
        });
        receipt.state = "executed";
        receipt.output = output;
        receipt.resultHash = hashOnboardingToolArgs({ output });
        const requestId =
          `snapshot-refresh:${event.toolCallId}:` +
          `${rejected.revision}:${rejected.digest}`;
        delete lifecycle.summary;
        delete lifecycle.approvalCandidate;
        lifecycle.freshCallerTurnIds = [];
        lifecycle.phase = "snapshot_preparing";
        lifecycle.snapshotRefresh = {
          requestId,
          toolCallId: event.toolCallId,
          rejectedRevision: rejected.revision,
          rejectedDigest: rejected.digest,
        };
        commands.push(
          telemetry(lifecycle, "onboarding.approval.rejected", event, {
            toolCallId: event.toolCallId,
            errorCode: event.code,
            outcome: "persistence_failed",
          }),
        );
        resendOutput(lifecycle, commands, event, receipt, false);
        commands.push({
          type: "refresh_snapshot",
          requestId,
          afterRevision: rejected.revision,
          rejectedDigest: rejected.digest,
        });
        break;
      } else {
        if (event.code === "indeterminate")
          delete lifecycle.toolOutbox[event.toolCallId];
        lifecycle.phase = "blocked";
        commands.push({
          type: "block",
          code: event.code,
          safeDetail: event.safeDetail,
          toolCallId: event.toolCallId,
          recoverable: true,
        });
      }
      commands.push(
        telemetry(lifecycle, "onboarding.approval.rejected", event, {
          toolCallId: event.toolCallId,
          errorCode: event.code,
          outcome: "persistence_failed",
        }),
      );
      break;
    }
    case "provider.termination_requested": {
      const approvalExpected = lifecycle.approval
        ? `hangup:${lifecycle.approval.approvalReceiptId}`
        : "";
      const budgetExpected = `budget-hangup:${lifecycle.callId}`;
      const budgetErrorExpected = `budget-error-hangup:${lifecycle.callId}`;
      const recoveryErrorExpected =
        `recovery-error-hangup:${lifecycle.callId}`;
      const transportErrorExpected =
        `transport-error-hangup:${lifecycle.callId}`;
      const fatalErrorExpected = `fatal-error-hangup:${lifecycle.callId}`;
      if (lifecycle.phase === "ready_to_terminate" &&
        event.intentKey === approvalExpected &&
        lifecycle.requestedHangupKeys.includes(approvalExpected)) {
        lifecycle.phase = "provider_terminating";
        break;
      }
      if (lifecycle.phase === "budget_pause_ready_to_terminate" &&
        event.intentKey === budgetExpected &&
        lifecycle.requestedBudgetHangupKeys.includes(budgetExpected)) {
        lifecycle.phase = "budget_pause_provider_terminating";
        break;
      }
      if (lifecycle.phase === "budget_pause_error_ready_to_terminate" &&
        event.intentKey === budgetErrorExpected &&
        lifecycle.requestedBudgetHangupKeys.includes(budgetErrorExpected)) {
        lifecycle.phase = "budget_error_provider_terminating";
        break;
      }
      if (lifecycle.phase === "recovery_error_ready_to_terminate" &&
        event.intentKey === recoveryErrorExpected &&
        lifecycle.requestedRecoveryHangupKeys.includes(
          recoveryErrorExpected,
        )) {
        lifecycle.phase = "recovery_error_provider_terminating";
        break;
      }
      if (lifecycle.phase === "transport_error_ready_to_terminate" &&
        event.intentKey === transportErrorExpected &&
        lifecycle.requestedTransportHangupKeys.includes(
          transportErrorExpected,
        )) {
        lifecycle.phase = "transport_error_provider_terminating";
        break;
      }
      if (lifecycle.phase === "fatal_error_ready_to_terminate" &&
        event.intentKey === fatalErrorExpected &&
        lifecycle.requestedFatalHangupKeys.includes(fatalErrorExpected)) {
        lifecycle.phase = "fatal_error_provider_terminating";
        break;
      }
      block(
        lifecycle,
        commands,
        event,
        "provider_termination_not_authorized",
        "provider termination was requested before final playback proof",
      );
      break;
    }
    case "provider.termination_confirmed": {
      const approvalExpected = lifecycle.approval
        ? `hangup:${lifecycle.approval.approvalReceiptId}`
        : "";
      const budgetExpected = `budget-hangup:${lifecycle.callId}`;
      const budgetErrorExpected = `budget-error-hangup:${lifecycle.callId}`;
      const recoveryErrorExpected =
        `recovery-error-hangup:${lifecycle.callId}`;
      const transportErrorExpected =
        `transport-error-hangup:${lifecycle.callId}`;
      const fatalErrorExpected = `fatal-error-hangup:${lifecycle.callId}`;
      const approvalClose = lifecycle.phase === "provider_terminating" &&
        event.intentKey === approvalExpected;
      const budgetClose = lifecycle.phase ===
          "budget_pause_provider_terminating" &&
        event.intentKey === budgetExpected;
      const budgetErrorClose = lifecycle.phase ===
          "budget_error_provider_terminating" &&
        event.intentKey === budgetErrorExpected;
      const recoveryErrorClose = lifecycle.phase ===
          "recovery_error_provider_terminating" &&
        event.intentKey === recoveryErrorExpected;
      const transportErrorClose = lifecycle.phase ===
          "transport_error_provider_terminating" &&
        event.intentKey === transportErrorExpected;
      const fatalErrorClose = lifecycle.phase ===
          "fatal_error_provider_terminating" &&
        event.intentKey === fatalErrorExpected;
      if ((
        !approvalClose && !budgetClose && !budgetErrorClose &&
        !recoveryErrorClose && !transportErrorClose && !fatalErrorClose
      ) ||
        !event.terminalPersisted) {
        block(
          lifecycle,
          commands,
          event,
          "provider_termination_unproven",
          "provider close or terminal persistence is unconfirmed",
        );
        break;
      }
      lifecycle.providerTerminationConfirmed = true;
      lifecycle.phase = "closed";
      commands.push(
        telemetry(lifecycle, "closing.provider_confirmed", event, {
          intentKey: event.intentKey,
          outcome: "provider_and_terminal_persisted",
        }),
      );
      commands.push(
        telemetry(lifecycle, "onboarding.closed", event, {
          intentKey: event.intentKey,
          outcome: approvalClose
            ? "durable_completion"
            : budgetClose
              ? "durable_budget_pause"
              : budgetErrorClose
                ? "durable_budget_pause_error"
                : recoveryErrorClose
                  ? "durable_recovery_error"
                  : transportErrorClose
                    ? "durable_transport_error"
                    : "durable_fatal_error",
        }),
      );
      break;
    }
    case "timer.elapsed":
      break;
  }

  return { lifecycle, commands };
}
