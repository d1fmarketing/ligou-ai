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
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalEstimate = config.estCostPerSessionUsd;

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; }, lt() { return api; }, limit() { return api; },
        update() { return api; },
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

  test("uses the configured estimate and settles only after reject is confirmed", async () => {
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
    const settlement = rpcCalls.find((call) => call.name === "settle_call_budget");
    expect(settlement?.args).toMatchObject({ p_call: "call-1", p_outcome: "startup_error", p_actual_cost: 0 });
  });

  test("accepted-call attach failure hangs up before zero settlement", async () => {
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response(null, { status: 200 });
    };
    globalThis.WebSocket = class {
      constructor() { throw new Error("websocket unavailable"); }
    } as any;

    await expect(handleIncoming(row)).rejects.toThrow("websocket unavailable");

    expect(fetchUrls.some((url) => url.endsWith("/hangup"))).toBe(true);
    const settlements = rpcCalls.filter((call) => call.name === "settle_call_budget");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.args.p_outcome).toBe("startup_error");
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

  test("accept transport unknown confirms reject before settlement", async () => {
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) throw new Error("accept transport unknown");
      return new Response(null, { status: 200 });
    };

    await expect(handleIncoming(row)).rejects.toThrow("accept transport unknown");

    expect(fetchUrls.some((url) => url.endsWith("/reject"))).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
  });
});
