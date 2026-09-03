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
