// Owner-triggered Google Calendar proof for V0.2 M1: real free/busy and one
// deterministic, at-most-once test event with exact read-back. The connector is
// selected strictly by the owner's tenant UUID — a connector that is missing or
// not active fails closed with its truthful state; there is no fallback calendar.
// Deploy: supabase functions deploy calendar-test --no-verify-jwt   (JWT verified explicitly)
import { createClient } from "@supabase/supabase-js";
import { decryptConnectorToken } from "../_shared/connector-crypto.ts";
import {
  TEST_EVENT_SUMMARY,
  classifyInsertStatus,
  deterministicTestEventId,
  nextTenantHourWindow,
  normalizeGoogleDateTime,
  verifyTestEventReadback,
} from "../_shared/calendar-test-core.ts";
import { requireTenantOwnerById } from "../_shared/tenant-ownership-id.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PROVIDER = "google_calendar";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

interface ConnectorRow {
  refresh_token_ciphertext: string | null;
  refresh_token_iv: string | null;
  token_key_version: number | null;
  token_account_ref: string | null;
  calendar_id: string | null;
  account_email: string | null;
  status: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SERVICE_KEY");
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const encryptionKey = Deno.env.get("CONNECTOR_TOKEN_ENCRYPTION_KEY");
  if (!url || !serviceKey || !clientId || !clientSecret || !encryptionKey) {
    return reply({ error: "calendar_test_not_configured" }, 503);
  }
  const supa = createClient(url, serviceKey, { auth: { persistSession: false } });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: auth } });
  if (!userRes.ok) return reply({ error: "unauthorized" }, 401);
  const user = await userRes.json();
  if (!user?.id) return reply({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== "freebusy" && action !== "test_event") return reply({ error: "action_invalid" }, 400);

  let tenant;
  try {
    tenant = await requireTenantOwnerById(supa, String(body?.tenant_id ?? ""), user.id);
  } catch (error: any) {
    return reply({ error: error?.message ?? "ownership_check_failed" }, error?.status ?? 500);
  }

  const { data: connector, error: connectorError } = await supa
    .from("connector_accounts")
    .select("refresh_token_ciphertext,refresh_token_iv,token_key_version,token_account_ref,calendar_id,account_email,status")
    .eq("tenant_id", tenant.id)
    .eq("provider", PROVIDER)
    .maybeSingle<ConnectorRow>();
  if (connectorError) return reply({ error: "connector_lookup_failed" }, 500);
  if (!connector || connector.status !== "active") {
    return reply({ error: "connector_not_active", connector_status: connector?.status ?? null }, 409);
  }
  if (!connector.refresh_token_ciphertext || !connector.refresh_token_iv
    || connector.token_key_version === null || !connector.token_account_ref) {
    return reply({ error: "connector_malformed", connector_status: connector.status }, 500);
  }

  const markConnector = async (status: string, lastError: string) => {
    await supa
      .from("connector_accounts")
      .update({ status, last_error: lastError, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenant.id)
      .eq("provider", PROVIDER);
  };
  const markSuccess = async () => {
    await supa
      .from("connector_accounts")
      .update({ last_success_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("tenant_id", tenant.id)
      .eq("provider", PROVIDER);
  };

  let refreshToken: string;
  try {
    refreshToken = await decryptConnectorToken(
      {
        ciphertext: connector.refresh_token_ciphertext,
        iv: connector.refresh_token_iv,
        keyVersion: connector.token_key_version,
      },
      {
        tenantId: tenant.id,
        provider: PROVIDER,
        accountRef: connector.token_account_ref,
        keyVersion: connector.token_key_version,
      },
      { 1: encryptionKey },
    );
  } catch {
    return reply({ error: "connector_token_decrypt_failed" }, 500);
  }

  let accessToken: string;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (tokenRes.status === 400) {
      const detail = await tokenRes.json().catch(() => ({}));
      if (detail?.error === "invalid_grant") {
        // The account revoked our access: record the truth; login alone must not undo this.
        await markConnector("revoked", "google_refresh_invalid_grant");
        return reply({ error: "connector_revoked", connector_status: "revoked" }, 409);
      }
      await markConnector("error", `google_token_failed:${detail?.error ?? "400"}`);
      return reply({ error: "google_token_failed", connector_status: "error" }, 502);
    }
    if (!tokenRes.ok) {
      // Transient provider trouble: no connector downgrade without a definitive verdict.
      return reply({ error: "google_token_unavailable" }, 502);
    }
    const tokenBody = await tokenRes.json();
    if (typeof tokenBody?.access_token !== "string" || !tokenBody.access_token) {
      return reply({ error: "google_token_unavailable" }, 502);
    }
    accessToken = tokenBody.access_token;
  } catch {
    return reply({ error: "google_token_unavailable" }, 502);
  }

  const calendarId = connector.calendar_id || "primary";
  const calendarPath = encodeURIComponent(calendarId);
  const googleHeaders = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };

  if (action === "freebusy") {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
    try {
      const fbRes = await fetch(`${CALENDAR_BASE}/freeBusy`, {
        method: "POST",
        headers: googleHeaders,
        body: JSON.stringify({ timeMin, timeMax, items: [{ id: calendarId }] }),
      });
      if (!fbRes.ok) return reply({ error: `freebusy_failed:${fbRes.status}` }, 502);
      const fb = await fbRes.json();
      const entry = fb?.calendars?.[calendarId];
      if (!entry) return reply({ error: "freebusy_calendar_missing" }, 502);
      if (Array.isArray(entry.errors) && entry.errors.length > 0) {
        await markConnector("error", `freebusy_calendar_error:${entry.errors[0]?.reason ?? "unknown"}`);
        return reply({ error: "freebusy_calendar_error", connector_status: "error" }, 502);
      }
      const busy = Array.isArray(entry.busy) ? entry.busy.slice(0, 20) : [];
      await markSuccess();
      return reply({
        ok: true,
        calendar_id: calendarId,
        account_email: connector.account_email,
        time_min: timeMin,
        time_max: timeMax,
        busy_count: Array.isArray(entry.busy) ? entry.busy.length : 0,
        busy,
      });
    } catch {
      return reply({ error: "freebusy_unavailable" }, 502);
    }
  }

  // action === "test_event"
  const eventId = await deterministicTestEventId(tenant.id);
  const timeZone = tenant.timezone || "America/Los_Angeles";
  const window = nextTenantHourWindow(Date.now(), timeZone);

  const { data: begin, error: beginError } = await supa.rpc("begin_calendar_test_attempt", {
    p_tenant: tenant.id,
    p_event_id: eventId,
    p_summary: TEST_EVENT_SUMMARY,
    p_start_iso: window.startIso,
    p_end_iso: window.endIso,
    p_time_zone: timeZone,
  });
  if (beginError || !begin?.decision) return reply({ error: "calendar_test_state_failed" }, 500);

  const expected = {
    eventId,
    summary: String(begin.summary),
    startIso: String(begin.start_iso),
    endIso: String(begin.end_iso),
  };

  const readbackEvent = async () => {
    const res = await fetch(`${CALENDAR_BASE}/calendars/${calendarPath}/events/${eventId}`, { headers: googleHeaders });
    return { status: res.status, body: res.ok ? await res.json() : null };
  };
  const canonicalReadback = (resource: Record<string, unknown>) => ({
    id: resource.id,
    summary: resource.summary,
    status: resource.status,
    start_iso: normalizeGoogleDateTime(resource.start),
    end_iso: normalizeGoogleDateTime(resource.end),
    calendar_id: calendarId,
    html_link: typeof resource.htmlLink === "string" ? resource.htmlLink : null,
  });
  const recordResult = async (outcome: string, readback: Record<string, unknown> | null, errorText: string | null) => {
    const { data, error } = await supa.rpc("record_calendar_test_result", {
      p_tenant: tenant.id,
      p_outcome: outcome,
      p_event_id: eventId,
      p_readback: readback,
      p_error: errorText,
    });
    if (error) throw new Error("calendar_test_record_failed");
    return data;
  };

  const verifyAndAccept = async (label: string) => {
    const readback = await readbackEvent();
    if (readback.status === 404) {
      await recordResult("reconciliation_required", null, `${label}:readback_absent`);
      return reply({ outcome: "reconciliation_required", event_id: eventId, detail: "readback_absent" });
    }
    if (readback.status !== 200 || !readback.body) {
      await recordResult("reconciliation_required", null, `${label}:readback_unavailable:${readback.status}`);
      return reply({ outcome: "reconciliation_required", event_id: eventId, detail: "readback_unavailable" });
    }
    const verdict = verifyTestEventReadback(expected, readback.body);
    if (!verdict.ok) {
      await recordResult("failed", null, `${label}:readback_mismatch:${verdict.field}`);
      return reply({ outcome: "failed", event_id: eventId, mismatch: verdict.field }, 502);
    }
    const receipt = await recordResult("accepted", canonicalReadback(readback.body), null);
    await markSuccess();
    return reply({
      outcome: "accepted",
      reused: receipt?.reused === true,
      event_id: eventId,
      summary: expected.summary,
      start_iso: expected.startIso,
      end_iso: expected.endIso,
      time_zone: timeZone,
      readback: canonicalReadback(readback.body),
    });
  };

  try {
    if (begin.decision === "accepted_exists") {
      // Terminal receipt already exists: confirm the event is still readable, never write.
      const readback = await readbackEvent();
      return reply({
        outcome: "accepted",
        reused: true,
        event_id: eventId,
        summary: expected.summary,
        start_iso: expected.startIso,
        end_iso: expected.endIso,
        time_zone: timeZone,
        live_event: readback.status === 200 ? "present" : `unreadable:${readback.status}`,
      });
    }

    if (begin.decision === "reconcile_only") {
      // A previous attempt has unknown provider state: lookup only, no second POST ever.
      return await verifyAndAccept("reconcile");
    }

    // decision === "proceed": the single allowed POST for this attempt.
    let insertStatus: number;
    let insertReason = "";
    try {
      const insertRes = await fetch(`${CALENDAR_BASE}/calendars/${calendarPath}/events`, {
        method: "POST",
        headers: googleHeaders,
        body: JSON.stringify({
          id: eventId,
          summary: TEST_EVENT_SUMMARY,
          start: { dateTime: expected.startIso, timeZone },
          end: { dateTime: expected.endIso, timeZone },
          extendedProperties: { private: { ligouTestKey: eventId, ligouTenantId: tenant.id } },
        }),
      });
      insertStatus = insertRes.status;
      if (!insertRes.ok) {
        // Provider reasons are short enum-like strings (never token material);
        // keep only a sanitized slice so failures are diagnosable.
        const detail = await insertRes.json().catch(() => null);
        const reason = detail?.error?.errors?.[0]?.reason ?? detail?.error?.status ?? "";
        const message = detail?.error?.message ?? "";
        insertReason = `${reason}:${message}`.replace(/[^\w :._-]/g, "").slice(0, 120);
      }
    } catch {
      // The request may or may not have reached Google: unknown, never re-POST.
      await recordResult("reconciliation_required", null, "insert_outcome_unknown:network");
      return reply({ outcome: "reconciliation_required", event_id: eventId, detail: "insert_outcome_unknown" });
    }

    const classification = classifyInsertStatus(insertStatus);
    if (classification === "unknown") {
      await recordResult("reconciliation_required", null, `insert_outcome_unknown:${insertStatus}`);
      return reply({ outcome: "reconciliation_required", event_id: eventId, detail: "insert_outcome_unknown" });
    }
    if (classification === "failed") {
      await recordResult("failed", null, `insert_rejected:${insertStatus}:${insertReason}`);
      return reply({ outcome: "failed", event_id: eventId, detail: `insert_rejected:${insertStatus}:${insertReason}` }, 502);
    }
    // created or duplicate (idempotent replay of the deterministic id): exact read-back decides.
    return await verifyAndAccept(classification);
  } catch (error) {
    const message = error instanceof Error ? error.message : "calendar_test_failed";
    return reply({ error: message === "calendar_test_record_failed" ? message : "calendar_test_failed" }, 500);
  }
});
