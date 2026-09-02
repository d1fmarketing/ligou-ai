import { describe, expect, test } from "bun:test";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CALL = "22222222-2222-4222-8222-222222222222";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const RESULT = "55555555-5555-4555-8555-555555555555";
const CLAIM = "66666666-6666-4666-8666-666666666666";

function fact(claimType: string, value: unknown, overrides: Record<string, unknown> = {}) {
  return {
    claim_id: CLAIM,
    claim_class: claimType === "emergency" ? "safety_critical" : "operational",
    claim_type: claimType,
    value,
    decision: "approve",
    edited_by_owner: false,
    evidence_refs: ["77777777-7777-4777-8777-777777777777"],
    confidence: "high",
    contradiction_status: "none",
    adapter_id: "direct_model",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    claim_schema_version: "company_discovery.claim.v2",
    missing_fields: [],
    ambiguous_fields: [],
    contradictions: [],
    uncertainty: [],
    ...overrides,
  };
}

function readback(approvedFacts: unknown[], unresolvedItems: unknown[] = []) {
  return {
    draft_id: DRAFT,
    draft_version: 1,
    draft_hash: "a".repeat(64),
    draft: {
      schema_version: "company_discovery.onboarding_draft.v1",
      source_job_id: JOB,
      source_result_id: RESULT,
      approved_facts: approvedFacts,
      rejected_claim_ids: [],
      unresolved_items: unresolvedItems,
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
    },
  };
}

async function build(approvedFacts: unknown[], options: Record<string, unknown> = {}) {
  const module = await import("../src/company-discovery-prefill.ts");
  return module.buildCompanyDiscoveryPrefill({
    tenant_id: TENANT,
    call_id: CALL,
    draft_readback: readback(approvedFacts),
    localities: [],
    ...options,
  });
}

describe("Company Discovery Stage 0B onboarding prefill fixtures", () => {
  test("1. exact city and state territory resolves only through the locality registry", async () => {
    const projection = await build([fact("service_territory", {
      service_type: null,
      included_areas: [{ kind: "city", name: "Novato", region_state: "CA", country_code: "US" }],
      excluded_areas: [],
      radius: null,
    })], {
      localities: [{
        locality_id: "88888888-8888-4888-8888-888888888888",
        display_name: "Novato",
        country_code: "US",
        region_code: "CA",
        aliases: ["novato"],
      }],
    });
    expect(projection.coverage.snapshot.cells["area.coverage"]).toEqual({
      state: "answered",
      attempts: 0,
      value: { localities: [{
        display_name: "Novato",
        country_code: "US",
        region_code: "CA",
        locality_id: "88888888-8888-4888-8888-888888888888",
      }] },
    });
  });

  test("2. ambiguous city without state remains an onboarding ambiguity", async () => {
    const projection = await build([fact("service_territory", {
      service_type: null,
      included_areas: [{ kind: "city", name: "Concord", region_state: null, country_code: "US" }],
      excluded_areas: [],
      radius: null,
    }, { ambiguous_fields: ["included_areas[0].region_state"] })]);
    expect(projection.coverage.snapshot.cells["area.coverage"]?.state).toBe("ambiguous");
    expect(JSON.stringify(projection.coverage.snapshot)).not.toContain("locality_id");
  });

  test("3. statewide or broad marketing language never becomes an exact city list", async () => {
    const projection = await build([fact("service_territory", {
      service_type: null,
      included_areas: [{ kind: "marketing_region", name: "the whole Bay Area", region_state: "CA", country_code: "US" }],
      excluded_areas: [],
      radius: null,
    })]);
    expect(projection.coverage.snapshot.cells["area.coverage"]?.state).toBe("ambiguous");
    expect(JSON.stringify(projection.coverage.snapshot)).not.toContain('"localities"');
  });

  test("4. one explicit normal weekly interval prefills business hours", async () => {
    const projection = await build([fact("business_hours", {
      timezone: "America/Los_Angeles",
      ordinary_intervals: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat"], opens: "08:00", closes: "18:00" }],
      closed_days: ["sun"],
      ordinary_24_7: false,
      emergency_24_7: false,
      after_hours: "unavailable",
      holiday_policy: "Closed on federal holidays",
    })]);
    expect(projection.coverage.snapshot.cells["schedule.business_hours"]).toEqual({
      state: "answered", attempts: 0,
      value: { days: ["mon", "tue", "wed", "thu", "fri", "sat"], hours: { opens: "08:00", closes: "18:00" } },
    });
  });

  test("5. 24/7 emergency availability does not become ordinary 24/7 booking", async () => {
    const projection = await build([fact("business_hours", {
      timezone: "America/Los_Angeles",
      ordinary_intervals: [{ days: ["mon", "tue", "wed", "thu", "fri"], opens: "09:00", closes: "17:00" }],
      closed_days: ["sat", "sun"],
      ordinary_24_7: false,
      emergency_24_7: true,
      after_hours: "emergency_only",
      holiday_policy: null,
    }, { missing_fields: ["holiday_policy"] })]);
    expect((projection.coverage.snapshot.cells["schedule.business_hours"] as any).value.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect((projection.coverage.snapshot.cells["emergency.after_hours"] as any).value).toContain("emergência");
    expect(JSON.stringify(projection.coverage.snapshot.cells["schedule.business_hours"])).not.toContain("24/7");
  });

  test("6. explicit 90-day labor guarantee prefills only the warranty question", async () => {
    const projection = await build([fact("guarantee", {
      guarantee_kind: "company_guarantee",
      service_type: "leak_repair",
      coverage: ["labor"],
      duration: { amount: 90, unit: "days" },
      conditions: ["Company labor only"],
      exclusions: [],
    })]);
    const warranty = projection.coverage.snapshot.cells["service:leak_repair:service.warranty"] as any;
    expect(warranty.state).toBe("answered");
    expect(warranty.value).toContain("90 days");
    expect(projection.coverage.snapshot.cells["authority.book"]).toBeUndefined();
  });

  test("7. vague satisfaction language never invents money, lifetime, or duration", async () => {
    const projection = await build([fact("guarantee", {
      guarantee_kind: "satisfaction_statement",
      service_type: null,
      coverage: ["satisfaction"],
      duration: null,
      conditions: ["Satisfaction guaranteed"],
      exclusions: [],
    })]);
    const warranty = projection.coverage.snapshot.cells["policy.warranty_materials"] as any;
    expect(warranty.value).toContain("Satisfaction guaranteed");
    expect(warranty.value).not.toMatch(/lifetime|\$|day|month|year/i);
  });

  test("8. explicit same-day restriction prefills lead-time but grants no booking power", async () => {
    const projection = await build([fact("booking_restriction", {
      restriction_type: "same_day",
      service_type: null,
      rule: "conditional",
      notice_minutes: 120,
      public_fee: null,
      conditions: ["Call before noon for same-day eligibility"],
    })]);
    expect(projection.coverage.snapshot.cells["schedule.same_day_lead_time"]?.state).toBe("answered");
    expect(projection.coverage.snapshot.cells["authority.book"]).toBeUndefined();
    expect(projection.coverage.authority).toEqual({
      rules_approved: false,
      powers_granted: false,
      operational_mode_changed: false,
    });
  });

  test("9. Sunday unavailable remains a scheduling restriction rather than booking authority", async () => {
    const projection = await build([fact("booking_restriction", {
      restriction_type: "sunday",
      service_type: null,
      rule: "not_allowed",
      notice_minutes: null,
      public_fee: null,
      conditions: ["No Sunday appointments"],
    })]);
    expect(projection.coverage.snapshot.cells["schedule.business_hours"]?.state).toBe("ambiguous");
    expect(projection.coverage.snapshot.cells["authority.book"]).toBeUndefined();
  });

  test("10. cancellation fee and access requirement prefill separate policy fields", async () => {
    const projection = await build([
      fact("booking_restriction", {
        restriction_type: "cancellation", service_type: null, rule: "fee_applies",
        notice_minutes: 1440,
        public_fee: { amount: "75.00", currency: "USD", qualifier: "fixed", condition: "Less than 24 hours" },
        conditions: ["$75 fee with less than 24 hours notice"],
      }),
      fact("booking_restriction", {
        restriction_type: "access", service_type: null, rule: "required",
        notice_minutes: null, public_fee: null,
        conditions: ["An adult must provide safe access"],
      }, { claim_id: "99999999-9999-4999-8999-999999999999" }),
    ]);
    expect((projection.coverage.snapshot.cells["schedule.reschedule_cancel"] as any).value).toContain("75.00");
    expect((projection.coverage.snapshot.cells["policy.access_cancellation"] as any).value).toContain("safe access");
    expect(projection.coverage.snapshot.cells["authority.charge_fee"]).toBeUndefined();
  });

  test("11. contradictory pages remain ambiguous and do not suppress the owner question", async () => {
    const projection = await build([fact("business_hours", {
      timezone: "America/Los_Angeles",
      ordinary_intervals: [{ days: ["mon"], opens: "08:00", closes: "18:00" }],
      closed_days: [], ordinary_24_7: false, emergency_24_7: false,
      after_hours: "unavailable", holiday_policy: "Closed",
    }, {
      contradiction_status: "confirmed",
      contradictions: ["Contact page says 8–6; footer says 9–5"],
    })]);
    expect(projection.coverage.snapshot.cells["schedule.business_hours"]?.state).toBe("ambiguous");
    expect(projection.coverage.progress.ambiguous).toContainEqual({ field: "schedule.business_hours" });
  });

  test("12. website with none of the four classes keeps the ordinary first question", async () => {
    const projection = await build([]);
    expect(projection.coverage.snapshot.services).toEqual([]);
    expect(projection.coverage.snapshot.cells).toEqual({});
    expect(projection.coverage.next_action).toEqual({
      type: "ask",
      field: "service.catalog_closure",
      question_pt: "Quais serviços sua empresa oferece?",
    });
  });
});
