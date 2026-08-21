// Authoritative sideband: the controller owns tools, transcripts, usage, deadline and finalization.
// The browser only carries audio; it never executes tools and never holds credentials beyond its own mic.
import { config, emptyUsage, sessionCostUsd, type UsageTotals } from "./config.ts";
import { runTool, type Capability } from "./tools.ts";
import { supa } from "./rules.ts";
import { finalizeTerminalBudget, type BudgetOutcome } from "./budget.ts";
import { requestProviderTermination, type FetchLike, type ProviderTerminationMode } from "./provider-termination.ts";

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
    clearRuntimeTimers();
    live.delete(cap.callId);
    if (!openedSettled) {
      openedSettled = true;
      rejectOpened(new Error("phone_sideband_cancelled"));
    }
    const socket = ws;
    ws = null;
    try { socket?.close(); } catch {}
  };

  const finalize = async (reason: string) => {
    if (cancelled || finalizing || !live.has(cap.callId)) return;
    finalizing = true;
    terminal = true;
    clearRuntimeTimers();
    if (!openedSettled) {
      openedSettled = true;
      rejectOpened(new Error("phone_sideband_closed_before_open"));
    }
    const socket = ws;
    ws = null;
    try { socket?.close(); } catch {}
    console.log(`sideband finalize call=${cap.callId.slice(0, 8)} reason=${reason} status=${ledger.status} tools=${ledger.toolLog.length}`);
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
    live.delete(cap.callId);
  };

  const startHeartbeat = () => {
    if (!options.phone || heartbeat || cancelled) return;
    heartbeat = setInterval(() => {
      if (heartbeatInFlight || cancelled || finalizing) return;
      heartbeatInFlight = true;
      void (async () => {
        try {
          const { data, error } = await supa().rpc("heartbeat_phone_sideband", {
            p_event_id: options.phone!.eventId,
            p_claim_token: options.phone!.claimToken,
          });
          if (!error && data === true) return;
          ledger.status = "error";
          ledger.transcript.push({ role: "system", text: "sideband heartbeat failed", at: new Date().toISOString() });
          await finalize("sideband_heartbeat_failed");
        } catch {
          await finalize("sideband_heartbeat_failed");
        } finally {
          heartbeatInFlight = false;
        }
      })();
    }, 5_000);
  };

  const activateOpenedSocket = async (sock: WebSocket) => {
    if (cancelled) return;
    if (options.phone && !phoneActive) {
      const { data, error } = await supa().rpc("confirm_phone_sideband", {
        p_event_id: options.phone.eventId,
        p_claim_token: options.phone.claimToken,
      });
      if (error || data !== true) {
        if (!openedSettled) {
          openedSettled = true;
          rejectOpened(Object.assign(new Error("phone_sideband_activation_failed"), { detail: error?.message }));
        }
        cancel("phone_sideband_activation_failed");
        return;
      }
      phoneActive = true;
      startHeartbeat();
    }
    sock.send(JSON.stringify({
      type: "session.update",
      session: { type: "realtime", audio: { input: { transcription: { model: "gpt-live-transcribe" } } } },
    }));
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
      if (cancelled) return;
      openedThisAttempt = true;
      everOpened = true;
      console.log(`sideband OPEN call=${cap.callId.slice(0, 8)} rtc=${openaiCallId} attempt=${attempt}`);
      void activateOpenedSocket(sock).catch((error) => {
        ledger.status = "error";
        ledger.transcript.push({ role: "system", text: `sideband setup failed: ${String(error)}`, at: new Date().toISOString() });
        void finalize("sideband_session_update_failed");
      });
    });

    sock.addEventListener("message", (ev) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      void handleEvent(cap, ledger, sock, msg).then(() => {
        if (ledger.status !== "active" && live.has(cap.callId)) {
          terminal = true;
          clearTimeout(deadline);
          void finalize(ledger.status === "error" ? "openai_error" : "terminal_event");
        }
      });
    });

    sock.addEventListener("close", (ev: any) => {
      if (cancelled) return;
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
        if (!terminal && !cancelled && live.has(cap.callId)) {
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

export async function handleEvent(cap: Capability, ledger: SessionLedger, ws: WebSocket, msg: any) {
  switch (msg.type) {
    case "conversation.item.input_audio_transcription.completed":
      if (msg.transcript) ledger.transcript.push({ role: "caller", text: msg.transcript, at: new Date().toISOString() });
      break;
    case "response.output_audio_transcript.done":
      if (msg.transcript) ledger.transcript.push({ role: "agent", text: msg.transcript, at: new Date().toISOString() });
      break;
    case "response.output_item.done": {
      const item = msg.item;
      if (item?.type === "function_call") {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(item.arguments ?? "{}"); } catch {}
        const result = await runTool(cap, item.name, args);
        ledger.toolLog.push({ name: item.name, ok: result.ok, durationMs: result.durationMs });
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result.body) },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
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
    case "error":
      ledger.transcript.push({ role: "system", text: `openai error: ${msg.error?.message ?? "?"}`, at: new Date().toISOString() });
      ledger.status = "error";
      try { ws.close(); } catch {}
      break;
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
  const providerNeedsTermination = ledger.status !== "ended";
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
    provider_termination_reason: providerNeedsTermination ? `sideband_${ledger.status}` : "caller_hung_up",
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
      ? { openaiCallId: ledger.openaiCallId, mode: "hangup", reason: `sideband_${ledger.status}` }
      : undefined,
    fetchImpl,
    usageResolved,
  });
}
