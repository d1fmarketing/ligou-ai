import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/foghorn-website-first-voice.json";
import { buildWebsiteAgendaSeeds } from "../src/onboarding-agenda-seed.ts";
import { coverageKey, evaluateCoverage, type CoverageSnapshot } from "../src/onboarding-coverage.ts";
import { createOnboardingAgenda } from "../src/onboarding-agenda.ts";
import { buildCompanyDiscoveryPrefill } from "../src/company-discovery-prefill.ts";

const { tenant_id: _tenant, ...draftReadback } = fixture.draft_row;
const initialCoverage = fixture.initial_coverage.snapshot as CoverageSnapshot;
const build = () => buildWebsiteAgendaSeeds({ draftReadback, initialCoverage });
const ORIGINAL_IDS = [
  "ff9fa80b-12d5-4afa-85e2-a17a937aceca", "96d2a50e-7b5f-4a4f-8733-835aaf93febc",
  "2a19450a-5492-480b-84cc-9f8a1687cf49", "a7f48240-2bbc-43a6-84db-d4c085969d63",
  "3be3bb5c-25e8-460a-83dc-32c5796f023d", "92b3f78b-12b9-4f1d-81f2-db03bc2c0732",
  "832bbe1e-1361-44da-860b-749a0b419b60", "765e3066-368e-4f92-8af0-7adb701d9016",
  "0fd6eb2a-eae5-4379-84b8-ee321514f11e", "745da4fc-f875-4020-8dc7-6fb3b9eb09a9",
  "aa40426d-1249-4f51-8ed5-1b2652a022ae", "fecf86be-63f3-4028-8814-5a530a86694c",
  "ffb7e814-f75f-4136-8be8-0f66e70bf487", "614786ab-64f0-452f-851f-73dddb548090",
  "da6e4084-5078-4cbf-8e39-8dfb0deba09e", "a0867d56-216c-46ef-8cbb-41624661d0f4",
];

describe("website finite agenda seed derivation", () => {
  test("retains all sixteen exact original unresolved UUIDs and questions once", () => {
    const result = build();
    expect(result.sourceItems.map(item => item.unresolvedId)).toEqual(ORIGINAL_IDS);
    for (const source of result.sourceItems) {
      const matches = result.seeds.filter(seed => seed.id === source.unresolvedId);
      expect(matches).toHaveLength(1);
      expect(matches[0].questionPt).toBe(source.questionPt);
      expect(matches[0].coverageRefs).toContain(source.coverageRef);
    }
    expect(result.sourceItems.map(item => item.questionPt).slice(0, 6)).toEqual(draftReadback.draft.missing_information);
  });

  test("opening is exact targeted cities, then original questions, not fresh service discovery", () => {
    const result = build();
    expect(result.seeds[0].coverageRefs).toEqual(["area.coverage"]);
    expect(result.seeds[0].questionPt).toBe("O site descreve a área de atendimento de forma ampla ou ambígua. Quais cidades exatas sua empresa atende?");
    expect(result.seeds.slice(1, 17).map(seed => seed.id)).toEqual(ORIGINAL_IDS);
    expect(result.seeds.some(seed => seed.questionPt === "Quais serviços sua empresa oferece?")).toBe(false);
  });

  test("all required unknown/private obligations remain blocking with no arbitrary question cap", () => {
    const result = build();
    const progress = evaluateCoverage(initialCoverage);
    expect(progress.requiredFields).toHaveLength(136);
    const needed = progress.requiredFields.map(ref => coverageKey(ref.field, ref.subject)).filter(key => !["answered", "not_applicable"].includes(initialCoverage.cells[key]?.state ?? "missing"));
    expect(needed).toHaveLength(115);
    expect(result.coverageObligations).toHaveLength(136);
    expect([...new Set(result.seeds.flatMap(seed => [...seed.coverageRefs]))].sort()).toEqual(needed.sort());
    expect(result.seeds.every(seed => seed.blocking)).toBe(true);
    expect(result.seeds).toHaveLength(114);
    expect(result.coverageObligations.filter(item => item.disposition === "ask").every(item => item.seedId && item.blocking)).toBe(true);
  });

  test("only identical holiday obligation merges while distinct policy details stay represented", () => {
    const result = build();
    const holiday = result.seeds.find(seed => seed.id === ORIGINAL_IDS[1])!;
    expect(holiday.coverageRefs).toEqual(["discovery.owner_question.96d2a50e7b5f4a4f8733835aaf93febc", "schedule.holidays"]);
    expect(result.seeds.filter(seed => seed.coverageRefs.includes("schedule.holidays"))).toHaveLength(1);
    for (const field of ["policy.payment_estimate", "policy.warranty_materials", "policy.access_cancellation", "policy.complaints_returns", "business.languages_tone"]) {
      expect(result.seeds.filter(seed => seed.coverageRefs.includes(field))).toHaveLength(1);
    }
  });

  test("known service names and public prices go to candidate recap, catalog asks confirmation", () => {
    const result = build();
    expect(result.candidateRecap).toHaveLength(21);
    expect(result.candidateRecap).toEqual(draftReadback.draft.candidate_facts);
    const catalog = result.seeds.find(seed => seed.coverageRefs.includes("service.catalog_closure"))!;
    for (const subject of initialCoverage.services) {
      const names = initialCoverage.cells[coverageKey("service.name_synonyms", subject)];
      expect(catalog.questionPt).toContain((names as { value: string[] }).value[0]);
      expect(result.seeds.some(seed => seed.coverageRefs.includes(coverageKey("service.name_synonyms", subject)))).toBe(false);
    }
    expect(catalog.questionPt).toContain("Confirma");
    for (const subject of ["new_system_assessment", "filter_cabinet_upgrade", "repair", "single_zone_ductless_heat_pump_installation"]) {
      expect(result.seeds.some(seed => seed.coverageRefs.includes(coverageKey("service.price_target", subject)))).toBe(false);
    }
    expect(result.provenance.authority).toEqual({ rules_approved: false, powers_granted: false, operational_mode_changed: false });
  });

  test("conditional published price confirmations preserve exact amount and condition", () => {
    const result = build();
    for (const [subject, amount, condition] of [
      ["repair_diagnostic", "USD 89.00", "Credited to the repair."],
      ["comfort_plan_maintenance", "USD 24.00", "Per month per system."],
    ]) {
      for (const field of ["service.price_mode", "service.price_target"] as const) {
        const item = result.seeds.find(seed => seed.coverageRefs.includes(coverageKey(field, subject)))!;
        expect(item.questionPt).toContain(amount);
        expect(item.questionPt).toContain(condition);
      }
    }
    const negotiated = result.seeds.find(seed => seed.coverageRefs.includes(coverageKey("service.negotiation", "single_zone_ductless_heat_pump_installation")))!;
    expect(negotiated.questionPt).toContain("After rebates.");
    expect(negotiated.questionPt).toContain("11900.00");
  });

  test("all eight private owner questions and service negotiation remain explicit; related refs grant nothing", () => {
    const result = build();
    const privateSources = result.sourceItems.filter(item => item.coverageRef.startsWith("authority."));
    expect(privateSources).toHaveLength(8);
    for (const source of privateSources) expect(result.seeds.find(seed => seed.id === source.seedId)?.source).toBe("owner_private_requirement");
    for (const subject of ["new_system_assessment", "filter_cabinet_upgrade", "repair", "single_zone_ductless_heat_pump_installation"]) {
      expect(result.seeds.some(seed => seed.coverageRefs.includes(coverageKey("service.negotiation", subject)))).toBe(true);
    }
    const byId = new Map(result.seeds.map(seed => [seed.id, seed]));
    for (const seed of result.seeds) for (const id of seed.relatedItemIds) {
      expect(byId.has(id)).toBe(true);
      if (byId.get(id)!.coverageRefs.some(ref => ref.startsWith("authority.") || ref.endsWith("service.negotiation") || ref === "emergency.fee_authority")) {
        expect(seed.coverageRefs.some(ref => ref.startsWith("authority.") || ref.endsWith(":service.negotiation") || ref.endsWith(":service.escalation") || ref === "emergency.fee_authority") || (/taxa|fee/.test(seed.questionPt.toLowerCase()) && /emerg/.test(seed.questionPt.toLowerCase()))).toBe(true);
      }
    }
    const territory = byId.get(ORIGINAL_IDS[5])!;
    expect(territory.relatedItemIds).toContain(result.seeds[0].id);
    expect(result.relationHints.some(hint => hint.requirement === "explicit_owner_applicability")).toBe(true);
    expect(result.relationHints.some(hint => hint.requirement === "explicit_owner_authority")).toBe(true);
  });

  test("output is immutable, accepted by pure agenda, and deterministic across storage key/service order", () => {
    const first = build();
    const reordered = { ...structuredClone(initialCoverage), services: [...initialCoverage.services].reverse(), cells: Object.fromEntries(Object.entries(initialCoverage.cells).reverse()) };
    const second = buildWebsiteAgendaSeeds({ draftReadback: { draft: draftReadback.draft, draft_hash: draftReadback.draft_hash, draft_version: draftReadback.draft_version, draft_id: draftReadback.draft_id }, initialCoverage: reordered });
    expect(second.seeds).toEqual(first.seeds);
    expect(second.seedsHash).toBe(first.seedsHash);
    expect(Object.isFrozen(first.seeds[0].coverageRefs)).toBe(true);
    expect(Object.isFrozen(first.candidateRecap[0])).toBe(true);
    const agenda = createOnboardingAgenda({ interviewId: "interview-1", callId: initialCoverage.callId, draftId: first.provenance.draftId, draftHash: first.provenance.draftHash, sourceResultId: first.provenance.sourceResultId, sourceResultHash: first.provenance.sourceResultHash }, first.seeds);
    expect(agenda.items).toHaveLength(first.seeds.length);
  });

  test("seeds hash binds source hashes, full candidate content, and coverage snapshot", () => {
    const initial = build();
    const changedHash = structuredClone(draftReadback);
    changedHash.draft_hash = "e".repeat(64);
    expect(buildWebsiteAgendaSeeds({ draftReadback: changedHash, initialCoverage }).seedsHash).not.toBe(initial.seedsHash);
    const changedFact = structuredClone(draftReadback);
    (changedFact.draft.candidate_facts.find(fact => fact.claim_type === "business_name") as { value: string }).value = "Another company";
    expect(buildWebsiteAgendaSeeds({ draftReadback: changedFact, initialCoverage }).seedsHash).not.toBe(initial.seedsHash);
    const changedCoverage = structuredClone(initialCoverage);
    changedCoverage.cells["business.languages_tone"] = { state: "answered", attempts: 0, value: "Português" };
    expect(buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: changedCoverage }).seedsHash).not.toBe(initial.seedsHash);
  });

  test("new generic service obligations are retained instead of Foghorn-specific allowlisting", () => {
    const coverage = structuredClone(initialCoverage);
    coverage.services.push("solar_panel_cleaning");
    const result = buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: coverage });
    expect(result.coverageObligations.filter(item => item.subject === "solar_panel_cleaning")).toHaveLength(10);
    expect(result.seeds.filter(seed => seed.coverageRefs.some(ref => ref.startsWith("service:solar_panel_cleaning:")))).toHaveLength(10);
  });

  test("rejects source/coverage drift or malformed state rather than silently dropping obligations", () => {
    const coverage = structuredClone(initialCoverage);
    (coverage.cells["area.coverage"] as any).state = "complete";
    expect(() => buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: coverage })).toThrow();
    const lostSource = structuredClone(initialCoverage);
    delete lostSource.cells["discovery.owner_question.2a19450a5492480b84cc9f8a1687cf49"];
    expect(() => buildWebsiteAgendaSeeds({ draftReadback, initialCoverage: lostSource })).toThrow();
  });

  test("explicit owner-private source stays private even outside authority-prefixed fields", () => {
    const draft = structuredClone(draftReadback);
    draft.draft.owner_private_information_needed.push({ field: "area.out_of_area_policy", question_pt: "Qual regra privada devo seguir para pedidos fora da área?" });
    const prefill = buildCompanyDiscoveryPrefill({ tenant_id: initialCoverage.tenantId, call_id: initialCoverage.callId, draft_readback: draft, localities: [] });
    const result = buildWebsiteAgendaSeeds({ draftReadback: draft, initialCoverage: prefill.coverage.snapshot });
    const privateItem = result.seeds.find(seed => seed.coverageRefs.includes("area.out_of_area_policy"))!;
    expect(privateItem.source).toBe("owner_private_requirement");
    expect(result.seeds.some(seed => seed.relatedItemIds.includes(privateItem.id))).toBe(false);
  });

  test("conflicting published prices remain explicit in a reconciliation question, not a blank price interview", () => {
    const draft = structuredClone(draftReadback);
    const duplicate = structuredClone(draft.draft.candidate_facts.find(fact => fact.claim_id === "70df1b75-16c3-45fd-a00f-e83c678c22cc")!);
    duplicate.claim_id = "99999999-9999-4999-8999-999999999999";
    (duplicate.value as any).public_price = { amount: "49.00", currency: "USD", qualifier: "conditional", condition: "Only for members." };
    draft.draft.candidate_facts.push(duplicate);
    const result = buildWebsiteAgendaSeeds({ draftReadback: draft, initialCoverage });
    const price = result.seeds.find(seed => seed.coverageRefs.includes(coverageKey("service.price_target", "repair_diagnostic")))!;
    expect(price.questionPt).toContain("89.00");
    expect(price.questionPt).toContain("49.00");
    expect(price.questionPt).toContain("Credited to the repair.");
    expect(price.questionPt).toContain("Only for members.");
  });

  test("holiday booking policy is not merged with holiday operating hours", () => {
    const draft = structuredClone(draftReadback);
    draft.draft.missing_information.push("What is the booking policy on holidays?");
    const prefill = buildCompanyDiscoveryPrefill({ tenant_id: initialCoverage.tenantId, call_id: initialCoverage.callId, draft_readback: draft, localities: [] });
    const result = buildWebsiteAgendaSeeds({ draftReadback: draft, initialCoverage: prefill.coverage.snapshot });
    expect(result.seeds.find(seed => seed.id === ORIGINAL_IDS[1])!.coverageRefs).toContain("schedule.holidays");
    expect(result.seeds.find(seed => seed.questionPt === "What is the booking policy on holidays?")!.coverageRefs).toHaveLength(1);
  });
});
