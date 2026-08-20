import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { handleIncoming } from "../src/phone.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";

const TENANT = {
  id: "tenant-1", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "owner-1", auth_epoch: 2, policy_epoch: 3,
};

let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let ownerUserId: string | null = "owner-1";
let callInserts = 0;
let fetchUrls: string[] = [];
let callUpdates: any[] = [];
let budgetUpdates: any[] = [];
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalEstimate = config.estCostPerSessionUsd;

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; }, lt() { return api; }, limit() { return api; },
        update(row: any) {
          if (table === "calls") callUpdates.push(row);
          if (table === "budget_reservations") budgetUpdates.push(row);
          return api;
        },
        insert() { if (table === "calls") callInserts += 1; return api; },
        single: async () => table === "tenants"
          ? { data: { ...TENANT, owner_user_id: ownerUserId }, error: null }
          : table === "calls"
            ? { data: { id: "call-1" }, error: null }
            : { data: null, error: null },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "phone_events" ? [{ id: "event-1" }] : table === "effective_rules" ? [] : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "reserve_call_budget" && !ownerUserId) {
        return Promise.resolve({ data: null, error: { message: "must not reserve" } });
      }
      return Promise.resolve({ data: "reservation-1", error: null });
    },
  } as any;
}

beforeEach(() => {
  rpcCalls = [];
  ownerUserId = "owner-1";
  callInserts = 0;
  fetchUrls = [];
  callUpdates = [];
  budgetUpdates = [];
  config.estCostPerSessionUsd = originalEstimate;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});

afterEach(() => {
  config.estCostPerSessionUsd = originalEstimate;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});
afterAll(() => _setClient(null));

const row = { id: "event-1", openai_call_id: "rtc-1" };

describe("phone startup budget lifecycle", () => {
  const expectUsageUnresolved = () => {
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(callUpdates.some((row) => row.provider_usage_state === "unknown" && row.cost_estimate_usd === null)).toBe(true);
    expect(budgetUpdates.some((row) => String(row.reconcile_last_error).includes("provider_usage_unresolved"))).toBe(true);
  };

  test("an unprovisioned tenant is rejected before call creation or reservation", async () => {
    ownerUserId = null;
    globalThis.fetch = async () => new Response(null, { status: 200 });

    await expect(handleIncoming(row)).rejects.toMatchObject({
      message: "tenant_provisioning_required",
      status: 409,
    });

    expect(callInserts).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  test("ambiguous accept failure confirms reject but keeps usage unresolved", async () => {
    config.estCostPerSessionUsd = 2.25;
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("accept failed", { status: 502 })
        : new Response(null, { status: 200 });
    };

    await expect(handleIncoming(row)).rejects.toThrow("accept_failed");

    expect(rpcCalls.find((call) => call.name === "reserve_call_budget")?.args.p_est_cost).toBe(2.25);
    expect(fetchUrls.some((url) => url.endsWith("/reject"))).toBe(true);
    expectUsageUnresolved();
  });

  test("a definitive phone 4xx rejection resolves authoritative zero usage", async () => {
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("definitively rejected", { status: 400 })
        : new Response(null, { status: 200 });
    };

    await expect(handleIncoming(row)).rejects.toThrow("accept_failed");

    expect(fetchUrls.some((url) => url.endsWith("/reject"))).toBe(true);
    expect(callUpdates.some((update) => update.provider_usage_state === "resolved"
      && update.cost_estimate_usd === 0)).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
  });

  test("accepted-call attach failure hangs up but keeps usage unresolved", async () => {
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response(null, { status: 200 });
    };
    globalThis.WebSocket = class {
      constructor() { throw new Error("websocket unavailable"); }
    } as any;

    await expect(handleIncoming(row)).rejects.toThrow("websocket unavailable");

    expect(fetchUrls.some((url) => url.endsWith("/hangup"))).toBe(true);
    expectUsageUnresolved();
  });

  test("termination transport failure leaves the reservation active", async () => {
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) return new Response(null, { status: 200 });
      throw new Error("termination transport unknown");
    };
    globalThis.WebSocket = class {
      constructor() { throw new Error("websocket unavailable"); }
    } as any;

    await expect(handleIncoming(row)).rejects.toThrow("websocket unavailable");

    expect(fetchUrls.some((url) => url.endsWith("/hangup"))).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("accept transport unknown confirms reject but keeps usage unresolved", async () => {
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) throw new Error("accept transport unknown");
      return new Response(null, { status: 200 });
    };

    await expect(handleIncoming(row)).rejects.toThrow("accept transport unknown");

    expect(fetchUrls.some((url) => url.endsWith("/reject"))).toBe(true);
    expectUsageUnresolved();
  });
});
