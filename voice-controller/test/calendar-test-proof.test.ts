import { describe, expect, test } from "bun:test";
import {
  TEST_EVENT_SUMMARY,
  classifyInsertStatus,
  deterministicTestEventId,
  nextTenantHourWindow,
  normalizeGoogleDateTime,
  verifyTestEventReadback,
} from "../../supabase/functions/_shared/calendar-test-core.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

describe("deterministic test event identity", () => {
  test("is stable per tenant and valid as a Google event id", async () => {
    const first = await deterministicTestEventId(TENANT);
    const second = await deterministicTestEventId(TENANT);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/); // subset of Google's base32hex alphabet, length within 5..1024
  });

  test("differs across tenants", async () => {
    expect(await deterministicTestEventId(TENANT)).not.toBe(await deterministicTestEventId(OTHER_TENANT));
  });

  test("rejects a non-uuid tenant", async () => {
    await expect(deterministicTestEventId("not-a-tenant")).rejects.toThrow();
  });
});

describe("test event window", () => {
  test("uses the exact required label", () => {
    expect(TEST_EVENT_SUMMARY).toBe("Ligou V0.2 TEST — Google Login and Calendar Verification");
  });

  test("starts at the next full hour in the tenant timezone with a 30 minute duration", () => {
    // 2026-08-22T18:30:00Z is 11:30 in America/Los_Angeles (UTC-7 in August).
    const now = Date.parse("2026-08-22T18:30:00.000Z");
    const window = nextTenantHourWindow(now, "America/Los_Angeles");
    expect(Date.parse(window.startIso)).toBe(Date.parse("2026-08-22T19:00:00.000Z"));
    expect(Date.parse(window.endIso) - Date.parse(window.startIso)).toBe(30 * 60_000);
    expect(window.startIso).toContain("-07:00");
    expect(window.startIso).toContain("T12:00:00");
  });

  test("rolls to the following hour when already exactly on the hour", () => {
    const now = Date.parse("2026-08-22T19:00:00.000Z");
    const window = nextTenantHourWindow(now, "America/Los_Angeles");
    expect(Date.parse(window.startIso)).toBe(Date.parse("2026-08-22T20:00:00.000Z"));
  });

  test("handles UTC tenants", () => {
    const now = Date.parse("2026-08-22T18:30:00.000Z");
    const window = nextTenantHourWindow(now, "UTC");
    expect(Date.parse(window.startIso)).toBe(Date.parse("2026-08-22T19:00:00.000Z"));
    expect(window.startIso).toContain("+00:00");
  });

  test("a real-world clock with sub-second remainder still yields a well-formed offset", () => {
    // Regression: Intl truncates to seconds, so a fractional now leaked a
    // fractional offset ("-07:0.0087…") that Google rejected with 400.
    const now = Date.parse("2026-08-22T18:30:00.000Z") + 527.13333333;
    const window = nextTenantHourWindow(now, "America/Los_Angeles");
    expect(window.startIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(window.endIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(window.startIso).toContain("T12:00:00-07:00");
    expect(Date.parse(window.startIso)).toBe(Date.parse("2026-08-22T19:00:00.000Z"));
    expect(Number.isFinite(Date.parse(window.endIso))).toBe(true);
  });
});

describe("read-back normalization and verification", () => {
  test("normalizes offset and zulu forms to the same instant", () => {
    expect(normalizeGoogleDateTime({ dateTime: "2026-08-22T12:00:00-07:00" }))
      .toBe(normalizeGoogleDateTime({ dateTime: "2026-08-22T19:00:00Z" }));
    expect(normalizeGoogleDateTime({})).toBeNull();
    expect(normalizeGoogleDateTime({ dateTime: "garbage" })).toBeNull();
  });

  function expected() {
    return {
      eventId: "abc123def456abc123def456abc123de",
      summary: TEST_EVENT_SUMMARY,
      startIso: "2026-08-22T12:00:00-07:00",
      endIso: "2026-08-22T12:30:00-07:00",
    };
  }
  function resource(overrides: Record<string, unknown> = {}) {
    return {
      id: "abc123def456abc123def456abc123de",
      summary: TEST_EVENT_SUMMARY,
      status: "confirmed",
      start: { dateTime: "2026-08-22T19:00:00Z" },
      end: { dateTime: "2026-08-22T19:30:00Z" },
      ...overrides,
    };
  }

  test("accepts an exact read-back across timezone representations", () => {
    expect(verifyTestEventReadback(expected(), resource())).toEqual({ ok: true });
  });

  test.each([
    ["id", { id: "ffffffffffffffffffffffffffffffff" }],
    ["summary", { summary: "Ligou test" }],
    ["status", { status: "tentative" }],
    ["start", { start: { dateTime: "2026-08-22T20:00:00Z" } }],
    ["end", { end: { dateTime: "2026-08-22T20:30:00Z" } }],
    ["attendees", { attendees: [{ email: "someone@example.com" }] }],
  ])("rejects a %s mismatch", (field, override) => {
    const verdict = verifyTestEventReadback(expected(), resource(override as Record<string, unknown>));
    expect(verdict.ok).toBe(false);
    expect(verdict.field).toBe(field);
  });

  test("a missing start timestamp is a start mismatch, never acceptance", () => {
    const verdict = verifyTestEventReadback(expected(), resource({ start: {} }));
    expect(verdict).toEqual({ ok: false, field: "start" });
  });
});

describe("insert outcome classification", () => {
  test.each([
    [200, "created"],
    [201, "created"],
    [409, "duplicate"],
    [400, "failed"],
    [401, "failed"],
    [403, "failed"],
    [404, "failed"],
    [500, "unknown"],
    [502, "unknown"],
    [503, "unknown"],
  ] as const)("HTTP %p → %p", (status, expected) => {
    expect(classifyInsertStatus(status)).toBe(expected);
  });
});
