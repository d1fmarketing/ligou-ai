import { resolveOwnedTenantForSession } from "../_shared/owned-tenant.ts";

export const BROWSER_SESSION_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APPLICATION_MODE = "application_tts_v1";
const PROVIDER_MODE = "provider_model_v1";
const APPLICATION_STARTUP_DEADLINE_MS = 35_000;
const PROVIDER_STARTUP_DEADLINE_MS = 20_000;
const CANCEL_ACK_POLL_MS = 200;
const CANCEL_ACK_MAX_POLLS = 60;
const CLEANUP_COLUMNS = "id,status,session_type,call_id,answer_sdp,error,opening_mode_requested,opening_mode_applied,opening_payload";
const OPENING_KEYS = [
  "version",
  "item_id",
  "text",
  "text_sha256",
  "audio_base64",
  "audio_sha256",
  "mime",
  "voice",
  "tts_model",
  "cost_usd",
] as const;

type OpeningMode = typeof APPLICATION_MODE | typeof PROVIDER_MODE;

interface BrowserSessionDependencies {
  env(name: string): string | undefined;
  createClient(url: string, serviceKey: string): any;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: BROWSER_SESSION_CORS });
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

export function isApplicationOpeningPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  if (keys.length !== OPENING_KEYS.length || !OPENING_KEYS.every((key) => keys.includes(key))) return false;
  if (payload.version !== 1) return false;
  if (!boundedString(payload.item_id, 32, 32) || !/^lgo-[0-9a-f]{28}$/.test(payload.item_id)) return false;
  if (!boundedString(payload.text, 1, 1000) || !payload.text.trim()) return false;
  if (!boundedString(payload.text_sha256, 64, 64) || !/^[0-9a-f]{64}$/.test(payload.text_sha256)) return false;
  if (!boundedString(payload.audio_base64, 4, 2_000_000)) return false;
  if (payload.audio_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.audio_base64)) return false;
  if (!boundedString(payload.audio_sha256, 64, 64) || !/^[0-9a-f]{64}$/.test(payload.audio_sha256)) return false;
  if (payload.mime !== "audio/mpeg" || payload.voice !== "ash" || payload.tts_model !== "tts-1") return false;
  return typeof payload.cost_usd === "number"
    && Number.isFinite(payload.cost_usd)
    && payload.cost_usd >= 0
    && payload.cost_usd <= 1;
}

function validReadyOpening(
  requested: OpeningMode,
  row: Record<string, unknown>,
): boolean {
  if (!boundedString(row.answer_sdp, 1, 1_000_000) || !boundedString(row.call_id, 1, 128)) return false;
  if (requested === PROVIDER_MODE) {
    return row.opening_mode_applied === PROVIDER_MODE && row.opening_payload === null;
  }
  return row.opening_mode_applied === APPLICATION_MODE
    && isApplicationOpeningPayload(row.opening_payload);
}

async function waitForPollOrAbort(
  signal: AbortSignal,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(300), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function exactExpiredCleanup(
  row: Record<string, unknown>,
  requestId: string,
  expectedCallId: string | null,
): boolean {
  return row.id === requestId
    && row.status === "expired"
    && row.call_id === expectedCallId
    && (expectedCallId === null || (
      row.session_type === "onboarding"
      && row.opening_mode_requested === APPLICATION_MODE
    ))
    && row.answer_sdp === null
    && row.opening_mode_applied === null
    && row.opening_payload === null;
}

function exactCancellableReady(
  row: Record<string, unknown>,
  requestId: string,
  requested: OpeningMode,
  status: "ready" | "cancel_requested",
  expectedCallId?: string,
): boolean {
  return row.id === requestId
    && row.status === status
    && requested === APPLICATION_MODE
    && row.session_type === "onboarding"
    && row.opening_mode_requested === requested
    && (expectedCallId === undefined || row.call_id === expectedCallId)
    && validReadyOpening(requested, row);
}

function exactCancellableProcessing(
  row: Record<string, unknown>,
  requestId: string,
  requested: OpeningMode,
  status: "processing" | "cancel_requested",
  expectedCallId?: string,
): boolean {
  return row.id === requestId
    && row.status === status
    && requested === APPLICATION_MODE
    && row.session_type === "onboarding"
    && row.opening_mode_requested === APPLICATION_MODE
    && typeof row.call_id === "string"
    && (expectedCallId === undefined || row.call_id === expectedCallId)
    && row.answer_sdp === null
    && row.opening_mode_applied === null
    && row.opening_payload === null;
}

async function readCleanupRow(client: any, requestId: string) {
  const { data, error } = await client.from("browser_session_requests")
    .select(CLEANUP_COLUMNS)
    .eq("id", requestId)
    .single();
  return error || !data ? null : data as Record<string, unknown>;
}

async function expireOpenRequest(
  dependencies: BrowserSessionDependencies,
  client: any,
  requestId: string,
  reason: "request_aborted" | "controller_timeout",
  requested: OpeningMode,
): Promise<boolean> {
  const { data: expiredRows, error: expireError } = await client.from("browser_session_requests")
    .update({ status: "expired", error: reason })
    .eq("id", requestId)
    .in("status", ["pending", "processing"])
    .is("call_id", null)
    .select(CLEANUP_COLUMNS);
  if (expireError || !Array.isArray(expiredRows) || expiredRows.length > 1) return false;
  if (expiredRows.length === 1) {
    return exactExpiredCleanup(expiredRows[0], requestId, null);
  }

  let row = await readCleanupRow(client, requestId);
  if (!row) return false;
  if (row.status === "expired") {
    const retainedCallId = typeof row.call_id === "string" ? row.call_id : null;
    return exactExpiredCleanup(row, requestId, retainedCallId);
  }

  let expectedCallId: string;
  let boundKind: "processing" | "ready";
  let sourceStatus: "processing" | "ready";
  if (exactCancellableReady(row, requestId, requested, "ready")) {
    expectedCallId = row.call_id as string;
    boundKind = "ready";
    sourceStatus = "ready";
  } else if (exactCancellableProcessing(row, requestId, requested, "processing")) {
    expectedCallId = row.call_id as string;
    boundKind = "processing";
    sourceStatus = "processing";
  } else if (exactCancellableReady(row, requestId, requested, "cancel_requested")) {
    expectedCallId = row.call_id as string;
    boundKind = "ready";
    sourceStatus = "ready";
  } else if (exactCancellableProcessing(row, requestId, requested, "cancel_requested")) {
    expectedCallId = row.call_id as string;
    boundKind = "processing";
    sourceStatus = "processing";
  } else {
    return false;
  }

  if (row.status !== "cancel_requested") {
    const { data: cancelRows, error: cancelError } = await client.from("browser_session_requests")
      .update({ status: "cancel_requested", error: reason })
      .eq("id", requestId)
      .eq("status", sourceStatus)
      .eq("call_id", expectedCallId)
      .select(CLEANUP_COLUMNS);
    if (cancelError || !Array.isArray(cancelRows) || cancelRows.length > 1) return false;
    if (cancelRows.length === 1) {
      const exact = boundKind === "ready"
        ? exactCancellableReady(cancelRows[0], requestId, requested, "cancel_requested", expectedCallId)
        : exactCancellableProcessing(cancelRows[0], requestId, requested, "cancel_requested", expectedCallId);
      if (!exact) return false;
      row = cancelRows[0];
    } else {
      row = await readCleanupRow(client, requestId);
      if (!row) return false;
      if (exactExpiredCleanup(row, requestId, expectedCallId)) return true;
      const exact = boundKind === "ready"
        ? exactCancellableReady(row, requestId, requested, "cancel_requested", expectedCallId)
        : exactCancellableProcessing(row, requestId, requested, "cancel_requested", expectedCallId);
      if (!exact) return false;
    }
  }

  for (let attempt = 0; attempt < CANCEL_ACK_MAX_POLLS; attempt += 1) {
    await dependencies.sleep(CANCEL_ACK_POLL_MS);
    row = await readCleanupRow(client, requestId);
    if (!row) return false;
    if (exactExpiredCleanup(row, requestId, expectedCallId)) return true;
    const exact = boundKind === "ready"
      ? exactCancellableReady(row, requestId, requested, "cancel_requested", expectedCallId)
      : exactCancellableProcessing(row, requestId, requested, "cancel_requested", expectedCallId);
    if (!exact) return false;
  }
  return false;
}

export function createBrowserSessionHandler(dependencies: BrowserSessionDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { headers: BROWSER_SESSION_CORS });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (request.signal.aborted) return json({ error: "request_aborted" }, 499);

    const url = dependencies.env("SUPABASE_URL");
    const serviceKey = dependencies.env("SERVICE_KEY");
    if (!url || !serviceKey) return json({ error: "server_configuration_error" }, 503);
    const client = dependencies.createClient(url, serviceKey);

    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
    let userResponse: Response;
    try {
      userResponse = await dependencies.fetch(`${url}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: auth },
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) return json({ error: "request_aborted" }, 499);
      throw error;
    }
    if (request.signal.aborted) return json({ error: "request_aborted" }, 499);
    if (!userResponse.ok) return json({ error: "unauthorized" }, 401);
    const user = await userResponse.json().catch(() => null);
    if (!user?.id) return json({ error: "unauthorized" }, 401);

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.sdp) return json({ error: "sdp_required" }, 400);
    const sessionType = typeof body.session_type === "string" ? body.session_type : "owner_browser";
    if (!["customer", "owner_browser", "onboarding"].includes(sessionType)) {
      return json({ error: "invalid_session_type" }, 400);
    }
    const openingModeRequested: OpeningMode = sessionType === "onboarding" ? APPLICATION_MODE : PROVIDER_MODE;
    if (sessionType === "onboarding" && body.opening_mode_requested !== APPLICATION_MODE) {
      return json({ error: "client_upgrade_required" }, 409);
    }

    const defaultTenant = dependencies.env("LIGOU_TENANT") ?? "rocha-plumbing";
    let tenant;
    try {
      tenant = await resolveOwnedTenantForSession(client, String(user.id), defaultTenant);
    } catch (error: any) {
      return json({ error: error?.message ?? "ownership_check_failed" }, error?.status ?? 500);
    }
    if (request.signal.aborted) return json({ error: "request_aborted" }, 499);
    const businessName = typeof tenant.name === "string" ? tenant.name.trim() : "";
    if (!businessName || businessName.length > 256) return json({ error: "tenant_identity_invalid" }, 503);

    const { data: requestRow, error: insertError } = await client.from("browser_session_requests").insert({
      tenant_id: tenant.id,
      user_id: user.id,
      session_type: sessionType,
      model_override: body.model ?? null,
      offer_sdp: String(body.sdp),
      opening_mode_requested: openingModeRequested,
    }).select("id").single();
    if (insertError || !requestRow) return json({ error: `enqueue_failed: ${insertError?.message}` }, 500);

    const stopOpenRequest = async (
      reason: "request_aborted" | "controller_timeout",
      status: 499 | 504,
    ) => {
      const expired = await expireOpenRequest(
        dependencies,
        client,
        String(requestRow.id),
        reason,
        openingModeRequested,
      );
      if (!expired) return json({ error: "request_cleanup_failed" }, 502);
      if (reason === "request_aborted") return json({ error: reason }, status);
      return json({
        error: reason,
        hint: "controller offline? check ligou-controller on the EC2",
      }, status);
    };
    if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);

    const startupDeadline = openingModeRequested === APPLICATION_MODE
      ? APPLICATION_STARTUP_DEADLINE_MS
      : PROVIDER_STARTUP_DEADLINE_MS;
    const deadline = dependencies.now() + startupDeadline;
    while (dependencies.now() < deadline) {
      await waitForPollOrAbort(request.signal, dependencies.sleep);
      if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);
      if (dependencies.now() >= deadline) break;
      const { data: row } = await client.from("browser_session_requests")
        .select("status,answer_sdp,call_id,error,opening_mode_applied,opening_payload")
        .eq("id", requestRow.id)
        .single();
      if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);
      if (!row) break;
      if (row.status === "ready") {
        if (!validReadyOpening(openingModeRequested, row)) {
          const error = openingModeRequested === APPLICATION_MODE
            ? "invalid_application_opening_contract"
            : "invalid_provider_opening_contract";
          return json({ error }, 502);
        }
        const { data: call } = await client.from("calls").select("model").eq("id", row.call_id).single();
        if (request.signal.aborted) return stopOpenRequest("request_aborted", 499);
        return json({
          sdp: row.answer_sdp,
          call_id: row.call_id,
          max_minutes: sessionType === "onboarding" ? 30 : 15,
          model: call?.model ?? null,
          opening_mode_applied: row.opening_mode_applied,
          opening_payload: row.opening_payload,
          business_name: businessName,
        });
      }
      if (row.status === "error") {
        const status = row.error?.includes("budget") ? 402 : 502;
        return json({ error: row.error ?? "session_failed" }, status);
      }
    }
    return stopOpenRequest("controller_timeout", 504);
  };
}
