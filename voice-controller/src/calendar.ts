// CalendarPort — the only hands that touch a calendar. Every write is followed by a READ-BACK: an external id alone
// is never proof (receipts require readback + payload hash). Two adapters: fake (Supabase-backed, default until
// Google Workspace creds exist) and google (googleapis REST, enabled via GOOGLE_* env).
import { createHash } from "node:crypto";
import { supa } from "./rules.ts";

export interface CalendarEventInput {
  tenantId: string;
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
  idempotencyKey: string;
}
export interface CalendarWriteResult {
  outcome: "accepted" | "failed" | "unknown";
  externalId?: string;
  readback?: Record<string, unknown>;
  payloadHash?: string;
  error?: string;
  latencyMs: number;
}

export function payloadHash(input: CalendarEventInput): string {
  return createHash("sha256")
    .update(`${input.tenantId}|${input.summary}|${input.startIso}|${input.endIso}|${input.idempotencyKey}`)
    .digest("hex");
}

export interface BusyInterval { start: string; end: string }

export interface CalendarPort {
  book(input: CalendarEventInput): Promise<CalendarWriteResult>;
  /** Busy intervals overlapping [fromIso, toIso). Never throws: on failure returns `unknown: true` so the
   *  caller degrades honestly (offer fewer/no slots) instead of selling an hour that is already booked. */
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

/** Wall-clock in a tenant's zone -> a real instant (ISO with Z).
 *  Without this, "2026-08-20T08:00:00" is ambiguous: Google's freeBusy rejects it (HTTP 400) and
 *  Date.parse silently reads it as the SERVER's zone (UTC on the EC2) — a 7-hour error that would offer
 *  hours already sold. Observed live on 2026-08-19. */
export function zonedInstantIso(ymd: string, hour: number, tz: string): string {
  const naiveUtc = Date.parse(`${ymd}T${String(hour).padStart(2, "0")}:00:00Z`);
  const firstPass = new Date(naiveUtc - tzOffsetMinutes(new Date(naiveUtc), tz) * 60_000);
  // re-evaluate at the corrected instant so DST transitions land on the right side
  return new Date(naiveUtc - tzOffsetMinutes(firstPass, tz) * 60_000).toISOString();
}

/** Human phrasing for the agent to speak, in the tenant's zone (never the server's). */
export function spokenLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

/** Slot is free when it overlaps no busy interval. Half-open [start, end): touching edges do not collide. */
export function overlapsBusy(startIso: string, endIso: string, busy: BusyInterval[]): boolean {
  const s = Date.parse(startIso), e = Date.parse(endIso);
  return busy.some((b) => {
    const bs = Date.parse(b.start), be = Date.parse(b.end);
    return Number.isFinite(bs) && Number.isFinite(be) && s < be && bs < e;
  });
}

// ---------------------------------------------------------------- fake adapter (deterministic, persisted)
export const fakeCalendar: CalendarPort = {
  async book(input) {
    const started = Date.now();
    const hash = payloadHash(input);
    try {
      // idempotent insert keyed by the server-issued key
      const { data: existing } = await supa()
        .from("fake_calendar_events")
        .select("id,summary,start_iso,end_iso")
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      let id = existing?.id as string | undefined;
      if (!id) {
        const { data, error } = await supa()
          .from("fake_calendar_events")
          .insert({
            tenant_id: input.tenantId,
            summary: input.summary,
            description: input.description,
            start_iso: input.startIso,
            end_iso: input.endIso,
            idempotency_key: input.idempotencyKey,
          })
          .select("id")
          .single();
        if (error) return { outcome: "unknown", error: error.message, latencyMs: Date.now() - started };
        id = data.id;
      }
      // READ-BACK: fetch what the "provider" actually stored
      const { data: readback, error: re } = await supa()
        .from("fake_calendar_events")
        .select("id,summary,start_iso,end_iso,created_at")
        .eq("id", id!)
        .single();
      if (re || !readback) return { outcome: "unknown", externalId: id, error: re?.message, latencyMs: Date.now() - started };
      const matches = readback.start_iso === input.startIso && readback.summary === input.summary;
      if (!matches) return { outcome: "failed", externalId: id, readback, error: "readback_mismatch", latencyMs: Date.now() - started };
      return { outcome: "accepted", externalId: id, readback, payloadHash: hash, latencyMs: Date.now() - started };
    } catch (e) {
      return { outcome: "unknown", error: String(e), latencyMs: Date.now() - started };
    }
  },

  async busy(tenantId, fromIso, toIso) {
    try {
      // overlap test: event starts before the window ends AND ends after it starts
      const { data, error } = await supa()
        .from("fake_calendar_events")
        .select("start_iso,end_iso")
        .eq("tenant_id", tenantId)
        .lt("start_iso", toIso)
        .gt("end_iso", fromIso);
      if (error) return { intervals: [], unknown: true };
      return { intervals: (data ?? []).map((r: any) => ({ start: r.start_iso, end: r.end_iso })) };
    } catch {
      return { intervals: [], unknown: true };
    }
  },
};

// ---------------------------------------------------------------- google adapter (real; no third-party MCP)
// Two auth shapes, both ending in an access token:
//   (a) service account INVITED to a calendar the tenant owns (RJ's choice 2026-08-19) — signed JWT grant.
//       The robot is a guest with edit rights; the human stays the owner, and nothing expires.
//   (b) classic user OAuth refresh token — kept for tenants whose own calendar we connect later.
// No attendees are ever sent (inviting guests would require domain-wide delegation).
interface GoogleCfg {
  calendarId: string;
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
      sa: { clientEmail: GOOGLE_SA_CLIENT_EMAIL, privateKey: GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, "\n") },
    };
  }
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN) {
    return { calendarId: GOOGLE_CALENDAR_ID, oauth: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN } };
  }
  return null;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b as any).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RS256-signed JWT assertion -> access token (service account flow, no user interaction, no expiry). */
async function saAccessToken(sa: { clientEmail: string; privateKey: string }): Promise<string> {
  const { createSign } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.clientEmail,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.privateKey));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
  });
  if (!res.ok) throw new Error(`google_sa_token_failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as any).access_token;
}

async function googleAccessToken(cfg: GoogleCfg): Promise<string> {
  if (cfg.sa) return saAccessToken(cfg.sa);
  const o = cfg.oauth!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: o.clientId, client_secret: o.clientSecret,
      refresh_token: o.refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`google_token_failed: ${res.status}`);
  return ((await res.json()) as any).access_token;
}

export const googleCalendar: CalendarPort = {
  async book(input) {
    const started = Date.now();
    const cfg = googleCfg();
    if (!cfg) return { outcome: "failed", error: "google_not_configured", latencyMs: 0 };
    const hash = payloadHash(input);
    try {
      const token = await googleAccessToken(cfg);
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId)}/events`;

      // IDEMPOTENCY IS A QUERY, NOT A COMMENT: the key lives in extendedProperties and is looked up BEFORE
      // any insert — a retry (tool re-fire, timeout, barge-in double-submit) must find the existing event,
      // never create a twin. (First E2E proof caught exactly this: the key was only written into the
      // description, so a same-key retry duplicated the booking.)
      const lookup = await fetch(
        `${base}?privateExtendedProperty=${encodeURIComponent(`ligouKey=${input.idempotencyKey}`)}&maxResults=1&showDeleted=false`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (lookup.ok) {
        const existing = ((await lookup.json()) as any).items?.[0];
        if (existing?.id && existing.status !== "cancelled") {
          return {
            outcome: "accepted", externalId: existing.id,
            readback: { id: existing.id, start: existing.start, status: existing.status, reused: true },
            payloadHash: hash, latencyMs: Date.now() - started,
          };
        }
      }

      const res = await fetch(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: input.summary,
          description: input.description,
          start: { dateTime: input.startIso },
          end: { dateTime: input.endIso },
          extendedProperties: { private: { ligouKey: input.idempotencyKey } },
          // no attendees in MVP (invites require DWD)
        }),
      });
      if (!res.ok) {
        const outcome = res.status >= 500 ? "unknown" : "failed";
        return { outcome, error: `google_insert_${res.status}`, latencyMs: Date.now() - started };
      }
      const event = (await res.json()) as any;
      // READ-BACK
      const rb = await fetch(`${base}/${encodeURIComponent(event.id)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!rb.ok) return { outcome: "unknown", externalId: event.id, error: `readback_${rb.status}`, latencyMs: Date.now() - started };
      const readback = (await rb.json()) as any;
      const ok = readback?.status !== "cancelled" && readback?.start?.dateTime;
      return ok
        ? { outcome: "accepted", externalId: event.id, readback: { id: readback.id, start: readback.start, status: readback.status }, payloadHash: hash, latencyMs: Date.now() - started }
        : { outcome: "failed", externalId: event.id, readback, error: "readback_invalid", latencyMs: Date.now() - started };
    } catch (e) {
      return { outcome: "unknown", error: String(e), latencyMs: Date.now() - started };
    }
  },

  // Every `unknown` path logs WHY. Silence here cost a full debugging round on 2026-08-19: the agent kept
  // saying "I can't confirm the schedule" while the same call succeeded from a probe, and nothing said why.
  async busy(_tenantId, fromIso, toIso) {
    const cfg = googleCfg();
    if (!cfg) { console.warn("calendar.busy unknown: not_configured"); return { intervals: [], unknown: true }; }
    try {
      const token = await googleAccessToken(cfg);
      const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: cfg.calendarId }] }),
      });
      if (!res.ok) {
        console.warn(`calendar.busy unknown: http_${res.status} window=${fromIso}..${toIso} body=${(await res.text()).slice(0, 220)}`);
        return { intervals: [], unknown: true };
      }
      const body = (await res.json()) as any;
      const cal = body?.calendars?.[cfg.calendarId];
      if (!cal || cal.errors?.length) {
        console.warn(`calendar.busy unknown: calendar_entry ${JSON.stringify(cal?.errors ?? Object.keys(body?.calendars ?? {})).slice(0, 220)}`);
        return { intervals: [], unknown: true };
      }
      return { intervals: (cal.busy ?? []).map((b: any) => ({ start: b.start, end: b.end })) };
    } catch (e) {
      console.warn(`calendar.busy unknown: threw ${String(e).slice(0, 220)}`);
      return { intervals: [], unknown: true };
    }
  },
};

export function calendarPort(): CalendarPort {
  return googleCfg() ? googleCalendar : fakeCalendar;
}
