import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDeal, proposeBooking } from "../src/booking.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { makeCapability } from "../src/tools.ts";

const TENANT = {
  id: "tenant-1", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "owner-1", auth_epoch: 4, policy_epoch: 9,
};
const RULES = [{
  id: "rule-1", rule_group_id: "group-1", version: 1, category: "preco", escopo: "servico",
  text: "Drain cleaning", structured: { service_type: "drain_cleaning", price_min: 149, price_target: 225 },
}];
let activeRules = RULES;
const POWERS = [{
  id: "power-1", resource: "drain_cleaning", monetary_limit: 225, expires_at: null,
  conditions: {
    geography: ["Irvine"],
    allowed_hours: { days: ["mon", "tue", "wed", "thu", "fri", "sat"], start: "08:00", end: "18:00" },
    channel: ["voice"], purpose: ["booking"],
  },
}];

let inserted: Array<{ table: string; row: any }> = [];
let rpcCalls: Array<{ name: string; args: any }> = [];
let authorizeError: { message: string } | null = null;

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; }, is() { return api; },
        upsert(row: any) { inserted.push({ table, row }); return api; },
        update(row: any) { inserted.push({ table: `${table}:update`, row }); return api; },
        single: async () => {
          if (table === "tenants") return { data: TENANT, error: null };
          if (table === "bookings") return { data: {
            id: "booking-1", tenant_id: TENANT.id, status: "proposed", service_type: "drain_cleaning",
            price_agreed: 225, slot_start: "2026-08-21T17:00:00Z", slot_end: "2026-08-21T18:00:00Z",
            authority_context: { geography: "irvine", channel: "voice", purpose: "booking", appointment_at: "2026-08-21T17:00:00.000Z" },
          }, error: null };
          if (table === "approval_cases") return { data: { id: "case-1" }, error: null };
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "effective_rules" ? activeRules : table === "powers" ? POWERS : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (name === "authorize_booking_intent") {
        return Promise.resolve({ data: authorizeError ? null : { id: "intent-1", status: "queued" }, error: authorizeError });
      }
      if (name === "consume_slot_offer") {
        return Promise.resolve({ data: { booking_id: "booking-1" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  inserted = [];
  rpcCalls = [];
  authorizeError = null;
  activeRules = RULES;
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});
afterAll(() => _setClient(null));

const capability = () => makeCapability("rocha-plumbing", TENANT.id, "call-1", 15, "customer", {
  authEpoch: TENANT.auth_epoch,
  policyEpoch: TENANT.policy_epoch,
});

describe("booking passes the complete power context", () => {
  test("proposal delegates exact offer validation to the atomic consumer", async () => {
    const result = await proposeBooking(capability(), {
      slot_token: "opaque-offer",
    });

    expect(result.status).toBe("proposed");
    const call = rpcCalls.find((entry) => entry.name === "consume_slot_offer")!;
    expect(call.args).toMatchObject({
      p_tenant: TENANT.id,
      p_call: "call-1",
      p_expected_auth_epoch: TENANT.auth_epoch,
      p_expected_policy_epoch: TENANT.policy_epoch,
    });
  });

  test("model-supplied close price cannot override the server-bound booking price", async () => {
    const result = await closeDeal(capability(), { booking_id: "booking-1", confirmed_price: 1 });

    expect(result.status).toBe("processing");
    const call = rpcCalls.find((entry) => entry.name === "authorize_booking_intent")!;
    expect(call.args.p_confirmed_price).toBe(225);
  });

  test("auth/policy TOCTOU before enqueue creates no direct intent", async () => {
    authorizeError = { message: "authority_epoch_stale" };
    const result = await closeDeal(capability(), { booking_id: "booking-1" });

    expect(result.status).toBe("pending_approval");
    expect(rpcCalls.filter((call) => call.name === "authorize_booking_intent")).toHaveLength(1);
    expect(inserted.some((entry) => entry.table === "action_intents")).toBe(false);
  });

  test("close fails closed when the current rule has no private server floor", async () => {
    activeRules = [{ ...RULES[0], structured: { service_type: "drain_cleaning", price_target: 225 } }];
    invalidateTenant("rocha-plumbing");
    const result = await closeDeal(capability(), { booking_id: "booking-1" });
    expect(result.status).toBe("pending_approval");
    expect(rpcCalls.some((call) => call.name === "authorize_booking_intent")).toBe(false);
  });
});
