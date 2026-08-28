import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as configModule from "../src/config.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { startSession } from "../src/server.ts";

const TENANT = {
  id: "tenant-1", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "owner-1", auth_epoch: 2, policy_epoch: 3,
};

const { config } = configModule;

let reserveError: { message: string } | null = null;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const originalOpenAiKey = config.openaiKey;
const originalCeiling = config.sessionCostCeilingUsd;
const originalProviderCreateTimeoutMs =
  (config as any).realtimeCreateTimeoutMs;
const originalSidebandOpenTimeoutMs = (config as any).sidebandOpenTimeoutMs;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let fetchUrls: string[] = [];
let callUpdates: any[] = [];
let budgetUpdates: any[] = [];
let providerAttempts = new Set<string>();
let callInserts = 0;
let callInsertRows: Record<string, unknown>[] = [];
let floorWriteMode: "success" | "throw_exact" | "unproven" = "success";
let durableFloor: number | null = null;
let providerIdentityMode: "success" | "error" | "zero" = "success";
let durableProviderIdentity: Record<string, unknown> | null = null;
let reserveGate: Promise<void> | null = null;
let providerMarkerGate: Promise<void> | null = null;

class AutoOpenWebSocket {
  listeners = new Map<string, Array<(event: any) => void>>();
  constructor() { setTimeout(() => this.emit("open"), 0); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() {}
  close() {}
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function client() {
  return {
    from(table: string) {
      let updatedRow: any = null;
      const api: any = {
        select() { return api; }, eq() { return api; },
        insert(row: Record<string, unknown>) {
          if (table === "calls") {
            callInserts += 1;
            callInsertRows.push(structuredClone(row));
          }
          return api;
        },
        update(row: any) {
          updatedRow = row;
          if (table === "calls") callUpdates.push(row);
          if (table === "budget_reservations") budgetUpdates.push(row);
          return api;
        },
        single: async () => table === "tenants"
          ? { data: TENANT, error: null }
          : table === "calls"
            ? { data: { id: callInsertRows.at(-1)?.id ?? "call-1" }, error: null }
            : { data: null, error: null },
        maybeSingle: async () => {
          if (table !== "calls") return { data: null, error: null };
          if (updatedRow?.provider_termination_reason ===
            "provider_create_inflight") {
            if (providerMarkerGate) await providerMarkerGate;
            return {
              data: {
                id: String(callInsertRows.at(-1)?.id ?? "call-1"),
                tenant_id: TENANT.id,
                status: "active",
                openai_call_id: null,
                ...structuredClone(updatedRow),
              },
              error: null,
            };
          }
          if (updatedRow?.provider_termination_reason === "tts_inflight")
            return {
              data: {
                id: String(callInsertRows.at(-1)?.id ?? "call-1"),
                tenant_id: TENANT.id,
                status: "active",
                ...structuredClone(updatedRow),
              },
              error: null,
            };
          if (updatedRow && typeof updatedRow.openai_call_id === "string") {
            if (providerIdentityMode === "error")
              return { data: null, error: { message: "identity write failed" } };
            if (providerIdentityMode === "zero")
              return { data: null, error: null };
            durableProviderIdentity = {
              id: String(callInsertRows.at(-1)?.id ?? "call-1"),
              tenant_id: TENANT.id,
              status: "active",
              ...structuredClone(updatedRow),
            };
            return { data: structuredClone(durableProviderIdentity), error: null };
          }
          if (updatedRow && typeof updatedRow.cost_estimate_usd === "number") {
            if (floorWriteMode === "unproven")
              return { data: null, error: { message: "floor write unknown" } };
            durableFloor = updatedRow.cost_estimate_usd;
            if (floorWriteMode === "throw_exact")
              throw new TypeError("floor write transport lost after commit");
            return {
              data: { id: String(callInsertRows.at(-1)?.id ?? "call-1"), tenant_id: TENANT.id,
                status: "active",
                ...structuredClone(updatedRow) },
              error: null,
            };
          }
          if (durableProviderIdentity)
            return { data: structuredClone(durableProviderIdentity), error: null };
          return durableFloor === null
            ? { data: null, error: { message: "floor absent" } }
            : {
                data: { id: String(callInsertRows.at(-1)?.id ?? "call-1"), tenant_id: TENANT.id,
                  status: "active",
                  cost_estimate_usd: durableFloor,
                  provider_termination_state: "not_required",
                  provider_termination_reason: "tts_resolved",
                  provider_usage_state: "resolved" },
                error: null,
              };
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: table === "effective_rules" ? [] : null, error: null }).then(resolve);
        },
      };
      return api;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "reserve_call_budget") {
        if (reserveGate) await reserveGate;
        return { data: reserveError ? null : "reservation-1", error: reserveError };
      }
      if (name === "settle_call_budget") {
        return Promise.resolve({ data: "reservation-1", error: null });
      }
      if (name === "begin_provider_termination_attempt") {
        const callId = String(args.p_call_id);
        if (providerAttempts.has(callId)) return Promise.resolve({ data: { should_attempt: false }, error: null });
        providerAttempts.add(callId);
        return Promise.resolve({ data: {
          should_attempt: true,
          attempt_id: "91000000-0000-4000-8000-000000000001",
          request_id: "91000000-0000-4000-8000-000000000001",
          openai_call_id: args.p_openai_call_id,
          provider_termination_mode: args.p_mode,
        }, error: null });
      }
      if (name === "complete_provider_termination_attempt") {
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  reserveError = null;
  rpcCalls = [];
  config.openaiKey = originalOpenAiKey;
  config.sessionCostCeilingUsd = originalCeiling;
  (config as any).realtimeCreateTimeoutMs = originalProviderCreateTimeoutMs;
  (config as any).sidebandOpenTimeoutMs = originalSidebandOpenTimeoutMs;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  fetchUrls = [];
  callUpdates = [];
  budgetUpdates = [];
  providerAttempts = new Set();
  callInserts = 0;
  callInsertRows = [];
  floorWriteMode = "success";
  durableFloor = null;
  providerIdentityMode = "success";
  durableProviderIdentity = null;
  reserveGate = null;
  providerMarkerGate = null;
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});

afterEach(() => {
  config.openaiKey = originalOpenAiKey;
  config.sessionCostCeilingUsd = originalCeiling;
  (config as any).realtimeCreateTimeoutMs = originalProviderCreateTimeoutMs;
  (config as any).sidebandOpenTimeoutMs = originalSidebandOpenTimeoutMs;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

afterAll(() => _setClient(null));

describe("session budget lifecycle", () => {
  test("onboarding rejects missing or provider opening mode before call, budget, TTS, or Realtime", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new Error("provider must remain unreachable");
    };
    for (const options of [
      undefined,
      {
        browserRequestId: "stale-provider-request",
        openingModeRequested: "provider_model_v1" as const,
      },
    ]) {
      invalidateTenant("rocha-plumbing");
      await expect(startSession(
        "owner-1",
        "onboarding",
        "test-sdp",
        undefined,
        TENANT.id,
        undefined,
        options,
      )).rejects.toMatchObject({
        message: "client_upgrade_required",
        status: 409,
      });
    }
    expect(callInserts).toBe(0);
    expect(rpcCalls.filter((call) => call.name === "reserve_call_budget"))
      .toHaveLength(0);
    expect(fetchUrls).toEqual([]);
  });

  test("session ceiling defaults to the primary maximum and rejects unbounded overrides", () => {
    expect(typeof configModule.parseSessionCostCeilingUsd).toBe("function");
    expect(configModule.parseSessionCostCeilingUsd(undefined)).toBe(1.5);
    expect(configModule.parseSessionCostCeilingUsd("2.75")).toBe(2.75);
    for (const value of ["0", "-1", "5.01", "NaN", "Infinity", "1.23456"]) {
      expect(() => configModule.parseSessionCostCeilingUsd(value)).toThrow("session_cost_ceiling_invalid");
    }
    expect(configModule.parseRealtimeCreateTimeoutMs(undefined)).toBe(6_000);
    expect(configModule.parseSidebandOpenTimeoutMs(undefined)).toBe(5_000);
    for (const value of ["999", "10001", "NaN"])
      expect(() => configModule.parseRealtimeCreateTimeoutMs(value))
        .toThrow("realtime_create_timeout_invalid");
    for (const value of ["249", "6001", "NaN"])
      expect(() => configModule.parseSidebandOpenTimeoutMs(value))
        .toThrow("sideband_open_timeout_invalid");
  });

  test("reserves the same validated ceiling used by the live cost kill switch", async () => {
    config.sessionCostCeilingUsd = 2.75;
    reserveError = { message: "budget cap" };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "budget_exceeded",
      status: 402,
    });

    const reservation = rpcCalls.find((call) => call.name === "reserve_call_budget");
    expect(reservation?.args.p_est_cost).toBe(2.75);
  });

  test("onboarding reserves its isolated USD 7.50 envelope without changing the customer ceiling", async () => {
    config.openaiKey = "synthetic-openai-key";
    reserveError = { message: "stop after reservation" };

    await expect(startSession(
      "owner-1",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-budget-envelope",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({ message: "budget_exceeded", status: 402 });

    expect(rpcCalls.find((call) => call.name === "reserve_call_budget")?.args)
      .toMatchObject({ p_est_cost: 7.5 });

    rpcCalls = [];
    invalidateTenant("rocha-plumbing");
    await expect(startSession(
      "owner-1",
      "owner_browser",
      "test-sdp",
    )).rejects.toMatchObject({ message: "budget_exceeded", status: 402 });
    expect(rpcCalls.find((call) => call.name === "reserve_call_budget")?.args)
      .toMatchObject({ p_est_cost: 1.5 });
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

  test("all definitive browser 4xx responses remain a safe not-applicable zero settlement", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("model rejected", { status: 400 });
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "realtime_unavailable",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(2);
    expect(callUpdates.some((row) => row.provider_usage_state === "not_applicable"
      && row.cost_estimate_usd === 0)).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
  });

  const assertUnknownProviderRemainsDiscoverable = () => {
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(callUpdates.some((row) => row.status === "error"
      && row.provider_usage_state === "unknown"
      && row.cost_estimate_usd === null)).toBe(true);
    expect(budgetUpdates.some((row) => row.reconcile_lease_until === null && row.reconcile_last_error)).toBe(true);
  };

  const providerCreationRequests = () => fetchUrls.filter((url) => url.endsWith("/v1/realtime/calls"));

  test("application opening spends TTS only after reservation and before Realtime, then settles its known cost on definitive provider rejection", async () => {
    config.openaiKey = "synthetic-openai-key";
    floorWriteMode = "throw_exact";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech")) {
        expect(rpcCalls.some((call) => call.name === "reserve_call_budget"))
          .toBe(true);
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "tts-1",
          voice: "ash",
          input: "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
          response_format: "mp3",
        });
        return new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      expect(fetchUrls[0]).toBe("https://api.openai.com/v1/audio/speech");
      expect(callUpdates).toContainEqual(expect.objectContaining({
        cost_estimate_usd: 0.00162,
        provider_termination_reason: "tts_resolved",
        provider_usage_state: "resolved",
      }));
      expect(durableFloor).toBe(0.00162);
      expect(callUpdates).toContainEqual(expect.objectContaining({
        provider_termination_state: "unknown",
        provider_termination_mode: "hangup",
        provider_termination_reason: "provider_create_inflight",
      }));
      return new Response("model rejected", { status: 400 });
    };

    await expect(startSession(
      "owner-1",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-test-10",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "realtime_unavailable",
      status: 502,
    });

    expect(fetchUrls).toEqual([
      "https://api.openai.com/v1/audio/speech",
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls",
    ]);
    expect(callInsertRows[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111119",
      session_type: "onboarding",
    });
    expect(rpcCalls.find((call) => call.name === "settle_call_budget")?.args)
      .toMatchObject({ p_actual_cost: 0.00162, p_outcome: "startup_error" });
    expect(callUpdates).toContainEqual(expect.objectContaining({
      provider_usage_state: "not_applicable",
      cost_estimate_usd: 0.00162,
    }));
  });

  test("cancellation during held budget reservation prevents every TTS/provider step and releases the reservation", async () => {
    config.openaiKey = "synthetic-openai-key";
    let releaseReserve!: () => void;
    reserveGate = new Promise<void>((resolve) => { releaseReserve = resolve; });
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-reserve",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleanup).not.toBeNull();
    const cancelled = cleanup!.cancel("edge_cancel_held_reserve");
    expect(fetchUrls).toEqual([]);
    releaseReserve();
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
      status: 499,
    });
    expect(fetchUrls).toEqual([]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(1);
    expect(callUpdates.filter((row) => row.status === "error")).toHaveLength(1);
  });

  test("TTS success racing cancellation preserves the exact floor and never starts Realtime", async () => {
    config.openaiKey = "synthetic-openai-key";
    let resolveTts!: (response: Response) => void;
    let ttsSignal: AbortSignal | null = null;
    globalThis.fetch = async (input, init) => {
      fetchUrls.push(String(input));
      ttsSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((resolve) => { resolveTts = resolve; });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-tts",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!resolveTts) await new Promise((resolve) => setImmediate(resolve));
    const cancelled = cleanup!.cancel("edge_cancel_held_tts");
    resolveTts(new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }));
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(ttsSignal?.aborted).toBe(true);
    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00162,
      provider_usage_state: "resolved",
      provider_termination_state: "not_required",
    }));
  });

  test("HTTP 200 TTS body abort preserves known cost as resolved before cancellation settlement", async () => {
    config.openaiKey = "synthetic-openai-key";
    let bodyStarted = false;
    globalThis.fetch = async (input, init) => {
      fetchUrls.push(String(input));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyStarted = true;
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-tts-body-abort",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!bodyStarted) await new Promise((resolve) => setImmediate(resolve));
    await cleanup!.cancel("edge_cancel_tts_body");
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00162,
      provider_usage_state: "resolved",
      provider_termination_state: "not_required",
    }));
  });

  test("cancellation while provider marker is held retains the TTS floor and performs no provider POST", async () => {
    config.openaiKey = "synthetic-openai-key";
    let releaseMarker!: () => void;
    providerMarkerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-marker",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!providerMarkerGate || callUpdates.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    const cancelled = cleanup!.cancel("edge_cancel_held_marker");
    releaseMarker();
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00162,
      provider_usage_state: "resolved",
      provider_termination_state: "not_required",
    }));
  });

  test("cancellation during held provider POST aborts the chain without fallback or ready", async () => {
    config.openaiKey = "synthetic-openai-key";
    let providerSignal: AbortSignal | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      providerSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-provider",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!providerSignal) await new Promise((resolve) => setImmediate(resolve));
    await cleanup!.cancel("edge_cancel_held_provider");
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(providerSignal?.aborted).toBe(true);
    expect(providerCreationRequests()).toHaveLength(1);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00162,
      provider_usage_state: "unknown",
      provider_termination_state: "unknown",
    }));
  });

  test("an unprovable TTS cost floor never opens Realtime and settles or defers the known charge", async () => {
    config.openaiKey = "synthetic-openai-key";
    floorWriteMode = "unproven";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response(audio, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };

    await expect(startSession(
      "owner-1",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-floor-unproven",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_tts_cost_floor_unproven",
      status: 503,
    });
    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(providerCreationRequests()).toHaveLength(0);
    expect(rpcCalls.find((call) => call.name === "settle_call_budget")?.args)
      .toMatchObject({ p_actual_cost: 0.00162, p_outcome: "startup_error" });
  });

  test("definitive TTS rejection settles zero without opening Realtime", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("rejected", { status: 400 });
    };

    await expect(startSession(
      "owner-1",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-tts-rejected",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_tts_rejected",
      status: 502,
    });

    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(providerCreationRequests()).toHaveLength(0);
    expect(rpcCalls.find((call) => call.name === "settle_call_budget")?.args)
      .toMatchObject({ p_actual_cost: 0, p_outcome: "startup_error" });
  });

  test("indeterminate TTS transport defers the reservation and never opens Realtime", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new TypeError("synthetic TTS transport loss");
    };

    await expect(startSession(
      "owner-1",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-tts-unknown",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_tts_outcome_unknown",
      status: 503,
    });

    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(providerCreationRequests()).toHaveLength(0);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("unknown Realtime startup preserves the already durable TTS floor", async () => {
    config.openaiKey = "synthetic-openai-key";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      throw new TypeError("synthetic Realtime transport loss");
    };
    await expect(startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      undefined,
      {
        browserRequestId: "request-realtime-unknown-floor",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({ message: "provider_outcome_unknown" });
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0.00162,
    }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(0);
  });

  test("post-start cleanup preserves the TTS floor while Realtime usage is unresolved", async () => {
    config.openaiKey = "synthetic-openai-key";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      if (url.endsWith("/v1/realtime/calls"))
        return new Response("answer-sdp", {
          status: 200,
          headers: { Location: "/v1/realtime/calls/rtc-cleanup-floor" },
        });
      return new Response(null, { status: 200 });
    };
    globalThis.WebSocket = AutoOpenWebSocket as any;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    await startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-cleanup-floor",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    await cleanup!.cancel("ready_write_unknown");
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0.00162,
    }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(0);
  });

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

    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("Realtime SDP creation and body share a bounded deadline below the Edge processing expiry", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).realtimeCreateTimeoutMs = 10;
    globalThis.fetch = async (input, init) => {
      fetchUrls.push(String(input));
      return await new Promise<Response>((resolve, reject) => {
        const delayed = setTimeout(() =>
          resolve(new Response("late rejection", { status: 400 })), 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(delayed);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const started = performance.now();
    await expect(startSession(
      "owner-1", "owner_browser", "test-sdp",
    )).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });
    expect(performance.now() - started).toBeLessThan(80);
    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("Realtime SDP body read is covered by the same provider deadline", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).realtimeCreateTimeoutMs = 10;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const delayed = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("late-sdp"));
            controller.close();
          }, 100);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(delayed);
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-body-timeout" },
      });
    };
    const started = performance.now();
    await expect(startSession(
      "owner-1", "owner_browser", "test-sdp",
    )).rejects.toMatchObject({ message: "provider_outcome_unknown" });
    expect(performance.now() - started).toBeLessThan(80);
    expect(fetchUrls).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls/rtc-body-timeout/hangup",
    ]);
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

    expect(providerCreationRequests()).toHaveLength(1);
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

    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("5xx with Location confirms hangup but keeps usage unresolved", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("provider internal error", { status: 503, headers: { Location: "/v1/realtime/calls/rtc-ambiguous" } })
        : new Response(null, { status: 200 });
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.some((url) => url.endsWith("/rtc-ambiguous/hangup"))).toBe(true);
    expect(rpcCalls.some((call) => call.name === "complete_provider_termination_attempt"
      && call.args.p_confirmed === true)).toBe(true);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("body read failure after Location hangs up but keeps usage unresolved", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ Location: "/v1/realtime/calls/rtc-body-failed" }),
          text: async () => { throw new Error("SDP body transport failed"); },
        } as Response;
      }
      return new Response(null, { status: 200 });
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.some((url) => url.endsWith("/rtc-body-failed/hangup"))).toBe(true);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("empty SDP after Location is ambiguous and cannot fall back or settle", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("   \n", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-empty-sdp" } })
        : new Response(null, { status: 200 });
    };

    await expect(startSession("owner-1", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.some((url) => url.endsWith("/rtc-empty-sdp/hangup"))).toBe(true);
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
    globalThis.WebSocket = AutoOpenWebSocket as any;

    const result = await startSession("owner-1", "owner_browser", "test-sdp");

    expect(fetchUrls).toHaveLength(2);
    expect(result.fell_back).toBe(true);
    expect(result).toMatchObject({
      opening_mode_applied: "provider_model_v1",
      opening_payload: null,
    });
    expect(callUpdates.some((row) => row.openai_call_id === "rtc-fallback" && row.provider_termination_state === "active")).toBe(true);
    expect(callUpdates.filter((row) =>
      row.provider_termination_state === "unknown"
    )).toEqual([
      expect.objectContaining({
        provider_termination_reason: "provider_create_inflight",
      }),
    ]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("unproven provider identity never reaches sideband or ready and terminates by the in-memory provider ID", async () => {
    for (const mode of ["error", "zero"] as const) {
      providerAttempts = new Set();
      durableProviderIdentity = null;
      durableFloor = null;
      callUpdates = [];
      budgetUpdates = [];
      rpcCalls = [];
      providerIdentityMode = mode;
      config.openaiKey = "synthetic-openai-key";
      fetchUrls = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        fetchUrls.push(url);
        if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
        return new Response("answer-sdp", {
          status: 200,
          headers: { Location: "/v1/realtime/calls/rtc-identity-unproven" },
        });
      };
      let sockets = 0;
      globalThis.WebSocket = class {
        constructor() { sockets += 1; }
      } as any;
      await expect(startSession(
        "owner-1", "owner_browser", "test-sdp",
      )).rejects.toMatchObject({
        message: "provider_identity_unproven",
        status: 503,
      });
      expect(sockets).toBe(0);
      expect(fetchUrls).toContain(
        "https://api.openai.com/v1/realtime/calls/rtc-identity-unproven/hangup",
      );
      expect(callUpdates).toContainEqual(expect.objectContaining({
        status: "error",
        provider_usage_state: "unknown",
      }));
      providerIdentityMode = "success";
    }
  });

  test("startSession does not publish SDP until the first sideband socket is open", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-await-open" },
      });
    };
    class DelayedOpenSocket {
      static instance: DelayedOpenSocket | null = null;
      listeners = new Map<string, Array<(event: any) => void>>();
      constructor() { DelayedOpenSocket.instance = this; }
      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send() {}
      close() {}
      emit(type: string, event: any = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = DelayedOpenSocket as any;
    let settled = false;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-await-sideband-open",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    ).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    DelayedOpenSocket.instance!.emit("open");
    const result = await pending;
    expect(result.sdp).toBe("answer-sdp");
    await cleanup!.cancel("test_cleanup");
  });

  test("non-onboarding sessions preserve asynchronous sideband-open behavior", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-legacy-open" },
      });
    };
    globalThis.WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    } as any;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const result = await startSession(
      "owner-1", "owner_browser", "test-sdp", undefined, undefined,
      (control) => { cleanup = control; },
    );
    expect(result.sdp).toBe("answer-sdp");
    await cleanup!.cancel("test_cleanup");
  });

  test("sideband open timeout cleans up the accepted provider call before any ready result", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).sidebandOpenTimeoutMs = 10;
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-open-timeout" },
      });
    };
    globalThis.WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    } as any;
    await expect(startSession(
      "owner-1", "onboarding", "test-sdp", undefined, TENANT.id,
      undefined,
      {
        browserRequestId: "request-sideband-open-timeout",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "sideband_open_timeout",
      status: 502,
    });
    expect(fetchUrls).toContain(
      "https://api.openai.com/v1/realtime/calls/rtc-open-timeout/hangup",
    );
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0.00162,
    }));
  });

  test("accepted browser call attach failure confirms hangup but keeps unknown usage active", async () => {
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
    assertUnknownProviderRemainsDiscoverable();
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
