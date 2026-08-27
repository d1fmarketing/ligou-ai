import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

type EdgeHandler = (request: Request) => Response | Promise<Response>;

const originalDeno = (globalThis as any).Deno;
const originalFetch = globalThis.fetch;
let registeredHandler: EdgeHandler | null = null;
let fromCalls: string[] = [];
let rpcCalls: string[] = [];
let authFetches: string[] = [];
let activeClient: any;

const forbiddenEffectClient = {
  from(table: string) {
    fromCalls.push(table);
    throw new Error(`unexpected_supabase_from:${table}`);
  },
  rpc(name: string) {
    rpcCalls.push(name);
    throw new Error(`unexpected_supabase_rpc:${name}`);
  },
};

function readySessionClient(insertedRows: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      fromCalls.push(table);
      let selected = "";
      let inserted: Record<string, unknown> | null = null;
      const api: any = {
        select(columns: string) { selected = columns; return api; },
        eq() { return api; },
        order() { return api; },
        insert(row: Record<string, unknown>) {
          inserted = row;
          insertedRows.push(row);
          return api;
        },
        limit: async () => ({
          data: [{
            id: "tenant-rollback-bridge",
            slug: "rocha-plumbing",
            owner_user_id: "owner-rollback-bridge",
          }],
          error: null,
        }),
        single: async () => {
          if (table === "browser_session_requests" && inserted) {
            return { data: { id: "request-rollback-bridge" }, error: null };
          }
          if (table === "browser_session_requests" && selected.includes("status")) {
            return {
              data: {
                status: "ready",
                answer_sdp: "synthetic-answer-sdp",
                call_id: "call-rollback-bridge",
                error: null,
              },
              error: null,
            };
          }
          if (table === "calls") return { data: { model: "gpt-realtime-2.1" }, error: null };
          return { data: null, error: null };
        },
      };
      return api;
    },
    rpc(name: string) {
      rpcCalls.push(name);
      throw new Error(`unexpected_supabase_rpc:${name}`);
    },
  };
}

const mockedSupabase = () => ({
  createClient: () => activeClient,
});
mock.module("@supabase/supabase-js", mockedSupabase);
mock.module(
  new URL("../../node_modules/@supabase/supabase-js/dist/index.mjs", import.meta.url).href,
  mockedSupabase,
);

beforeAll(async () => {
  (globalThis as any).Deno = {
    env: {
      get(name: string) {
        if (name === "SUPABASE_URL") return "https://rollback-bridge.invalid";
        if (name === "SERVICE_KEY") return "synthetic-service-key";
        if (name === "LIGOU_TENANT") return "rocha-plumbing";
        return undefined;
      },
    },
    serve(handler: EdgeHandler) {
      registeredHandler = handler;
      return { shutdown() {} };
    },
  };
  await import("../../supabase/functions/browser-session/index.ts");
  if (!registeredHandler) throw new Error("browser_session_handler_not_registered");
});

beforeEach(() => {
  fromCalls = [];
  rpcCalls = [];
  authFetches = [];
  activeClient = forbiddenEffectClient;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    authFetches.push(String(input));
    return Response.json({ id: "owner-rollback-bridge" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  (globalThis as any).Deno = originalDeno;
  mock.restore();
});

function request(body: Record<string, unknown>, authorization = "Bearer synthetic-owner-jwt") {
  return new Request("https://rollback-bridge.invalid/functions/v1/browser-session", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("browser-session rollback bridge", () => {
  test("an authenticated valid onboarding request is refused before tenant lookup, request insert, or RPC", async () => {
    const response = await registeredHandler!(request({
      sdp: "synthetic-offer-sdp",
      session_type: "onboarding",
    }));

    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 503,
      body: { error: "onboarding_disabled_rollback_bridge" },
    });
    expect(authFetches).toEqual(["https://rollback-bridge.invalid/auth/v1/user"]);
    expect(fromCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  test("body validation remains ahead of the temporary onboarding refusal", async () => {
    const response = await registeredHandler!(request({ session_type: "onboarding" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "sdp_required" });
    expect(fromCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  test("authentication remains ahead of the temporary onboarding refusal", async () => {
    const response = await registeredHandler!(request({
      sdp: "synthetic-offer-sdp",
      session_type: "onboarding",
    }, "invalid"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(authFetches).toEqual([]);
    expect(fromCalls).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  test("customer and owner-browser requests still traverse ownership, queueing, and ready-session delivery", async () => {
    for (const sessionType of ["customer", "owner_browser"] as const) {
      const insertedRows: Array<Record<string, unknown>> = [];
      fromCalls = [];
      rpcCalls = [];
      activeClient = readySessionClient(insertedRows);

      const response = await registeredHandler!(request({
        sdp: `synthetic-${sessionType}-offer`,
        session_type: sessionType,
      }));

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: {
          sdp: "synthetic-answer-sdp",
          call_id: "call-rollback-bridge",
          max_minutes: 15,
          model: "gpt-realtime-2.1",
        },
      });
      expect(insertedRows).toEqual([expect.objectContaining({
        tenant_id: "tenant-rollback-bridge",
        user_id: "owner-rollback-bridge",
        session_type: sessionType,
        offer_sdp: `synthetic-${sessionType}-offer`,
      })]);
      expect(fromCalls).toContain("browser_session_requests");
      expect(fromCalls).toContain("calls");
      expect(rpcCalls).toEqual([]);
    }
  });
});
