import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { _setClient, invalidateTenant, loadTenant } from "../src/rules.ts";

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
