// Plan v4 §3 + §12: grant conditions are ENFORCED, and proactive messages pass a complete gate.
// Pure logic + mocked Supabase — no network, $0.
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { _setClient } from "../src/rules.ts";
import { conditionsDeny, checkPower, checkCommunication, contactHash } from "../src/powers.ts";

const TZ = "America/Los_Angeles";
// Thursday 2026-08-20, 10:00 and 03:00 Pacific
const THU_10AM = new Date("2026-08-20T17:00:00Z");
const THU_3AM = new Date("2026-08-20T10:00:00Z");
const SUN_10AM = new Date("2026-08-23T17:00:00Z");

const BUSINESS_HOURS = {
  allowed_hours: { start: "08:00", end: "18:00", days: ["mon", "tue", "wed", "thu", "fri", "sat"] },
  channel: ["sms"],
  purpose: ["follow_up", "confirmation"],
  frequency: { max: 2, per_days: 7 },
  max_body_chars: 320,
};

describe("conditionsDeny (grant conditions are real, not decoration)", () => {
  test("allows an action inside the granted window", () => {
    expect(conditionsDeny(BUSINESS_HOURS, { at: THU_10AM, channel: "sms", purpose: "follow_up" }, TZ)).toBeNull();
  });
  test("blocks 3am — the quiet-hours case that would wake a customer", () => {
    expect(conditionsDeny(BUSINESS_HOURS, { at: THU_3AM, channel: "sms" }, TZ)).toBe("outside_allowed_hours");
  });
  test("blocks a day outside the grant (Sunday)", () => {
    expect(conditionsDeny(BUSINESS_HOURS, { at: SUN_10AM, channel: "sms" }, TZ)).toBe("outside_allowed_days");
  });
  test("blocks a channel that was never granted", () => {
    expect(conditionsDeny(BUSINESS_HOURS, { at: THU_10AM, channel: "whatsapp" }, TZ)).toBe("channel_not_granted");
  });
  test("blocks a purpose that was never granted (no marketing under a follow-up grant)", () => {
    expect(conditionsDeny(BUSINESS_HOURS, { at: THU_10AM, channel: "sms", purpose: "marketing" }, TZ)).toBe("purpose_not_granted");
  });
  test("blocks work outside the granted geography", () => {
    expect(conditionsDeny({ geography: ["Anaheim", "Irvine"] }, { geography: "Los Angeles" }, TZ)).toBe("outside_allowed_geography");
    expect(conditionsDeny({ geography: ["Anaheim", "Irvine"] }, { geography: "irvine" }, TZ)).toBeNull();
  });
  test("empty conditions never block", () => {
    expect(conditionsDeny({}, { at: THU_3AM }, TZ)).toBeNull();
  });
  test("malformed conditions fail closed", () => {
    expect(conditionsDeny(null, { at: THU_10AM }, TZ)).toBe("malformed_conditions");
    expect(conditionsDeny({ allowed_hours: { days: "mon-sat", open: "08:00", close: "18:00" } }, { at: THU_10AM }, TZ)).toBe("malformed_conditions");
    expect(conditionsDeny({ unrecognized_constraint: true }, { at: THU_10AM }, TZ)).toBe("malformed_conditions");
  });
  test("configured fields require their matching authority context", () => {
    expect(conditionsDeny({ geography: ["Irvine"] }, {}, TZ)).toBe("geography_required");
    expect(conditionsDeny({ channel: ["voice"] }, {}, TZ)).toBe("channel_required");
    expect(conditionsDeny({ purpose: ["booking"] }, {}, TZ)).toBe("purpose_required");
  });
  test("normalizes geography and evaluates the appointment instant", () => {
    const conditions = {
      geography: ["São Paulo"],
      allowed_hours: { days: ["mon", "tue", "wed", "thu", "fri", "sat"], start: "08:00", end: "18:00" },
    };
    expect(conditionsDeny(conditions, { geography: "  SAO   PAULO ", appointmentAt: THU_10AM }, TZ)).toBeNull();
    expect(conditionsDeny(conditions, { geography: "sao paulo", appointmentAt: SUN_10AM }, TZ)).toBe("outside_allowed_days");
  });
});

// ---------------------------------------------------------------- mocked ledger
let powersRows: any[] = [];
let optOutRows: any[] = [];
let sentRows: any[] = [];
let tenantLookupFails = false;

function mockSupabase() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; },
        eq() { return api; },
        in() { return api; },
        gte() { return api; },
        is() { return api; },
        limit: async () => ({ data: table === "contact_opt_outs" ? optOutRows : [], error: null }),
        single: async () =>
          table === "tenants"
            ? tenantLookupFails
              ? { data: null, error: { message: "tenant lookup failed" } }
              : { data: { auth_epoch: 1, timezone: TZ }, error: null }
            : { data: powersRows[0] ?? null, error: null },
        then(res: any) { // awaited without a terminal method (powers / communications lookups)
          const data = table === "powers" ? powersRows : table === "communications" ? sentRows : [];
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return api;
    },
  } as any;
}

beforeEach(() => {
  powersRows = [{ id: "p-1", resource: "sms", monetary_limit: null, expires_at: null, conditions: BUSINESS_HOURS }];
  optOutRows = [];
  sentRows = [];
  tenantLookupFails = false;
  _setClient(mockSupabase());
});
afterAll(() => _setClient(null));

describe("checkPower enforces conditions", () => {
  test("grants inside the window", async () => {
    const r = await checkPower("t-1", "hermes", "follow_up_message", "sms", { at: THU_10AM, channel: "sms", purpose: "follow_up" });
    expect(r.granted).toBe(true);
  });
  test("denies at 3am even though the capability is granted", async () => {
    const r = await checkPower("t-1", "hermes", "follow_up_message", "sms", { at: THU_3AM, channel: "sms" });
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("outside_allowed_hours");
  });
  test("inspects every matching grant before denying on a monetary limit", async () => {
    powersRows = [
      { id: "p-low", resource: "sms", monetary_limit: 100, expires_at: null, conditions: BUSINESS_HOURS },
      { id: "p-high", resource: "sms", monetary_limit: 500, expires_at: null, conditions: BUSINESS_HOURS },
    ];
    const r = await checkPower("t-1", "hermes", "follow_up_message", "sms", {
      amountUsd: 250, at: THU_10AM, channel: "sms", purpose: "follow_up",
    });
    expect(r.granted).toBe(true);
    expect(r.powerId).toBe("p-high");
  });
  test("rejects a capability issued under an older authorization epoch", async () => {
    const r = await checkPower("t-1", "hermes", "follow_up_message", "sms", {
      at: THU_10AM, channel: "sms", purpose: "follow_up", expectedAuthEpoch: 0,
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toBe("authorization_epoch_stale");
  });
  test("fails closed when the tenant epoch cannot be loaded", async () => {
    tenantLookupFails = true;
    const r = await checkPower("t-1", "hermes", "follow_up_message", "sms", {
      at: THU_10AM, channel: "sms", purpose: "follow_up",
    });
    expect(r.granted).toBe(false);
    expect(r.reason).toContain("tenant_authority_lookup_failed");
  });
});

describe("checkCommunication (complete grant, plan v4 §12)", () => {
  const base = { tenantId: "t-1", contact: "+1 949 555 0101", channel: "sms", purpose: "follow_up", body: "Hi! Following up on your drain cleaning quote.", priorConsent: true };

  test("allows a granted follow-up in business hours", async () => {
    const r = await checkCommunication({ ...base, at: THU_10AM, timezone: TZ });
    expect(r.allowed).toBe(true);
  });
  test("never messages at 3am", async () => {
    const r = await checkCommunication({ ...base, at: THU_3AM, timezone: TZ });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("outside_allowed_hours");
  });
  test("respects opt-out", async () => {
    optOutRows = [{ id: "o-1" }];
    const r = await checkCommunication({ ...base, at: THU_10AM, timezone: TZ });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("opt_out");
  });
  test("fails closed when a consent-bound grant has no consent context", async () => {
    powersRows = [{ ...powersRows[0], conditions: { ...BUSINESS_HOURS, requires_prior_consent: true } }];
    const { priorConsent: _omitted, ...withoutConsent } = base;
    const r = await checkCommunication({ ...withoutConsent, at: THU_10AM, timezone: TZ });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("prior_consent_required");
  });
  test("respects the frequency cap (2 per 7 days)", async () => {
    sentRows = [{ id: "c-1" }, { id: "c-2" }];
    const r = await checkCommunication({ ...base, at: THU_10AM, timezone: TZ });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("frequency_cap");
  });
  test("enforces the content limit from the grant", async () => {
    const r = await checkCommunication({ ...base, body: "x".repeat(400), at: THU_10AM, timezone: TZ });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("body_too_long");
  });
  test("contact hashing is stable across formatting, so opt-out cannot be dodged", () => {
    const canonical = contactHash("+19495550101");
    for (const variant of ["+1 (949) 555-0101", "949-555-0101", "(949) 555 0101", " +1.949.555.0101 "]) {
      expect(contactHash(variant)).toBe(canonical);
    }
    // different people stay different
    expect(contactHash("+19495550102")).not.toBe(canonical);
    // emails normalize by case/space, not by digits
    expect(contactHash(" Marcos@Rocha.com ")).toBe(contactHash("marcos@rocha.com"));
  });
});

// ---------------------------------------------------------------- cost kill-switch (plan v4 §8)
import { sessionCostCapUsd } from "../src/sideband.ts";
import { sessionCostUsd, emptyUsage } from "../src/config.ts";

describe("session cost cap (a live expensive session must be cut, not just future ones)", () => {
  test("mini has a lower ceiling than the frontier model", () => {
    expect(sessionCostCapUsd("gpt-realtime-2.1-mini")).toBeLessThan(sessionCostCapUsd("gpt-realtime-2.1"));
  });
  test("a runaway session crosses the cap and would be killed", () => {
    const u = emptyUsage();
    u.audioIn = 40_000; u.audioOut = 25_000; // a long, rich call
    const spent = sessionCostUsd("gpt-realtime-2.1", u);
    expect(spent).toBeGreaterThan(sessionCostCapUsd("gpt-realtime-2.1"));
  });
  test("a normal short call stays well under the cap", () => {
    const u = emptyUsage();
    u.audioIn = 2_000; u.audioOut = 1_500; // ~a couple of minutes
    expect(sessionCostUsd("gpt-realtime-2.1", u)).toBeLessThan(sessionCostCapUsd("gpt-realtime-2.1"));
  });
  test("env override wins when set", () => {
    process.env.SESSION_COST_CAP_USD = "0.25";
    expect(sessionCostCapUsd("gpt-realtime-2.1")).toBe(0.25);
    delete process.env.SESSION_COST_CAP_USD;
  });
});
