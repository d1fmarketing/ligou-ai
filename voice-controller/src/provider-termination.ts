import { config } from "./config.ts";
import { supa } from "./rules.ts";

export type ProviderTerminationMode = "reject" | "hangup";
export type FetchLike = typeof fetch;
export type ProviderTerminationResult = { confirmed: boolean; error?: string };
export const PROVIDER_TERMINATION_TIMEOUT_MS = 5_000;

export async function requestProviderTermination(args: {
  openaiCallId: string | null;
  mode: ProviderTerminationMode;
  requestId: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}): Promise<ProviderTerminationResult> {
  if (!args.openaiCallId) return { confirmed: false, error: "provider_call_id_unknown" };
  if (!args.requestId?.trim()) return { confirmed: false, error: "provider_request_id_required" };
  const timeoutMs = args.timeoutMs ?? PROVIDER_TERMINATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 15_000) {
    return { confirmed: false, error: "provider_termination_timeout_invalid" };
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = (async (): Promise<ProviderTerminationResult> => {
    try {
      const response = await fetchImpl(
      `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(args.openaiCallId)}/${args.mode}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openaiKey}`,
            "X-Client-Request-Id": args.requestId,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) return { confirmed: false, error: `provider_${args.mode}_failed: ${response.status}` };
      return { confirmed: true };
    } catch (error) {
      if (controller.signal.aborted) return { confirmed: false, error: `provider_${args.mode}_timeout` };
      return { confirmed: false, error: `provider_${args.mode}_transport_unknown: ${String(error)}`.slice(0, 400) };
    }
  })();
  const timeout = new Promise<ProviderTerminationResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ confirmed: false, error: `provider_${args.mode}_timeout` });
    }, timeoutMs);
  });
  const result = await Promise.race([request, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function terminateProviderCall(args: {
  callId: string;
  openaiCallId: string | null;
  mode: ProviderTerminationMode;
  reason: string;
  fetchImpl?: FetchLike;
}): Promise<{ confirmed: boolean; error?: string }> {
  const s = supa();
  const { data: attempt, error: beginError } = await s.rpc("begin_provider_termination_attempt", {
    p_call_id: args.callId,
    p_openai_call_id: args.openaiCallId,
    p_mode: args.mode,
    p_reason: args.reason,
  });
  if (beginError || !attempt) return { confirmed: false, error: `termination_state_write_failed: ${beginError?.message ?? "attempt_missing"}` };
  const claimed = attempt as any;
  if (claimed.should_attempt !== true) {
    const { data: readback, error: readbackError } = await s
      .from("calls")
      .select("id,openai_call_id,provider_termination_state")
      .eq("id", args.callId)
      .maybeSingle();
    if (
      readbackError ||
      readback?.id !== args.callId ||
      !args.openaiCallId ||
      readback.openai_call_id !== args.openaiCallId ||
      readback.provider_termination_state !== "confirmed"
    ) return {
      confirmed: false,
      error: `provider_termination_already_attempted:${String(
        readback?.provider_termination_state ?? "missing",
      )}`,
    };
    return { confirmed: true };
  }

  const result = await requestProviderTermination({
    openaiCallId: claimed.openai_call_id ? String(claimed.openai_call_id) : args.openaiCallId,
    mode: claimed.provider_termination_mode === "reject" ? "reject" : "hangup",
    requestId: String(claimed.request_id ?? ""),
    fetchImpl: args.fetchImpl,
  });
  const { data: completed, error: completeError } = await s.rpc("complete_provider_termination_attempt", {
    p_call_id: args.callId,
    p_attempt_id: String(claimed.attempt_id ?? ""),
    p_confirmed: result.confirmed,
    p_error: result.error ?? null,
  });
  if (completeError || completed !== true) {
    return { confirmed: false, error: `termination_confirmation_write_failed: ${completeError?.message ?? "attempt_not_completed"}` };
  }
  return result;
}
