import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function resolveBrowserExecutable({
  env = process.env,
  platform = process.platform,
  accessFn = access,
} = {}) {
  const configured = [
    env.LIGOU_TEST_BROWSER_PATH,
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    env.CHROME_BIN,
  ].filter(Boolean);
  const known = platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    : platform === "win32"
      ? [
        env["PROGRAMFILES"] && join(env["PROGRAMFILES"], "Google", "Chrome", "Application", "chrome.exe"),
        env["PROGRAMFILES(X86)"] && join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      ].filter(Boolean)
      : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ];
  for (const candidate of [...configured, ...known]) {
    try {
      await accessFn(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through portable known locations. Absence is a capability
      // result, not a dashboard test failure.
    }
  }
  return null;
}

function interactionModuleSource() {
  const rows = discoveryRows();
  return `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import "/src/styles.css";
    import { LigouWorkspace } from "/src/App.jsx";
    import { buildDiscoveryReviewRequest, mapDiscoveryRead } from "/src/discovery-model.js";

    const source = ${JSON.stringify(rows)};
    const kind = new URLSearchParams(location.search).get("kind") || "service";
    const wanted = kind === "safety" ? "safety_critical" : "operational";
    source.claims = source.claims.filter((claim) => claim.claim_class === wanted);
    const review = mapDiscoveryRead(source);
    window.addEventListener("error", (event) => { window.__fatal = event.error?.stack || event.message; });
    window.__rpcCalls = 0;
    window.__voiceCalls = 0;
    window.__payload = null;
    window.__reviewError = null;

    function onReview({ review: currentReview, reviewState }) {
      try {
        const payload = buildDiscoveryReviewRequest(currentReview, reviewState, "browser-nonce");
        window.__rpcCalls += 2;
        window.__payload = payload;
      } catch (error) {
        window.__reviewError = error.message;
      }
    }

    function Harness() {
      return <main className="workspace"><LigouWorkspace
        showDiscovery
        discoveryProps={{
          discovery: review,
          onReview,
          onStartInterview: () => { window.__voiceCalls += 1; },
        }}
        chatProps={{
          messages: [],
          callContext: null,
          pendingApproval: null,
          onboardingCtaLabel: "Começar a entrevista de onboarding (voz)",
          onStartOnboarding: () => { window.__voiceCalls += 1; },
          onSend: () => true,
        }}
      /></main>;
    }

    createRoot(document.getElementById("root")).render(<Harness />);
    window.__ready = true;
  `;
}

async function startInteractionBrowser(browserExecutable) {
  const virtualId = "/__virtual_discovery_interaction.jsx";
  const resolvedId = virtualId;
  const profile = await mkdtemp(join(tmpdir(), "ligou-discovery-browser-"));
  const harnessPlugin = {
    name: "discovery-interaction-harness",
    resolveId(id) { return id === virtualId ? resolvedId : null; },
    load(id) { return id === resolvedId ? interactionModuleSource() : null; },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/__discovery_interaction__")) return next();
        const html = await server.transformIndexHtml(request.url, `<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${virtualId}"></script></body></html>`);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(html);
      });
    },
  };
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    cacheDir: join(profile, "vite-cache"),
    appType: "custom",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, ws: false },
    resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: {
      noDiscovery: true,
      include: ["react", "react-dom/client", "@tabler/icons-react", "@supabase/supabase-js"],
    },
    plugins: [react(), harnessPlugin],
  });
  await vite.listen();
  const address = vite.httpServer.address();
  const port = typeof address === "object" ? address.port : null;
  assert.ok(port);

  const chrome = spawn(browserExecutable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const devtoolsUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("chrome_debug_timeout")), 8000);
    chrome.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    chrome.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`chrome_exited_${code}`)); });
  });
  const debugBase = devtoolsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.+$/, "");

  async function connectPage() {
    let page;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const pages = await (await fetch(`${debugBase}/json/list`)).json();
      page = pages.find((item) => item.type === "page");
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(page, "interaction page must open");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => { socket.onopen = resolve; });
    let messageId = 0;
    const pending = new Map();
    const runtimeErrors = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++messageId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    return { socket, send, runtimeErrors };
  }

  const page = await connectPage();
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/__discovery_interaction__?kind=service` });
  const evaluate = async (expression) => {
    const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || "browser_evaluation_failed");
    return result.result.result.value;
  };
  const cleanup = async () => {
    page.socket.close();
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (chrome.exitCode == null) chrome.kill("SIGKILL");
    await vite.waitForRequestsIdle();
    await vite.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate("Boolean(window.__ready && document.querySelector('.discovery-review'))")) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) {
    const diagnostic = await evaluate("JSON.stringify({ fatal: window.__fatal, html: document.documentElement.outerHTML, resources: performance.getEntriesByType('resource').map((entry) => entry.name).slice(0, 20) })");
    const runtime = page.runtimeErrors.map((error) => error.exception?.description || error.text);
    await cleanup();
    throw new Error(`interaction_page_not_ready:${diagnostic}:${JSON.stringify(runtime)}`);
  }
  return {
    port,
    page,
    evaluate,
    async navigate(kind) {
      await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/__discovery_interaction__?kind=${kind}` });
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (await evaluate("Boolean(window.__ready && document.querySelector('.discovery-review'))")) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("interaction_page_not_ready");
    },
    async close() {
      await cleanup();
    },
  };
}

function discoveryRows(overrides = {}) {
  return {
    ownerStatus: { enabled: true, allowlisted: true, expires_at: "2026-09-02T00:00:00Z", available: true },
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

function stage0bRows() {
  const source = discoveryRows();
  const claim = (index, claimClass, claimType, value, overrides = {}) => ({
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    result_id: IDS.result,
    claim_version: 1,
    claim_class: claimClass,
    claim_type: claimType,
    normalized_value: value,
    evidence_refs: [IDS.evidenceA],
    adapter_id: "direct_model",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    confidence: "high",
    contradiction_status: "none",
    missing_fields: [],
    ambiguous_fields: [],
    contradictions: [],
    uncertainty: [],
    claim_schema_version: "company_discovery.claim.v2",
    ...overrides,
  });
  return {
    ...source,
    result: {
      ...source.result,
      result_schema: "company_discovery.result.v2",
      candidate_result: {
        schema_version: "company_discovery.result.v2",
        missing_questions: ["Qual é o preço mínimo privado?"],
        contradictions: ["O rodapé e a página de contato mostram horários diferentes."],
        uncertainty: [],
      },
    },
    claims: [
      claim(1, "descriptive", "business_name", "Costa Home Services"),
      claim(2, "operational", "service", {
        service_type: "drain_cleaning", service_names: ["Drain cleaning"],
        public_price: { amount: "149.00", currency: "USD", qualifier: "starting_at", condition: null },
        duration_minutes: 60,
      }),
      claim(3, "operational", "service_territory", {
        service_type: null,
        included_areas: [{ kind: "city", name: "Novato", region_state: "CA", country_code: "US" }],
        excluded_areas: [], radius: null,
      }),
      claim(4, "operational", "business_hours", {
        timezone: "America/Los_Angeles",
        ordinary_intervals: [{ days: ["mon", "tue", "wed", "thu", "fri"], opens: "08:00", closes: "17:00" }],
        closed_days: ["sat", "sun"], ordinary_24_7: false,
        emergency_24_7: false, after_hours: "unavailable", holiday_policy: null,
      }, { missing_fields: ["holiday_policy"], confidence: "medium" }),
      claim(5, "operational", "guarantee", {
        guarantee_kind: "company_guarantee", service_type: "drain_cleaning",
        coverage: ["labor"], duration: { amount: 90, unit: "days" },
        conditions: ["Company labor only"], exclusions: [],
      }),
      claim(6, "operational", "booking_restriction", {
        restriction_type: "sunday", service_type: null, rule: "not_allowed",
        notice_minutes: null, public_fee: null, conditions: ["No Sunday appointments"],
      }),
      claim(7, "safety_critical", "emergency", {
        guidance: "Em caso de vazamento de gás, saia e ligue para 911.",
      }),
    ],
  };
}

test("maps Stage 0B claims into the seven product groups and retains gap metadata", () => {
  const review = mapDiscoveryRead(stage0bRows());

  assert.equal(review.phase, "review");
  assert.deepEqual(review.groups.map((group) => group.label), [
    "Empresa",
    "Serviços e preços públicos",
    "Área atendida",
    "Horários",
    "Garantias",
    "Restrições de agendamento",
    "Segurança e emergências",
  ]);
  const hours = review.groups.find((group) => group.id === "hours").claims[0];
  assert.equal(hours.confidence, "medium");
  assert.equal(hours.contradictionStatus, "none");
  assert.deepEqual(hours.missingFields, ["holiday_policy"]);
  assert.deepEqual(hours.ambiguousFields, []);
  assert.equal(hours.adapterId, "direct_model");
  assert.equal(hours.model, "gpt-5.6-sol");
  assert.deepEqual(review.questionsStillMissing, ["Qual é o preço mínimo privado?"]);
  assert.deepEqual(review.contradictions, ["O rodapé e a página de contato mostram horários diferentes."]);
  assert.deepEqual(review.globalUnresolved.map((item) => ({
    sourceKind: item.sourceKind,
    sourceIndex: item.sourceIndex,
    sourceText: item.sourceText,
    question: item.question,
  })), [
    {
      sourceKind: "missing_question",
      sourceIndex: 0,
      sourceText: "Qual é o preço mínimo privado?",
      question: "Qual é o preço mínimo privado?",
    },
    {
      sourceKind: "contradiction",
      sourceIndex: 0,
      sourceText: "O rodapé e a página de contato mostram horários diferentes.",
      question: "Confirme esta contradição encontrada no site: O rodapé e a página de contato mostram horários diferentes.",
    },
  ]);
});

test("Stage 0B sends one complete owner decision for every global unresolved item", () => {
  const review = mapDiscoveryRead(stage0bRows());
  let state = createDiscoveryReviewState(review);
  for (const group of review.groups) {
    for (const claim of group.claims) {
      state = discoveryReviewReducer(state, {
        type: "decide", claimId: claim.id, decision: "approve",
      });
      if (group.id === "safety") state = discoveryReviewReducer(state, {
        type: "ackEvidence", claimId: claim.id, checked: true,
      });
    }
    state = discoveryReviewReducer(state, {
      type: "confirm", group: group.id, checked: true,
    });
  }
  const [missing, contradiction] = review.globalUnresolved;
  state = discoveryReviewReducer(state, {
    type: "decideUnresolved", itemId: missing.id, decision: "answer",
  });
  state = discoveryReviewReducer(state, {
    type: "editUnresolved", itemId: missing.id,
    value: "O preço mínimo é privado e cada exceção exige minha aprovação.",
  });
  state = discoveryReviewReducer(state, {
    type: "decideUnresolved", itemId: contradiction.id, decision: "reject",
  });

  const request = buildDiscoveryReviewRequest(review, state, "nonce");

  assert.deepEqual(request.p_unresolved_decisions, [
    {
      source_kind: "missing_question",
      source_index: 0,
      source_text: "Qual é o preço mínimo privado?",
      decision: "answer",
      owner_response: "O preço mínimo é privado e cada exceção exige minha aprovação.",
    },
    {
      source_kind: "contradiction",
      source_index: 0,
      source_text: "O rodapé e a página de contato mostram horários diferentes.",
      decision: "reject",
      owner_response: null,
    },
  ]);
  assert.equal(request.p_decisions.length, 7);
});

test("Stage 0B reviews a zero-claim result when one global question remains", () => {
  const rows = stage0bRows();
  rows.claims = [];
  rows.result.candidate_result = {
    schema_version: "company_discovery.result.v2",
    missing_questions: ["Qual é o limite privado?"],
    contradictions: [],
    uncertainty: [],
  };
  const review = mapDiscoveryRead(rows);

  assert.equal(review.phase, "review");
  assert.deepEqual(review.groups, []);
  assert.equal(review.globalUnresolved.length, 1);
  const request = buildDiscoveryReviewRequest(
    review,
    createDiscoveryReviewState(review),
    "zero-claim-nonce",
  );
  assert.deepEqual(request.p_decisions, []);
  assert.deepEqual(request.p_unresolved_decisions, [{
    source_kind: "missing_question",
    source_index: 0,
    source_text: "Qual é o limite privado?",
    decision: "ask",
    owner_response: null,
  }]);
});

test("Stage 0B blocks an empty owner resolution before requesting a nonce", () => {
  const review = mapDiscoveryRead(stage0bRows());
  let state = createDiscoveryReviewState(review);
  for (const group of review.groups) {
    for (const claim of group.claims) {
      state = discoveryReviewReducer(state, {
        type: "decide", claimId: claim.id, decision: "approve",
      });
      if (group.id === "safety") state = discoveryReviewReducer(state, {
        type: "ackEvidence", claimId: claim.id, checked: true,
      });
    }
    state = discoveryReviewReducer(state, {
      type: "confirm", group: group.id, checked: true,
    });
  }
  state = discoveryReviewReducer(state, {
    type: "decideUnresolved",
    itemId: review.globalUnresolved[0].id,
    decision: "answer",
  });
  assert.throws(
    () => buildDiscoveryReviewRequest(review, state, "nonce"),
    /Escreva a resposta do dono/,
  );
});

test("Stage 0B requires a scoped confirmation for every accepted group", () => {
  const review = mapDiscoveryRead(stage0bRows());
  let state = createDiscoveryReviewState(review);
  for (const group of review.groups) {
    for (const claim of group.claims) {
      state = discoveryReviewReducer(state, {
        type: "decide", claimId: claim.id, decision: "approve",
      });
      if (group.id === "safety") {
        state = discoveryReviewReducer(state, {
          type: "ackEvidence", claimId: claim.id, checked: true,
        });
      }
    }
  }
  assert.throws(
    () => buildDiscoveryReviewRequest(review, state, "nonce"),
    /Confirme/,
  );
  for (const group of review.groups) {
    state = discoveryReviewReducer(state, {
      type: "confirm", group: group.id, checked: true,
    });
  }

  const request = buildDiscoveryReviewRequest(review, state, "nonce");

  const groupByClaim = new Map(review.groups.flatMap((group) =>
    group.claims.map((claim) => [claim.id, group.id])));
  for (const decision of request.p_decisions) {
    assert.equal(
      decision.group_confirmed,
      groupByClaim.get(decision.claim_id) === "company" ? false : true,
    );
  }
});

test("Stage 0B service edits keep estimate empty and require a visible conditional qualifier", () => {
  const review = mapDiscoveryRead(stage0bRows());
  const service = review.groups.find((group) => group.id === "services").claims[0];
  let state = createDiscoveryReviewState(review);
  state = discoveryReviewReducer(state, { type: "decide", claimId: service.id, decision: "edit" });
  state = discoveryReviewReducer(state, { type: "editField", claimId: service.id, field: "qualifier", value: "estimate" });
  state = discoveryReviewReducer(state, { type: "editField", claimId: service.id, field: "amount", value: "" });
  assert.equal(state.decisions[service.id].editor.valid, true);
  assert.deepEqual(state.decisions[service.id].value.public_price, {
    amount: null,
    currency: null,
    qualifier: "estimate",
    condition: null,
  });

  state = discoveryReviewReducer(state, { type: "editField", claimId: service.id, field: "qualifier", value: "conditional" });
  state = discoveryReviewReducer(state, { type: "editField", claimId: service.id, field: "amount", value: "250.00" });
  state = discoveryReviewReducer(state, { type: "editField", claimId: service.id, field: "condition", value: "" });
  assert.equal(state.decisions[service.id].editor.valid, false);
  assert.equal(state.decisions[service.id].value, null);
  assert.match(state.decisions[service.id].editor.error, /condição pública/);
});

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

test("invalid visible service and safety drafts replace the prior value and block review before nonce", () => {
  const review = mapDiscoveryRead(discoveryRows());
  let state = createDiscoveryReviewState(review);
  state = discoveryReviewReducer(state, { type: "decide", claimId: IDS.operational, decision: "edit" });
  state = discoveryReviewReducer(state, {
    type: "editField",
    claimId: IDS.operational,
    field: "amount",
    value: "149",
  });
  assert.equal(state.decisions[IDS.operational].editor.valid, false);
  assert.equal(state.decisions[IDS.operational].value, null);
  assert.match(state.decisions[IDS.operational].editor.error, /0\.00/);

  state = discoveryReviewReducer(state, { type: "decide", claimId: IDS.safety, decision: "edit" });
  state = discoveryReviewReducer(state, {
    type: "editField",
    claimId: IDS.safety,
    field: "guidance",
    value: "",
  });
  assert.equal(state.decisions[IDS.safety].editor.valid, false);
  assert.equal(state.decisions[IDS.safety].value, null);
  assert.match(state.decisions[IDS.safety].editor.error, /orientação de emergência/);

  assert.throws(
    () => buildDiscoveryReviewRequest(review, state, "nonce-must-not-be-requested"),
    /Corrija os campos visíveis antes de confirmar/,
  );
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
  assert.equal(mapDiscoveryRead(discoveryRows({
    ownerStatus: { enabled: false, allowlisted: true, expires_at: null, available: false }, job: null,
  })).reason, "disabled");
  assert.equal(mapDiscoveryRead(discoveryRows({
    ownerStatus: { enabled: true, allowlisted: false, expires_at: null, available: false }, job: null,
  })).reason, "not_allowlisted");
  assert.equal(mapDiscoveryRead(discoveryRows({
    ownerStatus: { enabled: true, allowlisted: true, expires_at: "2026-08-31T00:00:00Z", available: false }, job: null,
  })).reason, "allowlist_expired");
});

test("queued, fetching, and analyzing are projected only from durable job state", () => {
  const rows = discoveryRows();
  assert.equal(mapDiscoveryRead({
    ...rows,
    job: { ...rows.job, status: "queued", processing_stage: "queued" },
  }).processingStage, "queued");
  assert.equal(mapDiscoveryRead({
    ...rows,
    job: { ...rows.job, status: "running", processing_stage: "fetching" },
  }).processingStage, "fetching");
  assert.equal(mapDiscoveryRead({
    ...rows,
    job: { ...rows.job, status: "running", processing_stage: "analyzing" },
  }).processingStage, "analyzing");
  assert.equal(mapDiscoveryRead({
    ...rows,
    job: { ...rows.job, status: "running", processing_stage: null },
  }).processingStage, "working");
});

test("discovery never fabricates late timing without a durable timing receipt", () => {
  const neutral = mapDiscoveryRead(discoveryRows({ hasOwnerAnswers: true }));
  const impossibleLegacyCombination = mapDiscoveryRead(discoveryRows({
    job: { ...discoveryRows().job, fallback_state: "existing_onboarding" },
  }));
  for (const review of [neutral, impossibleLegacyCombination]) {
    assert.equal(Object.hasOwn(review, "lateSuggestion"), false);
    assert.equal(review.authorityEffect, "suggestion_only");
    assert.equal(review.groups.flatMap((group) => group.claims).every((claim) => claim.decision === null), true);
  }
});

test("browser capability resolution is portable and returns null when no executable exists", async () => {
  const checked = [];
  const resolved = await resolveBrowserExecutable({
    env: {},
    platform: "linux",
    accessFn: async (candidate) => {
      checked.push(candidate);
      if (candidate !== "/usr/bin/chromium") throw new Error("missing");
    },
  });
  assert.equal(resolved, "/usr/bin/chromium");
  assert.equal(checked.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), false);
  assert.equal(await resolveBrowserExecutable({
    env: { CHROME_BIN: "/custom/chrome" },
    platform: "linux",
    accessFn: async (candidate) => { if (candidate !== "/custom/chrome") throw new Error("missing"); },
  }), "/custom/chrome");
  assert.equal(await resolveBrowserExecutable({
    env: {},
    platform: "linux",
    accessFn: async () => { throw new Error("missing"); },
  }), null);
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

test("owner gateway routes a Stage 0B review only to the v2 draft RPC", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  const { reviewCompanyDiscoveryVia } = await vite.ssrLoadModule("/src/data/gateway.supabase.js");
  const review = mapDiscoveryRead(stage0bRows());
  let state = createDiscoveryReviewState(review);
  for (const group of review.groups) {
    for (const claim of group.claims) {
      state = discoveryReviewReducer(state, { type: "decide", claimId: claim.id, decision: "approve" });
      if (group.id === "safety") {
        state = discoveryReviewReducer(state, { type: "ackEvidence", claimId: claim.id, checked: true });
      }
    }
    state = discoveryReviewReducer(state, { type: "confirm", group: group.id, checked: true });
  }
  const calls = [];
  const client = {
    async rpc(name, payload) {
      calls.push([name, payload]);
      if (name === "create_company_discovery_review_nonce_v2") {
        return { data: "stage0b-nonce", error: null };
      }
      if (name === "review_company_discovery_claims_v2") {
        return {
          data: {
            reviewed: 7, version: 8,
            onboarding_draft_id: "30000000-0000-4000-8000-000000000001",
          },
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected_${name}` } };
    },
  };
  try {
    const response = await reviewCompanyDiscoveryVia(client, review, state);
    assert.equal(response.reviewed, 7);
  } finally {
    await vite.close();
  }
  assert.equal(calls[0][0], "create_company_discovery_review_nonce_v2");
  assert.equal(calls[1][0], "review_company_discovery_claims_v2");
  assert.equal(calls.some(([name]) => name === "review_company_discovery_claims"), false);
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

test("every review, nonce, and version conflict maps to actionable reload copy without raw database codes", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  const { reviewCompanyDiscoveryVia } = await vite.ssrLoadModule("/src/data/gateway.supabase.js");
  const codes = [
    "company_discovery_review_result_not_owner",
    "company_discovery_claim_already_reviewed",
    "company_discovery_stale_version",
    "company_discovery_review_nonce_invalid",
    "company_discovery_review_nonce_race_lost",
    "company_discovery_review_not_awaiting",
    "company_discovery_review_claim_set_invalid",
    "company_discovery_review_claim_set_mismatch",
  ];
  const review = mapDiscoveryRead(discoveryRows());
  try {
    for (const code of codes) {
      let call = 0;
      const client = {
        async rpc() {
          call += 1;
          if (call === 1 && ["company_discovery_stale_version", "company_discovery_review_nonce_invalid", "company_discovery_review_nonce_race_lost", "company_discovery_review_not_awaiting", "company_discovery_review_claim_set_mismatch"].includes(code)) {
            return { data: "fresh-nonce", error: null };
          }
          return { data: null, error: { message: code } };
        },
      };
      await assert.rejects(
        reviewCompanyDiscoveryVia(client, review, fullyDecided(review)),
        (error) => {
          assert.match(error.message, /Recarregue|Atualize/);
          assert.equal(error.message.includes(code), false);
          return true;
        },
      );
    }
  } finally {
    await vite.close();
  }
});

test("an invalid visible editor draft reaches neither nonce nor review RPC", async () => {
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
  const review = mapDiscoveryRead(discoveryRows());
  let state = fullyDecided(review);
  state = discoveryReviewReducer(state, {
    type: "editField",
    claimId: IDS.operational,
    field: "amount",
    value: "139",
  });
  try {
    await assert.rejects(
      reviewCompanyDiscoveryVia({ rpc: async (...args) => { calls.push(args); return { data: null, error: null }; } }, review, state),
      /Corrija os campos visíveis/,
    );
  } finally {
    await vite.close();
  }
  assert.deepEqual(calls, []);
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
    worker_jobs: { data: rows.job, error: null },
    worker_results: { data: rows.result, error: null },
    discovery_claims: { data: rows.claims, error: null },
    discovery_source_snapshots: { data: rows.sources, error: null },
    discovery_decisions: { data: rows.decisions, error: null },
  };
  const client = {
    async rpc(name, payload) {
      operations.push(["rpc", name, payload]);
      return { data: rows.ownerStatus, error: null };
    },
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
      now: rows.now,
    });
    assert.equal(projected.phase, "review");
    assert.equal(Object.hasOwn(projected, "lateSuggestion"), false);
  } finally {
    await vite.close();
  }
  assert.deepEqual(operations[0], ["rpc", "company_discovery_owner_status", undefined]);
  assert.deepEqual(operations.filter((operation) => operation[0] === "rpc"), [
    ["rpc", "company_discovery_owner_status", undefined],
  ]);
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

test("initial discovery load uses the exact no-arg owner status RPC and fails open for disabled, refused, or expired access", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  const { loadCompanyDiscoveryVia } = await vite.ssrLoadModule("/src/data/gateway.supabase.js");
  const cases = [
    [{ enabled: false, allowlisted: true, expires_at: null, available: false }, "disabled"],
    [{ enabled: true, allowlisted: false, expires_at: null, available: false }, "not_allowlisted"],
    [{ enabled: true, allowlisted: true, expires_at: "2026-08-31T00:00:00Z", available: false }, "allowlist_expired"],
  ];
  try {
    for (const [status, reason] of cases) {
      const calls = [];
      const client = {
        async rpc(name, payload) {
          calls.push([name, payload]);
          return { data: status, error: null };
        },
        from(table) { throw new Error(`unexpected_table_read:${table}`); },
      };
      const projection = await loadCompanyDiscoveryVia(client, "tenant-exact", { now: "2026-09-01T20:00:00Z" });
      assert.equal(projection.phase, "unavailable");
      assert.equal(projection.reason, reason);
      assert.deepEqual(calls, [["company_discovery_owner_status", undefined]]);
    }
  } finally {
    await vite.close();
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
  assert.match(html, /Sugestão pública · sem efeito automático/);
  assert.doesNotMatch(html, /Chegou depois da entrevista/);

  const descriptiveSection = html.slice(html.indexOf("Dados públicos"), html.indexOf("Operação"));
  assert.match(descriptiveSection, /Perfil da empresa/);
  assert.doesNotMatch(descriptiveSection, /Regra da Ligou/);
  const privateSection = html.slice(html.indexOf("Perguntas para a entrevista"));
  assert.doesNotMatch(privateSection, /Aprovar como fato/);
  assert.doesNotMatch(privateSection, /Evidência do site|Candidato|Perfil da empresa|Regra da Ligou/);
});

test("the Stage 0B component renders semantic groups, draft-only authority, contradictions, and missing questions", async () => {
  const review = mapDiscoveryRead(stage0bRows());
  const html = await renderModule(
    "/src/views/DiscoveryReviewView.jsx",
    "DiscoveryReviewView",
    { discovery: review },
  );
  for (const visible of [
    "Empresa",
    "Serviços e preços públicos",
    "Área atendida",
    "Horários",
    "Garantias",
    "Restrições de agendamento",
    "Segurança e emergências",
    "Rascunho de onboarding",
    "Confiança média",
    "Campos ainda ausentes",
    "holiday_policy",
    "Contradições",
    "Perguntas que ainda faltam",
    "Qual é o preço mínimo privado?",
    "Levar para a entrevista",
    "Responder agora",
    "Rejeitar sugestão",
    "Não se aplica",
    "Adiar para revisão do dono",
  ]) assert.match(html, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /Regra da Ligou/);
  assert.doesNotMatch(html, /Preço mínimo.*Aprovar/);

  const territory = review.groups.find((group) => group.id === "territory").claims[0];
  let state = createDiscoveryReviewState(review);
  state = discoveryReviewReducer(state, {
    type: "decide", claimId: territory.id, decision: "edit",
  });
  state = discoveryReviewReducer(state, {
    type: "editField", claimId: territory.id, field: "json", value: "{",
  });
  assert.equal(state.decisions[territory.id].editor.valid, false);
  assert.equal(state.decisions[territory.id].value, null);
  assert.match(state.decisions[territory.id].editor.error, /JSON válido/);
});

test("review readiness is visible, live, and connected to submit for every blocking reason", async () => {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  try {
    const { DiscoveryReviewReadiness, DiscoveryReviewView } = await vite.ssrLoadModule("/src/views/DiscoveryReviewView.jsx");
    assert.equal(typeof DiscoveryReviewReadiness, "function");
    for (const message of [
      "Corrija os campos visíveis antes de confirmar a revisão.",
      "Confirme o grupo operacional antes de criar regras.",
      "Confirme a evidência exata de cada item de segurança.",
      "A descoberta mudou enquanto você revisava. Recarregue antes de confirmar.",
    ]) {
      const status = renderToStaticMarkup(React.createElement(DiscoveryReviewReadiness, { message }));
      assert.match(status, /id="discovery-review-readiness"/);
      assert.match(status, /role="status"/);
      assert.match(status, /aria-live="polite"/);
      assert.match(status, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const html = renderToStaticMarkup(React.createElement(DiscoveryReviewView, { discovery: mapDiscoveryRead(discoveryRows()) }));
    assert.match(html, /aria-describedby="discovery-review-readiness"/);
    assert.match(html, /Escolha aprovar, editar ou rejeitar para cada sugestão/);
  } finally {
    await vite.close();
  }
});

test("loading and failure discovery copy never replaces the existing Portuguese interview CTA", async () => {
  const [loading, fallback, disabled, refused, expired, chat] = await Promise.all([
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "loading" } }),
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "fallback", reason: "failed" } }),
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "unavailable", reason: "disabled" } }),
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "unavailable", reason: "not_allowlisted" } }),
    renderModule("/src/views/DiscoveryReviewView.jsx", "DiscoveryReviewView", { discovery: { phase: "unavailable", reason: "allowlist_expired" } }),
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
  assert.match(disabled, /está desativada/);
  assert.match(refused, /não foi liberada/);
  assert.match(expired, /permissão.*expirou/);
  assert.match(chat, /Começar a entrevista de onboarding \(voz\)/);
});

test("durable discovery stages render queued, fetching, and analyzing without blocking onboarding", async () => {
  const rendered = await Promise.all([
    ["queued", "Na fila"],
    ["fetching", "Lendo páginas públicas"],
    ["analyzing", "Organizando sugestões"],
  ].map(async ([processingStage, expected]) => {
    const html = await renderModule(
      "/src/views/DiscoveryReviewView.jsx",
      "DiscoveryReviewView",
      { discovery: { phase: "working", processingStage } },
    );
    return { html, expected };
  }));
  for (const { html, expected } of rendered) {
    assert.match(html, new RegExp(expected));
    assert.match(html, /entrevista.*disponível/i);
  }
});

test("real component interactions block invalid structured edits, submit visible values, and keep mobile voice", { timeout: 25000 }, async (context) => {
  const browserExecutable = await resolveBrowserExecutable();
  if (!browserExecutable) {
    context.skip("browser QA skipped: set LIGOU_TEST_BROWSER_PATH or install Chrome/Chromium");
    return;
  }
  const browser = await startInteractionBrowser(browserExecutable);
  const setField = (selector, value) => `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  try {
    await browser.page.send("Emulation.setDeviceMetricsOverride", {
      width: 320,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.evaluate("document.body.tabIndex = -1; document.body.focus()");
    for (const type of ["keyDown", "keyUp"]) await browser.page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const summaryFocus = JSON.parse(await browser.evaluate(`JSON.stringify({
      tag: document.activeElement.tagName,
      className: document.activeElement.className,
      outline: getComputedStyle(document.activeElement).outlineWidth
    })`));
    assert.deepEqual(summaryFocus, { tag: "SUMMARY", className: "discovery-review-header", outline: "3px" });
    await browser.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await browser.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await browser.evaluate("document.querySelector('.discovery-review').open"), true);
    for (const type of ["keyDown", "keyUp"]) await browser.page.send("Input.dispatchKeyEvent", { type, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const voiceState = JSON.parse(await browser.evaluate(`JSON.stringify({
      shortcut: Boolean(document.querySelector('.discovery-interview-shortcut')),
      shortcutHeight: document.querySelector('.discovery-interview-shortcut')?.getBoundingClientRect().height || 0,
      composerDisplay: getComputedStyle(document.querySelector('.composer')).display,
      chatCta: Boolean(document.querySelector('.onboarding-cta button'))
    })`));
    assert.deepEqual(voiceState, {
      shortcut: true,
      shortcutHeight: 44,
      composerDisplay: "flex",
      chatCta: true,
    });
    assert.equal(await browser.evaluate("document.activeElement.classList.contains('discovery-interview-shortcut')"), true);
    await browser.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await browser.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await browser.evaluate("window.__voiceCalls"), 1);

    await browser.evaluate(`[...document.querySelectorAll('.discovery-claim button')].find((button) => button.textContent.includes('Editar')).click()`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await browser.evaluate("Boolean(document.querySelector('[name=serviceNames]') && document.querySelector('[name=publicAmount]') && document.querySelector('[name=durationMinutes]'))"), true);
    const missingConfirmation = JSON.parse(await browser.evaluate(`JSON.stringify({
      text: document.getElementById('discovery-review-readiness').textContent,
      role: document.getElementById('discovery-review-readiness').getAttribute('role'),
      live: document.getElementById('discovery-review-readiness').getAttribute('aria-live'),
      describedBy: document.querySelector('.discovery-review-actions button').getAttribute('aria-describedby')
    })`));
    assert.deepEqual(missingConfirmation, {
      text: "Confirme o grupo operacional antes de criar regras.",
      role: "status",
      live: "polite",
      describedBy: "discovery-review-readiness",
    });
    assert.equal(await browser.evaluate(setField("[name=publicAmount]", "139")), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const invalidService = JSON.parse(await browser.evaluate(`JSON.stringify({
      disabled: document.querySelector('.discovery-review-actions button').disabled,
      error: document.querySelector('.discovery-edit-field [role=alert]')?.textContent || '',
      readiness: document.getElementById('discovery-review-readiness').textContent,
      rpcCalls: window.__rpcCalls
    })`));
    assert.equal(invalidService.disabled, true);
    assert.match(invalidService.error, /0\.00/);
    assert.match(invalidService.readiness, /Corrija os campos visíveis/);
    assert.equal(invalidService.rpcCalls, 0);

    for (const [selector, value] of [
      ["[name=serviceNames]", "Desentupimento, Limpeza de dreno"],
      ["[name=publicAmount]", "139.00"],
      ["[name=publicCurrency]", "USD"],
      ["[name=publicQualifier]", "exact"],
      ["[name=durationMinutes]", "45"],
    ]) assert.equal(await browser.evaluate(setField(selector, value)), true);
    await browser.evaluate("document.querySelector('.discovery-group-confirmation input').click()");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await browser.evaluate("document.querySelector('.discovery-review-actions button').disabled"), false);
    await browser.evaluate("document.querySelector('.discovery-review-actions button').click()");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const serviceResult = JSON.parse(await browser.evaluate("JSON.stringify({ rpcCalls: window.__rpcCalls, payload: window.__payload })"));
    assert.equal(serviceResult.rpcCalls, 2);
    assert.deepEqual(serviceResult.payload.p_decisions[0].value, {
      service_type: "drain_cleaning",
      service_names: ["Desentupimento", "Limpeza de dreno"],
      public_price: { amount: "139.00", currency: "USD", qualifier: "exact" },
      duration_minutes: 45,
    });

    await browser.navigate("safety");
    await browser.evaluate("document.querySelector('.discovery-review').open = true");
    await browser.evaluate(`[...document.querySelectorAll('.discovery-claim button')].find((button) => button.textContent.includes('Editar')).click()`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await browser.evaluate("Boolean(document.querySelector('[name=emergencyGuidance]'))"), true);
    assert.equal(await browser.evaluate(setField("[name=emergencyGuidance]", "")), true);
    await browser.evaluate("document.querySelector('.discovery-group-confirmation input').click()");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(
      await browser.evaluate("document.getElementById('discovery-review-readiness').textContent"),
      /Corrija os campos visíveis/,
    );
    assert.equal(await browser.evaluate(setField("[name=emergencyGuidance]", "Orientação temporária válida.")), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(
      await browser.evaluate("document.getElementById('discovery-review-readiness').textContent"),
      /Confirme a evidência exata de cada item de segurança/,
    );
    await browser.evaluate("document.querySelector('.discovery-evidence-ack input').click()");
    assert.equal(await browser.evaluate(setField("[name=emergencyGuidance]", "")), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const invalidSafety = JSON.parse(await browser.evaluate(`JSON.stringify({
      disabled: document.querySelector('.discovery-review-actions button').disabled,
      error: document.querySelector('.discovery-edit-field [role=alert]')?.textContent || '',
      rpcCalls: window.__rpcCalls
    })`));
    assert.equal(invalidSafety.disabled, true);
    assert.match(invalidSafety.error, /orientação de emergência/);
    assert.equal(invalidSafety.rpcCalls, 0);

    const guidance = "Feche o registro, saia do imóvel e ligue para 911.";
    assert.equal(await browser.evaluate(setField("[name=emergencyGuidance]", guidance)), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await browser.evaluate("document.querySelector('.discovery-review-actions button').disabled"), false);
    await browser.evaluate("document.querySelector('.discovery-review-actions button').click()");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const safetyResult = JSON.parse(await browser.evaluate("JSON.stringify({ rpcCalls: window.__rpcCalls, payload: window.__payload })"));
    assert.equal(safetyResult.rpcCalls, 2);
    assert.deepEqual(safetyResult.payload.p_decisions[0].value, { guidance });
  } finally {
    await browser.close();
  }
});
