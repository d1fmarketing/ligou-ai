// Post-login owner bootstrap: the authoritative tenant comes from
// ensure_owner_tenant() — never from listing tenant rows — and the Google
// provider tokens are handed to the trusted Edge function exactly once, bound
// to a single-use intent. Provider tokens exist only inside this call frame.

export const RECONNECT_FLAG = "ligou.reconnect.pending";
export const CONSENT_RETRY_FLAG = "ligou.consent.retry";

function toBase64Url(bytes) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readConnectorStatus(client, tenantId) {
  const { data, error } = await client.rpc("get_connector_status", { p_tenant: tenantId });
  if (error) throw new Error(error.message || "connector_status_failed");
  const row = Array.isArray(data) ? data[0] ?? null : data;
  return { connector_status: row?.status ?? null, account_email: row?.account_email ?? null };
}

export async function runOwnerBootstrap({
  client,
  session,
  providerToken,
  providerRefreshToken,
  functionsBase,
  flagStorage,
  fetchImpl,
  onStage,
}) {
  const doFetch = fetchImpl ?? fetch;
  onStage?.("tenant");
  const { data: tenant, error: tenantError } = await client.rpc("ensure_owner_tenant", {});
  if (tenantError || !tenant?.tenant_id) {
    throw new Error(tenantError?.message || "tenant_bootstrap_failed");
  }

  onStage?.("calendar");
  if (!providerToken) {
    const connector = await readConnectorStatus(client, tenant.tenant_id);
    return { tenant, connector };
  }

  const kind = flagStorage.getItem(RECONNECT_FLAG) ? "reconnect" : "login";
  flagStorage.removeItem(RECONNECT_FLAG);

  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = toBase64Url(nonceBytes);
  const nonceHash = await sha256Hex(nonceBytes);

  const { data: intent, error: intentError } = await client.rpc("begin_connector_handoff", {
    p_tenant: tenant.tenant_id,
    p_kind: kind,
    p_nonce_hash: nonceHash,
  });
  if (intentError || !intent?.intent_id) {
    throw new Error(intentError?.message || "handoff_intent_failed");
  }

  const response = await doFetch(`${functionsBase}/google-handoff`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent_id: intent.intent_id,
      nonce,
      tenant_id: tenant.tenant_id,
      provider: "google",
      provider_token: providerToken,
      provider_refresh_token: providerRefreshToken ?? null,
    }),
  });
  const connector = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(connector?.error || "handoff_failed");
  }

  if (connector.connector_status === "active") {
    flagStorage.removeItem(CONSENT_RETRY_FLAG);
    return { tenant, connector };
  }

  if (connector.needs_consent && !flagStorage.getItem(CONSENT_RETRY_FLAG)) {
    // Google only returns a refresh token on a consent grant; retry once with
    // prompt=consent, then stop — never an unbounded redirect loop.
    flagStorage.setItem(CONSENT_RETRY_FLAG, "1");
    return { tenant, connector, action: "reauth_consent" };
  }

  return { tenant, connector };
}
