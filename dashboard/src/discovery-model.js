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

function discoveryAvailability(ownerStatus, now) {
  if (!ownerStatus || typeof ownerStatus !== "object" || Array.isArray(ownerStatus)) {
    return { available: false, reason: "status_unavailable" };
  }
  if (ownerStatus.enabled !== true) return { available: false, reason: "disabled" };
  if (ownerStatus.allowlisted !== true) return { available: false, reason: "not_allowlisted" };
  if (ownerStatus.expires_at && Date.parse(ownerStatus.expires_at) <= Date.parse(now)) {
    return { available: false, reason: "allowlist_expired" };
  }
  if (ownerStatus.available !== true) return { available: false, reason: "unavailable" };
  return { available: true, reason: null };
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

function serviceNames(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function editorFromValue(claim, value = claim.value) {
  if (claim.type === "service") {
    return validateEditor({
      kind: "service",
      draft: {
        serviceType: value?.service_type ?? claim.value?.service_type ?? "",
        serviceNames: asArray(value?.service_names).join(", "),
        pricePublished: value?.public_price != null,
        amount: value?.public_price?.amount ?? "",
        currency: value?.public_price?.currency ?? "USD",
        qualifier: value?.public_price?.qualifier ?? "exact",
        durationMinutes: value?.duration_minutes == null ? "" : String(value.duration_minutes),
      },
    });
  }
  if (claim.type === "emergency") {
    return validateEditor({
      kind: "emergency",
      draft: { guidance: value?.guidance ?? "" },
    });
  }
  return validateEditor({
    kind: "descriptive",
    draft: { text: typeof value === "string" ? value : "" },
  });
}

function validateEditor(editor) {
  const draft = clone(editor.draft);
  if (editor.kind === "service") {
    const names = serviceNames(draft.serviceNames);
    if (!names.length || names.length > 20 || names.some((name) => name.length > 200)) {
      return { ...editor, draft, valid: false, error: "Informe de 1 a 20 nomes públicos do serviço.", value: null };
    }
    let publicPrice = null;
    if (draft.pricePublished) {
      if (!/^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/.test(draft.amount)) {
        return { ...editor, draft, valid: false, error: "Use o valor público no formato 0.00, sem símbolo.", value: null };
      }
      const currency = String(draft.currency ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return { ...editor, draft, valid: false, error: "Informe a moeda pública com 3 letras, como USD.", value: null };
      }
      if (!["exact", "starting_at"].includes(draft.qualifier)) {
        return { ...editor, draft, valid: false, error: "Escolha se o preço é exato ou inicial.", value: null };
      }
      publicPrice = { amount: draft.amount, currency, qualifier: draft.qualifier };
    }
    let duration = null;
    if (String(draft.durationMinutes).trim()) {
      const parsed = Number(draft.durationMinutes);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10080) {
        return { ...editor, draft, valid: false, error: "A duração pública deve ficar entre 1 e 10.080 minutos.", value: null };
      }
      duration = parsed;
    }
    return {
      ...editor,
      draft,
      valid: true,
      error: null,
      value: {
        service_type: draft.serviceType,
        service_names: names,
        public_price: publicPrice,
        duration_minutes: duration,
      },
    };
  }
  if (editor.kind === "emergency") {
    const guidance = String(draft.guidance ?? "").trim();
    if (!guidance || guidance.length > 2000) {
      return { ...editor, draft, valid: false, error: "Informe uma orientação de emergência de até 2.000 caracteres.", value: null };
    }
    return { ...editor, draft, valid: true, error: null, value: { guidance } };
  }
  const text = String(draft.text ?? "").trim();
  if (!text || text.length > 2000) {
    return { ...editor, draft, valid: false, error: "Informe um texto público de até 2.000 caracteres.", value: null };
  }
  return { ...editor, draft, valid: true, error: null, value: text };
}

export function mapDiscoveryRead({
  ownerStatus = null,
  job = null,
  result = null,
  claims = [],
  sources = [],
  decisions = [],
  errorCode = null,
  now = new Date().toISOString(),
} = {}) {
  if (FALLBACK_ERROR_CODES.has(errorCode)) {
    return { phase: "fallback", reason: errorCode, interviewAvailable: true };
  }
  const availability = discoveryAvailability(ownerStatus, now);
  if (!availability.available) {
    return {
      phase: "unavailable",
      reason: availability.reason,
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
    lateSuggestion: job.fallback_state === "existing_onboarding",
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
    decisions: Object.fromEntries(claims.map((claim) => {
      const editor = editorFromValue(claim);
      return [claim.id, {
        decision: null,
        value: clone(editor.value),
        editor,
      }];
    })),
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
    const editor = editorFromValue({
      type: state.decisions[action.claimId].editor.kind === "emergency"
        ? "emergency"
        : state.decisions[action.claimId].editor.kind === "service" ? "service" : "descriptive",
      value: state.decisions[action.claimId].value,
    }, action.value);
    return {
      ...state,
      decisions: {
        ...state.decisions,
        [action.claimId]: { decision: "edit", value: clone(editor.value), editor },
      },
    };
  }
  if (action.type === "editField") {
    const current = state.decisions[action.claimId];
    if (!current?.editor || !Object.hasOwn(current.editor.draft, action.field)) return state;
    const editor = validateEditor({
      ...current.editor,
      draft: { ...current.editor.draft, [action.field]: action.value },
    });
    return {
      ...state,
      decisions: {
        ...state.decisions,
        [action.claimId]: {
          ...current,
          decision: "edit",
          value: clone(editor.value),
          editor,
        },
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
  if (claims.some((claim) => {
    const selected = state.decisions?.[claim.id];
    return selected?.decision === "edit" && !selected.editor?.valid;
  })) {
    throw new Error("Corrija os campos visíveis antes de confirmar a revisão.");
  }
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
