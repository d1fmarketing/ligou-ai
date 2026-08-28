import { beforeEach, describe, expect, test } from "bun:test";

type BrowserHandler = (request: Request) => Promise<Response>;

const TENANT = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "ligou-22222222",
  name: "D1F Marketing",
  owner_user_id: "owner-a",
};
const PAYLOAD = {
  version: 1,
  item_id: `lgo-${"c".repeat(28)}`,
  text: "Oi. Aqui e o Ligou, agente de inteligencia artificial da D1F Marketing.",
  text_sha256: "a".repeat(64),
  audio_base64: "SUQzBA==",
  audio_sha256: "b".repeat(64),
  mime: "audio/mpeg",
  voice: "ash",
  tts_model: "tts-1",
  cost_usd: 0.001,
};

let handler: BrowserHandler | undefined;
let currentClient: ReturnType<typeof edgeClient>;
const edgeModule = await import("../../supabase/functions/browser-session/core.ts").catch(() => ({}));
const createBrowserSessionHandler = (edgeModule as {
  createBrowserSessionHandler?: (dependencies: Record<string, unknown>) => BrowserHandler;
}).createBrowserSessionHandler;

function edgeClient(options: {
  readyRow?: Record<string, unknown>;
  readyRows?: Record<string, unknown>[];
  updateResults?: Array<{ data: Record<string, unknown>[]; error: unknown }>;
  model?: string;
} = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const selections: Array<{ table: string; columns: string; operation: string }> = [];
  const readyRow = options.readyRow ?? {
    status: "ready",
    answer_sdp: "answer-sdp",
    call_id: "33333333-3333-4333-8333-333333333333",
    error: null,
    opening_mode_applied: "application_tts_v1",
    opening_payload: PAYLOAD,
  };
  const readyRows = [...(options.readyRows ?? [])];
  const updateResults = [...(options.updateResults ?? [])];

  return {
    inserts,
    updates,
    selections,
    from(table: string) {
      let operation: "insert" | "select" | "update" | null = null;
      let updateRecord: Record<string, unknown> | null = null;
      const api: any = {
        select(columns: string) {
          const selectedOperation = operation ?? "select";
          operation = operation ?? "select";
          selections.push({ table, columns, operation: selectedOperation });
          return api;
        },
        eq(column: string, value: unknown) {
          const filters = updateRecord?.filters as Record<string, unknown> | undefined;
          if (filters) filters[column] = value;
          return api;
        },
        in(column: string, values: unknown[]) {
          const filters = updateRecord?.filters as Record<string, unknown> | undefined;
          if (filters) filters[column] = { in: values };
          return api;
        },
        is(column: string, value: unknown) {
          const filters = updateRecord?.filters as Record<string, unknown> | undefined;
          if (filters) filters[column] = { is: value };
          return api;
        },
        order() { return api; },
        limit: async () => table === "tenants"
          ? { data: [{ ...TENANT }], error: null }
          : { data: [], error: null },
        insert(row: Record<string, unknown>) {
          operation = "insert";
          inserts.push({ table, ...row });
          return api;
        },
        update(patch: Record<string, unknown>) {
          operation = "update";
          updateRecord = { table, patch, filters: {} };
          updates.push(updateRecord);
          return api;
        },
        single: async () => {
          if (table === "browser_session_requests" && operation === "insert") {
            return { data: { id: "request-1" }, error: null };
          }
          if (table === "browser_session_requests") {
            return { data: readyRows.shift() ?? readyRow, error: null };
          }
          if (table === "calls") return { data: { model: options.model ?? "gpt-realtime-2.1" }, error: null };
          return { data: null, error: { message: `unexpected_single_${table}` } };
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          const result = operation === "update"
            ? updateResults.shift() ?? {
              data: [{
                id: "request-1",
                status: "expired",
                call_id: null,
                answer_sdp: null,
                opening_mode_applied: null,
                opening_payload: null,
              }],
              error: null,
            }
            : { data: null, error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

function request(body: Record<string, unknown>, signal?: AbortSignal) {
  return new Request("https://example.supabase.co/functions/v1/browser-session", {
    method: "POST",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
    body: JSON.stringify({ sdp: "offer-sdp", ...body }),
    signal,
  });
}

function buildHandler(overrides: Record<string, unknown> = {}) {
  return createBrowserSessionHandler?.({
    env: (name: string) => name === "SUPABASE_URL" ? "https://example.supabase.co" : "test-secret",
    createClient: () => currentClient,
    fetch: async () => Response.json({ id: "owner-a" }),
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  });
}

beforeEach(() => {
  currentClient = edgeClient();
  handler = buildHandler();
});

describe("browser-session opening contract", () => {
  test("rejects a stale onboarding client before it can enqueue work", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    for (const body of [
      { session_type: "onboarding" },
      { session_type: "onboarding", opening_mode_requested: "provider_model_v1" },
      { session_type: "onboarding", opening_mode_requested: "unknown" },
    ]) {
      currentClient = edgeClient();
      const response = await handler!(request(body));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "client_upgrade_required" });
      expect(currentClient.inserts).toHaveLength(0);
    }
  });

  test("binds an application opening to the authenticated tenant and ignores browser payload fields", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    currentClient = edgeClient();
    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      opening_mode_applied: "provider_model_v1",
      opening_payload: { ...PAYLOAD, text: "browser spoof" },
      business_name: "Browser Spoof LLC",
    }));

    expect(response.status).toBe(200);
    expect(currentClient.inserts).toEqual([{
      table: "browser_session_requests",
      tenant_id: TENANT.id,
      user_id: "owner-a",
      session_type: "onboarding",
      model_override: null,
      offer_sdp: "offer-sdp",
      opening_mode_requested: "application_tts_v1",
    }]);
    expect(await response.json()).toEqual({
      sdp: "answer-sdp",
      call_id: "33333333-3333-4333-8333-333333333333",
      max_minutes: 30,
      model: "gpt-realtime-2.1",
      opening_mode_applied: "application_tts_v1",
      opening_payload: PAYLOAD,
      business_name: "D1F Marketing",
    });
  });

  test("fails closed when ready onboarding state is partial or malformed", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    for (const readyRow of [
      {
        status: "ready", answer_sdp: "answer-sdp", call_id: "call-1", error: null,
        opening_mode_applied: null, opening_payload: null,
      },
      {
        status: "ready", answer_sdp: "answer-sdp", call_id: "call-1", error: null,
        opening_mode_applied: "application_tts_v1", opening_payload: { ...PAYLOAD, extra: true },
      },
      {
        status: "ready", answer_sdp: "answer-sdp", call_id: "call-1", error: null,
        opening_mode_applied: "application_tts_v1",
        opening_payload: { ...PAYLOAD, item_id: `lgo-${"d".repeat(29)}` },
      },
      {
        status: "ready", answer_sdp: "answer-sdp", call_id: "call-1", error: null,
        opening_mode_applied: "provider_model_v1", opening_payload: null,
      },
    ]) {
      currentClient = edgeClient({ readyRow });
      const response = await handler!(request({ session_type: "onboarding", opening_mode_requested: "application_tts_v1" }));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "invalid_application_opening_contract" });
    }
  });

  test("keeps non-onboarding customer sessions on the provider-owned opening path", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    currentClient = edgeClient({ readyRow: {
      status: "ready",
      answer_sdp: "customer-answer-sdp",
      call_id: "44444444-4444-4444-8444-444444444444",
      error: null,
      opening_mode_applied: "provider_model_v1",
      opening_payload: null,
    } });
    const response = await handler!(request({ session_type: "customer" }));

    expect(response.status).toBe(200);
    expect(currentClient.inserts[0]).toMatchObject({
      session_type: "customer",
      opening_mode_requested: "provider_model_v1",
    });
    expect(await response.json()).toMatchObject({
      sdp: "customer-answer-sdp",
      max_minutes: 15,
      opening_mode_applied: "provider_model_v1",
      opening_payload: null,
      business_name: "D1F Marketing",
    });
  });

  test("an already-aborted request never enqueues browser work", async () => {
    const abort = new AbortController();
    abort.abort();

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }, abort.signal));

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "request_aborted" });
    expect(currentClient.inserts).toHaveLength(0);
    expect(currentClient.updates).toHaveLength(0);
  });

  test("an abort after enqueue expires exactly one pending or processing row and stops polling", async () => {
    for (const status of ["pending", "processing"]) {
      const abort = new AbortController();
      currentClient = edgeClient({ readyRow: {
        status,
        answer_sdp: null,
        call_id: null,
        error: null,
        opening_mode_applied: null,
        opening_payload: null,
      } });
      const times = [0, 0, 20_001];
      handler = buildHandler({
        sleep: async () => { abort.abort(); },
        now: () => times.shift() ?? 20_001,
      });

      const response = await handler!(request({
        session_type: "onboarding",
        opening_mode_requested: "application_tts_v1",
      }, abort.signal));

      expect(response.status).toBe(499);
      expect(await response.json()).toEqual({ error: "request_aborted" });
      expect(currentClient.updates).toEqual([{
        table: "browser_session_requests",
        patch: { status: "expired", error: "request_aborted" },
        filters: {
          id: "request-1",
          status: { in: ["pending", "processing"] },
          call_id: { is: null },
        },
      }]);
      expect(currentClient.selections.some(({ columns, operation }) =>
        operation === "select" && columns.startsWith("status,answer_sdp"))).toBe(false);
    }
  });

  test("a zero-row open expiry reconciles an exact ready race through cancel_requested ACK", async () => {
    const abort = new AbortController();
    const callId = "66666666-6666-4666-8666-666666666666";
    const ready = {
      id: "request-1",
      status: "ready",
      session_type: "onboarding",
      call_id: callId,
      answer_sdp: "race-answer-sdp",
      error: null,
      opening_mode_requested: "application_tts_v1",
      opening_mode_applied: "application_tts_v1",
      opening_payload: PAYLOAD,
    };
    const cancelRequested = { ...ready, status: "cancel_requested", error: "request_aborted" };
    const expired = {
      ...ready,
      status: "expired",
      error: "request_aborted",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
    };
    currentClient = edgeClient({
      readyRows: [ready, expired],
      updateResults: [
        { data: [], error: null },
        { data: [cancelRequested], error: null },
      ],
    });
    handler = buildHandler({ sleep: async () => { abort.abort(); } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }, abort.signal));

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "request_aborted" });
    expect(currentClient.updates).toEqual([
      {
        table: "browser_session_requests",
        patch: { status: "expired", error: "request_aborted" },
        filters: {
          id: "request-1",
          status: { in: ["pending", "processing"] },
          call_id: { is: null },
        },
      },
      {
        table: "browser_session_requests",
        patch: { status: "cancel_requested", error: "request_aborted" },
        filters: { id: "request-1", status: "ready", call_id: callId },
      },
    ]);
  });

  test("provider customer ready race fails cleanup without introducing cancel_requested", async () => {
    const abort = new AbortController();
    currentClient = edgeClient({
      readyRows: [{
        id: "request-1",
        status: "ready",
        session_type: "customer",
        call_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        answer_sdp: "provider-answer",
        error: null,
        opening_mode_requested: "provider_model_v1",
        opening_mode_applied: "provider_model_v1",
        opening_payload: null,
      }],
      updateResults: [{ data: [], error: null }],
    });
    handler = buildHandler({ sleep: async () => { abort.abort(); } });

    const response = await handler!(request({ session_type: "customer" }, abort.signal));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "request_cleanup_failed" });
    expect(currentClient.updates).toHaveLength(1);
  });

  test("application processing early-bind race transitions through cancel_requested ACK", async () => {
    const abort = new AbortController();
    const callId = "abababab-abab-4bab-8bab-abababababab";
    const processing = {
      id: "request-1",
      status: "processing",
      session_type: "onboarding",
      call_id: callId,
      answer_sdp: null,
      error: null,
      opening_mode_requested: "application_tts_v1",
      opening_mode_applied: null,
      opening_payload: null,
    };
    const cancelRequested = { ...processing, status: "cancel_requested", error: "request_aborted" };
    const expired = { ...cancelRequested, status: "expired" };
    currentClient = edgeClient({
      readyRows: [processing, expired],
      updateResults: [
        { data: [], error: null },
        { data: [cancelRequested], error: null },
      ],
    });
    handler = buildHandler({ sleep: async () => { abort.abort(); } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }, abort.signal));

    expect(response.status).toBe(499);
    expect(currentClient.updates[1]).toEqual({
      table: "browser_session_requests",
      patch: { status: "cancel_requested", error: "request_aborted" },
      filters: { id: "request-1", status: "processing", call_id: callId },
    });
  });

  test("a zero-row expiry never reports cleanup success for malformed ready state", async () => {
    const abort = new AbortController();
    currentClient = edgeClient({
      readyRows: [{
        id: "request-1",
        status: "ready",
        call_id: "77777777-7777-4777-8777-777777777777",
        answer_sdp: "malformed-answer",
        error: null,
        opening_mode_requested: "application_tts_v1",
        opening_mode_applied: "provider_model_v1",
        opening_payload: null,
      }],
      updateResults: [{ data: [], error: null }],
    });
    handler = buildHandler({ sleep: async () => { abort.abort(); } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }, abort.signal));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "request_cleanup_failed" });
  });

  test("a competing cleanup that already reached cancel_requested remains idempotent", async () => {
    const abort = new AbortController();
    const callId = "88888888-8888-4888-8888-888888888888";
    const ready = {
      id: "request-1",
      status: "ready",
      session_type: "onboarding",
      call_id: callId,
      answer_sdp: "race-answer-sdp",
      error: null,
      opening_mode_requested: "application_tts_v1",
      opening_mode_applied: "application_tts_v1",
      opening_payload: PAYLOAD,
    };
    const cancelRequested = { ...ready, status: "cancel_requested", error: "request_aborted" };
    const expired = {
      ...ready,
      status: "expired",
      error: "request_aborted",
      answer_sdp: null,
      opening_mode_applied: null,
      opening_payload: null,
    };
    currentClient = edgeClient({
      readyRows: [ready, cancelRequested, expired],
      updateResults: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    });
    handler = buildHandler({ sleep: async () => { abort.abort(); } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }, abort.signal));

    expect(response.status).toBe(499);
    expect(currentClient.updates).toHaveLength(2);
  });

  test("cancel_requested ACK wait is bounded at twelve seconds with restart margin", async () => {
    const abort = new AbortController();
    const callId = "99999999-9999-4999-8999-999999999999";
    const ready = {
      id: "request-1",
      status: "ready",
      session_type: "onboarding",
      call_id: callId,
      answer_sdp: "race-answer-sdp",
      error: null,
      opening_mode_requested: "application_tts_v1",
      opening_mode_applied: "application_tts_v1",
      opening_payload: PAYLOAD,
    };
    const cancelRequested = { ...ready, status: "cancel_requested", error: "request_aborted" };
    currentClient = edgeClient({
      readyRows: [ready, ...Array(60).fill(cancelRequested)],
      updateResults: [
        { data: [], error: null },
        { data: [cancelRequested], error: null },
      ],
    });
    let cleanupSleeps = 0;
    handler = buildHandler({ sleep: async () => {
      if (!abort.signal.aborted) abort.abort();
      else cleanupSleeps += 1;
    } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }, abort.signal));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "request_cleanup_failed" });
    expect(cleanupSleeps).toBe(60);
  });

  test("the internal deadline expires a processing row before returning 504", async () => {
    currentClient = edgeClient({ readyRow: {
      status: "processing",
      answer_sdp: null,
      call_id: null,
      error: null,
      opening_mode_applied: null,
      opening_payload: null,
    } });
    const times = [0, 0, 35_001];
    handler = buildHandler({ now: () => times.shift() ?? 20_001 });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }));

    expect(response.status).toBe(504);
    expect(currentClient.updates).toEqual([{
      table: "browser_session_requests",
      patch: { status: "expired", error: "controller_timeout" },
      filters: {
        id: "request-1",
        status: { in: ["pending", "processing"] },
        call_id: { is: null },
      },
    }]);
    expect(currentClient.selections.some(({ columns, operation }) =>
      operation === "select" && columns.startsWith("status,answer_sdp"))).toBe(false);
  });

  test("application TTS keeps its bounded startup window past the provider deadline", async () => {
    currentClient = edgeClient({ readyRows: [
      {
        status: "processing",
        answer_sdp: null,
        call_id: null,
        error: null,
        opening_mode_applied: null,
        opening_payload: null,
      },
      {
        status: "ready",
        answer_sdp: "application-answer-sdp",
        call_id: "55555555-5555-4555-8555-555555555555",
        error: null,
        opening_mode_applied: "application_tts_v1",
        opening_payload: PAYLOAD,
      },
    ] });
    const times = [0, 0, 20_001, 21_000, 22_000];
    handler = buildHandler({ now: () => times.shift() ?? 22_000 });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sdp: "application-answer-sdp",
      opening_mode_applied: "application_tts_v1",
    });
    expect(currentClient.updates).toHaveLength(0);
  });

  test("provider-owned customer startup retains the 20 second deadline", async () => {
    currentClient = edgeClient({ readyRow: {
      status: "processing",
      answer_sdp: null,
      call_id: null,
      error: null,
      opening_mode_applied: null,
      opening_payload: null,
    } });
    const times = [0, 0, 20_001];
    handler = buildHandler({ now: () => times.shift() ?? 20_001 });

    const response = await handler!(request({ session_type: "customer" }));

    expect(response.status).toBe(504);
    expect(currentClient.updates).toEqual([{
      table: "browser_session_requests",
      patch: { status: "expired", error: "controller_timeout" },
      filters: {
        id: "request-1",
        status: { in: ["pending", "processing"] },
        call_id: { is: null },
      },
    }]);
    expect(currentClient.selections.some(({ columns, operation }) =>
      operation === "select" && columns.startsWith("status,answer_sdp"))).toBe(false);
  });
});
