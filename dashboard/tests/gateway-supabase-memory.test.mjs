import assert from "node:assert/strict";
import test from "node:test";

import { mapRuleGroups } from "../src/data/gateway-rule-mapping.js";

const serviceStructured = (serviceType, overrides = {}) => ({
  schema: "ligou.rule.service.v2",
  materialization_key: `service:${serviceType}`,
  materialization_hash: "a".repeat(64),
  materialization_eligible: true,
  review_ready: true,
  operational_state: "active",
  service_type: serviceType,
  service_names: [serviceType.replaceAll("_", " ")],
  price_mode: "fixed",
  quoteable: true,
  negotiable: false,
  price_target: 149,
  price_min: 149,
  duration_min: 60,
  owner_review_fields: [],
  coverage_revision: 41,
  source_call_id: "22222222-2222-4222-8222-222222222222",
  ...overrides,
});

test("a rejected V2 correction preserves the prior effective policy and exposes the rejected draft separately", () => {
  const entries = mapRuleGroups([
    {
      id: "approved-v1",
      tenant_id: "tenant-1",
      rule_group_id: "service-drain-group",
      version: 1,
      status: "aprovado",
      origem: "onboarding",
      category: "preco",
      escopo: "servico",
      text: "Drain cleaning fixo por 149.",
      structured: serviceStructured("drain_cleaning"),
      approved_by: "owner-1",
      approved_at: "2026-08-25T20:00:00Z",
      created_at: "2026-08-25T19:00:00Z",
    },
    {
      id: "rejected-v2",
      tenant_id: "tenant-1",
      rule_group_id: "service-drain-group",
      version: 2,
      status: "rejeitado",
      origem: "onboarding",
      category: "preco",
      escopo: "servico",
      text: "Correção rejeitada.",
      structured: serviceStructured("drain_cleaning", {
        operational_state: "owner_review_required",
        price_mode: "owner_review",
        quoteable: false,
        owner_review_fields: ["service.price_mode"],
        price_target: undefined,
        price_min: undefined,
        coverage_revision: 42,
      }),
      created_at: "2026-08-25T21:00:00Z",
    },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "approved-v1");
  assert.equal(entries[0].status, "ativa");
  assert.equal(entries[0].title, "Serviço · drain cleaning");
  assert.equal(entries[0].structured.price_target, 149);
  assert.deepEqual(entries[0].draft, {
    id: "rejected-v2",
    status: "rejeitada",
    version: 2,
    text: "Correção rejeitada.",
    intent: "revisão do dono",
    coverageRevision: 42,
    canonicalFields: null,
  });
  assert.deepEqual(entries[0].effectivePolicy, {
    id: "approved-v1",
    version: 1,
    text: "Drain cleaning fixo por 149.",
    intent: "ativa",
    coverageRevision: 41,
    canonicalFields: null,
  });
});

test("V2 owner-review and removal suggestions render canonical intent instead of raw model text", () => {
  const entries = mapRuleGroups([
    {
      id: "owner-review-v1",
      rule_group_id: "service-owner-group",
      version: 1,
      status: "sugerido",
      origem: "onboarding",
      category: "preco",
      escopo: "servico",
      text: "Canonical owner-review projection.",
      structured: serviceStructured("sewer_repair", {
        operational_state: "owner_review_required",
        price_mode: "owner_review",
        quoteable: false,
        owner_review_fields: ["service.price_mode"],
        price_target: undefined,
        price_min: undefined,
      }),
      created_at: "2026-08-25T22:00:00Z",
    },
    {
      id: "disabled-v1",
      rule_group_id: "service-disabled-group",
      version: 1,
      status: "sugerido",
      origem: "onboarding",
      category: "preco",
      escopo: "servico",
      text: "Canonical disabled projection.",
      structured: serviceStructured("old_service", {
        operational_state: "disabled",
        quoteable: false,
        owner_review_fields: [],
        price_target: undefined,
        price_min: undefined,
      }),
      created_at: "2026-08-25T23:00:00Z",
    },
  ]);

  assert.deepEqual(entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    intent: entry.materializationIntent,
    revision: entry.coverageRevision,
  })), [
    {
      id: "disabled-v1",
      title: "Serviço · old service",
      intent: "remoção",
      revision: 41,
    },
    {
      id: "owner-review-v1",
      title: "Serviço · sewer repair",
      intent: "revisão do dono",
      revision: 41,
    },
  ]);
  assert.equal(JSON.stringify(entries).includes("raw model"), false);
});

test("every V2 domain renders its canonical title, intent, fields, and coverage revision", () => {
  const domains = [
    ["domain:area", "ligou.rule.area.v2", "area", "Área"],
    ["domain:schedule", "ligou.rule.schedule.v2", "agenda", "Agenda"],
    ["domain:emergency", "ligou.rule.emergency.v2", "emergencia", "Emergências"],
    ["domain:business", "ligou.rule.business.v2", "negocio", "Negócio"],
    ["domain:policy", "ligou.rule.policy.v2", "politica", "Políticas"],
    ["domain:authority", "ligou.rule.authority.v2", "autoridade", "Autoridade"],
  ];
  const entries = mapRuleGroups(domains.map(([key, schema, category], index) => ({
    id: `domain-${index}`,
    rule_group_id: `domain-group-${index}`,
    version: 1,
    status: "sugerido",
    origem: "onboarding",
    category,
    escopo: key === "domain:area" ? "localizacao" : "geral",
    text: `Canonical ${key}`,
    structured: {
      schema,
      materialization_key: key,
      materialization_hash: String(index + 1).repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: index === 5 ? "owner_review_required" : "active",
      coverage_revision: 50 + index,
      fields: { proof: `value-${index}` },
    },
    created_at: `2026-08-26T00:00:0${index}.000Z`,
  })));

  for (const [key, _schema, _category, title] of domains) {
    const entry = entries.find(
      (candidate) => candidate.structured.materialization_key === key,
    );
    assert.equal(entry.title, title);
    assert.deepEqual(entry.canonicalFields, {
      proof: `value-${domains.findIndex((domain) => domain[0] === key)}`,
    });
    assert.equal(typeof entry.coverageRevision, "number");
    assert.ok(["ativa", "revisão do dono"].includes(entry.materializationIntent));
  }
});
