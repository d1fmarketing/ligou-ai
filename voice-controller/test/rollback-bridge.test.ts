import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as server from "../src/server.ts";
import * as configModule from "../src/config.ts";
import { liveSessions } from "../src/sideband.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";

const BRIDGE_BASE = "6f65667b428fa0f3f7e3df31534746e120553b10";
const TENANT = {
  id: "tenant-rollback-bridge",
  slug: "rocha-plumbing",
  name: "Rocha Plumbing",
  vertical: "plumbing",
  languages: ["en", "es"],
  timezone: "America/Los_Angeles",
  session_max_minutes: 15,
  owner_user_id: "owner-rollback-bridge",
  auth_epoch: 2,
  policy_epoch: 3,
  status: "active",
  operational_mode: "live",
};

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalOpenAiKey = configModule.config.openaiKey;

let tableEffects: Array<{ table: string; operation: string; value?: unknown }> = [];
let rpcEffects: Array<{ name: string; args: Record<string, unknown> }> = [];
let fetchEffects: string[] = [];
let webSocketConstructions = 0;

function effectCapableClient() {
  return {
    from(table: string) {
      tableEffects.push({ table, operation: "from" });
      const api: any = {
        select() { tableEffects.push({ table, operation: "select" }); return api; },
        eq() { return api; },
        insert(value: unknown) { tableEffects.push({ table, operation: "insert", value }); return api; },
        update(value: unknown) { tableEffects.push({ table, operation: "update", value }); return api; },
        single: async () => {
          if (table === "tenants") return { data: { ...TENANT }, error: null };
          if (table === "calls") return { data: { id: "call-rollback-bridge" }, error: null };
          return { data: null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "effective_rules" ? [] : null;
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcEffects.push({ name, args });
      if (name === "reserve_call_budget") {
        return Promise.resolve({ data: "reservation-rollback-bridge", error: null });
      }
      if (name === "begin_provider_termination_attempt") {
        return Promise.resolve({
          data: {
            should_attempt: true,
            attempt_id: "91000000-0000-4000-8000-000000000001",
            request_id: "91000000-0000-4000-8000-000000000001",
            openai_call_id: args.p_openai_call_id,
            provider_termination_mode: args.p_mode,
          },
          error: null,
        });
      }
      if (name === "complete_provider_termination_attempt") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "settle_call_budget") {
        return Promise.resolve({ data: "reservation-rollback-bridge", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  tableEffects = [];
  rpcEffects = [];
  fetchEffects = [];
  webSocketConstructions = 0;
  invalidateTenant(TENANT.slug);
  _setClient(effectCapableClient());
  configModule.config.openaiKey = "synthetic-openai-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchEffects.push(String(input));
    return fetchEffects.length === 1
      ? new Response("answer-sdp", {
          status: 200,
          headers: { Location: "/v1/realtime/calls/rtc-rollback-bridge" },
        })
      : new Response(null, { status: 200 });
  }) as typeof fetch;
  globalThis.WebSocket = class {
    constructor() {
      webSocketConstructions += 1;
      throw new Error("unexpected_websocket_construction");
    }
  } as any;
});

afterEach(() => {
  configModule.config.openaiKey = originalOpenAiKey;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  liveSessions.delete("call-rollback-bridge");
  invalidateTenant(TENANT.slug);
  _setClient(null);
});

describe("onboarding rollback bridge", () => {
  test("startSession refuses onboarding before every Supabase, provider, socket, call, budget, or live-session effect", async () => {
    const liveBefore = [...liveSessions.keys()];

    const error = await server.startSession(
      TENANT.owner_user_id,
      "onboarding",
      "synthetic-offer-sdp",
    ).then(() => null, (caught) => caught);

    expect(error).toMatchObject({
      message: "onboarding_disabled_rollback_bridge",
      status: 503,
    });
    expect(tableEffects).toEqual([]);
    expect(rpcEffects).toEqual([]);
    expect(fetchEffects).toEqual([]);
    expect(webSocketConstructions).toBe(0);
    expect([...liveSessions.keys()]).toEqual(liveBefore);
  });

  test("controller health identifies the rollback bridge and its exact live-release base", () => {
    const healthBuilder = (server as Record<string, unknown>).controllerHealthPayload;
    expect(typeof healthBuilder).toBe("function");
    if (typeof healthBuilder !== "function") return;

    expect(healthBuilder()).toMatchObject({
      ok: true,
      onboarding_acceptance: "disabled_rollback_bridge",
      rollback_bridge_base: BRIDGE_BASE,
    });
  });
});
