// Inbound phone orchestration. Database claim/transition RPCs own the lifecycle;
// provider writes occur only after their corresponding durable intent.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";
import { buildInstructions } from "./instructions.ts";
import { loadTenant, supa } from "./rules.ts";
import { makeCapability, toolSchemas } from "./tools.ts";
import { attachSideband, type SidebandControl } from "./sideband.ts";
import {
  requestProviderTermination,
  type FetchLike,
  type ProviderTerminationMode,
} from "./provider-termination.ts";

type PhoneAcceptState = "not_attempted" | "attempting" | "accepted" | "failed" | "unknown";
type PhoneRuntime = {
  workerId?: string;
  fetchImpl?: FetchLike;
  attachSidebandImpl?: typeof attachSideband;
};

type PhoneClaim = { id: string; claim_token: string; openai_call_id: string };
type PhoneTerminationClaim = {
  event_id: string;
  claim_token: string;
  action: "terminate" | "resolve_not_applicable";
  request_id?: string;
  openai_call_id: string | null;
  provider_termination_mode: ProviderTerminationMode;
};

function runtimeError(message: string, status: number, detail?: string) {
  return Object.assign(new Error(message), { status, detail });
}

async function requiredRpc<T>(name: string, args: Record<string, unknown>, message: string): Promise<T> {
  const { data, error } = await supa().rpc(name, args);
  if (error || data === null || data === false) {
    throw runtimeError(message, 503, error?.message ?? "lifecycle_write_failed");
  }
  return data as T;
}

async function claimPhoneEvent(eventId: string, workerId: string): Promise<PhoneClaim | null> {
  const { data, error } = await supa().rpc("claim_phone_event", { p_event_id: eventId, p_worker: workerId });
  if (error) throw runtimeError("phone_claim_failed", 503, error.message);
  return data ? data as PhoneClaim : null;
}

async function completeTermination(args: {
  eventId: string;
  claimToken: string;
  confirmed: boolean;
  error?: string;
}) {
  await requiredRpc<boolean>("complete_phone_termination", {
    p_event_id: args.eventId,
    p_claim_token: args.claimToken,
    p_confirmed: args.confirmed,
    p_error: args.error ?? null,
  }, "phone_termination_persistence_failed");
}

async function terminatePhoneLifecycle(args: {
  eventId: string;
  claimToken: string;
  openaiCallId: string | null;
  mode: ProviderTerminationMode;
  reason: string;
  acceptState: PhoneAcceptState;
  fetchImpl: FetchLike;
}): Promise<boolean> {
  const intent = await requiredRpc<{ should_attempt: boolean; request_id?: string; openai_call_id?: string | null }>(
    "begin_phone_termination",
    {
      p_event_id: args.eventId,
      p_claim_token: args.claimToken,
      p_mode: args.mode,
      p_reason: args.reason,
      p_accept_state: args.acceptState,
    },
    "phone_termination_intent_failed",
  );
  if (intent.should_attempt !== true) return false;
  const result = await requestProviderTermination({
    openaiCallId: intent.openai_call_id ?? args.openaiCallId,
    mode: args.mode,
    requestId: String(intent.request_id ?? ""),
    fetchImpl: args.fetchImpl,
  });
  await completeTermination({
    eventId: args.eventId,
    claimToken: args.claimToken,
    confirmed: result.confirmed,
    error: result.error,
  });
  return result.confirmed;
}

export function startPhoneListener() {
  if (!config.openaiKey) return;
  const rt = createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false } });
  rt.channel("phone-events")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "phone_events" }, (payload) => {
      void handleIncoming(payload.new as any).catch((error) => console.error("phone lifecycle failed", error));
    })
    .subscribe();
  setInterval(async () => {
    const { data } = await supa().from("phone_events").select("*")
      .eq("status", "pending").eq("lifecycle_state", "pending")
      .lt("created_at", new Date(Date.now() - 3_000).toISOString()).limit(3);
    for (const row of data ?? []) await handleIncoming(row).catch(() => {});
    await reconcilePhoneLifecycles().catch((error) => console.error("phone lifecycle reconciliation", error));
  }, 5_000);
  console.log("phone listener active (realtime + poll + lifecycle reconciliation)");
}

export async function handleIncoming(row: any, runtime: PhoneRuntime = {}) {
  const workerId = runtime.workerId ?? `phone-${process.pid}`;
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const attachSidebandImpl = runtime.attachSidebandImpl ?? attachSideband;
  const claim = await claimPhoneEvent(String(row.id), workerId);
  if (!claim) return;
  const context = {
    eventId: String(claim.id),
    claimToken: String(claim.claim_token),
    openaiCallId: claim.openai_call_id ? String(claim.openai_call_id) : null,
  };
  const terminate = async (
    mode: ProviderTerminationMode,
    reason: string,
    acceptState: PhoneAcceptState,
  ) => await terminatePhoneLifecycle({ ...context, mode, reason, acceptState, fetchImpl });

  let tenant: any;
  let rules: any[];
  try {
    ({ tenant, rules } = await loadTenant(config.defaultTenantSlug));
  } catch (error) {
    await terminate("reject", "tenant_load_failed_before_accept", "not_attempted");
    throw error;
  }
  if (!tenant.owner_user_id) {
    await terminate("reject", "tenant_provisioning_required", "not_attempted");
    throw runtimeError("tenant_provisioning_required", 409);
  }

  let callId: string;
  try {
    callId = String(await requiredRpc<string>("persist_phone_call", {
      p_event_id: context.eventId,
      p_claim_token: context.claimToken,
      p_tenant_id: tenant.id,
      p_model: config.model,
    }, "phone_call_insert_failed"));
  } catch (error) {
    await terminate("reject", "phone_call_insert_failed", "not_attempted");
    throw error;
  }

  try {
    await requiredRpc<string>("reserve_phone_call_budget", {
      p_event_id: context.eventId,
      p_claim_token: context.claimToken,
      p_est_cost: config.sessionCostCeilingUsd,
    }, "phone_budget_reservation_failed");
  } catch (error) {
    await terminate("reject", "budget_denied_before_accept", "not_attempted");
    throw error;
  }

  let instructions: string;
  try {
    instructions = buildInstructions(tenant, rules, "customer");
    await requiredRpc<boolean>("begin_phone_provider_accept", {
      p_event_id: context.eventId,
      p_claim_token: context.claimToken,
    }, "phone_accept_intent_failed");
  } catch (error) {
    await terminate("reject", "phone_accept_preparation_failed", "not_attempted");
    throw error;
  }

  let accept: Response;
  try {
    accept = await fetchImpl(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(context.openaiCallId ?? "")}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "realtime",
        model: config.model,
        instructions,
        tools: toolSchemas,
        tool_choice: "auto",
        audio: { output: { voice: config.voice } },
      }),
    });
  } catch (error) {
    await terminate("hangup", "phone_accept_transport_unknown", "unknown");
    throw error;
  }
  if (!accept.ok) {
    const definitive = accept.status >= 400 && accept.status < 500;
    await terminate(definitive ? "reject" : "hangup", "phone_accept_failed", definitive ? "failed" : "unknown");
    throw runtimeError("accept_failed", 502, `${accept.status} ${await accept.text()}`);
  }

  try {
    await requiredRpc<boolean>("confirm_phone_provider_accept", {
      p_event_id: context.eventId,
      p_claim_token: context.claimToken,
    }, "phone_accept_persistence_failed");
  } catch (error) {
    await terminate("hangup", "phone_accept_persistence_failed", "accepted");
    throw error;
  }

  let cap;
  try {
    cap = makeCapability(
      tenant.slug,
      tenant.id,
      callId,
      tenant.session_max_minutes ?? config.sessionMaxMinutes,
      "customer",
      { authEpoch: tenant.auth_epoch, policyEpoch: tenant.policy_epoch },
    );
    await requiredRpc<boolean>("begin_phone_sideband", {
      p_event_id: context.eventId,
      p_claim_token: context.claimToken,
    }, "phone_sideband_intent_failed");
  } catch (error) {
    await terminate("hangup", "phone_sideband_ownership_failed", "accepted");
    throw error;
  }

  let sideband: SidebandControl | null = null;
  try {
    sideband = attachSidebandImpl(cap, context.openaiCallId!, config.model, {
      phone: { eventId: context.eventId, claimToken: context.claimToken },
      fetchImpl,
    });
    if (!sideband?.opened || typeof sideband.cancel !== "function") throw new Error("phone_sideband_control_invalid");
    await sideband.opened;
  } catch (error) {
    sideband?.cancel("phone_hangup_before_sideband_active");
    await terminate("hangup", "sideband_attach_failed", "accepted");
    throw error;
  }
}

export async function reconcilePhoneLifecycles(runtime: Pick<PhoneRuntime, "workerId" | "fetchImpl"> = {}): Promise<number> {
  const workerId = runtime.workerId ?? `phone-reconciliation-${process.pid}`;
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const { data, error } = await supa().rpc("claim_phone_lifecycle_reconciliation", { p_worker: workerId });
  if (error || !data) return 0;
  const claim = data as PhoneTerminationClaim;
  if (claim.action === "resolve_not_applicable") {
    await completeTermination({ eventId: claim.event_id, claimToken: claim.claim_token, confirmed: true });
    return 1;
  }
  const result = await requestProviderTermination({
    openaiCallId: claim.openai_call_id,
    mode: claim.provider_termination_mode,
    requestId: String(claim.request_id ?? ""),
    fetchImpl,
  });
  await completeTermination({
    eventId: claim.event_id,
    claimToken: claim.claim_token,
    confirmed: result.confirmed,
    error: result.error,
  });
  return result.confirmed ? 1 : 0;
}
