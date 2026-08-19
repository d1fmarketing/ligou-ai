// Voice controller HTTP surface.
// POST /session: owner-authenticated bootstrap — budget reservation, call row, ephemeral client secret (ek_) with the
// full per-tenant session config, SDP exchange proxied to OpenAI, sideband attach. The browser never sees any key.
import { config } from "./config.ts";
import { buildInstructions, type SessionType } from "./instructions.ts";
import { loadTenant, supa } from "./rules.ts";
import { makeCapability, toolSchemas } from "./tools.ts";
import { attachSideband, liveSessions } from "./sideband.ts";

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
  const { tenant, rules } = await loadTenant(config.defaultTenantSlug);

  // first authenticated user claims the seed tenant (single-tenant F1)
  if (!tenant.owner_user_id) {
    await supa().from("tenants").update({ owner_user_id: userId }).eq("id", tenant.id).is("owner_user_id", null);
  } else if (tenant.owner_user_id !== userId) {
    throw Object.assign(new Error("not_tenant_owner"), { status: 403 });
  }

  const ALLOWED_MODELS = new Set(["gpt-realtime", "gpt-realtime-2.1", "gpt-realtime-2.1-mini"]);
  const model = modelOverride && ALLOWED_MODELS.has(modelOverride) ? modelOverride : config.model;
  const estCost = model === "gpt-realtime-2.1-mini" ? 0.35 : 1.0;

  // call row first (budget RPC references it)
  const { data: call, error: ce } = await supa()
    .from("calls")
    .insert({ tenant_id: tenant.id, channel: "browser", session_type: sessionType, model, status: "active" })
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

  // 1) ephemeral client secret embedding the whole session config
  const secretRes = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model,
        instructions,
        tools: toolSchemas,
        tool_choice: "auto",
        audio: { output: { voice: "marin" } },
      },
    }),
  });
  if (!secretRes.ok) throw new Error(`client_secret_failed: ${secretRes.status} ${await secretRes.text()}`);
  const ek = ((await secretRes.json()) as any).value as string;

  // 2) SDP exchange on behalf of the browser
  const callRes = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${ek}`, "Content-Type": "application/sdp" },
    body: sdpOffer,
  });
  if (!callRes.ok) throw new Error(`sdp_exchange_failed: ${callRes.status} ${await callRes.text()}`);
  const answerSdp = await callRes.text();
  const location = callRes.headers.get("Location") ?? "";
  const openaiCallId = location.split("/").pop() ?? "";
  if (!openaiCallId) throw new Error("no_call_id_in_location");

  await supa().from("calls").update({ openai_call_id: openaiCallId }).eq("id", call.id);

  // 3) authoritative sideband
  attachSideband(cap, openaiCallId, model);

  return {
    sdp: answerSdp,
    call_id: call.id,
    max_minutes: maxMinutes,
    model,
  };
}

if (import.meta.main) {
  const { startWorkerLoop } = await import("./worker.ts");
  startWorkerLoop();
  const { startPhoneListener } = await import("./phone.ts");
  startPhoneListener();
  Bun.serve({
    port: config.port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

      if (url.pathname === "/health") {
        return Response.json({ ok: true, live_sessions: liveSessions.size, model: config.model, openai: Boolean(config.openaiKey) }, { headers: CORS });
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
