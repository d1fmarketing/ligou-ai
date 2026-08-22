// Safe projections over the connector RPCs. Only display-safe fields survive:
// ciphertext, IVs, key versions and any token-shaped field are dropped here even
// if a future RPC were to leak them.
const UUID = /^[a-f0-9-]{36}$/i;

export async function loadConnectorStatus(client, tenantId) {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new Error("tenant_required");
  const { data, error } = await client.rpc("get_connector_status", { p_tenant: tenantId });
  if (error) throw new Error(error.message || "connector_status_failed");
  const rows = Array.isArray(data) ? data : [];
  if (rows.length > 1) throw new Error("connector_status_ambiguous");
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    provider: row.provider ?? null,
    account_email: row.account_email ?? null,
    calendar_id: row.calendar_id ?? null,
    status: row.status ?? null,
    connected_at: row.connected_at ?? null,
    scopes: row.scopes ?? null,
    last_success_at: row.last_success_at ?? null,
  };
}

export async function loadCalendarTestState(client, tenantId) {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new Error("tenant_required");
  const { data, error } = await client.rpc("get_calendar_test_state", { p_tenant: tenantId });
  if (error) throw new Error(error.message || "calendar_test_state_failed");
  if (!data || data.outcome === undefined) return null;
  return {
    outcome: data.outcome ?? null,
    event_id: data.event_id ?? null,
    summary: data.summary ?? null,
    start_iso: data.start_iso ?? null,
    end_iso: data.end_iso ?? null,
    time_zone: data.time_zone ?? null,
    attempt_count: data.attempt_count ?? 0,
    accepted_at: data.accepted_at ?? null,
    readback_summary: data.readback_summary ?? null,
    readback_start_iso: data.readback_start_iso ?? null,
    readback_end_iso: data.readback_end_iso ?? null,
    last_error: data.last_error ?? null,
  };
}
