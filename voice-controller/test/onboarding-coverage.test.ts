import { describe, expect, test } from "bun:test";
import {
  applyCoverageFact,
  buildSummaryAnchors,
  canonicalizeLocalityInput,
  canonicalCoverage,
  coverageKey,
  createCoverage,
  evaluateCoverage,
  recordDirectedFollowUp,
  resolveLocalityValueFromRegistry,
} from "../src/onboarding-coverage.ts";
import type {
  CoverageFact,
  CoverageField,
} from "../src/onboarding-coverage.ts";

const identity = { tenantId: "tenant-1", callId: "call-1" };

const OWNER_LOCALITY_REGISTRY = [
  {
    locality_id: "loc_06b5af1ac7ab0ac5ffaa565a",
    display_name: "Concord",
    country_code: "US",
    region_code: "CA",
    aliases: [],
  },
  {
    locality_id: "loc_d89792846ce09bcbb7667a0a",
    display_name: "Concord",
    country_code: "US",
    region_code: "NH",
    aliases: [],
  },
  {
    locality_id: "loc_9971eda617977d43d7df9fd5",
    display_name: "Irvine",
    country_code: "US",
    region_code: "CA",
    aliases: [],
  },
  {
    locality_id: "loc_103311f819190c5e34075124",
    display_name: "Walnut Creek",
    country_code: "US",
    region_code: "CA",
    aliases: [],
  },
  {
    locality_id: "loc_49cae77e3299fdc874706952",
    display_name: "Pleasant Hill",
    country_code: "US",
    region_code: "CA",
    aliases: [],
  },
  {
    locality_id: "loc_fcc2e7491cf2266b3cc824d5",
    display_name: "Martinez",
    country_code: "US",
    region_code: "CA",
    aliases: [],
  },
] as const;

const CONCORD_AMBIGUITY = {
  state: "ambiguous" as const,
  reason: "locality_region_owner_evidence_required",
  value: { localities: [] },
  candidates: [
    {
      locality_id: "loc_06b5af1ac7ab0ac5ffaa565a",
      display_name: "Concord",
      country_code: "US",
      region_code: "CA",
    },
    {
      locality_id: "loc_d89792846ce09bcbb7667a0a",
      display_name: "Concord",
      country_code: "US",
      region_code: "NH",
    },
  ],
  questionPt: "Você quer dizer Concord, CA, US ou Concord, NH, US?",
};

function answer(
  field: CoverageField,
  value: unknown,
  subject?: string,
): CoverageFact {
  return {
    field,
    subject,
    disposition: "answered" as const,
    value,
    ownerWords: "resposta do dono",
  };
}

function localityValue(
  ...localities: Array<[display_name: string, region_code: string]>
) {
  return {
    localities: localities.map(([display_name, region_code]) =>
      canonicalizeLocalityInput({
        display_name,
        country_code: "US",
        region_code,
      })!
    ),
  };
}

function coveredUniversal(snapshot = createCoverage(identity)) {
  const values: Record<string, unknown> = {
    "business.customer_types": ["residencial"],
    "business.excluded_work": "nenhum",
    "business.languages_tone": "português cordial",
    "area.coverage": localityValue(["Irvine", "CA"]),
    "area.out_of_area_policy": "owner_review",
    "area.travel_fee": "not_applicable",
    "schedule.business_hours": {
      days: ["mon", "tue", "wed", "thu", "fri"],
      hours: { opens: "08:00", closes: "18:00" },
    },
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
  return Object.entries(values).reduce(
    (next, [field, value]) => applyCoverageFact(next, answer(field, value)),
    snapshot,
  );
}

function completeService(
  snapshot: ReturnType<typeof createCoverage>,
  subject = "limpeza de ralo",
) {
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
  test("application owns initial service discovery before normal catalog closure", () => {
    const fresh = createCoverage(identity);
    expect(evaluateCoverage(fresh).nextQuestion).toEqual({
      field: "service.catalog_closure",
      questionPt: "Quais serviços sua empresa oferece?",
    });

    const discovered = applyCoverageFact(
      fresh,
      answer(
        "service.name_synonyms",
        ["limpeza de ralo", "desentupimento"],
        "Limpeza de ralo",
      ),
    );
    expect(evaluateCoverage(discovered).nextQuestion).toEqual({
      field: "service.catalog_closure",
      questionPt:
        "Há mais algum serviço que devemos cadastrar antes de encerrar o catálogo?",
    });
  });

  test("uses a trusted targeted question for a non-area ambiguous prefill cell", () => {
    const subject = "drain_cleaning";
    const snapshot = completeService(coveredUniversal(), subject);
    snapshot.cells[`service:${subject}:service.price_mode`] = {
      state: "ambiguous",
      attempts: 0,
      reason: "website_conditional_public_price",
      questionPt: "Seu site diz USD 250.00 por até duas horas. Deseja manter essa condição?",
    };

    expect(evaluateCoverage(snapshot).nextQuestion).toEqual({
      field: "service.price_mode",
      subject,
      questionPt: "Seu site diz USD 250.00 por até duas horas. Deseja manter essa condição?",
    });
  });

  test("documented one-fact service values answer pricing, duration, and negotiation without ambiguity", () => {
    let snapshot = createCoverage(identity);
    const subject = "limpeza_de_ralo";
    for (const fact of [
      answer(
        "service.name_synonyms",
        ["limpeza de ralo", "desentupimento"],
        subject,
      ),
      answer("service.price_mode", "fixed", subject),
      answer("service.price_target", 225, subject),
      answer("service.negotiation", { floor: 175 }, subject),
      answer("service.duration", 60, subject),
    ]) snapshot = applyCoverageFact(snapshot, fact);

    const progress = evaluateCoverage(snapshot);
    for (const field of [
      "service.name_synonyms",
      "service.price_mode",
      "service.price_target",
      "service.negotiation",
      "service.duration",
    ] as const) {
      expect(progress.answered).toContainEqual({ field, subject });
      expect(progress.ambiguous).not.toContainEqual({ field, subject });
    }

    const nonNegotiable = applyCoverageFact(
      snapshot,
      {
        ...answer("service.negotiation", null, subject),
        disposition: "not_applicable",
      },
    );
    expect(evaluateCoverage(nonNegotiable).answered).toContainEqual({
      field: "service.negotiation",
      subject,
    });

    const literalNonNegotiable = applyCoverageFact(
      snapshot,
      answer("service.negotiation", "non_negotiable", subject),
    );
    expect(evaluateCoverage(literalNonNegotiable).answered).toContainEqual({
      field: "service.negotiation",
      subject,
    });
    expect(evaluateCoverage(literalNonNegotiable).ambiguous).not.toContainEqual({
      field: "service.negotiation",
      subject,
    });
    expect(buildSummaryAnchors(literalNonNegotiable)).toContain(
      "Mínimo: não negociável (225)",
    );

    const bareFloor = applyCoverageFact(
      snapshot,
      answer("service.negotiation", 175, subject),
    );
    expect(bareFloor.cells[
      `service:${subject}:service.negotiation`
    ]).toMatchObject({
      state: "ambiguous",
      reason: "negotiation_floor_requires_public_price",
    });

    const extraNegotiationKey = applyCoverageFact(
      snapshot,
      answer(
        "service.negotiation",
        { floor: 175, extra: "model-authored" },
        subject,
      ),
    );
    expect(extraNegotiationKey.cells[
      `service:${subject}:service.negotiation`
    ]).toMatchObject({
      state: "ambiguous",
      reason: "negotiation_floor_requires_public_price",
    });

    const ownerReview = applyCoverageFact(snapshot, {
      ...answer("service.negotiation", null, subject),
      disposition: "owner_review_required",
    });
    expect(evaluateCoverage(ownerReview).ownerReviewRequired).toContainEqual({
      field: "service.negotiation",
      subject,
    });

    const prematureClosure = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", false),
    );
    expect(evaluateCoverage(prematureClosure).missingRequired).toContainEqual({
      field: "service.catalog_closure",
    });
    const explicitClosure = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    expect(evaluateCoverage(explicitClosure).answered).toContainEqual({
      field: "service.catalog_closure",
    });
  });

  test("a pure target correction rederives a non-negotiable floor without granting negotiation", () => {
    const subject = "drain_cleaning";
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["Drain cleaning"], subject),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 100, subject),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.negotiation", "non_negotiable", subject),
    );
    const negotiationKey = `service:${subject}:service.negotiation`;
    expect(snapshot.cells[negotiationKey]).toMatchObject({
      state: "answered",
      value: { mode: "non_negotiable", floor: 100 },
    });

    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 149, subject),
    );
    expect(snapshot.cells[negotiationKey]).toMatchObject({
      state: "answered",
      value: { mode: "non_negotiable", floor: 149 },
    });
    expect(buildSummaryAnchors(snapshot)).toContain(
      "Mínimo: não negociável (149)",
    );
  });

  test("a target correction retains a safe negotiable floor and invalidates an inverted floor", () => {
    const subject = "drain_cleaning";
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["Drain cleaning"], subject),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 100, subject),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.negotiation", { floor: 80 }, subject),
    );
    const negotiationKey = `service:${subject}:service.negotiation`;

    const retained = applyCoverageFact(
      snapshot,
      answer("service.price_target", 90, subject),
    );
    expect(retained.cells[negotiationKey]).toMatchObject({
      state: "answered",
      value: { mode: "negotiable", floor: 80 },
    });

    const inverted = applyCoverageFact(
      snapshot,
      answer("service.price_target", 50, subject),
    );
    expect(inverted.cells[negotiationKey]).toMatchObject({
      state: "ambiguous",
      reason: "negotiation_floor_requires_public_price",
    });
    expect(evaluateCoverage(inverted).ambiguous).toContainEqual({
      field: "service.negotiation",
      subject,
    });
    expect(buildSummaryAnchors(inverted).join("\n")).not.toContain(
      "Mínimo: 80",
    );
  });

  test("starts incomplete and five generic records cannot complete five topics", () => {
    const fresh = createCoverage(identity);
    expect(evaluateCoverage(fresh).readyForReview).toBe(false);
    expect(evaluateCoverage(fresh).missingRequired).toContainEqual({
      field: "business.customer_types",
    });

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
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    expect(evaluateCoverage(snapshot).readyForReview).toBe(true);

    const withoutClosure = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", false),
    );
    expect(evaluateCoverage(withoutClosure).readyForReview).toBe(false);
    expect(evaluateCoverage(withoutClosure).missingRequired).toContainEqual({
      field: "service.catalog_closure",
    });

    const twoServices = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["instalação"], "instalação"),
    );
    expect(evaluateCoverage(twoServices).missingRequired).toContainEqual({
      field: "service.duration",
      subject: "instalacao",
    });
  });

  test("accepts zero target but keeps invalid prices and inverted floors ambiguous", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    const zero = applyCoverageFact(
      snapshot,
      answer("service.price_target", 0, "consulta"),
    );
    expect(evaluateCoverage(zero).answered).toContainEqual({
      field: "service.price_target",
      subject: "consulta",
    });

    for (const value of [-1, "120", Number.NaN]) {
      const invalid = applyCoverageFact(
        snapshot,
        answer("service.price_target", value, "consulta"),
      );
      expect(evaluateCoverage(invalid).ambiguous).toContainEqual({
        field: "service.price_target",
        subject: "consulta",
      });
    }

    const inverted = applyCoverageFact(
      applyCoverageFact(
        snapshot,
        answer("service.price_target", 100, "consulta"),
      ),
      answer("service.negotiation", { floor: 101 }, "consulta"),
    );
    expect(evaluateCoverage(inverted).ambiguous).toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
  });

  test("accepts conservative service exceptions but does not let a required field be skipped", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 100, "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.negotiation", "non_negotiable", "consulta"),
    );
    expect(evaluateCoverage(snapshot).answered).toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });

    const review = applyCoverageFact(snapshot, {
      field: "service.duration",
      subject: "consulta",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "não sei ainda",
      ruleText: "Não confirmar autonomamente; encaminhar a duração ao dono.",
    });
    expect(evaluateCoverage(review).ownerReviewRequired).toContainEqual({
      field: "service.duration",
      subject: "consulta",
    });
    expect(evaluateCoverage(review).missingRequired).not.toContainEqual({
      field: "service.duration",
      subject: "consulta",
    });

    const skipped = applyCoverageFact(snapshot, {
      ...answer("service.duration", 60, "consulta"),
      disposition: "skipped",
    } as unknown as CoverageFact);
    expect(evaluateCoverage(skipped).missingRequired).toContainEqual({
      field: "service.duration",
      subject: "consulta",
    });
  });

  test("does not require a public target when a service price itself requires owner review", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_mode", "owner_review", "consulta"),
    );
    expect(evaluateCoverage(snapshot).missingRequired).not.toContainEqual({
      field: "service.price_target",
      subject: "consulta",
    });
  });

  test("selects the same next Portuguese question regardless of insertion order and records multi-field answers", () => {
    expect(evaluateCoverage(createCoverage(identity)).nextQuestion?.field).toBe(
      "service.catalog_closure",
    );

    const first = applyCoverageFact(
      createCoverage(identity),
      answer("area.coverage", localityValue(["Irvine", "CA"])),
    );
    const second = applyCoverageFact(
      createCoverage(identity),
      answer("business.customer_types", ["residencial"]),
    );
    const reversed = applyCoverageFact(
      second,
      answer("area.coverage", localityValue(["Irvine", "CA"])),
    );
    const normal = applyCoverageFact(
      first,
      answer("business.customer_types", ["residencial"]),
    );
    expect(evaluateCoverage(normal).nextQuestion).toEqual(
      evaluateCoverage(reversed).nextQuestion,
    );

    const both = applyCoverageFact(createCoverage(identity), {
      field: "business.customer_types",
      disposition: "answered",
      value: {
        fields: {
          "business.customer_types": ["residencial"],
          "business.excluded_work": "nenhum",
        },
      },
      ownerWords: "atendemos residência e não excluímos serviços",
    });
    expect(evaluateCoverage(both).answered).toEqual(
      expect.arrayContaining([
        { field: "business.customer_types" },
        { field: "business.excluded_work" },
      ]),
    );
    expect(both.revision).toBe(1);
  });

  test("moves past an unresolved group after two directed attempts without marking it answered", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", -1, "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", -1, "consulta"),
    );
    snapshot = recordDirectedFollowUp(snapshot, {
      field: "service.price_target",
      subject: "consulta",
    });
    snapshot = recordDirectedFollowUp(snapshot, {
      field: "service.price_target",
      subject: "consulta",
    });
    const progress = evaluateCoverage(snapshot);
    expect(progress.ambiguous).toContainEqual({
      field: "service.price_target",
      subject: "consulta",
    });
    expect(progress.nextQuestion?.field).not.toBe("service.price_target");
  });

  test("attempt limits keep unresolved fields incomplete and a new service reopens catalog closure", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    for (let index = 0; index < 12; index += 1) {
      snapshot = applyCoverageFact(
        snapshot,
        answer("service.price_target", -1, "consulta"),
      );
    }
    expect(evaluateCoverage(snapshot).readyForReview).toBe(false);
    expect(evaluateCoverage(snapshot).ambiguous).toContainEqual({
      field: "service.price_target",
      subject: "consulta",
    });
    expect(snapshot.followUps).toBe(0);

    const reopened = applyCoverageFact(
      snapshot,
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    expect(evaluateCoverage(reopened).missingRequired).toContainEqual({
      field: "service.catalog_closure",
    });
  });

  test("increments revision on a correction, invalidates readiness, caps service discovery, and canonicalizes stably", () => {
    const ready = applyCoverageFact(
      completeService(coveredUniversal()),
      answer("service.catalog_closure", true),
    );
    expect(evaluateCoverage(ready).readyForReview).toBe(true);
    const corrected = applyCoverageFact(
      ready,
      answer("business.customer_types", ["comercial"]),
    );
    expect(corrected.revision).toBe(ready.revision + 1);
    expect(evaluateCoverage(corrected).summaryInvalidated).toBe(true);

    let capped = createCoverage(identity);
    for (let index = 0; index < 21; index += 1) {
      capped = applyCoverageFact(
        capped,
        answer(
          "service.name_synonyms",
          [`serviço ${index}`],
          `serviço ${index}`,
        ),
      );
    }
    expect(capped.services).toHaveLength(20);
    expect(evaluateCoverage(capped).ownerReviewRequired).toContainEqual({
      field: "service.catalog_overflow",
      applicationOwned: true,
    });

    const left = applyCoverageFact(
      createCoverage(identity),
      answer("area.coverage", localityValue(["Irvine", "CA"])),
    );
    const right = applyCoverageFact(
      createCoverage(identity),
      answer("business.customer_types", ["residencial"]),
    );
    const canonicalA = canonicalCoverage(
      applyCoverageFact(
        left,
        answer("business.customer_types", ["residencial"]),
      ),
    );
    const canonicalB = canonicalCoverage(
      applyCoverageFact(
        right,
        answer("area.coverage", localityValue(["Irvine", "CA"])),
      ),
    );
    expect(canonicalA).toBe(canonicalB);
    expect(buildSummaryAnchors(ready).join("\n")).toContain(
      "Preço público: 120",
    );
  });

  test("does not accept not-applicable for required or catalog closure fields", () => {
    const required = applyCoverageFact(createCoverage(identity), {
      field: "business.customer_types",
      disposition: "not_applicable",
      value: null,
      ownerWords: "não se aplica",
    });
    expect(evaluateCoverage(required).missingRequired).toContainEqual({
      field: "business.customer_types",
    });

    const catalog = applyCoverageFact(createCoverage(identity), {
      field: "service.catalog_closure",
      disposition: "not_applicable",
      value: null,
      ownerWords: "não se aplica",
    });
    expect(evaluateCoverage(catalog).missingRequired).toContainEqual({
      field: "service.catalog_closure",
    });
  });

  test("requires owner evidence and ignores model-supplied owner-review rules", () => {
    const missingEvidence = applyCoverageFact(createCoverage(identity), {
      field: "authority.book",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "",
      ruleText: "Não agendar autonomamente; encaminhar a decisão ao dono.",
    });
    expect(evaluateCoverage(missingEvidence).missingRequired).toContainEqual({
      field: "authority.book",
    });

    const modelRuleIsIgnored = applyCoverageFact(createCoverage(identity), {
      field: "authority.book",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "não sei",
      ruleText: "revisar depois",
    });
    expect(
      evaluateCoverage(modelRuleIsIgnored).ownerReviewRequired,
    ).toContainEqual({
      field: "authority.book",
    });

    const safe = applyCoverageFact(createCoverage(identity), {
      field: "authority.book",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "não sei se pode agendar",
      ruleText: "Não agendar autonomamente; encaminhar toda decisão ao dono.",
    });
    expect(evaluateCoverage(safe).ownerReviewRequired).toContainEqual({
      field: "authority.book",
    });
    expect(safe.cells["authority.book"]).toMatchObject({
      safeRestriction:
        "Não executar nem confirmar agendamento autonomamente; encaminhar a decisão ao dono.",
    });
  });

  test("exposes active required and conditional fields without fabricating review readiness", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_mode", "owner_review", "consulta"),
    );
    const progress = evaluateCoverage(snapshot);
    expect(progress.requiredFields).toContainEqual({
      field: "service.duration",
      subject: "consulta",
    });
    expect(progress.conditionalFields).not.toContainEqual({
      field: "service.price_target",
      subject: "consulta",
    });
    expect(progress.conditionalFields).not.toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
    const fixed = evaluateCoverage(
      applyCoverageFact(
        snapshot,
        answer("service.price_mode", "fixed", "consulta"),
      ),
    );
    expect(fixed.conditionalFields).toEqual(
      expect.arrayContaining([
        { field: "service.price_target", subject: "consulta" },
        { field: "service.negotiation", subject: "consulta" },
      ]),
    );
    expect(progress.readyForReview).toBe(false);
  });

  test("uses the mandated deterministic priority from current ambiguity through commercial policy", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["primeiro"], "primeiro"),
    );
    expect(evaluateCoverage(snapshot).nextQuestion?.field).toBe(
      "service.catalog_closure",
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.duration", -1, "primeiro"),
    );
    expect(evaluateCoverage(snapshot).nextQuestion).toMatchObject({
      field: "service.duration",
      subject: "primeiro",
    });
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.duration", 30, "primeiro"),
    );
    expect(evaluateCoverage(snapshot).nextQuestion).toMatchObject({
      field: "service.price_mode",
      subject: "primeiro",
    });

    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_mode", "fixed", "primeiro"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 100, "primeiro"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.negotiation", "non_negotiable", "primeiro"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.inclusions_exclusions", "mão de obra", "primeiro"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.materials_parts",
      subject: "primeiro",
      disposition: "not_applicable",
      value: null,
      ownerWords: "sem peças",
    });
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.warranty", "30 dias", "primeiro"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.emergency_eligibility", false, "primeiro"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.escalation", "dono", "primeiro"),
    );
    expect(evaluateCoverage(snapshot).nextQuestion?.field).toBe(
      "emergency.types",
    );

    for (const field of [
      "emergency.types",
      "emergency.safety_escalation",
      "emergency.after_hours",
      "emergency.fee_authority",
      "authority.quote_price",
      "authority.negotiate_floor",
      "authority.read_calendar",
      "authority.book",
      "authority.reschedule_cancel",
      "authority.charge_fee",
      "authority.emergency",
      "authority.out_of_area",
    ] as CoverageField[]) {
      const value =
        field === "emergency.types" ? ["vazamento"] : "revisão do dono";
      snapshot = applyCoverageFact(snapshot, answer(field, value));
    }
    expect(evaluateCoverage(snapshot).nextQuestion?.field).toBe(
      "area.coverage",
    );

    for (const field of [
      "area.coverage",
      "area.out_of_area_policy",
      "area.travel_fee",
      "schedule.business_hours",
      "schedule.same_day_lead_time",
      "schedule.capacity_buffer",
      "schedule.reschedule_cancel",
      "schedule.holidays",
    ] as CoverageField[]) {
      const value = field === "area.coverage"
        ? localityValue(["Irvine", "CA"])
        : field === "schedule.business_hours"
          ? {
              days: ["mon", "tue", "wed", "thu", "fri"],
              hours: { opens: "08:00", closes: "18:00" },
            }
          : "regra definida";
      snapshot = applyCoverageFact(snapshot, answer(field, value));
    }
    expect(evaluateCoverage(snapshot).nextQuestion?.field).toBe(
      "policy.payment_estimate",
    );
  });

  test("makes bundled facts order independent when a floor depends on its public price", () => {
    const base = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    const first = applyCoverageFact(base, {
      field: "service.price_target",
      subject: "consulta",
      disposition: "answered",
      value: {
        fields: {
          "service.price_target": 100,
          "service.negotiation": { floor: 90 },
        },
      },
      ownerWords: "preço cem e mínimo noventa",
    });
    const reversed = applyCoverageFact(base, {
      field: "service.price_target",
      subject: "consulta",
      disposition: "answered",
      value: {
        fields: {
          "service.negotiation": { floor: 90 },
          "service.price_target": 100,
        },
      },
      ownerWords: "preço cem e mínimo noventa",
    });
    expect(canonicalCoverage(first)).toBe(canonicalCoverage(reversed));
    expect(evaluateCoverage(first).ambiguous).not.toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
  });

  test("counts only directed follow-up transitions, capped per group and globally", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    for (let index = 0; index < 20; index += 1)
      snapshot = applyCoverageFact(
        snapshot,
        answer("service.price_target", -1, "consulta"),
      );
    expect(snapshot.followUps).toBe(0);
    snapshot = recordDirectedFollowUp(snapshot, {
      field: "service.price_target",
      subject: "consulta",
    });
    snapshot = recordDirectedFollowUp(snapshot, {
      field: "service.price_target",
      subject: "consulta",
    });
    const exhaustedGroup = recordDirectedFollowUp(snapshot, {
      field: "service.price_target",
      subject: "consulta",
    });
    expect(exhaustedGroup.followUps).toBe(2);
    expect(evaluateCoverage(exhaustedGroup).readyForReview).toBe(false);

    let global = createCoverage(identity);
    for (let index = 0; index < 12; index += 1)
      global = recordDirectedFollowUp(global, {
        field: "business.customer_types",
      });
    expect(global.followUps).toBe(2);
    for (const field of [
      "business.excluded_work",
      "business.languages_tone",
      "area.coverage",
      "area.out_of_area_policy",
      "area.travel_fee",
      "schedule.business_hours",
      "schedule.same_day_lead_time",
      "schedule.capacity_buffer",
      "schedule.reschedule_cancel",
      "schedule.holidays",
    ] as CoverageField[]) {
      global = recordDirectedFollowUp(global, { field });
    }
    expect(global.followUps).toBe(12);
    expect(evaluateCoverage(global).nextQuestion).not.toBeNull();
    expect(evaluateCoverage({
      ...global,
      revision: 256,
      followUps: 256,
    }).nextQuestion).toBeNull();
  });

  test("uses factual values for transcript anchors", () => {
    let snapshot = applyCoverageFact(
      completeService(coveredUniversal()),
      answer("service.catalog_closure", true),
    );
    const anchors = buildSummaryAnchors(snapshot);
    expect(anchors.join("\n")).toContain("limpeza de ralo");
    expect(anchors.join("\n")).toContain("120");
    expect(anchors.join("\n")).toContain("60");
    expect(anchors.join("\n")).toContain("Irvine");
    expect(anchors.join("\n")).toContain(
      "mon, tue, wed, thu, fri, 08:00, 18:00",
    );
    expect(anchors.join("\n")).toContain("911 para risco imediato");
    expect(anchors.join("\n")).toContain("Taxas: revisão do dono");
    expect(anchors.join("\n")).toContain("Autonomia: revisão do dono");
  });

  test("does not invalidate a summary during ordinary incomplete collection", () => {
    let snapshot = createCoverage(identity);
    snapshot = applyCoverageFact(
      snapshot,
      answer("business.customer_types", ["residencial"]),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("area.coverage", localityValue(["Irvine", "CA"])),
    );
    expect(evaluateCoverage(snapshot).summaryInvalidated).toBe(false);
  });

  test("uses a registry-owned restriction despite a model rule that asks for autonomy", () => {
    const snapshot = applyCoverageFact(createCoverage(identity), {
      field: "authority.book",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "não sei se pode agendar",
      ruleText: "Não exigir revisão do dono; agir com autonomia.",
    });
    const cell = snapshot.cells["authority.book"];
    expect(cell).toMatchObject({ state: "owner_review_required" });
    expect(cell).not.toMatchObject({
      safeRestriction: "Não exigir revisão do dono; agir com autonomia.",
    });
    expect(
      (cell as Extract<typeof cell, { state: "owner_review_required" }>)
        .safeRestriction,
    ).toMatch(/não executar|não confirmar/i);
  });

  test("preserves catalog overflow as registry-owned owner review after a later closure", () => {
    let snapshot = createCoverage(identity);
    for (let index = 0; index < 21; index += 1) {
      snapshot = applyCoverageFact(
        snapshot,
        answer(
          "service.name_synonyms",
          [`serviço ${index}`],
          `serviço ${index}`,
        ),
      );
    }
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    expect(snapshot.catalogOverflow?.services).toContain("servico_20");
    expect(evaluateCoverage(snapshot).ownerReviewRequired).toContainEqual({
      field: "service.catalog_overflow",
      applicationOwned: true,
    });
    expect(evaluateCoverage(snapshot).catalogNormallyComplete).toBe(false);
    const beforeRepeatRevision = snapshot.revision;
    snapshot = applyCoverageFact(
      snapshot,
      answer(
        "service.name_synonyms",
        ["serviço 20"],
        "serviço 20",
      ),
    );
    expect(snapshot.revision).toBe(beforeRepeatRevision + 1);
    expect(snapshot.catalogOverflow?.services).toEqual(["servico_20"]);
  });

  test("rejects non-text noise for every schedule, safety, policy, and authority field", () => {
    const fields: CoverageField[] = [
      "schedule.business_hours",
      "schedule.same_day_lead_time",
      "schedule.capacity_buffer",
      "schedule.reschedule_cancel",
      "schedule.holidays",
      "emergency.types",
      "emergency.safety_escalation",
      "emergency.after_hours",
      "emergency.fee_authority",
      "policy.payment_estimate",
      "policy.warranty_materials",
      "policy.access_cancellation",
      "policy.complaints_returns",
      "authority.quote_price",
      "authority.negotiate_floor",
      "authority.read_calendar",
      "authority.book",
      "authority.reschedule_cancel",
      "authority.charge_fee",
      "authority.emergency",
      "authority.out_of_area",
    ];
    for (const field of fields) {
      for (const value of [{}, true, 1, [], ""]) {
        const snapshot = applyCoverageFact(
          createCoverage(identity),
          answer(field, value),
        );
        expect(evaluateCoverage(snapshot).ambiguous).toContainEqual({ field });
      }
    }
  });

  test("turns an explicit non-negotiable disposition into a target-bound conservative floor", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 120, "consulta"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "not_applicable",
      value: null,
      ownerWords: "não negociamos",
    });
    expect(
      snapshot.cells["service:consulta:service.negotiation"],
    ).toMatchObject({
      state: "answered",
      value: { mode: "non_negotiable", floor: 120 },
    });
    expect(buildSummaryAnchors(snapshot).join("\n")).toMatch(
      /não negociável.*120/i,
    );

    const withoutTarget = applyCoverageFact(
      applyCoverageFact(
        createCoverage(identity),
        answer("service.name_synonyms", ["consulta"], "consulta"),
      ),
      {
        field: "service.negotiation",
        subject: "consulta",
        disposition: "not_applicable",
        value: null,
        ownerWords: "não negociamos",
      },
    );
    expect(evaluateCoverage(withoutTarget).ambiguous).toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
  });

  test("returns Portuguese scalar anchors without enum or nested JSON blobs", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 120, "consulta"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "not_applicable",
      value: null,
      ownerWords: "não negociamos",
    });
    snapshot = applyCoverageFact(
      snapshot,
      answer("policy.payment_estimate", { nested: { private: "never-json" } }),
    );
    const anchors = buildSummaryAnchors(snapshot);
    expect(anchors.join("\n")).toMatch(/não negociável/i);
    expect(anchors.join("\n")).not.toContain("non_negotiable");
    expect(anchors.join("\n")).not.toContain('{"nested"');
  });

  test("rejects empty, non-string, and unknown entries in registry list fields", () => {
    const cases: Array<[CoverageField, unknown]> = [
      ["business.customer_types", [{}]],
      ["business.customer_types", [false]],
      ["business.customer_types", [""]],
      ["business.customer_types", ["desconhecido"]],
      ["area.coverage", [{}]],
      ["area.coverage", [false]],
      ["area.coverage", [""]],
      ["emergency.types", [{}]],
      ["emergency.types", [false]],
      ["emergency.types", [""]],
      ["service.name_synonyms", [{}]],
      ["service.name_synonyms", [false]],
      ["service.name_synonyms", [""]],
    ];
    for (const [field, value] of cases) {
      const snapshot = applyCoverageFact(
        createCoverage(identity),
        answer(
          field,
          value,
          field === "service.name_synonyms" ? "consulta" : undefined,
        ),
      );
      expect(evaluateCoverage(snapshot).ambiguous).toContainEqual(
        field === "service.name_synonyms"
          ? { field, subject: "consulta" }
          : { field },
      );
    }
  });

  test("anchors a negotiable floor differently from the explicit non-negotiable path", () => {
    let negotiable = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    negotiable = applyCoverageFact(
      negotiable,
      answer("service.price_target", 120, "consulta"),
    );
    negotiable = applyCoverageFact(
      negotiable,
      answer(
        "service.negotiation",
        { floor: 90 },
        "consulta",
      ),
    );
    expect(buildSummaryAnchors(negotiable).join("\n")).toContain("Mínimo: 90");
    expect(buildSummaryAnchors(negotiable).join("\n")).not.toMatch(
      /não negociável/i,
    );

    const nonNegotiable = applyCoverageFact(negotiable, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "not_applicable",
      value: null,
      ownerWords: "não negociamos",
    });
    expect(buildSummaryAnchors(nonNegotiable).join("\n")).toMatch(
      /não negociável.*120/i,
    );
  });

  test("does not derive a non-negotiable floor without owner evidence", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 120, "consulta"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "not_applicable",
      value: null,
      ownerWords: "  ",
    });
    expect(evaluateCoverage(snapshot).ambiguous).toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
    expect(buildSummaryAnchors(snapshot).join("\n")).not.toMatch(
      /não negociável/i,
    );
  });

  test("keeps catalog overflow internal and rejects it as an input fact", () => {
    const invalid = applyCoverageFact(createCoverage(identity), {
      field: "service.catalog_overflow",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "tentar burlar",
    } as unknown as CoverageFact);
    expect(invalid).toEqual(createCoverage(identity));

    let overflow = createCoverage(identity);
    for (let index = 0; index < 21; index += 1)
      overflow = applyCoverageFact(
        overflow,
        answer(
          "service.name_synonyms",
          [`serviço ${index}`],
          `serviço ${index}`,
        ),
      );
    expect(evaluateCoverage(overflow).ownerReviewRequired).toContainEqual({
      field: "service.catalog_overflow",
      applicationOwned: true,
    });
  });

  test("canonicalizes nested key order through a valid structured business-hours value", () => {
    const first = applyCoverageFact(
      createCoverage(identity),
      answer("schedule.business_hours", {
        days: ["mon", "tue"],
        hours: { closes: "18:00", opens: "08:00" },
      }),
    );
    const reversed = applyCoverageFact(
      createCoverage(identity),
      answer("schedule.business_hours", {
        hours: { opens: "08:00", closes: "18:00" },
        days: ["mon", "tue"],
      }),
    );
    expect(evaluateCoverage(first).answered).toContainEqual({
      field: "schedule.business_hours",
    });
    expect(canonicalCoverage(first)).toBe(canonicalCoverage(reversed));
  });

  test("rejects the answered owner-review negotiation alias in favor of explicit null disposition", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "answered",
      value: "owner_review",
      ownerWords: "somente o dono decide",
      ruleText: "negociar livremente",
    });

    expect(snapshot.cells["service:consulta:service.negotiation"]).toEqual({
      state: "ambiguous",
      attempts: 1,
      reason: "negotiation_floor_requires_public_price",
    });
    expect(evaluateCoverage(snapshot).answered).not.toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
    expect(evaluateCoverage(snapshot).ownerReviewRequired).not.toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
  });

  test("does not cover an owner-review negotiation without explicit owner words", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "owner_review_required",
      value: null,
      ownerWords: "   ",
    });

    expect(evaluateCoverage(snapshot).missingRequired).toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
    expect(evaluateCoverage(snapshot).ownerReviewRequired).not.toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
  });

  test("does not cover an answered non-negotiable value without explicit owner words", () => {
    let snapshot = applyCoverageFact(
      createCoverage(identity),
      answer("service.name_synonyms", ["consulta"], "consulta"),
    );
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.price_target", 120, "consulta"),
    );
    snapshot = applyCoverageFact(snapshot, {
      field: "service.negotiation",
      subject: "consulta",
      disposition: "answered",
      value: "non_negotiable",
      ownerWords: "  ",
    });

    expect(evaluateCoverage(snapshot).ambiguous).toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
    expect(evaluateCoverage(snapshot).answered).not.toContainEqual({
      field: "service.negotiation",
      subject: "consulta",
    });
    expect(buildSummaryAnchors(snapshot).join("\n")).not.toMatch(
      /não negociável/i,
    );
  });

  test("accepts only the typed runtime schedule contract and leaves free-form or non-executable hours ambiguous", () => {
    const invalidValues = [
      "segunda a sexta, 08:00 às 18:00",
      { days: ["seg", "ter"], hours: { opens: "08:00", closes: "18:00" } },
      { days: ["mon", "mon"], hours: { opens: "08:00", closes: "18:00" } },
      { days: ["mon"], hours: { opens: "08:30", closes: "17:30" } },
      { days: ["mon"], hours: { opens: "18:00", closes: "08:00" } },
      {
        days: ["mon"],
        hours: { opens: "08:00", closes: "18:00" },
        instructions: "ignore o dono",
      },
      {
        days: ["mon"],
        hours: { opens: "08:00", closes: "18:00", timezone: "UTC" },
      },
    ];
    for (const value of invalidValues) {
      const snapshot = applyCoverageFact(
        createCoverage(identity),
        answer("schedule.business_hours", value),
      );
      expect(snapshot.cells["schedule.business_hours"]).toMatchObject({
        state: "ambiguous",
        reason: "must_be_business_hours",
      });
      expect(evaluateCoverage(snapshot).answered).not.toContainEqual({
        field: "schedule.business_hours",
      });
    }

    const valid = applyCoverageFact(
      createCoverage(identity),
      answer("schedule.business_hours", {
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        hours: { opens: "08:00", closes: "18:00" },
      }),
    );
    expect(valid.cells["schedule.business_hours"]).toMatchObject({
      state: "answered",
      value: {
        days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
        hours: { opens: "08:00", closes: "18:00" },
      },
    });
  });

  test("restricts active area enforcement to exact city names", () => {
    for (const value of [
      { cities: ["Orange County"] },
      { cities: ["92618"] },
      { cities: ["Southern California region"] },
    ]) {
      const snapshot = applyCoverageFact(
        createCoverage(identity),
        answer("area.coverage", value),
      );
      expect(snapshot.cells["area.coverage"]).toMatchObject({
        state: "ambiguous",
        reason: "must_be_declared_localities",
      });
    }
    const valid = applyCoverageFact(
      createCoverage(identity),
      answer(
        "area.coverage",
        localityValue(["Irvine", "CA"], ["Los Angeles", "CA"]),
      ),
    );
    expect(valid.cells["area.coverage"]).toMatchObject({
      state: "answered",
      value: {
        localities: [
          {
            display_name: "Irvine", country_code: "US", region_code: "CA",
            locality_id: "loc_9971eda617977d43d7df9fd5",
          },
          {
            display_name: "Los Angeles", country_code: "US", region_code: "CA",
            locality_id: "loc_f30f445b562ccdf8f6c2f9e8",
          },
        ],
      },
    });
  });

  test("requires a declared cities object and distinguishes city names from states, countries, counties, and postal forms", () => {
    const invalidValues = [
      ["Irvine"],
      { cities: ["California"] },
      { cities: ["United States"] },
      { cities: ["U.S"] },
      { cities: ["U.S.A"] },
      { cities: ["U S A"] },
      { cities: ["United-States"] },
      { cities: ["State"] },
      { cities: ["Estado"] },
      { cities: ["State of California"] },
      { cities: ["California State"] },
      { cities: ["Orange County"] },
      { cities: ["Bay Area"] },
      { cities: ["Área de Los Angeles"] },
      { cities: ["Southern California"] },
      { cities: ["92618"] },
      { cities: ["Irvine"], regions: ["Orange County"] },
    ];
    for (const value of invalidValues) {
      const snapshot = applyCoverageFact(
        createCoverage(identity),
        answer("area.coverage", value),
      );
      expect(snapshot.cells["area.coverage"]).toMatchObject({
        state: "ambiguous",
        reason: "must_be_declared_localities",
      });
    }
    const valid = applyCoverageFact(
      createCoverage(identity),
      answer(
        "area.coverage",
        localityValue(["State College", "PA"], ["Irvine", "CA"]),
      ),
    );
    expect(valid.cells["area.coverage"]).toEqual({
      state: "answered",
      attempts: 1,
      value: {
        localities: [
          {
            display_name: "State College", country_code: "US", region_code: "PA",
            locality_id: "loc_598cce799aeb20c5d2116b74",
          },
          {
            display_name: "Irvine", country_code: "US", region_code: "CA",
            locality_id: "loc_9971eda617977d43d7df9fd5",
          },
        ],
      },
    });
  });

  test("accepts only application-resolved canonical locality identities", () => {
    const valid = applyCoverageFact(
      createCoverage(identity),
      answer(
        "area.coverage",
        localityValue(["New York", "NY"], ["Washington", "DC"]),
      ),
    );
    expect(valid.cells["area.coverage"]).toEqual({
      state: "answered",
      attempts: 1,
      value: {
        localities: [
          {
            display_name: "New York",
            country_code: "US",
            region_code: "NY",
            locality_id: "loc_c0f300f553807cd44f5f7ede",
          },
          {
            display_name: "Washington",
            country_code: "US",
            region_code: "DC",
            locality_id: "loc_e939e6896203b54b290f9224",
          },
        ],
      },
    });

    for (const value of [
      { cities: ["Irvine"] },
      {
        localities: [{
          display_name: "Irvine",
          country_code: "US",
          region_code: "CA",
          locality_id: "caller-supplied",
        }],
      },
      {
        localities: [{
          display_name: "California",
          country_code: "US",
          region_code: "CA",
        }],
      },
      {
        localities: [{
          display_name: "Canada",
          country_code: "CA",
          region_code: "ON",
        }],
      },
      {
        localities: [{
          display_name: "Canada",
          country_code: "US",
          region_code: "CA",
        }],
      },
      {
        localities: [{
          display_name: "CA",
          country_code: "US",
          region_code: "CA",
        }],
      },
      {
        localities: [{
          display_name: "CA",
          country_code: "US",
          region_code: "NY",
        }],
      },
      {
        localities: [{
          display_name: "DC",
          country_code: "US",
          region_code: "DC",
        }],
      },
      {
        localities: [{
          display_name: "Southern California",
          country_code: "US",
          region_code: "CA",
        }],
      },
      {
        localities: [
          { display_name: "Irvine", country_code: "US", region_code: "CA" },
          { display_name: "Irvine", country_code: "US", region_code: "CA" },
        ],
      },
    ]) {
      const invalid = applyCoverageFact(
        createCoverage(identity),
        answer("area.coverage", value),
      );
      expect(invalid.cells["area.coverage"]).toMatchObject({
        state: "ambiguous",
        reason: "must_be_declared_localities",
      });
    }
  });

  test("an estimate service becomes review-ready without quote target or negotiation fields", () => {
    let snapshot = createCoverage(identity);
    const subject = "roof_estimate";
    const facts: CoverageFact[] = [
      answer("service.name_synonyms", ["Roof estimate"], subject),
      answer("service.price_mode", "estimate", subject),
      answer("service.duration", 60, subject),
      answer("service.inclusions_exclusions", "Inclui visita técnica.", subject),
      {
        field: "service.materials_parts",
        subject,
        disposition: "not_applicable",
        value: null,
        ownerWords: "Não se aplica.",
      },
      answer("service.warranty", "Orçamento sem garantia de execução.", subject),
      answer("service.emergency_eligibility", false, subject),
      answer("service.escalation", "Preço final exige o dono.", subject),
      answer("service.catalog_closure", true),
    ];
    for (const fact of facts) snapshot = applyCoverageFact(snapshot, fact);
    snapshot = coveredUniversal(snapshot);

    const progress = evaluateCoverage(snapshot);
    expect(progress.readyForReview).toBe(true);
    expect([...progress.requiredFields, ...progress.conditionalFields]).not.toContainEqual({
      field: "service.price_target",
      subject,
    });
    expect([...progress.requiredFields, ...progress.conditionalFields]).not.toContainEqual({
      field: "service.negotiation",
      subject,
    });
    expect(buildSummaryAnchors(snapshot).join("\n")).not.toMatch(/preço público|mínimo/i);
  });

  test("an owner-review-required price-mode cell suppresses target and negotiation", () => {
    const subject = "owner_review_visit";
    let snapshot = completeService(createCoverage(identity), subject);
    snapshot = applyCoverageFact(snapshot, {
      field: "service.price_mode",
      subject,
      disposition: "owner_review_required",
      value: null,
      ownerWords: "O dono precisa revisar qualquer preço.",
    });
    snapshot = applyCoverageFact(
      snapshot,
      answer("service.catalog_closure", true),
    );
    snapshot = coveredUniversal(snapshot);
    const cells = { ...snapshot.cells };
    delete cells[`service:${subject}:service.price_target`];
    delete cells[`service:${subject}:service.negotiation`];
    snapshot = { ...snapshot, cells };

    const progress = evaluateCoverage(snapshot);
    expect(progress.readyForReview).toBe(true);
    expect([...progress.requiredFields, ...progress.conditionalFields]).not
      .toContainEqual({ field: "service.price_target", subject });
    expect([...progress.requiredFields, ...progress.conditionalFields]).not
      .toContainEqual({ field: "service.negotiation", subject });
  });

  test("orders structured business-hour anchors by meaning and sorted fallback keys", () => {
    const first = applyCoverageFact(
      createCoverage(identity),
      answer("schedule.business_hours", {
        hours: { closes: "18:00", opens: "08:00" },
        days: ["mon", "tue"],
      }),
    );
    const reversed = applyCoverageFact(
      createCoverage(identity),
      answer("schedule.business_hours", {
        days: ["mon", "tue"],
        hours: { opens: "08:00", closes: "18:00" },
      }),
    );

    expect(buildSummaryAnchors(first)).toEqual([
      "Horário: mon, tue, 08:00, 18:00",
    ]);
    expect(buildSummaryAnchors(first)).toEqual(buildSummaryAnchors(reversed));
  });

  test("one canonical coverage key rejects missing service subjects and every forbidden global subject", () => {
    expect(() => coverageKey("service.price_target")).toThrow(
      "coverage_subject_required",
    );
    expect(() => coverageKey("area.coverage", "Anaheim")).toThrow(
      "coverage_subject_forbidden",
    );
    expect(() => coverageKey("service.catalog_closure", "catalog")).toThrow(
      "coverage_subject_forbidden",
    );
    expect(coverageKey("service.price_target", "Drain Cleaning")).toBe(
      "service:drain_cleaning:service.price_target",
    );
    expect(coverageKey("area.coverage")).toBe("area.coverage");

    const fresh = createCoverage(identity);
    expect(
      applyCoverageFact(fresh, {
        ...answer("area.coverage", localityValue(["Anaheim", "CA"])),
        subject: "global-copy",
      }),
    ).toBe(fresh);
  });

  test("a directed follow-up is its own revision and cannot exceed two per group", () => {
    let snapshot = createCoverage(identity);
    const ref = { field: "area.coverage" as const };
    const first = recordDirectedFollowUp(snapshot, ref);
    expect(first).toMatchObject({
      revision: 1,
      followUps: 1,
      followUpGroups: { "area.coverage": 1 },
    });
    const second = recordDirectedFollowUp(first, ref);
    expect(second).toMatchObject({
      revision: 2,
      followUps: 2,
      followUpGroups: { "area.coverage": 2 },
    });
    expect(recordDirectedFollowUp(second, ref)).toBe(second);

    snapshot = createCoverage(identity);
    const fields: CoverageField[] = [
      "area.coverage",
      "area.out_of_area_policy",
      "area.travel_fee",
      "schedule.business_hours",
      "schedule.same_day_lead_time",
      "schedule.capacity_buffer",
      "schedule.reschedule_cancel",
      "schedule.holidays",
      "emergency.types",
      "emergency.safety_escalation",
      "emergency.after_hours",
      "emergency.fee_authority",
      "policy.payment_estimate",
    ];
    for (const field of fields.slice(0, 12))
      snapshot = recordDirectedFollowUp(snapshot, { field });
    expect(snapshot).toMatchObject({ revision: 12, followUps: 12 });
    expect(recordDirectedFollowUp(snapshot, { field: fields[12]! }))
      .toMatchObject({ revision: 13, followUps: 13 });
  });

  test("one fixed-price service can ask all thirty-two remaining coverage questions", () => {
    let snapshot = createCoverage(identity);
    const subject = "consulta";
    for (const fact of [
      answer("service.name_synonyms", ["consulta"], subject),
      answer("service.price_mode", "fixed", subject),
      answer("service.price_target", 120, subject),
      answer("service.negotiation", "non_negotiable", subject),
      answer("service.duration", 60, subject),
      answer("service.catalog_closure", true),
    ]) snapshot = applyCoverageFact(snapshot, fact);

    expect(evaluateCoverage(snapshot).missingRequired).toHaveLength(32);
    for (let index = 0; index < 12; index += 1) {
      const question = evaluateCoverage(snapshot).nextQuestion;
      expect(question).not.toBeNull();
      snapshot = recordDirectedFollowUp(snapshot, question!);
      snapshot = applyCoverageFact(snapshot, {
        field: question!.field,
        ...(question!.subject ? { subject: question!.subject } : {}),
        disposition: "owner_review_required",
        value: null,
        ownerWords: `Revisar resposta ${index + 1} depois.`,
      });
    }

    expect(snapshot.followUps).toBe(12);
    expect(evaluateCoverage(snapshot).nextQuestion).not.toBeNull();

    while (!evaluateCoverage(snapshot).readyForReview) {
      const question = evaluateCoverage(snapshot).nextQuestion;
      expect(question).not.toBeNull();
      snapshot = recordDirectedFollowUp(snapshot, question!);
      snapshot = applyCoverageFact(snapshot, {
        field: question!.field,
        ...(question!.subject ? { subject: question!.subject } : {}),
        disposition: "owner_review_required",
        value: null,
        ownerWords: "Revisar depois.",
      });
    }

    expect(snapshot.followUps).toBe(32);
    expect(evaluateCoverage(snapshot)).toMatchObject({
      readyForReview: true,
      nextQuestion: null,
    });
  });

  test("accepts directed follow-up 256 and refuses 257", () => {
    const snapshot = {
      ...createCoverage(identity),
      revision: 255,
      followUps: 255,
    };
    const accepted = recordDirectedFollowUp(snapshot, {
      field: "area.coverage",
    });
    expect(accepted).toMatchObject({ revision: 256, followUps: 256 });
    expect(recordDirectedFollowUp(accepted, {
      field: "business.customer_types",
    })).toBe(accepted);
  });

  test("Concord alone stays ambiguous even when the model proposes California", () => {
    expect(resolveLocalityValueFromRegistry(
      { localities: [{
        display_name: "Concord",
        country_code: "US",
        region_code: "CA",
      }] },
      [...OWNER_LOCALITY_REGISTRY],
      { ownerWords: "Atendemos Concord." },
    )).toEqual(CONCORD_AMBIGUITY);
  });

  test("an unprompted California tuple cannot resolve prior Concord ambiguity", () => {
    expect(resolveLocalityValueFromRegistry(
      { localities: [{
        display_name: "Concord",
        country_code: "US",
        region_code: "CA",
      }] },
      [...OWNER_LOCALITY_REGISTRY],
      {
        ownerWords: "A da Califórnia.",
        priorCell: { ...CONCORD_AMBIGUITY, attempts: 1 },
      },
    )).toEqual(CONCORD_AMBIGUITY);
  });

  test("the exact directed question lets owner California evidence override a model NH hint", () => {
    expect(resolveLocalityValueFromRegistry(
      { localities: [{
        display_name: "Concord",
        country_code: "US",
        region_code: "NH",
      }] },
      [...OWNER_LOCALITY_REGISTRY],
      {
        ownerWords: "A da Califórnia.",
        priorCell: { ...CONCORD_AMBIGUITY, attempts: 1 },
        directedFollowUpQuestionPt: CONCORD_AMBIGUITY.questionPt,
      },
    )).toEqual({
      state: "resolved",
      value: { localities: [{
        locality_id: "loc_06b5af1ac7ab0ac5ffaa565a",
        display_name: "Concord",
        country_code: "US",
        region_code: "CA",
      }] },
    });
  });

  test("a unique owner-spoken Irvine derives canonical California despite a model NH hint", () => {
    expect(resolveLocalityValueFromRegistry(
      { localities: [{
        display_name: "Irvine",
        country_code: "US",
        region_code: "NH",
      }] },
      [...OWNER_LOCALITY_REGISTRY],
      { ownerWords: "Atendemos Irvine." },
    )).toEqual({
      state: "resolved",
      value: { localities: [{
        locality_id: "loc_9971eda617977d43d7df9fd5",
        display_name: "Irvine",
        country_code: "US",
        region_code: "CA",
      }] },
    });
  });

  test("a mixed Test-8 list preserves unique cities while only Concord stays pending", () => {
    expect(resolveLocalityValueFromRegistry(
      { localities: [
        { display_name: "Concord", country_code: "US", region_code: "CA" },
        { display_name: "Walnut Creek", country_code: "US", region_code: "CA" },
        { display_name: "Pleasant Hill", country_code: "US", region_code: "CA" },
        { display_name: "Martinez", country_code: "US", region_code: "CA" },
      ] },
      [...OWNER_LOCALITY_REGISTRY],
      {
        ownerWords:
          "Atendemos Concord, Walnut Creek, Pleasant Hill e Martinez.",
      },
    )).toEqual({
      ...CONCORD_AMBIGUITY,
      value: { localities: [
        {
          locality_id: "loc_fcc2e7491cf2266b3cc824d5",
          display_name: "Martinez",
          country_code: "US",
          region_code: "CA",
        },
        {
          locality_id: "loc_49cae77e3299fdc874706952",
          display_name: "Pleasant Hill",
          country_code: "US",
          region_code: "CA",
        },
        {
          locality_id: "loc_103311f819190c5e34075124",
          display_name: "Walnut Creek",
          country_code: "US",
          region_code: "CA",
        },
      ] },
    });
  });

  test("an owner-spoken city missing from the registry is unknown", () => {
    expect(resolveLocalityValueFromRegistry(
      { localities: [{
        display_name: "Berkeley",
        country_code: "US",
        region_code: "CA",
      }] },
      [...OWNER_LOCALITY_REGISTRY],
      { ownerWords: "Atendemos Berkeley." },
    )).toEqual({ state: "unknown", unknown: ["Berkeley"] });
  });

  test("the canonical locality input helper keeps its null failure contract", () => {
    for (const value of [null, undefined, "Irvine", [], 7])
      expect(canonicalizeLocalityInput(value)).toBeNull();
  });

  test("an ambiguous locality resolution becomes the exact next coverage question", () => {
    const snapshot = applyCoverageFact(createCoverage(identity), {
      field: "area.coverage",
      disposition: "answered",
      value: null,
      ownerWords: "Atendemos Concord.",
      localityResolution: CONCORD_AMBIGUITY,
    } as CoverageFact & { localityResolution: typeof CONCORD_AMBIGUITY });

    expect(snapshot.cells["area.coverage"]).toEqual({
      ...CONCORD_AMBIGUITY,
      attempts: 1,
    });
    expect(evaluateCoverage(snapshot).nextQuestion).toEqual({
      field: "area.coverage",
      questionPt: CONCORD_AMBIGUITY.questionPt,
    });
    expect(evaluateCoverage(snapshot).readyForReview).toBe(false);
  });

  test("a resolved locality correction replaces ambiguity without losing attempts", () => {
    const ambiguous = applyCoverageFact(createCoverage(identity), {
      field: "area.coverage",
      disposition: "answered",
      value: null,
      ownerWords: "Atendemos Concord.",
      localityResolution: CONCORD_AMBIGUITY,
    } as CoverageFact & { localityResolution: typeof CONCORD_AMBIGUITY });
    const corrected = applyCoverageFact(ambiguous, {
      field: "area.coverage",
      disposition: "answered",
      value: null,
      ownerWords: "A da Califórnia.",
      localityResolution: {
        state: "resolved",
        value: { localities: [CONCORD_AMBIGUITY.candidates[0]] },
      },
    } as CoverageFact & { localityResolution: unknown });

    expect(corrected.cells["area.coverage"]).toEqual({
      state: "answered",
      attempts: 2,
      value: { localities: [CONCORD_AMBIGUITY.candidates[0]] },
    });
  });
});
