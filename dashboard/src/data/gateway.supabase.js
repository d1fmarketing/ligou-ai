// Real gateway: same 10 async signatures as gateway.js, backed by Supabase (owner-scoped RLS + hardened RPCs).
// The prototype's model.js remains the vocabulary; here every decision flows through server RPCs.
import { supabase } from "../lib/supabase.js";
import { decideMemoryVia } from "./memory-decisions.js";

const SCOPE_TO_DB = {
  service: "servico", "serviço": "servico", servico: "servico",
  location: "localizacao", "localização": "localizacao", localizacao: "localizacao",
  client: "cliente", cliente: "cliente",
  general: "geral", geral: "geral",
};
const STATUS_FROM_DB = { aprovado: "ativa", sugerido: "sugerida", revogado: "revogada", rejeitado: "rejeitada" };

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

function mapRuleGroups(rules) {
  // latest version per rule_group_id wins; earlier versions become history
  const groups = new Map();
  for (const r of rules) {
    const g = groups.get(r.rule_group_id) ?? [];
    g.push(r);
    groups.set(r.rule_group_id, g);
  }
  const entries = [];
  for (const versions of groups.values()) {
    versions.sort((a, b) => a.version - b.version);
    const latest = versions[versions.length - 1];
    if (latest.status === "rejeitado") continue; // rejected suggestions disappear from the working memory list
    const status = latest.structured?.effective_until ? "temporária" : (STATUS_FROM_DB[latest.status] ?? latest.status);
    entries.push({
      id: latest.id,
      title: latest.category === "preco" ? `Preço · ${latest.structured?.service_type ?? ""}` : latest.category,
      text: latest.text,
      category: latest.category,
      structured: latest.structured ?? null,
      status,
      origin: { onboarding: "Entrevista de onboarding", escalacao: "Aprovação de caso", edicao_manual: "Edição manual", aprendizado: "Aprendizado em chamada" }[latest.origem] ?? latest.origem,
      scope: latest.escopo,
      version: latest.version,
      evidenceQuote: latest.evidence_quote ?? null,
      effectiveFrom: latest.approved_at?.slice(0, 10) ?? null,
      approvedBy: latest.approved_by ? "Você" : null,
      updatedAt: latest.created_at,
      history: versions.slice(0, -1).map((v, i) => ({
        version: v.version,
        changedAt: versions[i + 1].created_at,
        before: v.text,
        after: versions[i + 1].text,
      })),
    });
  }
  entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return entries;
}

function mapCase(c) {
  return {
    id: c.id,
    clientName: c.client_name || "Cliente da ligação",
    request: c.request,
    note: c.evidence_quote ? `Fala do cliente: “${c.evidence_quote}”` : null,
    rule: c.rule_text ?? null,
    proposedAction: c.proposed_action,
    consequence: c.price_quoted ? `Valor citado: $${c.price_quoted}` : null,
    status: { pendente: "pendente", aprovada: "aprovada", recusada: "recusada", expirada: "recusada" }[c.status] ?? c.status,
    location: null,
    language: null,
    urgency: c.urgency,
    date: c.created_at?.slice(0, 10),
    createdAt: c.created_at,
    updatedAt: c.resolved_at ?? c.created_at,
    relatedCallId: c.call_id,
    adjustments: c.resolution?.adjustments ?? [],
  };
}

// The tenant identity comes exclusively from the authoritative bootstrap
// (ensure_owner_tenant); this gateway never picks "the first tenant row".
let activeTenantId = null;

async function fetchAll() {
  if (!activeTenantId) return { state: null, warning: "Sua conta ainda não terminou de carregar. Recarregue a página." };
  const [{ data: tenants, error: te }, { data: rules }, { data: cases }, { data: calls }, { data: notifications }] = await Promise.all([
    supabase.from("tenants").select("*").eq("id", activeTenantId),
    supabase.from("rules").select("*").eq("tenant_id", activeTenantId).order("created_at", { ascending: true }),
    supabase.from("approval_cases").select("*").eq("tenant_id", activeTenantId).order("created_at", { ascending: false }).limit(50),
    supabase.from("calls").select("id,channel,session_type,started_at,ended_at,duration_seconds,summary_pt,summary_status,cost_estimate_usd,model,status").eq("tenant_id", activeTenantId).order("started_at", { ascending: false }).limit(20),
    supabase.from("notifications").select("*").eq("tenant_id", activeTenantId).order("created_at", { ascending: false }).limit(20),
  ]);
  if (te) throw new Error(te.message);
  const tenant = tenants?.[0];
  if (!tenant) return { state: null, warning: "Não foi possível carregar a sua empresa. Saia e entre novamente." };

  const approvals = (cases ?? []).map(mapCase);
  const memory = mapRuleGroups(rules ?? []);

  const messages = [];
  for (const call of (calls ?? []).slice(0, 8).reverse()) {
    if (call.session_type === "eval") continue;
    messages.push({
      id: `call-${call.id}`,
      role: "agent",
      label: "Ligou · registro de chamada",
      text: call.summary_status === "ready" && call.summary_pt
        ? call.summary_pt
        : call.ended_at
          ? `Chamada de ${Math.round((call.duration_seconds ?? 0) / 60)} min encerrada (${call.model ?? "voz"}). Resumo em preparação.`
          : "Chamada de voz em andamento…",
      time: fmtTime(call.started_at),
      timestamp: call.started_at,
    });
  }
  for (const n of (notifications ?? []).slice(0, 6).reverse()) {
    if (n.kind === "usage_70" || n.kind === "usage_90") {
      messages.push({
        id: `notif-${n.id}`, role: "system",
        text: `Aviso de uso: ${n.payload?.pct ?? "?"}% dos ${n.payload?.plan_minutes ?? 400} minutos do plano já utilizados (${n.payload?.minutes_used ?? "?"} min).`,
        time: fmtTime(n.created_at), timestamp: n.created_at,
      });
    }
  }
  messages.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  const pending = approvals.filter((a) => a.status === "pendente");
  const state = {
    schemaVersion: 2,
    revision: Date.now(),
    fixtureDate: new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString(),
    pendingApprovalCount: pending.length,
    business: {
      id: tenant.id,
      name: tenant.name,
      owner: "Você",
      status: tenant.status === "active" ? "ativo" : tenant.status,
      timezone: tenant.timezone,
      serviceArea: tenant.vertical ?? "",
      languages: tenant.languages ?? [],
    },
    callContext: pending[0]
      ? { id: pending[0].relatedCallId ?? pending[0].id, clientName: pending[0].clientName, language: "", location: "", date: pending[0].date, request: pending[0].request, note: pending[0].note, rule: pending[0].rule, status: "aguardando" }
      : null,
    messages,
    memory,
    approvals,
    revocationReceipts: [],
  };
  return { state };
}

export function createSupabaseGateway() {
  let channel = null;
  return {
    setTenant(tenantId) {
      activeTenantId = typeof tenantId === "string" && tenantId ? tenantId : null;
    },

    async loadState() {
      try { return await fetchAll(); } catch (e) { return { state: null, warning: e.message }; }
    },

    subscribe(onChange) {
      if (channel || !supabase) return () => {};
      channel = supabase
        .channel("dashboard-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "approval_cases" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "rules" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, onChange)
        .subscribe();
      return () => { supabase.removeChannel(channel); channel = null; };
    },

    async sendMessage(text) {
      const { state } = await fetchAll();
      const now = new Date();
      const userMessage = { id: `local-${now.getTime()}`, role: "owner", text, time: fmtTime(now.toISOString()), timestamp: now.toISOString() };
      const agentMessage = {
        id: `local-agent-${now.getTime()}`, role: "agent",
        text: "Nesta fase, fale comigo por VOZ (botão de microfone) — o chat de texto com o cérebro do Ligou chega junto com a fase de aprendizado. Aprovações e regras já funcionam de verdade nas outras abas.",
        time: fmtTime(now.toISOString()), timestamp: now.toISOString(),
      };
      if (state) state.messages = [...state.messages, userMessage, agentMessage];
      return { state, userMessage, agentMessage };
    },

    async resetPrototype() {
      const { state } = await fetchAll();
      return { state, warning: "Este painel usa dados reais — não há demonstração para restaurar." };
    },

    async listMemory({ search, query, status, category } = {}) {
      const { state } = await fetchAll();
      const q = (search ?? query ?? "").toLowerCase();
      let entries = state?.memory ?? [];
      if (q) entries = entries.filter((e) => `${e.title} ${e.text}`.toLowerCase().includes(q));
      if (status && status !== "all") entries = entries.filter((e) => e.status === status);
      if (category && category !== "all") entries = entries.filter((e) => e.category === category);
      return { state, entries };
    },

    async updateMemory(memoryId, patch) {
      const { data, error } = await supabase.rpc("edit_rule", { p_rule: memoryId, p_text: patch.text });
      if (error) return { state: (await fetchAll()).state, warning: error.message };
      const { state } = await fetchAll();
      const entry = state.memory.find((m) => m.id === data) ?? null;
      return { state, entry, comparison: null };
    },

    async revokeMemory(memoryId, reason) {
      const { data, error } = await supabase.rpc("revoke_rule", { p_rule: memoryId, p_reason: reason ?? "revogada pelo dono" });
      if (error) return { state: (await fetchAll()).state, warning: error.message };
      const { state } = await fetchAll();
      return { state, entry: state.memory.find((m) => m.id === data) ?? null, receipt: { id: data } };
    },

    async approveMemory(memoryId) {
      try {
        const newVersionId = await decideMemoryVia(supabase, memoryId, "aprovado");
        const { state } = await fetchAll();
        return { state, entry: state.memory.find((m) => m.id === newVersionId) ?? null };
      } catch (e) {
        return { state: (await fetchAll()).state, warning: e.message };
      }
    },

    async rejectMemory(memoryId) {
      try {
        await decideMemoryVia(supabase, memoryId, "rejeitado");
        const { state } = await fetchAll();
        return { state, entry: null };
      } catch (e) {
        return { state: (await fetchAll()).state, warning: e.message };
      }
    },

    async listApprovals({ search, query, status } = {}) {
      const { state } = await fetchAll();
      const q = (search ?? query ?? "").toLowerCase();
      let approvals = state?.approvals ?? [];
      if (q) approvals = approvals.filter((a) => `${a.clientName} ${a.request}`.toLowerCase().includes(q));
      if (status && status !== "all") approvals = approvals.filter((a) => a.status === status);
      return { state, approvals };
    },

    async approveApproval(approvalId, { mode, scope, duration, ruleText } = {}) {
      const dbMode = mode === "rule" || mode === "regra" ? "rule" : "case";
      const args = {
        p_case: approvalId,
        p_decision: "aprovada",
        p_mode: dbMode,
        p_scope: SCOPE_TO_DB[scope] ?? "geral",
        p_duration: duration ?? "permanente",
      };
      if (dbMode === "rule") {
        const { state: pre } = await fetchAll();
        const approval = pre?.approvals.find((a) => a.id === approvalId);
        args.p_rule_text = ruleText || approval?.proposedAction || approval?.request || "Regra aprovada a partir de um caso.";
        args.p_rule_structured = { category: "escalacao", from_case: approvalId };
      }
      const { data, error } = await supabase.rpc("decide_case", args);
      if (error) return { state: (await fetchAll()).state, warning: error.message };
      const { state } = await fetchAll();
      return {
        state,
        approval: state.approvals.find((a) => a.id === approvalId) ?? null,
        memoryEntry: data?.rule_id ? state.memory.find((m) => m.id === data.rule_id) ?? null : null,
        systemMessage: null,
      };
    },

    async adjustApproval(approvalId, proposal) {
      const { error } = await supabase.rpc("adjust_case", { p_case: approvalId, p_proposal: proposal });
      if (error) return { state: (await fetchAll()).state, warning: error.message };
      const { state } = await fetchAll();
      return { state, approval: state.approvals.find((a) => a.id === approvalId) ?? null, adjustment: { after: proposal }, systemMessage: null };
    },

    async rejectApproval(approvalId, reason) {
      const { error } = await supabase.rpc("decide_case", { p_case: approvalId, p_decision: "recusada" });
      if (error) return { state: (await fetchAll()).state, warning: error.message };
      const { state } = await fetchAll();
      return { state, approval: state.approvals.find((a) => a.id === approvalId) ?? null, systemMessage: null, reason };
    },
  };
}

export const supabaseGateway = createSupabaseGateway();
