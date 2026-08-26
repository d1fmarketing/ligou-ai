import { config } from "./config.ts";
import { supa } from "./rules.ts";
import { terminateProviderCall, type FetchLike, type ProviderTerminationMode } from "./provider-termination.ts";

export type BudgetOutcome = "ended" | "startup_error" | "killed_deadline" | "killed_budget" | "error";

export async function reserveCallBudget(tenantId: string, callId: string, estimatedCostUsd: number): Promise<string> {
  const { data, error } = await supa().rpc("reserve_call_budget", {
    p_tenant: tenantId,
    p_call: callId,
    p_est_cost: estimatedCostUsd,
  });
  if (error || !data) {
    throw Object.assign(new Error("budget_exceeded"), { status: 402, detail: error?.message ?? "reservation_failed" });
  }
  return String(data);
}

export async function settleCallBudget(args: {
  tenantId: string;
  callId: string;
  actualCostUsd: number;
  minutes: number;
  outcome: BudgetOutcome;
  detail?: Record<string, unknown>;
}): Promise<string> {
  const { data, error } = await supa().rpc("settle_call_budget", {
    p_tenant: args.tenantId,
    p_call: args.callId,
    p_actual_cost: args.actualCostUsd,
    p_minutes: args.minutes,
    p_outcome: args.outcome,
    p_detail: args.detail ?? {},
  });
  if (error || !data) {
    throw Object.assign(new Error("budget_settlement_failed"), { status: 503, detail: error?.message ?? "settlement_failed" });
  }
  return String(data);
}

async function deferBudgetReconciliation(callId: string, error: unknown) {
  const detail = (error as any)?.detail ?? (error as any)?.message ?? String(error);
  const { error: deferError } = await supa().from("budget_reservations").update({
    reconcile_last_error: String(detail).slice(0, 400),
    reconcile_after: new Date(Date.now() + 5_000).toISOString(),
    reconcile_lease_until: null,
  }).eq("call_id", callId).eq("status", "active");
  if (deferError) {
    throw Object.assign(new Error("budget_reconciliation_defer_failed"), {
      status: 503,
      detail: deferError.message ?? "budget_reconciliation_update_failed",
    });
  }
}

export async function deferProviderTerminationReconciliation(callId: string, error: unknown) {
  const detail = (error as any)?.error ?? (error as any)?.detail ?? (error as any)?.message ?? String(error);
  const { error: deferError } = await supa().from("calls").update({
    provider_termination_reconcile_after: new Date(Date.now() + 5_000).toISOString(),
    provider_termination_reconcile_lease_until: null,
    provider_termination_last_error: String(detail).slice(0, 400),
  }).eq("id", callId);
  if (deferError) {
    throw Object.assign(new Error("provider_termination_reconciliation_defer_failed"), {
      status: 503,
      detail: deferError.message ?? "provider_termination_reconciliation_update_failed",
    });
  }
}

export async function finalizeTerminalBudget(args: {
  tenantId: string;
  callId: string;
  actualCostUsd: number;
  minutes: number;
  outcome: BudgetOutcome;
  detail?: Record<string, unknown>;
  provider?: { openaiCallId: string | null; mode: ProviderTerminationMode; reason: string };
  fetchImpl?: FetchLike;
  usageResolved: boolean;
}): Promise<boolean> {
  if (args.provider) {
    const termination = await terminateProviderCall({
      callId: args.callId,
      openaiCallId: args.provider.openaiCallId,
      mode: args.provider.mode,
      reason: args.provider.reason,
      fetchImpl: args.fetchImpl,
    });
    if (!termination.confirmed) {
      await deferBudgetReconciliation(args.callId, termination.error ?? "provider_termination_unknown");
      return false;
    }
  }
  if (args.usageResolved !== true) {
    await deferBudgetReconciliation(args.callId, "provider_usage_unresolved");
    return false;
  }
  try {
    await settleCallBudget(args);
    return true;
  } catch (error) {
    await deferBudgetReconciliation(args.callId, error);
    return false;
  }
}

const UNRESOLVED_SETTLEMENT_MIN_ATTEMPTS = 20;
const ABANDONED_CALL_GRACE_MINUTES = 120;

// A controller restart leaves its in-flight calls in 'active' forever: nothing
// transitions them, so budget reconciliation (which only claims terminal calls)
// never reaches their reservations and the dashboard shows them as in progress.
// The RPC only touches calls older than a grace window far beyond any legitimate
// session, and marks the provider side for the existing at-most-once hangup path.
export async function reapAbandonedCalls(): Promise<number> {
  const { data, error } = await supa().rpc("reap_abandoned_calls", {
    p_grace_minutes: ABANDONED_CALL_GRACE_MINUTES,
  });
  if (error || data === null || data === undefined) return 0;
  return Number(data) || 0;
}

export async function reconcileBudgetReservations(fetchImpl?: FetchLike): Promise<number> {
  const { data: claim, error } = await supa().rpc("claim_budget_reconciliation", {
    p_worker: `budget-${process.pid}`,
  });
  if (error || !claim) return 0;

  const row = claim as any;
  const providerState = String(row.provider_termination_state ?? "not_required");
  const providerUsageState = row.provider_usage_state;
  const needsTermination = ["active", "pending", "unknown"].includes(providerState);
  const storedTerminationReason = typeof row.provider_termination_reason === "string"
    && row.provider_termination_reason.length > 0
    ? row.provider_termination_reason
    : "durable_budget_reconciliation";
  const provider = needsTermination
    ? {
        openaiCallId: row.openai_call_id ? String(row.openai_call_id) : null,
        mode: (row.provider_termination_mode === "reject" ? "reject" : "hangup") as ProviderTerminationMode,
        reason: storedTerminationReason,
      }
    : undefined;

  const usageResolved = providerUsageState === "resolved" || providerUsageState === "not_applicable";
  // At-most-once already spent the single permitted termination POST and the
  // outcome never confirmed. No further POST is allowed and no read-back exists,
  // so the outcome is permanently unknowable rather than merely pending.
  // Exhaustion is "an attempt was durably recorded", not any single state: the one
  // POST may end in unknown, pending, or external_evidence_required, and at-most-once
  // forbids another either way.
  const terminationExhausted = row.provider_termination_attempt_id != null
    && providerState !== "confirmed" && providerState !== "not_required";
  if (!usageResolved && (!needsTermination || terminationExhausted)
    && Number(row.reconcile_attempts ?? 0) >= UNRESOLVED_SETTLEMENT_MIN_ATTEMPTS) {
    // A call whose media never carried usage events leaves provider usage unknown
    // forever. Holding the full reservation would silently consume the tenant's
    // daily budget, so once the call is durably terminal at the provider we settle
    // at the same rate the reservation was priced at, using the duration we do know.
    const reservedCost = Number(row.reserved_cost_usd ?? 0);
    // The reservation is a flat session ceiling; its implied rate is that ceiling
    // divided by the session length it was sized for.
    const reservedMinutes = Number(row.reserved_minutes ?? config.sessionMaxMinutes ?? 0);
    const rate = reservedMinutes > 0 ? reservedCost / reservedMinutes : 0;
    const estimated = Math.min(reservedCost, Number((Number(row.minutes ?? 0) * rate).toFixed(4)));
    const { error: settleError } = await supa().rpc("settle_unresolved_call_budget", {
      p_tenant: String(row.tenant_id),
      p_call: String(row.call_id),
      p_estimated_cost: estimated,
      p_minutes: Number(row.minutes ?? 0),
      p_outcome: String(row.outcome),
      p_detail: {
        reconciled: true,
        reservation_id: row.reservation_id,
        settlement_basis: "reservation_rate_estimate",
        provider_usage_state: providerUsageState ?? "unknown",
        provider_termination_state: providerState,
      },
    });
    if (settleError) {
      await deferBudgetReconciliation(String(row.call_id), settleError.message ?? "unresolved_settlement_failed");
      return 0;
    }
    return 1;
  }

  return await finalizeTerminalBudget({
    tenantId: String(row.tenant_id),
    callId: String(row.call_id),
    actualCostUsd: Number(row.actual_cost_usd ?? 0),
    minutes: Number(row.minutes ?? 0),
    outcome: String(row.outcome) as BudgetOutcome,
    detail: { reconciled: true, reservation_id: row.reservation_id },
    provider,
    fetchImpl,
    usageResolved,
  }) ? 1 : 0;
}

export async function reconcileProviderTerminations(fetchImpl?: FetchLike): Promise<number> {
  const { data: claim, error } = await supa().rpc("claim_provider_termination_reconciliation", {
    p_worker: `provider-termination-${process.pid}`,
  });
  if (error || !claim) return 0;
  const row = claim as any;
  const termination = await terminateProviderCall({
    callId: String(row.call_id),
    openaiCallId: row.openai_call_id ? String(row.openai_call_id) : null,
    mode: row.provider_termination_mode === "reject" ? "reject" : "hangup",
    reason: String(row.provider_termination_reason ?? "durable_provider_termination_reconciliation"),
    fetchImpl,
  });
  if (!termination.confirmed) {
    await deferProviderTerminationReconciliation(String(row.call_id), termination.error ?? "provider_termination_unknown");
    return 0;
  }
  await supa().from("calls").update({
    provider_termination_reconcile_lease_until: null,
    provider_termination_reconcile_worker: null,
  }).eq("id", String(row.call_id));
  return 1;
}
