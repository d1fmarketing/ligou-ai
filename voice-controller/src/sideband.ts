// Authoritative sideband: the controller owns tools, transcripts, usage, deadline and finalization.
// The browser only carries audio; it never executes tools and never holds credentials beyond its own mic.
import { config, emptyUsage, sessionCostUsd, type UsageTotals } from "./config.ts";
import { runTool, type Capability } from "./tools.ts";
import { supa } from "./rules.ts";
import { finalizeTerminalBudget, type BudgetOutcome } from "./budget.ts";
import { requestProviderTermination, type FetchLike, type ProviderTerminationMode } from "./provider-termination.ts";
import { admitToolCall, evt, requestResponse, setPhase } from "./response-coordinator.ts";

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
  transcript: Array<{ role: "caller" | "agent" | "system"; text: string; at: string }>;
  toolLog: Array<{ name: string; ok: boolean; durationMs: number }>;
  status: "active" | "ended" | "killed_deadline" | "killed_budget" | "error";
  /** True while OpenAI is streaming a response; `response.create` is illegal in that window. */
  responseActive?: boolean;
  /** A tool output was delivered and the model still owes the conversation its next turn. */
  continuationWanted?: boolean;
  /** Function calls still executing from the current batch; the continuation waits for all outputs. */
  pendingToolCalls?: number;
  /** Rules were recorded and the owner has not heard a substantive spoken recap since:
   *  end_session is refused until enough agent speech follows the last registration. */
  pendingRecapAfterRecords?: boolean;
  /** The response that carried the last registration: its own audio (the "vou registrar"
   *  ack) must not count as the recap. */
  recapBlockedResponseId?: string;
  /** Agent speech accumulated after the last registration, in characters — within ONE
   *  response only (short utterances across turns must never sum into a fake recap).
   *  Test 4 proved a 66-char promise can precede a bare end_session. */
  postRecordSpeechChars?: number;
  /** The response currently being credited; switching responses resets the credit. */
  recapCreditResponseId?: string;
  /** How many times end_session was refused for a missing recap. The guard is
   *  best-effort: a broken transcription pipeline must not hold the call hostage. */
  recapRefusals?: number;
  /** The initial agent-speaks-first greeting was requested (once per call, ever). */
  greetingRequested?: boolean;
  /** Provider tool call_ids already executed — the coordinator's exactly-once dedup. */
  executedToolCallIds?: string[];
  /** Coarse lifecycle phase for telemetry (greeting/collecting/summarizing/closing/closed). */
  phase?: string;
  /** Bounded pushes that force the promised recap when the model stalls on
   *  meta-announcements ("vou recapitular") instead of speaking it (E2E test 6). */
  recapPushes?: number;
  recapPushTimer?: ReturnType<typeof setTimeout> | null;
  /** The model called end_session: close gracefully after its farewell response finishes. */
  agentEndRequested?: boolean;
  /** The graceful close is already scheduled for the current socket generation. */
  agentEndScheduled?: boolean;
  /** The session was ended by the agent, so the provider call is still live and needs the audited hangup. */
  agentEnded?: boolean;
}

/** Plan v4 §8: reserving quota only gates FUTURE sessions — a live session that runs up the bill must be cut.
 *  Returns the ceiling in USD for one session (reservation-based, overridable per deploy). */
export function sessionCostCapUsd(_model: string): number {
  return config.sessionCostCeilingUsd;
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
  fetchImpl?: FetchLike;
}

export function terminalStatusForReason(
  current: SessionLedger["status"],
  reason: string,
): SessionLedger["status"] {
  if (current !== "active") return current;
  return reason === "caller_hung_up" ? "ended" : "error";
}

export function attachSideband(
  cap: Capability,
  openaiCallId: string,
  model: string,
  options: SidebandOptions = {},
): SidebandControl {
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
    setPhase(ledger, "closed");
    ledger.status = terminalStatusForReason(ledger.status, reason);
    let persisted = false;
    try {
      persisted = await persistLedger(cap, ledger, options.fetchImpl, options.phone);
    } catch (error) {
      console.error("persist failed", error);
    }
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
            turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
          },
        },
      },
    }));
    if (!ownsSocket(sock)) return;
    // A fresh socket has no knowledge of a response that was streaming when the previous
    // one dropped, and OpenAI does not replay missed events: a stale `responseActive`
    // would wedge the continuation forever. Clear the streaming flags and re-request any
    // turn the model still owes; an over-eager create is absorbed by the recoverable
    // `conversation_already_has_active_response` path.
    ledger.responseActive = false;
    ledger.pendingToolCalls = 0;
    ledger.agentEndScheduled = false;
    if (ledger.recapPushTimer) { clearTimeout(ledger.recapPushTimer); ledger.recapPushTimer = null; }
    maybeContinueResponse(ledger, sock);
    maybeScheduleAgentEnd(ledger, sock, () => ownsSocket(sock));
    if (!ownsSocket(sock)) return;
    if (!options.phone && requestResponse(ledger, sock, "greeting")) {
      // The agent speaks first. Without an initial response.create the realtime session
      // sits in silence until the caller says something (E2E test 6, P0): the browser
      // owner would answer a "connected" call and hear nothing.
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

/** The persisted snapshot of THIS call's registered suggestions: the deterministic
 *  source for the spoken final summary (never the model's memory of the transcript).
 *  Sanitized: category + operational text + structured values only. */
async function fetchCallSnapshot(cap: Capability): Promise<Array<Record<string, unknown>> | null> {
  // Best-effort grounding: a slow or unavailable read must never stall the voice
  // lifecycle, so the query races a short deadline and failure degrades to null.
  try {
    const query = (async () => {
      const { data, error } = await supa()
        .from("rules")
        .select("category,text,structured")
        .eq("related_call_id", cap.callId)
        .eq("status", "sugerido");
      if (error || !Array.isArray(data) || data.length === 0) return null;
      return data as Array<Record<string, unknown>>;
    })();
    const deadline = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), 1_500);
      (t as any).unref?.();
    });
    return await Promise.race([query, deadline]);
  } catch {
    return null;
  }
}

function snapshotMessage(rows: Array<Record<string, unknown>>): string {
  const lines = rows.map((r) =>
    `- [${r.category}] ${String(r.text ?? "").slice(0, 200)}${r.structured ? " " + JSON.stringify(r.structured) : ""}`);
  return `DADOS REGISTRADOS NESTA ENTREVISTA (fonte oficial — fale o resumo a partir DESTES dados, não da sua memória):\n${lines.join("\n")}`;
}

/** Agent speech counts toward the recap only when it is substantive and belongs to a
 *  response AFTER the one that carried the last registration — the pre-registration ack
 *  and short promises ("vou recapitular…") never clear the gate. */
function creditRecapSpeech(ledger: SessionLedger, responseId: unknown, text: string) {
  if (!ledger.pendingRecapAfterRecords) return;
  const rid = typeof responseId === "string" ? responseId : "unknown";
  if (rid === (ledger.recapBlockedResponseId ?? "unknown")) return;
  const raw = Number(process.env.LIGOU_RECAP_MIN_CHARS ?? 200);
  const threshold = Number.isFinite(raw) && raw > 0 ? raw : 200;
  // The credit is per response: a chain of short turns must never sum into a fake recap.
  if (ledger.recapCreditResponseId !== rid) {
    ledger.recapCreditResponseId = rid;
    ledger.postRecordSpeechChars = 0;
  }
  ledger.postRecordSpeechChars = (ledger.postRecordSpeechChars ?? 0) + text.length;
  if (ledger.postRecordSpeechChars >= threshold) ledger.pendingRecapAfterRecords = false;
}

/** Reattach-safe twin of maybeContinueResponse: once end_session was honored and the
 *  farewell response is no longer streaming (and no tool of its batch is pending),
 *  schedule the graceful close exactly once per socket generation. */
function maybeScheduleAgentEnd(ledger: SessionLedger, ws: WebSocket, isCurrent: () => boolean = () => true) {
  if (!ledger.agentEndRequested || ledger.agentEndScheduled) return;
  if (ledger.status !== "active" || ledger.responseActive) return;
  if ((ledger.pendingToolCalls ?? 0) > 0) return;
  ledger.agentEndScheduled = true;
  const raw = Number(process.env.LIGOU_AGENT_END_GRACE_MS ?? 5_000);
  const grace = Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
  setTimeout(() => {
    if (ledger.status !== "active" || !isCurrent()) return;
    ledger.status = "ended";
    ledger.agentEnded = true;
    ledger.transcript.push({ role: "system", text: "session ended: interview completed by agent (end_session)", at: new Date().toISOString() });
    setPhase(ledger, "closing");
    evt("closing.started", { call: ledger.callId.slice(0, 8), reason: "end_session_honored" });
    try { ws.close(); } catch {}
  }, grace);
}

export async function handleEvent(
  cap: Capability,
  ledger: SessionLedger,
  ws: WebSocket,
  msg: any,
  isCurrent: () => boolean = () => true,
) {
  if (!isCurrent()) return;
  switch (msg.type) {
    case "response.created":
      ledger.responseActive = true;
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (msg.transcript) ledger.transcript.push({ role: "caller", text: msg.transcript, at: new Date().toISOString() });
      break;
    case "input_audio_buffer.speech_started":
      // The owner is talking: an owed-recap push must not talk over them.
      if (ledger.recapPushTimer) { clearTimeout(ledger.recapPushTimer); ledger.recapPushTimer = null; }
      break;
    case "response.output_audio_transcript.done":
      if (msg.transcript) {
        ledger.transcript.push({ role: "agent", text: msg.transcript, at: new Date().toISOString() });
        creditRecapSpeech(ledger, msg.response_id, msg.transcript);
      }
      break;
    case "response.output_text.done":
      // A text-modality turn also counts as the agent addressing the owner.
      if (msg.text) creditRecapSpeech(ledger, msg.response_id, String(msg.text));
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
          let result = await runTool(cap, item.name, args);
          if (!isCurrent()) return;
          // Test-3 defect (call e9d10384): after registering the final rules the model called
          // end_session in its next response without ever speaking the promised recap, and the
          // call hung up in silence. State-machine invariant: registering and hanging up must
          // have a spoken agent turn between them.
          if (item.name === "end_session" && result.ok && ledger.pendingRecapAfterRecords
            && (ledger.recapRefusals ?? 0) < 2) {
            ledger.recapRefusals = (ledger.recapRefusals ?? 0) + 1;
            // Ground the demanded summary in the persisted snapshot, not transcript memory.
            const snapshotRows = await fetchCallSnapshot(cap);
            if (!isCurrent()) return;
            result = {
              ok: false,
              body: {
                error: "recap_required",
                message: "O dono ainda não ouviu o resumo depois dos últimos registros. Fale AGORA, em voz alta, o resumo completo do que registrou (todos os serviços com preços, mínimos e durações, cidades, horários, emergências e regras), oriente a aprovação na aba Memória, despeça-se e só então chame end_session de novo.",
                ...(snapshotRows ? { registered_rules: snapshotRows } : {}),
              },
              durationMs: result.durationMs,
            };
            evt("close.refused", { call: ledger.callId.slice(0, 8), reason: "recap_required", refusals: ledger.recapRefusals });
          }
          if (item.name === "record_interview_answer" && result.ok) {
            ledger.pendingRecapAfterRecords = true;
            ledger.recapBlockedResponseId = typeof msg.response_id === "string" ? msg.response_id : "unknown";
            ledger.postRecordSpeechChars = 0;
          }
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
          if (item.name === "end_session" && result.ok) {
            // The farewell is the last turn: no continuation, close after the response finishes.
            ledger.agentEndRequested = true;
          } else {
            ledger.continuationWanted = true;
          }
        } finally {
          // The counter belongs to the current socket generation: activateOpenedSocket
          // resets it on reattach, so a stale call from a superseded socket must not
          // decrement the new generation's batch.
          if (isCurrent()) ledger.pendingToolCalls = Math.max(0, (ledger.pendingToolCalls ?? 1) - 1);
        }
        if (!isCurrent()) return;
        maybeContinueResponse(ledger, ws);
        maybeScheduleAgentEnd(ledger, ws, isCurrent);
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
      const spent = sessionCostUsd(ledger.model, ledger.usage);
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
      maybeScheduleAgentEnd(ledger, ws, isCurrent);
      // E2E test 6: after the final registrations the model produced promise-turns
      // ("vou recapitular…") and then waited for the owner, so the recap never came.
      // While a recap is owed, an idle turn gets a bounded push; a real user utterance
      // (speech_started) cancels the pending push so a clarification can be answered.
      if (
        ledger.pendingRecapAfterRecords
        && ledger.status === "active"
        && !ledger.agentEndRequested
        && !ledger.continuationWanted
        && !ledger.responseActive
        && (ledger.pendingToolCalls ?? 0) === 0
        && (ledger.recapPushes ?? 0) < 3
      ) {
        const rawDelay = Number(process.env.LIGOU_RECAP_PUSH_DELAY_MS ?? 1_200);
        const delay = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1_200;
        if (ledger.recapPushTimer) clearTimeout(ledger.recapPushTimer);
        // The bound counts SCHEDULED attempts, not successful fires: otherwise a caller
        // whose brief remarks keep cancelling pushes would let this loop forever
        // (review finding on 79b1169).
        ledger.recapPushes = (ledger.recapPushes ?? 0) + 1;
        ledger.recapPushTimer = setTimeout(() => {
          ledger.recapPushTimer = null;
          void (async () => {
            const eligible = () => isCurrent() && ledger.status === "active" && ledger.pendingRecapAfterRecords === true
              && !ledger.responseActive && (ledger.pendingToolCalls ?? 0) === 0 && !ledger.agentEndRequested;
            if (!eligible()) return;
            // Deterministic summary: inject the persisted snapshot so the forced turn
            // reads from the database, then request the response via the coordinator.
            const snapshotRows = await fetchCallSnapshot(cap);
            if (!eligible()) return;
            try {
              if (snapshotRows) {
                ws.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: { type: "message", role: "system", content: [{ type: "input_text", text: snapshotMessage(snapshotRows) }] },
                }));
              }
            } catch { return; }
            evt("summary.requested", { call: ledger.callId.slice(0, 8), push: ledger.recapPushes, snapshot: snapshotRows?.length ?? 0 });
            setPhase(ledger, "summarizing");
            requestResponse(ledger, ws, "recap_push");
          })();
        }, delay);
      }
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
  const cost = usageResolved ? Number(sessionCostUsd(ledger.model, ledger.usage).toFixed(4)) : null;
  const s = supa();
  // "ended" normally means the provider already finished the call (session.ended /
  // caller hangup). An agent-initiated end is the exception: the status is "ended" but
  // the provider call is still live and must get the audited hangup.
  const providerNeedsTermination = ledger.status !== "ended" || ledger.agentEnded === true;
  const terminationReason = ledger.agentEnded === true ? "agent_ended_session" : `sideband_${ledger.status}`;
  const outcome: BudgetOutcome = ledger.status === "ended"
    ? "ended"
    : ledger.status === "killed_deadline"
      ? "killed_deadline"
      : ledger.status === "killed_budget"
        ? "killed_budget"
        : "error";
  const providerUsageEvidence = usageResolved ? {
    source: "response.done.usage",
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
        detail: { tools: ledger.toolLog, model: ledger.model },
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
    provider_termination_state: providerNeedsTermination ? "active" : "confirmed",
    provider_termination_mode: "hangup",
    provider_termination_reason: providerNeedsTermination ? terminationReason : "caller_hung_up",
    provider_usage_state: usageResolved ? "resolved" : "unknown",
    provider_usage_evidence: providerUsageEvidence,
  }).eq("id", cap.callId);
  if (terminalWrite.error) return false;
  return await finalizeTerminalBudget({
    tenantId: cap.tenantId,
    callId: cap.callId,
    actualCostUsd: cost ?? 0,
    minutes: Number((durationS / 60).toFixed(2)),
    outcome,
    detail: { tools: ledger.toolLog, model: ledger.model },
    provider: providerNeedsTermination
      ? { openaiCallId: ledger.openaiCallId, mode: "hangup", reason: terminationReason }
      : undefined,
    fetchImpl,
    usageResolved,
  });
}
