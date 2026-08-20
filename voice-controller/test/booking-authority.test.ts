import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { proposeBooking } from "../src/booking.ts";
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
const POWERS = [{
  id: "power-1", resource: "drain_cleaning", monetary_limit: 225, expires_at: null,
  conditions: {
    geography: ["Irvine"],
    allowed_hours: { days: ["mon", "tue", "wed", "thu", "fri", "sat"], start: "08:00", end: "18:00" },
    channel: ["voice"], purpose: ["booking"],
  },
}];

let inserted: Array<{ table: string; row: any }> = [];

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; }, is() { return api; },
        upsert(row: any) { inserted.push({ table, row }); return api; },
        single: async () => {
          if (table === "tenants") return { data: TENANT, error: null };
          if (table === "bookings") return { data: { id: "booking-1", status: "proposed" }, error: null };
          if (table === "approval_cases") return { data: { id: "case-1" }, error: null };
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "effective_rules" ? RULES : table === "powers" ? POWERS : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
  } as any;
}

beforeEach(() => {
  inserted = [];
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});
afterAll(() => _setClient(null));

const capability = () => makeCapability("rocha-plumbing", TENANT.id, "call-1", 15, "customer", {
  authEpoch: TENANT.auth_epoch,
  policyEpoch: TENANT.policy_epoch,
});

describe("booking passes the complete power context", () => {
  test("missing service city fails closed when the grant is geographic", async () => {
    const result = await proposeBooking(capability(), {
      service_type: "drain_cleaning",
      slot_start: "2026-08-21T17:00:00Z",
      price: 225,
    });

    expect(result.status).toBe("pending_approval");
    expect(result.reason).toBe("geography_required");
  });

  test("stores the normalized authority context used by a matching grant", async () => {
    const result = await proposeBooking(capability(), {
      service_type: "drain_cleaning",
      slot_start: "2026-08-21T17:00:00Z",
      price: 225,
      service_city: "  IRVINE ",
    });

    expect(result.status).toBe("proposed");
    const booking = inserted.find((entry) => entry.table === "bookings")?.row;
    expect(booking.authority_context).toEqual({
      geography: "irvine",
      channel: "voice",
      purpose: "booking",
      appointment_at: "2026-08-21T17:00:00.000Z",
    });
  });
});
