import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { _setClient } from "../src/rules.ts";
import { calendarPort, googleCalendar, payloadHash } from "../src/calendar.ts";

const INPUT = {
  tenantId: "tenant-1",
  bookingId: "booking-1",
  summary: "Drain cleaning — Customer ($180)",
  description: "Ligou booking commitment. Contact: +1. Call call-1.",
  startIso: "2026-08-21T17:00:00.000Z",
  endIso: "2026-08-21T18:00:00.000Z",
  idempotencyKey: "idem-1",
};
const EXPECTED_HASH = "170c6a7ac39bce4cd5d343262a74d878c0c5c9a336b2e1f0cd8274aeb1aca83f";

const exactEvent = () => ({
  id: "event-1",
  summary: INPUT.summary,
  description: INPUT.description,
  start: { dateTime: INPUT.startIso },
  end: { dateTime: INPUT.endIso },
  status: "confirmed",
  extendedProperties: { private: {
    ligouKey: INPUT.idempotencyKey,
    ligouProvider: "google_calendar",
    ligouTenantId: INPUT.tenantId,
    ligouBookingId: INPUT.bookingId,
    ligouCalendarId: "calendar-1",
    ligouAccountId: "oauth:synthetic-unit-test-client",
    ligouPayloadHash: EXPECTED_HASH,
  } },
});

let requests: Array<{ url: string; method: string; body?: any }> = [];
let lookupResponse: { ok: boolean; status: number; body: any };
let connectorError: { message: string } | null = null;
let connectorData: any = null;
let queriedTables: string[] = [];

function response(value: { ok: boolean; status: number; body: any }): Response {
  return new Response(JSON.stringify(value.body), { status: value.status });
}

beforeEach(() => {
  process.env.GOOGLE_CALENDAR_ID = "calendar-1";
  process.env.GOOGLE_CLIENT_ID = "synthetic-unit-test-client";
  process.env.GOOGLE_CLIENT_SECRET = "synthetic-unit-test-key";
  process.env.GOOGLE_REFRESH_TOKEN = "synthetic-unit-test-token";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-oauth-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "synthetic-oauth-secret";
  process.env.GOOGLE_MANAGED_CALENDAR_FALLBACK = "enabled";
  requests = [];
  connectorError = null;
  connectorData = null;
  queriedTables = [];
  lookupResponse = { ok: true, status: 200, body: { items: [exactEvent()] } };
  _setClient({
    from(table: string) {
      queriedTables.push(table);
      const api: any = {
        select() { return api; }, eq() { return api; },
        maybeSingle: async () => ({ data: connectorData, error: connectorError }),
      };
      return api;
    },
  } as any);
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET");
    const rawBody = init.body ? String(init.body) : "";
    requests.push({ url, method, body: rawBody.startsWith("{") ? JSON.parse(rawBody) : rawBody || undefined });
    if (url === "https://oauth2.googleapis.com/token") {
      return response({ ok: true, status: 200, body: { access_token: "synthetic-token" } });
    }
    if (method === "GET" && url.includes("privateExtendedProperty=")) return response(lookupResponse);
    if (method === "POST") return response({ ok: true, status: 200, body: { id: "event-created" } });
    return response({ ok: true, status: 200, body: exactEvent() });
  }) as typeof fetch;
});

afterAll(() => {
  _setClient(null);
  delete process.env.GOOGLE_CALENDAR_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_MANAGED_CALENDAR_FALLBACK;
});

async function write(input = INPUT) {
  return googleCalendar.write(input as any);
}

describe("canonical calendar commitment", () => {
  test("hash covers provider mapping, commitment fields, status, and private tenant/booking keys", () => {
    expect(payloadHash({
      ...INPUT,
      provider: "google_calendar",
      accountId: "oauth:synthetic-unit-test-client",
      calendarId: "calendar-1",
    } as any)).toBe(EXPECTED_HASH);
  });

  test("accepts a reused event only when every expected field is exactly equivalent", async () => {
    const result = await write();
    expect(result.outcome).toBe("accepted");
    expect(result.payloadHash).toBe(EXPECTED_HASH);
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(0);
  });

  test("rejects every per-field readback mismatch", async () => {
    const mutations: Array<[string, (event: any) => void]> = [
      ["summary", (event) => { event.summary = "Wrong"; }],
      ["description", (event) => { event.description = "Wrong"; }],
      ["start", (event) => { event.start.dateTime = "2026-08-21T17:30:00.000Z"; }],
      ["end", (event) => { event.end.dateTime = "2026-08-21T18:30:00.000Z"; }],
      ["status", (event) => { event.status = "tentative"; }],
      ["idempotency", (event) => { event.extendedProperties.private.ligouKey = "wrong"; }],
      ["provider", (event) => { event.extendedProperties.private.ligouProvider = "fake_calendar"; }],
      ["tenant", (event) => { event.extendedProperties.private.ligouTenantId = "tenant-2"; }],
      ["booking", (event) => { event.extendedProperties.private.ligouBookingId = "booking-2"; }],
      ["calendar", (event) => { event.extendedProperties.private.ligouCalendarId = "calendar-2"; }],
      ["account", (event) => { event.extendedProperties.private.ligouAccountId = "oauth:other"; }],
      ["payload hash", (event) => { event.extendedProperties.private.ligouPayloadHash = "wrong"; }],
    ];

    for (const [field, mutate] of mutations) {
      const event = exactEvent();
      mutate(event);
      lookupResponse = { ok: true, status: 200, body: { items: [event] } };
      const result = await write();
      expect(result.outcome, field).toBe("failed");
      expect(result.error, field).toBe(`readback_mismatch:${field}`);
    }
  });

  test("wrong reused event never becomes an accepted receipt", async () => {
    const event = exactEvent();
    event.extendedProperties.private.ligouBookingId = "other-booking";
    lookupResponse = { ok: true, status: 200, body: { items: [event] } };
    expect((await write()).outcome).toBe("failed");
  });

  test("lookup failure is unknown and performs zero event POSTs", async () => {
    lookupResponse = { ok: false, status: 503, body: { error: "unavailable" } };
    const result = await write();
    expect(result.outcome).toBe("unknown");
    expect(result.error).toBe("lookup_503");
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(0);
  });

  test("repeating the exact write reuses one event instead of posting a twin", async () => {
    lookupResponse = { ok: true, status: 200, body: { items: [] } };
    const first = await write();
    lookupResponse = { ok: true, status: 200, body: { items: [exactEvent()] } };
    const second = await write();
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("accepted");
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(1);
  });

  test("connector lookup error is unknown and never falls back to global credentials", async () => {
    connectorError = { message: "connector database unavailable" };
    const result = await write({ ...INPUT, tenantId: "tenant-connector-error" });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_lookup_failed");
    expect(requests).toHaveLength(0);
  });

  test("confirmed connector absence uses no managed fallback unless explicitly enabled", async () => {
    delete process.env.GOOGLE_MANAGED_CALENDAR_FALLBACK;
    const result = await write({ ...INPUT, tenantId: "tenant-no-fallback" });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("google_not_configured");
    expect(requests).toHaveLength(0);
  });

  test("explicit managed fallback follows confirmed connector absence", async () => {
    const result = await write();
    expect(result.outcome).toBe("accepted");
  });

  test("connector lookup error stays unknown even when OAuth client env is absent", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    connectorError = { message: "connector database unavailable" };
    const result = await write({ ...INPUT, tenantId: "tenant-error-no-oauth-env" });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_lookup_failed");
    expect(requests).toHaveLength(0);
  });

  test("connector row without refresh token is malformed and never falls back", async () => {
    connectorData = { status: "active", refresh_token: null, calendar_id: "calendar-tenant", account_email: "owner@example.com" };
    const result = await write({ ...INPUT, tenantId: "tenant-malformed-token" });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_malformed");
    expect(requests).toHaveLength(0);
  });

  test("connector row with incomplete OAuth client configuration never falls back", async () => {
    connectorData = { status: "active", refresh_token: "tenant-refresh", calendar_id: "calendar-tenant", account_email: "owner@example.com" };
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const result = await write({ ...INPUT, tenantId: "tenant-oauth-misconfigured" });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_oauth_config_missing");
    expect(requests).toHaveLength(0);
  });

  test("successful lookup with non-array items is unknown and never posts", async () => {
    lookupResponse = { ok: true, status: 200, body: { items: {} } };
    const result = await write();
    expect(result.outcome).toBe("unknown");
    expect(result.error).toBe("lookup_malformed_items");
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(0);
  });

  test("inactive connector row is not treated as absence or allowed to fall back", async () => {
    connectorData = {
      status: "revoked", refresh_token: "tenant-refresh",
      calendar_id: "calendar-tenant", account_email: "owner@example.com",
    };
    const result = await write({ ...INPUT, tenantId: "tenant-revoked-connector" });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_inactive:revoked");
    expect(requests).toHaveLength(0);
  });

  test("successful lookup with malformed pagination is unknown and never posts", async () => {
    lookupResponse = { ok: true, status: 200, body: { items: [], nextPageToken: 0 } };
    const result = await write();
    expect(result.outcome).toBe("unknown");
    expect(result.error).toBe("lookup_malformed_pagination");
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(0);
  });

  test("explicit empty pagination token is malformed rather than zero-match", async () => {
    lookupResponse = { ok: true, status: 200, body: { items: [], nextPageToken: "" } };
    const result = await write();
    expect(result.outcome).toBe("unknown");
    expect(result.error).toBe("lookup_malformed_pagination");
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(0);
  });

  test("connector state is re-read after an active row becomes revoked", async () => {
    const tenantId = "tenant-cache-revoked";
    connectorData = {
      status: "active", refresh_token: "tenant-refresh",
      calendar_id: "calendar-tenant", account_email: "owner@example.com",
    };
    await write({ ...INPUT, tenantId });
    const requestCount = requests.length;
    connectorData = { ...connectorData, status: "revoked" };
    const result = await write({ ...INPUT, tenantId });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_inactive:revoked");
    expect(requests).toHaveLength(requestCount);
  });

  test("confirmed absence is re-read and a second-call DB error cannot use cached fallback", async () => {
    const tenantId = "tenant-cache-db-error";
    connectorData = null;
    await write({ ...INPUT, tenantId });
    const requestCount = requests.length;
    connectorError = { message: "connector database unavailable" };
    const result = await write({ ...INPUT, tenantId });
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_lookup_failed");
    expect(requests).toHaveLength(requestCount);
  });

  test("default calendar port still queries tenant connector without any Google env", async () => {
    delete process.env.CALENDAR_PROVIDER;
    delete process.env.GOOGLE_CALENDAR_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    connectorError = { message: "connector database unavailable" };
    const result = await calendarPort().write({ ...INPUT, tenantId: "tenant-port-no-google-env" } as any);
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("connector_lookup_failed");
    expect(queriedTables).toContain("connector_accounts");
  });

  for (const method of ["write", "reconcile"] as const) {
    test(`${method} treats duplicate ligouKey matches as manual conflict`, async () => {
      const wrong = exactEvent();
      wrong.extendedProperties.private.ligouBookingId = "wrong-booking";
      lookupResponse = { ok: true, status: 200, body: { items: [wrong, exactEvent()] } };
      const result = await googleCalendar[method](INPUT as any);
      expect(result.outcome).toBe("unknown");
      expect(result.error).toBe("lookup_ambiguous:2");
      expect(requests.filter((request) => request.method === "POST" && request.url.includes("/events"))).toHaveLength(0);
    });
  }
});
