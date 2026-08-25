import { createHash } from "node:crypto";
import { evaluateCoverage, type CoverageRef } from "./onboarding-coverage.ts";
import type {
  OnboardingAnswerArgs,
  SnapshotResult,
} from "./onboarding-store.ts";

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
  | "ready_to_terminate"
  | "provider_terminating"
  | "closed"
  | "blocked";

export type ToolOutboxState =
  | "running"
  | "executed"
  | "output_pending"
  | "output_acked";

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
}

export interface SignoffProof {
  approvalReceiptId: string;
  responseId?: string;
  audioDone: boolean;
  responseDone: boolean;
  playbackStopped: boolean;
  interrupted: boolean;
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

export interface ResponseIntentReceipt {
  intentKey: string;
  purpose: ResponsePurpose;
  state: "queued" | "sent" | "acknowledged" | "terminal";
  responseId?: string;
}

export interface OnboardingLifecycle {
  callId: string;
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
  summary?: SummaryProof;
  signoff?: SignoffProof;
  invalidatedSummaryRevision?: number;
  requestedHangupKeys: string[];
  providerTerminationConfirmed: boolean;
}

export type ResponsePurpose =
  | "greeting"
  | "tool_continuation"
  | "summary"
  | "final_signoff";

export type TelemetryName =
  | "onboarding.coverage.started"
  | "onboarding.coverage.changed"
  | "onboarding.field.answered"
  | "onboarding.field.missing"
  | "onboarding.field.ambiguous"
  | "onboarding.followup.selected"
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
  | "onboarding.summary.validated"
  | "onboarding.summary.invalid"
  | "onboarding.summary.audio_done"
  | "onboarding.summary.playback_done"
  | "onboarding.approval.captured"
  | "onboarding.approval.persisted"
  | "onboarding.approval.rejected"
  | "onboarding.final_audio.done"
  | "onboarding.final_audio.playback_done"
  | "closing.provider_requested"
  | "closing.provider_confirmed"
  | "onboarding.closed"
  | "invariant.violation";

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
      type: "resend_output";
      toolCallId: string;
      output: string;
      outputItemId: string;
      replay: boolean;
      socketGeneration: number;
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
      type: "tool.called";
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      providerResponseId: string;
      batchHash: string;
    })
  | (TimedEvent & {
      type: "tool.executed";
      toolCallId: string;
      output: string;
      resultHash: string;
    })
  | (SocketEvent & { type: "tool.output_sent"; toolCallId: string })
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
      code: "timeout" | "query_error" | "empty" | "coverage_incomplete" | "changed" | "not_owner_bound" | "invalid_fact";
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

const batchKey = (providerResponseId: string, batchHash: string) =>
  `${providerResponseId}:${batchHash}`;
const outputItemId = (toolCallId: string) => `tool-output:${toolCallId}`;
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

function block(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  code: string,
  safeDetail: string,
  toolCallId?: string,
): void {
  lifecycle.phase = "blocked";
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

function queueResponse(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  request: Omit<Extract<OnboardingCommand, { type: "request_response" }>, "type">,
): boolean {
  if (lifecycle.responseIntents[request.intentKey]) return false;
  lifecycle.responseIntents[request.intentKey] = {
    intentKey: request.intentKey,
    purpose: request.purpose,
    state: "queued",
  };
  commands.push({ type: "request_response", ...request });
  commands.push(
    telemetry(lifecycle, "voice.response.intent_queued", event, {
      intentKey: request.intentKey,
      outcome: request.purpose,
    }),
  );
  return true;
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

function maybeAdvanceCoverage(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
): void {
  if (lifecycle.snapshotRefresh) return;
  const readyBatches = Object.values(lifecycle.toolBatches).filter(
    (batch) => batchIsReady(lifecycle, batch) && !batch.continuationRequested,
  );
  if (lifecycle.coverage.complete) {
    if (lifecycle.activeResponseId) return;
    if (!everyAdmittedCallIsInAReadyBatch(lifecycle)) return;
    const digest = lifecycle.coverage.digest;
    if (!digest || lifecycle.preparedSnapshotDigests.includes(digest)) return;
    lifecycle.phase = "snapshot_preparing";
    lifecycle.preparedSnapshotDigests.push(digest);
    commands.push({
      type: "prepare_summary",
      revision: lifecycle.coverage.revision,
      digest,
    });
    commands.push(
      telemetry(lifecycle, "onboarding.snapshot.prepare_started", event, {
        outcome: "coverage_complete",
      }),
    );
    return;
  }
  for (const batch of readyBatches) {
    const intentKey = `tool-batch:${batch.providerResponseId}:${batch.batchHash}`;
    if (lifecycle.coverage.nextQuestion) {
      lifecycle.phase = "follow_up";
      commands.push({
        type: "ask_follow_up",
        ...lifecycle.coverage.nextQuestion,
        intentKey,
      });
      commands.push(
        telemetry(lifecycle, "onboarding.followup.selected", event, {
          intentKey,
          outcome: lifecycle.coverage.nextQuestion.field,
        }),
      );
    }
    if (
      queueResponse(lifecycle, commands, event, {
        intentKey,
        purpose: "tool_continuation",
        ...(lifecycle.coverage.nextQuestion
          ? { instructions: lifecycle.coverage.nextQuestion.questionPt }
          : {}),
      })
    )
      batch.continuationRequested = true;
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
  if (
    !summary ||
    summary.validated !== undefined ||
    !summary.transcriptFinal ||
    !summary.audioDone ||
    !summary.responseDone ||
    !summary.playbackStopped ||
    summary.interrupted
  )
    return;
  summary.validated = summaryTranscriptValid(summary);
  if (!summary.validated) {
    commands.push(
      telemetry(lifecycle, "onboarding.summary.invalid", event, {
        responseId: summary.responseId,
        intentKey: `summary:${summary.digest}`,
        outcome: "factual_or_audio_proof_invalid",
      }),
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
    signoff.interrupted ||
    !signoff.audioDone ||
    !signoff.responseDone ||
    !signoff.playbackStopped
  )
    return;
  lifecycle.phase = "ready_to_terminate";
  const intentKey = `hangup:${approval.approvalReceiptId}`;
  if (lifecycle.requestedHangupKeys.includes(intentKey)) return;
  lifecycle.requestedHangupKeys.push(intentKey);
  commands.push({
    type: "request_hangup",
    intentKey,
    approvalReceiptId: approval.approvalReceiptId,
  });
  commands.push(
    telemetry(lifecycle, "closing.provider_requested", event, {
      intentKey,
      responseId: signoff.responseId,
      outcome: "signoff_playback_proven",
    }),
  );
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
    audioDone: false,
    responseDone: false,
    playbackStopped: false,
    interrupted: false,
  };
  const intentKey = `final-signoff:${approval.approvalReceiptId}`;
  const instructions =
    "Diga uma única frase curta em português: a confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.";
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

function resendOutput(
  lifecycle: OnboardingLifecycle,
  commands: OnboardingCommand[],
  event: TimedEvent,
  receipt: ToolReceipt,
  replay: boolean,
): void {
  if (receipt.output === undefined) return;
  commands.push({
    type: "resend_output",
    toolCallId: receipt.toolCallId,
    output: receipt.output,
    outputItemId: receipt.outputItemId,
    replay,
    socketGeneration: lifecycle.socketGeneration,
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

export function createOnboardingLifecycle(callId: string): OnboardingLifecycle {
  if (!callId.trim()) throw new Error("onboarding_call_id_required");
  return {
    callId,
    phase: "greeting",
    lifecycleRevision: 0,
    socketGeneration: 0,
    coverage: {
      revision: 0,
      complete: false,
      missing: [],
      ambiguous: [],
    },
    toolOutbox: {},
    toolBatches: {},
    responseIntents: {},
    terminalResponseIds: [],
    preparedSnapshotDigests: [],
    freshCallerTurnIds: [],
    consumedCallerTurnIds: [],
    requestedHangupKeys: [],
    providerTerminationConfirmed: false,
  };
}

export function reduceOnboarding(
  current: OnboardingLifecycle,
  event: OnboardingEvent,
): { lifecycle: OnboardingLifecycle; commands: OnboardingCommand[] } {
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
      if (firstAttach)
        commands.push(
          telemetry(lifecycle, "onboarding.coverage.started", event, {
            outcome: `coverage_revision_${lifecycle.coverage.revision}`,
          }),
        );
      for (const receipt of Object.values(lifecycle.toolOutbox))
        if (
          receipt.state === "executed" || receipt.state === "output_pending"
        )
          resendOutput(lifecycle, commands, event, receipt, true);
      if (lifecycle.phase === "greeting")
        queueResponse(lifecycle, commands, event, {
          intentKey: `greeting:${lifecycle.callId}`,
          purpose: "greeting",
        });
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
      intent.state = "sent";
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
        intent.state = "acknowledged";
        intent.responseId = event.responseId;
        if (intent.purpose === "summary" && lifecycle.summary)
          lifecycle.summary.responseId = event.responseId;
        if (intent.purpose === "final_signoff" && lifecycle.signoff)
          lifecycle.signoff.responseId = event.responseId;
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
        lifecycle.summary?.responseId === event.responseId &&
        !lifecycle.summary.transcriptFinal
      )
        lifecycle.summary.transcript += event.delta;
      break;
    }
    case "response.transcript.done": {
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.transcript = event.transcript;
        lifecycle.summary.transcriptFinal = true;
        maybeValidateSummary(lifecycle, commands, event);
      }
      break;
    }
    case "response.output_audio.done": {
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
      break;
    }
    case "response.done": {
      if (!lifecycle.terminalResponseIds.includes(event.responseId))
        lifecycle.terminalResponseIds.push(event.responseId);
      if (lifecycle.activeResponseId === event.responseId)
        delete lifecycle.activeResponseId;
      for (const intent of Object.values(lifecycle.responseIntents))
        if (intent.responseId === event.responseId) intent.state = "terminal";
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.responseDone = true;
        maybeValidateSummary(lifecycle, commands, event);
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        lifecycle.signoff.responseDone = true;
        maybeFinishSignoff(lifecycle, commands, event);
      }
      if (lifecycle.phase === "greeting") lifecycle.phase = "collecting";
      else if (lifecycle.phase === "follow_up") lifecycle.phase = "collecting";
      commands.push(
        telemetry(lifecycle, "voice.response.terminal", event, {
          responseId: event.responseId,
          outcome: "response_done",
        }),
      );
      maybeAdvanceCoverage(lifecycle, commands, event);
      break;
    }
    case "output_audio_buffer.stopped": {
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
      break;
    }
    case "response.audio_interrupted": {
      if (lifecycle.summary?.responseId === event.responseId) {
        lifecycle.summary.audioDone = false;
        lifecycle.summary.playbackStopped = false;
        lifecycle.summary.interrupted = true;
        lifecycle.summary.validated = false;
        lifecycle.phase = "summary_speaking";
      }
      if (lifecycle.signoff?.responseId === event.responseId) {
        lifecycle.signoff.audioDone = false;
        lifecycle.signoff.playbackStopped = false;
        lifecycle.signoff.interrupted = true;
        lifecycle.phase = "final_signoff_speaking";
      }
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
      lifecycle.phase = lifecycle.coverage.complete
        ? "coverage_check"
        : "collecting";
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
      };
      lifecycle.freshCallerTurnIds = [];
      commands.push(
        telemetry(lifecycle, "onboarding.snapshot.ready", {
          elapsedMs: event.result.durationMs,
        }, { outcome: "snapshot_ready" }),
      );
      const facts = event.result.requiredAnchors.join("\n");
      queueResponse(lifecycle, commands, event, {
        intentKey: `summary:${event.result.digest}`,
        purpose: "summary",
        snapshotDigest: event.result.digest,
        instructions:
          `Fale diretamente estes fatos, sem narrar o processo:\n${facts}\n` +
          "Ao final, pergunte explicitamente se tudo está correto.",
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
      } else {
        commands.push(
          telemetry(lifecycle, "onboarding.approval.rejected", event, {
            outcome: "ambiguous_owner_turn",
          }),
        );
      }
      break;
    }
    case "tool.called": {
      const argsHash = hashOnboardingToolArgs(event.args);
      const existing = lifecycle.toolOutbox[event.toolCallId];
      if (existing) {
        if (
          existing.argsHash !== argsHash ||
          existing.toolName !== event.name ||
          existing.providerResponseId !== event.providerResponseId ||
          existing.batchHash !== event.batchHash
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
      const receipt: ToolReceipt = {
        toolCallId: event.toolCallId,
        toolName: event.name,
        argsHash,
        state: "running",
        providerResponseId: event.providerResponseId,
        batchHash: event.batchHash,
        outputItemId: outputItemId(event.toolCallId),
        socketGeneration: event.socketGeneration,
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
        if (
          lifecycle.phase !== "awaiting_owner_approval" ||
          !lifecycle.summary?.validated ||
          !lifecycle.approvalCandidate ||
          normalizeText(ownerWords) !==
            normalizeText(lifecycle.approvalCandidate.ownerWords)
        ) {
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
              toolCallId: event.toolCallId,
              outcome: "approval_tool_not_eligible",
            }),
          );
          break;
        }
        lifecycle.phase = "approval_persisting";
        commands.push({
          type: "persist_approval",
          toolCallId: event.toolCallId,
          argsHash,
          ownerWords,
          coverageReceiptId: lifecycle.summary.receiptId,
          revision: lifecycle.summary.revision,
          digest: lifecycle.summary.digest,
        });
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
      receipt.state = "output_pending";
      receipt.socketGeneration = event.socketGeneration;
      commands.push(
        telemetry(lifecycle, "voice.tool.output_sent", event, {
          toolCallId: event.toolCallId,
          outcome: "awaiting_acknowledgement",
        }),
      );
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
      if (
        lifecycle.approval?.toolCallId === event.toolCallId &&
        lifecycle.phase === "approval_persisting"
      )
        startSignoff(lifecycle, commands, event);
      else maybeAdvanceCoverage(lifecycle, commands, event);
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
        commands.push({
          type: "refresh_snapshot",
          requestId,
          afterRevision: rejected.revision,
          rejectedDigest: rejected.digest,
        });
      } else {
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
      const expected = lifecycle.approval
        ? `hangup:${lifecycle.approval.approvalReceiptId}`
        : "";
      if (
        lifecycle.phase !== "ready_to_terminate" ||
        event.intentKey !== expected ||
        !lifecycle.requestedHangupKeys.includes(expected)
      ) {
        block(
          lifecycle,
          commands,
          event,
          "provider_termination_not_authorized",
          "provider termination was requested before final playback proof",
        );
        break;
      }
      lifecycle.phase = "provider_terminating";
      break;
    }
    case "provider.termination_confirmed": {
      const expected = lifecycle.approval
        ? `hangup:${lifecycle.approval.approvalReceiptId}`
        : "";
      if (
        lifecycle.phase !== "provider_terminating" ||
        event.intentKey !== expected ||
        !event.terminalPersisted
      ) {
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
          outcome: "durable_completion",
        }),
      );
      break;
    }
    case "timer.elapsed":
      break;
  }

  return { lifecycle, commands };
}
