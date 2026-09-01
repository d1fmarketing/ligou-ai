import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  _setClient,
  invalidateTenant,
  loadTenant,
  priceRules,
  ruleByMaterializationKey,
  servicePolicies,
  type Rule,
} from "../src/rules.ts";

const BASE_TENANT = {
  id: "tenant-1",
  slug: "rocha-plumbing",
  name: "Rocha Plumbing",
  vertical: "plumbing",
  languages: ["en", "es"],
  timezone: "America/Los_Angeles",
  session_max_minutes: 15,
  owner_user_id: "owner-1",
  auth_epoch: 3,
  policy_epoch: 7,
};

let tenantReads = 0;
let effectiveRuleReads = 0;
let rawRuleReads = 0;
let policyEpoch = 7;
let effectiveRules = [{
  id: "rule-v2",
  rule_group_id: "group-1",
  version: 2,
  category: "preco",
  escopo: "servico",
  text: "Current price",
  structured: { service_type: "drain_cleaning", price_target: 225 },
}];

function rulesClient() {
  return {
    from(table: string) {
      if (table === "tenants") tenantReads += 1;
      if (table === "effective_rules") effectiveRuleReads += 1;
      if (table === "rules") rawRuleReads += 1;
      const api: any = {
        select() { return api; },
        eq() { return api; },
        order() { return api; },
        single: async () => ({ data: { ...BASE_TENANT, policy_epoch: policyEpoch }, error: null }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: table === "effective_rules" ? effectiveRules : [], error: null }).then(resolve);
        },
      };
      return api;
    },
  } as any;
}

beforeEach(() => {
  tenantReads = 0;
  effectiveRuleReads = 0;
  rawRuleReads = 0;
  policyEpoch = 7;
  effectiveRules = [{
    id: "rule-v2", rule_group_id: "group-1", version: 2,
    category: "preco", escopo: "servico", text: "Current price",
    structured: { service_type: "drain_cleaning", price_target: 225 },
  }];
  invalidateTenant("rocha-plumbing");
  _setClient(rulesClient());
});

afterAll(() => _setClient(null));

describe("effective rule loading", () => {
  test("reads the latest-version projection instead of every approved history row", async () => {
    const loaded = await loadTenant("rocha-plumbing");

    expect(loaded.rules.map((rule) => rule.id)).toEqual(["rule-v2"]);
    expect(effectiveRuleReads).toBe(1);
    expect(rawRuleReads).toBe(0);
  });

  test("reuses rules only while both authority epochs are unchanged", async () => {
    await loadTenant("rocha-plumbing");
    await loadTenant("rocha-plumbing");

    expect(tenantReads).toBe(2);
    expect(effectiveRuleReads).toBe(1);

    policyEpoch = 8;
    effectiveRules = [];
    const afterRevocation = await loadTenant("rocha-plumbing");

    expect(afterRevocation.rules).toEqual([]);
    expect(effectiveRuleReads).toBe(2);
  });
});

describe("V2 service policy projection", () => {
  const rule = (
    id: string,
    structured: Record<string, unknown>,
    text = "canonical",
  ): Rule => ({
    id,
    rule_group_id: `${id}-group`,
    version: 1,
    category: "preco",
    escopo: "servico",
    text,
    structured,
  });

  test("prefers one eligible V2 fixed service and keeps the quoteable legacy compatibility subset", () => {
    const legacy = rule("legacy", {
      service_type: "drain_cleaning",
      price_target: 999,
      price_min: 999,
      duration_min: 10,
    });
    const v2 = rule("v2", {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:drain_cleaning",
      materialization_hash: "a".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "active",
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning", "Unclog drain"],
      price_mode: "fixed",
      negotiation_mode: "non_negotiable",
      quoteable: true,
      negotiable: false,
      price_target: 149,
      price_min: 149,
      duration_min: 90,
      owner_review_fields: [],
      coverage_revision: 41,
      source_call_id: "22222222-2222-4222-8222-222222222222",
    });

    expect(servicePolicies([legacy, v2])).toEqual([
      expect.objectContaining({
        rule_id: "v2",
        service_type: "drain_cleaning",
        service_names: ["Drain cleaning", "Unclog drain"],
        price_mode: "fixed",
        quoteable: true,
        negotiable: false,
        price_target: 149,
        price_min: 149,
        duration_min: 90,
      }),
    ]);
    expect(priceRules([legacy, v2])).toEqual([
      expect.objectContaining({
        rule_id: "v2",
        service_type: "drain_cleaning",
        price_target: 149,
        price_min: 149,
      }),
    ]);
  });

  test("keeps exact discovery public price visible for review but never autonomous", () => {
    const discovery = rule("discovery-v2", {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:drain_cleaning",
      materialization_hash: "9".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "owner_review_required",
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      price_mode: "owner_review",
      quoteable: false,
      negotiable: false,
      public_price: {
        amount: "149.00",
        currency: "USD",
        qualifier: "exact",
      },
      duration_min: 90,
      owner_review_fields: [
        "service.negotiation",
        "service.price_mode",
        "service.private_pricing",
      ],
      source_kind: "company_discovery",
      source_job_id: "11111111-1111-4111-8111-111111111111",
      source_result_id: "22222222-2222-4222-8222-222222222222",
      source_claim_id: "33333333-3333-4333-8333-333333333333",
      source_decision_id: "44444444-4444-4444-8444-444444444444",
      source_refs: ["55555555-5555-4555-8555-555555555555"],
    });

    expect(servicePolicies([discovery])).toEqual([
      expect.objectContaining({
        rule_id: "discovery-v2",
        service_type: "drain_cleaning",
        price_mode: "owner_review",
        quoteable: false,
        negotiable: false,
        public_price: {
          amount: "149.00",
          currency: "USD",
          qualifier: "exact",
        },
      }),
    ]);
    expect(priceRules([discovery])).toEqual([]);
    const { duration_min: _duration, ...withoutDuration } = discovery.structured!;
    const noPublicPrice: Rule = {
      ...discovery,
      id: "discovery-no-public-price",
      rule_group_id: "discovery-no-public-price-group",
      structured: { ...withoutDuration, public_price: null },
    };
    expect(servicePolicies([noPublicPrice])).toEqual([
      expect.objectContaining({
        public_price: null,
        quoteable: false,
        negotiable: false,
      }),
    ]);
    expect(servicePolicies([noPublicPrice])[0]).not.toHaveProperty("duration_min");
    expect(priceRules([noPublicPrice])).toEqual([]);
    expect(discovery.structured).not.toHaveProperty("source_call_id");
  });

  test("rejects discovery public-price review rows that smuggle private pricing authority", () => {
    const base = {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:drain_cleaning",
      materialization_hash: "7".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "owner_review_required",
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      price_mode: "owner_review",
      quoteable: false,
      negotiable: false,
      public_price: {
        amount: "149.00",
        currency: "USD",
        qualifier: "starting_at",
      },
      owner_review_fields: [
        "service.negotiation",
        "service.price_mode",
        "service.private_pricing",
      ],
      source_kind: "company_discovery",
      source_job_id: "11111111-1111-4111-8111-111111111111",
      source_result_id: "22222222-2222-4222-8222-222222222222",
      source_claim_id: "33333333-3333-4333-8333-333333333333",
      source_decision_id: "44444444-4444-4444-8444-444444444444",
      source_refs: ["55555555-5555-4555-8555-555555555555"],
    };
    for (const privatePricing of [
      { price_target: 149 },
      { price_min: 120 },
      { negotiation_mode: "non_negotiable" },
    ]) {
      expect(servicePolicies([rule("private-smuggle", {
        ...base,
        ...privatePricing,
      })])).toEqual([]);
    }
  });

  test("rejects incomplete discovery provenance even when the policy fields look executable", () => {
    const legacy = rule("legacy-discovery-shadow", {
      service_type: "drain_cleaning",
      price_target: 999,
      price_min: 999,
      duration_min: 10,
    });
    const malformed = rule("malformed-discovery-v2", {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:drain_cleaning",
      materialization_hash: "8".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "active",
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      price_mode: "fixed",
      negotiation_mode: "non_negotiable",
      quoteable: true,
      negotiable: false,
      price_target: 149,
      price_min: 149,
      duration_min: 90,
      owner_review_fields: [],
      source_kind: "company_discovery",
      source_job_id: "11111111-1111-4111-8111-111111111111",
      source_result_id: "22222222-2222-4222-8222-222222222222",
      source_claim_id: "33333333-3333-4333-8333-333333333333",
      source_refs: ["55555555-5555-4555-8555-555555555555"],
    });

    expect(servicePolicies([legacy, malformed])).toEqual([]);
    expect(priceRules([legacy, malformed])).toEqual([]);
  });

  test("lists estimate and owner-review services while excluding them from autonomous pricing", () => {
    const estimate = rule("estimate", {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:camera_inspection",
      materialization_hash: "b".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "active",
      service_type: "camera_inspection",
      service_names: ["Camera inspection"],
      price_mode: "estimate",
      quoteable: false,
      negotiable: false,
      duration_min: 60,
      owner_review_fields: [],
      coverage_revision: 42,
      source_call_id: "22222222-2222-4222-8222-222222222222",
    });
    const ownerReview = rule("owner-review", {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:sewer_repair",
      materialization_hash: "c".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "owner_review_required",
      service_type: "sewer_repair",
      service_names: ["Sewer repair"],
      price_mode: "owner_review",
      quoteable: false,
      negotiable: false,
      owner_review_fields: ["service.price_mode"],
      coverage_revision: 43,
      source_call_id: "22222222-2222-4222-8222-222222222222",
    });

    expect(servicePolicies([estimate, ownerReview]).map((item) => item.service_type))
      .toEqual(["camera_inspection", "sewer_repair"]);
    expect(priceRules([estimate, ownerReview])).toEqual([]);
  });

  test("a service V2 row with non-service scope shadows legacy but cannot become a policy", () => {
    const legacy = rule("legacy-wrong-scope", {
      service_type: "drain_cleaning",
      price_target: 225,
      price_min: 225,
      duration_min: 60,
    });
    const wrongScope: Rule = {
      ...rule("v2-wrong-scope", {
        schema: "ligou.rule.service.v2",
        materialization_key: "service:drain_cleaning",
        materialization_hash: "c".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        service_type: "drain_cleaning",
        service_names: ["Drain cleaning"],
        price_mode: "fixed",
        quoteable: true,
        negotiable: false,
        price_target: 149,
        price_min: 149,
        duration_min: 60,
        coverage_revision: 45,
        source_call_id: "22222222-2222-4222-8222-222222222222",
      }),
      escopo: "geral",
    };
    expect(servicePolicies([legacy, wrongScope])).toEqual([]);
    expect(priceRules([legacy, wrongScope])).toEqual([]);
  });

  test("ignores V2 rows that are not explicitly eligible and preserves strict legacy rules", () => {
    const unsafe = rule("unsafe", {
      schema: "ligou.rule.service.v2",
      materialization_key: "service:unsafe",
      materialization_hash: "d".repeat(64),
      materialization_eligible: false,
      review_ready: false,
      operational_state: "incomplete",
      service_type: "unsafe",
      service_names: ["Unsafe"],
      price_mode: "fixed",
      quoteable: true,
      price_target: 1,
      price_min: 0,
      duration_min: 1,
    });
    const legacy = rule("legacy-safe", {
      service_type: "legacy_service",
      price_target: 200,
      price_min: 150,
      duration_min: 60,
    });

    expect(servicePolicies([unsafe, legacy]).map((item) => item.service_type))
      .toEqual(["legacy_service"]);
    expect(priceRules([unsafe, legacy]).map((item) => item.service_type))
      .toEqual(["legacy_service"]);
  });

  test("a schema-marked V2 service with a missing or mismatched key shadows legacy for its subject", () => {
    const legacy = rule("legacy-drain", {
      service_type: "drain_cleaning",
      price_target: 999,
      price_min: 999,
      duration_min: 10,
    });
    const base = {
      schema: "ligou.rule.service.v2",
      materialization_hash: "e".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "active",
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      price_mode: "fixed",
      quoteable: true,
      negotiable: false,
      price_target: 149,
      price_min: 149,
      duration_min: 60,
      coverage_revision: 44,
      source_call_id: "22222222-2222-4222-8222-222222222222",
    };
    for (const materializationKey of [undefined, "service:other_service"]) {
      const malformed = rule("malformed-v2", {
        ...base,
        ...(materializationKey === undefined
          ? {}
          : { materialization_key: materializationKey }),
      });
      expect(servicePolicies([legacy, malformed])).toEqual([]);
      expect(priceRules([legacy, malformed])).toEqual([]);
    }
  });

  test("a domain V2 row masquerading as pricing is never parsed as legacy and shadows its claimed service", () => {
    const legacy = rule("legacy-drain", {
      service_type: "drain_cleaning",
      price_target: 225,
      price_min: 149,
      duration_min: 60,
    });
    const scheduleAsPrice = rule("schedule-as-price", {
      schema: "ligou.rule.schedule.v2",
      materialization_key: "domain:schedule",
      materialization_hash: "f".repeat(64),
      materialization_eligible: true,
      review_ready: true,
      operational_state: "active",
      service_type: "drain_cleaning",
      price_target: 1,
      price_min: 1,
      duration_min: 1,
      business_hours: {
        days: ["mon"],
        hours: { opens: "08:00", closes: "18:00" },
      },
    });

    expect(servicePolicies([legacy, scheduleAsPrice])).toEqual([]);
    expect(priceRules([legacy, scheduleAsPrice])).toEqual([]);
  });

  test("any present reserved marker makes a service row nonlegacy regardless of marker value", () => {
    const legacy = rule("legacy-reserved-shadow", {
      service_type: "drain_cleaning",
      price_target: 225,
      price_min: 149,
      duration_min: 60,
    });
    const markerValues: unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "\nligou.rule.service.v2\t",
      "ligou.rule.service.v3",
      3,
      {},
      [],
    ];
    for (const [index, marker] of markerValues.entries()) {
      const schemaMarked = rule(`schema-marker-${index}`, {
        schema: marker,
        service_type: "drain_cleaning",
        price_target: 1,
        price_min: 1,
        duration_min: 1,
      });
      const keyMarked = rule(`key-marker-${index}`, {
        materialization_key: marker,
        service_type: "drain_cleaning",
        price_target: 1,
        price_min: 1,
        duration_min: 1,
      });
      expect(servicePolicies([legacy, schemaMarked]), `schema ${index}`)
        .toEqual([]);
      expect(servicePolicies([legacy, keyMarked]), `key ${index}`)
        .toEqual([]);
    }
    const wrongCategory: Rule = {
      ...rule("reserved-wrong-category", {
        schema: null,
        service_type: "drain_cleaning",
        price_target: 1,
        price_min: 1,
        duration_min: 1,
      }),
      category: "outro",
    };
    expect(servicePolicies([legacy, wrongCategory])).toEqual([]);
  });

  test("a padded marked service key shadows legacy even without a redundant service_type", () => {
    const legacy = rule("legacy-padded-shadow", {
      service_type: "drain_cleaning",
      price_target: 225,
      price_min: 149,
      duration_min: 60,
    });
    for (const materializationKey of [
      " service:drain_cleaning ",
      "\tservice:drain_cleaning\n",
    ]) {
      const marked = rule("padded-key", {
        schema: "ligou.rule.service.v2",
        materialization_key: materializationKey,
        materialization_hash: "f".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        service_names: ["Drain cleaning"],
        price_mode: "fixed",
        quoteable: true,
        negotiable: false,
        price_target: 1,
        price_min: 1,
        duration_min: 1,
        coverage_revision: 1,
        source_call_id: "22222222-2222-4222-8222-222222222222",
      });
      expect(servicePolicies([legacy, marked]), materializationKey).toEqual([]);
      expect(priceRules([legacy, marked]), materializationKey).toEqual([]);
    }
  });
});

describe("V2 domain policy projection", () => {
  const legacyArea: Rule = {
    id: "legacy-area",
    rule_group_id: "legacy-area-group",
    version: 1,
    category: "area",
    escopo: "localizacao",
    text: "Legacy Irvine.",
    structured: { cities: ["Irvine"] },
  };

  test("a self-hashed V2 locality without runtime registry membership shadows legacy but is not operational", () => {
    const unverified: Rule = {
      id: "unverified-area",
      rule_group_id: "unverified-area-group",
      version: 1,
      category: "area",
      escopo: "localizacao",
      text: "Berkeley.",
      structured: {
        schema: "ligou.rule.area.v2",
        materialization_key: "domain:area",
        materialization_hash: "a".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        localities: [{
          display_name: "Berkeley",
          country_code: "US",
          region_code: "CA",
          locality_id: "loc_f6c6b198478b384c7149fdba",
        }],
      },
    };
    expect(ruleByMaterializationKey(
      [legacyArea, unverified],
      "domain:area",
      "area",
    )).toBeUndefined();
  });

  test("schema-only or key-only malformed V2 domains shadow legacy", () => {
    const base: Rule = {
      id: "v2-area",
      rule_group_id: "v2-area-group",
      version: 1,
      category: "area",
      escopo: "localizacao",
      text: "V2 area.",
      structured: {
        schema: "ligou.rule.area.v2",
        materialization_key: "domain:area",
        materialization_hash: "a".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        cities: ["Irvine"],
      },
    };
    const schemaOnly = {
      ...base,
      structured: { ...base.structured, materialization_key: undefined },
    } as Rule;
    const keyOnly = {
      ...base,
      structured: { ...base.structured, schema: undefined },
    } as Rule;
    expect(ruleByMaterializationKey(
      [legacyArea, schemaOnly],
      "domain:area",
      "area",
    )).toBeUndefined();
    expect(ruleByMaterializationKey(
      [legacyArea, keyOnly],
      "domain:area",
      "area",
    )).toBeUndefined();
  });

  test("every ligou.rule.*.v2 namespace shape is V2-marked even with extra schema segments", () => {
    for (const [index, schema] of [
      "ligou.rule.schedule.experimental.v2",
      "ligou.rule.schedule\nexperimental.v2",
      "ligou.rule..v2",
    ].entries()) {
      const hostile: Rule = {
        ...legacyArea,
        id: `hostile-nested-v2-schema-${index}`,
        rule_group_id: `hostile-nested-v2-schema-group-${index}`,
        text: "Nested V2 schema must never become legacy area authority.",
        structured: { schema, cities: ["Irvine"] },
      };
      expect(ruleByMaterializationKey(
        [legacyArea, hostile],
        "domain:area",
        "area",
      )).toBeUndefined();
    }
  });

  test("a schedule V2 row categorized as area blocks both domain identities and never falls back", () => {
    const scheduleAsArea: Rule = {
      id: "schedule-as-area",
      rule_group_id: "schedule-as-area-group",
      version: 1,
      category: "area",
      escopo: "localizacao",
      text: "Cross-domain text must not be trusted.",
      structured: {
        schema: "ligou.rule.schedule.v2",
        materialization_key: "domain:schedule",
        materialization_hash: "b".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        business_hours: {
          days: ["mon"],
          hours: { opens: "08:00", closes: "18:00" },
        },
      },
    };
    expect(ruleByMaterializationKey(
      [legacyArea, scheduleAsArea],
      "domain:area",
      "area",
    )).toBeUndefined();
    expect(ruleByMaterializationKey(
      [legacyArea, scheduleAsArea],
      "domain:schedule",
      "agenda",
    )).toBeUndefined();
  });

  test("any present reserved marker shadows a same-category legacy domain", () => {
    const markerValues: unknown[] = [
      null,
      " ",
      "\nligou.rule.area.v3\t",
      9,
      {},
      [],
    ];
    for (const [index, marker] of markerValues.entries()) {
      const marked: Rule = {
        ...legacyArea,
        id: `reserved-area-${index}`,
        rule_group_id: `reserved-area-group-${index}`,
        text: "Reserved marker must never become area authority.",
        structured: { schema: marker, cities: ["Irvine"] },
      };
      expect(ruleByMaterializationKey(
        [legacyArea, marked],
        "domain:area",
        "area",
      )).toBeUndefined();
    }
  });
});
