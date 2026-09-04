// Real gateway: same 10 async signatures as gateway.js, backed by Supabase (owner-scoped RLS + hardened RPCs).
// The prototype's model.js remains the vocabulary; here every decision flows through server RPCs.
import { supabase } from "../lib/supabase.js";
import { decideMemoryVia } from "./memory-decisions.js";
import {
  isFreshTestResetReadback,
  mapRuleGroups,
  projectRowsAfterTestReset,
  scopeUsageAlertQuery,
} from "./gateway-rule-mapping.js";
import { buildDiscoveryReviewRequest, mapDiscoveryRead } from "../discovery-model.js";
import { mapWebsiteSetupStatus, mapWebsiteSetupPublicDetails, validateWebsiteUrl } from "../website-setup-model.js";

const DISCOVERY_ERROR_COPY = {
  company_discovery_stale_version: "A descoberta mudou enquanto você revisava. Recarregue antes de confirmar.",
  company_discovery_review_result_not_owner: "Este resultado não é mais a revisão atual. Recarregue o painel.",
  company_discovery_claim_already_reviewed: "Uma destas sugestões já foi revisada. Recarregue o painel para ver o estado atual.",
  company_discovery_review_not_awaiting: "Esta descoberta não está mais aguardando revisão. Recarregue o painel.",
  company_discovery_review_claim_set_invalid: "O conjunto de sugestões mudou. Recarregue o painel antes de confirmar.",
  company_discovery_review_claim_set_mismatch: "O conjunto de sugestões mudou. Recarregue o painel antes de confirmar.",
  company_discovery_review_nonce_invalid: "A confirmação expirou ou foi invalidada. Recarregue o painel e confirme novamente.",
  company_discovery_review_nonce_race_lost: "Esta confirmação já foi usada. Recarregue o painel antes de tentar novamente.",
  company_discovery_operational_confirmation_required: "Confirme explicitamente o grupo operacional.",
  company_discovery_safety_evidence_ack_required: "Confirme a evidência exata de cada item de segurança.",
  company_discovery_owner_private_fact_forbidden: "Assuntos privados só podem ser respondidos na entrevista.",
  company_discovery_disabled: "A leitura automática do site está desativada. A entrevista continua disponível.",
  company_discovery_tenant_not_allowlisted: "A leitura automática do site não está disponível para esta empresa. A entrevista continua disponível.",
  company_discovery_deadline_expired: "O tempo da leitura terminou. A entrevista continua disponível.",
  company_discovery_url_change_blocked: "Uma análise já está em andamento. Aguarde a conclusão antes de trocar o endereço.",
  company_discovery_candidate_context_empty: "O site não produziu informações nem perguntas utilizáveis.",
};

function discoveryError(error) {
  const code = error?.message || "company_discovery_failed";
  const mapped = new Error(DISCOVERY_ERROR_COPY[code] || code);
  mapped.code = code;
  return mapped;
}

async function discoveryRpc(client, name, payload) {
  const { data, error } = await client.rpc(name, payload);
  if (error) throw discoveryError(error);
  return data;
}

export async function submitCompanyDiscoveryVia(client, url, idempotencyKey) {
  return discoveryRpc(client, "submit_company_discovery", {
    p_url: url,
    p_idempotency_key: idempotencyKey,
  });
}

export async function loadWebsiteSetupVia(client) {
  const data = await discoveryRpc(client, "company_discovery_setup_status");
  const setup = mapWebsiteSetupStatus(data);
  if (!setup.startOnboardingEnabled) return setup;
  try {
    // Owner RLS chooses the tenant; only the authoritative ready proof chooses the result.
    const claims = discoveryData(await client.from("discovery_claims")
      .select("job_id,result_id,claim_class,claim_type,claim_schema_version,normalized_value,uncertainty,ambiguous_fields,contradiction_status")
      .eq("job_id", setup.readyProof.jobId)
      .eq("result_id", setup.readyProof.resultId)
      .eq("claim_class", "operational")
      .in("claim_type", ["service", "service_territory", "business_hours", "booking_restriction"])
      .order("created_at", { ascending: true })
      .limit(100));
    return Object.freeze({ ...setup, publicDetails: mapWebsiteSetupPublicDetails(setup, claims) });
  } catch {
    // Optional details must not revoke a ready result or leak transport/provider diagnostics.
    return Object.freeze({ ...setup, publicDetailsUnavailable: true });
  }
}

export async function startWebsiteSetupVia(client, url) {
  return discoveryRpc(client, "start_company_discovery_setup", {
    p_url: validateWebsiteUrl(url),
  });
}

export async function retryWebsiteSetupVia(client, jobId, expectedVersion) {
  return discoveryRpc(client, "retry_company_discovery_setup", {
    p_job: jobId,
    p_expected_version: expectedVersion,
  });
}

export async function cancelCompanyDiscoveryVia(client, jobId, expectedVersion) {
  return discoveryRpc(client, "cancel_company_discovery", {
    p_job: jobId,
    p_expected_version: expectedVersion,
  });
}

export async function retryCompanyDiscoveryVia(client, jobId, expectedVersion) {
  return discoveryRpc(client, "retry_company_discovery", {
    p_job: jobId,
    p_expected_version: expectedVersion,
  });
}

export async function reviewCompanyDiscoveryVia(client, review, reviewState) {
  // Validate the complete visible draft before minting a nonce. An invalid
  // editor must produce zero server calls and can never fall back to a prior
  // valid value held elsewhere.
  const payload = buildDiscoveryReviewRequest(review, reviewState, "preflight-only");
  const claimIds = payload.p_decisions.map((decision) => decision.claim_id);
  const stage0b = review?.result?.schema === "company_discovery.result.v2";
  const nonce = await discoveryRpc(client, stage0b
    ? "create_company_discovery_review_nonce_v2"
    : "create_company_discovery_review_nonce", {
    p_job: review.job.id,
    p_result: review.result.id,
    p_claim_ids: claimIds,
  });
  const reviewRpc = stage0b
    ? "review_company_discovery_claims_v2"
    : "review_company_discovery_claims";
  return discoveryRpc(client, reviewRpc, {
    ...payload,
    p_confirmation_nonce: nonce,
  });
}

function discoveryData(result) {
  if (result?.error) throw discoveryError(result.error);
  return result?.data ?? null;
}

export async function loadCompanyDiscoveryVia(client, tenantId, {
  now = new Date().toISOString(),
} = {}) {
  if (typeof tenantId !== "string" || !tenantId) throw new Error("active_tenant_required");
  const ownerStatus = discoveryData(await client.rpc("company_discovery_owner_status"));
  const availability = mapDiscoveryRead({ ownerStatus, now });
  if (availability.phase === "unavailable") return availability;
  const jobResult = await client
    .from("worker_jobs")
    .select("id,tenant_id,version,status,processing_stage,current_attempt_id,selected_attempt_id,deadline_at,fallback_state,normalized_origin,updated_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const job = discoveryData(jobResult);
  if (!job?.selected_attempt_id) {
    return mapDiscoveryRead({ ownerStatus, job, now });
  }

  const result = discoveryData(await client
    .from("worker_results")
    .select("id,tenant_id,job_id,attempt_id,result_schema,result_hash,candidate_result,validation_state,validated_at")
    .eq("tenant_id", tenantId)
    .eq("job_id", job.id)
    .eq("attempt_id", job.selected_attempt_id)
    .eq("validation_state", "validated")
    .maybeSingle());
  if (!result) return mapDiscoveryRead({ ownerStatus, job, now });

  const [claimsResult, sourcesResult, decisionsResult] = await Promise.all([
    client
      .from("discovery_claims")
      .select("id,tenant_id,job_id,result_id,claim_class,claim_type,normalized_value,evidence_refs,adapter_id,provider,model,confidence,contradiction_status,missing_fields,ambiguous_fields,contradictions,uncertainty,claim_schema_version,claim_version,created_at")
      .eq("tenant_id", tenantId)
      .eq("job_id", job.id)
      .eq("result_id", result.id)
      .order("created_at", { ascending: true }),
    client
      .from("discovery_source_snapshots")
      .select("id,tenant_id,job_id,result_id,url,retrieved_at,http_status,mime_type,byte_length,content_hash,excerpt,crawl_order,crawl_depth")
      .eq("tenant_id", tenantId)
      .eq("job_id", job.id)
      .eq("result_id", result.id)
      .order("crawl_order", { ascending: true }),
    client
      .from("discovery_decisions")
      .select("id,tenant_id,job_id,result_id,claim_id,decision,decided_at")
      .eq("tenant_id", tenantId)
      .eq("job_id", job.id)
      .eq("result_id", result.id)
      .order("decided_at", { ascending: true }),
  ]);
  return mapDiscoveryRead({
    ownerStatus,
    job,
    result,
    claims: discoveryData(claimsResult) ?? [],
    sources: discoveryData(sourcesResult) ?? [],
    decisions: discoveryData(decisionsResult) ?? [],
    now,
  });
}

const SCOPE_TO_DB = {
  service: "servico", "serviço": "servico", servico: "servico",
  location: "localizacao", "localização": "localizacao", localizacao: "localizacao",
  client: "cliente", cliente: "cliente",
  general: "geral", geral: "geral",
};

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
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
  const [tenantResult, rulesResult, casesResult, callsResult, notificationsResult, powersResult] = await Promise.all([
    supabase.from("tenants").select("*").eq("id", activeTenantId),
    supabase.from("rules").select("*").eq("tenant_id", activeTenantId).order("created_at", { ascending: true }),
    supabase.from("approval_cases").select("*").eq("tenant_id", activeTenantId).order("created_at", { ascending: false }).limit(50),
    supabase.from("calls").select("id,channel,session_type,started_at,ended_at,duration_seconds,summary_pt,summary_status,cost_estimate_usd,model,status,test_memory_generation").eq("tenant_id", activeTenantId).order("started_at", { ascending: false }).limit(20),
    scopeUsageAlertQuery(
      supabase.from("notifications").select("*"),
      { tenantId: activeTenantId },
    ),
    supabase.from("powers").select("id,granted_at,revoked_at,test_memory_generation").eq("tenant_id", activeTenantId).order("granted_at", { ascending: false }),
  ]);
  for (const result of [
    tenantResult, rulesResult, casesResult, callsResult,
    notificationsResult, powersResult,
  ])
    if (result.error) throw new Error(result.error.message);
  const tenants = tenantResult.data;
  const rules = rulesResult.data;
  const tenant = tenants?.[0];
  if (!tenant) return { state: null, warning: "Não foi possível carregar a sua empresa. Saia e entre novamente." };
  const resetAt = tenant.test_memory_reset_at ?? null;
  const generation = Number(tenant.test_memory_generation ?? 0);
  const current = projectRowsAfterTestReset({
    generation,
    rules: rules ?? [],
    cases: casesResult.data ?? [],
    calls: callsResult.data ?? [],
    notifications: notificationsResult.data ?? [],
    powers: powersResult.data ?? [],
  });

  const approvals = current.cases.map(mapCase);
  const memory = mapRuleGroups(current.rules);

  const messages = [];
  for (const call of current.calls.slice(0, 8).reverse()) {
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
  for (const n of current.notifications.slice(0, 6).reverse()) {
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
    testResetAt: resetAt,
    testGeneration: generation,
    testState: {
      calls: current.calls.length,
      approvals: approvals.length,
      memory: memory.length,
      powers: current.powers.length,
    },
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

    async loadCompanyDiscovery() {
      try {
        return await loadCompanyDiscoveryVia(supabase, activeTenantId);
      } catch (error) {
        return {
          phase: "fallback",
          reason: error?.code || "load_failed",
          message: error?.message,
          interviewAvailable: true,
        };
      }
    },

    async loadWebsiteSetup() {
      return loadWebsiteSetupVia(supabase);
    },

    async startWebsiteSetup(url) {
      return startWebsiteSetupVia(supabase, url);
    },

    async retryWebsiteSetup(jobId, expectedVersion) {
      return retryWebsiteSetupVia(supabase, jobId, expectedVersion);
    },

    async startCompanyDiscovery(url) {
      const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return submitCompanyDiscoveryVia(supabase, url, `dashboard-${suffix}`);
    },

    async cancelCompanyDiscovery(jobId, expectedVersion) {
      return cancelCompanyDiscoveryVia(supabase, jobId, expectedVersion);
    },

    async retryCompanyDiscovery(jobId, expectedVersion) {
      return retryCompanyDiscoveryVia(supabase, jobId, expectedVersion);
    },

    async reviewCompanyDiscovery(review, reviewState) {
      return reviewCompanyDiscoveryVia(supabase, review, reviewState);
    },

    subscribe(onChange) {
      if (channel || !supabase) return () => {};
      channel = supabase
        .channel("dashboard-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "approval_cases" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "rules" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "worker_jobs" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "worker_results" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "discovery_claims" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "discovery_decisions" }, onChange)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "company_discovery_onboarding_drafts" }, onChange)
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
      // Real mode: reset the simulation-only tenant's working memory through the
      // append-only path (every rule group gets a terminal rejected version, pending
      // cases expire). The server refuses outside simulation_only.
      const { data, error } = await supabase.rpc("reset_owner_test_memory");
      const { state } = await fetchAll();
      if (error) {
        return { state, warning: `Não deu para zerar a memória de teste: ${error.message}` };
      }
      if (!isFreshTestResetReadback({
        rpcResetAt: data?.reset_at,
        rpcGeneration: Number(data?.generation),
        state,
      }))
        return {
          state,
          warning:
            "O servidor não confirmou um teste totalmente zerado. Nada foi anunciado como concluído.",
        };
      return { state };
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
