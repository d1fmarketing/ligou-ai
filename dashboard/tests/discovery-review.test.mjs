import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

import {
  buildDiscoveryReviewRequest,
  createDiscoveryReviewState,
  discoveryReviewReducer,
  mapDiscoveryRead,
} from "../src/discovery-model.js";

const IDS = {
  job: "10000000-0000-4000-8000-000000000001",
  attempt: "10000000-0000-4000-8000-000000000002",
  result: "10000000-0000-4000-8000-000000000003",
  descriptive: "10000000-0000-4000-8000-000000000011",
  operational: "10000000-0000-4000-8000-000000000012",
  safety: "10000000-0000-4000-8000-000000000013",
  evidenceA: "10000000-0000-4000-8000-000000000021",
  evidenceB: "10000000-0000-4000-8000-000000000022",
};

function discoveryRows(overrides = {}) {
  return {
    allowlist: { active: true, expires_at: "2026-09-02T00:00:00Z" },
    job: {
      id: IDS.job,
      version: 7,
      status: "awaiting_review",
      current_attempt_id: IDS.attempt,
      selected_attempt_id: IDS.attempt,
      deadline_at: "2026-09-01T23:00:00Z",
      fallback_state: "discovery_selected",
      normalized_origin: "https://example.com/",
      updated_at: "2026-09-01T19:00:00Z",
    },
    result: {
      id: IDS.result,
      job_id: IDS.job,
      attempt_id: IDS.attempt,
      result_hash: "f".repeat(64),
      candidate_result: {
        schema_version: "company_discovery.result.v1",
        missing_questions: [
          "Qual é o menor preço que você aceita negociar?",
          "Quem recebe chamadas fora do horário?",
        ],
        contradictions: ["O rodapé e a página de contato mostram telefones diferentes."],
        uncertainty: ["A duração pode variar por endereço."],
      },
    },
    claims: [
      {
        id: IDS.descriptive,
        result_id: IDS.result,
        claim_version: 1,
        claim_class: "descriptive",
        claim_type: "business_name",
        normalized_value: "Costa Home Services",
        evidence_refs: [IDS.evidenceA],
        contradictions: [],
        uncertainty: [],
      },
      {
        id: IDS.operational,
        result_id: IDS.result,
        claim_version: 1,
        claim_class: "operational",
        claim_type: "service",
        normalized_value: {
          service_type: "drain_cleaning",
          service_names: ["Drain cleaning"],
          public_price: { amount: "149.00", currency: "USD", qualifier: "starting_at" },
          duration_minutes: 60,
        },
        evidence_refs: [IDS.evidenceA],
        contradictions: ["A página de cupons mostra USD 129.00."],
        uncertainty: ["Preço público inicial, não autorização de negociação."],
      },
      {
        id: IDS.safety,
        result_id: IDS.result,
        claim_version: 1,
        claim_class: "safety_critical",
        claim_type: "emergency",
        normalized_value: { guidance: "Em caso de vazamento de gás, ligue para 911." },
        evidence_refs: [IDS.evidenceA, IDS.evidenceB],
        contradictions: [],
        uncertainty: ["O site não informa cobertura fora do horário."],
      },
    ],
    sources: [
      {
        id: IDS.evidenceA,
        result_id: IDS.result,
        url: "https://example.com/services",
        excerpt: "Drain cleaning from $149. Gas leak? Call 911.",
        content_hash: "a".repeat(64),
        crawl_order: 0,
      },
      {
        id: IDS.evidenceB,
        result_id: IDS.result,
        url: "https://example.com/emergency",
        excerpt: "For gas emergencies, leave the property and call 911.",
        content_hash: "b".repeat(64),
        crawl_order: 1,
      },
    ],
    decisions: [],
    now: "2026-09-01T20:00:00Z",
    ...overrides,
  };
}

function fullyDecided(review) {
  let state = createDiscoveryReviewState(review);
  state = discoveryReviewReducer(state, { type: "decide", claimId: IDS.descriptive, decision: "approve" });
  state = discoveryReviewReducer(state, { type: "decide", claimId: IDS.operational, decision: "edit" });
  state = discoveryReviewReducer(state, {
    type: "edit",
    claimId: IDS.operational,
    value: {
      service_type: "drain_cleaning",
      service_names: ["Desentupimento"],
      public_price: { amount: "139.00", currency: "USD", qualifier: "exact" },
      duration_minutes: 45,
    },
  });
  state = discoveryReviewReducer(state, { type: "decide", claimId: IDS.safety, decision: "approve" });
  state = discoveryReviewReducer(state, { type: "confirm", group: "descriptive", checked: true });
  state = discoveryReviewReducer(state, { type: "confirm", group: "operational", checked: true });
  state = discoveryReviewReducer(state, { type: "confirm", group: "safety", checked: true });
  state = discoveryReviewReducer(state, { type: "ackEvidence", claimId: IDS.safety, checked: true });
  return state;
}

test("maps only the exact selected result into Portuguese authority groups with evidence provenance", () => {
  const review = mapDiscoveryRead(discoveryRows());

  assert.equal(review.phase, "review");
  assert.equal(review.job.id, IDS.job);
  assert.equal(review.job.version, 7);
  assert.equal(review.result.id, IDS.result);
  assert.deepEqual(review.groups.map((group) => [group.id, group.claims.length]), [
    ["descriptive", 1],
    ["operational", 1],
    ["safety", 1],
  ]);
  assert.deepEqual(review.groups[1].claims[0].evidence[0], {
    id: IDS.evidenceA,
    url: "https://example.com/services",
    excerpt: "Drain cleaning from $149. Gas leak? Call 911.",
    contentHash: "a".repeat(64),
    crawlOrder: 0,
  });
  assert.deepEqual(review.groups[1].claims[0].contradictions, ["A página de cupons mostra USD 129.00."]);
  assert.deepEqual(review.groups[1].claims[0].uncertainty, ["Preço público inicial, não autorização de negociação."]);
  assert.deepEqual(review.privateQuestions.map((item) => item.question), [
    "Qual é o menor preço que você aceita negociar?",
    "Quem recebe chamadas fora do horário?",
  ]);
  assert.equal(review.privateQuestions.every((item) => item.approvable === false), true);
});

test("builds one exact atomic owner RPC payload with pinned versions, nonce, group confirmation, and safety evidence", () => {
  const review = mapDiscoveryRead(discoveryRows());
  const state = fullyDecided(review);
  const request = buildDiscoveryReviewRequest(review, state, "nonce-hex-64");

  assert.deepEqual(request, {
    p_job: IDS.job,
    p_result: IDS.result,
    p_expected_version: 7,
    p_decisions: [
      {
        claim_id: IDS.descriptive,
        decision: "approve",
        value: "Costa Home Services",
        group_confirmed: false,
        evidence_acknowledged: false,
        acknowledged_evidence_refs: [],
      },
      {
        claim_id: IDS.operational,
        decision: "edit",
        value: {
          service_type: "drain_cleaning",
          service_names: ["Desentupimento"],
          public_price: { amount: "139.00", currency: "USD", qualifier: "exact" },
          duration_minutes: 45,
        },
        group_confirmed: true,
        evidence_acknowledged: false,
        acknowledged_evidence_refs: [],
      },
      {
        claim_id: IDS.safety,
        decision: "approve",
        value: { guidance: "Em caso de vazamento de gás, ligue para 911." },
        group_confirmed: true,
        evidence_acknowledged: true,
        acknowledged_evidence_refs: [IDS.evidenceA, IDS.evidenceB],
      },
    ],
    p_confirmation_nonce: "nonce-hex-64",
  });
});

test("refuses incomplete, stale, private, operational, and safety review boundaries before an RPC", () => {
  const review = mapDiscoveryRead(discoveryRows());
  const undecided = createDiscoveryReviewState(review);
  assert.throws(
    () => buildDiscoveryReviewRequest(review, undecided, "nonce"),
    /Escolha aprovar, editar ou rejeitar para cada sugestão/,
  );

  const complete = fullyDecided(review);
  assert.throws(
    () => buildDiscoveryReviewRequest(review, { ...complete, expectedJobVersion: 6 }, "nonce"),
    /A descoberta mudou enquanto você revisava/,
  );
  assert.throws(
    () => buildDiscoveryReviewRequest(review, { ...complete, confirmations: { ...complete.confirmations, operational: false } }, "nonce"),
    /Confirme o grupo operacional/,
  );
  assert.throws(
    () => buildDiscoveryReviewRequest(review, { ...complete, evidenceAcks: {} }, "nonce"),
    /Confirme a evidência exata de cada item de segurança/,
  );
  assert.throws(
    () => buildDiscoveryReviewRequest({
      ...review,
      groups: [...review.groups, { id: "private", claims: [{ id: "private-fact" }] }],
    }, complete, "nonce"),
    /Assuntos privados só podem virar perguntas da entrevista/,
  );
  const incompleteEvidence = {
    ...review,
    groups: review.groups.map((group) => ({
      ...group,
      claims: group.claims.map((claim) => claim.id === IDS.safety ? { ...claim, evidence: [] } : claim),
    })),
  };
  assert.throws(
    () => buildDiscoveryReviewRequest(incompleteEvidence, complete, "nonce"),
    /A evidência desta sugestão não carregou por completo/,
  );
});

test("failed, expired, disabled, and non-allowlisted discovery fail open to the existing interview", () => {
  assert.deepEqual(mapDiscoveryRead(discoveryRows({
    job: { ...discoveryRows().job, status: "failed", fallback_state: "existing_onboarding" },
  })).phase, "fallback");
  assert.deepEqual(mapDiscoveryRead(discoveryRows({
    job: { ...discoveryRows().job, status: "queued", deadline_at: "2026-09-01T19:59:59Z" },
  })).phase, "fallback");
  assert.deepEqual(mapDiscoveryRead(discoveryRows({ allowlist: { active: false, expires_at: null }, job: null })).phase, "unavailable");
  assert.deepEqual(mapDiscoveryRead(discoveryRows({ allowlist: { active: true, expires_at: "2026-08-31T00:00:00Z" }, job: null })).phase, "unavailable");
});

test("a late result stays labeled as suggestion and cannot overwrite owner answers", () => {
  const review = mapDiscoveryRead(discoveryRows({ hasOwnerAnswers: true }));
  assert.equal(review.lateSuggestion, true);
  assert.equal(review.authorityEffect, "suggestion_only");
  assert.equal(review.groups.flatMap((group) => group.claims).every((claim) => claim.decision === null), true);
});

test("owner discovery gateway emits exact Task 1 RPC names and payloads", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  const {
    cancelCompanyDiscoveryVia,
    retryCompanyDiscoveryVia,
    reviewCompanyDiscoveryVia,
    submitCompanyDiscoveryVia,
  } = await vite.ssrLoadModule("/src/data/gateway.supabase.js");
  const calls = [];
  const client = {
    async rpc(name, payload) {
      calls.push([name, payload]);
      if (name === "create_company_discovery_review_nonce") return { data: "nonce-from-owner-rpc", error: null };
      if (name === "review_company_discovery_claims") return { data: { reviewed: 3, version: 8 }, error: null };
      if (name === "submit_company_discovery") return { data: IDS.job, error: null };
      return { data: { status: name.includes("cancel") ? "cancelled" : "queued", version: 8 }, error: null };
    },
  };
  const review = mapDiscoveryRead(discoveryRows());
  const state = fullyDecided(review);

  try {
    assert.equal(await submitCompanyDiscoveryVia(client, "https://example.com", "owner-key-1"), IDS.job);
    await cancelCompanyDiscoveryVia(client, IDS.job, 7);
    await retryCompanyDiscoveryVia(client, IDS.job, 7);
    assert.deepEqual(await reviewCompanyDiscoveryVia(client, review, state), { reviewed: 3, version: 8 });
  } finally {
    await vite.close();
  }

  assert.deepEqual(calls, [
    ["submit_company_discovery", { p_url: "https://example.com", p_idempotency_key: "owner-key-1" }],
    ["cancel_company_discovery", { p_job: IDS.job, p_expected_version: 7 }],
    ["retry_company_discovery", { p_job: IDS.job, p_expected_version: 7 }],
    ["create_company_discovery_review_nonce", {
      p_job: IDS.job,
      p_result: IDS.result,
      p_claim_ids: [IDS.descriptive, IDS.operational, IDS.safety],
    }],
    ["review_company_discovery_claims", {
      p_job: IDS.job,
      p_result: IDS.result,
      p_expected_version: 7,
      p_decisions: buildDiscoveryReviewRequest(review, state, "nonce-from-owner-rpc").p_decisions,
      p_confirmation_nonce: "nonce-from-owner-rpc",
    }],
  ]);
});

test("stale owner review errors become actionable Portuguese copy and never retry a partial loop", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  const { reviewCompanyDiscoveryVia } = await vite.ssrLoadModule("/src/data/gateway.supabase.js");
  const calls = [];
  const client = {
    async rpc(name) {
      calls.push(name);
      if (name === "create_company_discovery_review_nonce") return { data: "fresh-nonce", error: null };
      return { data: null, error: { message: "company_discovery_stale_version" } };
    },
  };
  const review = mapDiscoveryRead(discoveryRows());
  try {
    await assert.rejects(
      reviewCompanyDiscoveryVia(client, review, fullyDecided(review)),
      /A descoberta mudou enquanto você revisava/,
    );
  } finally {
    await vite.close();
  }
  assert.deepEqual(calls, [
    "create_company_discovery_review_nonce",
    "review_company_discovery_claims",
  ]);
});

test("owner discovery reads stay tenant, job, attempt, and result pinned through RLS tables", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  const { loadCompanyDiscoveryVia } = await vite.ssrLoadModule("/src/data/gateway.supabase.js");
  const rows = discoveryRows();
  const operations = [];
  const responses = {
    company_discovery_allowlist: { data: rows.allowlist, error: null },
    worker_jobs: { data: rows.job, error: null },
    worker_results: { data: rows.result, error: null },
    discovery_claims: { data: rows.claims, error: null },
    discovery_source_snapshots: { data: rows.sources, error: null },
    discovery_decisions: { data: rows.decisions, error: null },
  };
  const client = {
    from(table) {
      const query = {
        select(columns) { operations.push([table, "select", columns]); return query; },
        eq(column, value) { operations.push([table, "eq", column, value]); return query; },
        order(column, options) { operations.push([table, "order", column, options]); return query; },
        limit(value) { operations.push([table, "limit", value]); return query; },
        maybeSingle() { operations.push([table, "maybeSingle"]); return Promise.resolve(responses[table]); },
        then(resolve, reject) { return Promise.resolve(responses[table]).then(resolve, reject); },
      };
      return query;
    },
  };
  try {
    const projected = await loadCompanyDiscoveryVia(client, "tenant-exact", {
      hasOwnerAnswers: true,
      now: rows.now,
    });
    assert.equal(projected.phase, "review");
    assert.equal(projected.lateSuggestion, true);
  } finally {
    await vite.close();
  }
  for (const table of Object.keys(responses)) {
    assert.equal(
      operations.some((operation) => operation[0] === table && operation[1] === "eq" && operation[2] === "tenant_id" && operation[3] === "tenant-exact"),
      true,
      `${table} must be pinned to the active tenant`,
    );
  }
  assert.equal(operations.some((operation) => operation[0] === "worker_results" && operation[2] === "attempt_id" && operation[3] === IDS.attempt), true);
  for (const table of ["worker_results", "discovery_claims", "discovery_source_snapshots", "discovery_decisions"]) {
    assert.equal(
      operations.some((operation) => operation[0] === table && operation[1] === "eq" && operation[2] === "job_id" && operation[3] === IDS.job),
      true,
      `${table} must be pinned to the exact job`,
    );
  }
  for (const table of ["discovery_claims", "discovery_source_snapshots", "discovery_decisions"]) {
    assert.equal(
      operations.some((operation) => operation[0] === table && operation[1] === "eq" && operation[2] === "result_id" && operation[3] === IDS.result),
      true,
      `${table} must be pinned to the exact result`,
    );
  }
});

async function renderModule(path, exportName, props) {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  try {
    const module = await vite.ssrLoadModule(path);
    return renderToStaticMarkup(React.createElement(module[exportName], props));
  } finally {
    await vite.close();
  }
}

test("the real review component renders evidence-to-authority rail, boundaries, and private questions without fact controls", async () => {
  const review = mapDiscoveryRead(discoveryRows());
  const html = await renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: review });

  for (const visible of [
    "Revisão do site",
    "Dados públicos",
    "Operação",
    "Segurança",
    "Evidência do site",
    "Candidato",
    "Decisão do dono",
    "Regra da Ligou",
    "https://example.com/services",
    "Drain cleaning from $149. Gas leak? Call 911.",
    "aaaaaaaaaaaa",
    "A página de cupons mostra USD 129.00.",
    "Preço público inicial, não autorização de negociação.",
    "Perguntas para a entrevista",
    "Qual é o menor preço que você aceita negociar?",
    "Nunca são aprovados como fatos.",
  ]) assert.match(html, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const privateSection = html.slice(html.indexOf("Perguntas para a entrevista"));
  assert.doesNotMatch(privateSection, /Aprovar como fato/);
});

test("loading and failure discovery copy never replaces the existing Portuguese interview CTA", async () => {
  const [loading, fallback, chat] = await Promise.all([
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "loading" } }),
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "fallback", reason: "failed" } }),
    renderModule("/src/views/ChatView.jsx", "ChatView", {
      messages: [],
      callContext: null,
      pendingApproval: null,
      onboardingCtaLabel: "Começar a entrevista de onboarding (voz)",
      onStartOnboarding() {},
    }),
  ]);
  assert.match(loading, /Você não precisa esperar/);
  assert.match(fallback, /A entrevista em português continua disponível agora/);
  assert.match(chat, /Começar a entrevista de onboarding \(voz\)/);
});
