// Authoritative sideband: the controller owns tools, transcripts, usage, deadline and finalization.
// The browser only carries audio; it never executes tools and never holds credentials beyond its own mic.
import { config, emptyUsage, sessionCostUsd, type UsageTotals } from "./config.ts";
import { runTool, type Capability } from "./tools.ts";
import { supa } from "./rules.ts";
import { finalizeTerminalBudget, type BudgetOutcome } from "./budget.ts";
import type { FetchLike } from "./provider-termination.ts";

export interface SessionLedger {
  callId: string;
  openaiCallId: string;
  model: string;
  startedAt: number;
  usage: UsageTotals;
  transcript: Array<{ role: "caller" | "agent" | "system"; text: string; at: string }>;
  toolLog: Array<{ name: string; ok: boolean; durationMs: number }>;
  status: "active" | "ended" | "killed_deadline" | "killed_budget" | "error";
}

/** Plan v4 §8: reserving quota only gates FUTURE sessions — a live session that runs up the bill must be cut.
 *  Returns the ceiling in USD for one session (reservation-based, overridable per deploy). */
export function sessionCostCapUsd(model: string): number {
  const explicit = Number(process.env.SESSION_COST_CAP_USD ?? 0);
  if (explicit > 0) return explicit;
  return model === "gpt-realtime-2.1-mini" ? 0.5 : 1.5;
}

const live = new Map<string, SessionLedger>();
export const liveSessions = live;

export function terminalStatusForReason(
  current: SessionLedger["status"],
  reason: string,
): SessionLedger["status"] {
  if (current !== "active") return current;
  return reason === "caller_hung_up" ? "ended" : "error";
}

export function attachSideband(cap: Capability, openaiCallId: string, model: string): SessionLedger {
  const ledger: SessionLedger = {
    callId: cap.callId,
    openaiCallId,
    model,
    startedAt: Date.now(),
    usage: emptyUsage(),
    transcript: [],
    toolLog: [],
    status: "active",
  };
  live.set(cap.callId, ledger);

  // Root-cause discipline (2026-08-19 incident): a WS close is NOT the end of the call — the WebRTC leg
  // lives independently. We finalize only on terminal states (deadline/budget kill, or retries exhausted);
  // any other close triggers a reattach, because the call may still be in progress with live tools.
  const MAX_ATTACHES = 6;
  let attaches = 0;
  let everOpened = false;
  let terminal = false;
  let ws: WebSocket | null = null;

  const finalize = async (reason: string) => {
    if (!live.has(cap.callId)) return; // already finalized
    console.log(`sideband finalize call=${cap.callId.slice(0, 8)} reason=${reason} status=${ledger.status} tools=${ledger.toolLog.length}`);
    ledger.status = terminalStatusForReason(ledger.status, reason);
    live.delete(cap.callId);
    await persistLedger(cap, ledger).catch((e) => console.error("persist failed", e));
  };

  const deadlineMs = cap.expiresAt - Date.now();
  const deadline = setTimeout(() => {
    terminal = true;
    ledger.status = "killed_deadline";
    ledger.transcript.push({ role: "system", text: "session ended: max duration reached", at: new Date().toISOString() });
    try { ws?.close(); } catch {}
    void finalize("deadline");
  }, Math.max(deadlineMs, 5_000));

  const connect = () => {
    attaches += 1;
    const attempt = attaches;
    let openedThisAttempt = false;
    const sock = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(openaiCallId)}`, {
      // Bun extension: custom headers on client WebSocket
      headers: { Authorization: `Bearer ${config.openaiKey}` },
    } as any);
    ws = sock;

    sock.addEventListener("open", () => {
      openedThisAttempt = true;
      everOpened = true;
      console.log(`sideband OPEN call=${cap.callId.slice(0, 8)} rtc=${openaiCallId} attempt=${attempt}`);
      sock.send(JSON.stringify({
        type: "session.update",
        session: { type: "realtime", audio: { input: { transcription: { model: "gpt-live-transcribe" } } } },
      }));
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
      console.log(`sideband CLOSE call=${cap.callId.slice(0, 8)} code=${ev?.code} attempt=${attempt} opened=${openedThisAttempt} terminal=${terminal}`);
      if (terminal || ledger.status !== "active") { clearTimeout(deadline); void finalize("terminal_close"); return; }
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
      setTimeout(() => { if (!terminal && live.has(cap.callId)) connect(); }, delay);
    });
    sock.addEventListener("error", () => { /* close follows */ });
  };

  connect();
  return ledger;
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
      const u = msg.response?.usage;
      if (u) {
        const inDet = u.input_token_details ?? {};
        const cached = inDet.cached_tokens_details ?? {};
        ledger.usage.textIn += inDet.text_tokens ?? 0;
        ledger.usage.audioIn += inDet.audio_tokens ?? 0;
        ledger.usage.textInCached += cached.text_tokens ?? 0;
        ledger.usage.audioInCached += cached.audio_tokens ?? 0;
        const outDet = u.output_token_details ?? {};
        ledger.usage.textOut += outDet.text_tokens ?? 0;
        ledger.usage.audioOut += outDet.audio_tokens ?? 0;
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
    case "error":
      ledger.transcript.push({ role: "system", text: `openai error: ${msg.error?.message ?? "?"}`, at: new Date().toISOString() });
      ledger.status = "error";
      try { ws.close(); } catch {}
      break;
  }
}

export async function persistLedger(cap: Capability, ledger: SessionLedger, fetchImpl?: FetchLike) {
  const durationS = Math.round((Date.now() - ledger.startedAt) / 1000);
  const cost = sessionCostUsd(ledger.model, ledger.usage);
  const s = supa();
  const providerNeedsTermination = ledger.status !== "ended";
  const terminalWrite = await s.from("calls").update({
    status: ledger.status,
    ended_at: new Date().toISOString(),
    duration_seconds: durationS,
    transcript: ledger.transcript,
    usage_tokens: ledger.usage as any,
    cost_estimate_usd: Number(cost.toFixed(4)),
    summary_status: "pending_ingest",
    provider_termination_state: providerNeedsTermination ? "active" : "confirmed",
    provider_termination_mode: "hangup",
    provider_termination_reason: providerNeedsTermination ? `sideband_${ledger.status}` : "caller_hung_up",
    provider_usage_state: "resolved",
  }).eq("id", cap.callId);
  if (terminalWrite.error) return false;
  const outcome: BudgetOutcome = ledger.status === "ended"
    ? "ended"
    : ledger.status === "killed_deadline"
      ? "killed_deadline"
      : ledger.status === "killed_budget"
        ? "killed_budget"
        : "error";
  return await finalizeTerminalBudget({
    tenantId: cap.tenantId,
    callId: cap.callId,
    actualCostUsd: Number(cost.toFixed(4)),
    minutes: Number((durationS / 60).toFixed(2)),
    outcome,
    detail: { tools: ledger.toolLog, model: ledger.model },
    provider: providerNeedsTermination
      ? { openaiCallId: ledger.openaiCallId, mode: "hangup", reason: `sideband_${ledger.status}` }
      : undefined,
    fetchImpl,
    usageResolved: true,
  });
}
