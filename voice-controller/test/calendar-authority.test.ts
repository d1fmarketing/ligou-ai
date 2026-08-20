import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { _setClient } from "../src/rules.ts";
import { googleCalendar, payloadHash } from "../src/calendar.ts";

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
    ligouTenantId: INPUT.tenantId,
    ligouBookingId: INPUT.bookingId,
    ligouCalendarId: "calendar-1",
    ligouAccountId: "oauth:synthetic-unit-test-client",
    ligouPayloadHash: EXPECTED_HASH,
  } },
});

let requests: Array<{ url: string; method: string; body?: any }> = [];
let lookupResponse: { ok: boolean; status: number; body: any };

function response(value: { ok: boolean; status: number; body: any }): Response {
  return new Response(JSON.stringify(value.body), { status: value.status });
}

beforeEach(() => {
  process.env.GOOGLE_CALENDAR_ID = "calendar-1";
  process.env.GOOGLE_CLIENT_ID = "synthetic-unit-test-client";
  process.env.GOOGLE_CLIENT_SECRET = "synthetic-unit-test-key";
  requests = [];
  lookupResponse = { ok: true, status: 200, body: { items: [exactEvent()] } };
  _setClient({
    from() {
      const api: any = {
        select() { return api; }, eq() { return api; },
        maybeSingle: async () => ({ data: null, error: null }),
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
});
