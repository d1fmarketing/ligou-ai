import { describe, expect, test } from "bun:test";
import {
  applyCoverageFact,
  buildSummaryAnchors,
  canonicalCoverage,
  createCoverage,
  evaluateCoverage,
} from "../src/onboarding-coverage.ts";

const identity = { tenantId: "tenant-1", callId: "call-1" };

function answer(field: any, value: unknown, subject?: string) {
  return { field, subject, disposition: "answered" as const, value, ownerWords: "resposta do dono" };
}

function coveredUniversal(snapshot = createCoverage(identity)) {
  const values: Record<string, unknown> = {
    "business.customer_types": ["residencial"],
    "business.excluded_work": "nenhum",
    "business.languages_tone": "português cordial",
    "area.coverage": ["Irvine"],
    "area.out_of_area_policy": "owner_review",
    "area.travel_fee": "not_applicable",
    "schedule.business_hours": "seg-sex 08:00-18:00",
    "schedule.same_day_lead_time": "2 horas",
    "schedule.capacity_buffer": "30 minutos",
    "schedule.reschedule_cancel": "24 horas",
    "schedule.holidays": "owner_review",
    "emergency.types": ["vazamento"],
    "emergency.safety_escalation": "911 para risco imediato",
    "emergency.after_hours": "owner_review",
    "emergency.fee_authority": "owner_review",
    "policy.payment_estimate": "cartão; orçamento sujeito a aprovação",
    "policy.warranty_materials": "owner_review",
    "policy.access_cancellation": "taxa para acesso impossível",
    "policy.complaints_returns": "owner_review",
    "authority.quote_price": "owner_review",
    "authority.negotiate_floor": "owner_review",
    "authority.read_calendar": "owner_review",
    "authority.book": "owner_review",
    "authority.reschedule_cancel": "owner_review",
    "authority.charge_fee": "owner_review",
    "authority.emergency": "owner_review",
    "authority.out_of_area": "owner_review",
  };
  return Object.entries(values).reduce((next, [field, value]) => applyCoverageFact(next, answer(field, value)), snapshot);
}

function completeService(snapshot: ReturnType<typeof createCoverage>, subject = "limpeza de ralo") {
  const facts = [
    answer("service.name_synonyms", [subject], subject),
    answer("service.price_mode", "fixed", subject),
    answer("service.price_target", 120, subject),
    answer("service.negotiation", "non_negotiable", subject),
    answer("service.duration", 60, subject),
    answer("service.inclusions_exclusions", "inclui mão de obra", subject),
    answer("service.materials_parts", "not_applicable", subject),
    answer("service.warranty", "30 dias", subject),
    answer("service.emergency_eligibility", false, subject),
    answer("service.escalation", "owner_review", subject),
  ];
  return facts.reduce(applyCoverageFact, snapshot);
}

describe("onboarding coverage", () => {
  test("starts incomplete and five generic records cannot complete five topics", () => {
    const fresh = createCoverage(identity);
    expect(evaluateCoverage(fresh).readyForReview).toBe(false);
    expect(evaluateCoverage(fresh).missingRequired).toContainEqual({ field: "business.customer_types" });

    let generic = fresh;
    for (let index = 0; index < 5; index += 1) {
      generic = applyCoverageFact(generic, {
        field: "policy.access_cancellation",
        disposition: "answered",
        value: { note: `generic-${index}` },
        ownerWords: `genérico ${index}`,
      });
    }
    expect(evaluateCoverage(generic).readyForReview).toBe(false);
  });

  test("requires catalog closure and every required detail of each discovered service", () => {
    let snapshot = completeService(coveredUniversal());
    snapshot = applyCoverageFact(snapshot, answer("service.catalog_closure", true));
    expect(evaluateCoverage(snapshot).readyForReview).toBe(true);

    const withoutClosure = applyCoverageFact(snapshot, answer("service.catalog_closure", false));
    expect(evaluateCoverage(withoutClosure).readyForReview).toBe(false);
    expect(evaluateCoverage(withoutClosure).missingRequired).toContainEqual({ field: "service.catalog_closure" });

    const twoServices = applyCoverageFact(snapshot, answer("service.name_synonyms", ["instalação"], "instalação"));
    expect(evaluateCoverage(twoServices).missingRequired).toContainEqual({ field: "service.duration", subject: "instalacao" });
  });

  test("accepts zero target but keeps invalid prices and inverted floors ambiguous", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(snapshot, answer("service.name_synonyms", ["consulta"], "consulta"));
    const zero = applyCoverageFact(snapshot, answer("service.price_target", 0, "consulta"));
    expect(evaluateCoverage(zero).answered).toContainEqual({ field: "service.price_target", subject: "consulta" });

    for (const value of [-1, "120", Number.NaN]) {
      const invalid = applyCoverageFact(snapshot, answer("service.price_target", value, "consulta"));
      expect(evaluateCoverage(invalid).ambiguous).toContainEqual({ field: "service.price_target", subject: "consulta" });
    }

    const inverted = applyCoverageFact(
      applyCoverageFact(snapshot, answer("service.price_target", 100, "consulta")),
      answer("service.negotiation", { floor: 101 }, "consulta"),
    );
    expect(evaluateCoverage(inverted).ambiguous).toContainEqual({ field: "service.negotiation", subject: "consulta" });
  });

  test("accepts conservative service exceptions but does not let a required field be skipped", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(snapshot, answer("service.name_synonyms", ["consulta"], "consulta"));
    snapshot = applyCoverageFact(snapshot, answer("service.price_target", 100, "consulta"));
    snapshot = applyCoverageFact(snapshot, answer("service.negotiation", "non_negotiable", "consulta"));
    expect(evaluateCoverage(snapshot).answered).toContainEqual({ field: "service.negotiation", subject: "consulta" });

    const review = applyCoverageFact(snapshot, {
      field: "service.duration",
      subject: "consulta",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "não sei ainda",
    });
    expect(evaluateCoverage(review).ownerReviewRequired).toContainEqual({ field: "service.duration", subject: "consulta" });
    expect(evaluateCoverage(review).missingRequired).not.toContainEqual({ field: "service.duration", subject: "consulta" });

    const skipped = applyCoverageFact(snapshot, { ...answer("service.duration", 60, "consulta"), disposition: "skipped" as any });
    expect(evaluateCoverage(skipped).missingRequired).toContainEqual({ field: "service.duration", subject: "consulta" });
  });

  test("does not require a public target when a service price itself requires owner review", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(snapshot, answer("service.name_synonyms", ["consulta"], "consulta"));
    snapshot = applyCoverageFact(snapshot, answer("service.price_mode", "owner_review", "consulta"));
    expect(evaluateCoverage(snapshot).missingRequired).not.toContainEqual({ field: "service.price_target", subject: "consulta" });
  });

  test("selects the same next Portuguese question regardless of insertion order and records multi-field answers", () => {
    expect(evaluateCoverage(createCoverage(identity)).nextQuestion?.field).toBe("service.catalog_closure");

    const first = applyCoverageFact(createCoverage(identity), answer("area.coverage", ["Irvine"]));
    const second = applyCoverageFact(createCoverage(identity), answer("business.customer_types", ["residencial"]));
    const reversed = applyCoverageFact(second, answer("area.coverage", ["Irvine"]));
    const normal = applyCoverageFact(first, answer("business.customer_types", ["residencial"]));
    expect(evaluateCoverage(normal).nextQuestion).toEqual(evaluateCoverage(reversed).nextQuestion);

    const both = applyCoverageFact(createCoverage(identity), {
      field: "business.customer_types",
      disposition: "answered",
      value: { fields: { "business.customer_types": ["residencial"], "business.excluded_work": "nenhum" } },
      ownerWords: "atendemos residência e não excluímos serviços",
    });
    expect(evaluateCoverage(both).answered).toEqual(expect.arrayContaining([
      { field: "business.customer_types" },
      { field: "business.excluded_work" },
    ]));
    expect(both.revision).toBe(1);
  });

  test("moves past an unresolved group after two directed attempts without marking it answered", () => {
    let snapshot = applyCoverageFact(createCoverage(identity), answer("service.name_synonyms", ["consulta"], "consulta"));
    snapshot = applyCoverageFact(snapshot, answer("service.catalog_closure", true));
    snapshot = applyCoverageFact(snapshot, answer("service.price_target", -1, "consulta"));
    snapshot = applyCoverageFact(snapshot, answer("service.price_target", -1, "consulta"));
    const progress = evaluateCoverage(snapshot);
    expect(progress.ambiguous).toContainEqual({ field: "service.price_target", subject: "consulta" });
    expect(progress.nextQuestion?.field).not.toBe("service.price_target");
  });

  test("attempt limits keep unresolved fields incomplete and a new service reopens catalog closure", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(snapshot, answer("service.catalog_closure", true));
    for (let index = 0; index < 12; index += 1) {
      snapshot = applyCoverageFact(snapshot, answer("service.price_target", -1, "consulta"));
    }
    expect(evaluateCoverage(snapshot).readyForReview).toBe(false);
    expect(evaluateCoverage(snapshot).ambiguous).toContainEqual({ field: "service.price_target", subject: "consulta" });
    expect(evaluateCoverage(snapshot).nextQuestion).toBeNull();

    const reopened = applyCoverageFact(snapshot, answer("service.name_synonyms", ["consulta"], "consulta"));
    expect(evaluateCoverage(reopened).missingRequired).toContainEqual({ field: "service.catalog_closure" });
  });

  test("increments revision on a correction, invalidates readiness, caps service discovery, and canonicalizes stably", () => {
    const ready = applyCoverageFact(completeService(coveredUniversal()), answer("service.catalog_closure", true));
    expect(evaluateCoverage(ready).readyForReview).toBe(true);
    const corrected = applyCoverageFact(ready, answer("business.customer_types", ["comercial"]));
    expect(corrected.revision).toBe(ready.revision + 1);
    expect(evaluateCoverage(corrected).summaryInvalidated).toBe(true);

    let capped = createCoverage(identity);
    for (let index = 0; index < 21; index += 1) {
      capped = applyCoverageFact(capped, answer("service.name_synonyms", [`serviço ${index}`], `serviço ${index}`));
    }
    expect(capped.services).toHaveLength(20);
    expect(evaluateCoverage(capped).ownerReviewRequired).toContainEqual({ field: "service.catalog_closure" });

    const left = applyCoverageFact(createCoverage(identity), answer("area.coverage", ["Irvine"]));
    const right = applyCoverageFact(createCoverage(identity), answer("business.customer_types", ["residencial"]));
    const canonicalA = canonicalCoverage(applyCoverageFact(left, answer("business.customer_types", ["residencial"])));
    const canonicalB = canonicalCoverage(applyCoverageFact(right, answer("area.coverage", ["Irvine"])));
    expect(canonicalA).toBe(canonicalB);
    expect(buildSummaryAnchors(ready)).toEqual(expect.arrayContaining(["business.customer_types", "service:limpeza_de_ralo:service.duration"]));
  });
});
