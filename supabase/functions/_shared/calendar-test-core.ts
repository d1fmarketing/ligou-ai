// Pure logic for the V0.2 M1 calendar proof: deterministic event identity,
// tenant-timezone scheduling, and exact read-back verification. No I/O.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TEST_EVENT_SUMMARY = "Ligou V0.2 TEST — Google Login and Calendar Verification";

// Google accepts caller-chosen event ids in base32hex ([a-v0-9], 5..1024 chars).
// A SHA-256 hex digest is a strict subset of that alphabet, so the first 32 hex
// characters give a deterministic, collision-safe, provider-valid identity.
export async function deterministicTestEventId(tenantId: string): Promise<string> {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new Error("tenant_required");
  const bytes = new TextEncoder().encode(`ligou-v0.2-m1-test|${tenantId.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function timeZoneOffsetMs(atMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(atMs))) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - atMs;
}

function offsetSuffix(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const total = Math.abs(offsetMs) / 60_000;
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function localIso(instantMs: number, offsetMs: number): string {
  const local = new Date(instantMs + offsetMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    offsetSuffix(offsetMs);
}

export interface TestEventWindow {
  startIso: string;
  endIso: string;
}

// The next full wall-clock hour in the tenant timezone, 30 minutes long,
// rendered as RFC3339 with the tenant's UTC offset.
export function nextTenantHourWindow(nowMs: number, timeZone: string): TestEventWindow {
  if (!Number.isFinite(nowMs)) throw new Error("calendar_test_time_invalid");
  const approximateOffset = timeZoneOffsetMs(nowMs, timeZone);
  const localNow = nowMs + approximateOffset;
  const HOUR = 3_600_000;
  const nextLocalHour = (Math.floor(localNow / HOUR) + 1) * HOUR;
  let startMs = nextLocalHour - approximateOffset;
  // One refinement pass keeps the wall-clock hour exact across a DST boundary.
  const exactOffset = timeZoneOffsetMs(startMs, timeZone);
  if (exactOffset !== approximateOffset) startMs = nextLocalHour - exactOffset;
  const endMs = startMs + 30 * 60_000;
  return {
    startIso: localIso(startMs, timeZoneOffsetMs(startMs, timeZone)),
    endIso: localIso(endMs, timeZoneOffsetMs(endMs, timeZone)),
  };
}

export function normalizeGoogleDateTime(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const dateTime = (value as Record<string, unknown>).dateTime;
  if (typeof dateTime !== "string") return null;
  const parsed = Date.parse(dateTime);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export interface ExpectedTestEvent {
  eventId: string;
  summary: string;
  startIso: string;
  endIso: string;
}

export type ReadbackVerdict = { ok: true } | { ok: false; field: string };

export function verifyTestEventReadback(expected: ExpectedTestEvent, resource: unknown): ReadbackVerdict {
  if (typeof resource !== "object" || resource === null) return { ok: false, field: "resource" };
  const record = resource as Record<string, unknown>;
  if (record.id !== expected.eventId) return { ok: false, field: "id" };
  if (record.summary !== expected.summary) return { ok: false, field: "summary" };
  if (record.status !== "confirmed") return { ok: false, field: "status" };
  const start = normalizeGoogleDateTime(record.start);
  if (!start || Date.parse(start) !== Date.parse(expected.startIso)) return { ok: false, field: "start" };
  const end = normalizeGoogleDateTime(record.end);
  if (!end || Date.parse(end) !== Date.parse(expected.endIso)) return { ok: false, field: "end" };
  if (Array.isArray(record.attendees) && record.attendees.length > 0) return { ok: false, field: "attendees" };
  return { ok: true };
}

export type InsertClassification = "created" | "duplicate" | "failed" | "unknown";

// A definitive provider rejection (4xx except the duplicate-id conflict) is "failed":
// nothing was created and a retry is safe. Anything ambiguous (5xx, timeouts) is
// "unknown": the write may exist, so at-most-once forbids another POST forever.
export function classifyInsertStatus(status: number): InsertClassification {
  if (status === 200 || status === 201) return "created";
  if (status === 409) return "duplicate";
  if (status >= 400 && status < 500) return "failed";
  return "unknown";
}
