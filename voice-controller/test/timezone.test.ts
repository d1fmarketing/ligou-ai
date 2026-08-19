import { describe, expect, test } from "bun:test";
import { zonedInstantIso, spokenLocal, overlapsBusy } from "../src/calendar.ts";

// Regression for the 2026-08-19 live bug: slots were emitted as bare local strings, so Google freeBusy
// answered HTTP 400 and Date.parse read them in the SERVER's zone (UTC on the EC2) — a 7h shift that
// would have offered hours already sold.
describe("tenant timezone -> real instants", () => {
  test("summer wall clock maps to the PDT instant", () => {
    expect(zonedInstantIso("2026-08-20", 8, "America/Los_Angeles")).toBe("2026-08-20T15:00:00.000Z");
  });

  test("winter wall clock maps to the PST instant (DST-aware)", () => {
    expect(zonedInstantIso("2026-01-15", 8, "America/Los_Angeles")).toBe("2026-01-15T16:00:00.000Z");
  });

  test("emitted slots always carry a zone designator", () => {
    const iso = zonedInstantIso("2026-08-20", 13, "America/Los_Angeles");
    expect(iso.endsWith("Z")).toBe(true);
    expect(Number.isFinite(Date.parse(iso))).toBe(true);
  });

  test("what the agent says stays in the tenant's clock", () => {
    const iso = zonedInstantIso("2026-08-20", 8, "America/Los_Angeles");
    expect(spokenLocal(iso, "America/Los_Angeles")).toContain("8:00 AM");
  });

  test("a busy hour in the tenant's morning is detected as a collision", () => {
    const start = zonedInstantIso("2026-08-20", 8, "America/Los_Angeles");
    const end = zonedInstantIso("2026-08-20", 9, "America/Los_Angeles");
    const busy = [{ start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z" }];
    expect(overlapsBusy(start, end, busy)).toBe(true);
  });

  test("a free hour is not reported as a collision", () => {
    const start = zonedInstantIso("2026-08-20", 13, "America/Los_Angeles");
    const end = zonedInstantIso("2026-08-20", 14, "America/Los_Angeles");
    const busy = [{ start: "2026-08-20T15:00:00Z", end: "2026-08-20T16:00:00Z" }];
    expect(overlapsBusy(start, end, busy)).toBe(false);
  });
});
