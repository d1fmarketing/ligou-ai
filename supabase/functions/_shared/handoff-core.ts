// Pure validation and decision logic for the one-time Google provider-token handoff.
// No I/O here: the Edge function supplies the network and storage; these functions
// decide. Error messages are short, fixed strings — token material never enters them.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]{43,}$/; // 32+ bytes of nonce
const MAX_TOKEN_LENGTH = 16_384;

export const REQUIRED_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
] as const;

export interface HandoffRequest {
  intentId: string;
  nonce: string;
  tenantId: string;
  provider: "google";
  providerToken: string;
  providerRefreshToken: string | null;
}

export function parseHandoffRequest(body: unknown): HandoffRequest {
  if (typeof body !== "object" || body === null) throw new Error("handoff_body_invalid");
  const record = body as Record<string, unknown>;
  const intentId = record.intent_id;
  if (typeof intentId !== "string" || !UUID.test(intentId)) throw new Error("handoff_intent_invalid");
  const nonce = record.nonce;
  if (typeof nonce !== "string" || !BASE64URL.test(nonce)) throw new Error("handoff_nonce_invalid");
  const tenantId = record.tenant_id;
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new Error("handoff_tenant_invalid");
  if (record.provider !== "google") throw new Error("handoff_provider_invalid");
  const providerToken = record.provider_token;
  if (typeof providerToken !== "string" || providerToken.length === 0 || providerToken.length > MAX_TOKEN_LENGTH) {
    throw new Error("handoff_provider_token_invalid");
  }
  const rawRefresh = record.provider_refresh_token;
  let providerRefreshToken: string | null = null;
  if (typeof rawRefresh === "string" && rawRefresh.length > 0) {
    if (rawRefresh.length > MAX_TOKEN_LENGTH) throw new Error("handoff_refresh_token_invalid");
    providerRefreshToken = rawRefresh;
  } else if (rawRefresh !== undefined && rawRefresh !== null && rawRefresh !== "") {
    throw new Error("handoff_refresh_token_invalid");
  }
  return {
    intentId: intentId.toLowerCase(),
    nonce,
    tenantId: tenantId.toLowerCase(),
    provider: "google",
    providerToken,
    providerRefreshToken,
  };
}

function fromBase64Url(value: string) {
  if (!BASE64URL.test(value)) throw new Error("handoff_nonce_invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function nonceHashFromBase64Url(nonce: string): Promise<string> {
  const bytes = fromBase64Url(nonce);
  if (bytes.length < 32) throw new Error("handoff_nonce_invalid");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface TokenInfoExpectations {
  clientId: string;
  expectedSubject: string | null;
  expectedEmail: string | null;
}

export interface VerifiedTokenInfo {
  scopes: string;
  email: string | null;
}

export function verifyTokenInfo(info: unknown, expectations: TokenInfoExpectations): VerifiedTokenInfo {
  if (typeof info !== "object" || info === null) throw new Error("provider_token_invalid");
  const record = info as Record<string, unknown>;
  if (record.aud !== expectations.clientId) throw new Error("provider_audience_mismatch");
  const subject = typeof record.sub === "string" ? record.sub : null;
  if (expectations.expectedSubject && subject !== expectations.expectedSubject) {
    throw new Error("provider_subject_mismatch");
  }
  const email = typeof record.email === "string" && record.email.length > 0 ? record.email.toLowerCase() : null;
  if (expectations.expectedEmail && email && email !== expectations.expectedEmail.toLowerCase()) {
    throw new Error("provider_account_mismatch");
  }
  const scopes = typeof record.scope === "string" ? record.scope : "";
  const granted = new Set(scopes.split(/\s+/).filter(Boolean));
  for (const required of REQUIRED_CALENDAR_SCOPES) {
    if (!granted.has(required)) throw new Error("provider_scope_missing");
  }
  const expiresIn = Number(record.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("provider_token_expired");
  return { scopes, email };
}

export type ConnectorStatus = "active" | "revoked" | "error" | "reconnect_required";
export type HandoffKind = "login" | "reconnect";
export type ConnectorDecision = "activate" | "preserve_active" | "refuse_reactivation" | "needs_refresh_token";

// The custody state machine:
// - an active connector is preserved when no new refresh token arrives and rotated when one does;
// - a revoked or errored connector is never reactivated by a plain login — only an explicit
//   reconnect from Settings (which re-runs consent) may activate it;
// - a missing or reconnect_required connector activates only with a real refresh token.
export function decideConnectorTransition(input: {
  existingStatus: ConnectorStatus | null;
  kind: HandoffKind;
  hasRefreshToken: boolean;
}): ConnectorDecision {
  const { existingStatus, kind, hasRefreshToken } = input;
  if (kind !== "login" && kind !== "reconnect") throw new Error("handoff_kind_invalid");
  if (existingStatus === "active") return hasRefreshToken ? "activate" : "preserve_active";
  if (existingStatus === "revoked" || existingStatus === "error") {
    if (kind !== "reconnect") return "refuse_reactivation";
    return hasRefreshToken ? "activate" : "needs_refresh_token";
  }
  if (existingStatus === "reconnect_required" || existingStatus === null) {
    return hasRefreshToken ? "activate" : "needs_refresh_token";
  }
  throw new Error("connector_status_unknown");
}
