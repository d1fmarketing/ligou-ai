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

export async function reconcileBudgetReservations(fetchImpl?: FetchLike): Promise<number> {
  const { data: claim, error } = await supa().rpc("claim_budget_reconciliation", {
    p_worker: `budget-${process.pid}`,
  });
  if (error || !claim) return 0;

  const row = claim as any;
  const providerState = String(row.provider_termination_state ?? "not_required");
  const providerUsageState = row.provider_usage_state;
  const needsTermination = ["active", "pending", "unknown"].includes(providerState);
  const provider = needsTermination
    ? {
        openaiCallId: row.openai_call_id ? String(row.openai_call_id) : null,
        mode: (row.provider_termination_mode === "reject" ? "reject" : "hangup") as ProviderTerminationMode,
        reason: "durable_budget_reconciliation",
      }
    : undefined;

  return await finalizeTerminalBudget({
    tenantId: String(row.tenant_id),
    callId: String(row.call_id),
    actualCostUsd: Number(row.actual_cost_usd ?? 0),
    minutes: Number(row.minutes ?? 0),
    outcome: String(row.outcome) as BudgetOutcome,
    detail: { reconciled: true, reservation_id: row.reservation_id },
    provider,
    fetchImpl,
    usageResolved: providerUsageState === "resolved" || providerUsageState === "not_applicable",
  }) ? 1 : 0;
}
