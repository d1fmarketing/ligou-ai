// Authoritative sideband: the controller owns tools, transcripts, usage, deadline and finalization.
// The browser only carries audio; it never executes tools and never holds credentials beyond its own mic.
import { createHash } from "node:crypto";
import { config, emptyUsage, sessionCostUsd, type UsageTotals } from "./config.ts";
import {
  runTool,
  validateToolArgumentsForCapability,
  type Capability,
} from "./tools.ts";
import { supa } from "./rules.ts";
import { finalizeTerminalBudget, type BudgetOutcome } from "./budget.ts";
import { requestProviderTermination, type FetchLike } from "./provider-termination.ts";
import { admitToolCall, evt, requestResponse, setPhase } from "./response-coordinator.ts";
import {
  createOnboardingLifecycle,
  hashOnboardingToolArgs,
  reduceOnboarding,
  type OnboardingCommand,
  type OnboardingEvent,
  type OnboardingLifecycle,
} from "./onboarding-coordinator.ts";
import {
  loadOnboardingSnapshot,
  recordOnboardingAnswer,
  recordOnboardingFollowup,
  recordOnboardingVoiceApproval,
  type OnboardingAnswerArgs,
} from "./onboarding-store.ts";
import type { CoverageField } from "./onboarding-coverage.ts";
import {
  onboardingOpeningText,
  openingPayloadIsInternallyValid,
  type OnboardingOpeningMode,
  type OnboardingOpeningPayload,
} from "./onboarding-greeting.ts";

type RequestResponseCommand = Extract<
  OnboardingCommand,
  { type: "request_response" }
>;
type PersistFactCommand = Extract<OnboardingCommand, { type: "persist_fact" }>;
type PersistFollowupCommand = Extract<
  OnboardingCommand,
  { type: "persist_followup" }
>;
type PersistApprovalCommand = Extract<
  OnboardingCommand,
  { type: "persist_approval" }
>;
type PendingMutationCommand =
  | PersistFactCommand
  | PersistFollowupCommand
  | PersistApprovalCommand;

interface PendingMutationEntry {
  command: PendingMutationCommand;
  reconciliationAttempts: number;
  retryScheduled: boolean;
  fingerprint: string;
}

interface PendingCallerTurn {
  turnId: string;
  responseId?: string;
  transcriptCompleted: boolean;
  responseTerminal?: boolean;
}

type OnboardingAdapterInvariantCode =
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
  | "application_opening_item_invalid"
  | "application_opening_response_forbidden"
  | "application_opening_tool_forbidden"
  | "application_opening_session_update_invalid";

interface ApplicationOpeningHandshake {
  payload: OnboardingOpeningPayload;
  itemObserved: boolean;
  transcriptRecorded: boolean;
  activationUpdateSentGeneration?: number;
  activatedGeneration?: number;
  retrieveEventId?: string;
}

interface BufferedOnboardingTool {
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  argsHash: string;
  outputIndex: number;
  callerTurnId?: string;
  memberError?: {
    code: OnboardingAdapterInvariantCode;
    safeDetail: string;
  };
}

interface BufferedOnboardingResponse {
  responseId: string;
  tools: BufferedOnboardingTool[];
  terminal: boolean;
  callerTurnId?: string;
  invariant?: {
    code: OnboardingAdapterInvariantCode;
    safeDetail: string;
  };
}

export interface OnboardingAdapterState {
  lifecycle: OnboardingLifecycle;
  queue: Promise<void>;
  responses: Record<string, BufferedOnboardingResponse>;
  terminalResponseBatchHashes: Record<string, string | null>;
  activeCallerTurnId?: string;
  pendingCallerTurns: PendingCallerTurn[];
  retiredCallerTurnIds: string[];
  callerTurnSequence: number;
  interrupted: boolean;
  pendingHangupIntentKey?: string;
  pendingResponseCommands: Record<string, RequestResponseCommand>;
  pendingMutationCommands: Record<string, PendingMutationEntry>;
  pendingMutationRetryTimers: Record<
    string,
    ReturnType<typeof setTimeout>
  >;
  speechGeneration: number;
  speechPending: boolean;
}

const MAX_ADAPTER_RESPONSES = 512;
const MAX_PENDING_CALLER_TURNS = 512;
const MAX_RETIRED_CALLER_TURNS = 1024;
const MAX_TERMINAL_RESPONSE_IDENTITIES = 1024;
const MAX_PENDING_RESPONSE_COMMANDS = 512;
const MAX_PENDING_MUTATION_COMMANDS = 512;
const MAX_ADAPTER_TOOL_RECEIPTS = 512;
const MAX_ADAPTER_TOOL_BATCHES = 512;
const MUTATION_RECONCILIATION_DELAY_MS = 0;

export interface SessionLedger {
  callId: string;
  openaiCallId: string;
  model: string;
  startedAt: number;
  usage: UsageTotals;
  providerUsageEvidence: {
    eventCount: number;
    lastResponseId: string | null;
    lastReceivedAt: string | null;
    continuous: boolean;
    terminal: boolean;
  };
  providerTerminalEvidence?: {
    observed: true;
    reason: "provider_session_ended";
    receivedAt: string;
  };
  transcript: Array<{ role: "caller" | "agent" | "system"; text: string; at: string }>;
  toolLog: Array<{ name: string; ok: boolean; durationMs: number }>;
  status: "active" | "ended" | "killed_deadline" | "killed_budget" | "error";
  /** True while OpenAI is streaming a response; `response.create` is illegal in that window. */
  responseActive?: boolean;
  /** A tool output was delivered and the model still owes the conversation its next turn. */
  continuationWanted?: boolean;
  /** Function calls still executing from the current batch; the continuation waits for all outputs. */
  pendingToolCalls?: number;
  /** The initial agent-speaks-first greeting was requested (once per call, ever). */
  greetingRequested?: boolean;
  /** Provider tool call_ids already executed — the coordinator's exactly-once dedup. */
  executedToolCallIds?: string[];
  /** Coarse lifecycle phase for telemetry (greeting/collecting/summarizing/closing/closed). */
  phase?: string;
  /** Stable application response intents already sent on this call. */
  requestedResponseIntentKeys?: string[];
  /** The session was ended by the agent, so the provider call is still live and needs the audited hangup. */
  agentEnded?: boolean;
  /** A successful terminal settlement is never submitted twice by one controller. */
  budgetFinalized?: boolean;
  /** Server-owned identity required to validate the exact onboarding greeting. */
  expectedOnboardingBusinessName?: string;
  /** Provider compatibility or deterministic application-owned opening. */
  openingMode?: OnboardingOpeningMode;
  /** Application TTS cost is outside Realtime usage but inside the call budget. */
  externalCostUsd?: number;
  /** Exact playback-to-conversation activation handshake for application TTS. */
  applicationOpening?: ApplicationOpeningHandshake;
  /** Onboarding-only reducer/transport state. It survives sideband socket reattachment. */
  onboarding?: OnboardingAdapterState;
}

/** Plan v4 §8: reserving quota only gates FUTURE sessions — a live session that runs up the bill must be cut.
 *  Returns the ceiling in USD for one session (reservation-based, overridable per deploy). */
export function sessionCostCapUsd(_model: string): number {
  return config.sessionCostCeilingUsd;
}

export function totalSessionCostUsd(ledger: SessionLedger): number {
  return sessionCostUsd(ledger.model, ledger.usage) +
    (ledger.externalCostUsd ?? 0);
}

const live = new Map<string, SessionLedger>();
export const liveSessions = live;

export interface SidebandControl {
  ledger: SessionLedger;
  opened: Promise<void>;
  cancel(reason?: string): void;
}

export interface SidebandOptions {
  phone?: { eventId: string; claimToken: string };
  onboarding?: {
    expectedBusinessName: string;
    openingMode?: OnboardingOpeningMode;
    openingPayload?: OnboardingOpeningPayload;
  };
  externalCostUsd?: number;
  fetchImpl?: FetchLike;
}

export function terminalStatusForReason(
  current: SessionLedger["status"],
  reason: string,
): SessionLedger["status"] {
  if (current !== "active") return current;
  return reason === "caller_hung_up" ? "ended" : "error";
}

function createOnboardingAdapter(
  callId: string,
  expectedBusinessName: string,
  openingMode: OnboardingOpeningMode = "provider_model_v1",
): OnboardingAdapterState {
  return {
    lifecycle: createOnboardingLifecycle(
      callId,
      expectedBusinessName,
      openingMode,
    ),
    queue: Promise.resolve(),
    responses: {},
    terminalResponseBatchHashes: {},
    pendingCallerTurns: [],
    retiredCallerTurnIds: [],
    callerTurnSequence: 0,
    interrupted: false,
    pendingResponseCommands: {},
    pendingMutationCommands: {},
    pendingMutationRetryTimers: {},
    speechGeneration: 0,
    speechPending: false,
  };
}

function ensureOnboardingAdapter(ledger: SessionLedger): OnboardingAdapterState {
  return ledger.onboarding ??
    (ledger.onboarding = createOnboardingAdapter(
      ledger.callId,
      ledger.expectedOnboardingBusinessName ?? "",
      ledger.openingMode ?? "provider_model_v1",
    ));
}

function onboardingBatchHash(tools: BufferedOnboardingTool[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tools.map((tool) => ({
      tool_call_id: tool.toolCallId,
      name: tool.name,
      args_hash: tool.argsHash,
      output_index: tool.outputIndex,
      caller_turn_id: tool.callerTurnId ?? null,
    }))), "utf8")
    .digest("hex");
}

function exactString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function applicationOpeningItemMatches(
  ledger: SessionLedger,
  item: any,
): boolean {
  const payload = ledger.applicationOpening?.payload;
  if (!payload) return false;
  return item?.id === payload.item_id &&
    item?.type === "message" &&
    item?.role === "assistant" &&
    item?.status === "completed" &&
    Array.isArray(item?.content) &&
    item.content.length === 1 &&
    item.content[0]?.type === "output_text" &&
    item.content[0]?.text === payload.text;
}

function applicationOpeningRetrieveEventId(
  ledger: SessionLedger,
  socketGeneration: number,
): string {
  const itemId = ledger.applicationOpening?.payload.item_id ?? "";
  const digest = createHash("sha256")
    .update(JSON.stringify({
      call_id: ledger.callId,
      item_id: itemId,
      socket_generation: socketGeneration,
    }), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ligou-opening-retrieve-${digest}`;
}

function openingTurnDetection(active: boolean) {
  return {
    type: "semantic_vad",
    eagerness: "low",
    create_response: active,
    interrupt_response: active,
  };
}

function sendApplicationOpeningActivation(
  ledger: SessionLedger,
  ws: WebSocket,
): void {
  const opening = ledger.applicationOpening;
  const generation = ledger.onboarding?.lifecycle.socketGeneration ?? 0;
  if (!opening || generation < 1 ||
    opening.activationUpdateSentGeneration === generation) return;
  ws.send(JSON.stringify({
    type: "session.update",
    event_id: `ligou-opening-activate-${generation}-${ledger.callId}`,
    session: {
      type: "realtime",
      audio: {
        input: {
          transcription: { model: "gpt-live-transcribe" },
          turn_detection: openingTurnDetection(true),
        },
      },
    },
  }));
  opening.activationUpdateSentGeneration = generation;
}

function exactOpeningSessionUpdate(value: unknown, active: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detection = (value as any)?.audio?.input?.turn_detection;
  return detection?.type === "semantic_vad" &&
    detection?.eagerness === "low" &&
    detection?.create_response === active &&
    detection?.interrupt_response === active;
}

function callerCorrelationRecoveryKey(
  explicitTurnId: string | null,
  retiredTurnIds: string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(explicitTurnId
      ? { explicit_turn_id: explicitTurnId }
      : { retired_turn_ids: [...retiredTurnIds].sort() }), "utf8")
    .digest("hex")
    .slice(0, 32);
}

function rememberRetiredCallerTurns(
  adapter: OnboardingAdapterState,
  turnIds: string[],
): void {
  for (const turnId of turnIds)
    if (!adapter.retiredCallerTurnIds.includes(turnId))
      adapter.retiredCallerTurnIds.push(turnId);
  const overflow = adapter.retiredCallerTurnIds.length -
    MAX_RETIRED_CALLER_TURNS;
  if (overflow > 0) adapter.retiredCallerTurnIds.splice(0, overflow);
}

function ensureResponseCapacity(adapter: OnboardingAdapterState): boolean {
  if (Object.keys(adapter.responses).length < MAX_ADAPTER_RESPONSES) return true;
  const pruneKey = Object.keys(adapter.responses)
    .find((key) => adapter.responses[key]?.terminal === true);
  if (!pruneKey) return false;
  delete adapter.responses[pruneKey];
  return true;
}

function preflightOnboardingBatch(
  cap: Capability,
  adapter: OnboardingAdapterState,
  responseId: string,
  batchHash: string,
  tools: BufferedOnboardingTool[],
  socketGeneration: number,
): BufferedOnboardingResponse["invariant"] | undefined {
  if (adapter.lifecycle.phase === "blocked")
    return {
      code: "tool_args_mismatch",
      safeDetail: "blocked lifecycle cannot admit another tool batch",
    };
  for (const tool of tools) {
    if (tool.memberError) return tool.memberError;
    if (!tool.args)
      return {
        code: "tool_args_json_invalid",
        safeDetail: "provider tool arguments were not a JSON object",
      };
    const validation = validateToolArgumentsForCapability(
      cap,
      tool.name,
      tool.args,
    );
    if (!validation.ok) return validation;
  }
  let newReceipts = 0;
  for (const tool of tools) {
    const existing = adapter.lifecycle.toolOutbox[tool.toolCallId];
    if (!existing) {
      newReceipts += 1;
      continue;
    }
    if (
      existing.toolName !== tool.name ||
      existing.argsHash !== tool.argsHash ||
      existing.providerResponseId !== responseId ||
      existing.batchHash !== batchHash
    )
      return {
        code: "tool_args_mismatch",
        safeDetail: "provider tool replay changed its payload or batch identity",
      };
  }
  if (
    Object.keys(adapter.lifecycle.toolOutbox).length + newReceipts >
      MAX_ADAPTER_TOOL_RECEIPTS
  )
    return {
      code: "adapter_capacity_exceeded",
      safeDetail: "tool replay registry reached its deterministic bound",
    };
  const key = `${responseId}:${batchHash}`;
  if (
    !adapter.lifecycle.toolBatches[key] &&
    Object.keys(adapter.lifecycle.toolBatches).length >= MAX_ADAPTER_TOOL_BATCHES
  )
    return {
      code: "adapter_capacity_exceeded",
      safeDetail: "tool batch replay registry reached its deterministic bound",
    };
  let preview = adapter.lifecycle;
  for (const tool of tools) {
    const reduced = reduceOnboarding(preview, {
      type: "tool.called",
      socketGeneration,
      toolCallId: tool.toolCallId,
      name: tool.name,
      args: tool.args!,
      providerResponseId: responseId,
      batchHash,
      elapsedMs: 0,
      ...(tool.callerTurnId ? { callerTurnId: tool.callerTurnId } : {}),
    });
    if (
      preview.phase !== "blocked" &&
      reduced.lifecycle.phase === "blocked"
    ) return {
      code: "tool_not_admitted",
      safeDetail: "provider tool batch was not admissible in the current lifecycle",
    };
    preview = reduced.lifecycle;
  }
  return undefined;
}

function safeToolOutput(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function toolResultHash(output: string): string {
  return hashOnboardingToolArgs({ output });
}

function telemetryFields(command: Extract<OnboardingCommand, { type: "telemetry" }>) {
  return {
    call: command.callIdPrefix,
    socket_generation: command.socketGeneration,
    lifecycle_revision: command.lifecycleRevision,
    phase: command.phase,
    elapsed_ms: command.elapsedMs,
    ...(command.responseId ? { response_id: command.responseId } : {}),
    ...(command.intentKey ? { intent_key: command.intentKey } : {}),
    ...(command.toolCallId ? { tool_call_id: command.toolCallId } : {}),
    ...(command.snapshotDigestPrefix
      ? { snapshot_digest: command.snapshotDigestPrefix }
      : {}),
    ...(command.outcome ? { outcome: command.outcome } : {}),
    ...(command.errorCode ? { error_code: command.errorCode } : {}),
  };
}

interface OnboardingCommandContext {
  cap: Capability;
  ledger: SessionLedger;
  ws: WebSocket;
  isCurrent: () => boolean;
}

function pendingResponseCommandIsCurrent(
  adapter: OnboardingAdapterState,
  command: RequestResponseCommand,
): boolean {
  if (command.purpose === "summary")
    return Boolean(
      command.snapshotDigest &&
      command.snapshotDigest === adapter.lifecycle.coverage.digest &&
      command.snapshotDigest === adapter.lifecycle.summary?.digest &&
      adapter.lifecycle.phase === "summary_speaking",
    );
  if (command.purpose === "final_signoff")
    return Boolean(
      command.approvalReceiptId &&
      command.approvalReceiptId ===
        adapter.lifecycle.approval?.approvalReceiptId &&
      command.approvalReceiptId ===
        adapter.lifecycle.signoff?.approvalReceiptId &&
      adapter.lifecycle.phase === "final_signoff_speaking",
    );
  return adapter.lifecycle.phase !== "blocked" &&
    adapter.lifecycle.phase !== "closed" &&
    adapter.lifecycle.phase !== "provider_terminating";
}

function hasDrainablePendingResponseCommand(
  adapter: OnboardingAdapterState,
): boolean {
  return Object.entries(adapter.pendingResponseCommands).some(
    ([intentKey, command]) =>
      adapter.lifecycle.responseIntents[intentKey]?.state === "queued" &&
      pendingResponseCommandIsCurrent(adapter, command),
  );
}

function pruneInvalidPendingResponseCommands(
  adapter: OnboardingAdapterState,
): void {
  if (adapter.lifecycle.phase === "blocked") {
    for (const intentKey of Object.keys(adapter.pendingResponseCommands))
      delete adapter.pendingResponseCommands[intentKey];
    return;
  }
  for (const [intentKey, command] of Object.entries(
    adapter.pendingResponseCommands,
  ))
    if (!pendingResponseCommandIsCurrent(adapter, command))
      delete adapter.pendingResponseCommands[intentKey];
}

async function dispatchOnboardingEvent(
  context: OnboardingCommandContext,
  event: OnboardingEvent,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  const reduced = reduceOnboarding(adapter.lifecycle, event);
  adapter.lifecycle = reduced.lifecycle;
  pruneInvalidPendingResponseCommands(adapter);
  context.ledger.phase = adapter.lifecycle.phase;
  await executeOnboardingCommands(context, reduced.commands);
}

async function recoverUnmatchedCallerTranscript(
  context: OnboardingCommandContext,
  explicitTurnId: string | null,
  safeDetail: string,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  const retiredTurnIds = [...new Set([
    ...adapter.pendingCallerTurns
      .filter((turn) => !turn.transcriptCompleted)
      .map((turn) => turn.turnId),
    ...(explicitTurnId ? [explicitTurnId] : []),
  ])];
  const retired = new Set(retiredTurnIds);
  rememberRetiredCallerTurns(adapter, retiredTurnIds);
  if (retired.size > 0) {
    adapter.pendingCallerTurns = adapter.pendingCallerTurns.filter(
      (turn) => !retired.has(turn.turnId),
    );
    if (
      adapter.activeCallerTurnId && retired.has(adapter.activeCallerTurnId)
    ) delete adapter.activeCallerTurnId;
  }
  adapter.speechPending = adapter.pendingCallerTurns.some(
    (turn) => turn.responseTerminal !== true,
  );
  await dispatchOnboardingEvent(context, {
    type: "recovery.required",
    reason: "caller_turn_correlation_mismatch",
    recoveryKey: callerCorrelationRecoveryKey(
      explicitTurnId,
      retiredTurnIds,
    ),
    socketGeneration: adapter.lifecycle.socketGeneration,
    ...(retiredTurnIds.length > 0 ? { retiredTurnIds } : {}),
    elapsedMs: 0,
  });
  context.ledger.transcript.push({
    role: "system",
    text: `onboarding recovery: caller_turn_correlation_mismatch (${safeDetail})`,
    at: new Date().toISOString(),
  });
  if (!adapter.speechPending) await drainPendingResponseCommands(context);
}

function nextQuestionFromRecorded(result: {
  nextAction: Record<string, unknown>;
}): { field: string; subject?: string; questionPt: string } | undefined {
  const action = result.nextAction;
  if (action?.type !== "ask") return undefined;
  const field = exactString(action.field);
  const questionPt = exactString(action.question_pt ?? action.questionPt);
  if (!field || !questionPt) return undefined;
  const subject = exactString(action.subject);
  return { field, ...(subject ? { subject } : {}), questionPt };
}

function sameCoverageRef(
  ref: { field: string; subject?: string },
  candidate: { field: string; subject?: string },
): boolean {
  return ref.field === candidate.field && (ref.subject ?? "") === (candidate.subject ?? "");
}

function pendingMutationKey(command: PendingMutationCommand): string {
  if (command.type === "persist_fact") return `fact:${command.toolCallId}`;
  if (command.type === "persist_approval")
    return `approval:${command.toolCallId}`;
  return `followup:${command.revision}:${command.field}:${command.subject ?? ""}`;
}

function pendingMutationFingerprint(command: PendingMutationCommand): string {
  return hashOnboardingToolArgs(
    command as unknown as Record<string, unknown>,
  );
}

function pendingMutationIsExpected(
  adapter: OnboardingAdapterState,
  command: PendingMutationCommand,
): boolean {
  if (command.type === "persist_followup") {
    const pending = adapter.lifecycle.pendingFollowup;
    return Boolean(
      pending &&
      pending.sourceRevision === command.revision &&
      pending.sourceDigest === command.digest &&
      pending.field === command.field &&
      (pending.subject ?? "") === (command.subject ?? "") &&
      pending.questionPt === command.questionPt &&
      pending.intentKey === command.intentKey,
    );
  }
  const receipt = adapter.lifecycle.toolOutbox[command.toolCallId];
  if (
    !receipt ||
    receipt.state !== "running" ||
    receipt.argsHash !== command.argsHash
  ) return false;
  if (command.type === "persist_fact")
    return receipt.providerResponseId === command.providerResponseId &&
      receipt.batchHash === command.batchHash;
  return adapter.lifecycle.phase === "approval_persisting" &&
    receipt.toolName === "approve_onboarding_summary";
}

function clearPendingMutationEntry(
  adapter: OnboardingAdapterState,
  key: string,
): void {
  const timer = adapter.pendingMutationRetryTimers[key];
  if (timer) clearTimeout(timer);
  delete adapter.pendingMutationRetryTimers[key];
  delete adapter.pendingMutationCommands[key];
}

async function executePendingMutationReconciliation(
  context: OnboardingCommandContext,
  key: string,
  expectedGeneration: number,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  const entry = adapter.pendingMutationCommands[key];
  if (!entry) return;
  if (
    entry.fingerprint !== pendingMutationFingerprint(entry.command)
  ) {
    clearPendingMutationEntry(adapter, key);
    await dispatchOnboardingEvent(context, {
      type: "adapter.invariant_failed",
      code: "tool_args_mismatch",
      safeDetail: "pending mutation fingerprint changed before reconciliation",
      elapsedMs: 0,
    });
    return;
  }
  if (
    adapter.lifecycle.socketGeneration !== expectedGeneration ||
    !context.isCurrent()
  ) {
    entry.retryScheduled = false;
    return;
  }
  if (!pendingMutationIsExpected(adapter, entry.command)) {
    clearPendingMutationEntry(adapter, key);
    return;
  }
  if (entry.reconciliationAttempts >= 1) return;
  entry.retryScheduled = false;
  entry.reconciliationAttempts += 1;
  await executeOnboardingCommands(
    context,
    [structuredClone(entry.command)],
  );
}

function schedulePendingMutationReconciliation(
  context: OnboardingCommandContext,
  key: string,
): void {
  const adapter = ensureOnboardingAdapter(context.ledger);
  const entry = adapter.pendingMutationCommands[key];
  if (!entry || entry.retryScheduled || entry.reconciliationAttempts >= 1)
    return;
  entry.retryScheduled = true;
  const generation = adapter.lifecycle.socketGeneration;
  adapter.pendingMutationRetryTimers[key] = setTimeout(() => {
    delete adapter.pendingMutationRetryTimers[key];
    const task = adapter.queue.then(() =>
      executePendingMutationReconciliation(context, key, generation)
    );
    adapter.queue = task.catch(() => {
      adapter.interrupted = true;
      context.ledger.status = "error";
    });
  }, MUTATION_RECONCILIATION_DELAY_MS);
}

async function executeOnboardingCommands(
  context: OnboardingCommandContext,
  commands: OnboardingCommand[],
): Promise<void> {
  const { cap, ledger, ws, isCurrent } = context;
  const retainsCallAuthority = () =>
    isCurrent() ||
    (ledger.status === "active" && live.get(cap.callId) === ledger);
  for (const command of commands) {
    if (!retainsCallAuthority() && command.type !== "telemetry") return;
    const adapter = ensureOnboardingAdapter(ledger);
    if (
      command.type === "persist_fact" ||
      command.type === "persist_followup" ||
      command.type === "persist_approval"
    ) {
      const key = pendingMutationKey(command);
      const fingerprint = pendingMutationFingerprint(command);
      const existing = adapter.pendingMutationCommands[key];
      if (
        !existing &&
        Object.keys(adapter.pendingMutationCommands).length >=
          MAX_PENDING_MUTATION_COMMANDS
      ) {
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "adapter_capacity_exceeded",
          safeDetail: "pending mutation registry reached its deterministic bound",
          elapsedMs: 0,
        });
        continue;
      }
      if (existing && existing.fingerprint !== fingerprint) {
        clearPendingMutationEntry(adapter, key);
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "tool_args_mismatch",
          safeDetail: "pending mutation key was reused with a different payload",
          elapsedMs: 0,
        });
        continue;
      }
      if (!existing)
        adapter.pendingMutationCommands[key] = {
          command: structuredClone(command),
          reconciliationAttempts: 0,
          retryScheduled: false,
          fingerprint,
        };
    }
    if (command.type === "request_response") {
      if (!pendingResponseCommandIsCurrent(adapter, command)) {
        delete adapter.pendingResponseCommands[command.intentKey];
        continue;
      }
      if (
        !adapter.pendingResponseCommands[command.intentKey] &&
        Object.keys(adapter.pendingResponseCommands).length >=
          MAX_PENDING_RESPONSE_COMMANDS
      ) {
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "adapter_capacity_exceeded",
          safeDetail: "pending response command registry reached its deterministic bound",
          elapsedMs: 0,
        });
        continue;
      }
      adapter.pendingResponseCommands[command.intentKey] =
        structuredClone(command);
    }
    if (
      !isCurrent() &&
      (command.type === "request_response" ||
        command.type === "resend_output" ||
        command.type === "request_hangup")
    )
      continue;
    if (command.type === "request_response" && adapter.speechPending)
      continue;
    const generation = adapter.lifecycle.socketGeneration;
    switch (command.type) {
      case "telemetry":
        evt(command.name, telemetryFields(command));
        break;
      case "ask_follow_up":
      case "request_signoff":
      case "refuse_end_session":
        // Informational commands. The paired request_response/resend_output is
        // the single transport action and must not be duplicated here.
        break;
      case "block":
        ledger.phase = "blocked";
        ledger.transcript.push({
          role: "system",
          text: `onboarding blocked: ${command.code}`,
          at: new Date().toISOString(),
        });
        break;
      case "prepare_summary": {
        const result = await loadOnboardingSnapshot(cap);
        if (!retainsCallAuthority()) return;
        await dispatchOnboardingEvent(context, {
          type: "snapshot.loaded",
          result,
          elapsedMs: result.durationMs,
        });
        break;
      }
      case "refresh_snapshot": {
        const result = await loadOnboardingSnapshot(cap);
        if (!retainsCallAuthority()) return;
        await dispatchOnboardingEvent(context, {
          type: "snapshot.refresh_loaded",
          requestId: command.requestId,
          result,
          elapsedMs: result.durationMs,
        });
        break;
      }
      case "request_response": {
        const sent = requestResponse(ledger, ws, {
          intentKey: command.intentKey,
          purpose: command.purpose,
          ...(command.instructions ? { instructions: command.instructions } : {}),
          ...(command.snapshotDigest
            ? { snapshotDigest: command.snapshotDigest }
            : {}),
          ...(command.approvalReceiptId
            ? { approvalReceiptId: command.approvalReceiptId }
            : {}),
        });
        if (sent) {
          delete adapter.pendingResponseCommands[command.intentKey];
          await dispatchOnboardingEvent(context, {
            type: "response.intent_sent",
            socketGeneration: generation,
            intentKey: command.intentKey,
            elapsedMs: 0,
          });
        }
        break;
      }
      case "persist_fact": {
        const mutationKey = pendingMutationKey(command);
        ledger.pendingToolCalls = (ledger.pendingToolCalls ?? 0) + 1;
        const result = await recordOnboardingAnswer(
          cap,
          command.toolCallId,
          command.args as OnboardingAnswerArgs,
        );
        ledger.pendingToolCalls = Math.max(0, (ledger.pendingToolCalls ?? 1) - 1);
        if (!retainsCallAuthority()) return;
        const output = result.ok
          ? safeToolOutput({
              status: result.status,
              rule_id: result.ruleId,
              coverage_receipt_id: result.coverageReceiptId,
              revision: result.revision,
              complete: result.complete,
              missing: result.missing,
              ambiguous: result.ambiguous,
              next_action: result.nextAction,
              snapshot_hash: result.digest,
            })
          : safeToolOutput({
              status: "unknown",
              error: result.code,
              detail: result.safeDetail,
            });
        ledger.toolLog.push({
          name: "record_interview_answer",
          ok: result.ok,
          durationMs: result.durationMs,
        });
        if (!result.ok) {
          if (result.code === "indeterminate") {
            const entry = adapter.pendingMutationCommands[mutationKey];
            if ((entry?.reconciliationAttempts ?? 0) >= 1) {
              clearPendingMutationEntry(adapter, mutationKey);
              await dispatchOnboardingEvent(context, {
                type: "tool.execution_failed",
                toolCallId: command.toolCallId,
                code: "indeterminate",
                safeDetail: result.safeDetail,
                elapsedMs: result.durationMs,
              });
              adapter.interrupted = true;
            } else schedulePendingMutationReconciliation(
              context,
              mutationKey,
            );
            break;
          }
          clearPendingMutationEntry(adapter, mutationKey);
          await dispatchOnboardingEvent(context, {
            type: "tool.execution_failed",
            toolCallId: command.toolCallId,
            code: result.code,
            safeDetail: result.safeDetail,
            elapsedMs: result.durationMs,
          });
          adapter.interrupted = true;
          break;
        }
        clearPendingMutationEntry(adapter, mutationKey);
        const currentCoverage = adapter.lifecycle.coverage;
        const nonAdvancingReuse = result.status === "reused" &&
          result.revision <= currentCoverage.revision;
        if (
          nonAdvancingReuse &&
          result.revision === currentCoverage.revision &&
          currentCoverage.digest &&
          result.digest !== currentCoverage.digest
        ) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "reused_coverage_mismatch",
            safeDetail: "reused coverage identity conflicted with the current revision",
            elapsedMs: result.durationMs,
          });
          break;
        }
        await dispatchOnboardingEvent(context, {
          type: "tool.executed",
          toolCallId: command.toolCallId,
          output,
          resultHash: toolResultHash(output),
          elapsedMs: result.durationMs,
        });
        if (nonAdvancingReuse) break;
        const ref = {
          field: String(command.args.field),
          ...(exactString(command.args.subject)
            ? { subject: String(command.args.subject) }
            : {}),
        };
        await dispatchOnboardingEvent(context, {
          type: "coverage.changed",
          revision: result.revision,
          digest: result.digest,
          complete: result.complete,
          missing: result.missing,
          ambiguous: result.ambiguous,
          answered: result.ambiguous.some((candidate) => sameCoverageRef(ref, candidate))
            ? []
            : [ref],
          ...(nextQuestionFromRecorded(result)
            ? { nextQuestion: nextQuestionFromRecorded(result)! }
            : {}),
          elapsedMs: result.durationMs,
        });
        break;
      }
      case "persist_followup": {
        const mutationKey = pendingMutationKey(command);
        const result = await recordOnboardingFollowup(cap, {
          revision: command.revision,
          digest: command.digest,
          field: command.field as CoverageField,
          ...(command.subject ? { subject: command.subject } : {}),
          questionPt: command.questionPt,
        });
        if (!retainsCallAuthority()) return;
        if (!result.ok) {
          if (result.code === "indeterminate") {
            const entry = adapter.pendingMutationCommands[mutationKey];
            if ((entry?.reconciliationAttempts ?? 0) >= 1) {
              clearPendingMutationEntry(adapter, mutationKey);
              await dispatchOnboardingEvent(context, {
                type: "followup.persistence_failed",
                sourceRevision: command.revision,
                field: command.field,
                ...(command.subject ? { subject: command.subject } : {}),
                code: "indeterminate",
                safeDetail: result.safeDetail,
                elapsedMs: result.durationMs,
              });
            } else schedulePendingMutationReconciliation(
              context,
              mutationKey,
            );
            break;
          }
          clearPendingMutationEntry(adapter, mutationKey);
          await dispatchOnboardingEvent(context, {
            type: "followup.persistence_failed",
            sourceRevision: command.revision,
            field: command.field,
            ...(command.subject ? { subject: command.subject } : {}),
            code: result.code,
            safeDetail: result.safeDetail,
            elapsedMs: result.durationMs,
          });
          break;
        }
        clearPendingMutationEntry(adapter, mutationKey);
        await dispatchOnboardingEvent(context, {
          type: "followup.persisted",
          sourceRevision: command.revision,
          revision: result.revision,
          digest: result.digest,
          field: command.field,
          ...(command.subject ? { subject: command.subject } : {}),
          questionPt: command.questionPt,
          intentKey: command.intentKey,
          elapsedMs: result.durationMs,
        });
        break;
      }
      case "execute_tool": {
        ledger.pendingToolCalls = (ledger.pendingToolCalls ?? 0) + 1;
        const result = await runTool(
          cap,
          command.name,
          command.args,
          command.toolCallId,
        );
        ledger.pendingToolCalls = Math.max(0, (ledger.pendingToolCalls ?? 1) - 1);
        if (!retainsCallAuthority()) return;
        const output = safeToolOutput(result.body);
        ledger.toolLog.push({
          name: command.name,
          ok: result.ok,
          durationMs: result.durationMs,
        });
        await dispatchOnboardingEvent(context, {
          type: "tool.executed",
          toolCallId: command.toolCallId,
          output,
          resultHash: toolResultHash(output),
          elapsedMs: result.durationMs,
        });
        break;
      }
      case "persist_approval": {
        const mutationKey = pendingMutationKey(command);
        ledger.pendingToolCalls = (ledger.pendingToolCalls ?? 0) + 1;
        const result = await recordOnboardingVoiceApproval(
          cap,
          command.toolCallId,
          command.ownerWords,
        );
        ledger.pendingToolCalls = Math.max(0, (ledger.pendingToolCalls ?? 1) - 1);
        if (!retainsCallAuthority()) return;
        ledger.toolLog.push({
          name: "approve_onboarding_summary",
          ok: result.ok,
          durationMs: result.durationMs,
        });
        if (!result.ok) {
          if (result.code === "indeterminate") {
            const entry = adapter.pendingMutationCommands[mutationKey];
            if ((entry?.reconciliationAttempts ?? 0) >= 1) {
              clearPendingMutationEntry(adapter, mutationKey);
              await dispatchOnboardingEvent(context, {
                type: "approval.persistence_failed",
                toolCallId: command.toolCallId,
                code: "indeterminate",
                safeDetail: result.safeDetail,
                elapsedMs: result.durationMs,
              });
            } else schedulePendingMutationReconciliation(
              context,
              mutationKey,
            );
            break;
          }
          clearPendingMutationEntry(adapter, mutationKey);
          await dispatchOnboardingEvent(context, {
            type: "approval.persistence_failed",
            toolCallId: command.toolCallId,
            code: result.code,
            safeDetail: result.safeDetail,
            elapsedMs: result.durationMs,
          });
          break;
        }
        clearPendingMutationEntry(adapter, mutationKey);
        const output = safeToolOutput({
          status: result.status,
          approval_receipt_id: result.approvalReceiptId,
          coverage_receipt_id: result.coverageReceiptId,
          revision: result.revision,
          snapshot_hash: result.digest,
        });
        await dispatchOnboardingEvent(context, {
          type: "approval.persisted",
          toolCallId: command.toolCallId,
          approvalReceiptId: result.approvalReceiptId,
          coverageReceiptId: result.coverageReceiptId,
          revision: result.revision,
          digest: result.digest,
          output,
          resultHash: toolResultHash(output),
          elapsedMs: result.durationMs,
        });
        break;
      }
      case "resend_output": {
        try {
          ws.send(JSON.stringify(command.delivery === "create"
            ? {
                type: "conversation.item.create",
                event_id: command.eventId,
                item: {
                  id: command.outputItemId,
                  type: "function_call_output",
                  call_id: command.toolCallId,
                  output: command.output,
                },
              }
            : {
                type: "conversation.item.retrieve",
                event_id: command.eventId,
                item_id: command.outputItemId,
              }));
        } catch {
          // The reducer intentionally keeps the receipt in executed/pending.
          // A later socket generation receives a deterministic resend command.
          break;
        }
        if (!isCurrent()) return;
        await dispatchOnboardingEvent(context, {
          type: "tool.output_sent",
          socketGeneration: generation,
          toolCallId: command.toolCallId,
          delivery: command.delivery,
          eventId: command.eventId,
          elapsedMs: 0,
        });
        break;
      }
      case "request_hangup": {
        if (adapter.pendingHangupIntentKey) break;
        await dispatchOnboardingEvent(context, {
          type: "provider.termination_requested",
          intentKey: command.intentKey,
          elapsedMs: 0,
        });
        if (adapter.lifecycle.phase !== "provider_terminating") break;
        adapter.pendingHangupIntentKey = command.intentKey;
        ledger.agentEnded = true;
        ledger.status = "ended";
        ledger.transcript.push({
          role: "system",
          text: "session ended: approval-bound onboarding signoff completed",
          at: new Date().toISOString(),
        });
        try { ws.close(); } catch {}
        break;
      }
    }
  }
}

async function drainPendingResponseCommands(
  context: OnboardingCommandContext,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  if (
    !context.isCurrent() || adapter.speechPending ||
    adapter.lifecycle.phase === "blocked" ||
    adapter.lifecycle.phase === "closed" ||
    adapter.lifecycle.phase === "provider_terminating"
  ) return;
  for (const [intentKey, command] of Object.entries(
    adapter.pendingResponseCommands,
  )) {
    const intent = adapter.lifecycle.responseIntents[intentKey];
    if (
      !intent || intent.state !== "queued" ||
      !pendingResponseCommandIsCurrent(adapter, command)
    ) {
      delete adapter.pendingResponseCommands[intentKey];
      continue;
    }
    await executeOnboardingCommands(context, [structuredClone(command)]);
  }
}

async function resumeApplicationOnboardingTransport(
  context: OnboardingCommandContext,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  const generation = adapter.lifecycle.socketGeneration;
  await dispatchOnboardingEvent(context, {
    type: "application.transport_activated",
    socketGeneration: generation,
    elapsedMs: 0,
  });
  if (adapter.lifecycle.phase === "blocked") return;
  for (const key of Object.keys(adapter.pendingMutationCommands)) {
    const timer = adapter.pendingMutationRetryTimers[key];
    if (timer) clearTimeout(timer);
    delete adapter.pendingMutationRetryTimers[key];
    const entry = adapter.pendingMutationCommands[key];
    if (entry) entry.retryScheduled = false;
    await executePendingMutationReconciliation(context, key, generation);
  }
  await drainPendingResponseCommands(context);
}

async function attachOnboardingSocket(
  context: OnboardingCommandContext,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  const pendingBeforeAttach = Object.values(adapter.pendingResponseCommands)
    .map((command) => structuredClone(command));
  const pendingMutationKeysBeforeAttach = Object.keys(
    adapter.pendingMutationCommands,
  );
  const generation = adapter.lifecycle.socketGeneration + 1;
  await dispatchOnboardingEvent(context, {
    type: "socket.attached",
    socketGeneration: generation,
    elapsedMs: 0,
  });
  const applicationOpening = context.ledger.applicationOpening;
  if (
    applicationOpening && generation > 1 &&
    adapter.lifecycle.phase !== "blocked" &&
    adapter.lifecycle.phase !== "closed" &&
    adapter.lifecycle.phase !== "provider_terminating"
  ) {
    const eventId = applicationOpeningRetrieveEventId(
      context.ledger,
      generation,
    );
    applicationOpening.retrieveEventId = eventId;
    context.ws.send(JSON.stringify({
      type: "conversation.item.retrieve",
      event_id: eventId,
      item_id: applicationOpening.payload.item_id,
    }));
  }
  if (applicationOpening) return;
  if (
    adapter.lifecycle.phase !== "blocked" &&
    adapter.lifecycle.phase !== "closed" &&
    adapter.lifecycle.phase !== "provider_terminating"
  )
    for (const key of pendingMutationKeysBeforeAttach) {
      const timer = adapter.pendingMutationRetryTimers[key];
      if (timer) clearTimeout(timer);
      delete adapter.pendingMutationRetryTimers[key];
      const entry = adapter.pendingMutationCommands[key];
      if (entry) entry.retryScheduled = false;
      await executePendingMutationReconciliation(
        context,
        key,
        adapter.lifecycle.socketGeneration,
      );
    }
  for (const command of pendingBeforeAttach)
    await executeOnboardingCommands(context, [command]);
}

function enqueueOnboardingRawEvent(
  context: OnboardingCommandContext,
  msg: any,
): Promise<void> {
  const adapter = ensureOnboardingAdapter(context.ledger);
  if (!context.isCurrent()) return Promise.resolve();
  if (msg?.type === "input_audio_buffer.speech_started") {
    adapter.speechGeneration += 1;
    adapter.speechPending = true;
  }
  const admittedGeneration = adapter.lifecycle.socketGeneration;
  const task = adapter.queue.then(async () => {
    if (
      admittedGeneration !== 0 &&
      adapter.lifecycle.socketGeneration !== admittedGeneration
    )
      return;
    if (adapter.lifecycle.socketGeneration === 0) {
      const attached = reduceOnboarding(adapter.lifecycle, {
        type: "socket.attached",
        socketGeneration: 1,
        elapsedMs: 0,
      });
      adapter.lifecycle = attached.lifecycle;
    }
    await handleOnboardingRawEvent(context, msg);
  });
  adapter.queue = task.catch((error) => {
    adapter.interrupted = true;
    context.ledger.status = "error";
    context.ledger.transcript.push({
      role: "system",
      text: "onboarding adapter invariant failure",
      at: new Date().toISOString(),
    });
    evt("invariant.violation", {
      call: context.ledger.callId.slice(0, 8),
      kind: "adapter_command_failed",
      code: error instanceof Error ? error.name : "unknown",
    });
  });
  return adapter.queue;
}

async function onboardingTerminationIsDurable(
  cap: Capability,
  ledger: SessionLedger,
): Promise<boolean> {
  const intentKey = ledger.onboarding?.pendingHangupIntentKey;
  if (!intentKey) return false;
  try {
    const { data, error } = await supa()
      .from("calls")
      .select("id,status,provider_termination_state")
      .eq("id", cap.callId)
      .eq("tenant_id", cap.tenantId)
      .maybeSingle();
    return !error && data?.id === cap.callId && data?.status === "ended" &&
      data?.provider_termination_state === "confirmed";
  } catch {
    return false;
  }
}

function confirmOnboardingTermination(
  ledger: SessionLedger,
): void {
  const adapter = ledger.onboarding;
  const intentKey = adapter?.pendingHangupIntentKey;
  if (!adapter || !intentKey) return;
  const reduced = reduceOnboarding(adapter.lifecycle, {
    type: "provider.termination_confirmed",
    intentKey,
    terminalPersisted: true,
    elapsedMs: 0,
  });
  adapter.lifecycle = reduced.lifecycle;
  ledger.phase = reduced.lifecycle.phase;
  for (const command of reduced.commands)
    if (command.type === "telemetry") evt(command.name, telemetryFields(command));
}

function authoritySpeechResponseAwaitingPlayback(
  lifecycle: OnboardingLifecycle,
): string | null {
  for (const proof of [
    lifecycle.signoff,
    lifecycle.summary,
    lifecycle.greeting,
  ])
    if (
      proof?.responseId &&
      !proof.playbackStopped &&
      !proof.interrupted
    ) return proof.responseId;
  return lifecycle.activeResponseId ?? null;
}

function enqueueOnboardingTransportInterruption(
  ledger: SessionLedger,
): void {
  const adapter = ledger.onboarding;
  if (!adapter || adapter.lifecycle.phase === "provider_terminating" ||
    adapter.lifecycle.phase === "closed") return;
  adapter.interrupted = true;
  const responseId = authoritySpeechResponseAwaitingPlayback(
    adapter.lifecycle,
  );
  if (!responseId) return;
  const task = adapter.queue.then(() => {
    const reduced = reduceOnboarding(adapter.lifecycle, {
      type: "response.audio_interrupted",
      socketGeneration: adapter.lifecycle.socketGeneration,
      responseId,
      elapsedMs: 0,
    });
    adapter.lifecycle = reduced.lifecycle;
    ledger.phase = reduced.lifecycle.phase;
    for (const command of reduced.commands) {
      if (command.type === "telemetry")
        evt(command.name, telemetryFields(command));
      if (command.type === "request_response")
        adapter.pendingResponseCommands[command.intentKey] =
          structuredClone(command);
      if (command.type === "block") {
        ledger.phase = "blocked";
        ledger.transcript.push({
          role: "system",
          text: `onboarding blocked: ${command.code}`,
          at: new Date().toISOString(),
        });
      }
    }
  });
  adapter.queue = task.catch(() => {
    adapter.interrupted = true;
    ledger.status = "error";
  });
}

async function interruptOnboardingAudio(
  context: OnboardingCommandContext,
  responseId: string | null,
): Promise<void> {
  if (!responseId) return;
  const adapter = ensureOnboardingAdapter(context.ledger);
  adapter.interrupted = true;
  await dispatchOnboardingEvent(context, {
    type: "response.audio_interrupted",
    socketGeneration: adapter.lifecycle.socketGeneration,
    responseId,
    elapsedMs: 0,
  });
}

async function handleOnboardingRawEvent(
  context: OnboardingCommandContext,
  msg: any,
): Promise<void> {
  const { cap, ledger, ws, isCurrent } = context;
  const adapter = ensureOnboardingAdapter(ledger);
  const generation = adapter.lifecycle.socketGeneration;
  const applicationOpening = ledger.applicationOpening;
  const applicationOpeningActive = !applicationOpening ||
    applicationOpening.activatedGeneration === generation;
  if (!applicationOpeningActive && msg?.type === "response.created") {
    await dispatchOnboardingEvent(context, {
      type: "adapter.invariant_failed",
      code: "application_opening_response_forbidden",
      safeDetail:
        "provider response existed before the application opening was activated",
      elapsedMs: 0,
    });
    return;
  }
  if (
    !applicationOpeningActive &&
    msg?.type === "response.output_item.done" &&
    msg.item?.type === "function_call"
  ) {
    await dispatchOnboardingEvent(context, {
      type: "adapter.invariant_failed",
      code: "application_opening_tool_forbidden",
      safeDetail:
        "provider tool call existed before the application opening was activated",
      elapsedMs: 0,
    });
    return;
  }
  if (
    adapter.lifecycle.phase === "provider_terminating" &&
    adapter.pendingHangupIntentKey &&
    adapter.lifecycle.signoff?.responseId &&
    (
      ((msg?.type === "response.output_audio.done" ||
        msg?.type === "response.output_audio_transcript.delta" ||
        msg?.type === "response.output_audio_transcript.done" ||
        msg?.type === "output_audio_buffer.stopped") &&
        msg.response_id === adapter.lifecycle.signoff.responseId) ||
      (msg?.type === "response.done" &&
        msg.response?.id === adapter.lifecycle.signoff.responseId)
    )
  ) return;
  switch (msg?.type) {
    case "response.created": {
      const responseId = exactString(msg.response?.id);
      if (!responseId) break;
      ledger.responseActive = true;
      const intentKey = exactString(msg.response?.metadata?.intent_key);
      const pendingCallerTurn = !intentKey && adapter.speechPending
        ? adapter.pendingCallerTurns.find((turn) => !turn.responseId)
        : undefined;
      const callerTurnId = pendingCallerTurn?.turnId;
      if (pendingCallerTurn) {
        pendingCallerTurn.responseId = responseId;
        pendingCallerTurn.responseTerminal = false;
      }
      if (callerTurnId) {
        let buffered = adapter.responses[responseId];
        if (!buffered) {
          if (!ensureResponseCapacity(adapter)) {
            await dispatchOnboardingEvent(context, {
              type: "adapter.invariant_failed",
              code: "adapter_capacity_exceeded",
              safeDetail: "response correlation registry reached its deterministic bound",
              elapsedMs: 0,
            });
            break;
          }
          buffered = adapter.responses[responseId] = {
            responseId,
            tools: [],
            terminal: false,
          };
        }
        if (
          buffered.callerTurnId &&
          buffered.callerTurnId !== callerTurnId
        ) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "caller_turn_correlation_mismatch",
            safeDetail: "provider response changed its caller turn identity",
            elapsedMs: 0,
          });
          break;
        }
        buffered.callerTurnId = callerTurnId;
      }
      await dispatchOnboardingEvent(context, {
        type: "response.created",
        socketGeneration: generation,
        responseId,
        ...(intentKey ? { intentKey } : {}),
        elapsedMs: 0,
      });
      break;
    }
    case "response.output_item.done": {
      const item = msg.item;
      if (item?.type !== "function_call") break;
      const responseId = exactString(msg.response_id);
      const toolCallId = exactString(item.call_id);
      const name = exactString(item.name);
      if (!responseId || !toolCallId || !name) {
        adapter.interrupted = true;
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "function_item_identity_missing",
          safeDetail: "provider function item identity was incomplete",
          elapsedMs: 0,
        });
        break;
      }
      const rawArguments = typeof item.arguments === "string"
        ? item.arguments
        : null;
      let args: Record<string, unknown> | undefined;
      let memberError: BufferedOnboardingTool["memberError"];
      try {
        const parsed = rawArguments === null
          ? undefined
          : JSON.parse(rawArguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          args = parsed as Record<string, unknown>;
        else
          memberError = {
            code: "tool_args_json_invalid",
            safeDetail: "provider tool arguments were not a JSON object",
          };
      } catch {
        memberError = {
          code: "tool_args_json_invalid",
          safeDetail: "provider tool arguments were malformed JSON",
        };
      }
      let buffered = adapter.responses[responseId];
      if (!buffered) {
        if (!ensureResponseCapacity(adapter)) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "adapter_capacity_exceeded",
            safeDetail: "response correlation registry reached its deterministic bound",
            elapsedMs: 0,
          });
          break;
        }
        buffered = adapter.responses[responseId] = {
          responseId,
          tools: [],
          terminal: false,
        };
      }
      if (buffered.terminal) {
        adapter.interrupted = true;
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "function_item_after_terminal_response",
          safeDetail: "provider function item arrived after its terminal response",
          elapsedMs: 0,
        });
        break;
      }
      if (item.status !== "completed") {
        buffered.invariant = {
          code: "function_item_not_completed",
          safeDetail: "provider function item was not completed",
        };
        break;
      }
      if (
        Object.prototype.hasOwnProperty.call(
          adapter.terminalResponseBatchHashes,
          responseId,
        ) &&
        adapter.terminalResponseBatchHashes[responseId] === null
      ) {
        buffered.invariant = {
          code: "function_item_after_terminal_response",
          safeDetail: "provider function item reopened a terminal response without tools",
        };
        break;
      }
      const outputIndex = msg.output_index;
      if (!Number.isSafeInteger(outputIndex) || outputIndex < 0) {
        buffered.invariant = {
          code: "output_index_invalid",
          safeDetail: "provider function item output index was invalid",
        };
        break;
      }
      const argsHash = args
        ? hashOnboardingToolArgs(args)
        : createHash("sha256")
          .update(`invalid-json\0${rawArguments ?? "<missing>"}`, "utf8")
          .digest("hex");
      const replay = buffered.tools.find((tool) => tool.toolCallId === toolCallId);
      if (
        replay && replay.name === name && replay.argsHash === argsHash &&
        replay.outputIndex === outputIndex &&
        (replay.callerTurnId ?? "") === (buffered.callerTurnId ?? "")
      ) break;
      if (replay) {
        buffered.invariant = {
          code: "tool_args_mismatch",
          safeDetail: "provider tool replay changed its payload",
        };
        break;
      }
      if (buffered.tools.some((tool) => tool.outputIndex === outputIndex)) {
        buffered.invariant = {
          code: "output_index_duplicate",
          safeDetail: "provider function items repeated an output index",
        };
        break;
      }
      if (buffered.tools.length >= 100) {
        buffered.invariant = {
          code: "tool_batch_too_large",
          safeDetail: "provider tool batch exceeded its bounded membership",
        };
        break;
      }
      buffered.tools.push({
        toolCallId,
        name,
        ...(args ? { args } : {}),
        argsHash,
        outputIndex,
        ...(buffered.callerTurnId
          ? { callerTurnId: buffered.callerTurnId }
          : {}),
        ...(memberError ? { memberError } : {}),
      });
      break;
    }
    case "conversation.item.created":
    case "conversation.item.done": {
      if (applicationOpening && !applicationOpeningActive) {
        if (!applicationOpeningItemMatches(ledger, msg.item)) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "application_opening_item_invalid",
            safeDetail:
              "created application opening item did not match the exact payload",
            elapsedMs: 0,
          });
          break;
        }
        applicationOpening.itemObserved = true;
        if (!applicationOpening.transcriptRecorded) {
          applicationOpening.transcriptRecorded = true;
          ledger.transcript.push({
            role: "agent",
            text: applicationOpening.payload.text,
            at: new Date().toISOString(),
          });
        }
        sendApplicationOpeningActivation(ledger, ws);
        break;
      }
      const outputItemId = exactString(msg.item?.id);
      if (!outputItemId) break;
      const receipt = Object.values(adapter.lifecycle.toolOutbox)
        .find((candidate) => candidate.outputItemId === outputItemId);
      if (!receipt) break;
      if (
        receipt.state !== "output_pending" ||
        receipt.outputRequest?.delivery !== "create" ||
        receipt.outputRequest.socketGeneration !== generation
      ) break;
      if (
        msg.item?.type !== "function_call_output" ||
        msg.item?.call_id !== receipt.toolCallId ||
        msg.item?.output !== receipt.output
      ) {
        adapter.interrupted = true;
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "tool_output_created_invalid",
          safeDetail: "created provider output did not match the pending receipt",
          elapsedMs: 0,
        });
        break;
      }
      await dispatchOnboardingEvent(context, {
        type: "tool.output_acked",
        socketGeneration: generation,
        toolCallId: receipt.toolCallId,
        outputItemId,
        elapsedMs: 0,
      });
      break;
    }
    case "conversation.item.retrieved": {
      if (applicationOpening && !applicationOpeningActive) {
        if (!applicationOpeningItemMatches(ledger, msg.item)) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "application_opening_item_invalid",
            safeDetail:
              "retrieved application opening item did not match the exact payload",
            elapsedMs: 0,
          });
          break;
        }
        applicationOpening.itemObserved = true;
        if (!applicationOpening.transcriptRecorded) {
          applicationOpening.transcriptRecorded = true;
          ledger.transcript.push({
            role: "agent",
            text: applicationOpening.payload.text,
            at: new Date().toISOString(),
          });
        }
        sendApplicationOpeningActivation(ledger, ws);
        break;
      }
      const pendingRetrievals = Object.values(adapter.lifecycle.toolOutbox)
        .filter((candidate) =>
          candidate.state === "output_pending" &&
          candidate.outputRequest?.delivery === "retrieve" &&
          candidate.outputRequest.socketGeneration === generation
        );
      if (pendingRetrievals.length === 0) break;
      const itemId = exactString(msg.item?.id);
      const receipt = itemId
        ? pendingRetrievals.find((candidate) =>
            candidate.outputItemId === itemId
          )
        : undefined;
      if (
        !receipt ||
        msg.item?.type !== "function_call_output" ||
        msg.item?.call_id !== receipt.toolCallId ||
        msg.item?.output !== receipt.output
      ) {
        adapter.interrupted = true;
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "tool_output_retrieved_invalid",
          safeDetail: "retrieved provider output did not match the pending receipt",
          elapsedMs: 0,
        });
        break;
      }
      await dispatchOnboardingEvent(context, {
        type: "tool.output_acked",
        socketGeneration: generation,
        toolCallId: receipt.toolCallId,
        outputItemId: receipt.outputItemId,
        elapsedMs: 0,
      });
      break;
    }
    case "session.updated": {
      if (!applicationOpening || applicationOpeningActive) break;
      if (exactOpeningSessionUpdate(msg.session, false)) break;
      if (
        applicationOpening.activationUpdateSentGeneration === generation &&
        exactOpeningSessionUpdate(msg.session, true)
      ) {
        if (adapter.lifecycle.phase === "greeting")
          await dispatchOnboardingEvent(context, {
            type: "application.greeting_activated",
            socketGeneration: generation,
            elapsedMs: 0,
          });
        if (adapter.lifecycle.phase === "collecting")
          applicationOpening.activatedGeneration = generation;
        if (applicationOpening.activatedGeneration === generation)
          await resumeApplicationOnboardingTransport(context);
        break;
      }
      const detection = msg.session?.audio?.input?.turn_detection;
      if (detection) {
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "application_opening_session_update_invalid",
          safeDetail:
            "provider session update did not match the requested opening activation",
          elapsedMs: 0,
        });
      }
      break;
    }
    case "response.output_audio_transcript.delta": {
      const responseId = exactString(msg.response_id);
      if (!responseId || typeof msg.delta !== "string") break;
      await dispatchOnboardingEvent(context, {
        type: "response.transcript.delta",
        socketGeneration: generation,
        responseId,
        delta: msg.delta,
        elapsedMs: 0,
      });
      break;
    }
    case "response.output_audio_transcript.done": {
      const responseId = exactString(msg.response_id);
      if (!responseId || typeof msg.transcript !== "string") break;
      ledger.transcript.push({
        role: "agent",
        text: msg.transcript,
        at: new Date().toISOString(),
      });
      await dispatchOnboardingEvent(context, {
        type: "response.transcript.done",
        socketGeneration: generation,
        responseId,
        transcript: msg.transcript,
        elapsedMs: 0,
      });
      break;
    }
    case "response.output_audio.done": {
      const responseId = exactString(msg.response_id);
      if (!responseId) break;
      await dispatchOnboardingEvent(context, {
        type: "response.output_audio.done",
        socketGeneration: generation,
        responseId,
        elapsedMs: 0,
      });
      break;
    }
    case "output_audio_buffer.stopped": {
      const responseId = exactString(msg.response_id);
      if (!responseId) {
        evt("invariant.violation", {
          call: ledger.callId.slice(0, 8),
          kind: "playback_stop_response_id_missing",
        });
        break;
      }
      await dispatchOnboardingEvent(context, {
        type: "output_audio_buffer.stopped",
        socketGeneration: generation,
        responseId,
        elapsedMs: 0,
      });
      break;
    }
    case "input_audio_buffer.speech_started": {
      await interruptOnboardingAudio(
        context,
        authoritySpeechResponseAwaitingPlayback(adapter.lifecycle),
      );
      const turnId = exactString(msg.item_id) ??
        `caller-turn:${++adapter.callerTurnSequence}`;
      if (adapter.retiredCallerTurnIds.includes(turnId)) break;
      const existingTurn = adapter.pendingCallerTurns.find(
        (turn) => turn.turnId === turnId,
      );
      if (!existingTurn) {
        if (adapter.pendingCallerTurns.length >= MAX_PENDING_CALLER_TURNS) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "adapter_capacity_exceeded",
            safeDetail:
              "pending caller turn registry reached its deterministic bound",
            elapsedMs: 0,
          });
          break;
        }
        adapter.pendingCallerTurns.push({
          turnId,
          transcriptCompleted: false,
        });
      }
      adapter.activeCallerTurnId = turnId;
      await dispatchOnboardingEvent(context, {
        type: "caller.speech_started",
        socketGeneration: generation,
        turnId,
        elapsedMs: 0,
      });
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = typeof msg.transcript === "string" ? msg.transcript : "";
      if (transcript)
        ledger.transcript.push({
          role: "caller",
          text: transcript,
          at: new Date().toISOString(),
        });
      const explicitTurnId = exactString(msg.item_id);
      if (
        explicitTurnId && adapter.retiredCallerTurnIds.includes(explicitTurnId)
      ) break;
      const untranscribed = adapter.pendingCallerTurns.filter(
        (turn) => !turn.transcriptCompleted,
      );
      const turnId = explicitTurnId ??
        (untranscribed.length === 1 ? untranscribed[0]!.turnId : undefined);
      if (!turnId) {
        if (untranscribed.length > 1)
          await recoverUnmatchedCallerTranscript(
            context,
            null,
            "caller transcription did not identify one pending speech turn",
          );
        break;
      }
      const pendingTurn = adapter.pendingCallerTurns.find(
        (turn) => turn.turnId === turnId,
      );
      if (!pendingTurn) {
        await recoverUnmatchedCallerTranscript(
          context,
          turnId,
          "caller transcription did not match a speech-owned turn",
        );
        break;
      }
      pendingTurn.transcriptCompleted = true;
      await dispatchOnboardingEvent(context, {
        type: "caller.transcript.completed",
        socketGeneration: generation,
        turnId,
        transcript,
        elapsedMs: 0,
      });
      if (pendingTurn.responseTerminal === true) {
        const completedTurnIndex = adapter.pendingCallerTurns.findIndex(
          (turn) => turn.turnId === turnId,
        );
        if (completedTurnIndex >= 0) {
          rememberRetiredCallerTurns(adapter, [turnId]);
          adapter.pendingCallerTurns.splice(completedTurnIndex, 1);
        }
      }
      adapter.speechPending = adapter.pendingCallerTurns.some(
        (turn) => turn.responseTerminal !== true,
      );
      if (!adapter.speechPending) await drainPendingResponseCommands(context);
      if (adapter.activeCallerTurnId === turnId)
        delete adapter.activeCallerTurnId;
      break;
    }
    case "response.cancelled":
    case "output_audio_buffer.cleared": {
      const responseId = exactString(msg.response_id);
      await interruptOnboardingAudio(context, responseId);
      break;
    }
    case "response.done": {
      const responseId = exactString(msg.response?.id);
      if (!responseId) break;
      const usage = validatedProviderUsage(msg.response?.usage);
      if (usage) {
        ledger.usage.textIn += usage.textIn;
        ledger.usage.audioIn += usage.audioIn;
        ledger.usage.textInCached += usage.textInCached;
        ledger.usage.audioInCached += usage.audioInCached;
        ledger.usage.textOut += usage.textOut;
        ledger.usage.audioOut += usage.audioOut;
        ledger.providerUsageEvidence.eventCount += 1;
        ledger.providerUsageEvidence.lastResponseId = responseId;
        ledger.providerUsageEvidence.lastReceivedAt = new Date().toISOString();
      }
      const responseStatus = msg.response?.status;
      const cancelled = responseStatus === "cancelled" ||
        msg.response?.status_details?.type === "cancelled";
      if (cancelled) await interruptOnboardingAudio(context, responseId);
      let buffered = adapter.responses[responseId];
      if (!buffered) {
        if (!ensureResponseCapacity(adapter)) {
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            code: "adapter_capacity_exceeded",
            safeDetail: "response correlation registry reached its deterministic bound",
            elapsedMs: 0,
          });
          ledger.responseActive = false;
          break;
        }
        buffered = adapter.responses[responseId] = {
          responseId,
          tools: [],
          terminal: false,
        };
      }
      if (buffered.terminal) break;
      buffered.terminal = true;
      const ordinaryCancelled = responseStatus === "cancelled" &&
        buffered.tools.length === 0 && !buffered.invariant;
      const turnDetectedCancellation = ordinaryCancelled &&
        msg.response?.status_details?.reason === "turn_detected";
      if (responseStatus !== "completed" && !ordinaryCancelled) {
        buffered.invariant = {
          code: "response_not_completed",
          safeDetail: "provider response was not completed",
        };
      }
      const knownTerminalIdentity = Object.prototype.hasOwnProperty.call(
        adapter.terminalResponseBatchHashes,
        responseId,
      );
      const sortedTools = buffered.tools.length > 0
        ? [...buffered.tools]
          .sort((left, right) => left.outputIndex - right.outputIndex)
        : [];
      const batchHash = sortedTools.length > 0
        ? onboardingBatchHash(sortedTools)
        : null;
      if (
        knownTerminalIdentity &&
        adapter.terminalResponseBatchHashes[responseId] !== batchHash
      ) buffered.invariant = {
        code: "tool_args_mismatch",
        safeDetail: "terminal provider response replay changed its tool batch identity",
      };
      if (
        !knownTerminalIdentity &&
        Object.keys(adapter.terminalResponseBatchHashes).length >=
          MAX_TERMINAL_RESPONSE_IDENTITIES
      ) buffered.invariant = {
        code: "adapter_capacity_exceeded",
        safeDetail: "terminal response identity registry reached its deterministic bound",
      };
      if (buffered.invariant) {
        adapter.interrupted = true;
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          ...buffered.invariant,
          elapsedMs: 0,
        });
      } else if (sortedTools.length > 0 && batchHash) {
        const preflight = preflightOnboardingBatch(
          cap,
          adapter,
          responseId,
          batchHash,
          sortedTools,
          generation,
        );
        if (preflight) {
          adapter.interrupted = true;
          await dispatchOnboardingEvent(context, {
            type: "adapter.invariant_failed",
            ...preflight,
            elapsedMs: 0,
          });
        } else {
          if (!knownTerminalIdentity)
            adapter.terminalResponseBatchHashes[responseId] = batchHash;
          for (const tool of sortedTools)
            await dispatchOnboardingEvent(context, {
            type: "tool.called",
            socketGeneration: generation,
            toolCallId: tool.toolCallId,
            name: tool.name,
            args: tool.args!,
            providerResponseId: responseId,
            batchHash,
            elapsedMs: 0,
            ...(tool.callerTurnId
              ? { callerTurnId: tool.callerTurnId }
              : {}),
          });
        }
        if (!preflight)
          await dispatchOnboardingEvent(context, {
            type: "tool.batch_closed",
            providerResponseId: responseId,
            batchHash,
            toolCallIds: sortedTools.map((tool) => tool.toolCallId),
            elapsedMs: 0,
          });
      } else if (!knownTerminalIdentity) {
        adapter.terminalResponseBatchHashes[responseId] = null;
      }
      ledger.responseActive = false;
      await dispatchOnboardingEvent(context, {
        type: "response.done",
        socketGeneration: generation,
        responseId,
        elapsedMs: 0,
      });
      if (
        responseStatus === "completed" &&
        sortedTools.length === 0 &&
        buffered.callerTurnId
      )
        await dispatchOnboardingEvent(context, {
          type: "recovery.required",
          reason: "owner_turn_completed_without_tool",
          recoveryKey: responseId,
          responseId,
          socketGeneration: generation,
          elapsedMs: 0,
        });
      const spent = totalSessionCostUsd(ledger);
      const costCapUsd = sessionCostCapUsd(ledger.model);
      if (spent >= costCapUsd && ledger.status === "active") {
        ledger.status = "killed_budget";
        ledger.transcript.push({
          role: "system",
          text: `session ended: cost cap reached ($${spent.toFixed(2)} >= $${costCapUsd.toFixed(2)})`,
          at: new Date().toISOString(),
        });
        try { ws.close(); } catch {}
      }
      const callerTurnIndex = adapter.pendingCallerTurns.findIndex(
        (turn) => turn.responseId === responseId,
      );
      if (callerTurnIndex >= 0 && responseStatus === "completed") {
        const callerTurn = adapter.pendingCallerTurns[callerTurnIndex]!;
        callerTurn.responseTerminal = true;
        if (callerTurn.transcriptCompleted) {
          rememberRetiredCallerTurns(adapter, [callerTurn.turnId]);
          adapter.pendingCallerTurns.splice(callerTurnIndex, 1);
        }
        adapter.speechPending = adapter.pendingCallerTurns.some(
          (turn) => turn.responseTerminal !== true,
        );
        if (!adapter.speechPending) await drainPendingResponseCommands(context);
      } else if (callerTurnIndex >= 0 && turnDetectedCancellation) {
        // This response belonged to the interrupted turn. The provider's next
        // response belongs to the newer speech-start record, never to this one.
        const callerTurn = adapter.pendingCallerTurns[callerTurnIndex]!;
        const transcriptCompleted = callerTurn.transcriptCompleted;
        rememberRetiredCallerTurns(adapter, [callerTurn.turnId]);
        adapter.pendingCallerTurns.splice(callerTurnIndex, 1);
        if (!transcriptCompleted)
          await dispatchOnboardingEvent(context, {
            type: "caller.turn_retired",
            socketGeneration: generation,
            turnId: callerTurn.turnId,
            elapsedMs: 0,
          });
        adapter.speechPending = adapter.pendingCallerTurns.some(
          (turn) => turn.responseTerminal !== true,
        );
        if (!adapter.speechPending) await drainPendingResponseCommands(context);
      } else if (callerTurnIndex >= 0 && ordinaryCancelled) {
        // Barge-in cancelled this ordinary VAD attempt. Keep the speech turn
        // pending so the next metadata-less provider response can bind it.
        delete adapter.pendingCallerTurns[callerTurnIndex]!.responseId;
        adapter.pendingCallerTurns[callerTurnIndex]!.responseTerminal = false;
        adapter.speechPending = true;
      }
      if (
        !adapter.speechPending && hasDrainablePendingResponseCommand(adapter)
      ) await drainPendingResponseCommands(context);
      break;
    }
    case "session.ended": {
      ledger.providerTerminalEvidence = {
        observed: true,
        reason: "provider_session_ended",
        receivedAt: new Date().toISOString(),
      };
      const usage = validatedProviderUsage(msg.usage);
      if (usage) {
        ledger.usage = usage;
        ledger.providerUsageEvidence.terminal = true;
        ledger.providerUsageEvidence.lastReceivedAt = new Date().toISOString();
      }
      if (adapter.lifecycle.phase === "provider_terminating" ||
        adapter.lifecycle.phase === "closed") {
        ledger.status = "ended";
      } else {
        adapter.interrupted = true;
        await interruptOnboardingAudio(context, adapter.lifecycle.activeResponseId ?? null);
        ledger.status = "error";
        ledger.transcript.push({
          role: "system",
          text: "onboarding interrupted before approval-bound final playback",
          at: new Date().toISOString(),
        });
      }
      try { ws.close(); } catch {}
      break;
    }
    case "error": {
      const code = exactString(msg.error?.code) ?? "";
      const message = typeof msg.error?.message === "string" ? msg.error.message : "";
      const causingEventId = exactString(msg.error?.event_id);
      if (
        applicationOpening &&
        causingEventId === applicationOpening.retrieveEventId
      ) {
        evt("voice.application_opening.retrieve_unconfirmed", {
          call: ledger.callId.slice(0, 8),
          socket_generation: generation,
        });
        break;
      }
      const outputReceipt = causingEventId
        ? Object.values(adapter.lifecycle.toolOutbox).find((candidate) =>
            candidate.state === "output_pending" &&
            candidate.outputRequest?.eventId === causingEventId &&
            candidate.outputRequest.socketGeneration === generation
          )
        : undefined;
      if (outputReceipt?.outputRequest?.delivery === "retrieve") {
        adapter.interrupted = true;
        await dispatchOnboardingEvent(context, {
          type: "adapter.invariant_failed",
          code: "tool_output_retrieve_failed",
          safeDetail: "provider could not retrieve the pending deterministic output",
          elapsedMs: 0,
        });
        break;
      }
      const duplicateOutputCreate =
        outputReceipt?.outputRequest?.delivery === "create" &&
        (
          code === "item_already_exists" ||
          code === "conversation_item_already_exists" ||
          /(?:item|conversation item).*(?:already exists|duplicate)/i.test(message)
        );
      if (duplicateOutputCreate) {
        await dispatchOnboardingEvent(context, {
          type: "tool.output_create_duplicate",
          socketGeneration: generation,
          toolCallId: outputReceipt.toolCallId,
          eventId: causingEventId!,
          elapsedMs: 0,
        });
        break;
      }
      if (code === "conversation_already_has_active_response" ||
        /already has an active response/i.test(message)) {
        ledger.responseActive = true;
        break;
      }
      adapter.interrupted = true;
      await interruptOnboardingAudio(context, adapter.lifecycle.activeResponseId ?? null);
      ledger.transcript.push({
        role: "system",
        text: `openai error: ${code || "provider_error"}`,
        at: new Date().toISOString(),
      });
      ledger.status = "error";
      try { ws.close(); } catch {}
      break;
    }
  }
  if (!isCurrent()) return;
}

export function attachSideband(
  cap: Capability,
  openaiCallId: string,
  model: string,
  options: SidebandOptions = {},
): SidebandControl {
  if (options.phone && cap.sessionType !== "customer")
    throw new Error("onboarding_phone_sideband_forbidden");
  const expectedOnboardingBusinessName = cap.sessionType === "onboarding"
    ? exactString(options.onboarding?.expectedBusinessName)
    : null;
  if (cap.sessionType === "onboarding" && !expectedOnboardingBusinessName)
    throw new Error("onboarding_expected_business_name_required");
  const openingMode: OnboardingOpeningMode = cap.sessionType === "onboarding"
    ? options.onboarding?.openingMode ?? "provider_model_v1"
    : "provider_model_v1";
  const openingPayload = options.onboarding?.openingPayload;
  const externalCostUsd = options.externalCostUsd ?? 0;
  if (!Number.isFinite(externalCostUsd) || externalCostUsd < 0)
    throw new Error("external_cost_invalid");
  if (openingMode === "application_tts_v1") {
    const expectedText = onboardingOpeningText(
      expectedOnboardingBusinessName!,
    );
    if (!openingPayloadIsInternallyValid(openingPayload, expectedText))
      throw new Error("application_opening_payload_invalid");
    if (externalCostUsd !== openingPayload.cost_usd)
      throw new Error("application_opening_cost_mismatch");
  } else if (openingPayload) {
    throw new Error("provider_opening_payload_forbidden");
  }
  const ledger: SessionLedger = {
    callId: cap.callId,
    openaiCallId,
    model,
    startedAt: Date.now(),
    usage: emptyUsage(),
    providerUsageEvidence: {
      eventCount: 0,
      lastResponseId: null,
      lastReceivedAt: null,
      continuous: true,
      terminal: false,
    },
    transcript: [],
    toolLog: [],
    status: "active",
    openingMode,
    externalCostUsd,
    ...(expectedOnboardingBusinessName
      ? { expectedOnboardingBusinessName }
      : {}),
    ...(cap.sessionType === "onboarding"
      ? {
          onboarding: createOnboardingAdapter(
            cap.callId,
            expectedOnboardingBusinessName!,
            openingMode,
          ),
        }
      : {}),
    ...(openingMode === "application_tts_v1"
      ? {
          applicationOpening: {
            payload: structuredClone(openingPayload!),
            itemObserved: false,
            transcriptRecorded: false,
          },
        }
      : {}),
  };
  // Root-cause discipline (2026-08-19 incident): a WS close is NOT the end of the call — the WebRTC leg
  // lives independently. We finalize only on terminal states (deadline/budget kill, or retries exhausted);
  // any other close triggers a reattach, because the call may still be in progress with live tools.
  const MAX_ATTACHES = 6;
  let attaches = 0;
  let everOpened = false;
  let terminal = false;
  let cancelled = false;
  let finalizing = false;
  let phoneActive = false;
  let ws: WebSocket | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let openedSettled = false;
  let resolveOpened!: () => void;
  let rejectOpened!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  void opened.catch(() => {});

  const ownsLiveLedger = () => (
    !cancelled
    && !terminal
    && !finalizing
    && live.get(cap.callId) === ledger
  );
  const ownsSocket = (sock: WebSocket) => ownsLiveLedger() && ws === sock;

  const clearRuntimeTimers = () => {
    if (deadline) clearTimeout(deadline);
    if (heartbeat) clearInterval(heartbeat);
    deadline = null;
    heartbeat = null;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    if (ledger.onboarding) {
      for (const timer of Object.values(
        ledger.onboarding.pendingMutationRetryTimers,
      )) clearTimeout(timer);
      ledger.onboarding.pendingMutationRetryTimers = {};
      ledger.onboarding.pendingMutationCommands = {};
    }
  };

  const cancel = (_reason = "cancelled") => {
    if (cancelled) return;
    cancelled = true;
    terminal = true;
    phoneActive = false;
    clearRuntimeTimers();
    if (live.get(cap.callId) === ledger) live.delete(cap.callId);
    if (!openedSettled) {
      openedSettled = true;
      rejectOpened(new Error("phone_sideband_cancelled"));
    }
    const socket = ws;
    ws = null;
    try { socket?.close(); } catch {}
  };

  const finalize = async (reason: string) => {
    if (cancelled || finalizing || live.get(cap.callId) !== ledger) return;
    finalizing = true;
    terminal = true;
    phoneActive = false;
    clearRuntimeTimers();
    if (!openedSettled) {
      openedSettled = true;
      rejectOpened(new Error("phone_sideband_closed_before_open"));
    }
    const socket = ws;
    ws = null;
    try { socket?.close(); } catch {}
    console.log(`sideband finalize call=${cap.callId.slice(0, 8)} reason=${reason} status=${ledger.status} tools=${ledger.toolLog.length}`);
    if (cap.sessionType !== "onboarding") setPhase(ledger, "closed");
    ledger.status = terminalStatusForReason(ledger.status, reason);
    let persisted = false;
    try {
      persisted = await persistLedger(cap, ledger, options.fetchImpl, options.phone);
    } catch (error) {
      console.error("persist failed", error);
    }
    // Budget settlement may be deferred when terminal usage is unresolved. That
    // does not authorize another provider request and must not hide already durable
    // provider+call completion from the onboarding lifecycle.
    if (
      cap.sessionType === "onboarding" &&
      await onboardingTerminationIsDurable(cap, ledger)
    )
      confirmOnboardingTermination(ledger);
    if (!persisted && options.phone) {
      await supa().rpc("defer_phone_sideband_finalization", {
        p_event_id: options.phone.eventId,
        p_claim_token: options.phone.claimToken,
        p_error: `sideband_terminal_persistence_failed:${reason}`,
      }).catch(() => ({ data: null, error: { message: "defer_failed" } }));
    }
    if (live.get(cap.callId) === ledger) live.delete(cap.callId);
  };

  const startHeartbeat = () => {
    if (!options.phone || heartbeat || !phoneActive || !ownsLiveLedger()) return;
    heartbeat = setInterval(() => {
      if (heartbeatInFlight || !phoneActive || !ownsLiveLedger()) return;
      heartbeatInFlight = true;
      void (async () => {
        try {
          const { data, error } = await supa().rpc("heartbeat_phone_sideband", {
            p_event_id: options.phone!.eventId,
            p_claim_token: options.phone!.claimToken,
          });
          if (!phoneActive || !ownsLiveLedger()) return;
          if (!error && data === true) return;
          ledger.status = "error";
          ledger.transcript.push({ role: "system", text: "sideband heartbeat failed", at: new Date().toISOString() });
          await finalize("sideband_heartbeat_failed");
        } catch {
          if (phoneActive && ownsLiveLedger()) await finalize("sideband_heartbeat_failed");
        } finally {
          heartbeatInFlight = false;
        }
      })();
    }, 5_000);
  };

  const activateOpenedSocket = async (sock: WebSocket) => {
    if (!ownsSocket(sock)) return;
    if (options.phone && !phoneActive) {
      const { data, error } = await supa().rpc("confirm_phone_sideband", {
        p_event_id: options.phone.eventId,
        p_claim_token: options.phone.claimToken,
      });
      if (!ownsSocket(sock)) return;
      if (error || data !== true) {
        if (!openedSettled) {
          openedSettled = true;
          rejectOpened(Object.assign(new Error("phone_sideband_activation_failed"), { detail: error?.message }));
        }
        cancel("phone_sideband_activation_failed");
        return;
      }
      if (!ownsSocket(sock)) return;
      phoneActive = true;
      if (!ownsSocket(sock)) return;
      startHeartbeat();
    }
    if (!ownsSocket(sock)) return;
    sock.send(JSON.stringify({
      type: "session.update",
      // turn_detection is re-asserted here because session.update semantics for nested
      // audio.input objects are not merge-guaranteed — both sites carry the same config.
      session: {
        type: "realtime",
        audio: {
          input: {
            transcription: { model: "gpt-live-transcribe" },
            turn_detection: openingTurnDetection(
              ledger.applicationOpening ? false : true,
            ),
          },
        },
      },
    }));
    if (!ownsSocket(sock)) return;
    if (cap.sessionType === "onboarding") {
      const adapter = ensureOnboardingAdapter(ledger);
      const context: OnboardingCommandContext = {
        cap,
        ledger,
        ws: sock,
        isCurrent: () => ownsSocket(sock),
      };
      const attached = adapter.queue.then(() => attachOnboardingSocket(context));
      adapter.queue = attached.catch(() => {
        adapter.interrupted = true;
        ledger.status = "error";
      });
      await attached;
    } else {
      // A fresh legacy socket has no knowledge of a response that was streaming
      // when the prior transport dropped. Non-onboarding sessions retain the
      // existing best-effort continuation behavior.
      ledger.responseActive = false;
      ledger.pendingToolCalls = 0;
      maybeContinueResponse(ledger, sock);
      if (!ownsSocket(sock)) return;
      if (!options.phone && requestResponse(ledger, sock, "greeting"))
        setPhase(ledger, "greeting");
    }
    if (!ownsSocket(sock)) return;
    if (!openedSettled) {
      openedSettled = true;
      resolveOpened();
    }
  };

  const connect = () => {
    if (cancelled || terminal) return;
    attaches += 1;
    const attempt = attaches;
    let openedThisAttempt = false;
    const sock = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(openaiCallId)}`, {
      // Bun extension: custom headers on client WebSocket
      headers: { Authorization: `Bearer ${config.openaiKey}` },
    } as any);
    ws = sock;

    sock.addEventListener("open", () => {
      if (!ownsSocket(sock)) return;
      openedThisAttempt = true;
      everOpened = true;
      console.log(`sideband OPEN call=${cap.callId.slice(0, 8)} rtc=${openaiCallId} attempt=${attempt}`);
      void activateOpenedSocket(sock).catch((error) => {
        if (!ownsSocket(sock)) return;
        ledger.status = "error";
        ledger.transcript.push({ role: "system", text: `sideband setup failed: ${String(error)}`, at: new Date().toISOString() });
        void finalize("sideband_session_update_failed");
      });
    });

    sock.addEventListener("message", (ev) => {
      const canHandleMessage = () => (
        openedThisAttempt
        && ledger.status === "active"
        && ownsSocket(sock)
        && (!options.phone || phoneActive)
      );
      if (!canHandleMessage()) return;
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!canHandleMessage()) return;
      void handleEvent(cap, ledger, sock, msg, canHandleMessage).then(() => {
        if (!openedThisAttempt || !ownsSocket(sock) || (options.phone && !phoneActive)) return;
        if (ledger.status !== "active") {
          terminal = true;
          clearTimeout(deadline);
          void finalize(ledger.status === "error" ? "openai_error" : "terminal_event");
        }
      });
    });

    sock.addEventListener("close", (ev: any) => {
      const wasCurrent = ws === sock;
      if (wasCurrent) ws = null;
      if (cancelled || !wasCurrent || live.get(cap.callId) !== ledger) return;
      if (cap.sessionType === "onboarding")
        enqueueOnboardingTransportInterruption(ledger);
      console.log(`sideband CLOSE call=${cap.callId.slice(0, 8)} code=${ev?.code} attempt=${attempt} opened=${openedThisAttempt} terminal=${terminal}`);
      if (terminal || ledger.status !== "active") { clearTimeout(deadline); void finalize("terminal_close"); return; }
      ledger.providerUsageEvidence.continuous = false;
      // 1002 after a healthy session means OpenAI no longer knows this call: the caller hung up.
      // Retrying then just delays the summary (45s of pointless reattaches on RJ's first real call).
      if (everOpened && !openedThisAttempt && ev?.code === 1002) {
        clearTimeout(deadline);
        void finalize("caller_hung_up");
        return;
      }
      if (attaches >= MAX_ATTACHES) {
        clearTimeout(deadline);
        ledger.transcript.push({ role: "system", text: `sideband lost after ${attaches} attaches (last close ${ev?.code})`, at: new Date().toISOString() });
        void finalize(everOpened ? "reattach_exhausted" : "retries_exhausted");
        return;
      }
      // call not visible yet (peer still connecting) or transient drop -> retry with backoff
      const delay = openedThisAttempt ? 500 : Math.min(1_000 * 2 ** (attempt - 1), 8_000);
      const retry = setTimeout(() => {
        retryTimers.delete(retry);
        if (!terminal && !cancelled && live.get(cap.callId) === ledger) {
          try { connect(); } catch { void finalize("sideband_reconnect_failed"); }
        }
      }, delay);
      retryTimers.add(retry);
    });
    sock.addEventListener("error", () => { /* close follows */ });
  };

  try {
    connect();
    live.set(cap.callId, ledger);
    const deadlineMs = cap.expiresAt - Date.now();
    deadline = setTimeout(() => {
      if (cancelled) return;
      terminal = true;
      ledger.status = "killed_deadline";
      ledger.transcript.push({ role: "system", text: "session ended: max duration reached", at: new Date().toISOString() });
      try { ws?.close(); } catch {}
      void finalize("deadline");
    }, Math.max(deadlineMs, 5_000));
  } catch (error) {
    if (!openedSettled) {
      openedSettled = true;
      resolveOpened();
    }
    cancel("sideband_setup_failed");
    throw error;
  }
  return { ledger, opened, cancel };
}

/** One continuation per owed turn, and only while no response is streaming. The interview
 *  stalled in production (call ec929149) because a per-item `response.create` raced the
 *  still-active response and the rejection was treated as terminal. */
function maybeContinueResponse(ledger: SessionLedger, ws: WebSocket) {
  // The coordinator owns eligibility (active response, pending tools, terminal
  // status, the consumed batch key) — this helper is just the call site.
  requestResponse(ledger, ws, "tool_continuation");
}

export async function handleEvent(
  cap: Capability,
  ledger: SessionLedger,
  ws: WebSocket,
  msg: any,
  isCurrent: () => boolean = () => true,
) {
  if (!isCurrent()) return;
  if (cap.sessionType === "onboarding")
    return await enqueueOnboardingRawEvent({ cap, ledger, ws, isCurrent }, msg);
  switch (msg.type) {
    case "response.created":
      ledger.responseActive = true;
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (msg.transcript) ledger.transcript.push({ role: "caller", text: msg.transcript, at: new Date().toISOString() });
      break;
    case "input_audio_buffer.speech_started":
      break;
    case "response.output_audio_transcript.done":
      if (msg.transcript)
        ledger.transcript.push({ role: "agent", text: msg.transcript, at: new Date().toISOString() });
      break;
    case "response.output_text.done":
      break;
    case "response.output_item.done": {
      const item = msg.item;
      if (item?.type === "function_call") {
        if (!isCurrent()) return;
        // Exactly-once per provider call_id: a duplicated/replayed event must not
        // re-run persistence, re-send an output or earn a second continuation.
        if (!admitToolCall(ledger, item.call_id)) break;
        ledger.pendingToolCalls = (ledger.pendingToolCalls ?? 0) + 1;
        if (ledger.phase === "greeting" || ledger.phase == null) setPhase(ledger, "collecting");
        try {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(item.arguments ?? "{}"); } catch {}
          const result = await runTool(cap, item.name, args, item.call_id);
          if (!isCurrent()) return;
          ledger.toolLog.push({ name: item.name, ok: result.ok, durationMs: result.durationMs });
          if (!isCurrent()) return;
          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result.body) },
          }));
          if (!isCurrent()) return;
          evt("tool.completed", {
            call: ledger.callId.slice(0, 8), name: item.name, ok: result.ok,
            ms: result.durationMs, response_active: ledger.responseActive === true,
          });
          ledger.continuationWanted = true;
        } finally {
          // The counter belongs to the current socket generation: activateOpenedSocket
          // resets it on reattach, so a stale call from a superseded socket must not
          // decrement the new generation's batch.
          if (isCurrent()) ledger.pendingToolCalls = Math.max(0, (ledger.pendingToolCalls ?? 1) - 1);
        }
        if (!isCurrent()) return;
        maybeContinueResponse(ledger, ws);
      }
      break;
    }
    case "response.done": {
      const usage = validatedProviderUsage(msg.response?.usage);
      if (usage) {
        ledger.usage.textIn += usage.textIn;
        ledger.usage.audioIn += usage.audioIn;
        ledger.usage.textInCached += usage.textInCached;
        ledger.usage.audioInCached += usage.audioInCached;
        ledger.usage.textOut += usage.textOut;
        ledger.usage.audioOut += usage.audioOut;
        ledger.providerUsageEvidence.eventCount += 1;
        ledger.providerUsageEvidence.lastResponseId = typeof msg.response?.id === "string" && msg.response.id.trim()
          ? msg.response.id
          : null;
        ledger.providerUsageEvidence.lastReceivedAt = new Date().toISOString();
      }
      // COST KILL-SWITCH: measured after every turn, because a long/rich session grows super-linearly.
      const spent = totalSessionCostUsd(ledger);
      const cap = sessionCostCapUsd(ledger.model);
      if (spent >= cap && ledger.status === "active") {
        ledger.status = "killed_budget";
        ledger.transcript.push({
          role: "system",
          text: `session ended: cost cap reached ($${spent.toFixed(2)} >= $${cap.toFixed(2)})`,
          at: new Date().toISOString(),
        });
        console.warn(`budget kill: call ${ledger.callId} spent $${spent.toFixed(2)} (cap $${cap.toFixed(2)})`);
        try { ws.close(); } catch {}
      }
      ledger.responseActive = false;
      maybeContinueResponse(ledger, ws);
      break;
    }
    case "session.ended": {
      const usage = validatedProviderUsage(msg.usage);
      if (usage) {
        ledger.usage = usage;
        ledger.providerUsageEvidence.terminal = true;
        ledger.providerUsageEvidence.lastReceivedAt = new Date().toISOString();
      }
      ledger.status = "ended";
      try { ws.close(); } catch {}
      break;
    }
    case "error": {
      ledger.transcript.push({ role: "system", text: `openai error: ${msg.error?.message ?? "?"}`, at: new Date().toISOString() });
      const code = typeof msg.error?.code === "string" ? msg.error.code : "";
      const message = typeof msg.error?.message === "string" ? msg.error.message : "";
      // A continuation that raced a still-streaming response is a coordination error, not a
      // session failure: keep the session, and re-request the turn once that response finishes.
      if (code === "conversation_already_has_active_response" || /already has an active response/i.test(message)) {
        ledger.responseActive = true;
        ledger.continuationWanted = true;
        console.warn(`sideband continuation deferred call=${ledger.callId.slice(0, 8)} (response still active)`);
        break;
      }
      ledger.status = "error";
      try { ws.close(); } catch {}
      break;
    }
  }
}

function validatedProviderUsage(value: unknown): UsageTotals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const input = usage.input_token_details;
  const output = usage.output_token_details;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !output || typeof output !== "object" || Array.isArray(output)) return null;
  const inputDetails = input as Record<string, unknown>;
  const outputDetails = output as Record<string, unknown>;
  const cached = inputDetails.cached_tokens_details;
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) return null;
  const cachedDetails = cached as Record<string, unknown>;

  const token = (candidate: unknown): number | null => (
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
  );
  const inputTokens = token(usage.input_tokens);
  const outputTokens = token(usage.output_tokens);
  const totalTokens = token(usage.total_tokens);
  const textIn = token(inputDetails.text_tokens);
  const audioIn = token(inputDetails.audio_tokens);
  const cachedTotal = token(inputDetails.cached_tokens);
  const textInCached = token(cachedDetails.text_tokens);
  const audioInCached = token(cachedDetails.audio_tokens);
  const textOut = token(outputDetails.text_tokens);
  const audioOut = token(outputDetails.audio_tokens);
  if ([inputTokens, outputTokens, totalTokens, textIn, audioIn, cachedTotal,
    textInCached, audioInCached, textOut, audioOut].some((part) => part === null)) return null;
  if (inputTokens !== textIn! + audioIn!
    || outputTokens !== textOut! + audioOut!
    || totalTokens !== inputTokens! + outputTokens!
    || cachedTotal !== textInCached! + audioInCached!
    || textInCached! > textIn!
    || audioInCached! > audioIn!) return null;
  return { textIn: textIn!, audioIn: audioIn!, textInCached: textInCached!, audioInCached: audioInCached!, textOut: textOut!, audioOut: audioOut! };
}

export async function persistLedger(
  cap: Capability,
  ledger: SessionLedger,
  fetchImpl?: FetchLike,
  phone?: { eventId: string; claimToken: string },
) {
  const durationS = Math.round((Date.now() - ledger.startedAt) / 1000);
  const usageResolved = ledger.providerUsageEvidence.continuous === true
    && ledger.providerUsageEvidence.terminal === true;
  const externalCostFloor = Number((ledger.externalCostUsd ?? 0).toFixed(8));
  const cost = usageResolved
    ? Number(totalSessionCostUsd(ledger).toFixed(8))
    : externalCostFloor > 0
      ? externalCostFloor
      : null;
  const s = supa();
  // "ended" normally means the provider already finished the call (session.ended /
  // caller hangup). An agent-initiated end is the exception: the status is "ended" but
  // the provider call is still live and must get the audited hangup.
  const providerTerminalObserved =
    ledger.providerTerminalEvidence?.observed === true;
  const providerNeedsTermination = !providerTerminalObserved &&
    (ledger.status !== "ended" || ledger.agentEnded === true);
  const terminationReason = ledger.agentEnded === true
    ? "agent_ended_session"
    : providerTerminalObserved
      ? ledger.providerTerminalEvidence!.reason
      : `sideband_${ledger.status}`;
  const outcome: BudgetOutcome = ledger.status === "ended"
    ? "ended"
    : ledger.status === "killed_deadline"
      ? "killed_deadline"
      : ledger.status === "killed_budget"
        ? "killed_budget"
        : "error";
  const providerUsageEvidence = usageResolved ? {
    source: providerTerminalObserved
      ? "session.ended.usage"
      : "response.done.usage",
    event_count: ledger.providerUsageEvidence.eventCount,
    last_response_id: ledger.providerUsageEvidence.lastResponseId,
    last_received_at: ledger.providerUsageEvidence.lastReceivedAt,
    continuous: true,
    terminal: true,
  } : null;

  if (phone) {
    const { data, error } = await s.rpc("finalize_phone_sideband", {
      p_event_id: phone.eventId,
      p_claim_token: phone.claimToken,
      p_terminal: {
        status: ledger.status,
        duration_seconds: durationS,
        transcript: ledger.transcript,
        usage_tokens: usageResolved ? ledger.usage : null,
        cost_estimate_usd: cost,
        provider_usage_state: usageResolved ? "resolved" : "unknown",
        provider_usage_evidence: providerUsageEvidence,
        outcome,
        detail: {
          tools: ledger.toolLog,
          model: ledger.model,
          external_cost_usd: ledger.externalCostUsd ?? 0,
        },
      },
    });
    if (error || !data) return false;
    const finalization = data as any;
    if (finalization.should_attempt === true) {
      const termination = await requestProviderTermination({
        openaiCallId: finalization.openai_call_id ? String(finalization.openai_call_id) : ledger.openaiCallId,
        mode: finalization.provider_termination_mode === "reject" ? "reject" : "hangup",
        requestId: String(finalization.request_id ?? ""),
        fetchImpl,
      });
      const { data: completed, error: completeError } = await s.rpc("complete_phone_termination", {
        p_event_id: phone.eventId,
        p_claim_token: phone.claimToken,
        p_confirmed: termination.confirmed,
        p_error: termination.error ?? null,
      });
      if (completeError || completed !== true) return false;
    }
    return true;
  }

  const terminalWrite = await s.from("calls").update({
    status: ledger.status,
    ended_at: new Date().toISOString(),
    duration_seconds: durationS,
    transcript: ledger.transcript,
    usage_tokens: usageResolved ? ledger.usage as any : null,
    cost_estimate_usd: cost,
    summary_status: "pending_ingest",
    ...(providerNeedsTermination
      ? {}
      : {
          provider_termination_state: "confirmed",
          provider_termination_mode: "hangup",
          provider_termination_reason: providerTerminalObserved
            ? terminationReason
            : "caller_hung_up",
        }),
    provider_usage_state: usageResolved ? "resolved" : "unknown",
    provider_usage_evidence: providerUsageEvidence,
  }).eq("id", cap.callId);
  if (terminalWrite.error) return false;
  if (ledger.budgetFinalized === true) return true;
  const finalized = await finalizeTerminalBudget({
    tenantId: cap.tenantId,
    callId: cap.callId,
    actualCostUsd: cost ?? 0,
    minutes: Number((durationS / 60).toFixed(2)),
    outcome,
    detail: {
      tools: ledger.toolLog,
      model: ledger.model,
      external_cost_usd: ledger.externalCostUsd ?? 0,
    },
    provider: providerNeedsTermination
      ? { openaiCallId: ledger.openaiCallId, mode: "hangup", reason: terminationReason }
      : undefined,
    fetchImpl,
    usageResolved,
  });
  if (finalized) ledger.budgetFinalized = true;
  return finalized;
}
