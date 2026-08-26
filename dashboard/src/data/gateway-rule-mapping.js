const STATUS_FROM_DB = {
  aprovado: "ativa",
  sugerido: "sugerida",
  revogado: "revogada",
  rejeitado: "rejeitada",
};

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
          intent: materializationIntent(latest),
          coverageRevision: latest.structured?.coverage_revision ?? null,
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
      canonicalFields:
        displayed.structured?.fields &&
          typeof displayed.structured.fields === "object" &&
          !Array.isArray(displayed.structured.fields)
          ? displayed.structured.fields
          : null,
      ...(draft ? { draft } : {}),
      ...(effective && displayed.id !== effective.id
        ? {
            effectivePolicy: {
              id: effective.id,
              version: effective.version,
              text: effective.text,
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
