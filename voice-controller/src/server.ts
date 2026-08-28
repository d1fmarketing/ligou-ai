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

export { synthesizeOnboardingOpening } from "./onboarding-greeting.ts";

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
  opening_payload?: OnboardingOpeningPayload | null;
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

async function persistOnboardingTtsCostFloor(args: {
  callId: string;
  tenantId: string;
  costUsd: number;
}): Promise<boolean> {
  const exact = (row: any) => row?.id === args.callId &&
    row?.tenant_id === args.tenantId &&
    row?.status === "active" &&
    Number(row?.cost_estimate_usd) === args.costUsd &&
    row?.provider_termination_state === "not_required" &&
    row?.provider_termination_reason === "tts_resolved" &&
    row?.provider_usage_state === "resolved";
  try {
    const { data, error } = await supa()
      .from("calls")
      .update({
        cost_estimate_usd: args.costUsd,
        provider_termination_state: "not_required",
        provider_termination_reason: "tts_resolved",
        provider_usage_state: "resolved",
      })
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .eq("status", "active")
      .select("id,tenant_id,status,cost_estimate_usd,provider_termination_state,provider_termination_reason,provider_usage_state")
      .maybeSingle();
    if (!error && exact(data)) return true;
  } catch {}
  try {
    const { data, error } = await supa()
      .from("calls")
      .select("id,tenant_id,status,cost_estimate_usd,provider_termination_state,provider_termination_reason,provider_usage_state")
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle();
    return !error && exact(data);
  } catch {
    return false;
  }
}

async function persistTtsInflight(args: {
  callId: string;
  tenantId: string;
}): Promise<boolean> {
  const exact = (row: any) => row?.id === args.callId &&
    row?.tenant_id === args.tenantId && row?.status === "active" &&
    row?.provider_termination_state === "not_required" &&
    row?.provider_termination_reason === "tts_inflight" &&
    row?.provider_usage_state === "unknown";
  const fields =
    "id,tenant_id,status,provider_termination_state,provider_termination_reason,provider_usage_state";
  try {
    const { data, error } = await supa()
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
      .maybeSingle();
    if (!error && exact(data)) return true;
  } catch {}
  try {
    const { data, error } = await supa()
      .from("calls")
      .select(fields)
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle();
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
    const { data, error } = await supa()
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
      .select(fields)
      .maybeSingle();
    if (!error && exact(data)) return true;
  } catch {}
  try {
    const { data, error } = await supa()
      .from("calls")
      .select(fields)
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle();
    return !error && exact(data);
  } catch {
    return false;
  }
}

async function persistProviderCreateInflight(args: {
  callId: string;
  tenantId: string;
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
    const { data, error } = await supa()
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
      .maybeSingle();
    if (!error && exact(data)) return true;
  } catch {}
  try {
    const { data, error } = await supa()
      .from("calls")
      .select(fields)
      .eq("id", args.callId)
      .eq("tenant_id", args.tenantId)
      .maybeSingle();
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
  const { tenant, rules } = await resolveSessionTenant(userId, tenantId);

  if (
    sessionType === "onboarding" &&
    options.openingModeRequested !== "application_tts_v1"
  ) throw Object.assign(new Error("client_upgrade_required"), { status: 409 });
  if (sessionType === "onboarding" &&
    (!options.requestedCallId || !UUID_PATTERN.test(options.requestedCallId)))
    throw Object.assign(new Error("browser_call_id_required"), { status: 409 });
  const openingMode = options.openingModeRequested ?? "provider_model_v1";
  if (!isOnboardingOpeningMode(openingMode) ||
    (openingMode === "application_tts_v1" && sessionType !== "onboarding"))
    throw Object.assign(new Error("opening_mode_invalid"), { status: 409 });

  const ALLOWED_MODELS = new Set(["gpt-realtime", "gpt-realtime-2.1", "gpt-realtime-2.1-mini"]);
  // Primary model, then automatic fallback (RJ 2026-08-19: 2.1 primary, mini as fallback).
  const primary = modelOverride && ALLOWED_MODELS.has(modelOverride) ? modelOverride : config.model;
  const chain = primary === config.fallbackModel ? [primary] : [primary, config.fallbackModel];
  const budgetEnvelope = sessionBudgetEnvelope(sessionType);

  // call row first (budget RPC references it)
  const { data: call, error: ce } = await supa()
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
    .single();
  if (ce || !call) throw new Error(`call_insert_failed: ${ce?.message}`);

  const settleStartupFailure = async (
    reason: string,
    usageState: "not_applicable" | "unknown" | "resolved",
    provider?: { openaiCallId: string | null; mode: "hangup" | "reject" },
    actualCostUsd = 0,
  ) => {
    const usageResolved = usageState === "not_applicable" || usageState === "resolved";
    const knownCostFloor = Number(actualCostUsd.toFixed(8));
    const resolvedCost = knownCostFloor;
    const terminalWrite = await supa().from("calls").update({
      status: "error",
      ended_at: new Date().toISOString(),
      duration_seconds: 0,
      cost_estimate_usd: usageResolved || knownCostFloor > 0
        ? usageResolved ? resolvedCost : knownCostFloor
        : null,
      provider_termination_state: provider ? (provider.openaiCallId ? "active" : "unknown") : "not_required",
      provider_termination_mode: provider?.mode ?? null,
      provider_termination_reason: reason,
      provider_usage_state: usageState,
    }).eq("id", call.id);
    if (terminalWrite.error) return false;
    return await finalizeTerminalBudget({
      tenantId: tenant.id,
      callId: call.id,
      actualCostUsd: usageResolved ? resolvedCost : knownCostFloor,
      minutes: 0,
      outcome: "startup_error",
      detail: { reason },
      provider: provider ? { ...provider, reason } : undefined,
      usageResolved,
    });
  };

  type StartupPhase =
    | "before_tts"
    | "tts_inflight"
    | "tts_resolved"
    | "provider_marking"
    | "provider_inflight"
    | "provider_accepted"
    | "sideband";
  let startupPhase: StartupPhase = "before_tts";
  let startupCancelled = false;
  let openingPayload: OnboardingOpeningPayload | null = null;
  let externalCostUsd = 0;
  let openaiCallId = "";
  let ttsAbortController: AbortController | null = null;
  let ttsFinished: Promise<void> | null = null;
  let resolveTtsFinished: (() => void) | null = null;
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
        ttsAbortController?.abort();
        providerCreateController?.abort();
        sidebandControl?.cancel(reason);
        cleanupPromise = (async () => {
          await reservationFinished;
          if (startupPhase === "tts_inflight" && ttsFinished)
            await ttsFinished;
          const provider = startupPhase === "provider_inflight"
            ? { openaiCallId: null, mode: "hangup" as const }
            : (startupPhase === "provider_accepted" ||
                startupPhase === "sideband") && openaiCallId
              ? { openaiCallId, mode: "hangup" as const }
              : undefined;
          const usageState = startupPhase === "before_tts"
            ? "not_applicable" as const
            : (startupPhase === "tts_resolved" ||
                startupPhase === "provider_marking")
              ? "resolved" as const
              : "unknown" as const;
          await settleStartupFailure(
            reason,
            usageState,
            provider,
            startupPhase === "before_tts" || startupPhase === "tts_inflight"
              ? 0
              : externalCostUsd,
          );
        })();
      }
      await cleanupPromise;
    },
  };
  if (openingMode === "application_tts_v1") registerCleanup?.(cleanupControl);

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
    await reserveCallBudget(
      tenant.id,
      call.id,
      budgetEnvelope.reservationUsd,
    );
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
  const maxMinutes = sessionType === "onboarding" ? 30 : (tenant.session_max_minutes ?? config.sessionMaxMinutes);
  const cap = makeBrowserSessionCapability({
    tenant,
    callId: call.id,
    userId,
    sessionType,
    maxMinutes,
  });
  let onboardingResume: OnboardingResumeSuccess | undefined;
  if (sessionType === "onboarding") {
    const resumeResult = await initializeOnboardingResume(cap);
    await stopIfCancelled();
    if (!resumeResult.ok) {
      const reason = `onboarding_resume_${resumeResult.code}`;
      await settleStartupFailure(reason, "not_applicable");
      throw Object.assign(new Error(reason), { status: 503 });
    }
    if (resumeResult.status !== "none") onboardingResume = resumeResult;
  }
  const resumeContext = openingResumeContext(onboardingResume);

  if (openingMode === "application_tts_v1") {
    if (!options.browserRequestId?.trim()) {
      await settleStartupFailure(
        "onboarding_opening_request_identity_missing",
        "not_applicable",
      );
      throw Object.assign(
        new Error("onboarding_opening_request_identity_missing"),
        { status: 503 },
      );
    }
    const ttsInflightProven = await persistTtsInflight({
      callId: call.id,
      tenantId: tenant.id,
    });
    await stopIfCancelled();
    if (!ttsInflightProven) {
      await settleStartupFailure(
        "onboarding_tts_inflight_unproven",
        "not_applicable",
      );
      throw Object.assign(
        new Error("onboarding_tts_inflight_unproven"),
        { status: 503 },
      );
    }
    startupPhase = "tts_inflight";
    ttsAbortController = new AbortController();
    ttsFinished = new Promise<void>((resolve) => {
      resolveTtsFinished = resolve;
    });
    try {
      openingPayload = await synthesizeOnboardingOpening(
        {
          tenantName: tenant.name,
          browserRequestId: options.browserRequestId,
          callId: call.id,
          resumeContext,
        },
        {
          openaiKey: config.openaiKey,
          signal: ttsAbortController.signal,
        },
      );
      externalCostUsd = openingPayload.cost_usd;
      startupPhase = "tts_resolved";
      resolveTtsFinished?.();
      await stopIfCancelled();
      if (!await persistOnboardingTtsCostFloor({
        callId: call.id,
        tenantId: tenant.id,
        costUsd: externalCostUsd,
      })) {
        await settleStartupFailure(
          "onboarding_tts_cost_floor_unproven",
          "resolved",
          undefined,
          externalCostUsd,
        );
        throw Object.assign(
          new Error("onboarding_tts_cost_floor_unproven"),
          { status: 503, costFloorHandled: true },
        );
      }
      await stopIfCancelled();
    } catch (error: any) {
      const resolvedCost = resolvedOnboardingTtsFailureCost(error);
      const usageResolved = resolvedCost !== null;
      const actualCost = resolvedCost ?? 0;
      if (usageResolved) {
        externalCostUsd = actualCost;
        startupPhase = "tts_resolved";
      }
      resolveTtsFinished?.();
      if (startupCancelled) await stopIfCancelled();
      if (error?.costFloorHandled === true) throw error;
      await settleStartupFailure(
        String(error?.message ?? "onboarding_tts_outcome_unknown"),
        usageResolved ? "resolved" : "unknown",
        undefined,
        actualCost,
      );
      throw Object.assign(
        new Error(String(error?.message ?? "onboarding_tts_outcome_unknown")),
        { status: usageResolved ? 502 : 503 },
      );
    } finally {
      resolveTtsFinished?.();
      resolveTtsFinished = null;
      ttsAbortController = null;
    }
  }

  startupPhase = "provider_marking";
  const providerInflightProven = await persistProviderCreateInflight({
    callId: call.id,
    tenantId: tenant.id,
  });
  await stopIfCancelled();
  if (!providerInflightProven) {
    await settleStartupFailure(
      "provider_create_inflight_unproven",
      "not_applicable",
      undefined,
      externalCostUsd,
    );
    throw Object.assign(
      new Error("provider_create_inflight_unproven"),
      { status: 503 },
    );
  }
  startupPhase = "provider_inflight";

  // Unified interface (official server flow): ONE multipart POST with the STANDARD key. No ephemeral ek_ —
  // we proxy the SDP ourselves, and calls created under an ek_ are invisible to the standard-key sideband
  // (404 call_id_not_found), which killed tools mid-call on 2026-08-19. Fall back through the model chain.
  let answerSdp = "", usedModel = "", lastErr = "";
  let ambiguousProvider: { detail: string; openaiCallId: string | null } | null = null;
  providerCreateController = new AbortController();
  const providerCreateDeadline = setTimeout(
    () => providerCreateController.abort(),
    config.realtimeCreateTimeoutMs,
  );
  try {
    for (const model of chain) {
      let attemptCallId: string | null = null;
      try {
      const form = new FormData();
      form.set("sdp", sdpOffer);
      // One explicit turn-control mode (voice-orchestration contract): semantic VAD with
      // low eagerness owns ordinary user turns — server-created responses, native
      // barge-in. The application never creates a response for a normal user turn.
      form.set("session", JSON.stringify(buildRealtimeSessionConfig({
        model,
        instructions,
        tools: toolSchemasForSessionType(sessionType),
        voice: sessionType === "onboarding" ? "ash" : config.voice,
        openingMode,
      })));
      const callRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiKey}` },
        body: form,
        signal: providerCreateController.signal,
      });
      const candidateCallId = (callRes.headers.get("Location") ?? "").split("/").pop() ?? "";
      attemptCallId = candidateCallId || null;
      if (candidateCallId) {
        openaiCallId = candidateCallId;
        startupPhase = "provider_accepted";
      }
      if (!callRes.ok) {
        const responseText = await callRes.text();
        const detail = `sdp ${model}: ${callRes.status} ${responseText}`;
        if (callRes.status >= 400 && callRes.status < 500 && !candidateCallId) {
          lastErr = detail;
          continue; // explicit non-acceptance: this model did not create a call
        }
        ambiguousProvider = { detail, openaiCallId: candidateCallId || null };
        break;
      }
      if (!candidateCallId) {
        ambiguousProvider = { detail: `no_call_id ${model}`, openaiCallId: null };
        break;
      }
      const candidateAnswerSdp = await callRes.text();
      if (!candidateAnswerSdp.trim()) {
        ambiguousProvider = { detail: `empty_sdp ${model}`, openaiCallId: candidateCallId };
        break;
      }
      answerSdp = candidateAnswerSdp;
      openaiCallId = candidateCallId;
      usedModel = model;
      break;
      } catch (e: any) {
        ambiguousProvider = {
          detail: `${model}: ${e?.message}`,
          openaiCallId: attemptCallId,
        };
        break;
      }
    }
  } finally {
    clearTimeout(providerCreateDeadline);
    providerCreateController = null;
  }
  await stopIfCancelled();
  if (ambiguousProvider) {
    await settleStartupFailure("provider_outcome_unknown", "unknown", {
      openaiCallId: ambiguousProvider.openaiCallId,
      mode: "hangup",
    }, externalCostUsd);
    throw Object.assign(new Error("provider_outcome_unknown"), {
      status: 502,
      detail: ambiguousProvider.detail,
    });
  }
  if (!usedModel) {
    await settleStartupFailure(
      "realtime_unavailable",
      "not_applicable",
      undefined,
      externalCostUsd,
    );
    throw Object.assign(new Error("realtime_unavailable"), { status: 502, detail: lastErr });
  }

  const providerIdentityProven = await persistRealtimeProviderIdentity({
    callId: call.id,
    tenantId: tenant.id,
    openaiCallId,
    model: usedModel,
  });
  await stopIfCancelled();
  if (!providerIdentityProven) {
    await settleStartupFailure(
      "provider_identity_unproven",
      "unknown",
      { openaiCallId, mode: "hangup" },
      externalCostUsd,
    );
    throw Object.assign(
      new Error("provider_identity_unproven"),
      { status: 503 },
    );
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
              ...(openingPayload ? { openingPayload } : {}),
              ...(onboardingResume ? { resume: onboardingResume } : {}),
            },
            externalCostUsd,
          }
        : {},
    );
    cleanupControl.startupComplete = true;
  } catch (error) {
    if (startupCancelled) await stopIfCancelled();
    await settleStartupFailure(
      "sideband_attach_failed",
      "unknown",
      { openaiCallId, mode: "hangup" },
      externalCostUsd,
    );
    throw error;
  }
  startupPhase = "sideband";
  if (openingMode !== "application_tts_v1") registerCleanup?.(cleanupControl);
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  if (openingMode === "application_tts_v1")
    try {
      await Promise.race([
        sidebandControl!.opened,
        new Promise<never>((_resolve, reject) => {
          openTimer = setTimeout(
            () => reject(new Error("sideband_open_timeout")),
            config.sidebandOpenTimeoutMs,
          );
        }),
      ]);
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
    opening_payload: openingPayload,
  };
}

export function buildRealtimeSessionConfig(args: {
  model: string;
  instructions: string;
  tools: unknown[];
  voice: string;
  openingMode: OnboardingOpeningMode;
}) {
  const applicationOwned = args.openingMode === "application_tts_v1";
  return {
    type: "realtime",
    model: args.model,
    instructions: args.instructions,
    tools: args.tools,
    tool_choice: "auto",
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
