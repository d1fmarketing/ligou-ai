// Outbound-only browser session servicing: the public Edge Function enqueues browser_session_requests;
// this listener (Realtime + poll, zero inbound ports) claims each row race-safely and runs the SAME
// canonical startSession used by the local HTTP path — one implementation, two transports.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { supa } from "./rules.ts";
import type { SessionType } from "./instructions.ts";
import { liveSessions } from "./sideband.ts";
import { managedLiveSessions, recoverManagedLiveCancellation } from "./onboarding-live-runtime.ts";
import { finalizeTerminalBudget } from "./budget.ts";
import type { FetchLike } from "./provider-termination.ts";
import { randomUUID } from "node:crypto";
import type {
  OnboardingOpeningMode,
  OnboardingOpeningPayload,
} from "./onboarding-greeting.ts";
import { createVoiceStartupTrace, type WebsiteOpeningEnvelope } from "./server.ts";
import { isApplicationOpeningPayload, isStreamOpeningPayload, isNativeOpeningPayload, isLiveOpeningPayload } from "../../supabase/functions/browser-session/core.ts";

type StartSession = (
  userId: string,
  sessionType: SessionType,
  sdpOffer: string,
  modelOverride?: string,
  tenantId?: string,
  registerCleanup?: (cleanup: {
    callId: string;
    startupComplete: boolean;
    cancel(reason: string): Promise<void>;
  }) => void,
  options?: {
    browserRequestId?: string;
    openingModeRequested?: OnboardingOpeningMode;
    requestedCallId?: string;
    onboardingProtocolVersion?: 2 | 3 | 4 | 5 | 6;
  },
) => Promise<{
  sdp: string;
  call_id: string;
  opening_mode_applied?: OnboardingOpeningMode;
  opening_payload?: OnboardingOpeningPayload | WebsiteOpeningEnvelope | null;
}>;

interface BrowserLiveControl {
  requestId: string;
  callId: string;
  userId: string;
  tenantId: string;
  sessionType: "onboarding";
  openingModeRequested: "application_tts_v1" | "realtime_stream_v1" | "realtime_native_v1" | "live_managed_v1";
  onboardingProtocolVersion: number | null;
  cancel(reason: string): Promise<void>;
  startupComplete(): boolean;
  cancelInvoked: boolean;
  cleanupResolved: boolean;
  cleanupWork?: Promise<boolean>;
}

async function invokeControlCleanupOnce(
  control: BrowserLiveControl,
  reason: string,
): Promise<boolean> {
  if (!control.cleanupWork && !control.cancelInvoked) {
    control.cancelInvoked = true;
    control.cleanupWork = (async () => {
      try {
        await control.cancel(reason);
        control.cleanupResolved = true;
        return true;
      } catch {
        return false;
      }
    })();
  }
  if (control.cleanupWork) return await control.cleanupWork;
  return control.cleanupResolved;
}

const MAX_BROWSER_LIVE_CONTROLS = 512;
const browserLiveControls = new Map<string, BrowserLiveControl>();
const cancellationWork = new Map<string, Promise<boolean>>();

function pruneTerminalBrowserControls(): void {
  for (const [requestId, control] of browserLiveControls)
    if (!control.cancelInvoked && control.startupComplete() &&
      !liveSessions.has(control.callId) && !managedLiveSessions.has(control.callId))
      browserLiveControls.delete(requestId);
}

function registerBrowserLiveControl(
  requestId: string,
  cleanup: {
    callId: string;
    startupComplete: boolean;
    cancel(reason: string): Promise<void>;
  },
  binding: {
    userId: string;
    tenantId: string;
    sessionType: "onboarding";
    openingModeRequested: "application_tts_v1" | "realtime_stream_v1" | "realtime_native_v1" | "live_managed_v1";
    onboardingProtocolVersion: number | null;
  },
): boolean {
  if (!requestId.trim() || !cleanup.callId?.trim() || !binding.userId.trim() ||
    !binding.tenantId.trim() ||
    !(binding.openingModeRequested==="live_managed_v1" ? binding.onboardingProtocolVersion===6
      : binding.openingModeRequested==="realtime_native_v1" ? binding.onboardingProtocolVersion===5
      : binding.openingModeRequested==="realtime_stream_v1" ? binding.onboardingProtocolVersion===4
      : [null, 2, 3].includes(binding.onboardingProtocolVersion))) return false;
  pruneTerminalBrowserControls();
  const existing = browserLiveControls.get(requestId);
  if (existing)
    return existing.callId === cleanup.callId && existing.cancel === cleanup.cancel;
  if (browserLiveControls.size >= MAX_BROWSER_LIVE_CONTROLS) return false;
  browserLiveControls.set(requestId, {
    requestId,
    callId: cleanup.callId,
    ...binding,
    cancel: cleanup.cancel,
    startupComplete: () => cleanup.startupComplete === true,
    cancelInvoked: false,
    cleanupResolved: false,
  });
  return true;
}

function unregisterBrowserLiveControl(requestId: string, callId?: string): void {
  const existing = browserLiveControls.get(requestId);
  if (existing && (!callId || existing.callId === callId))
    browserLiveControls.delete(requestId);
}

interface CancellationPollDependencies {
  loadRows?: () => Promise<any[]>;
  handleRow?: (row: any) => Promise<boolean>;
}

interface PendingPollDependencies {
  loadRows?: () => Promise<any[]>;
  handleRow?: (row: any, startSession: StartSession) => Promise<void>;
}

interface BrowserRequestHandleDependencies {
  callIdFactory?: () => string;
  dispatchSource?: "realtime" | "poll";
  queueObserver?: ReturnType<typeof createBrowserQueueObserver>;
}

/** Readiness and dispatch evidence only. Callback payloads may contain private
 * transport details; copy only fixed states and validated request identities. */
export function createBrowserQueueObserver(
  write:(event:Record<string,unknown>)=>void=event=>console.log(JSON.stringify(event)),
  monotonic:()=>number=()=>performance.now(),
) {
  const now=()=>{try{const value=monotonic();return Number.isFinite(value)?value:null;}catch{return null;}};
  const began=now();let lastSubscription:string|undefined;
  const emit=(event:Record<string,unknown>)=>{
    const at=now();
    try{write({...event,...(at!==null&&began!==null?{elapsedMs:Math.max(0,at-began)}:{})});}catch{ /* Logging cannot affect queue ownership. */ }
  };
  return {
    subscription(state:unknown){
      if(typeof state!=="string" || !["SUBSCRIBED","CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(state) || state===lastSubscription)return;
      lastSubscription=state;emit({event:"browser.queue.subscription",state});
    },
    replication(payload:{extension?:unknown;status?:unknown}){
      if(payload?.extension!=="postgres_changes" || !["ok","error"].includes(String(payload?.status)))return;
      emit({event:"browser.queue.replication",state:payload.status});
    },
    claimed(requestId:unknown,source:unknown,claimMs:number){
      if(typeof requestId!=="string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
        || !["realtime","poll","unspecified"].includes(String(source)))return;
      emit({event:"browser.queue.claimed",requestId,source,
        ...(Number.isFinite(claimMs)?{claimMs:Math.max(0,claimMs)}:{})});
    },
  };
}
const browserQueueObserver=createBrowserQueueObserver();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let cancellationPollInFlight: Promise<number> | null = null;

function pollBrowserCancellations(
  dependencies: CancellationPollDependencies = {},
): Promise<number> {
  if (cancellationPollInFlight) return cancellationPollInFlight;
  const work = (async () => {
    pruneTerminalBrowserControls();
    let rows: any[];
    try {
      rows = dependencies.loadRows
        ? await dependencies.loadRows()
        : ((await supa()
          .from("browser_session_requests")
          .select("*")
          .eq("status", "cancel_requested")
          .limit(16)).data ?? []);
    } catch {
      return 0;
    }
    const handleRow = dependencies.handleRow ?? handleBrowserCancellation;
    const results = await Promise.all(
      rows.slice(0, 16).map((row) => handleRow(row).catch(() => false)),
    );
    return results.filter(Boolean).length;
  })();
  cancellationPollInFlight = work;
  void work.finally(() => {
    if (cancellationPollInFlight === work) cancellationPollInFlight = null;
  });
  return work;
}

async function pollPendingBrowserRequests(
  startSession: StartSession,
  dependencies: PendingPollDependencies = {},
): Promise<number> {
  let rows: any[];
  try {
    rows = dependencies.loadRows
      ? await dependencies.loadRows()
      : ((await supa()
        .from("browser_session_requests")
        .select("*")
        .eq("status", "pending")
        .limit(3)).data ?? []);
  } catch {
    return 0;
  }
  const handleRow = dependencies.handleRow ?? ((row,start)=>handle(row,start,{dispatchSource:"poll"}));
  // The durable pending -> processing claim still arbitrates Realtime/poll
  // duplicates. A slow provider must not hold unrelated owners behind it.
  const outcomes = await Promise.allSettled(
    rows.slice(0, 3).map((row) => handleRow(row, startSession)),
  );
  return outcomes.filter((outcome) => outcome.status === "fulfilled").length;
}

export function startBrowserRequestListener(startSession: StartSession) {
  if (!config.openaiKey) return;
  const rt = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false } });
  rt.channel("browser-session-requests")
    .on("system", {}, (payload) => {browserQueueObserver.replication(payload);})
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "browser_session_requests" }, (payload) => {
      void handle(payload.new as any, startSession,{dispatchSource:"realtime"}).catch((e) => console.error("browser request failed", e));
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "browser_session_requests" }, (payload) => {
      if ((payload.new as any)?.status === "cancel_requested")
        void handleBrowserCancellation(payload.new as any).catch((e) =>
          console.error("browser cancellation failed", e)
        );
    })
    .subscribe((status)=>{browserQueueObserver.subscription(status);});
  // Cancellation recovery is immediate and independent from potentially slow
  // provider startup work. The shared promise makes 1s ticks non-overlapping.
  void pollBrowserCancellations();
  setInterval(() => { void pollBrowserCancellations(); }, 1_000);
  let pendingPollInFlight = false;
  const pollPending = () => {
    if (pendingPollInFlight) return;
    pendingPollInFlight = true;
    void pollPendingBrowserRequests(startSession).finally(() => {
      pendingPollInFlight = false;
    });
  };
  pollPending();
  setInterval(pollPending, 1_000);
  console.log("browser session listeners registered; subscription readiness is logged separately");
}

function exactOpeningPayloadMatches(
  actual: unknown,
  expected: OnboardingOpeningPayload | null,
): boolean {
  if (expected === null) return actual === null;
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    return false;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    return value;
  };
  return JSON.stringify(canonical(actual)) ===
    JSON.stringify(canonical(expected));
}

function exactReadyReceiptMatches(
  receipt: any,
  expected: {
    requestId: string;
    answerSdp: string;
    callId: string;
    openingMode: OnboardingOpeningMode;
    openingPayload: OnboardingOpeningPayload | WebsiteOpeningEnvelope | null;
  },
): boolean {
  return receipt?.id === expected.requestId &&
    receipt?.status === "ready" &&
    receipt?.answer_sdp === expected.answerSdp &&
    receipt?.call_id === expected.callId &&
    receipt?.opening_mode_applied === expected.openingMode &&
    exactOpeningPayloadMatches(
      receipt?.opening_payload,
      expected.openingPayload,
    );
}

async function bindProcessingRequestCall(
  row: any,
  callId: string,
): Promise<boolean> {
  const exact = (candidate: any) => candidate?.id === row.id &&
    candidate?.status === "processing" && candidate?.call_id === callId &&
    candidate?.tenant_id === row.tenant_id &&
    candidate?.session_type === "onboarding" &&
    candidate?.opening_mode_requested === row.opening_mode_requested && candidate?.onboarding_protocol_version===row.onboarding_protocol_version
    && ((row.opening_mode_requested === "realtime_native_v1" && row.onboarding_protocol_version===5)
      || (row.opening_mode_requested === "live_managed_v1" && row.onboarding_protocol_version===6));
  const fields =
    "id,status,call_id,tenant_id,session_type,opening_mode_requested,onboarding_protocol_version";
  try {
    const { data, error } = await supa()
      .from("browser_session_requests")
      .update({ call_id: callId })
      .eq("id", row.id)
      .eq("status", "processing")
      .select(fields);
    if (!error && data?.length === 1 && exact(data[0])) return true;
  } catch {}
  try {
    const { data, error } = await supa()
      .from("browser_session_requests")
      .select(fields)
      .eq("id", row.id)
      .maybeSingle();
    return !error && exact(data);
  } catch {
    return false;
  }
}

async function loadDurableCancellationRequest(
  requestId: string,
): Promise<any | null> {
  try {
    const { data, error } = await supa()
      .from("browser_session_requests")
      .select(
        "id,user_id,tenant_id,session_type,status,error,answer_sdp,call_id,opening_mode_requested,opening_mode_applied,opening_payload,onboarding_protocol_version",
      )
      .eq("id", requestId)
      .maybeSingle();
    return error ? null : data;
  } catch {
    return null;
  }
}

type CancellationRequestKind = "processing" | "ready";

function cancellationRequestKind(row: any): CancellationRequestKind | null {
  const stream=row?.opening_mode_requested==="realtime_stream_v1" && row?.onboarding_protocol_version===4;
  const native=row?.opening_mode_requested==="realtime_native_v1" && row?.onboarding_protocol_version===5;
  const live=row?.opening_mode_requested==="live_managed_v1" && row?.onboarding_protocol_version===6;
  const legacy=row?.opening_mode_requested==="application_tts_v1" && [null,undefined,2,3].includes(row?.onboarding_protocol_version);
  if (row?.session_type !== "onboarding" ||
    (!stream && !native && !live && !legacy) ||
    typeof row?.call_id !== "string" || !row.call_id.trim()) return null;
  if (row.answer_sdp == null && row.opening_mode_applied == null &&
    row.opening_payload == null) return "processing";
  const payload = row.opening_payload;
  if (typeof row.answer_sdp === "string" && row.answer_sdp.trim() &&
    row.opening_mode_applied === row.opening_mode_requested && payload &&
    typeof payload === "object" && !Array.isArray(payload) &&
    ([2, 3, 4, 5, 6].includes(row.onboarding_protocol_version)
      ? payload.version === row.onboarding_protocol_version
      : payload.version === 1 || payload.version === 2)) return "ready";
  return null;
}

function exactCancellationRequestMatches(eventRow: any, durableRow: any): boolean {
  const kind = cancellationRequestKind(eventRow);
  return kind !== null && cancellationRequestKind(durableRow) === kind &&
    durableRow?.id === eventRow?.id &&
    durableRow?.user_id === eventRow?.user_id &&
    durableRow?.status === "cancel_requested" &&
    durableRow?.call_id === eventRow?.call_id &&
    durableRow?.tenant_id === eventRow?.tenant_id &&
    durableRow?.session_type === eventRow?.session_type &&
    durableRow?.answer_sdp === eventRow?.answer_sdp &&
    durableRow?.opening_mode_requested === eventRow?.opening_mode_requested &&
    (durableRow?.onboarding_protocol_version ?? null) ===
      (eventRow?.onboarding_protocol_version ?? null) &&
    durableRow?.opening_mode_applied === eventRow?.opening_mode_applied &&
    exactOpeningPayloadMatches(
      durableRow?.opening_payload,
      eventRow?.opening_payload ?? null,
    );
}

const TERMINAL_CALL_STATUSES = new Set([
  "ended",
  "error",
  "killed_budget",
  "killed_deadline",
]);

type CancellationCallLoad =
  | { state: "found"; call: any }
  | { state: "absent" }
  | { state: "unreadable" };

async function loadCancellationCall(
  callId: string,
): Promise<CancellationCallLoad> {
  try {
    const { data, error } = await supa()
      .from("calls")
      .select(
        "id,tenant_id,model,channel,session_type,status,openai_call_id,provider_termination_state,provider_termination_mode,provider_usage_state,cost_estimate_usd,duration_seconds",
      )
      .eq("id", callId)
      .maybeSingle();
    if (error) return { state: "unreadable" };
    return data == null
      ? { state: "absent" }
      : { state: "found", call: data };
  } catch {
    return { state: "unreadable" };
  }
}

function cancellationCallBindingMatches(row: any, call: any): boolean {
  return call?.id === row.call_id && call?.channel === "browser" &&
    (!row.tenant_id || call.tenant_id === row.tenant_id) &&
    (!row.session_type || call.session_type === row.session_type);
}

function noProviderUsageIsSafelyResolved(call: any): boolean {
  if (call?.provider_usage_state === "not_applicable") return true;
  if (call?.cost_estimate_usd == null) return false;
  const floor = Number(call?.cost_estimate_usd);
  return call?.provider_usage_state === "resolved" &&
    Number.isFinite(floor) && floor >= 0;
}

function acceptedProviderUsageIsSafelyResolved(call: any): boolean {
  if (call?.provider_usage_state !== "resolved" ||
    call?.cost_estimate_usd == null) return false;
  const cost = Number(call.cost_estimate_usd);
  return Number.isFinite(cost) && cost >= 0;
}

function cancellationCallIsDurablyTerminal(
  row: any,
  call: any,
  kind: CancellationRequestKind,
): boolean {
  if (!cancellationCallBindingMatches(row, call) ||
    !TERMINAL_CALL_STATUSES.has(String(call.status))) return false;
  if (call.provider_termination_state === "confirmed")
    return typeof call.openai_call_id === "string" &&
      call.openai_call_id.trim().length > 0;
  return kind === "processing" && call.openai_call_id == null &&
    call.provider_termination_state === "not_required" &&
    noProviderUsageIsSafelyResolved(call);
}

async function ensureDurableCancellation(
  row: any,
  reason: string,
  control: BrowserLiveControl | undefined,
  fetchImpl?: FetchLike,
  recoverLive: (callId: string, reason: string) => Promise<boolean> = recoverManagedLiveCancellation,
): Promise<boolean> {
  const kind = cancellationRequestKind(row);
  if (!kind) return false;
  if (control) await invokeControlCleanupOnce(control, reason);

  let loadedCall = await loadCancellationCall(String(row.call_id));
  if (loadedCall.state === "absent") return kind === "processing";
  if (loadedCall.state !== "found") return false;
  let call = loadedCall.call;
  if (!cancellationCallBindingMatches(row, call)) return false;
  if (row.onboarding_protocol_version === 6 && call.model !== "gpt-live-1") return false;
  if (cancellationCallIsDurablyTerminal(row, call, kind)) return true;

  // Live is finalized by its own lifecycle. Never call the Realtime hangup API
  // or treat a transport disconnect as confirmation when a Live cleanup is pending.
  if (row.onboarding_protocol_version === 6) {
    if (!control) {
      try { await recoverLive(String(row.call_id), reason); } catch { return false; }
      loadedCall = await loadCancellationCall(String(row.call_id));
      return loadedCall.state === "found" && loadedCall.call.model === "gpt-live-1"
        && cancellationCallIsDurablyTerminal(row, loadedCall.call, kind);
    }
    return false;
  }

  if (call.openai_call_id == null) {
    if (kind !== "processing" ||
      call.provider_termination_state !== "not_required" ||
      !noProviderUsageIsSafelyResolved(call)) return false;
    if (!TERMINAL_CALL_STATUSES.has(String(call.status))) {
      try {
        await supa()
          .from("calls")
          .update({
            status: "error",
            ended_at: new Date().toISOString(),
            duration_seconds: Number(call.duration_seconds ?? 0),
            provider_termination_reason: reason,
          })
          .eq("id", call.id)
          .eq("tenant_id", call.tenant_id)
          .eq("status", "active");
      } catch {}
      loadedCall = await loadCancellationCall(String(row.call_id));
      if (loadedCall.state !== "found") return false;
      call = loadedCall.call;
    }
    if (!cancellationCallBindingMatches(row, call)) return false;
    try {
      await finalizeTerminalBudget({
        tenantId: String(call.tenant_id),
        callId: String(call.id),
        actualCostUsd: Number(call.cost_estimate_usd ?? 0),
        minutes: Number((Number(call.duration_seconds ?? 0) / 60).toFixed(2)),
        outcome: "error",
        detail: { reason, durable_cancel_requested: true },
        usageResolved: true,
      });
    } catch {}
    loadedCall = await loadCancellationCall(String(row.call_id));
    if (loadedCall.state !== "found") return false;
    call = loadedCall.call;
    return cancellationCallIsDurablyTerminal(row, call, kind);
  }

  if (!TERMINAL_CALL_STATUSES.has(String(call.status))) {
    try {
      await supa()
        .from("calls")
        .update({
          status: "error",
          ended_at: new Date().toISOString(),
          duration_seconds: Number(call.duration_seconds ?? 0),
          provider_termination_reason: reason,
        })
        .eq("id", call.id)
        .eq("tenant_id", call.tenant_id)
        .eq("status", "active");
    } catch {}
    loadedCall = await loadCancellationCall(String(row.call_id));
    if (loadedCall.state !== "found") return false;
    call = loadedCall.call;
    if (!cancellationCallBindingMatches(row, call)) return false;
  }

  const usageResolved = acceptedProviderUsageIsSafelyResolved(call);
  const providerConfirmed = call.provider_termination_state === "confirmed";
  try {
    await finalizeTerminalBudget({
      tenantId: String(call.tenant_id),
      callId: String(call.id),
      actualCostUsd: Number(call.cost_estimate_usd ?? 0),
      minutes: Number((Number(call.duration_seconds ?? 0) / 60).toFixed(2)),
      outcome: "error",
      detail: {
        reason,
        browser_request_id: String(row.id),
        durable_cancel_requested: true,
      },
      ...(providerConfirmed
        ? {}
        : {
            provider: {
              openaiCallId: String(call.openai_call_id),
              mode: call.provider_termination_mode === "reject"
                ? "reject"
                : "hangup",
              reason,
            },
          }),
      fetchImpl,
      usageResolved,
    });
  } catch {}
  loadedCall = await loadCancellationCall(String(row.call_id));
  if (loadedCall.state !== "found") return false;
  call = loadedCall.call;
  return cancellationCallIsDurablyTerminal(row, call, kind);
}

function exactExpiredCancellationMatches(row: any, callId: string): boolean {
  return row?.status === "expired" && row?.call_id === callId &&
    row?.answer_sdp == null && row?.opening_mode_applied == null &&
    row?.opening_payload == null;
}

async function expireCancelledRequest(
  row: any,
  reason: string,
): Promise<boolean> {
  const fields =
    "id,status,call_id,answer_sdp,opening_mode_applied,opening_payload";
  try {
    const { data, error } = await supa()
      .from("browser_session_requests")
      .update({
        status: "expired",
        error: reason,
        answer_sdp: null,
        opening_mode_applied: null,
        opening_payload: null,
      })
      .eq("id", row.id)
      .eq("status", "cancel_requested")
      .eq("call_id", row.call_id)
      .select(fields);
    if (!error && data?.length === 1 &&
      exactExpiredCancellationMatches(data[0], String(row.call_id))) return true;
  } catch {}
  try {
    const { data, error } = await supa()
      .from("browser_session_requests")
      .select(fields)
      .eq("id", row.id)
      .maybeSingle();
    return !error && exactExpiredCancellationMatches(
      data,
      String(row.call_id),
    );
  } catch {
    return false;
  }
}

async function handleBrowserCancellation(
  row: any,
  dependencies: { fetchImpl?: FetchLike; recoverLive?: (callId: string, reason: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const requestId = typeof row?.id === "string" ? row.id : "";
  const callId = typeof row?.call_id === "string" ? row.call_id : "";
  if (!requestId || row?.status !== "cancel_requested" || !callId)
    return false;
  const durableRow = await loadDurableCancellationRequest(requestId);
  if (!exactCancellationRequestMatches(row, durableRow)) return false;
  const control = browserLiveControls.get(requestId);
  if (control && (
    control.callId !== callId ||
    control.userId !== durableRow.user_id ||
    control.tenantId !== durableRow.tenant_id ||
    control.sessionType !== durableRow.session_type ||
    control.openingModeRequested !== durableRow.opening_mode_requested ||
    control.onboardingProtocolVersion !==
      (durableRow.onboarding_protocol_version ?? null)
  )) return false;
  const workKey = `${requestId}:${callId}`;
  const existingWork = cancellationWork.get(workKey);
  if (existingWork) return await existingWork;
  if (cancellationWork.size >= MAX_BROWSER_LIVE_CONTROLS) return false;
  const reason = typeof durableRow.error === "string" && durableRow.error.trim()
    ? durableRow.error.trim().slice(0, 400)
    : "browser_request_cancel_requested";
  const work = (async () => {
    if (!await ensureDurableCancellation(
      durableRow,
      reason,
      control,
      dependencies.fetchImpl,
      dependencies.recoverLive,
    )) return false;
    if (!await expireCancelledRequest(durableRow, reason)) return false;
    unregisterBrowserLiveControl(requestId, callId);
    return true;
  })();
  cancellationWork.set(workKey, work);
  try {
    return await work;
  } finally {
    if (cancellationWork.get(workKey) === work)
      cancellationWork.delete(workKey);
  }
}

async function handle(
  row: any,
  startSession: StartSession,
  dependencies: BrowserRequestHandleDependencies = {},
) {
  const traceScope = { requestId: String(row.id), callId: undefined as string | undefined, traceScope: "request" as const };
  const trace = createVoiceStartupTrace(traceScope);
  const claimBegan=performance.now();
  const { data: claimed } = await trace.measure("request_claim", () => supa().from("browser_session_requests")
    .update({ status: "processing", handled_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "pending").select("id"));
  if (!claimed?.length) return; // another controller instance won the race
  try{(dependencies.queueObserver??browserQueueObserver).claimed(row.id,dependencies.dispatchSource??"unspecified",performance.now()-claimBegan);}catch{ /* Diagnostic observers never own the claim. */ }

  let sessionCleanup: {
    callId: string;
    startupComplete: boolean;
    cancel(reason: string): Promise<void>;
  } | null = null;
  let controlRegistrationFailed = false;
  let requestedCallId: string | undefined;
  try {
    const requestedOpeningMode =
      (row.opening_mode_requested ?? "provider_model_v1") as
        OnboardingOpeningMode;
    if (
      (row.session_type ?? "owner_browser") === "onboarding" &&
      (!((requestedOpeningMode === "realtime_native_v1" && row.onboarding_protocol_version===5)
        || (requestedOpeningMode === "live_managed_v1" && row.onboarding_protocol_version===6)))
    ) throw Object.assign(
      new Error("client_upgrade_required"),
      { status: 409 },
    );
    const needsDurableCancelControl =
      (row.session_type ?? "owner_browser") === "onboarding" &&
      ["realtime_native_v1", "live_managed_v1"].includes(requestedOpeningMode);
    if (needsDurableCancelControl) {
      requestedCallId = (dependencies.callIdFactory ?? randomUUID)();
      traceScope.callId = requestedCallId;
      if (!UUID_PATTERN.test(requestedCallId) ||
        !await trace.measure("request_bind", () => bindProcessingRequestCall(row, requestedCallId!)))
        throw new Error("browser_request_call_bind_failed");
    }
    // The row's tenant_id is what the Edge Function resolved for the AUTHENTICATED
    // owner; startSession re-verifies ownership against a fresh read.
    const out = await trace.measure("session_start", () => startSession(
      row.user_id,
      (row.session_type ?? "owner_browser") as SessionType,
      row.offer_sdp,
      row.model_override ?? undefined,
      row.tenant_id ?? undefined,
      (cleanup) => {
        sessionCleanup = cleanup;
        if (needsDurableCancelControl &&
          !registerBrowserLiveControl(String(row.id), cleanup, {
            userId: String(row.user_id ?? ""),
            tenantId: String(row.tenant_id ?? ""),
            sessionType: "onboarding",
            openingModeRequested: requestedOpeningMode as BrowserLiveControl["openingModeRequested"],
            onboardingProtocolVersion:
              typeof row.onboarding_protocol_version === "number"
                ? row.onboarding_protocol_version
                : null,
          }))
          controlRegistrationFailed = true;
      },
      {
        browserRequestId: String(row.id),
        openingModeRequested:
          (row.opening_mode_requested ?? "provider_model_v1") as
            OnboardingOpeningMode,
        ...(requestedCallId ? { requestedCallId } : {}),
        ...([2, 3, 4, 5, 6].includes(row.onboarding_protocol_version) ? { onboardingProtocolVersion: row.onboarding_protocol_version } : {}),
      },
    ));
    if (needsDurableCancelControl &&
      (controlRegistrationFailed || !sessionCleanup))
      throw new Error("browser_request_cleanup_control_missing");
    if (sessionCleanup && sessionCleanup.callId !== out.call_id)
      throw new Error("browser_request_cleanup_call_mismatch");
    if (out.opening_mode_applied !== requestedOpeningMode)
      throw new Error("browser_request_opening_mode_mismatch");
    if (
      ["realtime_native_v1", "live_managed_v1"].includes(requestedOpeningMode) &&
      !out.opening_payload
    ) throw new Error("browser_request_opening_payload_missing");
    if (
      requestedOpeningMode === "provider_model_v1" &&
      out.opening_payload != null
    ) throw new Error("browser_request_provider_opening_payload_forbidden");
    const expectedOpeningPayload = out.opening_payload ?? null;
    if(row.onboarding_protocol_version===6 && (!isLiveOpeningPayload(expectedOpeningPayload)
      || (expectedOpeningPayload.live as Record<string,unknown>).callId!==out.call_id))
      throw new Error("browser_request_live_opening_invalid");
    if(row.onboarding_protocol_version===5 && (!isNativeOpeningPayload(expectedOpeningPayload)
      || (expectedOpeningPayload.native as Record<string,unknown>).callId!==out.call_id))
      throw new Error("browser_request_native_opening_invalid");
    if(row.onboarding_protocol_version===4 && (!isStreamOpeningPayload(expectedOpeningPayload)
      || ((expectedOpeningPayload.stream as Record<string,unknown>).action as Record<string,unknown>).callId!==out.call_id))
      throw new Error("browser_request_stream_opening_invalid");
    if (row.onboarding_protocol_version === 3 && (!isApplicationOpeningPayload(expectedOpeningPayload) ||
      expectedOpeningPayload.version !== 3 || (expectedOpeningPayload.speech as Record<string, unknown>).callId !== out.call_id))
      throw new Error("browser_request_website_opening_invalid");
    if (row.onboarding_protocol_version === 2 && expectedOpeningPayload?.version !== 2)
      throw new Error("browser_request_opening_protocol_mismatch");
    await trace.measure("request_ready", async () => {
      let ready: Array<{ id: string }> | null = null;
      let readyError: unknown = null;
      try {
        const result = await supa()
          .from("browser_session_requests")
          .update({
            status: "ready",
            answer_sdp: out.sdp,
            call_id: out.call_id,
            opening_mode_applied: requestedOpeningMode,
            opening_payload: expectedOpeningPayload,
          })
          .eq("id", row.id)
          .eq("status", "processing")
          .select("id");
        ready = result.data as Array<{ id: string }> | null;
        readyError = result.error;
      } catch (error) {
        readyError = error;
      }
      if (readyError || ready?.length !== 1) {
        let durableReady = false;
        try {
          const { data: receipt, error: receiptError } = await supa()
            .from("browser_session_requests")
            .select(
              "id,status,answer_sdp,call_id,opening_mode_applied,opening_payload",
            )
            .eq("id", row.id)
            .maybeSingle();
          durableReady = !receiptError && exactReadyReceiptMatches(receipt, {
            requestId: String(row.id),
            answerSdp: out.sdp,
            callId: out.call_id,
            openingMode: requestedOpeningMode,
            openingPayload: expectedOpeningPayload,
          });
        } catch {}
        if (!durableReady) throw new Error("browser_request_ready_failed");
      }
    });
  } catch (e: any) {
    if (sessionCleanup) {
      const registeredControl = browserLiveControls.get(String(row.id));
      if (registeredControl?.callId === sessionCleanup.callId)
        await invokeControlCleanupOnce(
          registeredControl,
          String(e?.message ?? "browser_request_failed").slice(0, 400),
        );
      else
        try {
          await sessionCleanup.cancel(
            String(e?.message ?? "browser_request_failed").slice(0, 400),
          );
        } catch {}
      unregisterBrowserLiveControl(String(row.id), sessionCleanup.callId);
    }
    try {
      const { data } = await supa().from("browser_session_requests")
        .update({
          status: "error",
          error: String(e?.message ?? e).slice(0, 400),
          answer_sdp: null,
          opening_mode_applied: null,
          opening_payload: null,
        })
        .eq("id", row.id)
        .eq("status", "processing")
        .select("id");
      if (!data?.length) {
        const { data: current } = await supa()
          .from("browser_session_requests")
          .select("id,status,call_id")
          .eq("id", row.id)
          .maybeSingle();
        if (["cancel_requested", "expired"].includes(String(current?.status)))
          return;
      }
    } catch {}
  }
}

// test seam: exercised directly by the tenancy suite
export const _handleBrowserRequest = handle;
export const _handleBrowserCancellation = handleBrowserCancellation;
export const _cancellationRequestKindForTests = cancellationRequestKind;
export const _exactOpeningPayloadMatchesForTests = exactOpeningPayloadMatches;
export const _browserLiveControlCount = () => browserLiveControls.size;
export const _pruneBrowserLiveControlsForTests = pruneTerminalBrowserControls;
export const _pollBrowserCancellations = pollBrowserCancellations;
export const _pollPendingBrowserRequests = pollPendingBrowserRequests;
export function _resetBrowserLiveControlsForTests() {
  browserLiveControls.clear();
  cancellationWork.clear();
  cancellationPollInFlight = null;
}
