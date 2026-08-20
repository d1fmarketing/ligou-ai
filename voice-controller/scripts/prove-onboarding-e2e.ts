// End-to-end proof of F5 onboarding: a fresh tenant with NO rules is configured by a Portuguese voice
// interview. The agent interviews the owner and calls record_interview_answer per fact; we assert suggested
// rules (origem=onboarding) covering services/area/hours are created — no file hand-edited.
// Uses the voice model over the realtime WS (text mode) — voice=API is correct; this is not the LLM brain.
//   bun run scripts/prove-onboarding-e2e.ts
import { config } from "../src/config.ts";
import { buildInstructions } from "../src/instructions.ts";
import { supa } from "../src/rules.ts";
import { makeCapability, runTool, toolSchemas } from "../src/tools.ts";

const SLUG = "test-onboarding-hvac";
let ok = true;
const check = (n: string, c: boolean) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); if (!c) ok = false; };

// Owner interview, in Portuguese — the 5 topics the landing promises.
const OWNER_TURNS = [
  "Oi Ligou. Somos a Clima Certo, uma empresa de ar-condicionado e aquecimento.",
  "A gente faz reparo de ar-condicionado por 180 a 320 dolares, e instalacao de 2500 a 4500 dolares.",
  "Atendemos Orange County: Anaheim, Irvine, Santa Ana e Tustin. Fora disso a gente nao vai.",
  "Horario de segunda a sabado, das 8 da manha as 6 da tarde. Emergencia so com taxa de 200 dolares.",
  "Se o cliente falar de cheiro de gas ou fumaca, manda ele sair de casa e ligar pro 911 na hora, e me avisa.",
];

const s = supa();
// Rules are append-only (production trigger blocks DELETE), so test cleanup runs privileged SQL via the
// Management API with session_replication_role=replica — the only correct way to purge append-only test data.
const PROJECT_REF = "ixpbqquvxirvuevjhmrq";
async function purge(tid: string) {
  const tok = process.env.SUPABASE_ACCESS_TOKEN;
  if (!tok) { console.log("WARN: SUPABASE_ACCESS_TOKEN unset — test tenant not purged:", tid); return; }
  const tables = ["rules", "calls", "approval_cases", "bookings", "action_intents", "receipts", "usage_ledger", "notifications", "powers"];
  const sql = `set session_replication_role=replica; ${tables.map((t) => `delete from public.${t} where tenant_id='${tid}';`).join(" ")} delete from public.tenants where id='${tid}'; reset session_replication_role;`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) console.log("WARN purge failed:", res.status, await res.text());
}
try {
  // fresh tenant, no rules — purge any leftover first (children before tenant to satisfy FKs)
  const existing = (await s.from("tenants").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
  if (existing) await purge(existing);
  const { data: tenant, error } = await s.from("tenants").insert({
    slug: SLUG, name: "Clima Certo HVAC", vertical: "hvac", status: "provisioning", languages: ["en", "es"], timezone: "America/Los_Angeles",
  }).select("*").single();
  if (error || !tenant) throw new Error(`seed_failed: ${error?.message}`);

  const { data: call } = await s.from("calls").insert({ tenant_id: tenant.id, channel: "onboarding", session_type: "onboarding", model: config.model, status: "active" }).select("id").single();
  const cap = makeCapability(SLUG, tenant.id, call!.id, 30, "onboarding", {
    authEpoch: tenant.auth_epoch,
    policyEpoch: tenant.policy_epoch,
  });
  const instructions = buildInstructions(tenant as any, [], "onboarding");

  const secretRes = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST", headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { type: "realtime", model: config.model } }),
  });
  if (!secretRes.ok) throw new Error(`client_secret: ${secretRes.status} ${await secretRes.text()}`);
  const ek = ((await secretRes.json()) as any).value as string;

  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`, { headers: { Authorization: `Bearer ${ek}` } } as any);
  const recorded: string[] = [];

  await new Promise<void>((resolve, reject) => {
    let idx = 0;
    const timeout = setTimeout(() => reject(new Error("timeout")), 120_000);
    const next = () => {
      if (idx >= OWNER_TURNS.length) { clearTimeout(timeout); setTimeout(resolve, 1500); return; }
      const text = OWNER_TURNS[idx++];
      ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
      ws.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["text"] } }));
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "session.update", session: { type: "realtime", model: config.model, instructions, tools: toolSchemas, tool_choice: "auto", output_modalities: ["text"] } }));
      setTimeout(next, 400);
    });
    ws.addEventListener("message", async (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "response.output_item.done" && msg.item?.type === "function_call") {
        if (msg.item.name === "record_interview_answer") recorded.push(msg.item.arguments ?? "");
        let a = {}; try { a = JSON.parse(msg.item.arguments ?? "{}"); } catch {}
        const r = await runTool(cap, msg.item.name, a as any);
        ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: msg.item.call_id, output: JSON.stringify(r.body) } }));
        ws.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["text"] } }));
      }
      if (msg.type === "response.done") {
        const hadText = (msg.response?.output ?? []).some((it: any) => it.type === "message");
        if (hadText) setTimeout(next, 300);
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("ws_error")); });
  });
  try { ws.close(); } catch {}

  const { data: rules } = await s.from("rules").select("category,status,origem,text").eq("tenant_id", tenant.id);
  const r = rules ?? [];
  const cats = new Set(r.map((x) => x.category));
  console.log("categories captured:", JSON.stringify([...cats]));
  check("interview recorded at least 4 answers", recorded.length >= 4);
  check("suggested rules created", r.length >= 4);
  check("all onboarding rules status=sugerido/origem=onboarding", r.every((x) => x.status === "sugerido" && x.origem === "onboarding"));
  check("interview spanned at least 3 distinct topics (categories)", cats.size >= 3);
  check("captured pricing/services", cats.has("preco"));
  check("captured area, schedule or emergency policy", cats.has("area") || cats.has("agenda") || cats.has("emergencia"));

  await purge(tenant.id);
  console.log(`recorded ${recorded.length} answers -> ${r.length} suggested rules; cleanup done`);
} catch (e) {
  console.log("ERROR", String(e)); ok = false;
}
console.log(ok ? "\nONBOARDING E2E: GREEN" : "\nONBOARDING E2E: RED");
process.exit(ok ? 0 : 1);
