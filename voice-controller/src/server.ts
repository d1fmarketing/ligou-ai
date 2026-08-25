// Voice controller HTTP surface.
// POST /session: owner-authenticated bootstrap — budget reservation, call row, ephemeral client secret (ek_) with the
// full per-tenant session config, SDP exchange proxied to OpenAI, sideband attach. The browser never sees any key.
import { config } from "./config.ts";
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
  [key: string]: unknown;
};
type StartSessionLike = (
  userId: string,
  sessionType: SessionType,
  sdpOffer: string,
  modelOverride?: string,
  tenantId?: string,
) => Promise<DirectSessionResult>;

export async function startDirectSessionRequest(
  args: {
    userId: string;
    sessionType: SessionType;
    sdpOffer: string;
    modelOverride?: string;
  },
  dependencies: {
    client?: any;
    nowIso?: () => string;
    resolveSessionTenantImpl?: typeof resolveSessionTenant;
    startSessionImpl?: StartSessionLike;
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
      status: "processing",
      handled_at: (dependencies.nowIso ?? (() => new Date().toISOString()))(),
    })
    .select("id")
    .single();
  if (insertError || !requestRow?.id)
    throw Object.assign(new Error("direct_onboarding_request_insert_failed"), {
      status: 503,
    });

  try {
    const result = await startSessionImpl(
      args.userId,
      "onboarding",
      args.sdpOffer,
      args.modelOverride,
      tenant.id,
    );
    const readyWrite = await client
      .from("browser_session_requests")
      .update({
        status: "ready",
        answer_sdp: result.sdp,
        call_id: result.call_id,
      })
      .eq("id", requestRow.id);
    if (readyWrite.error)
      throw Object.assign(
        new Error("direct_onboarding_request_ready_failed"),
        { status: 503 },
      );
    return result;
  } catch (error) {
    try {
      await client
        .from("browser_session_requests")
        .update({
          status: "error",
          error: String(
            error instanceof Error ? error.message : error,
          ).slice(0, 400),
        })
        .eq("id", requestRow.id);
    } catch {}
    throw error;
  }
}

export async function startSession(userId: string, sessionType: SessionType, sdpOffer: string, modelOverride?: string, tenantId?: string) {
  const { tenant, rules } = await resolveSessionTenant(userId, tenantId);

  const ALLOWED_MODELS = new Set(["gpt-realtime", "gpt-realtime-2.1", "gpt-realtime-2.1-mini"]);
  // Primary model, then automatic fallback (RJ 2026-08-19: 2.1 primary, mini as fallback).
  const primary = modelOverride && ALLOWED_MODELS.has(modelOverride) ? modelOverride : config.model;
  const chain = primary === config.fallbackModel ? [primary] : [primary, config.fallbackModel];
  const sessionCeiling = config.sessionCostCeilingUsd;

  // call row first (budget RPC references it)
  const { data: call, error: ce } = await supa()
    .from("calls")
    .insert({ tenant_id: tenant.id, channel: "browser", session_type: sessionType, model: primary, status: "active" })
    .select("id")
    .single();
  if (ce || !call) throw new Error(`call_insert_failed: ${ce?.message}`);

  // atomic budget reservation — hard gate
  try {
    await reserveCallBudget(tenant.id, call.id, sessionCeiling);
  } catch (error: any) {
    await supa().from("calls").update({ status: "killed_budget", ended_at: new Date().toISOString() }).eq("id", call.id);
    throw error;
  }

  const settleStartupFailure = async (
    reason: string,
    usageState: "not_applicable" | "unknown" | "resolved",
    provider?: { openaiCallId: string | null; mode: "hangup" | "reject" },
  ) => {
    const usageResolved = usageState === "not_applicable" || usageState === "resolved";
    const terminalWrite = await supa().from("calls").update({
      status: "error",
      ended_at: new Date().toISOString(),
      duration_seconds: 0,
      cost_estimate_usd: usageResolved ? 0 : null,
      provider_termination_state: provider ? (provider.openaiCallId ? "active" : "unknown") : "not_required",
      provider_termination_mode: provider?.mode ?? null,
      provider_termination_reason: reason,
      provider_usage_state: usageState,
    }).eq("id", call.id);
    if (terminalWrite.error) return false;
    return await finalizeTerminalBudget({
      tenantId: tenant.id,
      callId: call.id,
      actualCostUsd: 0,
      minutes: 0,
      outcome: "startup_error",
      detail: { reason },
      provider: provider ? { ...provider, reason } : undefined,
      usageResolved,
    });
  };

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

  // Unified interface (official server flow): ONE multipart POST with the STANDARD key. No ephemeral ek_ —
  // we proxy the SDP ourselves, and calls created under an ek_ are invisible to the standard-key sideband
  // (404 call_id_not_found), which killed tools mid-call on 2026-08-19. Fall back through the model chain.
  let answerSdp = "", openaiCallId = "", usedModel = "", lastErr = "";
  let ambiguousProvider: { detail: string; openaiCallId: string | null } | null = null;
  for (const model of chain) {
    let attemptCallId: string | null = null;
    try {
      const form = new FormData();
      form.set("sdp", sdpOffer);
      // One explicit turn-control mode (voice-orchestration contract): semantic VAD with
      // low eagerness owns ordinary user turns — server-created responses, native
      // barge-in. The application never creates a response for a normal user turn.
      form.set("session", JSON.stringify({
        type: "realtime",
        model,
        instructions,
        tools: toolSchemasForSessionType(sessionType),
        tool_choice: "auto",
        audio: {
          input: { turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true } },
          output: { voice: config.voice },
        },
      }));
      const callRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiKey}` },
        body: form,
      });
      const candidateCallId = (callRes.headers.get("Location") ?? "").split("/").pop() ?? "";
      attemptCallId = candidateCallId || null;
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
      ambiguousProvider = { detail: `${model}: ${e?.message}`, openaiCallId: attemptCallId };
      break;
    }
  }
  if (ambiguousProvider) {
    await settleStartupFailure("provider_outcome_unknown", "unknown", {
      openaiCallId: ambiguousProvider.openaiCallId,
      mode: "hangup",
    });
    throw Object.assign(new Error("provider_outcome_unknown"), {
      status: 502,
      detail: ambiguousProvider.detail,
    });
  }
  if (!usedModel) {
    await settleStartupFailure("realtime_unavailable", "not_applicable");
    throw Object.assign(new Error("realtime_unavailable"), { status: 502, detail: lastErr });
  }

  await supa().from("calls").update({
    openai_call_id: openaiCallId,
    model: usedModel,
    provider_termination_state: "active",
    provider_termination_mode: "hangup",
    provider_usage_state: "unknown",
  }).eq("id", call.id);
  try {
    attachSideband(cap, openaiCallId, usedModel);
  } catch (error) {
    await settleStartupFailure("sideband_attach_failed", "unknown", { openaiCallId, mode: "hangup" });
    throw error;
  }

  return { sdp: answerSdp, call_id: call.id, max_minutes: maxMinutes, model: usedModel, fell_back: usedModel !== primary };
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
          const body = (await req.json()) as { sdp?: string; session_type?: SessionType; model?: string };
          if (!body.sdp) return Response.json({ error: "sdp_required" }, { status: 400, headers: CORS });
          const out = await startDirectSessionRequest({
            userId: owner.userId,
            sessionType: body.session_type ?? "owner_browser",
            sdpOffer: body.sdp,
            modelOverride: body.model,
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
