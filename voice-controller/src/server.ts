// Voice controller HTTP surface.
// POST /session: owner-authenticated bootstrap — budget reservation, call row, ephemeral client secret (ek_) with the
// full per-tenant session config, SDP exchange proxied to OpenAI, sideband attach. The browser never sees any key.
import { config } from "./config.ts";
import { buildInstructions, type SessionType } from "./instructions.ts";
import { loadTenant, supa } from "./rules.ts";
import { makeCapability, toolSchemas } from "./tools.ts";
import { attachSideband, liveSessions } from "./sideband.ts";
import { requireTenantOwner } from "../../shared/tenant-ownership.ts";

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

export async function startSession(userId: string, sessionType: SessionType, sdpOffer: string, modelOverride?: string) {
  const ownedTenant = await requireTenantOwner(supa(), config.defaultTenantSlug, userId);
  const { tenant, rules } = await loadTenant(config.defaultTenantSlug);
  // The ownership read is intentionally fresh and occurs before any call or reservation write.
  tenant.owner_user_id = ownedTenant.owner_user_id;

  const ALLOWED_MODELS = new Set(["gpt-realtime", "gpt-realtime-2.1", "gpt-realtime-2.1-mini"]);
  // Primary model, then automatic fallback (RJ 2026-08-19: 2.1 primary, mini as fallback).
  const primary = modelOverride && ALLOWED_MODELS.has(modelOverride) ? modelOverride : config.model;
  const chain = primary === config.fallbackModel ? [primary] : [primary, config.fallbackModel];
  const estCost = primary === "gpt-realtime-2.1-mini" ? 0.35 : 1.0; // reserve for the pricier primary

  // call row first (budget RPC references it)
  const { data: call, error: ce } = await supa()
    .from("calls")
    .insert({ tenant_id: tenant.id, channel: "browser", session_type: sessionType, model: primary, status: "active" })
    .select("id")
    .single();
  if (ce || !call) throw new Error(`call_insert_failed: ${ce?.message}`);

  // atomic budget reservation — hard gate
  const { error: be } = await supa().rpc("reserve_call_budget", { p_tenant: tenant.id, p_call: call.id, p_est_cost: estCost });
  if (be) {
    await supa().from("calls").update({ status: "killed_budget", ended_at: new Date().toISOString() }).eq("id", call.id);
    throw Object.assign(new Error(`budget_exceeded`), { status: 402, detail: be.message });
  }

  if (!config.openaiKey) throw Object.assign(new Error("openai_key_missing"), { status: 503 });

  const instructions = buildInstructions(tenant, rules, sessionType);
  const maxMinutes = sessionType === "onboarding" ? 30 : (tenant.session_max_minutes ?? config.sessionMaxMinutes);
  const cap = makeCapability(tenant.slug, tenant.id, call.id, maxMinutes, sessionType);

  // Unified interface (official server flow): ONE multipart POST with the STANDARD key. No ephemeral ek_ —
  // we proxy the SDP ourselves, and calls created under an ek_ are invisible to the standard-key sideband
  // (404 call_id_not_found), which killed tools mid-call on 2026-08-19. Fall back through the model chain.
  let answerSdp = "", openaiCallId = "", usedModel = "", lastErr = "";
  for (const model of chain) {
    try {
      const form = new FormData();
      form.set("sdp", sdpOffer);
      form.set("session", JSON.stringify({ type: "realtime", model, instructions, tools: toolSchemas, tool_choice: "auto", audio: { output: { voice: config.voice } } }));
      const callRes = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiKey}` },
        body: form,
      });
      if (!callRes.ok) { lastErr = `sdp ${model}: ${callRes.status} ${await callRes.text()}`; continue; }
      answerSdp = await callRes.text();
      openaiCallId = (callRes.headers.get("Location") ?? "").split("/").pop() ?? "";
      if (!openaiCallId) { lastErr = `no_call_id ${model}`; continue; }
      usedModel = model;
      break;
    } catch (e: any) { lastErr = `${model}: ${e?.message}`; }
  }
  if (!usedModel) {
    await supa().from("calls").update({ status: "error", ended_at: new Date().toISOString() }).eq("id", call.id);
    throw Object.assign(new Error("realtime_unavailable"), { status: 502, detail: lastErr });
  }

  await supa().from("calls").update({ openai_call_id: openaiCallId, model: usedModel }).eq("id", call.id);
  attachSideband(cap, openaiCallId, usedModel);

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
          const out = await startSession(owner.userId, body.session_type ?? "owner_browser", body.sdp, body.model);
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
