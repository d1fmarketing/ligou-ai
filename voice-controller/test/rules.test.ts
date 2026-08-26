import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  _setClient,
  invalidateTenant,
  loadTenant,
  priceRules,
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
});
