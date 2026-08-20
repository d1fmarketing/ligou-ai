// F6: phone listener — reacts to phone_events via Supabase Realtime (outbound-only; zero open ports),
// accepts the SIP call on OpenAI with the SAME canonical session config, then attaches the authoritative sideband.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { buildInstructions } from "./instructions.ts";
import { loadTenant, supa } from "./rules.ts";
import { makeCapability, toolSchemas } from "./tools.ts";
import { attachSideband } from "./sideband.ts";

export function startPhoneListener() {
  if (!config.openaiKey) return;
  const rt = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false } });
  rt.channel("phone-events")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "phone_events" }, (payload) => {
      void handleIncoming(payload.new as any).catch((e) => console.error("phone accept failed", e));
    })
    .subscribe();
  // safety net: poll for rows missed while offline
  setInterval(async () => {
    const { data } = await supa().from("phone_events").select("*").eq("status", "pending")
      .lt("created_at", new Date(Date.now() - 3_000).toISOString()).limit(3);
    for (const row of data ?? []) await handleIncoming(row).catch(() => {});
  }, 5_000);
  console.log("phone listener active (realtime + poll)");
}

async function handleIncoming(row: any) {
  // claim the row (race-safe against the poll/realtime double path)
  const { data: claimed } = await supa().from("phone_events")
    .update({ status: "accepted", handled_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "pending").select("id");
  if (!claimed?.length) return;

  // tenant by called number (single-tenant F6 start: default slug)
  const { tenant, rules } = await loadTenant(config.defaultTenantSlug);
  const model = config.model;

  const { data: call } = await supa().from("calls")
    .insert({ tenant_id: tenant.id, channel: "phone", session_type: "customer", model, status: "active", openai_call_id: row.openai_call_id })
    .select("id").single();
  const { error: be } = await supa().rpc("reserve_call_budget", { p_tenant: tenant.id, p_call: call!.id, p_est_cost: 0.35 });
  if (be) {
    await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(row.openai_call_id)}/reject`, {
      method: "POST", headers: { Authorization: `Bearer ${config.openaiKey}` },
    }).catch(() => {});
    await supa().from("calls").update({ status: "killed_budget", ended_at: new Date().toISOString() }).eq("id", call!.id);
    return;
  }

  const instructions = buildInstructions(tenant, rules, "customer");
  const accept = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(row.openai_call_id)}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "realtime", model, instructions, tools: toolSchemas, tool_choice: "auto", audio: { output: { voice: config.voice } } }),
  });
  if (!accept.ok) {
    await supa().from("phone_events").update({ status: "error" }).eq("id", row.id);
    await supa().from("calls").update({ status: "error", ended_at: new Date().toISOString() }).eq("id", call!.id);
    throw new Error(`accept_failed: ${accept.status} ${await accept.text()}`);
  }
  await supa().from("phone_events").update({ tenant_id: tenant.id, call_id: call!.id }).eq("id", row.id);

  const cap = makeCapability(tenant.slug, tenant.id, call!.id, tenant.session_max_minutes ?? config.sessionMaxMinutes, "customer");
  attachSideband(cap, row.openai_call_id, model);
}
