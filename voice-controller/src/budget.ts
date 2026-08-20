import { supa } from "./rules.ts";

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
