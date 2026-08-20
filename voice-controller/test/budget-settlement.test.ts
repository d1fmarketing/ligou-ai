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

function client() {
  return {
    from(table: string) {
      const api: any = {
        select() { return api; }, eq() { return api; },
        insert() { return api; }, update() { return api; },
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
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});

afterEach(() => {
  config.openaiKey = originalOpenAiKey;
  config.estCostPerSessionUsd = originalEstimate;
  globalThis.fetch = originalFetch;
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

  test("settles exactly once when every Realtime model fails", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async () => new Response("unavailable", { status: 502 });

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "realtime_unavailable",
      status: 502,
    });

    const settlements = rpcCalls.filter((call) => call.name === "settle_call_budget");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.args.p_outcome).toBe("startup_error");
  });
});
