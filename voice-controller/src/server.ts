// Voice controller HTTP surface.
// POST /session: owner-authenticated bootstrap — budget reservation, call row, ephemeral client secret (ek_) with the
// full per-tenant session config, SDP exchange proxied to OpenAI, sideband attach. The browser never sees any key.
import { config, sessionBudgetEnvelope } from "./config.ts";
import { buildInstructions, type SessionType } from "./instructions.ts";
import { supa } from "./rules.ts";
import { resolveSessionTenant } from "./session-tenant.ts";
import {
  makeCapability,
  toolSchemasForSessionType,
  type Capability,
} from "./tools.ts";
import { attachSideband, liveSessions } from "./sideband.ts";
import { requireTenantOwner } from "../../supabase/functions/_shared/tenant-ownership.ts";
import { finalizeTerminalBudget, reserveCallBudget } from "./budget.ts";
import { terminateProviderCall, type ProviderTerminationResult } from "./provider-termination.ts";
import { randomUUID } from "node:crypto";
import {
  isOnboardingOpeningMode,
  openingResumeContextIsInternallyValid,
  synthesizeOnboardingOpening,
  type OnboardingOpeningMode,
  type OnboardingOpeningPayload,
  type OnboardingOpeningResumeContext,
} from "./onboarding-greeting.ts";
import {
  initializeOnboardingResume,
  type OnboardingResumeSuccess,
} from "./onboarding-store.ts";
import { prepareWebsiteInterview, type PreparedWebsiteInterview } from "./onboarding-website-bootstrap.ts";
import { buildWebsiteOpeningAction, createWebsiteAgendaCoordinator } from "./onboarding-agenda-coordinator.ts";
import { createInterviewEvidenceStore } from "./onboarding-interview-evidence-store.ts";
import { synthesizeOnboardingSpeech, speechPayloadIsInternallyValid, type OnboardingSpeechAction, type OnboardingSpeechPayload } from "./onboarding-speech.ts";
import type { StreamAuthorization } from "./onboarding-stream.ts";

export type WebsiteOpeningEnvelope = { version: 3; item_id: string; speech: OnboardingSpeechPayload }
  | { version: 4; stream: StreamAuthorization };

export async function prepareRequiredWebsiteInterview(
  scope: Parameters<typeof prepareWebsiteInterview>[0],
  client: Parameters<typeof prepareWebsiteInterview>[1],
): Promise<PreparedWebsiteInterview> {
  const prepared = await prepareWebsiteInterview(scope, client);
  if (!prepared) throw new Error("website_interview_prepared_source_required");
  return prepared;
}

export async function synthesizeClaimedWebsiteOpening(
  prepared: PreparedWebsiteInterview,
  tenantName: string,
  dependencies: {
    evidence: ReturnType<typeof createInterviewEvidenceStore>;
    synthesize: (action: OnboardingSpeechAction) => Promise<OnboardingSpeechPayload>;
  },
) {
  const openingAction = buildWebsiteOpeningAction(prepared.stored, tenantName);
  createWebsiteAgendaCoordinator(prepared.stored, { nowMs: Date.now(), openingAction });
  let claim;
  try { claim = await dependencies.evidence.claimSpeech({ ...prepared.scope, action: openingAction }); }
  catch (error) { throw Object.assign(new Error("website_opening_claim_unproven", { cause: error }), { usageResolved: true, costUsd: 0 }); }
  if (claim.status === "ready" && !claim.claimed && speechPayloadIsInternallyValid(claim.payload, openingAction))
    return { prepared, openingAction, openingPayload: claim.payload };
  if (claim.status !== "preparing" || claim.claimed !== true)
    throw Object.assign(new Error("website_opening_attempt_not_owned"), { usageResolved: false, costUsd: null });
  let openingPayload: OnboardingSpeechPayload;
  try { openingPayload = await dependencies.synthesize(openingAction); }
  catch (error) {
    // A claimed attempt is never automatically retried, including unknown usage.
    await dependencies.evidence.failSpeech({ ...prepared.scope, actionId: openingAction.actionId, reason: "tts_failed" }).catch(() => {});
    throw error;
  }
  try {
    const completed = await dependencies.evidence.completeSpeech({ ...prepared.scope, actionId: openingAction.actionId, payload: openingPayload });
    if (completed.status !== "ready" || !speechPayloadIsInternallyValid(completed.payload, openingAction))
      throw new Error("website_opening_completion_mismatch");
    return { prepared, openingAction, openingPayload: completed.payload };
  } catch (error) {
    throw Object.assign(new Error("website_opening_completion_unproven", { cause: error }), { usageResolved: true, costUsd: openingPayload.cost_usd });
  }
}

export { synthesizeOnboardingOpening } from "./onboarding-greeting.ts";

/** Leave five minutes below the provider's 60-minute session ceiling for
 * termination/reconciliation. The existing $7.50 reservation/hard cap is unchanged. */
export function onboardingSessionMaxMinutes(protocolVersion?: 2 | 3 | 4): number {
  return protocolVersion === 3 || protocolVersion === 4 ? 55 : 30;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

async function verifyOwner(authHeader: string | null): Promise<{ userId: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: config.supabasePublishableKey, Authorization: authHeader },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as any;
  return user?.id ? { userId: user.id } : null;
}

export function makeBrowserSessionCapability(args: {
  tenant: {
    slug: string;
    id: string;
    auth_epoch: number;
    policy_epoch: number;
    operational_mode?: string;
  };
  callId: string;
  userId: string;
  sessionType: SessionType;
  maxMinutes: number;
}): Capability {
  return makeCapability(
    args.tenant.slug,
    args.tenant.id,
    args.callId,
    args.maxMinutes,
    args.sessionType,
    {
      authEpoch: args.tenant.auth_epoch,
      policyEpoch: args.tenant.policy_epoch,
      simulation: args.tenant.operational_mode === "simulation_only",
    },
    args.sessionType === "customer" ? undefined : args.userId,
  );
}

type DirectSessionResult = {
  sdp: string;
  call_id: string;
  opening_mode_applied?: OnboardingOpeningMode;
  opening_payload?: OnboardingOpeningPayload | WebsiteOpeningEnvelope | null;
  [key: string]: unknown;
};
export interface DirectSessionCleanup {
  callId: string;
  startupComplete: boolean;
  cancel(reason: string): Promise<void>;
}
type StartSessionLike = (
  userId: string,
  sessionType: SessionType,
  sdpOffer: string,
  modelOverride?: string,
  tenantId?: string,
  registerCleanup?: (cleanup: DirectSessionCleanup) => void,
  options?: StartSessionOptions,
) => Promise<DirectSessionResult>;

export interface StartSessionOptions {
  browserRequestId?: string;
  openingModeRequested?: OnboardingOpeningMode;
  requestedCallId?: string;
  onboardingProtocolVersion?: 2 | 3 | 4;
}

type VoiceStartupStage = "tenant_context" | "call_insert" | "budget_reservation" |
  "website_context" | "resume_context" | "tts_marker" | "opening_audio" |
  "opening_authorization" |
  "opening_cost_floor" | "provider_marker" | "provider_create" |
  "provider_identity" | "sideband_open" | "request_claim" | "request_bind" |
  "session_start" | "request_ready";

/** Process-local offsets expose overlapping work without subtracting clocks
 * across browser, Edge and controller hosts. Payloads and exceptions stay out. */
export function createVoiceStartupTrace(
  scope: { requestId?: string; callId?: string; traceScope?: "request" | "session" },
  dependencies: { now?: () => number; write?: (event: Record<string, unknown>) => void } = {},
) {
  const now = dependencies.now ?? (() => performance.now());
  const origin = now();
  const safeId = (value: string | undefined) => value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
  const write = dependencies.write ?? ((event) => console.log("voice_startup", JSON.stringify(event)));
  return {
    async measure<T>(stage: VoiceStartupStage, work: () => T | PromiseLike<T>): Promise<T> {
      const started = now();
      let outcome = "ok";
      try { return await work(); }
      catch (error) { outcome = "error"; throw error; }
      finally {
        const finished = now();
        try { write({
          evt: "voice.startup.stage", timing_version: 1,
          trace_scope: scope.traceScope ?? "session",
          request_id: safeId(scope.requestId), call_id: safeId(scope.callId),
          stage, outcome,
          stage_start_ms: Math.round((started - origin) * 100) / 100,
          duration_ms: Math.round((finished - started) * 100) / 100,
          elapsed_ms: Math.round((finished - origin) * 100) / 100,
        }); } catch { /* Timing must not change startup or cleanup behavior. */ }
      }
    },
  };
}

export function resolvedOnboardingTtsFailureCost(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const failure = error as { usageResolved?: unknown; costUsd?: unknown };
  if (failure.usageResolved !== true || typeof failure.costUsd !== "number")
    return null;
  return Number.isFinite(failure.costUsd) && failure.costUsd >= 0
    ? failure.costUsd
    : null;
}

function openingResumeContext(
  resume: OnboardingResumeSuccess | undefined,
): OnboardingOpeningResumeContext | null {
  if (!resume) return null;
  const action = resume.nextAction;
  const context: OnboardingOpeningResumeContext = {
    coverage_receipt_id: resume.coverageReceiptId,
    revision: 1,
    snapshot_digest: resume.digest,
    next_action: {
      type: "ask",
      field: String(action.field ?? ""),
      ...(typeof action.subject === "string"
        ? { subject: action.subject }
        : {}),
      question_pt: String(action.question_pt ?? ""),
    },
  };
  if (!openingResumeContextIsInternallyValid(context))
    throw new Error("onboarding_resume_opening_context_invalid");
  return context;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertPublicDirectSessionAllowed(
  sessionType: SessionType,
): void {
  if (sessionType === "onboarding")
    throw Object.assign(new Error("onboarding_edge_required"), { status: 409 });
}

function abortableStartupReceipt<T>(request: PromiseLike<T> & { abortSignal?(signal: AbortSignal): PromiseLike<T> }, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(request);
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("startup_receipt_cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(request.abortSignal ? request.abortSignal(signal) : request).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function boundedCleanupReceipt<T>(work: (signal: AbortSignal) => PromiseLike<T>, timeoutMs = 250): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await abortableStartupReceipt(work(controller.signal), controller.signal); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

async function persistOnboardingTtsCostFloor(args: {
  callId: string;
  tenantId: string;
  costUsd: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const exact = (row: any) => row?.id === args.callId &&
    row?.tenant_id === args.tenantId &&
    row?.status === "active" &&
    row?.cost_estimate_usd != null &&
    Number(row?.cost_estimate_usd) === args.costUsd;
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .update({
        cost_estimate_usd: args.costUsd,
      })
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .eq("status", "active")
      .select("id,tenant_id,status,cost_estimate_usd,provider_termination_state,provider_termination_reason,provider_usage_state")
      .maybeSingle(), args.signal);
    if (!error && exact(data)) return true;
  } catch {}
  if (args.signal?.aborted) return false;
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .select("id,tenant_id,status,cost_estimate_usd,provider_termination_state,provider_termination_reason,provider_usage_state")
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle(), args.signal);
    return !error && exact(data);
  } catch {
    return false;
  }
}

async function persistTtsInflight(args: {
  callId: string;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const exact = (row: any) => row?.id === args.callId &&
    row?.tenant_id === args.tenantId && row?.status === "active" &&
    row?.provider_termination_state === "not_required" &&
    row?.provider_termination_reason === "tts_inflight" &&
    row?.provider_usage_state === "unknown";
  const fields =
    "id,tenant_id,status,provider_termination_state,provider_termination_reason,provider_usage_state";
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .update({
        provider_termination_state: "not_required",
        provider_termination_reason: "tts_inflight",
        provider_usage_state: "unknown",
      })
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .eq("status", "active")
      .select(fields)
      .maybeSingle(), args.signal);
    if (!error && exact(data)) return true;
  } catch {}
  if (args.signal?.aborted) return false;
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .select(fields)
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle(), args.signal);
    return !error && exact(data);
  } catch {
    return false;
  }
}

async function persistRealtimeProviderIdentity(args: {
  callId: string;
  tenantId: string;
  openaiCallId: string;
  model: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const exact = (row: any) => row?.id === args.callId &&
    row?.tenant_id === args.tenantId &&
    row?.openai_call_id === args.openaiCallId &&
    row?.model === args.model &&
    row?.provider_termination_state === "active" &&
    row?.provider_termination_mode === "hangup" &&
    row?.provider_usage_state === "unknown";
  const fields =
    "id,tenant_id,status,openai_call_id,model,provider_termination_state,provider_termination_mode,provider_usage_state";
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .update({
        openai_call_id: args.openaiCallId,
        model: args.model,
        provider_termination_state: "active",
        provider_termination_mode: "hangup",
        provider_usage_state: "unknown",
      })
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .eq("status", "active")
      .eq("provider_termination_state", "unknown")
      .is("provider_termination_attempt_id", null)
      .select(fields)
      .maybeSingle(), args.signal);
    if (!error && exact(data)) return true;
  } catch {}
  if (args.signal?.aborted) return false;
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .select(fields)
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle(), args.signal);
    return !error && exact(data);
  } catch {
    return false;
  }
}

async function persistProviderCreateInflight(args: {
  callId: string;
  tenantId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const exact = (row: any) => row?.id === args.callId &&
    row?.tenant_id === args.tenantId &&
    row?.status === "active" &&
    row?.openai_call_id == null &&
    row?.provider_termination_state === "unknown" &&
    row?.provider_termination_mode === "hangup" &&
    row?.provider_termination_reason === "provider_create_inflight" &&
    row?.provider_usage_state === "unknown";
  const fields =
    "id,tenant_id,status,openai_call_id,provider_termination_state,provider_termination_mode,provider_termination_reason,provider_usage_state";
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .update({
        provider_termination_state: "unknown",
        provider_termination_mode: "hangup",
        provider_termination_reason: "provider_create_inflight",
        provider_usage_state: "unknown",
      })
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .eq("status", "active")
      .select(fields)
      .maybeSingle(), args.signal);
    if (!error && exact(data)) return true;
  } catch {}
  if (args.signal?.aborted) return false;
  try {
    const { data, error } = await abortableStartupReceipt(supa()
      .from("calls")
      .select(fields)
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle(), args.signal);
    return !error && exact(data);
  } catch {
    return false;
  }
}

export async function startDirectSessionRequest(
  args: {
    userId: string;
    sessionType: SessionType;
    sdpOffer: string;
    modelOverride?: string;
    openingModeRequested?: OnboardingOpeningMode;
  },
  dependencies: {
    client?: any;
    nowIso?: () => string;
    resolveSessionTenantImpl?: typeof resolveSessionTenant;
    startSessionImpl?: StartSessionLike;
    callIdFactory?: () => string;
  } = {},
): Promise<DirectSessionResult> {
  const startSessionImpl = dependencies.startSessionImpl ?? startSession;
  // Preserve the established direct customer/owner-browser path. Only
  // onboarding persistence needs the durable browser request proof required by
  // the service-role RPCs.
  if (args.sessionType !== "onboarding")
    return await startSessionImpl(
      args.userId,
      args.sessionType,
      args.sdpOffer,
      args.modelOverride,
    );
  if (args.openingModeRequested !== "application_tts_v1")
    throw Object.assign(new Error("client_upgrade_required"), { status: 409 });

  const client = dependencies.client ?? supa();
  const resolveSessionTenantImpl =
    dependencies.resolveSessionTenantImpl ?? resolveSessionTenant;
  const { tenant } = await resolveSessionTenantImpl(args.userId);
  const { data: requestRow, error: insertError } = await client
    .from("browser_session_requests")
    .insert({
      tenant_id: tenant.id,
      user_id: args.userId,
      session_type: "onboarding",
      model_override: args.modelOverride ?? null,
      offer_sdp: args.sdpOffer,
      opening_mode_requested: "application_tts_v1",
      status: "processing",
      handled_at: (dependencies.nowIso ?? (() => new Date().toISOString()))(),
    })
    .select("id")
    .single();
  if (insertError || !requestRow?.id)
    throw Object.assign(new Error("direct_onboarding_request_insert_failed"), {
      status: 503,
    });

  const requestedCallId = (dependencies.callIdFactory ?? randomUUID)();
  if (!UUID_PATTERN.test(requestedCallId))
    throw Object.assign(new Error("browser_call_id_invalid"), { status: 503 });
  const { data: boundRow, error: bindError } = await client
    .from("browser_session_requests")
    .update({ call_id: requestedCallId })
    .eq("id", requestRow.id)
    .eq("status", "processing")
    .select("id,status,call_id")
    .single();
  if (bindError || boundRow?.id !== requestRow.id ||
    boundRow?.status !== "processing" || boundRow?.call_id !== requestedCallId)
    throw Object.assign(new Error("direct_onboarding_call_bind_failed"), {
      status: 503,
    });

  let sessionCleanup: DirectSessionCleanup | null = null;
  try {
    const result = await startSessionImpl(
      args.userId,
      "onboarding",
      args.sdpOffer,
      args.modelOverride,
      tenant.id,
      (cleanup) => {
        sessionCleanup = cleanup;
      },
      {
        browserRequestId: String(requestRow.id),
        openingModeRequested: "application_tts_v1",
        requestedCallId,
      },
    );
    if (
      result.opening_mode_applied !== "application_tts_v1" ||
      !result.opening_payload
    ) throw Object.assign(
      new Error("direct_onboarding_opening_contract_failed"),
      { status: 503 },
    );
    const openingReadyPatch = result.opening_mode_applied
      ? {
          opening_mode_applied: result.opening_mode_applied,
          opening_payload: result.opening_payload ?? null,
        }
      : {};
    const { data: readyRow, error: readyError } = await client
      .from("browser_session_requests")
      .update({
        status: "ready",
        answer_sdp: result.sdp,
        call_id: result.call_id,
        ...openingReadyPatch,
      })
      .eq("id", requestRow.id)
      .eq("status", "processing")
      .select("id")
      .single();
    if (readyError || readyRow?.id !== requestRow.id)
      throw Object.assign(
        new Error("direct_onboarding_request_ready_failed"),
        { status: 503 },
      );
    return result;
  } catch (error) {
    const primaryMessage = String(
      error instanceof Error ? error.message : error,
    ).slice(0, 400);
    if (sessionCleanup) {
      try {
        await sessionCleanup.cancel(primaryMessage);
      } catch {}
    }
    try {
      await client
        .from("browser_session_requests")
        .update({
          status: "error",
          error: primaryMessage,
        })
        .eq("id", requestRow.id)
        .eq("status", "processing");
    } catch {}
    throw error;
  }
}

export async function startSession(
  userId: string,
  sessionType: SessionType,
  sdpOffer: string,
  modelOverride?: string,
  tenantId?: string,
  registerCleanup?: (cleanup: DirectSessionCleanup) => void,
  options: StartSessionOptions = {},
) {
  // All new onboarding is streamed. Older MP3 capabilities remain readable
  // for historical evidence, but cannot create another paid session.
  if(sessionType==="onboarding" && (options.openingModeRequested!=="realtime_stream_v1" || options.onboardingProtocolVersion!==4))
    throw Object.assign(new Error("client_upgrade_required"),{status:409});
  const traceScope = { requestId: options.browserRequestId, callId: options.requestedCallId };
  const trace = createVoiceStartupTrace(traceScope);
  const { tenant, rules } = await trace.measure("tenant_context", () => resolveSessionTenant(userId, tenantId));

  if (
    sessionType === "onboarding" &&
    options.openingModeRequested !== "realtime_stream_v1"
  ) throw Object.assign(new Error("client_upgrade_required"), { status: 409 });
  if (sessionType === "onboarding" &&
    (!options.requestedCallId || !UUID_PATTERN.test(options.requestedCallId)))
    throw Object.assign(new Error("browser_call_id_required"), { status: 409 });
  const openingMode = options.openingModeRequested ?? "provider_model_v1";
  const applicationControlled=openingMode==="application_tts_v1" || openingMode==="realtime_stream_v1";
  const websiteProtocol = sessionType === "onboarding" && options.onboardingProtocolVersion === 4;
  if (options.onboardingProtocolVersion !== undefined &&
    (sessionType !== "onboarding" || options.onboardingProtocolVersion!==4))
    throw Object.assign(new Error("client_upgrade_required"), { status: 409 });
  if (!isOnboardingOpeningMode(openingMode) ||
    (applicationControlled && sessionType !== "onboarding"))
    throw Object.assign(new Error("opening_mode_invalid"), { status: 409 });

  const ALLOWED_MODELS = new Set(["gpt-realtime", "gpt-realtime-2.1", "gpt-realtime-2.1-mini"]);
  // Primary model, then automatic fallback (RJ 2026-08-19: 2.1 primary, mini as fallback).
  const primary = modelOverride && ALLOWED_MODELS.has(modelOverride) ? modelOverride : config.model;
  const chain = primary === config.fallbackModel ? [primary] : [primary, config.fallbackModel];
  const budgetEnvelope = sessionBudgetEnvelope(sessionType);

  // call row first (budget RPC references it)
  const { data: call, error: ce } = await trace.measure("call_insert", () => supa()
    .from("calls")
    .insert({
      ...(sessionType === "onboarding"
        ? { id: options.requestedCallId }
        : {}),
      tenant_id: tenant.id,
      channel: "browser",
      session_type: sessionType,
      model: primary,
      status: "active",
      provider_termination_state: "not_required",
      provider_usage_state: "not_applicable",
    })
    .select("id")
    .single());
  if (ce || !call) throw new Error(`call_insert_failed: ${ce?.message}`);
  traceScope.callId = call.id;

  let acceptedModel = primary;
  const terminateStartupProvider = async (
    provider: { openaiCallId: string | null; mode: "hangup" | "reject" }, reason: string,
  ): Promise<ProviderTerminationResult> => {
    const terminate = () => boundedCleanupReceipt(() => terminateProviderCall({
      callId: call.id, ...provider, reason,
    }), 5_500);
    const first = await terminate();
    if (first?.confirmed || !provider.openaiCallId) return first ?? { confirmed: false, error: "provider_termination_receipt_pending" };
    // A Location may arrive before the identity write completes (or its body
    // fails). Bind only that known identity, guarded against a spent termination
    // attempt, then let the existing RPC arbitrate the single permitted hangup.
    const identity = await boundedCleanupReceipt(signal => persistRealtimeProviderIdentity({
      callId: call.id, tenantId: tenant.id, openaiCallId: provider.openaiCallId!, model: acceptedModel, signal,
    }));
    if (!identity) return first ?? { confirmed: false, error: "provider_identity_receipt_pending" };
    return await terminate() ?? { confirmed: false, error: "provider_termination_receipt_pending" };
  };
  const settleStartupFailure = async (
    reason: string,
    usageState: "not_applicable" | "unknown" | "resolved",
    provider?: { openaiCallId: string | null; mode: "hangup" | "reject" },
    actualCostUsd = 0,
    terminationWork?: Promise<ProviderTerminationResult>,
  ) => {
    const usageResolved = usageState === "not_applicable" || usageState === "resolved";
    const knownCostFloor = Number(actualCostUsd.toFixed(8));
    const termination = provider ? await (terminationWork ?? terminateStartupProvider(provider, reason)) : null;
    const terminalWrite = await boundedCleanupReceipt(signal => abortableStartupReceipt(supa().from("calls").update({
      status: "error",
      ended_at: new Date().toISOString(),
      duration_seconds: 0,
      cost_estimate_usd: usageResolved || knownCostFloor > 0 ? knownCostFloor : null,
      // Accepted/unknown provider state belongs to the termination RPC. A late
      // status-write response must never reset its pending/confirmed evidence.
      ...(!provider ? { provider_termination_state: "not_required", provider_termination_mode: null } : {}),
      provider_termination_reason: reason,
      provider_usage_state: usageState,
    }).eq("id", call.id).eq("tenant_id", tenant.id).eq("status", "active"), signal));
    const terminalWriteProven = terminalWrite !== null && !terminalWrite.error;
    const settled = await boundedCleanupReceipt(() => finalizeTerminalBudget({
      tenantId: tenant.id, callId: call.id, actualCostUsd: knownCostFloor,
      minutes: 0, outcome: "startup_error", detail: { reason },
      // Termination is already under separate custody. Unproven receipts or
      // accepted-provider usage keep the existing reservation in reconciliation.
      usageResolved: usageResolved && terminalWriteProven && (!provider || termination?.confirmed === true),
    }));
    return settled === true;
  };

  // New onboarding authorizes live speech; startup creates no audio file.
  // Provider identity, cancellation and budget settlement stay independent.
  let providerLifecycle: "not_started" | "marking" | "inflight" | "rejected" | "accepted" = "not_started";
  let startupCancelled = false;
  let websiteInterview: {prepared:PreparedWebsiteInterview;openingAction:OnboardingSpeechAction;openingStream:StreamAuthorization} | undefined;
  let preparedWebsite: PreparedWebsiteInterview | null = null;
  const externalCostUsd = 0;
  let openaiCallId = "";
  let providerFinished: Promise<unknown> | null = null;
  let providerNetworkFinished: Promise<void> | null = null;
  const startupReceipts = new AbortController();
  let providerCreateController: AbortController | null = null;
  let sidebandControl: ReturnType<typeof attachSideband> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let resolveReservationFinished!: () => void;
  const reservationFinished = new Promise<void>((resolve) => {
    resolveReservationFinished = resolve;
  });
  const cleanupControl: DirectSessionCleanup = {
    callId: call.id,
    startupComplete: false,
    async cancel(reason: string) {
      if (!cleanupPromise) {
        startupCancelled = true;
        providerCreateController?.abort();
        startupReceipts.abort();
        sidebandControl?.cancel(reason);
        cleanupPromise = (async () => {
          await reservationFinished;
          // Wait for the bounded provider request, not an unbounded database
          // response body. An accepted call remains under termination custody.
          await providerNetworkFinished;
          const provider = ["inflight", "accepted"].includes(providerLifecycle)
            ? { openaiCallId: openaiCallId || null, mode: "hangup" as const }
            : undefined;
          const termination = provider ? terminateStartupProvider(provider, reason) : undefined;
          const usageState = provider ? "unknown" as const : "not_applicable" as const;
          await settleStartupFailure(
            reason,
            usageState,
            provider,
            externalCostUsd,
            termination,
          );
        })();
      }
      await cleanupPromise;
    },
  };
  if (applicationControlled) registerCleanup?.(cleanupControl);

  const stopIfCancelled = async () => {
    if (!startupCancelled) return;
    if (cleanupPromise) await cleanupPromise;
    throw Object.assign(new Error("browser_request_cancelled"), {
      status: 499,
      startupCancelled: true,
    });
  };

  // Atomic budget reservation remains a hard gate, but the app-opening cleanup
  // control is already registered and waits for this outcome before settlement.
  try {
    await trace.measure("budget_reservation", () => reserveCallBudget(
      tenant.id,
      call.id,
      budgetEnvelope.reservationUsd,
    ));
  } catch (error: any) {
    resolveReservationFinished();
    if (startupCancelled) await stopIfCancelled();
    await supa().from("calls").update({
      status: "killed_budget",
      ended_at: new Date().toISOString(),
    }).eq("id", call.id);
    throw error;
  }
  resolveReservationFinished();
  await stopIfCancelled();

  if (!config.openaiKey) {
    await settleStartupFailure("openai_key_missing", "not_applicable");
    throw Object.assign(new Error("openai_key_missing"), { status: 503 });
  }

  const instructions = buildInstructions(tenant, rules, sessionType);
  const maxMinutes = sessionType === "onboarding" ? onboardingSessionMaxMinutes(options.onboardingProtocolVersion) : (tenant.session_max_minutes ?? config.sessionMaxMinutes);
  const cap = makeBrowserSessionCapability({
    tenant,
    callId: call.id,
    userId,
    sessionType,
    maxMinutes,
  });
  if (websiteProtocol) {
    try {
      if (!options.browserRequestId || !UUID_PATTERN.test(options.browserRequestId)) throw new Error("website_interview_request_identity_required");
      preparedWebsite = await trace.measure("website_context", () => prepareRequiredWebsiteInterview({ ownerId: userId, tenantId: tenant.id, callId: call.id, requestId: options.browserRequestId! }, supa()));
      const streamRuntime=await import("./onboarding-website-runtime.ts");
      websiteInterview=await trace.measure("opening_authorization",()=>streamRuntime.prepareWebsiteStreamOpening(preparedWebsite!,tenant.name,{evidence:createInterviewEvidenceStore(supa())}));
    } catch (error: any) {
      await settleStartupFailure(String(error?.message ?? "website_interview_prepare_failed"), "not_applicable");
      throw Object.assign(error, { status: 503 });
    }
    await stopIfCancelled();
  }

  let answerSdp = "", usedModel = "";
  providerFinished = abortableStartupReceipt((async () => {
    providerLifecycle = "marking";
    const providerInflightProven = await trace.measure("provider_marker", () => persistProviderCreateInflight({ callId: call.id, tenantId: tenant.id, signal: startupReceipts.signal }));
    if (startupCancelled) return;
    if (!providerInflightProven)
      throw Object.assign(new Error("provider_create_inflight_unproven"), { status: 503 });

    // ONE multipart POST with the standard key. Explicit non-acceptance alone
    // permits model fallback; unknown outcomes never create a second session.
    let lastErr = "";
    providerCreateController = new AbortController();
    const controller = providerCreateController;
    const providerCreateDeadline = setTimeout(() => controller.abort(), config.realtimeCreateTimeoutMs);
    let finishNetwork!: () => void;
    providerNetworkFinished = new Promise<void>(resolve => { finishNetwork = resolve; });
    try {
      await trace.measure("provider_create", async () => {
        for (const model of chain) {
          if (startupCancelled) return;
          let attemptCallId: string | null = null;
          try {
            const form = new FormData();
            form.set("sdp", sdpOffer);
            form.set("session", JSON.stringify(buildRealtimeSessionConfig({
              model,
              instructions,
              tools: toolSchemasForSessionType(sessionType),
              voice: sessionType === "onboarding" ? "ash" : config.voice,
              openingMode,
              ...(websiteProtocol ? { onboardingProtocolVersion: 4 as const } : {}),
            })));
            providerLifecycle = "inflight";
            const callRes = await fetch("https://api.openai.com/v1/realtime/calls", {
              method: "POST",
              headers: { Authorization: `Bearer ${config.openaiKey}` },
              body: form,
              signal: controller.signal,
            });
            const candidateCallId = (callRes.headers.get("Location") ?? "").split("/").pop() ?? "";
            attemptCallId = candidateCallId || null;
            if (candidateCallId) {
              openaiCallId = candidateCallId;
              providerLifecycle = "accepted";
              acceptedModel = model;
            }
            if (!callRes.ok) {
              const responseText = await callRes.text();
              const detail = `sdp ${model}: ${callRes.status} ${responseText}`;
              if (callRes.status >= 400 && callRes.status < 500 && !candidateCallId) {
                providerLifecycle = "rejected";
                lastErr = detail;
                continue;
              }
              throw Object.assign(new Error("provider_outcome_unknown"), { detail });
            }
            if (!candidateCallId)
              throw Object.assign(new Error("provider_outcome_unknown"), { detail: `no_call_id ${model}` });
            const candidateAnswerSdp = await callRes.text();
            if (!candidateAnswerSdp.trim())
              throw Object.assign(new Error("provider_outcome_unknown"), { detail: `empty_sdp ${model}` });
            answerSdp = candidateAnswerSdp;
            usedModel = model;
            break;
          } catch (error: any) {
            // Keep any late Location even when cancellation won before its body.
            if (attemptCallId) openaiCallId = attemptCallId;
            throw Object.assign(new Error("provider_outcome_unknown"), {
              status: 502, detail: error?.detail ?? `${model}: ${error?.message}`,
            });
          }
        }
        if (!startupCancelled && !usedModel)
          throw Object.assign(new Error("realtime_unavailable"), { status: 502, detail: lastErr });
      });
    } finally {
      clearTimeout(providerCreateDeadline);
      providerCreateController = null;
      finishNetwork();
    }
    if (startupCancelled) return;
    const providerIdentityProven = await trace.measure("provider_identity", () => persistRealtimeProviderIdentity({
      callId: call.id, tenantId: tenant.id, openaiCallId, model: usedModel, signal: startupReceipts.signal,
    }));
    if (!providerIdentityProven)
      throw Object.assign(new Error("provider_identity_unproven"), { status: 503 });
  })(), startupReceipts.signal);

  const startupOutcomes = await Promise.allSettled([providerFinished]);
  await stopIfCancelled();
  const failed = startupOutcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") {
    const failure = failed.reason;
    await cleanupControl.cancel(String(failure?.message ?? "startup_failed"));
    throw failure;
  }
  try {
    sidebandControl = attachSideband(
      cap,
      openaiCallId,
      usedModel,
      sessionType === "onboarding"
        ? {
            onboarding: {
              expectedBusinessName: tenant.name,
              openingMode,
              ...(websiteInterview ? { websiteInterview } : {}),
            },
            externalCostUsd,
          }
        : {},
    );
    cleanupControl.startupComplete = true;
  } catch (error) {
    if (startupCancelled) await stopIfCancelled();
    await cleanupControl.cancel("sideband_attach_failed");
    throw error;
  }
  if (!applicationControlled) registerCleanup?.(cleanupControl);
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  if (applicationControlled)
    try {
      await trace.measure("sideband_open", () => Promise.race([
        sidebandControl!.opened,
        new Promise<never>((_resolve, reject) => {
          openTimer = setTimeout(
            () => reject(new Error("sideband_open_timeout")),
            config.sidebandOpenTimeoutMs,
          );
        }),
      ]));
    } catch (error) {
      const reason = error instanceof Error &&
          error.message === "sideband_open_timeout"
        ? "sideband_open_timeout"
        : "sideband_open_failed";
      await cleanupControl.cancel(reason);
      throw Object.assign(new Error(reason), { status: 502 });
    } finally {
      if (openTimer) clearTimeout(openTimer);
    }
  await stopIfCancelled();

  return {
    sdp: answerSdp,
    call_id: call.id,
    max_minutes: maxMinutes,
    model: usedModel,
    fell_back: usedModel !== primary,
    opening_mode_applied: openingMode,
    opening_payload: websiteInterview ? {version:4 as const,stream:websiteInterview.openingStream} : null,
  };
}

export function buildRealtimeSessionConfig(args: {
  model: string;
  instructions: string;
  tools: unknown[];
  voice: string;
  openingMode: OnboardingOpeningMode;
  onboardingProtocolVersion?: 2 | 3 | 4;
}) {
  const applicationOwned = args.openingMode === "application_tts_v1" || args.openingMode === "realtime_stream_v1";
  return {
    type: "realtime",
    model: args.model,
    instructions: args.instructions,
    tools: args.onboardingProtocolVersion === 3 || args.onboardingProtocolVersion === 4 ? [] : args.tools,
    tool_choice: args.onboardingProtocolVersion === 3 || args.onboardingProtocolVersion === 4 ? "none" : "auto",
    output_modalities: applicationOwned ? ["text"] : ["audio"],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: !applicationOwned,
          interrupt_response: !applicationOwned,
        },
      },
      output: { voice: args.voice },
    },
  };
}

if (import.meta.main) {
  const { startWorkerLoop } = await import("./worker.ts");
  startWorkerLoop();
  const { startPhoneListener } = await import("./phone.ts");
  startPhoneListener();
  const { startBrowserRequestListener } = await import("./browser-requests.ts");
  startBrowserRequestListener(startSession);
  Bun.serve({
    port: config.port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

      if (url.pathname === "/health") {
        return Response.json({ ok: true, live_sessions: liveSessions.size, model: config.model, openai: Boolean(config.openaiKey) }, { headers: CORS });
      }

      // Compatibility endpoint: verifies the explicit binding. Provisioning is an operator-only SQL RPC.
      if (url.pathname === "/claim" && req.method === "POST") {
        try {
          const owner = await verifyOwner(req.headers.get("authorization"));
          if (!owner) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
          await requireTenantOwner(supa(), config.defaultTenantSlug, owner.userId);
          return Response.json({ tenant: config.defaultTenantSlug, owner: true }, { headers: CORS });
        } catch (e: any) {
          return Response.json({ error: e?.message ?? "internal" }, { status: e?.status ?? 500, headers: CORS });
        }
      }

      if (url.pathname === "/session" && req.method === "POST") {
        try {
          const owner = await verifyOwner(req.headers.get("authorization"));
          if (!owner) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
          const body = (await req.json()) as {
            sdp?: string;
            session_type?: SessionType;
            model?: string;
            opening_mode_requested?: OnboardingOpeningMode;
          };
          if (!body.sdp) return Response.json({ error: "sdp_required" }, { status: 400, headers: CORS });
          const requestedSessionType = body.session_type ?? "owner_browser";
          assertPublicDirectSessionAllowed(requestedSessionType);
          const out = await startDirectSessionRequest({
            userId: owner.userId,
            sessionType: requestedSessionType,
            sdpOffer: body.sdp,
            modelOverride: body.model,
            openingModeRequested: body.opening_mode_requested,
          });
          return Response.json(out, { headers: CORS });
        } catch (e: any) {
          const status = e?.status ?? 500;
          return Response.json({ error: e?.message ?? "internal", detail: e?.detail }, { status, headers: CORS });
        }
      }

      return new Response("not found", { status: 404, headers: CORS });
    },
  });
  console.log(`ligou voice-controller on :${config.port} (model ${config.model}, openai key ${config.openaiKey ? "present" : "MISSING — live sessions disabled"})`);
}
