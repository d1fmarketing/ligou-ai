// Public session bootstrap for the dashboard — works from anywhere, while the EC2 keeps ZERO inbound ports.
// Flow: verify owner JWT -> verify provisioned tenant -> insert browser_session_requests(pending) -> the controller
// (outbound-only) picks it up via Realtime, runs the canonical startSession (budget, ek_, SDP exchange,
// sideband) and writes the answer -> this function returns it to the browser. Same response contract as the
// local controller's POST /session, so the dashboard just points here in remote mode.
// Deploy: supabase functions deploy browser-session --no-verify-jwt   (JWT is verified explicitly below)
// Secrets: SERVICE_KEY=sb_secret_...  (SUPABASE_URL is injected by the platform)
import { createClient } from "@supabase/supabase-js";
import { resolveOwnedTenantForSession } from "../_shared/owned-tenant.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const DEFAULT_TENANT = Deno.env.get("LIGOU_TENANT") ?? "rocha-plumbing";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const url = Deno.env.get("SUPABASE_URL")!;
  const supa = createClient(url, Deno.env.get("SERVICE_KEY")!, { auth: { persistSession: false } });

  // 1) verify the owner's JWT against GoTrue
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: Deno.env.get("SERVICE_KEY")!, Authorization: auth } });
  if (!userRes.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  const user = await userRes.json();
  if (!user?.id) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });

  const body = await req.json().catch(() => ({}));
  if (!body.sdp) return Response.json({ error: "sdp_required" }, { status: 400, headers: CORS });

  // 2) read-only ownership resolution: the caller's OWN self-service tenant first,
  // the legacy env-slug tenant as fallback. Owner assignment still belongs solely
  // to the bootstrap RPC and the operator RPC.
  let tenant;
  try {
    tenant = await resolveOwnedTenantForSession(supa, user.id, DEFAULT_TENANT);
  } catch (error: any) {
    return Response.json({ error: error?.message ?? "ownership_check_failed" }, { status: error?.status ?? 500, headers: CORS });
  }

  // 3) enqueue the request; the controller does the rest
  const { data: reqRow, error: ie } = await supa.from("browser_session_requests").insert({
    tenant_id: tenant.id,
    user_id: user.id,
    session_type: body.session_type ?? "owner_browser",
    model_override: body.model ?? null,
    offer_sdp: String(body.sdp),
  }).select("id").single();
  if (ie || !reqRow) return Response.json({ error: `enqueue_failed: ${ie?.message}` }, { status: 500, headers: CORS });

  // 4) wait for the controller (Realtime wakes it in ~100-300ms; SDP exchange ~1s)
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const { data: row } = await supa.from("browser_session_requests")
      .select("status,answer_sdp,call_id,error").eq("id", reqRow.id).single();
    if (!row) break;
    if (row.status === "ready") {
      const { data: call } = await supa.from("calls").select("model").eq("id", row.call_id).single();
      return Response.json({ sdp: row.answer_sdp, call_id: row.call_id, max_minutes: body.session_type === "onboarding" ? 30 : 15, model: call?.model ?? null }, { headers: CORS });
    }
    if (row.status === "error") {
      const status = row.error?.includes("budget") ? 402 : 502;
      return Response.json({ error: row.error ?? "session_failed" }, { status, headers: CORS });
    }
  }
  await supa.from("browser_session_requests").update({ status: "expired" }).eq("id", reqRow.id).eq("status", "pending");
  return Response.json({ error: "controller_timeout", hint: "controller offline? check ligou-controller on the EC2" }, { status: 504, headers: CORS });
});
