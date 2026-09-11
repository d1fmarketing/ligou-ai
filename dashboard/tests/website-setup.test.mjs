import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

import {
  mapWebsiteSetupStatus,
  preserveWebsiteSetupAfterReadFailure,
  websiteSetupOwnsScreen,
  validateWebsiteUrl,
} from "../src/website-setup-model.js";

const UUID = "10000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let sharedVite;
let sharedCacheDir;

async function viteServer() {
  if (sharedVite) return sharedVite;
  sharedCacheDir = await mkdtemp(path.join(tmpdir(), "ligou-website-setup-vite-"));
  sharedVite = await createServer({
    configFile: false,
    root: dashboardRoot,
    appType: "custom",
    cacheDir: sharedCacheDir,
    server: { middlewareMode: true, hmr: false },
    resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  return sharedVite;
}

after(async () => {
  await sharedVite?.close();
  if (sharedCacheDir) await rm(sharedCacheDir, { recursive: true, force: true });
});

async function renderSetup(props) {
  const vite = await viteServer();
  const { WebsiteSetupView } = await vite.ssrLoadModule("/src/views/WebsiteSetupView.jsx");
  return renderToStaticMarkup(React.createElement(WebsiteSetupView, props));
}

async function withDashboardModule(id, callback) {
  const vite = await viteServer();
  return callback(await vite.ssrLoadModule(id));
}

function status(state, overrides = {}) {
  return {
    schema_version: "company_discovery.setup_status.v1",
    state,
    entitlement_source: "pilot_allowlist",
    discovery_enabled: true,
    can_start: true,
    job: null,
    summary: null,
    ready_proof: null,
    ...overrides,
  };
}

test("maps every durable website setup state without inventing readiness", () => {
  for (const state of [
    "payment_pending",
    "website_required",
    "learning",
    "learning_failed",
    "onboarding_in_progress",
    "onboarding_complete",
  ]) {
    assert.equal(mapWebsiteSetupStatus(status(state)).state, state);
  }

  assert.throws(() => mapWebsiteSetupStatus(status("ready_for_onboarding")), /ready proof/i);
  const ready = mapWebsiteSetupStatus(status("ready_for_onboarding", {
    job: {
      job_id: UUID,
      version: 4,
      status: "awaiting_review",
      processing_stage: "ready_for_onboarding",
      normalized_origin: "https://foghorn-air.vercel.app/",
      failure_code: null,
    },
    summary: {
      company_name: "Foghorn Air",
      services: ["Air conditioning", "Heat pumps"],
      pages_analyzed: 5,
      claims_found: 8,
      questions_remaining: 6,
    },
    ready_proof: {
      job_id: UUID,
      attempt_id: "10000000-0000-4000-8000-000000000002",
      result_id: "10000000-0000-4000-8000-000000000003",
      result_hash: HASH,
      draft_id: "10000000-0000-4000-8000-000000000004",
      draft_hash: HASH,
    },
  }));
  assert.equal(ready.state, "ready_for_onboarding");
  assert.equal(ready.summary.pagesAnalyzed, 5);
  assert.equal(ready.startOnboardingEnabled, true);
  const legacyReady = mapWebsiteSetupStatus(status("ready_for_onboarding", {
    job: {
      job_id: UUID,
      version: 5,
      status: "reviewed",
      processing_stage: "reviewed",
      normalized_origin: "https://foghorn-air.vercel.app/",
      failure_code: null,
    },
    summary: {
      company_name: "Foghorn Air",
      services: [],
      pages_analyzed: 5,
      claims_found: 0,
      questions_remaining: 1,
    },
    ready_proof: {
      job_id: UUID,
      attempt_id: "10000000-0000-4000-8000-000000000002",
      result_id: "10000000-0000-4000-8000-000000000003",
      result_hash: HASH,
      draft_id: "10000000-0000-4000-8000-000000000004",
      draft_hash: HASH,
    },
  }));
  assert.equal(legacyReady.startOnboardingEnabled, true);
});

test('pending amendment preserves approval and permits only a proven settled resume',async()=>{
 const value=status('onboarding_amendment_pending',{voice_protocol_version:3,amendment_pending:true,
  amendment_can_resume:false,amendment_request_receipt_id:UUID,voice_approval_receipt_id:UUID});
 const pending=mapWebsiteSetupStatus(value);
 assert.equal(pending.approvalReceiptId,UUID);assert.equal(pending.startOnboardingEnabled,false);
 const html=await renderSetup({setup:pending});assert.match(html,/versão aprovada/i);assert.match(html,/disabled/);
 const ready=mapWebsiteSetupStatus({...value,amendment_can_resume:true});assert.equal(ready.startOnboardingEnabled,true);
 assert.throws(()=>mapWebsiteSetupStatus({...value,voice_approval_receipt_id:null}),/amendment proof/i);
});
test('an active or approved-closing interview cannot start a competing attempt from the setup page',async()=>{
 for(const proof of [{},{voice_approval_receipt_id:UUID}]){
  const setup=mapWebsiteSetupStatus(status('onboarding_in_progress',{voice_protocol_version:3,...proof}));
  const html=await renderSetup({setup});assert.match(html,/disabled/);
 }
});

test("validates one public HTTPS website URL", () => {
  assert.equal(validateWebsiteUrl("https://foghorn-air.vercel.app"), "https://foghorn-air.vercel.app/");
  for (const candidate of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/#fragment",
    "not a url",
  ]) assert.throws(() => validateWebsiteUrl(candidate), /HTTPS público válido/);
});

test("setup owns the authenticated onboarding screen until completion", () => {
  assert.equal(websiteSetupOwnsScreen({ state: "website_required" }, "onboarding"), true);
  assert.equal(websiteSetupOwnsScreen({ state: "ready_for_onboarding" }, "onboarding"), true);
  assert.equal(websiteSetupOwnsScreen({ state: "onboarding_complete" }, "active"), false);
  assert.equal(websiteSetupOwnsScreen({ state: "website_required" }, "active"), false);
  assert.equal(websiteSetupOwnsScreen({ state: "loading" }, "onboarding"), true);
});

test("a transient setup read failure preserves the last authoritative state", () => {
  const learning = Object.freeze({
    state: "learning",
    job: Object.freeze({ processingStage: "analyzing" }),
  });
  assert.equal(preserveWebsiteSetupAfterReadFailure(learning), learning);
  assert.equal(preserveWebsiteSetupAfterReadFailure(learning).state, "learning");
});

test("maps only owner-safe failure codes", () => {
  const rawJob = {
    job_id: UUID,
    version: 7,
    status: "failed",
    processing_stage: "failed",
    normalized_origin: "https://foghorn-air.vercel.app/",
    failure_code: "direct_model_stream_incomplete",
  };
  const failed = mapWebsiteSetupStatus(status("learning_failed", {
    job: rawJob,
  }));
  assert.match(failed.failureMessage, /não conseguiu concluir/i);
  const unknown = mapWebsiteSetupStatus(status("learning_failed", {
    job: { ...rawJob, failure_code: "secret internal stack" },
  }));
  assert.doesNotMatch(unknown.failureMessage, /secret internal stack/i);
});

test("renders website, real learning progress, failure, and ready states without internal jargon", async () => {
  const website = await renderSetup({ setup: mapWebsiteSetupStatus(status("website_required")) });
  assert.match(website, /Vamos conhecer sua empresa/);
  assert.match(website, /Conhecer minha empresa/);
  assert.doesNotMatch(website, /OpenClaw|DirectModel|SSE|worker|claims/i);
  const disabledWebsite = await renderSetup({
    setup: mapWebsiteSetupStatus(status("website_required", {
      discovery_enabled: false,
      can_start: false,
    })),
  });
  assert.match(disabledWebsite, /Conhecer minha empresa<\/button>/);
  assert.match(disabledWebsite, /disabled/);

  const learning = await renderSetup({ setup: mapWebsiteSetupStatus(status("learning", {
    job: {
      job_id: UUID,
      version: 2,
      status: "running",
      processing_stage: "analyzing",
      normalized_origin: "https://foghorn-air.vercel.app/",
      failure_code: null,
    },
  })) });
  assert.match(learning, /O Ligou está conhecendo sua empresa/);
  assert.match(learning, /Organizando as informações/);
  assert.match(learning, /disabled/);
  const learningWithReadFailure = await renderSetup({
    setup: mapWebsiteSetupStatus(status("learning", {
      job: {
        job_id: UUID,
        version: 2,
        status: "running",
        processing_stage: "analyzing",
        normalized_origin: "https://foghorn-air.vercel.app/",
        failure_code: null,
      },
    })),
    loadError: "Não foi possível atualizar agora. Tentaremos novamente.",
  });
  assert.match(learningWithReadFailure, /Tentaremos novamente/);
  assert.match(learningWithReadFailure, /Organizando as informações/);

  const failed = await renderSetup({ setup: mapWebsiteSetupStatus(status("learning_failed", {
    job: {
      job_id: UUID,
      version: 3,
      status: "failed",
      processing_stage: "failed",
      normalized_origin: "https://foghorn-air.vercel.app/",
      failure_code: "direct_model_deadline_exceeded",
    },
  })) });
  assert.match(failed, /Tentar novamente/);
  assert.doesNotMatch(failed, /direct_model|deadline_exceeded/);

  const ready = await renderSetup({ setup: mapWebsiteSetupStatus(status("ready_for_onboarding", {
    job: {
      job_id: UUID,
      version: 4,
      status: "awaiting_review",
      processing_stage: "ready_for_onboarding",
      normalized_origin: "https://foghorn-air.vercel.app/",
      failure_code: null,
    },
    summary: {
      company_name: "Foghorn Air",
      services: ["Air conditioning", "Heat pumps"],
      pages_analyzed: 5,
      claims_found: 8,
      questions_remaining: 6,
    },
    ready_proof: {
      job_id: UUID,
      attempt_id: "10000000-0000-4000-8000-000000000002",
      result_id: "10000000-0000-4000-8000-000000000003",
      result_hash: HASH,
      draft_id: "10000000-0000-4000-8000-000000000004",
      draft_hash: HASH,
    },
  })) });
  assert.match(ready, /O Ligou já conhece o básico da sua empresa/);
  assert.match(ready, /Foghorn Air/);
  assert.match(ready, /5 páginas/);
  assert.match(ready, /Começar onboarding/);
  assert.doesNotMatch(ready, /Começar onboarding[^<]*disabled/);
});

test("uses only owner-scoped setup RPCs and never sends a tenant or client idempotency key", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({
    loadWebsiteSetupVia,
    startWebsiteSetupVia,
    retryWebsiteSetupVia,
  }) => {
    const calls = [];
    const client = {
      async rpc(name, payload) {
        calls.push([name, payload]);
        if (name === "company_discovery_setup_status") {
          return { data: status("website_required"), error: null };
        }
        return { data: { job_id: UUID, status: "queued", version: 1 }, error: null };
      },
    };

    assert.equal((await loadWebsiteSetupVia(client)).state, "website_required");
    await startWebsiteSetupVia(client, "https://foghorn-air.vercel.app/");
    await retryWebsiteSetupVia(client, UUID, 7);
    assert.deepEqual(calls, [
      ["company_discovery_setup_status", undefined],
      ["start_company_discovery_setup", { p_url: "https://foghorn-air.vercel.app/" }],
      ["retry_company_discovery_setup", { p_job: UUID, p_expected_version: 7 }],
    ]);
    assert.equal(JSON.stringify(calls).includes("tenant"), false);
    assert.equal(JSON.stringify(calls).includes("idempotency"), false);
  });
});

test("website-first onboarding locks the voice panel to the current onboarding runtime", async () => {
  await withDashboardModule("/src/voice/VoicePanel.jsx", async ({ VoicePanel }) => {
    const html = renderToStaticMarkup(React.createElement(VoicePanel, {
      onClose() {},
      initialSessionType: "onboarding",
      lockedOnboarding: true,
    }));
    assert.match(html, /Começar entrevista/);
    assert.doesNotMatch(html, /Tipo de conversa/);
    assert.doesNotMatch(html, />Modelo</);
  });
});

function readyStatus() {
  return status("ready_for_onboarding", {
    job: { job_id: UUID, version: 4, status: "awaiting_review", processing_stage: "ready_for_onboarding",
      normalized_origin: "https://foghorn-air.vercel.app/", failure_code: null },
    summary: { company_name: "Foghorn Air", services: ["Heat pumps"], pages_analyzed: 5,
      claims_found: 8, questions_remaining: 6 },
    ready_proof: { job_id: UUID, attempt_id: "10000000-0000-4000-8000-000000000002",
      result_id: "10000000-0000-4000-8000-000000000003", result_hash: HASH,
      draft_id: "10000000-0000-4000-8000-000000000004", draft_hash: HASH },
  });
}

test('durable setup protocol identity remains readable across Live and historical formats',()=>{
  assert.equal(mapWebsiteSetupStatus(readyStatus()).voiceProtocolVersion,2);
  assert.equal(mapWebsiteSetupStatus({...readyStatus(),voice_protocol_version:3}).voiceProtocolVersion,3);
  assert.equal(mapWebsiteSetupStatus({...readyStatus(),voice_protocol_version:4}).voiceProtocolVersion,4);
  assert.equal(mapWebsiteSetupStatus({...readyStatus(),voice_protocol_version:5}).voiceProtocolVersion,5);
  assert.equal(mapWebsiteSetupStatus({...readyStatus(),voice_protocol_version:6}).voiceProtocolVersion,6);
  assert.throws(()=>mapWebsiteSetupStatus({...readyStatus(),voice_protocol_version:7}),/protocol/i);
});

function publicClaim(claim_type, normalized_value, overrides = {}) {
  return { job_id: UUID, result_id: readyStatus().ready_proof.result_id, claim_class: "operational",
    claim_schema_version: "company_discovery.claim.v2", claim_type, normalized_value,
    uncertainty: [], ambiguous_fields: [], contradiction_status: "none", ...overrides };
}

function serviceClaim(qualifier = "starting_at", condition = "After an on-site assessment") {
  return publicClaim("service", { service_type: "heat_pumps", service_names: ["Heat pumps"],
    public_price: { amount: "89.00", currency: "USD", qualifier, condition }, duration_minutes: null });
}

// Only the external Supabase boundary is doubled; mapping and SSR remain real.
function setupClient(rawStatus, claims, { error = null, reject = false } = {}) {
  const calls = [];
  const query = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  query.then = (resolve, fail) => reject
    ? Promise.reject(new Error("private transport diagnostic")).then(resolve, fail)
    : Promise.resolve({ data: claims, error }).then(resolve, fail);
  return {
    calls,
    client: {
      async rpc(name, payload) {
        calls.push(["rpc", name, payload]);
        assert.equal(name, "company_discovery_setup_status");
        return { data: rawStatus, error: null };
      },
      from(table) { calls.push(["from", table]); return query; },
    },
  };
}

test("ready summary loads only normalized public claims bound to the server-selected job and result", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const current = serviceClaim();
    const fake = setupClient(readyStatus(), [current,
      serviceClaim("promotional", "Offer ends Sunday"),
      { ...serviceClaim(), job_id: "20000000-0000-4000-8000-000000000001",
        normalized_value: { ...current.normalized_value, service_names: ["Foreign job"] } },
      { ...serviceClaim(), result_id: "20000000-0000-4000-8000-000000000003",
        normalized_value: { ...current.normalized_value, service_names: ["Foreign result"] } },
      { ...serviceClaim(), claim_class: "owner_private",
        normalized_value: { ...current.normalized_value, service_names: ["Private fact"] } },
      { ...serviceClaim(), claim_schema_version: "company_discovery.claim.v1",
        normalized_value: { ...current.normalized_value, service_names: ["Legacy value"] } },
      publicClaim("private_price", { amount: "private secret" }),
    ]);
    const setup = await loadWebsiteSetupVia(fake.client);
    assert.deepEqual(setup.publicDetails?.prices, [
      "Heat pumps · A partir de USD 89.00 · After an on-site assessment",
      "Heat pumps · Promocional: USD 89.00 · Offer ends Sunday",
    ]);
    assert.equal(setup.startOnboardingEnabled, true);
    assert.equal(setup.readyProof.resultId, readyStatus().ready_proof.result_id);
    assert.deepEqual(fake.calls, [
      ["rpc", "company_discovery_setup_status", undefined], ["from", "discovery_claims"],
      ["select", "job_id,result_id,claim_class,claim_type,claim_schema_version,normalized_value,uncertainty,ambiguous_fields,contradiction_status"],
      ["eq", "job_id", UUID], ["eq", "result_id", readyStatus().ready_proof.result_id],
      ["eq", "claim_class", "operational"],
      ["in", "claim_type", ["service", "service_territory", "business_hours", "booking_restriction"]],
      ["order", "created_at", { ascending: true }], ["limit", 100],
    ]);
    assert.equal(Object.hasOwn(setup.publicDetails, "normalized_value"), false);
  });
});

test("public prices preserve every qualifier and condition, including zero and unpriced estimates", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const claims = ["fixed", "starting_at", "estimate", "promotional", "conditional", "unknown"].map((qualifier) => {
      const claim = serviceClaim(qualifier, "Conditions still apply");
      claim.normalized_value.public_price.amount = qualifier === "unknown" ? null : "0.00";
      claim.normalized_value.public_price.currency = qualifier === "unknown" ? null : "USD";
      return claim;
    });
    const unpriced = serviceClaim("estimate", "After inspection");
    unpriced.normalized_value.public_price.amount = null;
    unpriced.normalized_value.public_price.currency = null;
    const unsafe = publicClaim("service", { service_names: ["Private"], private_price: "900", authority: "approved" });
    const setup = await loadWebsiteSetupVia(setupClient(readyStatus(), [...claims, unpriced, unsafe]).client);
    assert.deepEqual(setup.publicDetails?.prices, [
      "Heat pumps · Preço fixo: USD 0.00 · Conditions still apply",
      "Heat pumps · A partir de USD 0.00 · Conditions still apply",
      "Heat pumps · Estimativa: USD 0.00 · Conditions still apply",
      "Heat pumps · Promocional: USD 0.00 · Conditions still apply",
      "Heat pumps · Condicional: USD 0.00 · Conditions still apply",
      "Heat pumps · Valor não informado · Conditions still apply",
      "Heat pumps · Estimativa: valor não informado · After inspection",
    ]);
  });
});

test("ready render preserves broad territory, hours distinctions, fees and candidate-only wording", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const territory = publicClaim("service_territory", { service_type: "heat_pumps",
      included_areas: [{ kind: "marketing_region", name: "Greater Bay Area", region_state: null, country_code: null },
        { kind: "county", name: "Alameda", region_state: "CA", country_code: "US" }],
      excluded_areas: [{ kind: "city", name: "Napa", region_state: "CA", country_code: "US" }],
      radius: { distance: "25", unit: "miles", center: "Novato" } },
    { uncertainty: ["Coverage depends on the address"], ambiguous_fields: ["included_areas"] });
    const hours = publicClaim("business_hours", { timezone: "America/Los_Angeles",
      ordinary_intervals: [{ days: ["mon", "fri"], opens: "08:00", closes: "18:00" }],
      closed_days: ["sun"], ordinary_24_7: false, emergency_24_7: true,
      after_hours: "emergency_only", holiday_policy: "Call ahead on holidays" });
    const booking = publicClaim("booking_restriction", { restriction_type: "visit_fee", service_type: "heat_pumps",
      rule: "fee_applies", notice_minutes: null, public_fee: { amount: "89.00", currency: "USD",
        qualifier: "conditional", condition: "Waived if repair approved" },
      conditions: ["Only within the service area", "<img src=x onerror=alert(1)>"], authority: "active private rule" });
    const setup = await loadWebsiteSetupVia(setupClient(readyStatus(), [serviceClaim(), territory, hours, booking]).client);
    const html = await renderSetup({ setup });
    for (const text of ["Preços e condições publicados", "Área de atendimento", "Horários publicados",
      "Informações candidatas do website", "não são regras ativas", "Greater Bay Area (região ampla)",
      "Coverage depends on the address", "Alameda, CA, US (condado)", "Exclui: Napa, CA, US", "25 miles de Novato", "Heat pumps",
      "Atendimento normal: seg, sex 08:00–18:00", "Emergência 24/7", "Fechado: dom",
      "America/Los_Angeles", "Call ahead on holidays", "Waived if repair approved", "Only within the service area",
      "A partir de USD 89.00", "After an on-site assessment"]) assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /Atendimento normal 24\/7|active private rule|<img/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html.match(/<button[^>]*>Começar onboarding<\/button>/)?.[0] ?? "missing", /disabled|missing/);
  });
});

test("missing public details and read failures never revoke proven readiness or invent missing facts", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    for (const options of [{}, { error: { message: "private DB diagnostic" } }, { reject: true }]) {
      const setup = await loadWebsiteSetupVia(setupClient(readyStatus(), [], options).client);
      assert.equal(setup.startOnboardingEnabled, true);
      assert.equal(setup.summary.companyName, "Foghorn Air");
      assert.equal(setup.readyProof.resultId, readyStatus().ready_proof.result_id);
      const html = await renderSetup({ setup });
      assert.doesNotMatch(html, /private DB diagnostic|private transport diagnostic|USD|24\/7/);
      assert.match(html, /A confirmar no onboarding/);
      if (options.error || options.reject) assert.match(html, /Não foi possível carregar os detalhes/);
      assert.doesNotMatch(html.match(/<button[^>]*>Começar onboarding<\/button>/)?.[0] ?? "missing", /disabled|missing/);
    }
    const hours = publicClaim("business_hours", { timezone: null, ordinary_intervals: [], closed_days: [],
      ordinary_24_7: false, emergency_24_7: true, after_hours: "emergency_only", holiday_policy: null });
    const html = await renderSetup({ setup: await loadWebsiteSetupVia(setupClient(readyStatus(), [hours]).client) });
    assert.match(html, /Horário normal não informado/);
    assert.match(html, /Fuso não informado/);
    assert.doesNotMatch(html, /America\/|Atendimento normal 24\/7/);
    const ordinary = { ...hours, normalized_value: { ...hours.normalized_value, ordinary_24_7: true, emergency_24_7: false } };
    const ordinaryHtml = await renderSetup({ setup: await loadWebsiteSetupVia(setupClient(readyStatus(), [ordinary]).client) });
    assert.match(ordinaryHtml, /Atendimento normal 24\/7/);
    assert.doesNotMatch(ordinaryHtml, /Emergência 24\/7/);
  });
});

test("unproven statuses never query optional claims or acquire readiness", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const fake = setupClient(status("learning"), [serviceClaim()]);
    const setup = await loadWebsiteSetupVia(fake.client);
    assert.equal(setup.startOnboardingEnabled, false);
    assert.deepEqual(fake.calls, [["rpc", "company_discovery_setup_status", undefined]]);
    const forged = setupClient({ ...readyStatus(), ready_proof: null }, [serviceClaim()]);
    await assert.rejects(loadWebsiteSetupVia(forged.client), /ready proof/);
    assert.deepEqual(forged.calls, [["rpc", "company_discovery_setup_status", undefined]]);
  });
});

test("failure offers a non-mutating Continue later exit even when retry is unavailable", async () => {
  const setup = mapWebsiteSetupStatus(status("learning_failed", { can_start: false }));
  const before = JSON.stringify(setup);
  const html = await renderSetup({ setup, busy: true });
  assert.match(html, /<a[^>]*href="\/"[^>]*>Continuar depois<\/a>/);
  assert.equal(JSON.stringify(setup), before);
});

test("booking summary preserves required published advance notice even when conditions do not repeat it", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const booking = publicClaim("booking_restriction", { restriction_type: "advance_notice", service_type: "heat_pumps",
      rule: "required", notice_minutes: 2880, public_fee: null, conditions: ["For residential appointments"] });
    const setup = await loadWebsiteSetupVia(setupClient(readyStatus(), [serviceClaim(), booking]).client);
    assert.deepEqual(setup.publicDetails.conditions, [
      "Heat pumps · Agendamento antecipado · Obrigatório · Antecedência: 2880 min · For residential appointments",
    ]);
    const html = await renderSetup({ setup });
    assert.match(html, /Agendamento antecipado · Obrigatório · Antecedência: 2880 min/);
    assert.match(html, /Informações candidatas do website/);
    assert.match(html, /não são regras ativas/);
    assert.equal(setup.startOnboardingEnabled, true);
  });
});

test("booking public fee remains attached to its no-show applicability, qualifier and conditions", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const booking = publicClaim("booking_restriction", { restriction_type: "no_show_fee", service_type: null,
      rule: "fee_applies", notice_minutes: null,
      public_fee: { amount: "89.00", currency: "USD", qualifier: "fixed", condition: "Only after confirmation" },
      conditions: ["For residential appointments"] });
    const setup = await loadWebsiteSetupVia(setupClient(readyStatus(), [booking]).client);
    assert.deepEqual(setup.publicDetails.conditions, [
      "Taxa por não comparecimento · Taxa aplicável · Preço fixo: USD 89.00 · Only after confirmation · For residential appointments",
    ]);
    const html = await renderSetup({ setup });
    assert.match(html, /Taxa por não comparecimento · Taxa aplicável · Preço fixo: USD 89.00/);
    assert.doesNotMatch(html, /Antecedência:/);
  });
});

test("opposite published Sunday rules remain distinguishable and are never deduplicated together", async () => {
  await withDashboardModule("/src/data/gateway.supabase.js", async ({ loadWebsiteSetupVia }) => {
    const bookings = ["allowed", "not_allowed"].map((rule) => publicClaim("booking_restriction", {
      restriction_type: "sunday", service_type: null, rule, notice_minutes: null, public_fee: null,
      conditions: ["Residential customers"],
    }));
    const setup = await loadWebsiteSetupVia(setupClient(readyStatus(), bookings).client);
    assert.deepEqual(setup.publicDetails.conditions, [
      "Atendimento aos domingos · Permitido · Residential customers",
      "Atendimento aos domingos · Não permitido · Residential customers",
    ]);
    const html = await renderSetup({ setup });
    assert.match(html, /Atendimento aos domingos · Permitido/);
    assert.match(html, /Atendimento aos domingos · Não permitido/);
  });
});

test('website status accepts Live6 while preserving historical protocol identity',()=>{
 for(const version of [2,3,4,5,6]){
  const setup=mapWebsiteSetupStatus(status('onboarding_in_progress',{voice_protocol_version:version}));
  assert.equal(setup.voiceProtocolVersion,version);
 }
});
