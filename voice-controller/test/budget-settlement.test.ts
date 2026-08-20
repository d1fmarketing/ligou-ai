import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { startSession } from "../src/server.ts";

const TENANT = {
  id: "tenant-1", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "owner-1", auth_epoch: 2, policy_epoch: 3,
};

let reserveError: { message: string } | null = null;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const originalOpenAiKey = config.openaiKey;
const originalEstimate = config.estCostPerSessionUsd;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let fetchUrls: string[] = [];
let callUpdates: any[] = [];
let budgetUpdates: any[] = [];

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; },
        insert() { return api; },
        update(row: any) {
          if (table === "calls") callUpdates.push(row);
          if (table === "budget_reservations") budgetUpdates.push(row);
          return api;
        },
        single: async () => table === "tenants"
          ? { data: TENANT, error: null }
          : table === "calls"
            ? { data: { id: "call-1" }, error: null }
            : { data: null, error: null },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: table === "effective_rules" ? [] : null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "reserve_call_budget") {
        return Promise.resolve({ data: reserveError ? null : "reservation-1", error: reserveError });
      }
      if (name === "settle_call_budget") {
        return Promise.resolve({ data: "reservation-1", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  reserveError = null;
  rpcCalls = [];
  config.openaiKey = originalOpenAiKey;
  config.estCostPerSessionUsd = originalEstimate;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  fetchUrls = [];
  callUpdates = [];
  budgetUpdates = [];
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});

afterEach(() => {
  config.openaiKey = originalOpenAiKey;
  config.estCostPerSessionUsd = originalEstimate;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

afterAll(() => _setClient(null));

describe("session budget lifecycle", () => {
  test("reserves the configured EST_COST_PER_SESSION value", async () => {
    config.estCostPerSessionUsd = 2.75;
    reserveError = { message: "budget cap" };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "budget_exceeded",
      status: 402,
    });

    const reservation = rpcCalls.find((call) => call.name === "reserve_call_budget");
    expect(reservation?.args.p_est_cost).toBe(2.75);
  });

  test("settles a reservation when startup cannot obtain an OpenAI session", async () => {
    config.openaiKey = "";

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "openai_key_missing",
      status: 503,
    });

    const settlements = rpcCalls.filter((call) => call.name === "settle_call_budget");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.args).toMatchObject({
      p_tenant: TENANT.id,
      p_call: "call-1",
      p_actual_cost: 0,
      p_minutes: 0,
      p_outcome: "startup_error",
    });
  });

  const assertUnknownProviderRemainsDiscoverable = () => {
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(callUpdates.some((row) => row.status === "error" && row.provider_termination_state === "unknown")).toBe(true);
    expect(budgetUpdates.some((row) => row.reconcile_lease_until === null && row.reconcile_last_error)).toBe(true);
  };

  test("first transport exception stops fallback and leaves the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new Error("provider transport unknown");
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(fetchUrls).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("2xx without Location stops fallback and leaves the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("answer-without-id", { status: 200 })
        : new Response("definitive fallback rejection", { status: 400 });
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(fetchUrls).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("ambiguous 5xx stops fallback and leaves the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("provider internal error", { status: 503 })
        : new Response("definitive fallback rejection", { status: 400 });
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(fetchUrls).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("definitive 4xx can fall back and tracks only the successful call", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("unsupported model", { status: 400 })
        : new Response("fallback-answer", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-fallback" } });
    };
    globalThis.WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    } as any;

    const result = await startSession("owner-1", "owner_browser", "test-sdp");

    expect(fetchUrls).toHaveLength(2);
    expect(result.fell_back).toBe(true);
    expect(callUpdates.some((row) => row.openai_call_id === "rtc-fallback" && row.provider_termination_state === "active")).toBe(true);
    expect(callUpdates.some((row) => row.provider_termination_state === "unknown")).toBe(false);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("accepted browser call attach failure confirms hangup before zero settlement", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) {
        return new Response("answer-sdp", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-1" } });
      }
      return new Response(null, { status: 200 });
    };
    globalThis.WebSocket = class { constructor() { throw new Error("sideband attach failed"); } } as any;

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toThrow("sideband attach failed");

    expect(fetchUrls.some((url) => url.endsWith("/rtc-1/hangup"))).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
  });

  test("browser hangup transport failure keeps the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) {
        return new Response("answer-sdp", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-1" } });
      }
      throw new Error("hangup transport unknown");
    };
    globalThis.WebSocket = class { constructor() { throw new Error("sideband attach failed"); } } as any;

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toThrow("sideband attach failed");

    expect(fetchUrls.some((url) => url.endsWith("/rtc-1/hangup"))).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });
});
