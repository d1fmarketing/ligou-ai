// ResponseCoordinator — the ONLY application authority that may create a model
// response or admit a tool execution. Every send site funnels through
// requestResponse; every function_call event funnels through admitToolCall.
// State lives on the session ledger (structural interface below) so it survives
// socket reattach and serializes with the call — the coordinator is pure logic.
//
// Legitimate reasons to create a response, per the orchestration contract:
//   1. greeting        — once per call, first browser attach only;
//   2. tool_continuation — exactly once per delivered tool-output batch;
//   3. recap_push      — bounded lifecycle push while a recap is owed.
// The provider's semantic VAD owns ordinary user turns; nothing else may speak.

export interface CoordinatedLedger {
  callId: string;
  status: string;
  responseActive?: boolean;
  continuationWanted?: boolean;
  pendingToolCalls?: number;
  agentEndRequested?: boolean;
  greetingRequested?: boolean;
  executedToolCallIds?: string[];
  phase?: string;
}

export type ResponseIntent = "greeting" | "tool_continuation" | "recap_push";

type WsLike = { send(payload: string): void };

const id8 = (ledger: CoordinatedLedger) => ledger.callId.slice(0, 8);

/** Structured lifecycle telemetry: one greppable line per event, no PII. */
export function evt(name: string, fields: Record<string, unknown>) {
  console.log(`voice_evt ${JSON.stringify({ evt: name, ...fields })}`);
}

export function setPhase(ledger: CoordinatedLedger, phase: string) {
  if (ledger.phase === phase) return;
  evt("onboarding.state.changed", { call: id8(ledger), from: ledger.phase ?? "connecting", to: phase });
  ledger.phase = phase;
}

/** Single gate for every application-created response. Sends exactly one
 *  response.create when the intent is eligible; refuses (with telemetry) when a
 *  response is active, tools are pending, the session is terminal, or the
 *  intent's idempotency key was already consumed. */
export function requestResponse(ledger: CoordinatedLedger, ws: WsLike, intent: ResponseIntent): boolean {
  // No live intent, no noise: a consumed/absent idempotency key is a silent no-op.
  if (intent === "greeting" && ledger.greetingRequested) return false;
  if (intent === "tool_continuation" && !ledger.continuationWanted) return false;
  if (ledger.status !== "active" || ledger.agentEndRequested) return false;
  if (ledger.responseActive) {
    evt("response.denied", { call: id8(ledger), intent, reason: "response_active" });
    return false;
  }
  if ((ledger.pendingToolCalls ?? 0) > 0) {
    evt("response.denied", { call: id8(ledger), intent, reason: "tools_pending" });
    return false;
  }
  if (intent === "greeting") ledger.greetingRequested = true;
  else if (intent === "tool_continuation") ledger.continuationWanted = false;
  try {
    ws.send(JSON.stringify({ type: "response.create" }));
  } catch {
    // Nothing left the socket: put the idempotency key back so a reattach can
    // legitimately retry the owed turn.
    if (intent === "greeting") ledger.greetingRequested = false;
    if (intent === "tool_continuation") ledger.continuationWanted = true;
    return false;
  }
  ledger.responseActive = true;
  evt("response.requested", { call: id8(ledger), intent });
  return true;
}

/** Exactly-once tool admission per provider call_id: a duplicated or replayed
 *  response.output_item.done must not re-run persistence, re-send an output or
 *  earn a second continuation. */
export function admitToolCall(ledger: CoordinatedLedger, toolCallId: unknown): boolean {
  const key = typeof toolCallId === "string" && toolCallId ? toolCallId : null;
  if (!key) return true; // unkeyed items cannot be deduped; the provider contract sends one
  const seen = ledger.executedToolCallIds ?? (ledger.executedToolCallIds = []);
  if (seen.includes(key)) {
    evt("invariant.violation", { call: id8(ledger), kind: "duplicate_tool_event", tool_call: key });
    return false;
  }
  seen.push(key);
  if (seen.length > 500) seen.shift();
  return true;
}
