import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

type BrowserHandler = (request: Request) => Promise<Response>;

const TENANT = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "ligou-22222222",
  name: "D1F Marketing",
  owner_user_id: "owner-a",
};
const LEGACY_PAYLOAD = {
  version: 1,
  item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
  text:
    "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?",
  text_sha256:
    "413f79d3d184ea3985fdb593f99ac331c612c157e871034df0135f06a7817e06",
  audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
  audio_sha256:
    "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
  mime: "audio/mpeg",
  voice: "ash",
  tts_model: "tts-1",
  cost_usd: 0.001605,
};
const PAYLOAD = {
  version: 2,
  item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
  text:
    "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?",
  text_sha256:
    "413f79d3d184ea3985fdb593f99ac331c612c157e871034df0135f06a7817e06",
  audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
  audio_sha256:
    "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
  mime: "audio/mpeg",
  voice: "ash",
  tts_model: "tts-1-hd",
  cost_usd: 0.00321,
  resume_context: null,
};
const RESUME_CONTEXT = {
  coverage_receipt_id: "44444444-4444-4444-8444-444444444444",
  revision: 1,
  snapshot_digest: "c".repeat(64),
  next_action: {
    type: "ask",
    field: "area.coverage",
    question_pt: "Quais cidades e regiões sua empresa atende?",
  },
};
const RESUMED_PAYLOAD = {
  ...PAYLOAD,
  item_id: "lgo-b00cbaf9911210b676ace0d7dda5",
  text:
    "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Vamos continuar de onde paramos. Quais cidades e regiões sua empresa atende?",
  text_sha256:
    "643ca15a2dbc57364f4eca5ae9e846674df997f7837b42873c9998ed2ff5bbf3",
  cost_usd: 0.00444,
  resume_context: RESUME_CONTEXT,
};
const WEBSITE_QUESTION =
  "Eu já analisei seu website e encontrei as informações públicas básicas. Agora vou confirmar o que falta. Qual é o limite de negociação?";
const WEBSITE_CONTEXT = {
  ...RESUME_CONTEXT,
  next_action: {
    type: "ask",
    field: "authority.negotiate_floor",
    question_pt: WEBSITE_QUESTION,
  },
};
const WEBSITE_TEXT =
  `Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. ${WEBSITE_QUESTION}`;
const WEBSITE_PAYLOAD = {
  ...PAYLOAD,
  item_id: "lgo-c00cbaf9911210b676ace0d7dda5",
  text: WEBSITE_TEXT,
  text_sha256: createHash("sha256").update(WEBSITE_TEXT).digest("hex"),
  cost_usd: Number(([...WEBSITE_TEXT].length * 30 / 1_000_000).toFixed(8)),
  resume_context: WEBSITE_CONTEXT,
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
    onboarding_protocol_version: 2,
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
    body: JSON.stringify({ sdp: "offer-sdp", ...(body.session_type === "onboarding" ? { speech_contract_version: 2 } : {}), ...body }),
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

function invalidApplicationReady(overrides: Record<string, unknown> = {}) {
  return {
    id: "request-1",
    status: "ready",
    session_type: "onboarding",
    call_id: "33333333-3333-4333-8333-333333333333",
    answer_sdp: "invalid-ready-answer-sdp",
    error: null,
    opening_mode_requested: "application_tts_v1",
    opening_mode_applied: "application_tts_v1",
    opening_payload: { ...PAYLOAD, text: `${PAYLOAD.text} extra` },
    onboarding_protocol_version: 2,
    ...overrides,
  };
}

function invalidReadyAckScenario(ready: Record<string, unknown>) {
  const cancelRequested = {
    ...ready,
    status: "cancel_requested",
    error: "invalid_application_opening_contract",
  };
  const expired = {
    ...cancelRequested,
    status: "expired",
    answer_sdp: null,
    opening_mode_applied: null,
    opening_payload: null,
  };
  return {
    client: edgeClient({
      readyRows: [ready, expired],
      updateResults: [{ data: [cancelRequested], error: null }],
    }),
    cancelRequested,
    expired,
  };
}

beforeEach(() => {
  currentClient = edgeClient();
  handler = buildHandler();
});

describe("browser-session opening contract", () => {
  test("protocol3 returns exact nested persisted speech and preserves protocol identity", async () => {
    const speech = { schema: "onboarding.speech.v1", actionId: "a".repeat(64), interviewId: "33333333-3333-4333-8333-333333333333", callId: "33333333-3333-4333-8333-333333333333", revision: 0, kind: "ASK_NEXT_GAP", text: PAYLOAD.text, sourceDigest: "b".repeat(64), text_sha256: PAYLOAD.text_sha256, audio_base64: PAYLOAD.audio_base64, audio_sha256: PAYLOAD.audio_sha256, mime: "audio/mpeg", voice: "ash", tts_model: "tts-1-hd", cost_usd: PAYLOAD.cost_usd };
    const payload = { version: 3, item_id: `lgs-${speech.actionId.slice(0, 28)}`, speech };
    currentClient = edgeClient({ readyRow: { status: "ready", answer_sdp: "answer", call_id: speech.callId, opening_mode_applied: "application_tts_v1", opening_payload: payload, onboarding_protocol_version: 3 } });
    const response = await handler!(request({ session_type: "onboarding", opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 3 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.opening_payload).toEqual(payload);
    expect(body.onboarding_protocol_version).toBe(3);
    expect(body.max_minutes).toBe(55);
    expect(body).not.toHaveProperty("opening_text");
    expect(body).not.toHaveProperty("resume_context");
    expect(currentClient.inserts[0].onboarding_protocol_version).toBe(3);
  });

  test("protocol3 nested contract validates actual hashes and rejects flattening and changed bindings", () => {
    const speech = { schema: "onboarding.speech.v1", actionId: "a".repeat(64), interviewId: "33333333-3333-4333-8333-333333333333", callId: "33333333-3333-4333-8333-333333333333", revision: 0, kind: "ASK_NEXT_GAP", text: PAYLOAD.text, sourceDigest: "b".repeat(64), text_sha256: PAYLOAD.text_sha256, audio_base64: PAYLOAD.audio_base64, audio_sha256: PAYLOAD.audio_sha256, mime: "audio/mpeg", voice: "ash", tts_model: "tts-1-hd", cost_usd: PAYLOAD.cost_usd };
    const payload = { version: 3, item_id: `lgs-${speech.actionId.slice(0, 28)}`, speech };
    const validate = (edgeModule as any).isApplicationOpeningPayload;
    expect(validate(payload)).toBe(true);
    expect(validate({ ...payload, speech: { ...speech, interviewId: "55555555-5555-4555-8555-555555555555" } })).toBe(true);
    for (const changed of [{ text_sha256: "c".repeat(64) }, { audio_sha256: "c".repeat(64) }, { callId: "invalid" }, { actionId: "c".repeat(64) }, { kind: "generic_chat" }, { cost_usd: 0 }, { revision: -1 }, { audio_base64: "bm90bXAz", audio_sha256: createHash("sha256").update("notmp3").digest("hex") }])
      expect(validate({ ...payload, speech: { ...speech, ...changed } })).toBe(false);
    expect(validate({ ...payload, extra: true })).toBe(false);
    expect(validate({ version: 3, item_id: payload.item_id, ...speech })).toBe(false);
  });

  test("dual-validates legacy v1 and exact v2 payloads", () => {
    const validate = (edgeModule as any).isApplicationOpeningPayload;
    expect(validate).toBeFunction();
    expect(validate(LEGACY_PAYLOAD)).toBe(true);
    expect(validate(PAYLOAD)).toBe(true);
    expect(validate(RESUMED_PAYLOAD)).toBe(true);
    expect(validate({ ...PAYLOAD, resume_context: undefined })).toBe(false);
    expect(validate({ ...RESUMED_PAYLOAD, tts_model: "tts-1" })).toBe(false);
  });

  test("rejects a stale onboarding client before it can enqueue work", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    for (const body of [
      { session_type: "onboarding" },
      { session_type: "onboarding", opening_mode_requested: "provider_model_v1" },
      { session_type: "onboarding", opening_mode_requested: "unknown" },
      {
        session_type: "onboarding",
        opening_mode_requested: "application_tts_v1",
      },
      {
        session_type: "onboarding",
        opening_mode_requested: "application_tts_v1",
        onboarding_protocol_version: 1,
      },
      {
        session_type: "onboarding",
        opening_mode_requested: "application_tts_v1",
        onboarding_protocol_version: "2",
      },
    ]) {
      currentClient = edgeClient();
      const response = await handler!(request(body));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "client_upgrade_required" });
      expect(currentClient.inserts).toHaveLength(0);
    }
  });

  test("persists protocol 2 and returns exact resumed context, business, and text", async () => {
    currentClient = edgeClient({ readyRow: {
      status: "ready",
      answer_sdp: "resumed-answer-sdp",
      call_id: "33333333-3333-4333-8333-333333333333",
      error: null,
      opening_mode_applied: "application_tts_v1",
      opening_payload: RESUMED_PAYLOAD,
      onboarding_protocol_version: 2,
    } });
    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }));

    expect(response.status).toBe(200);
    expect(currentClient.inserts[0]).toMatchObject({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    });
    expect(await response.json()).toMatchObject({
      opening_payload: RESUMED_PAYLOAD,
      onboarding_protocol_version: 2,
      resume_context: RESUME_CONTEXT,
      opening_text: RESUMED_PAYLOAD.text,
      business_name: "D1F Marketing",
    });
  });

  test("accepts the website-first opening without inserting continuation copy", async () => {
    currentClient = edgeClient({ readyRow: {
      status: "ready",
      answer_sdp: "website-answer-sdp",
      call_id: "33333333-3333-4333-8333-333333333333",
      error: null,
      opening_mode_applied: "application_tts_v1",
      opening_payload: WEBSITE_PAYLOAD,
      onboarding_protocol_version: 2,
    } });
    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      opening_text: WEBSITE_TEXT,
      resume_context: WEBSITE_CONTEXT,
    });
    expect(WEBSITE_TEXT).not.toContain("Vamos continuar de onde paramos");
  });

  test("protocol 2 rejects a legacy v1 ready row", async () => {
    const ready = invalidApplicationReady({
      answer_sdp: "legacy-answer-sdp",
      opening_payload: LEGACY_PAYLOAD,
    });
    currentClient = invalidReadyAckScenario(ready).client;
    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "invalid_application_opening_contract",
    });
  });

  test("binds an application opening to the authenticated tenant and ignores browser payload fields", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    currentClient = edgeClient();
    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
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
      onboarding_protocol_version: 2,
    }]);
    expect(await response.json()).toEqual({
      sdp: "answer-sdp",
      call_id: "33333333-3333-4333-8333-333333333333",
      max_minutes: 30,
      model: "gpt-realtime-2.1",
      opening_mode_applied: "application_tts_v1",
      opening_payload: PAYLOAD,
      onboarding_protocol_version: 2,
      resume_context: null,
      opening_text: PAYLOAD.text,
      business_name: "D1F Marketing",
    });
  });

  test("fails closed when ready onboarding state is partial or malformed", async () => {
    expect(createBrowserSessionHandler).toBeFunction();
    for (const readyRow of [
      invalidApplicationReady({ opening_payload: { ...PAYLOAD, extra: true } }),
      invalidApplicationReady({
        opening_payload: { ...PAYLOAD, item_id: `lgo-${"d".repeat(29)}` },
      }),
      invalidApplicationReady({
        opening_payload: { ...PAYLOAD, text: `${PAYLOAD.text} extra` },
      }),
    ]) {
      currentClient = invalidReadyAckScenario(readyRow).client;
      const response = await handler!(request({
        session_type: "onboarding",
        opening_mode_requested: "application_tts_v1",
        onboarding_protocol_version: 2,
      }));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "invalid_application_opening_contract" });
      expect(currentClient.updates).toHaveLength(1);
    }
  });

  test("invalid application-ready contract requests one exact cancel and waits for expired ACK", async () => {
    const ready = invalidApplicationReady();
    const scenario = invalidReadyAckScenario(ready);
    currentClient = scenario.client;

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "invalid_application_opening_contract",
    });
    expect(currentClient.updates).toEqual([{
      table: "browser_session_requests",
      patch: {
        status: "cancel_requested",
        error: "invalid_application_opening_contract",
      },
      filters: {
        id: "request-1",
        status: "ready",
        call_id: ready.call_id,
      },
    }]);
    expect(currentClient.selections.some((selection) =>
      selection.table === "calls"
    )).toBe(false);
  });

  test("invalid application-ready cleanup failure returns request_cleanup_failed", async () => {
    const ready = invalidApplicationReady();
    const cancelRequested = {
      ...ready,
      status: "cancel_requested",
      error: "invalid_application_opening_contract",
    };
    currentClient = edgeClient({
      readyRows: [ready, ...Array(60).fill(cancelRequested)],
      updateResults: [{ data: [cancelRequested], error: null }],
    });
    let sleepCalls = 0;
    handler = buildHandler({ sleep: async () => { sleepCalls += 1; } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "request_cleanup_failed" });
    expect(currentClient.updates).toHaveLength(1);
    expect(sleepCalls).toBe(61);
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
        onboarding_protocol_version: 2,
      } });
      const times = [0, 0, 20_001];
      handler = buildHandler({
        sleep: async () => { abort.abort(); },
        now: () => times.shift() ?? 20_001,
      });

      const response = await handler!(request({
        session_type: "onboarding",
        opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
        opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
        opening_mode_applied: "provider_model_v1",
        opening_payload: null,
      }],
      updateResults: [{ data: [], error: null }],
    });
    handler = buildHandler({ sleep: async () => { abort.abort(); } });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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
        onboarding_protocol_version: 2,
      },
    ] });
    const times = [0, 0, 20_001, 21_000, 22_000];
    handler = buildHandler({ now: () => times.shift() ?? 22_000 });

    const response = await handler!(request({
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1", onboarding_protocol_version: 2,
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


test("Edge accepts only the model-specific rate for V2 and V3 opening receipts", () => {
  const validate = (edgeModule as any).isApplicationOpeningPayload;
  const speech = {schema:"onboarding.speech.v1",actionId:"a".repeat(64),interviewId:"33333333-3333-4333-8333-333333333333",callId:"33333333-3333-4333-8333-333333333333",revision:0,kind:"ASK_NEXT_GAP",sourceDigest:"b".repeat(64),text:PAYLOAD.text,text_sha256:PAYLOAD.text_sha256,audio_base64:PAYLOAD.audio_base64,audio_sha256:PAYLOAD.audio_sha256,mime:"audio/mpeg",voice:"ash"};
  for(const [model,rate] of [["tts-1",15],["tts-1-hd",30]] as const){
    const cost=Number(([...PAYLOAD.text].length*rate/1_000_000).toFixed(8));
    const v2={...PAYLOAD,tts_model:model,cost_usd:cost};
    const v3={version:3,item_id:`lgs-${speech.actionId.slice(0,28)}`,speech:{...speech,tts_model:model,cost_usd:cost}};
    expect(validate(v2)).toBe(true);expect(validate(v3)).toBe(true);
    const wrong=Number(([...PAYLOAD.text].length*(rate===15?30:15)/1_000_000).toFixed(8));
    expect(validate({...v2,cost_usd:wrong})).toBe(false);
    expect(validate({...v3,speech:{...v3.speech,cost_usd:wrong}})).toBe(false);
    expect(validate({...v3,speech:{...v3.speech,tts_model:"constructor"}})).toBe(false);
  }
});


test("old open dashboards cannot enqueue onboarding before upgrading their speech contract", async () => {
  for (const protocol of [2, 3]) {
    for (const capability of [undefined, null, 1, "2", 3, true]) {
      currentClient = edgeClient();
      const oldRequest = request({session_type:"onboarding",opening_mode_requested:"application_tts_v1",onboarding_protocol_version:protocol,speech_contract_version:capability});
      if (capability === undefined) expect(await oldRequest.clone().json()).not.toHaveProperty("speech_contract_version");
      const response = await handler!(oldRequest);
      expect(response.status).toBe(409); expect(await response.json()).toEqual({error:"client_upgrade_required"});
      expect(currentClient.inserts).toHaveLength(0); expect(currentClient.updates).toHaveLength(0);
      expect(currentClient.selections).toHaveLength(0);
    }
  }
});

test("declared speech contract admits fast V2 and V3 payloads without storing a new capability field", async () => {
  const fast = {...PAYLOAD,tts_model:"tts-1",cost_usd:0.001605};
  const callId="33333333-3333-4333-8333-333333333333";
  const speech={schema:"onboarding.speech.v1",actionId:"a".repeat(64),interviewId:callId,callId,revision:0,kind:"ASK_NEXT_GAP",text:fast.text,sourceDigest:"b".repeat(64),text_sha256:fast.text_sha256,audio_base64:fast.audio_base64,audio_sha256:fast.audio_sha256,mime:"audio/mpeg",voice:"ash",tts_model:fast.tts_model,cost_usd:fast.cost_usd};
  for (const protocol of [2,3]) {
    const payload=protocol===2?fast:{version:3,item_id:`lgs-${speech.actionId.slice(0,28)}`,speech};
    currentClient=edgeClient({readyRow:{status:"ready",answer_sdp:"answer",call_id:callId,error:null,opening_mode_applied:"application_tts_v1",opening_payload:payload,onboarding_protocol_version:protocol}});
    const response=await handler!(request({session_type:"onboarding",opening_mode_requested:"application_tts_v1",onboarding_protocol_version:protocol,speech_contract_version:2}));
    expect(response.status).toBe(200);expect((await response.json()).opening_payload).toEqual(payload);
    expect(currentClient.inserts).toHaveLength(1);expect(currentClient.inserts[0]).not.toHaveProperty("speech_contract_version");
  }
});
