import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

import { mapRuleGroups } from "../src/data/gateway-rule-mapping.js";

const areaStructured = (overrides = {}) => ({
  schema: "ligou.rule.area.v2",
  materialization_key: "domain:area",
  materialization_hash: "a".repeat(64),
  materialization_eligible: true,
  review_ready: true,
  operational_state: "active",
  coverage_revision: 41,
  fields: {
    coverage: "Irvine",
    out_of_area_policy: "Encaminhar ao dono",
    travel_fee: "Não se aplica",
  },
  ...overrides,
});

test("MemoryView shows the effective policy and rejected correction with both canonical projections", async () => {
  const entries = mapRuleGroups([
    {
      id: "approved-area-v1",
      rule_group_id: "area-group",
      version: 1,
      status: "aprovado",
      origem: "onboarding",
      category: "area",
      escopo: "localizacao",
      text: "POLÍTICA EFETIVA: atender somente Irvine.",
      structured: areaStructured(),
      approved_by: "owner-1",
      approved_at: "2026-08-25T20:00:00Z",
      created_at: "2026-08-25T19:00:00Z",
    },
    {
      id: "rejected-area-v2",
      rule_group_id: "area-group",
      version: 2,
      status: "rejeitado",
      origem: "onboarding",
      category: "area",
      escopo: "localizacao",
      text: "CORREÇÃO REJEITADA: trocar Irvine por Orange County.",
      structured: areaStructured({
        materialization_hash: "b".repeat(64),
        operational_state: "owner_review_required",
        coverage_revision: 42,
        fields: {
          coverage: "Orange County",
          out_of_area_policy: "Revisão do dono",
          travel_fee: "$25",
        },
      }),
      created_at: "2026-08-25T21:00:00Z",
    },
  ]);
  assert.equal(entries.length, 1);

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    plugins: [react()],
  });
  try {
    const { MemoryView } = await vite.ssrLoadModule("/src/views/MemoryView.jsx");
    const html = renderToStaticMarkup(React.createElement(MemoryView, {
      entries,
      query: "",
      filter: "all",
    }));

    for (const visible of [
      "Política efetiva",
      "POLÍTICA EFETIVA: atender somente Irvine.",
      "Intenção efetiva: ativa",
      "Revisão de cobertura efetiva: 41",
      "coverage: Irvine",
      "out_of_area_policy: Encaminhar ao dono",
      "Correção rejeitada",
      "CORREÇÃO REJEITADA: trocar Irvine por Orange County.",
      "Intenção da correção: revisão do dono",
      "Revisão de cobertura da correção: 42",
      "coverage: Orange County",
      "travel_fee: $25",
    ]) assert.match(html, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await vite.close();
  }
});
