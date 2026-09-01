const GROUPS = [
  {
    id: "descriptive",
    label: "Dados públicos",
    description: "Identidade e contatos públicos. Sua confirmação atualiza apenas o perfil da empresa.",
  },
  {
    id: "operational",
    label: "Operação",
    description: "Serviços, duração e preço publicado. Só viram regra após confirmação explícita do grupo.",
  },
  {
    id: "safety",
    label: "Segurança",
    description: "Orientações críticas. Exigem leitura e reconhecimento da evidência exata.",
  },
];

const CLASS_TO_GROUP = {
  descriptive: "descriptive",
  operational: "operational",
  safety_critical: "safety",
};

const FALLBACK_ERROR_CODES = new Set([
  "company_discovery_disabled",
  "company_discovery_tenant_not_allowlisted",
  "company_discovery_deadline_expired",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isAllowlisted(allowlist, now) {
  if (!allowlist?.active) return false;
  if (!allowlist.expires_at) return true;
  return Date.parse(allowlist.expires_at) > Date.parse(now);
}

function evidenceProjection(source) {
  return {
    id: source.id,
    url: source.url,
    excerpt: source.excerpt,
    contentHash: source.content_hash,
    crawlOrder: source.crawl_order,
  };
}

export function mapDiscoveryRead({
  allowlist = null,
  job = null,
  result = null,
  claims = [],
  sources = [],
  decisions = [],
  errorCode = null,
  hasOwnerAnswers = false,
  now = new Date().toISOString(),
} = {}) {
  if (FALLBACK_ERROR_CODES.has(errorCode)) {
    return { phase: "fallback", reason: errorCode, interviewAvailable: true };
  }
  if (!isAllowlisted(allowlist, now)) {
    return {
      phase: "unavailable",
      reason: allowlist?.active ? "allowlist_expired" : "not_allowlisted",
      interviewAvailable: true,
    };
  }
  if (!job) return { phase: "empty", interviewAvailable: true };

  const deadlineExpired = ["queued", "running"].includes(job.status)
    && Date.parse(job.deadline_at) <= Date.parse(now);
  if (["failed", "cancelled"].includes(job.status) || deadlineExpired) {
    return {
      phase: "fallback",
      reason: deadlineExpired ? "deadline_expired" : job.status,
      job: { id: job.id, version: Number(job.version), status: job.status },
      interviewAvailable: true,
    };
  }
  if (["queued", "running"].includes(job.status)) {
    return {
      phase: "working",
      job: { id: job.id, version: Number(job.version), status: job.status },
      interviewAvailable: true,
    };
  }

  const exactResult = result
    && result.job_id === job.id
    && result.attempt_id === job.selected_attempt_id
    ? result
    : null;
  if (!exactResult) {
    return {
      phase: job.status === "reviewed" ? "complete" : "working",
      job: { id: job.id, version: Number(job.version), status: job.status },
      interviewAvailable: true,
    };
  }

  const sourceById = new Map(
    sources
      .filter((source) => source.result_id === exactResult.id)
      .map((source) => [source.id, source]),
  );
  const decidedIds = new Set(
    decisions
      .filter((decision) => decision.result_id === exactResult.id)
      .map((decision) => decision.claim_id),
  );
  const mappedClaims = claims
    .filter((claim) => claim.result_id === exactResult.id && !decidedIds.has(claim.id))
    .map((claim) => ({
      id: claim.id,
      resultId: claim.result_id,
      version: Number(claim.claim_version),
      class: claim.claim_class,
      type: claim.claim_type,
      value: clone(claim.normalized_value),
      evidenceRefs: asArray(claim.evidence_refs).slice(),
      evidence: asArray(claim.evidence_refs)
        .map((id) => sourceById.get(id))
        .filter(Boolean)
        .sort((left, right) => left.crawl_order - right.crawl_order)
        .map(evidenceProjection),
      contradictions: asArray(claim.contradictions).map(String),
      uncertainty: asArray(claim.uncertainty).map(String),
      decision: null,
    }));

  const groups = GROUPS.map((group) => ({
    ...group,
    claims: mappedClaims.filter((claim) => CLASS_TO_GROUP[claim.class] === group.id),
  })).filter((group) => group.claims.length > 0);
  const privateQuestions = asArray(exactResult.candidate_result?.missing_questions).map((question, index) => ({
    id: `private-question-${index + 1}`,
    question: String(question),
    approvable: false,
  }));
  const unknownClaims = mappedClaims.filter((claim) => !CLASS_TO_GROUP[claim.class]);
  if (unknownClaims.length) groups.push({ id: "private", label: "Assuntos privados", claims: unknownClaims });

  return {
    phase: job.status === "reviewed" || mappedClaims.length === 0 ? "complete" : "review",
    interviewAvailable: true,
    authorityEffect: "suggestion_only",
    lateSuggestion: Boolean(hasOwnerAnswers),
    job: {
      id: job.id,
      version: Number(job.version),
      status: job.status,
      origin: job.normalized_origin,
      deadlineAt: job.deadline_at,
      fallbackState: job.fallback_state,
    },
    result: {
      id: exactResult.id,
      attemptId: exactResult.attempt_id,
      hash: exactResult.result_hash,
    },
    groups,
    privateQuestions,
    contradictions: asArray(exactResult.candidate_result?.contradictions).map(String),
    uncertainty: asArray(exactResult.candidate_result?.uncertainty).map(String),
  };
}

export function createDiscoveryReviewState(review) {
  const claims = asArray(review?.groups).flatMap((group) => asArray(group.claims));
  return {
    expectedJobVersion: review?.job?.version ?? null,
    expectedResultId: review?.result?.id ?? null,
    expectedClaimVersions: Object.fromEntries(claims.map((claim) => [claim.id, claim.version])),
    decisions: Object.fromEntries(claims.map((claim) => [claim.id, {
      decision: null,
      value: clone(claim.value),
    }])),
    confirmations: { descriptive: false, operational: false, safety: false },
    evidenceAcks: {},
  };
}

export function discoveryReviewReducer(state, action) {
  if (action.type === "reset") return createDiscoveryReviewState(action.review);
  if (action.type === "decide" && ["approve", "edit", "reject"].includes(action.decision)) {
    if (!state.decisions[action.claimId]) return state;
    return {
      ...state,
      decisions: {
        ...state.decisions,
        [action.claimId]: { ...state.decisions[action.claimId], decision: action.decision },
      },
    };
  }
  if (action.type === "edit") {
    if (!state.decisions[action.claimId]) return state;
    return {
      ...state,
      decisions: {
        ...state.decisions,
        [action.claimId]: { decision: "edit", value: clone(action.value) },
      },
    };
  }
  if (action.type === "confirm" && Object.hasOwn(state.confirmations, action.group)) {
    return {
      ...state,
      confirmations: { ...state.confirmations, [action.group]: Boolean(action.checked) },
    };
  }
  if (action.type === "ackEvidence") {
    return {
      ...state,
      evidenceAcks: { ...state.evidenceAcks, [action.claimId]: Boolean(action.checked) },
    };
  }
  return state;
}

export function buildDiscoveryReviewRequest(review, state, nonce) {
  const groups = asArray(review?.groups);
  if (groups.some((group) => group.id === "private")) {
    throw new Error("Assuntos privados só podem virar perguntas da entrevista, nunca fatos aprováveis.");
  }
  if (review?.phase !== "review" || !review.job?.id || !review.result?.id) {
    throw new Error("Esta revisão não está disponível.");
  }
  if (state?.expectedJobVersion !== review.job.version || state?.expectedResultId !== review.result.id) {
    throw new Error("A descoberta mudou enquanto você revisava. Recarregue antes de confirmar.");
  }

  const claims = groups.flatMap((group) => asArray(group.claims));
  for (const claim of claims) {
    if (!claim.evidenceRefs?.length || claim.evidence?.length !== claim.evidenceRefs.length) {
      throw new Error("A evidência desta sugestão não carregou por completo. Recarregue antes de decidir.");
    }
    if (state.expectedClaimVersions?.[claim.id] !== claim.version) {
      throw new Error("A descoberta mudou enquanto você revisava. Recarregue antes de confirmar.");
    }
    if (!["approve", "edit", "reject"].includes(state.decisions?.[claim.id]?.decision)) {
      throw new Error("Escolha aprovar, editar ou rejeitar para cada sugestão.");
    }
  }

  const acceptedIn = (groupId) => groups
    .find((group) => group.id === groupId)?.claims
    .some((claim) => state.decisions[claim.id].decision !== "reject");
  if (acceptedIn("descriptive") && !state.confirmations.descriptive) {
    throw new Error("Confirme os dados descritivos revisados.");
  }
  if (acceptedIn("operational") && !state.confirmations.operational) {
    throw new Error("Confirme o grupo operacional antes de criar regras.");
  }
  if (acceptedIn("safety") && !state.confirmations.safety) {
    throw new Error("Confirme o grupo de segurança antes de criar regras.");
  }
  const safetyClaims = groups.find((group) => group.id === "safety")?.claims ?? [];
  if (safetyClaims.some((claim) => state.decisions[claim.id].decision !== "reject" && !state.evidenceAcks[claim.id])) {
    throw new Error("Confirme a evidência exata de cada item de segurança.");
  }
  if (typeof nonce !== "string" || !nonce) {
    throw new Error("A confirmação expirou. Gere uma nova confirmação.");
  }

  const groupByClaim = new Map(groups.flatMap((group) => group.claims.map((claim) => [claim.id, group.id])));
  const p_decisions = [...claims]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((claim) => {
      const selected = state.decisions[claim.id];
      const accepted = selected.decision !== "reject";
      const safetyAccepted = groupByClaim.get(claim.id) === "safety" && accepted;
      return {
        claim_id: claim.id,
        decision: selected.decision,
        value: clone(selected.decision === "edit" ? selected.value : claim.value),
        group_confirmed: ["operational", "safety"].includes(groupByClaim.get(claim.id)) ? accepted : false,
        evidence_acknowledged: safetyAccepted,
        acknowledged_evidence_refs: safetyAccepted ? claim.evidenceRefs.slice() : [],
      };
    });

  return {
    p_job: review.job.id,
    p_result: review.result.id,
    p_expected_version: review.job.version,
    p_decisions,
    p_confirmation_nonce: nonce,
  };
}

export function formatDiscoveryValue(claim) {
  const value = claim?.value;
  if (typeof value === "string") return value;
  if (claim?.type === "service" && value) {
    const names = asArray(value.service_names).join(", ");
    const price = value.public_price
      ? `${value.public_price.currency} ${value.public_price.amount}${value.public_price.qualifier === "starting_at" ? " a partir de" : ""}`
      : "preço não publicado";
    const duration = value.duration_minutes ? `${value.duration_minutes} min` : "duração não publicada";
    return `${names || value.service_type} · ${price} · ${duration}`;
  }
  if (claim?.type === "emergency" && value?.guidance) return value.guidance;
  return JSON.stringify(value, null, 2);
}
