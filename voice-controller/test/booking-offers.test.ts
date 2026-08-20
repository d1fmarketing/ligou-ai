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
  conditions: { geography: ["Irvine"], channel: ["voice"], purpose: ["booking"] },
}];

let consumeError: string | null = null;
let rpcCalls: Array<{ name: string; args: any }> = [];

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; }, is() { return api; },
        single: async () => table === "tenants"
          ? { data: TENANT, error: null }
          : { data: null, error: null },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "effective_rules" ? RULES : table === "powers" ? POWERS : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (name === "consume_slot_offer") {
        return Promise.resolve(consumeError
          ? { data: null, error: { message: consumeError } }
          : { data: {
            booking_id: "booking-1", service_type: "drain_cleaning", public_price: 180,
            slot_start: "2026-08-21T17:00:00.000Z", slot_end: "2026-08-21T18:00:00.000Z",
            geography: "irvine",
          }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  consumeError = null;
  rpcCalls = [];
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});
afterAll(() => _setClient(null));

const capability = (tenantId = TENANT.id, callId = "call-1") =>
  makeCapability("rocha-plumbing", tenantId, callId, 15, "customer", {
    authEpoch: TENANT.auth_epoch,
    policyEpoch: TENANT.policy_epoch,
  });

describe("booking proposals consume only server-issued offers", () => {
  for (const [label, error] of [
    ["arbitrary", "slot_offer_not_found"],
    ["expired", "slot_offer_expired"],
    ["cross-call", "slot_offer_scope_mismatch"],
    ["cross-tenant", "slot_offer_scope_mismatch"],
    ["policy-stale", "slot_offer_policy_stale"],
    ["consumed", "slot_offer_consumed"],
  ] as const) {
    test(`rejects ${label} offers without creating a proposal`, async () => {
      consumeError = error;
      const result = await proposeBooking(capability(), {
        slot_token: label === "arbitrary" ? "model-invented-token" : `opaque-${label}`,
        client_name: "Customer",
      });

      expect(result.status).toBe("invalid_offer");
      expect(result.error).toBe(error);
    });
  }

  test("passes no model-authored time, service, geography, or price into atomic consumption", async () => {
    const result = await proposeBooking(capability(), {
      slot_token: "opaque-valid-offer",
      slot_start: "2099-01-01T00:00:00Z",
      slot_end: "2099-01-01T01:00:00Z",
      service_type: "attacker_service",
      service_city: "attacker_city",
      price: 1,
      client_name: "Customer",
      contact: "+15555550100",
    });

    expect(result).toMatchObject({ status: "proposed", booking_id: "booking-1" });
    const call = rpcCalls.find((entry) => entry.name === "consume_slot_offer")!;
    expect(call.args).toEqual({
      p_tenant: TENANT.id,
      p_call: "call-1",
      p_token_hash: expect.any(String),
      p_expected_auth_epoch: TENANT.auth_epoch,
      p_expected_policy_epoch: TENANT.policy_epoch,
      p_client_name: "Customer",
      p_contact: "+15555550100",
    });
    expect(call.args.p_token_hash).toHaveLength(64);
  });
});
