// Outbound-only browser session servicing: the public Edge Function enqueues browser_session_requests;
// this listener (Realtime + poll, zero inbound ports) claims each row race-safely and runs the SAME
// canonical startSession used by the local HTTP path — one implementation, two transports.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { supa } from "./rules.ts";
import type { SessionType } from "./instructions.ts";

type StartSession = (userId: string, sessionType: SessionType, sdpOffer: string, modelOverride?: string, tenantId?: string) => Promise<{ sdp: string; call_id: string }>;

export function startBrowserRequestListener(startSession: StartSession) {
  if (!config.openaiKey) return;
  const rt = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false } });
  rt.channel("browser-session-requests")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "browser_session_requests" }, (payload) => {
      void handle(payload.new as any, startSession).catch((e) => console.error("browser request failed", e));
    })
    .subscribe();
  // safety net for rows missed while offline
  setInterval(async () => {
    const { data } = await supa().from("browser_session_requests").select("*").eq("status", "pending")
      .lt("created_at", new Date(Date.now() - 2_000).toISOString()).limit(3);
    for (const row of data ?? []) await handle(row, startSession).catch(() => {});
  }, 4_000);
  console.log("browser session listener active (realtime + poll)");
}

async function handle(row: any, startSession: StartSession) {
  const { data: claimed } = await supa().from("browser_session_requests")
    .update({ status: "processing", handled_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "pending").select("id");
  if (!claimed?.length) return; // another controller instance won the race

  try {
    // The row's tenant_id is what the Edge Function resolved for the AUTHENTICATED
    // owner; startSession re-verifies ownership against a fresh read.
    const out = await startSession(
      row.user_id,
      (row.session_type ?? "owner_browser") as SessionType,
      row.offer_sdp,
      row.model_override ?? undefined,
      row.tenant_id ?? undefined,
    );
    await supa().from("browser_session_requests")
      .update({ status: "ready", answer_sdp: out.sdp, call_id: out.call_id }).eq("id", row.id);
  } catch (e: any) {
    await supa().from("browser_session_requests")
      .update({ status: "error", error: String(e?.message ?? e).slice(0, 400) }).eq("id", row.id);
  }
}

// test seam: exercised directly by the tenancy suite
export const _handleBrowserRequest = handle;
