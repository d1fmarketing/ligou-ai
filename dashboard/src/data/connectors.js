export async function loadConnectorStatus(client, tenantId) {
  if (typeof tenantId !== "string" || !/^[a-f0-9-]{36}$/i.test(tenantId)) throw new Error("tenant_required");
  const { data, error } = await client.rpc("get_connector_status", { p_tenant: tenantId });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data) || data.length > 1) throw new Error("connector_status_ambiguous");
  const row = data?.[0];
  if (!row) return null;
  return {
    provider: row.provider,
    account_email: row.account_email ?? null,
    calendar_id: row.calendar_id,
    status: row.status,
    connected_at: row.connected_at,
  };
}
