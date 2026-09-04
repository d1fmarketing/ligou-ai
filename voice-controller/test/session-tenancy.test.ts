// M2 tenancy: sessions resolve the AUTHENTICATED OWNER's own tenant. The queue row
// carries tenant_id end to end; the env slug remains only as the legacy fallback.
import { describe, expect, test, beforeEach } from "bun:test";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { resolveSessionTenant } from "../src/session-tenant.ts";
import { _handleBrowserRequest } from "../src/browser-requests.ts";
import * as browserRequestsModule from "../src/browser-requests.ts";
import { resolveOwnedTenantForSession } from "../../supabase/functions/_shared/owned-tenant.ts";
import { makeBrowserSessionCapability } from "../src/server.ts";
import * as serverModule from "../src/server.ts";
import {
  onboardingOpeningText,
  openingPayloadIsInternallyValid,
} from "../src/onboarding-greeting.ts";

const V02_TENANT = {
  id: "22222222-2222-4222-8222-222222222222", slug: "ligou-22222222", name: "D1f Marketing", vertical: null,
  languages: ["pt", "en"], timezone: "America/Los_Angeles", session_max_minutes: 15, owner_user_id: "owner-a",
  auth_epoch: 1, policy_epoch: 1, status: "onboarding", operational_mode: "simulation_only",
};
const LEGACY_TENANT = {
  id: "11111111-1111-4111-8111-111111111111", slug: "rocha-plumbing", name: "Rocha Plumbing LLC", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15, owner_user_id: "owner-legacy",
  auth_epoch: 1, policy_epoch: 1, status: "active", operational_mode: "live",
};
const APPLICATION_OPENING_PAYLOAD = {
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
const APPLICATION_OPENING_PAYLOAD_V2 = {
  version: 2,
  item_id: "lgo-b00cbaf9911210b676ace0d7dda5",
  text:
    "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Vamos continuar de onde paramos. Quais cidades e regiões sua empresa atende?",
  text_sha256:
    "643ca15a2dbc57364f4eca5ae9e846674df997f7837b42873c9998ed2ff5bbf3",
  audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
  audio_sha256:
    "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
  mime: "audio/mpeg",
  voice: "ash",
  tts_model: "tts-1-hd",
  cost_usd: 0.00444,
  resume_context: {
    coverage_receipt_id: "44444444-4444-4444-8444-444444444444",
    revision: 1,
    snapshot_digest: "c".repeat(64),
    next_action: {
      type: "ask",
      field: "area.coverage",
      question_pt: "Quais cidades e regiões sua empresa atende?",
    },
  },
};

function tenantClient() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const api: any = {
        select() { return api; },
        eq(column: string, value: unknown) { filters[column] = value; return api; },
        single: async () => {
          if (table !== "tenants") return { data: null, error: { message: `unexpected table ${table}` } };
          if (filters.id === V02_TENANT.id) return { data: { ...V02_TENANT }, error: null };
          if (filters.slug === LEGACY_TENANT.slug) return { data: { ...LEGACY_TENANT }, error: null };
          return { data: null, error: { message: "not found" } };
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: table === "effective_rules" ? [] : [], error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc: async () => ({ data: null, error: { message: "unexpected rpc" } }),
  };
}

beforeEach(() => {
  (browserRequestsModule as any)._resetBrowserLiveControlsForTests?.();
  _setClient(tenantClient() as any);
  invalidateTenant(V02_TENANT.slug);
  invalidateTenant(LEGACY_TENANT.slug);
});

describe("resolveSessionTenant", () => {
  test("a queue tenant_id resolves that tenant for its owner", async () => {
    const { tenant } = await resolveSessionTenant("owner-a", V02_TENANT.id);
    expect(tenant.id).toBe(V02_TENANT.id);
    expect(tenant.slug).toBe("ligou-22222222");
  });

  test("a queue tenant_id owned by someone else fails closed as not_tenant_owner", async () => {
    await expect(resolveSessionTenant("intruder", V02_TENANT.id)).rejects.toThrow(/not_tenant_owner/);
  });

  test("an unknown tenant id fails closed", async () => {
    await expect(resolveSessionTenant("owner-a", "33333333-3333-4333-8333-333333333333")).rejects.toThrow(/tenant_not_found/);
  });

  test("without a tenant id the legacy env slug still works for its own owner", async () => {
    const { tenant } = await resolveSessionTenant("owner-legacy", undefined);
    expect(tenant.slug).toBe("rocha-plumbing");
  });

  test("without a tenant id a non-owner of the legacy tenant is still refused", async () => {
    await expect(resolveSessionTenant("owner-a", undefined)).rejects.toThrow(/not_tenant_owner/);
  });
});

describe("browser capability ownership", () => {
  test("website-first opening starts directly with the persisted discovery context", () => {
    const question = "Eu já analisei seu website e encontrei as informações públicas básicas. Agora vou confirmar o que falta. Qual é o limite de negociação?";
    const opening = onboardingOpeningText("D1F Marketing", {
      coverage_receipt_id: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      snapshot_digest: "c".repeat(64),
      next_action: {
        type: "ask",
        field: "authority.negotiate_floor",
        question_pt: question,
      },
    });
    expect(opening).toBe(
      `Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. ${question}`,
    );
    expect(opening).not.toContain("Vamos continuar de onde paramos");
  });

  test("authenticated owner identity is retained only for owner and onboarding browser sessions", () => {
    for (const sessionType of ["owner_browser", "onboarding"] as const) {
      const cap = makeBrowserSessionCapability({
        tenant: V02_TENANT,
        callId: `call-${sessionType}`,
        userId: "owner-a",
        sessionType,
        maxMinutes: 30,
      });
      expect(cap.sessionType).toBe(sessionType);
      expect(cap.ownerUserId).toBe("owner-a");
    }
    const customer = makeBrowserSessionCapability({
      tenant: V02_TENANT,
      callId: "call-customer",
      userId: "owner-a",
      sessionType: "customer",
      maxMinutes: 15,
    });
    expect(customer.sessionType).toBe("customer");
    expect(customer.ownerUserId).toBeUndefined();
  });
});

describe("browser request handling", () => {
  test("direct onboarding rejects missing or provider opening mode before inserting its proof", async () => {
    const startDirectSessionRequest = (serverModule as any)
      .startDirectSessionRequest;
    let clientTouched = 0;
    const client = {
      from() { clientTouched += 1; throw new Error("must not insert"); },
    };
    for (const openingModeRequested of [
      undefined,
      "provider_model_v1",
    ]) {
      await expect(startDirectSessionRequest(
        {
          userId: "owner-a",
          sessionType: "onboarding",
          sdpOffer: "stale-direct-offer",
          ...(openingModeRequested ? { openingModeRequested } : {}),
        },
        { client },
      )).rejects.toMatchObject({
        message: "client_upgrade_required",
        status: 409,
      });
    }
    expect(clientTouched).toBe(0);
  });

  test("the public direct endpoint guard requires onboarding to use Edge", () => {
    const guard = (serverModule as any).assertPublicDirectSessionAllowed;
    expect(guard).toBeFunction();
    expect(() => guard("onboarding")).toThrow("onboarding_edge_required");
    expect(() => guard("owner_browser")).not.toThrow();
    expect(() => guard("customer")).not.toThrow();
  });

  test("the claimed row's tenant_id reaches startSession", async () => {
    const seen: any[] = [];
    const updates: any[] = [];
    const rowClient = {
      from(table: string) {
        const api: any = {
          update(patch: any) { updates.push({ table, patch }); return api; },
          eq() { return api; },
          select: async () => ({ data: [{ id: "req-1" }], error: null }),
        };
        return api;
      },
    };
    _setClient(rowClient as any);
    await _handleBrowserRequest(
      { id: "req-1", user_id: "owner-a", tenant_id: V02_TENANT.id, session_type: "owner_browser", offer_sdp: "sdp", model_override: null },
      async (...args: any[]) => {
        const [userId, sessionType, sdp, model, tenantId] = args;
        seen.push({ userId, sessionType, sdp, model, tenantId });
        args[5]?.({ callId: "call-1", cancel: async () => {} });
        return {
          sdp: "answer",
          call_id: "call-1",
          opening_mode_applied: "provider_model_v1",
          opening_payload: null,
        };
      },
    );
    expect(seen).toEqual([{ userId: "owner-a", sessionType: "owner_browser", sdp: "sdp", model: undefined, tenantId: V02_TENANT.id }]);
    expect(updates.some((u) => u.patch?.status === "ready")).toBe(true);
  });

  test("direct onboarding creates processing proof and marks that exact request ready before returning SDP", async () => {
    const startDirectSessionRequest = (serverModule as any)
      .startDirectSessionRequest;
    expect(startDirectSessionRequest).toBeFunction();
    const operations: Array<Record<string, unknown>> = [];
    const client = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        let mutation: "insert" | "update" | null = null;
        let lastPatch: Record<string, unknown> | null = null;
        const api: any = {
          insert(row: Record<string, unknown>) {
            mutation = "insert";
            operations.push({ operation: "insert", table, row });
            return api;
          },
          select() {
            return api;
          },
          single: async () => mutation === "insert"
            ? { data: { id: "direct-request-1" }, error: null }
            : lastPatch?.call_id && !lastPatch.status
              ? {
                  data: {
                    id: "direct-request-1",
                    status: "processing",
                    call_id: lastPatch.call_id,
                  },
                  error: null,
                }
              : { data: { id: "direct-request-1" }, error: null },
          update(patch: Record<string, unknown>) {
            mutation = "update";
            lastPatch = patch;
            operations.push({ operation: "update", table, patch, filters });
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
    const starts: unknown[][] = [];
    const startOptions: unknown[] = [];

    const result = await startDirectSessionRequest(
      {
        userId: "owner-a",
        sessionType: "onboarding",
        sdpOffer: "offer-sdp",
        modelOverride: "gpt-realtime-2.1",
        openingModeRequested: "application_tts_v1",
      },
      {
        client,
        nowIso: () => "2026-08-25T12:00:00.000Z",
        callIdFactory: () => "11111111-1111-4111-8111-111111111119",
        resolveSessionTenantImpl: async () => ({
          tenant: { ...V02_TENANT },
          rules: [],
        }),
        startSessionImpl: async (...args: unknown[]) => {
          starts.push(args.slice(0, 5));
          startOptions.push(args[6]);
          operations.push({ operation: "start" });
          const registerCleanup = args[5] as
            | ((control: { cancel(reason: string): Promise<void> }) => void)
            | undefined;
          registerCleanup?.({
            callId: "11111111-1111-4111-8111-111111111119",
            cancel: async () => {},
          });
          return {
            sdp: "answer-sdp",
            call_id: "11111111-1111-4111-8111-111111111119",
            opening_mode_applied: "application_tts_v1",
            opening_payload: {
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
            },
          } as any;
        },
      },
    );

    expect(result).toMatchObject({
      sdp: "answer-sdp",
      call_id: "11111111-1111-4111-8111-111111111119",
      opening_mode_applied: "application_tts_v1",
      opening_payload: expect.objectContaining({
        item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
      }),
    });
    expect(starts).toEqual([
      [
        "owner-a",
        "onboarding",
        "offer-sdp",
        "gpt-realtime-2.1",
        V02_TENANT.id,
      ],
    ]);
    expect(startOptions).toEqual([{
      browserRequestId: "direct-request-1",
      openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
    }]);
    expect(operations).toEqual([
      {
        operation: "insert",
        table: "browser_session_requests",
        row: {
          tenant_id: V02_TENANT.id,
          user_id: "owner-a",
          session_type: "onboarding",
          model_override: "gpt-realtime-2.1",
          offer_sdp: "offer-sdp",
          opening_mode_requested: "application_tts_v1",
          status: "processing",
          handled_at: "2026-08-25T12:00:00.000Z",
        },
      },
      {
        operation: "update",
        table: "browser_session_requests",
        patch: { call_id: "11111111-1111-4111-8111-111111111119" },
        filters: { id: "direct-request-1", status: "processing" },
      },
      { operation: "start" },
      {
        operation: "update",
        table: "browser_session_requests",
        patch: {
          status: "ready",
          answer_sdp: "answer-sdp",
          call_id: "11111111-1111-4111-8111-111111111119",
          opening_mode_applied: "application_tts_v1",
          opening_payload: expect.objectContaining({
            item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
          }),
        },
        filters: { id: "direct-request-1", status: "processing" },
      },
    ]);
  });

  test("application opening mode reaches startSession and is committed atomically with the ready SDP", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const durableRow: Record<string, unknown> = {
      id: "request-test-10",
      status: "pending",
      call_id: null,
      tenant_id: V02_TENANT.id,
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    };
    const rowClient = {
      from(table: string) {
        let patch: Record<string, unknown> | null = null;
        const api: any = {
          update(patch: Record<string, unknown>) {
            updates.push({ table, patch: structuredClone(patch) });
            durablePatch = patch;
            return api;
          },
          eq() { return api; },
          select: async () => {
            if (durablePatch) Object.assign(durableRow, durablePatch);
            return { data: [structuredClone(durableRow)], error: null };
          },
          maybeSingle: async () => ({
            data: structuredClone(durableRow), error: null,
          }),
        };
        let durablePatch = patch;
        return api;
      },
    };
    _setClient(rowClient as any);
    const starts: unknown[][] = [];
    const openingPayload = {
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

    await _handleBrowserRequest(
      {
        id: "request-test-10",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-test-10",
        model_override: null,
        opening_mode_requested: "application_tts_v1",
      },
      async (...args: unknown[]) => {
        starts.push(args);
        (args[5] as any)?.({
          callId: "11111111-1111-4111-8111-111111111119",
          cancel: async () => {},
        });
        return {
          sdp: "answer-test-10",
          call_id: "11111111-1111-4111-8111-111111111119",
          opening_mode_applied: "application_tts_v1",
          opening_payload: openingPayload,
        } as any;
      },
      {
        callIdFactory: () => "11111111-1111-4111-8111-111111111119",
      } as any,
    );

    expect(starts[0]?.slice(0, 5)).toEqual([
      "owner-a",
      "onboarding",
      "offer-test-10",
      undefined,
      V02_TENANT.id,
    ]);
    expect(typeof starts[0]?.[5]).toBe("function");
    expect(starts[0]?.[6]).toEqual({
      browserRequestId: "request-test-10",
      openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
    });
    expect(updates).toContainEqual({
      table: "browser_session_requests",
      patch: { call_id: "11111111-1111-4111-8111-111111111119" },
    });
    expect(openingPayload.item_id).toHaveLength(32);
    expect(updates.at(-1)).toEqual({
      table: "browser_session_requests",
      patch: {
        status: "ready",
        answer_sdp: "answer-test-10",
        call_id: "11111111-1111-4111-8111-111111111119",
        opening_mode_applied: "application_tts_v1",
        opening_payload: openingPayload,
      },
    });
  });

  test("a rejected atomic ready commit cancels the created provider session and records the request error", async () => {
    const patches: Record<string, unknown>[] = [];
    const rowClient = {
      from() {
        let patch: Record<string, unknown> = {};
        const api: any = {
          update(next: Record<string, unknown>) {
            patch = next;
            patches.push(structuredClone(next));
            return api;
          },
          eq() { return api; },
          select: async () => patch.status === "processing"
            ? { data: [{ id: "request-ready-fails" }], error: null }
            : patch.status === "ready"
              ? { data: null, error: { message: "ready constraint rejected" } }
              : { data: null, error: null },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
    };
    _setClient(rowClient as any);
    const cancellations: string[] = [];

    await _handleBrowserRequest(
      {
        id: "request-ready-fails",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "owner_browser",
        offer_sdp: "offer-ready-fails",
        opening_mode_requested: "provider_model_v1",
      },
      async (...args: unknown[]) => {
        const registerCleanup = args[5] as
          | ((cleanup: { cancel(reason: string): Promise<void> }) => void)
          | undefined;
        registerCleanup?.({
          callId: "call-ready-fails",
          cancel: async (reason: string) => {
            cancellations.push(reason);
          },
        });
        return {
          sdp: "answer-ready-fails",
          call_id: "call-ready-fails",
          opening_mode_applied: "provider_model_v1",
          opening_payload: null,
        } as any;
      },
    );

    expect(cancellations).toEqual(["browser_request_ready_failed"]);
    expect(patches.at(-1)).toMatchObject({
      status: "error",
      error: "browser_request_ready_failed",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
    });
  });

  test("an indeterminate ready write reconciles the exact durable ready row before any cancellation", async () => {
    const openingPayload = {
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
    const patches: Record<string, unknown>[] = [];
    const rowClient = {
      from() {
        let patch: Record<string, unknown> | null = null;
        const api: any = {
          update(next: Record<string, unknown>) {
            patch = next;
            patches.push(structuredClone(next));
            return api;
          },
          select() { return api; },
          eq() { return api; },
          maybeSingle: async () => ({
            data: {
              id: "request-ready-reconciles",
              status: "ready",
              answer_sdp: "answer-ready-reconciles",
              call_id: "call-ready-reconciles",
              opening_mode_applied: "provider_model_v1",
              opening_payload: null,
            },
            error: null,
          }),
          then(
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) {
            if (patch?.status === "processing")
              return Promise.resolve({
                data: [{ id: "request-ready-reconciles" }],
                error: null,
              }).then(resolve);
            if (patch?.status === "ready")
              return Promise.reject(
                new TypeError("synthetic ready transport loss"),
              ).then(resolve, reject);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
    };
    _setClient(rowClient as any);
    const cancellations: string[] = [];

    await _handleBrowserRequest(
      {
        id: "request-ready-reconciles",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "owner_browser",
        offer_sdp: "offer-ready-reconciles",
        opening_mode_requested: "provider_model_v1",
      },
      async (...args: unknown[]) => {
        const registerCleanup = args[5] as any;
        registerCleanup?.({
          callId: "call-ready-reconciles",
          cancel: async (reason: string) => cancellations.push(reason),
        });
        return {
          sdp: "answer-ready-reconciles",
          call_id: "call-ready-reconciles",
          opening_mode_applied: "provider_model_v1",
          opening_payload: null,
        } as any;
      },
    );

    expect(cancellations).toEqual([]);
    expect(patches.some((patch) => patch.status === "error")).toBe(false);
  });

  test("a mismatched ready reconciliation cancels and clears every ready-only field before error", async () => {
    const patches: Record<string, unknown>[] = [];
    const rowClient = {
      from() {
        let patch: Record<string, unknown> | null = null;
        const api: any = {
          update(next: Record<string, unknown>) {
            patch = next;
            patches.push(structuredClone(next));
            return api;
          },
          select() { return api; },
          eq() { return api; },
          maybeSingle: async () => ({
            data: {
              id: "request-ready-mismatch",
              status: "ready",
              answer_sdp: "foreign-answer",
              call_id: "foreign-call",
              opening_mode_applied: "provider_model_v1",
              opening_payload: null,
            },
            error: null,
          }),
          then(resolve: (value: unknown) => unknown) {
            if (patch?.status === "processing")
              return Promise.resolve({
                data: [{ id: "request-ready-mismatch" }], error: null,
              }).then(resolve);
            if (patch?.status === "ready")
              return Promise.resolve({ data: [], error: null }).then(resolve);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
    };
    _setClient(rowClient as any);
    const cancellations: string[] = [];

    await _handleBrowserRequest(
      {
        id: "request-ready-mismatch",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "owner_browser",
        offer_sdp: "offer-ready-mismatch",
        opening_mode_requested: "provider_model_v1",
      },
      async (...args: unknown[]) => {
        (args[5] as any)?.({
          callId: "expected-call",
          cancel: async (reason: string) => cancellations.push(reason),
        });
        return {
          sdp: "expected-answer",
          call_id: "expected-call",
          opening_mode_applied: "provider_model_v1",
          opening_payload: null,
        } as any;
      },
    );

    expect(cancellations).toEqual(["browser_request_ready_failed"]);
    expect(patches.at(-1)).toEqual({
      status: "error",
      error: "browser_request_ready_failed",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
    });
  });

  test("customer and owner browser ready rows apply provider mode with null payload and never request application TTS", async () => {
    for (const sessionType of ["customer", "owner_browser"] as const) {
      const patches: Record<string, unknown>[] = [];
      const rowClient = {
        from() {
          let patch: Record<string, unknown> = {};
          const api: any = {
            update(next: Record<string, unknown>) {
              patch = next;
              patches.push(structuredClone(next));
              return api;
            },
            eq() { return api; },
            select() { return api; },
            then(resolve: (value: unknown) => unknown) {
              return Promise.resolve({
                data: patch.status === "processing" || patch.status === "ready"
                  ? [{ id: `request-${sessionType}` }]
                  : null,
                error: null,
              }).then(resolve);
            },
          };
          return api;
        },
      };
      _setClient(rowClient as any);
      const starts: unknown[][] = [];
      await _handleBrowserRequest(
        {
          id: `request-${sessionType}`,
          user_id: "owner-a",
          tenant_id: V02_TENANT.id,
          session_type: sessionType,
          offer_sdp: `offer-${sessionType}`,
          opening_mode_requested: "provider_model_v1",
        },
        async (...args: unknown[]) => {
          starts.push(args);
          (args[5] as any)?.({
            callId: `call-${sessionType}`,
            cancel: async () => {},
          });
          return {
            sdp: `answer-${sessionType}`,
            call_id: `call-${sessionType}`,
            opening_mode_applied: "provider_model_v1",
            opening_payload: null,
          } as any;
        },
      );
      expect((starts[0]?.[6] as any)?.openingModeRequested)
        .toBe("provider_model_v1");
      expect(patches.at(-1)).toMatchObject({
        status: "ready",
        opening_mode_applied: "provider_model_v1",
        opening_payload: null,
      });
    }
    const count = (browserRequestsModule as any)._browserLiveControlCount;
    const prune = (browserRequestsModule as any)
      ._pruneBrowserLiveControlsForTests;
    expect(count()).toBe(0);
    prune();
    expect(count()).toBe(0);
  });

  test("a stale onboarding provider-mode row becomes client_upgrade_required without starting a call", async () => {
    const patches: Record<string, unknown>[] = [];
    const rowClient = {
      from() {
        let patch: Record<string, unknown> = {};
        const api: any = {
          update(next: Record<string, unknown>) {
            patch = next;
            patches.push(structuredClone(next));
            return api;
          },
          eq() { return api; },
          select() { return api; },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: patch.status === "processing"
                ? [{ id: "request-stale-provider" }]
                : null,
              error: null,
            }).then(resolve);
          },
        };
        return api;
      },
    };
    _setClient(rowClient as any);
    let starts = 0;
    await _handleBrowserRequest(
      {
        id: "request-stale-provider",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "stale-provider-offer",
        opening_mode_requested: "provider_model_v1",
      },
      async () => {
        starts += 1;
        throw new Error("must not start");
      },
    );
    expect(starts).toBe(0);
    expect(patches.at(-1)).toMatchObject({
      status: "error",
      error: "client_upgrade_required",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
    });
  });
});

describe("durable browser cancel_requested handshake", () => {
  test("protocol3 forwards durable identity and preserves ready cancellation custody", async () => {
    const b = boundary({ protocolVersion: 3 });
    _setClient(b.client as any);
    const reasons: string[] = [];
    const payload = {
      version: 3, item_id: `lgs-${"a".repeat(28)}`,
      speech: { schema: "onboarding.speech.v1", actionId: "a".repeat(64), interviewId: "22222222-2222-4222-8222-222222222229", callId: "22222222-2222-4222-8222-222222222229", revision: 0, kind: "ASK_NEXT_GAP", sourceDigest: "b".repeat(64), text: APPLICATION_OPENING_PAYLOAD_V2.text, text_sha256: APPLICATION_OPENING_PAYLOAD_V2.text_sha256, audio_base64: APPLICATION_OPENING_PAYLOAD_V2.audio_base64, audio_sha256: APPLICATION_OPENING_PAYLOAD_V2.audio_sha256, mime: "audio/mpeg", voice: "ash", tts_model: "tts-1-hd", cost_usd: APPLICATION_OPENING_PAYLOAD_V2.cost_usd },
    };
    await _handleBrowserRequest(structuredClone(b.row), async (...args: any[]) => {
      expect(args[6].onboardingProtocolVersion).toBe(3);
      expect(args[6].browserRequestId).toBe("request-cancel-1");
      args[5]({ callId: "22222222-2222-4222-8222-222222222229", startupComplete: true, cancel: async (reason: string) => {
        reasons.push(reason); Object.assign(b.call, { status: "error", provider_termination_state: "confirmed" });
      } });
      return { sdp: "answer", call_id: "22222222-2222-4222-8222-222222222229", opening_mode_applied: "application_tts_v1", opening_payload: payload } as any;
    });
    expect(b.row.error).toBeUndefined();
    expect(b.row.status).toBe("ready");
    expect(b.row.opening_payload).toEqual(payload);
    Object.assign(b.row, { status: "cancel_requested", error: "protocol3_cancel" });
    expect(await (browserRequestsModule as any)._handleBrowserCancellation(structuredClone(b.row))).toBe(true);
    expect(reasons).toEqual(["protocol3_cancel"]);
    expect(b.row.status).toBe("expired");
  });

  test("ready cancellation classification accepts wrong-cost V2 cleanup identity but rejects wrong protocol", () => {
    const classify = (browserRequestsModule as any)
      ._cancellationRequestKindForTests;
    expect(classify).toBeFunction();
    const row = (
      opening_payload: Record<string, unknown>,
      onboarding_protocol_version: number | null,
    ) => ({
      id: "request-classification",
      user_id: "owner-a",
      tenant_id: V02_TENANT.id,
      status: "cancel_requested",
      call_id: "22222222-2222-4222-8222-222222222229",
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version,
      answer_sdp: "answer",
      opening_mode_applied: "application_tts_v1",
      opening_payload,
    });
    expect(classify(row(APPLICATION_OPENING_PAYLOAD, null))).toBe("ready");
    expect(classify(row(APPLICATION_OPENING_PAYLOAD_V2, 2))).toBe("ready");
    expect(classify(row({
      ...APPLICATION_OPENING_PAYLOAD_V2,
      cost_usd: APPLICATION_OPENING_PAYLOAD_V2.cost_usd + 0.000001,
    }, 2))).toBe("ready");
    expect(classify(row(APPLICATION_OPENING_PAYLOAD_V2, 1))).toBeNull();
  });

  test("ready reconciliation deep-compares v2 resume context instead of object identity", () => {
    const matches = (browserRequestsModule as any)
      ._exactOpeningPayloadMatchesForTests;
    expect(matches).toBeFunction();
    expect(matches(
      structuredClone(APPLICATION_OPENING_PAYLOAD_V2),
      APPLICATION_OPENING_PAYLOAD_V2,
    )).toBe(true);
    expect(matches({
      ...structuredClone(APPLICATION_OPENING_PAYLOAD_V2),
      resume_context: {
        ...APPLICATION_OPENING_PAYLOAD_V2.resume_context,
        revision: 2,
      },
    }, APPLICATION_OPENING_PAYLOAD_V2)).toBe(false);
  });

  function boundary(options: {
    transitionRows?: number;
    protocolVersion?: number | null;
  } = {}) {
    const patches: Array<{
      patch: Record<string, unknown>;
      filters: Record<string, unknown>;
    }> = [];
    const row: Record<string, unknown> = {
      id: "request-cancel-1",
      user_id: "owner-a",
      status: "pending",
      call_id: null,
      answer_sdp: null,
      session_type: "onboarding",
      tenant_id: V02_TENANT.id,
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: options.protocolVersion ?? null,
      opening_mode_applied: null,
      opening_payload: null,
    };
    const call: Record<string, unknown> = {
      id: "22222222-2222-4222-8222-222222222229",
      tenant_id: V02_TENANT.id,
      channel: "browser",
      session_type: "onboarding",
      status: "active",
      openai_call_id: "rtc-cancel-1",
      provider_termination_state: "active",
      provider_termination_mode: "hangup",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0,
      duration_seconds: 0,
    };
    let expiredTransitions = 0;
    const client = {
      from(table: string) {
        let patch: Record<string, unknown> | null = null;
        const filters: Record<string, unknown> = {};
        const api: any = {
          update(next: Record<string, unknown>) {
            patch = next;
            patches.push({ patch: structuredClone(next), filters });
            return api;
          },
          select() { return api; },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return api;
          },
          maybeSingle: async () => ({
            data: structuredClone(table === "calls" ? call : row),
            error: null,
          }),
          then(resolve: (value: unknown) => unknown) {
            if (table === "calls") {
              if (patch) Object.assign(call, patch);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            }
            if (!patch) return Promise.resolve({
              data: [structuredClone(row)], error: null,
            }).then(resolve);
            if (patch.status === "processing") {
              Object.assign(row, patch);
              return Promise.resolve({
                data: [{ id: row.id }], error: null,
              }).then(resolve);
            }
            if (patch.status === "ready") {
              Object.assign(row, patch);
              return Promise.resolve({
                data: [{ id: row.id }], error: null,
              }).then(resolve);
            }
            if (patch.status === "expired") {
              expiredTransitions += 1;
              if ((options.transitionRows ?? 1) === 1) Object.assign(row, patch);
              return Promise.resolve({
                data: (options.transitionRows ?? 1) === 1
                  ? [structuredClone(row)]
                  : [],
                error: null,
              }).then(resolve);
            }
            if (patch.status === "error" && filters.status === "processing" &&
              row.status !== "processing")
              return Promise.resolve({ data: [], error: null }).then(resolve);
            Object.assign(row, patch);
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
    };
    return {
      client,
      patches,
      row,
      call,
      get expiredTransitions() { return expiredTransitions; },
    };
  }

  test("wrong-cost V2 Edge cancellation reaches controller cleanup and expires exactly once", async () => {
    const poll = (browserRequestsModule as any)._pollBrowserCancellations;
    const reset = (browserRequestsModule as any)
      ._resetBrowserLiveControlsForTests;
    const size = (browserRequestsModule as any)._browserLiveControlCount;
    reset();
    const b = boundary({ protocolVersion: 2 });
    _setClient(b.client as any);
    const reasons: string[] = [];
    const wrongCostPayload = {
      ...APPLICATION_OPENING_PAYLOAD_V2,
      cost_usd: APPLICATION_OPENING_PAYLOAD_V2.cost_usd + 0.000001,
    };
    await _handleBrowserRequest(
      {
        id: "request-cancel-1",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-wrong-cost-v2",
        opening_mode_requested: "application_tts_v1",
        onboarding_protocol_version: 2,
      },
      async (...args: unknown[]) => {
        (args[5] as any)?.({
          callId: "22222222-2222-4222-8222-222222222229",
          cancel: async (reason: string) => {
            reasons.push(reason);
            Object.assign(b.call, {
              status: "error",
              provider_termination_state: "confirmed",
            });
          },
        });
        return {
          sdp: "answer-wrong-cost-v2",
          call_id: "22222222-2222-4222-8222-222222222229",
          opening_mode_applied: "application_tts_v1",
          opening_payload: wrongCostPayload,
        } as any;
      },
    );
    expect(size()).toBe(1);
    Object.assign(b.row, {
      status: "cancel_requested",
      error: "invalid_application_opening_contract",
    });

    expect(await poll({
      loadRows: async () => [structuredClone(b.row)],
    })).toBe(1);
    expect(reasons).toEqual(["invalid_application_opening_contract"]);
    expect(b.expiredTransitions).toBe(1);
    expect(b.row).toMatchObject({
      status: "expired",
      call_id: "22222222-2222-4222-8222-222222222229",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
      onboarding_protocol_version: 2,
    });
    expect(size()).toBe(0);
    reset();
  });

  test("ready→cancel_requested runs exact cleanup once across realtime/poll duplicates, then expires with call audit linkage", async () => {
    const cancel = (browserRequestsModule as any)._handleBrowserCancellation;
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    const size = (browserRequestsModule as any)._browserLiveControlCount;
    expect(cancel).toBeFunction();
    expect(reset).toBeFunction();
    reset();
    const b = boundary();
    _setClient(b.client as any);
    const reasons: string[] = [];
    await _handleBrowserRequest(
      {
        id: "request-cancel-1",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-cancel",
        opening_mode_requested: "application_tts_v1",
      },
      async (...args: unknown[]) => {
        (args[5] as any)?.({
          callId: "22222222-2222-4222-8222-222222222229",
          cancel: async (reason: string) => {
            reasons.push(reason);
            Object.assign(b.call, {
              status: "error",
              provider_termination_state: "confirmed",
            });
          },
        });
        return {
          sdp: "answer-cancel",
          call_id: "22222222-2222-4222-8222-222222222229",
          opening_mode_applied: "application_tts_v1",
          opening_payload: APPLICATION_OPENING_PAYLOAD,
        } as any;
      },
    );
    expect(size()).toBe(1);
    Object.assign(b.row, {
      status: "cancel_requested",
      error: "edge_deadline_exceeded",
    });
    const cancelRow = structuredClone(b.row);
    const results = await Promise.all([
      cancel(cancelRow),
      cancel(cancelRow),
    ]);
    expect(results).toEqual([true, true]);
    expect(reasons).toEqual(["edge_deadline_exceeded"]);
    expect(b.expiredTransitions).toBe(1);
    expect(b.row).toMatchObject({
      status: "expired",
      call_id: "22222222-2222-4222-8222-222222222229",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
    });
    expect(size()).toBe(0);
  });

  test("wrong call, foreign status, or missing control never cancels or clears durable state", async () => {
    const cancel = (browserRequestsModule as any)._handleBrowserCancellation;
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    reset();
    const b = boundary();
    _setClient(b.client as any);
    const reasons: string[] = [];
    await _handleBrowserRequest(
      {
        id: "request-cancel-1",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-cancel",
        opening_mode_requested: "application_tts_v1",
      },
      async (...args: unknown[]) => {
        (args[5] as any)?.({
          callId: "22222222-2222-4222-8222-222222222229",
          cancel: async (reason: string) => { reasons.push(reason); },
        });
        return {
          sdp: "answer-cancel",
          call_id: "22222222-2222-4222-8222-222222222229",
          opening_mode_applied: "application_tts_v1",
          opening_payload: APPLICATION_OPENING_PAYLOAD,
        } as any;
      },
    );
    Object.assign(b.row, {
      status: "cancel_requested",
      error: "edge_identity_negative",
      user_id: "owner-b",
    });
    expect(await cancel(structuredClone(b.row))).toBe(false);
    b.row.user_id = "owner-a";
    b.row.onboarding_protocol_version = 2;
    expect(await cancel(structuredClone(b.row))).toBe(false);
    b.row.onboarding_protocol_version = null;
    expect(await cancel({
      ...b.row, status: "cancel_requested", call_id: "foreign-call",
    })).toBe(false);
    expect(await cancel({ ...b.row, status: "ready" })).toBe(false);
    expect(await cancel({
      ...b.row, id: "missing-request", status: "cancel_requested",
    })).toBe(false);
    Object.assign(b.row, {
      status: "cancel_requested",
      session_type: "owner_browser",
      opening_mode_requested: "provider_model_v1",
      opening_mode_applied: "provider_model_v1",
      opening_payload: null,
    });
    expect(await cancel(structuredClone(b.row))).toBe(false);
    expect(reasons).toEqual([]);
    expect(b.expiredTransitions).toBe(0);
    expect(b.row.status).toBe("cancel_requested");
    reset();
  });

  test("pre-sideband startup control survives pruning and the cancellation poll invokes it", async () => {
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    const size = (browserRequestsModule as any)._browserLiveControlCount;
    const prune = (browserRequestsModule as any)
      ._pruneBrowserLiveControlsForTests;
    const poll = (browserRequestsModule as any)._pollBrowserCancellations;
    reset();
    const b = boundary();
    _setClient(b.client as any);
    let registered!: () => void;
    const controlRegistered = new Promise<void>((resolve) => {
      registered = resolve;
    });
    let releaseStartup!: () => void;
    const heldStartup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let cancelCalls = 0;
    let aborted = false;
    const handling = _handleBrowserRequest(
      {
        id: "request-cancel-1",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-held-startup",
        opening_mode_requested: "application_tts_v1",
      },
      async (...args: unknown[]) => {
        let cancelled = false;
        (args[5] as any)?.({
          callId: "22222222-2222-4222-8222-222222222229",
          startupComplete: false,
          cancel: async () => {
            if (cancelled) return;
            cancelled = true;
            cancelCalls += 1;
            aborted = true;
            Object.assign(b.call, {
              status: "error",
              openai_call_id: null,
              provider_termination_state: "not_required",
              provider_usage_state: "not_applicable",
              cost_estimate_usd: 0,
            });
            releaseStartup();
          },
        });
        registered();
        await heldStartup;
        throw new Error("browser_request_cancelled");
      },
      { callIdFactory: () => "22222222-2222-4222-8222-222222222229" } as any,
    );
    await controlRegistered;
    expect(size()).toBe(1);
    prune();
    expect(size()).toBe(1);
    Object.assign(b.row, {
      status: "cancel_requested",
      error: "edge_cancelled_while_starting",
    });
    expect(await poll({
      loadRows: async () => [structuredClone(b.row)],
    })).toBe(1);
    await handling;
    expect(cancelCalls).toBe(1);
    expect(aborted).toBe(true);
    expect(b.row.status).toBe("expired");
    expect(size()).toBe(0);
    reset();
  });

  test("completed startup control without a live sideband session is pruned", async () => {
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    const size = (browserRequestsModule as any)._browserLiveControlCount;
    const prune = (browserRequestsModule as any)
      ._pruneBrowserLiveControlsForTests;
    reset();
    const b = boundary();
    _setClient(b.client as any);
    let registered!: () => void;
    const controlRegistered = new Promise<void>((resolve) => {
      registered = resolve;
    });
    let finishStartup!: (value: any) => void;
    const startupResult = new Promise<any>((resolve) => {
      finishStartup = resolve;
    });
    const handling = _handleBrowserRequest(
      {
        id: "request-cancel-1",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-completed-startup",
        opening_mode_requested: "application_tts_v1",
      },
      async (...args: unknown[]) => {
        (args[5] as any)?.({
          callId: "22222222-2222-4222-8222-222222222229",
          startupComplete: true,
          cancel: async () => {},
        });
        registered();
        return await startupResult;
      },
      { callIdFactory: () => "22222222-2222-4222-8222-222222222229" } as any,
    );
    await controlRegistered;
    expect(size()).toBe(1);
    prune();
    expect(size()).toBe(0);
    finishStartup({
      sdp: "answer-completed-startup",
      call_id: "22222222-2222-4222-8222-222222222229",
      opening_mode_applied: "application_tts_v1",
      opening_payload: APPLICATION_OPENING_PAYLOAD,
    });
    await handling;
    expect(size()).toBe(0);
    reset();
  });

  test("restart fallback uses one durable provider attempt, preserves cost floor, and ACKs only confirmed termination", async () => {
    const cancel = (browserRequestsModule as any)._handleBrowserCancellation;
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    for (const outcome of [
      "confirmed",
      "unknown",
      "missing_id",
      "not_required",
    ] as const) {
      reset();
      let posts = 0;
      let attemptStarted = false;
      const request: Record<string, unknown> = {
        id: `request-restart-${outcome}`,
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        status: "cancel_requested",
        call_id: `call-restart-${outcome}`,
        answer_sdp: "answer-before-cancel",
        opening_mode_requested: "application_tts_v1",
        opening_mode_applied: "application_tts_v1",
        opening_payload: structuredClone(APPLICATION_OPENING_PAYLOAD),
        error: "edge_deadline_exceeded",
      };
      const call: Record<string, unknown> = {
        id: request.call_id,
        tenant_id: V02_TENANT.id,
        channel: "browser",
        session_type: "onboarding",
        status: "active",
        openai_call_id: outcome === "missing_id" ? null : `rtc-${outcome}`,
        provider_termination_state: outcome === "not_required"
          ? "not_required"
          : "active",
        provider_termination_mode: "hangup",
        provider_usage_state: "unknown",
        cost_estimate_usd: 0.001605,
        duration_seconds: 0,
      };
      const client = {
        rpc(name: string, args: Record<string, unknown>) {
          if (name === "begin_provider_termination_attempt") {
            if (attemptStarted)
              return Promise.resolve({ data: { should_attempt: false }, error: null });
            attemptStarted = true;
            return Promise.resolve({ data: {
              should_attempt: true,
              attempt_id: `attempt-${outcome}`,
              request_id: `request-provider-${outcome}`,
              openai_call_id: call.openai_call_id,
              provider_termination_mode: "hangup",
            }, error: null });
          }
          if (name === "complete_provider_termination_attempt") {
            call.provider_termination_state = args.p_confirmed === true
              ? "confirmed"
              : "unknown";
            return Promise.resolve({ data: true, error: null });
          }
          if (name === "settle_call_budget")
            return Promise.resolve({ data: "settled", error: null });
          return Promise.resolve({ data: null, error: null });
        },
        from(table: string) {
          let patch: Record<string, unknown> | null = null;
          const filters: Record<string, unknown> = {};
          const api: any = {
            update(next: Record<string, unknown>) { patch = next; return api; },
            select() { return api; },
            eq(column: string, value: unknown) { filters[column] = value; return api; },
            maybeSingle: async () => ({
              data: structuredClone(table === "calls" ? call : request),
              error: null,
            }),
            then(resolve: (value: unknown) => unknown) {
              if (table === "calls" && patch) Object.assign(call, patch);
              if (table === "browser_session_requests" &&
                patch?.status === "expired" &&
                request.status === "cancel_requested" &&
                filters.call_id === request.call_id) {
                Object.assign(request, patch);
                return Promise.resolve({
                  data: [structuredClone(request)], error: null,
                }).then(resolve);
              }
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return api;
        },
      };
      _setClient(client as any);
      const fetchImpl = async () => {
        posts += 1;
        return new Response(null, {
          status: ["confirmed", "not_required"].includes(outcome) ? 200 : 500,
        });
      };
      const first = await cancel(structuredClone(request), { fetchImpl });
      expect(first).toBe(["confirmed", "not_required"].includes(outcome));
      expect(call.cost_estimate_usd).toBe(0.001605);
      if (["confirmed", "not_required"].includes(outcome)) {
        expect(request).toMatchObject({
          status: "expired",
          call_id: `call-restart-${outcome}`,
          answer_sdp: null,
          opening_mode_applied: null,
          opening_payload: null,
        });
        expect(posts).toBe(1);
      } else {
        expect(request.status).toBe("cancel_requested");
        expect(posts).toBe(outcome === "missing_id" ? 0 : 1);
        expect(await cancel(structuredClone(request), { fetchImpl })).toBe(false);
        expect(posts).toBe(outcome === "missing_id" ? 0 : 1);
      }
    }
    reset();
  });

  test("accepted-provider cancellation defers not-applicable or malformed usage instead of settling zero", async () => {
    const cancel = (browserRequestsModule as any)._handleBrowserCancellation;
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    for (const [usageState, cost] of [
      ["not_applicable", null],
      ["resolved", null],
      ["resolved", -0.01],
      ["resolved", Number.NaN],
    ] as const) {
      reset();
      const suffix = `${usageState}-${String(cost)}`;
      const request: Record<string, unknown> = {
        id: `request-provider-usage-${suffix}`,
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        status: "cancel_requested",
        call_id: `call-provider-usage-${suffix}`,
        answer_sdp: "answer-before-cancel",
        opening_mode_requested: "application_tts_v1",
        opening_mode_applied: "application_tts_v1",
        opening_payload: structuredClone(APPLICATION_OPENING_PAYLOAD),
        error: "edge_deadline_exceeded",
      };
      const call: Record<string, unknown> = {
        id: request.call_id,
        tenant_id: V02_TENANT.id,
        channel: "browser",
        session_type: "onboarding",
        status: "active",
        openai_call_id: `rtc-provider-usage-${suffix}`,
        provider_termination_state: "active",
        provider_termination_mode: "hangup",
        provider_usage_state: usageState,
        cost_estimate_usd: cost,
        duration_seconds: 0,
      };
      let terminationStarted = false;
      let providerPosts = 0;
      const settlements: Record<string, unknown>[] = [];
      const reconciliationPatches: Record<string, unknown>[] = [];
      const client = {
        rpc(name: string, args: Record<string, unknown>) {
          if (name === "begin_provider_termination_attempt") {
            if (terminationStarted)
              return Promise.resolve({
                data: { should_attempt: false }, error: null,
              });
            terminationStarted = true;
            return Promise.resolve({
              data: {
                should_attempt: true,
                attempt_id: `attempt-${suffix}`,
                request_id: `termination-request-${suffix}`,
                openai_call_id: call.openai_call_id,
                provider_termination_mode: "hangup",
              },
              error: null,
            });
          }
          if (name === "complete_provider_termination_attempt") {
            call.provider_termination_state = args.p_confirmed === true
              ? "confirmed"
              : "unknown";
            return Promise.resolve({ data: true, error: null });
          }
          if (name === "settle_call_budget") {
            settlements.push(structuredClone(args));
            return Promise.resolve({ data: "settled", error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        from(table: string) {
          let patch: Record<string, unknown> | null = null;
          const filters: Record<string, unknown> = {};
          const api: any = {
            update(next: Record<string, unknown>) {
              patch = next;
              if (table === "budget_reservations")
                reconciliationPatches.push(structuredClone(next));
              return api;
            },
            select() { return api; },
            eq(column: string, value: unknown) {
              filters[column] = value;
              return api;
            },
            maybeSingle: async () => ({
              data: structuredClone(table === "calls" ? call : request),
              error: null,
            }),
            then(resolve: (value: unknown) => unknown) {
              if (table === "calls" && patch) Object.assign(call, patch);
              if (table === "browser_session_requests" &&
                patch?.status === "expired" &&
                request.status === "cancel_requested" &&
                filters.call_id === request.call_id) {
                Object.assign(request, patch);
                return Promise.resolve({
                  data: [structuredClone(request)], error: null,
                }).then(resolve);
              }
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return api;
        },
      };
      _setClient(client as any);
      expect(await cancel(structuredClone(request), {
        fetchImpl: async () => {
          providerPosts += 1;
          return new Response(null, { status: 200 });
        },
      })).toBe(true);
      expect(providerPosts).toBe(1);
      expect(settlements).toEqual([]);
      expect(reconciliationPatches).toContainEqual(expect.objectContaining({
        reconcile_last_error: "provider_usage_unresolved",
      }));
      expect(request.status).toBe("expired");
    }
    reset();
  });

  test("processing-bound cancellation distinguishes exact call absence, unreadable calls, safe no-provider calls, and inflight unknown", async () => {
    const cancel = (browserRequestsModule as any)._handleBrowserCancellation;
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    for (const variant of [
      "no_call",
      "call_read_error",
      "call_read_throw",
      "no_provider",
      "inflight_unknown",
      "tts_inflight_unknown",
      "tts_resolved_floor",
      "tts_resolved_null",
    ] as const) {
      reset();
      const request: Record<string, unknown> = {
        id: `request-processing-${variant}`,
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        status: "cancel_requested",
        call_id: `call-processing-${variant}`,
        answer_sdp: null,
        opening_mode_requested: "application_tts_v1",
        opening_mode_applied: null,
        opening_payload: null,
        error: "edge_cancelled_processing",
      };
      const call: Record<string, unknown> | null = [
          "no_call",
          "call_read_error",
          "call_read_throw",
        ].includes(variant)
        ? null
        : {
            id: request.call_id,
            tenant_id: V02_TENANT.id,
            channel: "browser",
            session_type: "onboarding",
            status: "active",
            openai_call_id: null,
            provider_termination_state: [
              "no_provider",
              "tts_inflight_unknown",
              "tts_resolved_floor",
              "tts_resolved_null",
            ].includes(variant)
              ? "not_required"
              : "unknown",
            provider_termination_mode: "hangup",
            provider_termination_reason: variant === "inflight_unknown"
              ? "provider_create_inflight"
              : variant === "tts_inflight_unknown"
                ? "tts_inflight"
                : ["tts_resolved_floor", "tts_resolved_null"].includes(variant)
                  ? "tts_resolved"
                  : null,
            provider_usage_state: variant === "no_provider"
              ? "not_applicable"
              : ["tts_resolved_floor", "tts_resolved_null"].includes(variant)
                ? "resolved"
                : "unknown",
            cost_estimate_usd: variant === "tts_resolved_null"
              ? null
              : 0.001605,
            duration_seconds: 0,
          };
      const client = {
        rpc(name: string) {
          if (name === "settle_call_budget")
            return Promise.resolve({ data: "settled", error: null });
          return Promise.resolve({ data: null, error: null });
        },
        from(table: string) {
          let patch: Record<string, unknown> | null = null;
          const filters: Record<string, unknown> = {};
          const api: any = {
            update(next: Record<string, unknown>) { patch = next; return api; },
            select() { return api; },
            eq(column: string, value: unknown) { filters[column] = value; return api; },
            maybeSingle: async () => {
              if (table === "calls" && variant === "call_read_error")
                return {
                  data: null,
                  error: { message: "synthetic PostgREST read failure" },
                };
              if (table === "calls" && variant === "call_read_throw")
                throw new TypeError("synthetic calls transport failure");
              return {
                data: structuredClone(table === "calls" ? call : request),
                error: null,
              };
            },
            then(resolve: (value: unknown) => unknown) {
              if (table === "calls" && call && patch &&
                filters.status === "active") Object.assign(call, patch);
              if (table === "browser_session_requests" &&
                patch?.status === "expired" &&
                request.status === "cancel_requested") {
                Object.assign(request, patch);
                return Promise.resolve({
                  data: [structuredClone(request)], error: null,
                }).then(resolve);
              }
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return api;
        },
      };
      _setClient(client as any);
      const result = await cancel(structuredClone(request), {
        fetchImpl: async () => {
          throw new Error("provider POST forbidden for processing variants");
        },
      });
      const shouldExpire = [
        "no_call",
        "no_provider",
        "tts_resolved_floor",
      ].includes(variant);
      expect(result).toBe(shouldExpire);
      expect(request.status).toBe(
        shouldExpire ? "expired" : "cancel_requested",
      );
      if (call) expect(call.cost_estimate_usd).toBe(
        variant === "tts_resolved_null" ? null : 0.001605,
      );
    }
    reset();
  });

  test("a rejected local cleanup still falls through to exact durable confirmed proof", async () => {
    const cancel = (browserRequestsModule as any)._handleBrowserCancellation;
    const reset = (browserRequestsModule as any)._resetBrowserLiveControlsForTests;
    reset();
    const b = boundary();
    _setClient(b.client as any);
    let cleanupCalls = 0;
    await _handleBrowserRequest(
      {
        id: "request-cancel-1",
        user_id: "owner-a",
        tenant_id: V02_TENANT.id,
        session_type: "onboarding",
        offer_sdp: "offer-cancel",
        opening_mode_requested: "application_tts_v1",
      },
      async (...args: unknown[]) => {
        (args[5] as any)?.({
          callId: "22222222-2222-4222-8222-222222222229",
          cancel: async () => {
            cleanupCalls += 1;
            Object.assign(b.call, {
              status: "error",
              provider_termination_state: "confirmed",
            });
            throw new Error("local cleanup response lost");
          },
        });
        return {
          sdp: "answer-cancel",
          call_id: "22222222-2222-4222-8222-222222222229",
          opening_mode_applied: "application_tts_v1",
          opening_payload: APPLICATION_OPENING_PAYLOAD,
        } as any;
      },
      { callIdFactory: () => "22222222-2222-4222-8222-222222222229" } as any,
    );
    Object.assign(b.row, { status: "cancel_requested", error: "edge_abort" });
    expect(await cancel(structuredClone(b.row))).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(b.row.status).toBe("expired");
    reset();
  });

  test("dedicated cancellation polling completes while pending startup remains unresolved", async () => {
    const pollPending = (browserRequestsModule as any)
      ._pollPendingBrowserRequests;
    const pollCancellations = (browserRequestsModule as any)
      ._pollBrowserCancellations;
    expect(pollPending).toBeFunction();
    expect(pollCancellations).toBeFunction();
    let pendingStarted = 0;
    const never = new Promise<void>(() => {});
    void pollPending(async () => ({ sdp: "", call_id: "" }), {
      loadRows: async () => [{ id: "pending-slow" }],
      handleRow: async () => {
        pendingStarted += 1;
        await never;
      },
    });
    let cancellations = 0;
    const completed = await pollCancellations({
      loadRows: async () => [{ id: "cancel-fast" }],
      handleRow: async () => {
        cancellations += 1;
        return true;
      },
    });
    expect(pendingStarted).toBe(1);
    expect(completed).toBe(1);
    expect(cancellations).toBe(1);
  });

  test("overlapping cancellation ticks share one bounded poll", async () => {
    const pollCancellations = (browserRequestsModule as any)
      ._pollBrowserCancellations;
    let loads = 0;
    let handles = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const dependencies = {
      loadRows: async () => {
        loads += 1;
        return [{ id: "cancel-overlap" }];
      },
      handleRow: async () => {
        handles += 1;
        await held;
        return true;
      },
    };
    const first = pollCancellations(dependencies);
    const second = pollCancellations(dependencies);
    await new Promise((resolve) => setImmediate(resolve));
    expect(loads).toBe(1);
    expect(handles).toBe(1);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
  });
});

describe("application-owned Test 10 opening", () => {
  test("one bounded fresh tts-1-hd request emits payload v2 with null resume context and exact USD 30/M cost", async () => {
    const synthesize = (serverModule as any).synthesizeOnboardingOpening;
    expect(synthesize).toBeFunction();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const audio = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64,
    ]);
    const payload = await synthesize(
      {
        tenantName: "D1F Marketing",
        browserRequestId: "request-test-10",
        callId: "call-test-10",
      },
      {
        openaiKey: "synthetic-unit-test-key",
        timeoutMs: 50,
        fetchImpl: async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return new Response(audio, {
            status: 200,
            headers: {
              "content-type": "audio/mpeg",
              "content-length": String(audio.byteLength),
            },
          });
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "tts-1-hd",
      voice: "ash",
      input: "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?",
      response_format: "mp3",
    });
    expect(Object.keys(payload)).toEqual([
      "version",
      "item_id",
      "text",
      "text_sha256",
      "audio_base64",
      "audio_sha256",
      "mime",
      "voice",
      "tts_model",
      "cost_usd",
      "resume_context",
    ]);
    expect(payload).toEqual({
      version: 2,
      item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
      text: "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?",
      text_sha256: "413f79d3d184ea3985fdb593f99ac331c612c157e871034df0135f06a7817e06",
      audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
      audio_sha256: "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
      mime: "audio/mpeg",
      voice: "ash",
      tts_model: "tts-1-hd",
      cost_usd: 0.00321,
      resume_context: null,
    });
    expect(payload.item_id).toHaveLength(32);
    expect(openingPayloadIsInternallyValid(
      payload,
      onboardingOpeningText("D1F Marketing", null),
      null,
    )).toBe(true);
  });

  test("resumed payload v2 says identity, continuation phrase, and exact persisted question once", async () => {
    const synthesize = (serverModule as any).synthesizeOnboardingOpening;
    const audio = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64,
    ]);
    const resumeContext = {
      coverage_receipt_id: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      snapshot_digest: "c".repeat(64),
      next_action: {
        type: "ask",
        field: "area.coverage",
        question_pt: "Quais cidades e regiões sua empresa atende?",
      },
    };
    let body: Record<string, unknown> | null = null;
    const payload = await synthesize(
      {
        tenantName: "D1F Marketing",
        browserRequestId: "request-resume-task3",
        callId: "call-resume-task3",
        resumeContext,
      },
      {
        openaiKey: "synthetic-unit-test-key",
        timeoutMs: 50,
        fetchImpl: async (_url: string, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return new Response(audio, {
            status: 200,
            headers: {
              "content-type": "audio/mpeg",
              "content-length": String(audio.byteLength),
            },
          });
        },
      },
    );
    const exactText =
      "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Vamos continuar de onde paramos. Quais cidades e regiões sua empresa atende?";
    expect(body).toEqual({
      model: "tts-1-hd",
      voice: "ash",
      input: exactText,
      response_format: "mp3",
    });
    expect(payload).toEqual({
      version: 2,
      item_id: "lgo-b00cbaf9911210b676ace0d7dda5",
      text: exactText,
      text_sha256: "643ca15a2dbc57364f4eca5ae9e846674df997f7837b42873c9998ed2ff5bbf3",
      audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
      audio_sha256: "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
      mime: "audio/mpeg",
      voice: "ash",
      tts_model: "tts-1-hd",
      cost_usd: 0.00444,
      resume_context: resumeContext,
    });
    expect(payload.text.split("Vamos continuar de onde paramos.")).toHaveLength(2);
    expect(payload.text.split(resumeContext.next_action.question_pt)).toHaveLength(2);
    expect(openingPayloadIsInternallyValid(
      payload,
      exactText,
      resumeContext,
    )).toBe(true);
    expect(openingPayloadIsInternallyValid(
      payload,
      exactText,
      { ...resumeContext, snapshot_digest: "d".repeat(64) },
    )).toBe(false);
    expect(openingPayloadIsInternallyValid(
      APPLICATION_OPENING_PAYLOAD,
      APPLICATION_OPENING_PAYLOAD.text,
      null,
    )).toBe(true);
  });

  test("tts failures distinguish definitive rejection, malformed success, and indeterminate delivery", async () => {
    const synthesize = (serverModule as any).synthesizeOnboardingOpening;
    expect(synthesize).toBeFunction();
    const base = {
      tenantName: "D1F Marketing",
      browserRequestId: "request-test-10",
      callId: "call-test-10",
    };
    const dependency = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) => ({
      openaiKey: "synthetic-unit-test-key",
      timeoutMs: 50,
      fetchImpl,
    });

    try {
      await synthesize(base, dependency(async () =>
        new Response("invalid", { status: 400, headers: { "content-type": "application/json" } })
      ));
      throw new Error("expected definitive rejection");
    } catch (error: any) {
      expect(error.message).toBe("onboarding_tts_rejected");
      expect(error.usageResolved).toBe(true);
      expect(error.costUsd).toBe(0);
    }

    try {
      await synthesize(base, dependency(async () =>
        new Response("not-mp3", { status: 200, headers: { "content-type": "text/plain" } })
      ));
      throw new Error("expected malformed success");
    } catch (error: any) {
      expect(error.message).toBe("onboarding_tts_invalid_response");
      expect(error.usageResolved).toBe(true);
      expect(error.costUsd).toBe(0.00321);
    }

    try {
      await synthesize(base, dependency(async () => {
        throw new TypeError("synthetic network loss");
      }));
      throw new Error("expected indeterminate delivery");
    } catch (error: any) {
      expect(error.message).toBe("onboarding_tts_outcome_unknown");
      expect(error.usageResolved).toBe(false);
      expect(error.costUsd).toBeNull();
    }

    try {
      await synthesize(base, dependency(async () =>
        new Response(new Uint8Array(1_500_001), {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "content-length": "1500001",
          },
        })
      ));
      throw new Error("expected bounded audio rejection");
    } catch (error: any) {
      expect(error.message).toBe("onboarding_tts_invalid_response");
      expect(error.usageResolved).toBe(true);
      expect(error.costUsd).toBe(0.00321);
    }

    const timeoutDependency = {
      openaiKey: "synthetic-unit-test-key",
      timeoutMs: 10,
      fetchImpl: async (_url: string, init: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    };
    const timeoutStarted = performance.now();
    try {
      await synthesize(base, timeoutDependency);
      throw new Error("expected bounded timeout");
    } catch (error: any) {
      expect(error.message).toBe("onboarding_tts_outcome_unknown");
      expect(error.usageResolved).toBe(false);
      expect(performance.now() - timeoutStarted).toBeLessThan(250);
    }

    const slowBodyDependency = {
      openaiKey: "synthetic-unit-test-key",
      timeoutMs: 10,
      fetchImpl: async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const delayed = setTimeout(() => {
              controller.enqueue(new Uint8Array([0x49, 0x44, 0x33, 0xff]));
              controller.close();
            }, 40);
            init.signal?.addEventListener("abort", () => {
              clearTimeout(delayed);
              controller.error(new DOMException("aborted", "AbortError"));
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      },
    };
    try {
      await synthesize(base, slowBodyDependency);
      throw new Error("expected body timeout");
    } catch (error: any) {
      expect(error.message).toBe("onboarding_tts_invalid_response");
      expect(error.usageResolved).toBe(true);
      expect(error.costUsd).toBe(0.00321);
    }
  });

  test("malformed usage-resolved TTS failures cannot synthesize a zero cost floor", () => {
    const resolvedCost = (serverModule as any)
      .resolvedOnboardingTtsFailureCost;
    expect(resolvedCost).toBeFunction();
    expect(resolvedCost({ usageResolved: true, costUsd: null })).toBeNull();
    expect(resolvedCost({ usageResolved: true, costUsd: Number.NaN }))
      .toBeNull();
    expect(resolvedCost({ usageResolved: true, costUsd: -0.01 })).toBeNull();
    expect(resolvedCost({ usageResolved: false, costUsd: 0.001605 }))
      .toBeNull();
    expect(resolvedCost({ usageResolved: true, costUsd: 0 })).toBe(0);
    expect(resolvedCost({ usageResolved: true, costUsd: 0.001605 }))
      .toBe(0.001605);
  });

  test("application mode disables automatic Realtime responses in the initial multipart while provider mode stays compatible", () => {
    const build = (serverModule as any).buildRealtimeSessionConfig;
    expect(build).toBeFunction();
    const common = {
      model: "gpt-realtime-2.1",
      instructions: "synthetic instructions",
      tools: [],
      voice: "ash",
    };
    const application = build({ ...common, openingMode: "application_tts_v1" });
    const provider = build({ ...common, openingMode: "provider_model_v1" });
    expect(application.audio.input.turn_detection).toEqual({
      type: "semantic_vad",
      eagerness: "low",
      create_response: false,
      interrupt_response: false,
    });
    expect(application.output_modalities).toEqual(["text"]);
    expect(provider.audio.input.turn_detection).toEqual({
      type: "semantic_vad",
      eagerness: "low",
      create_response: true,
      interrupt_response: true,
    });
    expect(provider.output_modalities).toEqual(["audio"]);
  });
});

describe("edge owned-tenant resolution", () => {
  function edgeClient(rows: any[], legacy: any | null) {
    return {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const api: any = {
          select() { return api; },
          eq(column: string, value: unknown) { filters[column] = value; return api; },
          order() { return api; },
          limit: async () => ({ data: rows, error: null }),
          single: async () => (legacy ? { data: legacy, error: null } : { data: null, error: { message: "not found" } }),
        };
        return api;
      },
    };
  }

  test("an owner with a v0.2 tenant gets that tenant, not the env slug", async () => {
    const client = edgeClient([{
      id: V02_TENANT.id,
      slug: V02_TENANT.slug,
      name: V02_TENANT.name,
      owner_user_id: "owner-a",
    }], null);
    const tenant = await resolveOwnedTenantForSession(client as any, "owner-a", "rocha-plumbing");
    expect(tenant.id).toBe(V02_TENANT.id);
  });

  test("an owner without a v0.2 tenant falls back to legacy slug ownership", async () => {
    const client = edgeClient([], {
      id: LEGACY_TENANT.id,
      slug: "rocha-plumbing",
      name: LEGACY_TENANT.name,
      owner_user_id: "owner-legacy",
    });
    const tenant = await resolveOwnedTenantForSession(client as any, "owner-legacy", "rocha-plumbing");
    expect(tenant.id).toBe(LEGACY_TENANT.id);
  });

  test("no owned tenant anywhere fails closed", async () => {
    const client = edgeClient([], { id: LEGACY_TENANT.id, slug: "rocha-plumbing", owner_user_id: "owner-legacy" });
    await expect(resolveOwnedTenantForSession(client as any, "stranger", "rocha-plumbing")).rejects.toThrow(/not_tenant_owner/);
  });
});
