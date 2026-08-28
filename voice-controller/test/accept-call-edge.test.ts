import { expect, test } from "bun:test";
import { persistPhoneEvent } from "../../supabase/functions/_shared/accept-call.ts";
import { makeCapability } from "../src/tools.ts";
import * as serverModule from "../src/server.ts";

const row = { openai_call_id: "call-1", called_number: "+19495550100", caller_number_hash: "a".repeat(64), sip_headers: {} };
const applicationOpeningPayload = {
  version: 1,
  item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
  text: "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?",
  text_sha256: "413f79d3d184ea3985fdb593f99ac331c612c157e871034df0135f06a7817e06",
  audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
  audio_sha256: "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
  mime: "audio/mpeg",
  voice: "ash",
  tts_model: "tts-1",
  cost_usd: 0.001605,
};

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
      let mutation: "insert" | "update" | null = null;
      let lastPatch: Record<string, unknown> | null = null;
      const api: any = {
        insert() {
          mutation = "insert";
          return api;
        },
        select() {
          return api;
        },
        single: async () => mutation === "insert"
          ? { data: { id: "direct-request-error" }, error: null }
          : lastPatch?.call_id && !lastPatch.status
            ? { data: {
                id: "direct-request-error",
                status: "processing",
                call_id: lastPatch.call_id,
              }, error: null }
            : { data: { id: "direct-request-error" }, error: null },
        update(patch: Record<string, unknown>) {
          mutation = "update";
          lastPatch = patch;
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
        openingModeRequested: "application_tts_v1",
      },
      {
        client,
        nowIso: () => "2026-08-25T12:00:00.000Z",
        callIdFactory: () => "33333333-3333-4333-8333-333333333339",
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
      patch: { call_id: "33333333-3333-4333-8333-333333333339" },
      filters: { id: "direct-request-error", status: "processing" },
    },
    {
      patch: { status: "error", error: "provider startup failed" },
      filters: { id: "direct-request-error", status: "processing" },
    },
  ]);
});

test("direct onboarding rejects non-durable ready proof and cancels the created live session once", async () => {
  const startDirectSessionRequest = (serverModule as any)
    .startDirectSessionRequest;
  const scenarios = [
    { name: "zero rows", result: { data: null, error: null } },
    {
      name: "wrong id",
      result: { data: { id: "wrong-request" }, error: null },
    },
    {
      name: "status mismatch",
      result: { data: null, error: { message: "no rows" } },
    },
  ];

  for (const scenario of scenarios) {
    const updates: Array<{
      patch: Record<string, unknown>;
      filters: Record<string, unknown>;
    }> = [];
    let mutation: "insert" | "bind" | "ready" | "error" | null = null;
    const client = {
      from() {
        const filters: Record<string, unknown> = {};
        const api: any = {
          insert() {
            mutation = "insert";
            return api;
          },
          select() {
            return api;
          },
          single: async () => mutation === "insert"
            ? { data: { id: "direct-request-proof" }, error: null }
            : mutation === "bind"
              ? { data: {
                  id: "direct-request-proof",
                  status: "processing",
                  call_id: "33333333-3333-4333-8333-333333333339",
                }, error: null }
              : scenario.result,
          update(patch: Record<string, unknown>) {
            mutation = patch.call_id && !patch.status
              ? "bind"
              : patch.status === "ready" ? "ready" : "error";
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
    const cancellations: Array<{ callId: string; reason: string }> = [];

    await expect(
      startDirectSessionRequest(
        {
          userId: "owner-a",
          sessionType: "onboarding",
          sdpOffer: "offer-sdp",
          openingModeRequested: "application_tts_v1",
        },
        {
          client,
          nowIso: () => "2026-08-25T12:00:00.000Z",
          callIdFactory: () => "33333333-3333-4333-8333-333333333339",
          resolveSessionTenantImpl: async () => ({
            tenant: {
              id: "22222222-2222-4222-8222-222222222222",
            },
            rules: [],
          }),
          startSessionImpl: async (...args: unknown[]) => {
            const registerCleanup = args[5] as (
              control: { cancel(reason: string): Promise<void> },
            ) => void;
            registerCleanup({
              callId: "33333333-3333-4333-8333-333333333339",
              cancel: async (reason: string) => {
                cancellations.push({ callId: "call-proof", reason });
              },
            });
            return {
              sdp: "must-not-return",
              call_id: "33333333-3333-4333-8333-333333333339",
              opening_mode_applied: "application_tts_v1",
              opening_payload: applicationOpeningPayload,
            } as any;
          },
        },
      ),
    ).rejects.toThrow("direct_onboarding_request_ready_failed");

    expect(cancellations, scenario.name).toEqual([
      {
        callId: "call-proof",
        reason: "direct_onboarding_request_ready_failed",
      },
    ]);
    expect(updates[0], scenario.name).toEqual({
      patch: { call_id: "33333333-3333-4333-8333-333333333339" },
      filters: { id: "direct-request-proof", status: "processing" },
    });
    expect(updates[1], scenario.name).toEqual({
      patch: {
        status: "ready",
        answer_sdp: "must-not-return",
        call_id: "33333333-3333-4333-8333-333333333339",
        opening_mode_applied: "application_tts_v1",
        opening_payload: applicationOpeningPayload,
      },
      filters: { id: "direct-request-proof", status: "processing" },
    });
    expect(updates[2], scenario.name).toEqual({
      patch: {
        status: "error",
        error: "direct_onboarding_request_ready_failed",
      },
      filters: { id: "direct-request-proof", status: "processing" },
    });
  }
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
