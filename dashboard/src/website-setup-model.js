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
  "onboarding_amendment_pending",
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
  if(status.voice_protocol_version !== undefined && ![2,3,4].includes(status.voice_protocol_version))
    throw new Error("website voice protocol inválido");
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
  if (!["ready_for_onboarding","onboarding_amendment_pending"].includes(status.state) &&
      (summary !== null || readyProof !== null)) {
    throw new Error("ready proof fora do estado pronto");
  }
  const amendment=status.state==="onboarding_amendment_pending";
  if(amendment && (![3,4].includes(status.voice_protocol_version) || status.amendment_pending!==true ||
    typeof status.amendment_can_resume!=="boolean" || !UUID.test(status.amendment_request_receipt_id??"") || !UUID.test(status.voice_approval_receipt_id??"")))
    throw new Error("amendment proof ausente ou inválido");
  return Object.freeze({
    state: status.state,
    entitlementSource: status.entitlement_source,
    discoveryEnabled: status.discovery_enabled,
    canStart: status.can_start,
    job,
    summary,
    readyProof,
    startOnboardingEnabled: (status.state === "ready_for_onboarding" && readyProof !== null) || (amendment && status.amendment_can_resume),
    approvalReceiptId: UUID.test(status.voice_approval_receipt_id??"")?status.voice_approval_receipt_id:null,
    priorApprovalReceiptId: UUID.test(status.prior_voice_approval_receipt_id??"")?status.prior_voice_approval_receipt_id:null,
    amendmentRequestReceiptId: amendment?status.amendment_request_receipt_id:null,
    voiceProtocolVersion: status.voice_protocol_version ?? 2,
    failureMessage: status.state === "learning_failed"
      ? FAILURE_COPY[job?.failureCode] ?? "Não conseguimos concluir a análise. Confira o endereço e tente novamente."
      : null,
  });
}

const PUBLIC_DETAIL_TYPES = new Set(["service", "service_territory", "business_hours", "booking_restriction"]);
const DAY_LABELS = { mon: "seg", tue: "ter", wed: "qua", thu: "qui", fri: "sex", sat: "sáb", sun: "dom" };

function detailText(value) {
  return typeof value === "string" && value.length <= 2_000 ? value.trim() : "";
}

function detailList(value) {
  return Array.isArray(value) ? value.map(detailText).filter(Boolean) : [];
}

function publicPriceText(price) {
  if (!price || !["fixed", "starting_at", "estimate", "promotional", "conditional", "unknown"].includes(price.qualifier)) return null;
  const hasAmount = typeof price.amount === "string" && /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(price.amount);
  const hasCurrency = typeof price.currency === "string" && /^[A-Z]{3}$/.test(price.currency);
  if (hasAmount !== hasCurrency || (!hasAmount && (price.amount !== null || price.currency !== null))) return null;
  if (["fixed", "starting_at", "conditional"].includes(price.qualifier) && !hasAmount) return null;
  if (price.qualifier === "unknown" && hasAmount) return null;
  const condition = detailText(price.condition);
  // A condition must never be silently dropped while retaining its price.
  if ((price.condition !== null && !condition) || (price.qualifier === "conditional" && !condition)) return null;
  const amount = hasAmount ? `${price.currency} ${price.amount}` : "valor não informado";
  const label = {
    fixed: `Preço fixo: ${amount}`, starting_at: `A partir de ${amount}`,
    estimate: `Estimativa: ${amount}`, promotional: `Promocional: ${amount}`,
    conditional: `Condicional: ${amount}`, unknown: "Valor não informado",
  }[price.qualifier];
  return [label, condition].filter(Boolean).join(" · ");
}

function areaText(area) {
  if (!area || !detailText(area.name)) return "";
  return [detailText(area.name), detailText(area.region_state), detailText(area.country_code)].filter(Boolean).join(", ")
    + ({ marketing_region: " (região ampla)", county: " (condado)" }[area.kind] || "");
}

function publicHoursText(value) {
  const days = (items) => detailList(items).map((day) => DAY_LABELS[day]).filter(Boolean).join(", ");
  const intervals = (Array.isArray(value.ordinary_intervals) ? value.ordinary_intervals : []).flatMap((interval) => {
    if (!interval || !days(interval.days) || !/^\d{2}:\d{2}$/.test(interval.opens) || !/^\d{2}:\d{2}$/.test(interval.closes)) return [];
    return [`${days(interval.days)} ${interval.opens}–${interval.closes}`];
  });
  return [
    value.ordinary_24_7 === true ? "Atendimento normal 24/7" : intervals.length
      ? `Atendimento normal: ${intervals.join("; ")}` : "Horário normal não informado",
    days(value.closed_days) ? `Fechado: ${days(value.closed_days)}` : null,
    value.emergency_24_7 === true ? "Emergência 24/7" : null,
    ({ available: "Fora do horário: disponível", unavailable: "Fora do horário: indisponível",
      emergency_only: "Fora do horário: somente emergências" })[value.after_hours],
    detailText(value.timezone) || "Fuso não informado",
    detailText(value.holiday_policy),
  ].filter(Boolean).join(" · ");
}

// Candidate display only: never changes the server's readiness or exposes raw values.
export function mapWebsiteSetupPublicDetails(setup, claims) {
  if (!setup?.startOnboardingEnabled || !setup.readyProof) return null;
  if (!Array.isArray(claims)) throw new Error("Detalhes indisponíveis");
  const rows = claims.slice(0, 100).filter((claim) => claim &&
    claim.job_id === setup.readyProof.jobId && claim.result_id === setup.readyProof.resultId &&
    claim.claim_class === "operational" && claim.claim_schema_version === "company_discovery.claim.v2" &&
    PUBLIC_DETAIL_TYPES.has(claim.claim_type) && claim.normalized_value &&
    typeof claim.normalized_value === "object" && !Array.isArray(claim.normalized_value));
  const names = new Map(rows.filter((claim) => claim.claim_type === "service").map((claim) =>
    [claim.normalized_value.service_type, detailList(claim.normalized_value.service_names).join(", ")]));
  const details = { prices: [], territories: [], hours: [], conditions: [] };
  for (const claim of rows) {
    const value = claim.normalized_value;
    const scope = names.get(value.service_type) || detailText(value.service_type).replaceAll("_", " ");
    const notes = [
      claim.contradiction_status !== "none" || detailList(claim.ambiguous_fields).length ? "Há pontos incertos a confirmar" : null,
      ...detailList(claim.uncertainty),
    ].filter(Boolean);
    let group;
    let text;
    if (claim.claim_type === "service") {
      const price = publicPriceText(value.public_price);
      if (!price) continue;
      group = "prices";
      text = [scope, price].filter(Boolean).join(" · ");
    } else if (claim.claim_type === "service_territory") {
      const areas = (items) => (Array.isArray(items) ? items : []).map(areaText).filter(Boolean).join("; ");
      const included = areas(value.included_areas);
      const excluded = areas(value.excluded_areas);
      const radius = value.radius;
      group = "territories";
      text = [scope, included ? `Inclui: ${included}` : null, excluded ? `Exclui: ${excluded}` : null,
        radius && detailText(radius.distance) && ["miles", "kilometers"].includes(radius.unit)
          ? `Raio: ${radius.distance} ${radius.unit}${detailText(radius.center) ? ` de ${detailText(radius.center)}` : ""}` : null,
      ].filter(Boolean).join(" · ");
    } else if (claim.claim_type === "business_hours") {
      group = "hours";
      text = publicHoursText(value);
    } else {
      group = "conditions";
      const conditions = detailList(value.conditions);
      if (!conditions.length) continue;
      const restriction = ({
        same_day: "Atendimento no mesmo dia", advance_notice: "Agendamento antecipado",
        weekend: "Atendimento no fim de semana", sunday: "Atendimento aos domingos",
        emergency_only: "Atendimento de emergência", access: "Acesso ao local",
        deposit: "Depósito", cancellation: "Cancelamento", no_show_fee: "Taxa por não comparecimento",
        visit_fee: "Taxa de visita", customer_presence: "Presença do cliente", service_specific: "Condição específica do serviço",
      })[value.restriction_type];
      const rule = ({ allowed: "Permitido", not_allowed: "Não permitido", required: "Obrigatório",
        conditional: "Condicional", fee_applies: "Taxa aplicável", emergency_only: "Somente emergências" })[value.rule];
      if (typeof restriction !== "string" || typeof rule !== "string") continue;
      const notice = Number.isSafeInteger(value.notice_minutes) && value.notice_minutes > 0 && value.notice_minutes <= 525_600
        ? `Antecedência: ${value.notice_minutes} min` : null;
      text = [scope, restriction, rule, notice, publicPriceText(value.public_fee), ...conditions].filter(Boolean).join(" · ");
    }
    if (text) details[group].push([text, ...notes].join(" · "));
  }
  return Object.freeze(Object.fromEntries(Object.entries(details).map(([key, values]) =>
    [key, Object.freeze([...new Set(values)])])));
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
