const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const STATES = new Set([
  "payment_pending",
  "website_required",
  "learning",
  "learning_failed",
  "ready_for_onboarding",
  "onboarding_in_progress",
  "onboarding_complete",
]);

const FAILURE_COPY = Object.freeze({
  fetch_failed: "Não conseguimos acessar o website. Confira o endereço e tente novamente.",
  direct_model_provider_error: "O serviço de análise ficou indisponível. Tente novamente.",
  direct_model_stream_incomplete: "A análise não conseguiu concluir. Tente novamente.",
  direct_model_stream_truncated: "A resposta da análise foi interrompida. Tente novamente.",
  direct_model_protocol_invalid: "A análise retornou uma resposta inválida. Tente novamente.",
  direct_model_deadline_exceeded: "A análise demorou mais que o esperado. Tente novamente.",
  direct_model_schema_invalid: "Não conseguimos organizar as informações do site com segurança.",
  deadline_exceeded: "A análise demorou mais que o esperado. Tente novamente.",
  result_selection_incomplete: "A análise terminou, mas a preparação precisa ser retomada. Tente novamente.",
  legacy_review_requires_restart: "Esta análise antiga precisa ser refeita para continuar com segurança.",
  setup_state_unrecoverable: "Não conseguimos retomar esta preparação. Tente novamente.",
});

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} inválido`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} inválido`);
  return value;
}

function rawJob(value) {
  if (value === null) return null;
  const job = object(value, "job");
  if (!UUID.test(job.job_id ?? "") || !Number.isSafeInteger(job.version) || job.version < 1 ||
      typeof job.status !== "string" || typeof job.processing_stage !== "string" ||
      typeof job.normalized_origin !== "string" || !job.normalized_origin.startsWith("https://") ||
      !(job.failure_code === null || typeof job.failure_code === "string")) {
    throw new Error("job inválido");
  }
  return Object.freeze({
    id: job.job_id,
    version: job.version,
    status: job.status,
    processingStage: job.processing_stage,
    normalizedOrigin: job.normalized_origin,
    failureCode: job.failure_code,
  });
}

function rawSummary(value) {
  if (value === null) return null;
  const summary = object(value, "summary");
  if (!(summary.company_name === null || typeof summary.company_name === "string") ||
      !Array.isArray(summary.services) || summary.services.some((item) => typeof item !== "string")) {
    throw new Error("summary inválido");
  }
  return Object.freeze({
    companyName: summary.company_name,
    services: Object.freeze([...summary.services]),
    pagesAnalyzed: integer(summary.pages_analyzed, "páginas"),
    claimsFound: integer(summary.claims_found, "informações"),
    questionsRemaining: integer(summary.questions_remaining, "perguntas"),
  });
}

function rawReadyProof(value) {
  if (value === null) return null;
  const proof = object(value, "ready proof");
  for (const key of ["job_id", "attempt_id", "result_id", "draft_id"]) {
    if (!UUID.test(proof[key] ?? "")) throw new Error("ready proof inválido");
  }
  for (const key of ["result_hash", "draft_hash"]) {
    if (!HASH.test(proof[key] ?? "")) throw new Error("ready proof inválido");
  }
  return Object.freeze({
    jobId: proof.job_id,
    attemptId: proof.attempt_id,
    resultId: proof.result_id,
    resultHash: proof.result_hash,
    draftId: proof.draft_id,
    draftHash: proof.draft_hash,
  });
}

export function mapWebsiteSetupStatus(value) {
  const status = object(value, "website setup");
  if (status.schema_version !== "company_discovery.setup_status.v1" ||
      !STATES.has(status.state) ||
      !["pilot_allowlist", "none"].includes(status.entitlement_source) ||
      typeof status.discovery_enabled !== "boolean" || typeof status.can_start !== "boolean") {
    throw new Error("website setup inválido");
  }
  const job = rawJob(status.job);
  const summary = rawSummary(status.summary);
  const readyProof = rawReadyProof(status.ready_proof);
  if (status.state === "ready_for_onboarding" &&
      (!job || !summary || !readyProof || job.id !== readyProof.jobId ||
        !["ready_for_onboarding", "reviewed"].includes(job.processingStage))) {
    throw new Error("ready proof ausente ou inválido");
  }
  if (status.state !== "ready_for_onboarding" &&
      (summary !== null || readyProof !== null)) {
    throw new Error("ready proof fora do estado pronto");
  }
  return Object.freeze({
    state: status.state,
    entitlementSource: status.entitlement_source,
    discoveryEnabled: status.discovery_enabled,
    canStart: status.can_start,
    job,
    summary,
    readyProof,
    startOnboardingEnabled: status.state === "ready_for_onboarding" && readyProof !== null,
    failureMessage: status.state === "learning_failed"
      ? FAILURE_COPY[job?.failureCode] ?? "Não conseguimos concluir a análise. Confira o endereço e tente novamente."
      : null,
  });
}

export function validateWebsiteUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("Informe um endereço HTTPS público válido.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.port || !url.hostname || url.hostname === "localhost") {
    throw new Error("Informe um endereço HTTPS público válido.");
  }
  return url.href;
}

export function websiteSetupOwnsScreen(setup, tenantStatus) {
  return tenantStatus === "onboarding" && setup?.state !== "onboarding_complete";
}

export function preserveWebsiteSetupAfterReadFailure(currentSetup) {
  return currentSetup;
}

export const WEBSITE_SETUP_STATES = Object.freeze([...STATES]);
