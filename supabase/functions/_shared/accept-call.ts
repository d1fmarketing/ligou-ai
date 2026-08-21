export async function persistPhoneEvent(client: any, row: Record<string, unknown>): Promise<Response> {
  const { error } = await client.from("phone_events").upsert(row, {
    onConflict: "openai_call_id",
    ignoreDuplicates: true,
  });
  if (error) return Response.json({ error: "phone_event_persistence_failed" }, { status: 503 });
  return Response.json({ received: true });
}
