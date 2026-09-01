const STATUS_FROM_DB = {
  aprovado: "ativa",
  sugerido: "sugerida",
  revogado: "revogada",
  rejeitado: "rejeitada",
};

function inTestGeneration(row, generation) {
  return Number.isSafeInteger(generation) && generation >= 0 &&
    Number(row?.test_memory_generation) === generation;
}

export function scopePowersQuery(query, { tenantId, generation } = {}) {
  if (typeof tenantId !== "string" || tenantId.length === 0)
    throw new Error("active_tenant_required");
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error("test_generation_required");
  return query
    .eq("tenant_id", tenantId)
    .eq("test_memory_generation", generation);
}

export function scopeUsageAlertQuery(query, { tenantId } = {}) {
  if (typeof tenantId !== "string" || tenantId.length === 0)
    throw new Error("active_tenant_required");
  return query
    .eq("tenant_id", tenantId)
    .in("kind", ["usage_70", "usage_90"])
    .order("created_at", { ascending: false })
    .limit(20);
}

export function projectRowsAfterTestReset({
  generation = 0,
  rules = [],
  calls = [],
  cases = [],
  notifications = [],
  powers = [],
} = {}) {
  return {
    rules: rules.filter((row) => inTestGeneration(row, generation)),
    calls: calls.filter((row) => inTestGeneration(row, generation)),
    cases: cases.filter((row) => inTestGeneration(row, generation)),
    notifications: notifications.filter((row) =>
      row?.kind === "usage_70" || row?.kind === "usage_90" ||
      inTestGeneration(row, generation)
    ),
    powers: powers.filter((row) => inTestGeneration(row, generation)),
  };
}

export function isFreshTestResetReadback({
  rpcResetAt,
  rpcGeneration,
  state,
} = {}) {
  const rpcTime = Date.parse(rpcResetAt);
  const stateTime = Date.parse(state?.testResetAt);
  const counts = state?.testState;
  return Number.isFinite(rpcTime) && rpcTime === stateTime &&
    Number.isSafeInteger(rpcGeneration) &&
    rpcGeneration === state?.testGeneration &&
    counts?.calls === 0 && counts?.approvals === 0 &&
    counts?.memory === 0 && counts?.powers === 0;
}

function materializationIntent(rule) {
  if (!/^ligou[.]rule[.][a-z_]+[.]v2$/.test(String(rule?.structured?.schema ?? "")))
    return null;
  return {
    active: "ativa",
    owner_review_required: "revisão do dono",
    incomplete: "incompleta",
    disabled: "remoção",
  }[rule.structured.operational_state] ?? "revisão do dono";
}

function canonicalFields(rule) {
  return rule?.structured?.fields &&
      typeof rule.structured.fields === "object" &&
      !Array.isArray(rule.structured.fields)
    ? rule.structured.fields
    : null;
}

function ruleTitle(rule) {
  if (rule?.structured?.schema === "ligou.rule.service.v2") {
    const service = String(rule.structured.service_type ?? "serviço")
      .replaceAll("_", " ");
    return `Serviço · ${service}`;
  }
  const domainTitle = {
    "domain:area": "Área",
    "domain:schedule": "Agenda",
    "domain:emergency": "Emergências",
    "domain:business": "Negócio",
    "domain:policy": "Políticas",
    "domain:authority": "Autoridade",
  }[rule?.structured?.materialization_key];
  if (domainTitle) return domainTitle;
  return rule.category === "preco"
    ? `Preço · ${rule.structured?.service_type ?? ""}`
    : rule.category;
}

export function mapRuleGroups(rules) {
  const groups = new Map();
  for (const rule of rules) {
    const group = groups.get(rule.rule_group_id) ?? [];
    group.push(rule);
    groups.set(rule.rule_group_id, group);
  }
  const entries = [];
  for (const versions of groups.values()) {
    versions.sort((left, right) => left.version - right.version);
    const latest = versions.at(-1);
    const latestDecision = versions
      .filter((version) => ["aprovado", "revogado"].includes(version.status))
      .at(-1) ?? null;
    const effective = latestDecision?.status === "aprovado"
      ? latestDecision
      : null;
    const hasLaterDraft = ["sugerido", "rejeitado"].includes(latest.status) &&
      (!effective || latest.version > effective.version);
    const displayed = latest.status === "rejeitado" ? effective : latest;
    if (!displayed) continue;
    const status = displayed.structured?.effective_until
      ? "temporária"
      : (STATUS_FROM_DB[displayed.status] ?? displayed.status);
    const draft = hasLaterDraft
      ? {
          id: latest.id,
          status: STATUS_FROM_DB[latest.status] ?? latest.status,
          version: latest.version,
          text: latest.text,
          intent: materializationIntent(latest),
          coverageRevision: latest.structured?.coverage_revision ?? null,
          canonicalFields: canonicalFields(latest),
          ...(latest.evidence_quote
            ? { evidenceQuote: latest.evidence_quote }
            : {}),
        }
      : null;
    entries.push({
      id: displayed.id,
      title: ruleTitle(displayed),
      text: displayed.text,
      category: displayed.category,
      structured: displayed.structured ?? null,
      status,
      origin: {
        onboarding: "Entrevista de onboarding",
        escalacao: "Aprovação de caso",
        edicao_manual: "Edição manual",
        aprendizado: "Aprendizado em chamada",
      }[displayed.origem] ?? displayed.origem,
      scope: displayed.escopo,
      version: displayed.version,
      evidenceQuote: displayed.evidence_quote ?? null,
      effectiveFrom: displayed.approved_at?.slice(0, 10) ?? null,
      approvedBy: displayed.approved_by ? "Você" : null,
      updatedAt: latest.created_at,
      materializationIntent: materializationIntent(displayed),
      coverageRevision: displayed.structured?.coverage_revision ?? null,
      canonicalFields: canonicalFields(displayed),
      ...(draft ? { draft } : {}),
      ...(effective && hasLaterDraft
        ? {
            effectivePolicy: {
              id: effective.id,
              version: effective.version,
              text: effective.text,
              intent: materializationIntent(effective),
              coverageRevision:
                effective.structured?.coverage_revision ?? null,
              canonicalFields: canonicalFields(effective),
              ...(effective.evidence_quote
                ? { evidenceQuote: effective.evidence_quote }
                : {}),
            },
          }
        : {}),
      history: versions.slice(0, -1).map((version, index) => ({
        version: version.version,
        changedAt: versions[index + 1].created_at,
        before: version.text,
        after: versions[index + 1].text,
      })),
    });
  }
  entries.sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  );
  return entries;
}
