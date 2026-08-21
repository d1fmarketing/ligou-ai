import { config } from "./config.ts";
import { supa } from "./rules.ts";

export type ProviderTerminationMode = "reject" | "hangup";
export type FetchLike = typeof fetch;
export type ProviderTerminationResult = { confirmed: boolean; error?: string };

export async function requestProviderTermination(args: {
  openaiCallId: string | null;
  mode: ProviderTerminationMode;
  fetchImpl?: FetchLike;
}): Promise<ProviderTerminationResult> {
  if (!args.openaiCallId) return { confirmed: false, error: "provider_call_id_unknown" };
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(args.openaiCallId)}/${args.mode}`,
      { method: "POST", headers: { Authorization: `Bearer ${config.openaiKey}` } },
    );
    if (!response.ok) return { confirmed: false, error: `provider_${args.mode}_failed: ${response.status}` };
    return { confirmed: true };
  } catch (error) {
    return { confirmed: false, error: `provider_${args.mode}_transport_unknown: ${String(error)}`.slice(0, 400) };
  }
}

export async function terminateProviderCall(args: {
  callId: string;
  openaiCallId: string | null;
  mode: ProviderTerminationMode;
  reason: string;
  fetchImpl?: FetchLike;
}): Promise<{ confirmed: boolean; error?: string }> {
  const s = supa();
  const pending = await s.from("calls").update({
    provider_termination_state: "pending",
    provider_termination_mode: args.mode,
    provider_termination_reason: args.reason,
    provider_termination_last_error: null,
  }).eq("id", args.callId);
  if (pending.error) return { confirmed: false, error: `termination_state_write_failed: ${pending.error.message}` };

  const result = await requestProviderTermination({
    openaiCallId: args.openaiCallId,
    mode: args.mode,
    fetchImpl: args.fetchImpl,
  });
  if (result.confirmed) {
    const confirmed = await s.from("calls").update({
      provider_termination_state: "confirmed",
      provider_termination_last_error: null,
      provider_terminated_at: new Date().toISOString(),
    }).eq("id", args.callId);
    if (confirmed.error) return { confirmed: false, error: `termination_confirmation_write_failed: ${confirmed.error.message}` };
    return { confirmed: true };
  }
  await s.from("calls").update({ provider_termination_state: "unknown", provider_termination_last_error: result.error }).eq("id", args.callId);
  return result;
}
