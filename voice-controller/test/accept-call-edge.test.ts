import { expect, test } from "bun:test";
import { persistPhoneEvent } from "../../supabase/functions/_shared/accept-call.ts";
import { makeCapability } from "../src/tools.ts";
import * as serverModule from "../src/server.ts";

const row = { openai_call_id: "call-1", called_number: "+19495550100", caller_number_hash: "a".repeat(64), sip_headers: {} };

test("accept-call returns retryable non-2xx when persistence fails", async () => {
  const client = {
    from() {
      return { async upsert() { return { error: { message: "database unavailable" } }; } };
    },
  };
  const response = await persistPhoneEvent(client as any, row);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "phone_event_persistence_failed" });
});

test("accept-call acknowledges only after durable persistence", async () => {
  const client = {
    from() {
      return { async upsert() { return { error: null }; } };
    },
  };
  const response = await persistPhoneEvent(client as any, row);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true });
});

test("phone/customer capabilities retain their session type without an authenticated browser owner", () => {
  const capability = makeCapability(
    "rocha-plumbing",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    15,
    "customer",
    { authEpoch: 1, policyEpoch: 1 },
  );
  expect(capability.sessionType).toBe("customer");
  expect(capability.ownerUserId).toBeUndefined();
});

test("direct onboarding marks its exact proof row error when session startup fails", async () => {
  const startDirectSessionRequest = (serverModule as any)
    .startDirectSessionRequest;
  expect(startDirectSessionRequest).toBeFunction();
  const updates: Array<{
    patch: Record<string, unknown>;
    filters: Record<string, unknown>;
  }> = [];
  const client = {
    from() {
      const filters: Record<string, unknown> = {};
      const api: any = {
        insert() {
          return api;
        },
        select() {
          return api;
        },
        single: async () => ({
          data: { id: "direct-request-error" },
          error: null,
        }),
        update(patch: Record<string, unknown>) {
          updates.push({ patch, filters });
          return api;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return api;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
  };

  await expect(
    startDirectSessionRequest(
      {
        userId: "owner-a",
        sessionType: "onboarding",
        sdpOffer: "offer-sdp",
      },
      {
        client,
        nowIso: () => "2026-08-25T12:00:00.000Z",
        resolveSessionTenantImpl: async () => ({
          tenant: {
            id: "22222222-2222-4222-8222-222222222222",
          },
          rules: [],
        }),
        startSessionImpl: async () => {
          throw new Error("provider startup failed");
        },
      },
    ),
  ).rejects.toThrow("provider startup failed");
  expect(updates).toEqual([
    {
      patch: { status: "error", error: "provider startup failed" },
      filters: { id: "direct-request-error" },
    },
  ]);
});

test("direct customer sessions retain the existing path without request-proof writes", async () => {
  const startDirectSessionRequest = (serverModule as any)
    .startDirectSessionRequest;
  expect(startDirectSessionRequest).toBeFunction();
  const starts: unknown[][] = [];
  const result = await startDirectSessionRequest(
    {
      userId: "owner-a",
      sessionType: "customer",
      sdpOffer: "customer-offer",
      modelOverride: undefined,
    },
    {
      client: {
        from() {
          throw new Error("customer path must not write request proof");
        },
      },
      resolveSessionTenantImpl: async () => {
        throw new Error("customer path must preserve startSession resolution");
      },
      startSessionImpl: async (...args: unknown[]) => {
        starts.push(args);
        return { sdp: "customer-answer", call_id: "call-customer" };
      },
    },
  );
  expect(result).toEqual({
    sdp: "customer-answer",
    call_id: "call-customer",
  });
  expect(starts).toEqual([
    ["owner-a", "customer", "customer-offer", undefined],
  ]);
});
