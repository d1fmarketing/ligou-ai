// CalendarPort is the only provider boundary. Writes and reconciliation are
// deliberately separate: a transport-unknown intent can only use reconcile().
import { createHash } from "node:crypto";
import { supa } from "./rules.ts";

export interface CalendarEventInput {
  tenantId: string;
  bookingId: string;
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  idempotencyKey: string;
}

export interface ProviderMapping {
  provider: "fake_calendar" | "google_calendar";
  accountId: string;
  calendarId: string;
}

export interface CalendarWriteResult {
  outcome: "accepted" | "failed" | "unknown";
  externalId?: string;
  readback?: Record<string, unknown>;
  payloadHash?: string;
  error?: string;
  latencyMs: number;
}

interface ExpectedCalendarPayload {
  mapping: ProviderMapping;
  hash: string;
  privateProperties: Record<string, string>;
}

function normalizedInstant(value: string): string {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
}

function canonicalBody(input: CalendarEventInput, mapping: ProviderMapping) {
  return {
    provider: mapping.provider,
    account_id: mapping.accountId,
    calendar_id: mapping.calendarId,
    summary: input.summary,
    description: input.description,
    start: normalizedInstant(input.startIso),
    end: normalizedInstant(input.endIso),
    status: "confirmed",
    private: {
      ligouKey: input.idempotencyKey,
      ligouTenantId: input.tenantId,
      ligouBookingId: input.bookingId,
    },
  };
}

export function payloadHash(input: CalendarEventInput & Partial<{ provider: ProviderMapping["provider"]; accountId: string; calendarId: string }>): string {
  const mapping: ProviderMapping = {
    provider: input.provider ?? "fake_calendar",
    accountId: input.accountId ?? "ligou-fake",
    calendarId: input.calendarId ?? `tenant:${input.tenantId}`,
  };
  return createHash("sha256").update(JSON.stringify(canonicalBody(input, mapping))).digest("hex");
}

function expectedPayload(input: CalendarEventInput, mapping: ProviderMapping): ExpectedCalendarPayload {
  const hash = payloadHash({ ...input, ...mapping });
  return {
    mapping,
    hash,
    privateProperties: {
      ligouKey: input.idempotencyKey,
      ligouTenantId: input.tenantId,
      ligouBookingId: input.bookingId,
      ligouCalendarId: mapping.calendarId,
      ligouAccountId: mapping.accountId,
      ligouPayloadHash: hash,
    },
  };
}

function mismatchField(input: CalendarEventInput, expected: ExpectedCalendarPayload, event: any): string | null {
  if (event?.summary !== input.summary) return "summary";
  if (event?.description !== input.description) return "description";
  if (normalizedInstant(String(event?.start?.dateTime ?? "")) !== normalizedInstant(input.startIso)) return "start";
  if (normalizedInstant(String(event?.end?.dateTime ?? "")) !== normalizedInstant(input.endIso)) return "end";
  if (event?.status !== "confirmed") return "status";
  const privateFields = event?.extendedProperties?.private ?? {};
  const checks: Array<[string, string]> = [
    ["idempotency", "ligouKey"],
    ["tenant", "ligouTenantId"],
    ["booking", "ligouBookingId"],
    ["calendar", "ligouCalendarId"],
    ["account", "ligouAccountId"],
    ["payload hash", "ligouPayloadHash"],
  ];
  for (const [label, key] of checks) {
    if (privateFields[key] !== expected.privateProperties[key]) return label;
  }
  return null;
}

function classifyReadback(input: CalendarEventInput, expected: ExpectedCalendarPayload, event: any, started: number): CalendarWriteResult {
  const field = mismatchField(input, expected, event);
  if (field) {
    return {
      outcome: "failed", externalId: event?.id, readback: event,
      error: `readback_mismatch:${field}`, latencyMs: Date.now() - started,
    };
  }
  return {
    outcome: "accepted", externalId: event.id, readback: event,
    payloadHash: expected.hash, latencyMs: Date.now() - started,
  };
}

export interface BusyInterval { start: string; end: string }

export interface CalendarPort {
  write(input: CalendarEventInput): Promise<CalendarWriteResult>;
  reconcile(input: CalendarEventInput): Promise<CalendarWriteResult>;
  busy(tenantId: string, fromIso: string, toIso: string): Promise<{ intervals: BusyInterval[]; unknown?: boolean }>;
}

/** Minutes east of UTC for `tz` at that instant (DST-aware). */
function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return (asUtc - at.getTime()) / 60_000;
}

export function zonedInstantIso(ymd: string, hour: number, tz: string): string {
  const naiveUtc = Date.parse(`${ymd}T${String(hour).padStart(2, "0")}:00:00Z`);
  const firstPass = new Date(naiveUtc - tzOffsetMinutes(new Date(naiveUtc), tz) * 60_000);
  return new Date(naiveUtc - tzOffsetMinutes(firstPass, tz) * 60_000).toISOString();
}

export function spokenLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

export function overlapsBusy(startIso: string, endIso: string, busy: BusyInterval[]): boolean {
  const s = Date.parse(startIso), e = Date.parse(endIso);
  return busy.some((b) => {
    const bs = Date.parse(b.start), be = Date.parse(b.end);
    return Number.isFinite(bs) && Number.isFinite(be) && s < be && bs < e;
  });
}

function fakeMapping(input: CalendarEventInput): ProviderMapping {
  return { provider: "fake_calendar", accountId: "ligou-fake", calendarId: `tenant:${input.tenantId}` };
}

function fakeReadback(row: any) {
  return {
    id: row.id,
    summary: row.summary,
    description: row.description,
    start: { dateTime: row.start_iso },
    end: { dateTime: row.end_iso },
    status: row.status,
    extendedProperties: { private: {
      ligouKey: row.idempotency_key,
      ligouTenantId: row.tenant_id,
      ligouBookingId: row.booking_id,
      ligouCalendarId: row.calendar_id,
      ligouAccountId: row.account_id,
      ligouPayloadHash: row.payload_hash,
    } },
  };
}

async function fakeLookup(input: CalendarEventInput) {
  return supa().from("fake_calendar_events")
    .select("id,tenant_id,booking_id,summary,description,start_iso,end_iso,status,idempotency_key,account_id,calendar_id,payload_hash")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
}

export const fakeCalendar: CalendarPort = {
  async write(input) {
    const started = Date.now();
    const expected = expectedPayload(input, fakeMapping(input));
    try {
      const { data: existing, error: lookupError } = await fakeLookup(input);
      if (lookupError) return { outcome: "unknown", error: `lookup_failed:${lookupError.message}`, latencyMs: Date.now() - started };
      let row = existing;
      if (!row) {
        const { data, error } = await supa().from("fake_calendar_events").insert({
          tenant_id: input.tenantId,
          booking_id: input.bookingId,
          summary: input.summary,
          description: input.description,
          start_iso: normalizedInstant(input.startIso),
          end_iso: normalizedInstant(input.endIso),
          status: "confirmed",
          idempotency_key: input.idempotencyKey,
          account_id: expected.mapping.accountId,
          calendar_id: expected.mapping.calendarId,
          payload_hash: expected.hash,
        }).select("id").single();
        if (error || !data) return { outcome: "unknown", error: error?.message ?? "insert_unknown", latencyMs: Date.now() - started };
        const read = await supa().from("fake_calendar_events")
          .select("id,tenant_id,booking_id,summary,description,start_iso,end_iso,status,idempotency_key,account_id,calendar_id,payload_hash")
          .eq("id", data.id).single();
        if (read.error || !read.data) return { outcome: "unknown", externalId: data.id, error: read.error?.message ?? "readback_missing", latencyMs: Date.now() - started };
        row = read.data;
      }
      return classifyReadback(input, expected, fakeReadback(row), started);
    } catch (error) {
      return { outcome: "unknown", error: String(error), latencyMs: Date.now() - started };
    }
  },

  async reconcile(input) {
    const started = Date.now();
    const expected = expectedPayload(input, fakeMapping(input));
    try {
      const { data, error } = await fakeLookup(input);
      if (error) return { outcome: "unknown", error: `lookup_failed:${error.message}`, latencyMs: Date.now() - started };
      if (!data) return { outcome: "unknown", error: "reconcile_absent_manual_review", latencyMs: Date.now() - started };
      return classifyReadback(input, expected, fakeReadback(data), started);
    } catch (error) {
      return { outcome: "unknown", error: String(error), latencyMs: Date.now() - started };
    }
  },

  async busy(tenantId, fromIso, toIso) {
    try {
      const { data, error } = await supa().from("fake_calendar_events")
        .select("start_iso,end_iso").eq("tenant_id", tenantId).lt("start_iso", toIso).gt("end_iso", fromIso);
      if (error) return { intervals: [], unknown: true };
      return { intervals: (data ?? []).map((row: any) => ({ start: row.start_iso, end: row.end_iso })) };
    } catch {
      return { intervals: [], unknown: true };
    }
  },
};

interface GoogleCfg {
  calendarId: string;
  accountId: string;
  sa?: { clientEmail: string; privateKey: string };
  oauth?: { clientId: string; clientSecret: string; refreshToken: string };
}

function googleCfg(): GoogleCfg | null {
  const { GOOGLE_CALENDAR_ID, GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY,
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CALENDAR_ID) return null;
  if (GOOGLE_SA_CLIENT_EMAIL && GOOGLE_SA_PRIVATE_KEY) {
    return {
      calendarId: GOOGLE_CALENDAR_ID,
      accountId: GOOGLE_SA_CLIENT_EMAIL,
      sa: { clientEmail: GOOGLE_SA_CLIENT_EMAIL, privateKey: GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n") },
    };
  }
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
    return {
      calendarId: GOOGLE_CALENDAR_ID,
      accountId: `oauth:${GOOGLE_CLIENT_ID}`,
      oauth: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN },
    };
  }
  return null;
}

const connCache = new Map<string, { cfg: GoogleCfg | null; at: number }>();
const CONN_TTL_MS = 60_000;

async function tenantCfg(tenantId: string): Promise<GoogleCfg | null> {
  const hit = connCache.get(tenantId);
  if (hit && Date.now() - hit.at < CONN_TTL_MS) return hit.cfg;
  let cfg: GoogleCfg | null = null;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId && clientSecret) {
    const { data } = await supa().from("connector_accounts")
      .select("refresh_token,calendar_id,account_email")
      .eq("tenant_id", tenantId).eq("provider", "google_calendar").eq("status", "active").maybeSingle();
    if (data?.refresh_token) {
      cfg = {
        calendarId: data.calendar_id || "primary",
        accountId: data.account_email || `oauth:${clientId}`,
        oauth: { clientId, clientSecret, refreshToken: data.refresh_token },
      };
    }
  }
  connCache.set(tenantId, { cfg, at: Date.now() });
  return cfg;
}

async function cfgFor(tenantId: string): Promise<GoogleCfg | null> {
  return (await tenantCfg(tenantId).catch(() => null)) ?? googleCfg();
}

const b64url = (value: Buffer | string) =>
  Buffer.from(value as any).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function saAccessToken(sa: { clientEmail: string; privateKey: string }, fetcher: typeof fetch): Promise<string> {
  const { createSign } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.clientEmail, scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.privateKey));
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
  });
  if (!response.ok) throw new Error(`google_sa_token_failed:${response.status}`);
  return ((await response.json()) as any).access_token;
}

async function googleAccessToken(cfg: GoogleCfg, fetcher: typeof fetch): Promise<string> {
  if (cfg.sa) return saAccessToken(cfg.sa, fetcher);
  const oauth = cfg.oauth!;
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauth.clientId, client_secret: oauth.clientSecret,
      refresh_token: oauth.refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error(`google_token_failed:${response.status}`);
  return ((await response.json()) as any).access_token;
}

interface GoogleDependencies {
  fetcher?: typeof fetch;
  resolveConfig?: (tenantId: string) => Promise<GoogleCfg | null>;
  accessToken?: (cfg: GoogleCfg, fetcher: typeof fetch) => Promise<string>;
}

export function createGoogleCalendar(dependencies: GoogleDependencies = {}): CalendarPort {
  const fetcher = dependencies.fetcher ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const resolveConfig = dependencies.resolveConfig ?? cfgFor;
  const accessToken = dependencies.accessToken ?? googleAccessToken;

  async function lookup(input: CalendarEventInput, cfg: GoogleCfg, token: string) {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}/events`;
    const response = await fetcher(
      `${base}?privateExtendedProperty=${encodeURIComponent(`ligouKey=${input.idempotencyKey}`)}&maxResults=1&showDeleted=false`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return { base, response };
  }

  return {
    async write(input) {
      const started = Date.now();
      const cfg = await resolveConfig(input.tenantId);
      if (!cfg) return { outcome: "failed", error: "google_not_configured", latencyMs: Date.now() - started };
      const mapping: ProviderMapping = { provider: "google_calendar", accountId: cfg.accountId, calendarId: cfg.calendarId };
      const expected = expectedPayload(input, mapping);
      try {
        const token = await accessToken(cfg, fetcher);
        const { base, response: lookupResponse } = await lookup(input, cfg, token);
        if (!lookupResponse.ok) return { outcome: "unknown", error: `lookup_${lookupResponse.status}`, latencyMs: Date.now() - started };
        const existing = ((await lookupResponse.json()) as any).items?.[0];
        if (existing) return classifyReadback(input, expected, existing, started);

        const createResponse = await fetcher(base, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: input.summary,
            description: input.description,
            start: { dateTime: normalizedInstant(input.startIso) },
            end: { dateTime: normalizedInstant(input.endIso) },
            extendedProperties: { private: expected.privateProperties },
          }),
        });
        if (!createResponse.ok) {
          return {
            outcome: createResponse.status >= 500 ? "unknown" : "failed",
            error: `google_insert_${createResponse.status}`, latencyMs: Date.now() - started,
          };
        }
        const created = (await createResponse.json()) as any;
        const readbackResponse = await fetcher(`${base}/${encodeURIComponent(created.id)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!readbackResponse.ok) return { outcome: "unknown", externalId: created.id, error: `readback_${readbackResponse.status}`, latencyMs: Date.now() - started };
        return classifyReadback(input, expected, await readbackResponse.json(), started);
      } catch (error) {
        return { outcome: "unknown", error: String(error), latencyMs: Date.now() - started };
      }
    },

    async reconcile(input) {
      const started = Date.now();
      const cfg = await resolveConfig(input.tenantId);
      if (!cfg) return { outcome: "failed", error: "google_not_configured", latencyMs: Date.now() - started };
      const expected = expectedPayload(input, { provider: "google_calendar", accountId: cfg.accountId, calendarId: cfg.calendarId });
      try {
        const token = await accessToken(cfg, fetcher);
        const { response } = await lookup(input, cfg, token);
        if (!response.ok) return { outcome: "unknown", error: `lookup_${response.status}`, latencyMs: Date.now() - started };
        const existing = ((await response.json()) as any).items?.[0];
        if (!existing) return { outcome: "unknown", error: "reconcile_absent_manual_review", latencyMs: Date.now() - started };
        return classifyReadback(input, expected, existing, started);
      } catch (error) {
        return { outcome: "unknown", error: String(error), latencyMs: Date.now() - started };
      }
    },

    async busy(tenantId, fromIso, toIso) {
      const cfg = await resolveConfig(tenantId);
      if (!cfg) return { intervals: [], unknown: true };
      try {
        const token = await accessToken(cfg, fetcher);
        const response = await fetcher("https://www.googleapis.com/calendar/v3/freeBusy", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: cfg.calendarId }] }),
        });
        if (!response.ok) return { intervals: [], unknown: true };
        const body = (await response.json()) as any;
        const calendar = body?.calendars?.[cfg.calendarId];
        if (!calendar || calendar.errors?.length) return { intervals: [], unknown: true };
        return { intervals: (calendar.busy ?? []).map((busy: any) => ({ start: busy.start, end: busy.end })) };
      } catch {
        return { intervals: [], unknown: true };
      }
    },
  };
}

export const googleCalendar = createGoogleCalendar();

export function calendarPort(): CalendarPort {
  return googleCfg() ? googleCalendar : fakeCalendar;
}
