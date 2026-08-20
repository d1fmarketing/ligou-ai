export async function loadConnectorStatus(client) {
  const { data, error } = await client.rpc("get_connector_status");
  if (error) throw new Error(error.message);
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
