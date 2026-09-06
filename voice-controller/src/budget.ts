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

async function boundedWebsiteProof<T>(operation: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("website_terminal_proof_timeout")), 8_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

/** Read actual terminal storage; response.done or a successful hangup request is
 * not a budget receipt. Used by the live runtime and existing reconciliation. */
export async function readWebsiteTerminalProof(callId: string): Promise<{ providerReceiptId: string; budgetReceiptId: string } | null> {
  try {
    const s = supa();
    const [callResult, budgetResult] = await boundedWebsiteProof(() => Promise.all([
      s.from("calls").select("id,tenant_id,status,ended_at,provider_termination_state,provider_termination_attempt_id").eq("id", callId).maybeSingle(),
      s.from("budget_reservations").select("id,call_id,tenant_id,status").eq("call_id", callId).maybeSingle(),
    ]));
    const call = callResult.data, budget = budgetResult.data;
    if (callResult.error || budgetResult.error || call?.id !== callId || !call.ended_at ||
      !["ended", "error", "killed_budget", "killed_deadline"].includes(call.status) ||
      call.provider_termination_state !== "confirmed" || budget?.call_id !== callId ||
      budget.tenant_id !== call.tenant_id || budget.status !== "settled" || !budget.id) return null;
    return { providerReceiptId: String(call.provider_termination_attempt_id ?? call.id), budgetReceiptId: String(budget.id) };
  } catch { return null; }
}

async function reconcileWebsiteInterviewTerminals(): Promise<void> {
  try {
    // SQL selects only current, provider-confirmed, budget-settled calls with no
    // terminal receipt. Recording unfinished also removes stale calls from this
    // scan without changing their canonical agenda, so later calls cannot starve.
    const result = await boundedWebsiteProof(() => supa().rpc("list_website_interview_terminal_candidates", { p_limit: 4 }));
    if (result.error || !Array.isArray(result.data) || result.data.length > 4) return;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const row of result.data) {
      if (!row || typeof row !== "object" || Array.isArray(row) ||
        ![row.ownerId, row.requestId, row.interviewId, row.callId, row.tenantId].every(id => typeof id === "string" && uuid.test(id)) ||
        !["unfinished", "reviewing", "closing"].includes(row.state) ||
        !["ended", "error", "killed_budget", "killed_deadline"].includes(row.callStatus) ||
        typeof row.canComplete !== "boolean" ||
        !(row.approvalReceiptId === null || (typeof row.approvalReceiptId === "string" && uuid.test(row.approvalReceiptId)))) continue;
      const outcome = row.canComplete && row.state === "closing" && row.callStatus === "ended" &&
        row.providerTerminationReason === "agent_ended_session" && row.approvalReceiptId !== null
        ? "complete" : "unfinished";
      try {
        // canComplete is SQL-derived, including exact played signoff. The
        // mutation independently rechecks every proof and binding under lock.
        await boundedWebsiteProof(() => supa().rpc("record_website_interview_completion", {
          p_owner: row.ownerId, p_call: row.callId, p_request: row.requestId,
          p_outcome: outcome, p_approval: row.approvalReceiptId,
        }));
      } catch { /* No mutation retry here; the next readonly scan reconciles. */ }
    }
  } catch { /* Existing reconciliation retries later; no separate worker. */ }
}

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
  if (error || !claim) { await reconcileWebsiteInterviewTerminals(); return 0; }

  const row = claim as any;
  const providerState = String(row.provider_termination_state ?? "not_required");
  const providerUsageState = row.provider_usage_state;
  const needsTermination = ["active", "pending", "unknown"].includes(providerState);
  const storedTerminationReason = typeof row.provider_termination_reason === "string"
    && row.provider_termination_reason.trim().length > 0
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
    const durationEstimate = Number((
      Number(row.minutes ?? 0) * rate
    ).toFixed(4));
    const durableFloorCandidate = Number(row.actual_cost_usd ?? 0);
    const durableFloor = Number.isFinite(durableFloorCandidate) &&
        durableFloorCandidate >= 0
      ? durableFloorCandidate
      : 0;
    if (durableFloor > reservedCost) {
      await deferBudgetReconciliation(
        String(row.call_id),
        "unresolved_cost_floor_exceeds_reservation",
      );
      return 0;
    }
    const estimated = Math.min(
      reservedCost,
      Math.max(durableFloor, durationEstimate),
    );
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
    await reconcileWebsiteInterviewTerminals();
    return 1;
  }

  const settled = await finalizeTerminalBudget({
    tenantId: String(row.tenant_id),
    callId: String(row.call_id),
    actualCostUsd: Number(row.actual_cost_usd ?? 0),
    minutes: Number(row.minutes ?? 0),
    outcome: String(row.outcome) as BudgetOutcome,
    detail: { reconciled: true, reservation_id: row.reservation_id },
    provider,
    fetchImpl,
    usageResolved,
  });
  if (settled) await reconcileWebsiteInterviewTerminals();
  return settled ? 1 : 0;
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
  await reconcileWebsiteInterviewTerminals();
  return 1;
}
