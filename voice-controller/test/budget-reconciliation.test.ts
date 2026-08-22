import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { finalizeTerminalBudget, reapAbandonedCalls, reconcileBudgetReservations, reconcileProviderTerminations } from "../src/budget.ts";
import { requestProviderTermination, terminateProviderCall } from "../src/provider-termination.ts";
import { _setClient } from "../src/rules.ts";

let settleAttempts = 0;
let deferred: any[] = [];
let claimRow: any;
let deferError: any;
let terminationClaim: any;
let callUpdates: any[] = [];
let providerRpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
let providerAttemptStarted = false;
let unresolvedSettlements: any[] = [];
let reapCalls: any[] = [];
let reapResult: any = 0;

function client() {
  return {
    rpc(name: string, args?: Record<string, unknown>) {
      providerRpcCalls.push({ name, args });
      if (name === "begin_provider_termination_attempt") {
        if (providerAttemptStarted) return Promise.resolve({ data: { should_attempt: false }, error: null });
        providerAttemptStarted = true;
        return Promise.resolve({ data: {
          should_attempt: true,
          attempt_id: "90000000-0000-4000-8000-000000000001",
          request_id: "90000000-0000-4000-8000-000000000001",
          openai_call_id: args?.p_openai_call_id,
          provider_termination_mode: args?.p_mode,
        }, error: null });
      }
      if (name === "complete_provider_termination_attempt") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "claim_provider_termination_reconciliation") {
        const row = terminationClaim;
        terminationClaim = null;
        return Promise.resolve({ data: row, error: null });
      }
      if (name === "claim_budget_reconciliation") {
        return Promise.resolve({ data: claimRow, error: null });
      }
      if (name === "reap_abandoned_calls") {
        reapCalls.push(args ?? {});
        return Promise.resolve({ data: reapResult, error: null });
      }
      if (name === "settle_unresolved_call_budget") {
        unresolvedSettlements.push(args ?? {});
        return Promise.resolve({ data: "reservation-1", error: null });
      }
      if (name === "settle_call_budget") {
        settleAttempts += 1;
        return Promise.resolve(settleAttempts === 1
          ? { data: null, error: { message: "temporary database error" } }
          : { data: "reservation-1", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const api: any = {
        update(row: any) {
          if (table === "budget_reservations") deferred.push(row);
          if (table === "calls") callUpdates.push(row);
          return api;
        },
        eq() { return api; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: table === "budget_reservations" ? deferError : null }).then(resolve);
        },
      };
      return api;
    },
  } as any;
}

beforeEach(() => {
  settleAttempts = 0;
  deferred = [];
  deferError = null;
  terminationClaim = null;
  callUpdates = [];
  providerRpcCalls = [];
  providerAttemptStarted = false;
  unresolvedSettlements = [];
  reapCalls = [];
  reapResult = 0;
  claimRow = {
    reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
    actual_cost_usd: 0, minutes: 0, outcome: "startup_error",
    provider_termination_state: "not_required", provider_termination_mode: null,
    provider_usage_state: "not_applicable", openai_call_id: null,
  };
  _setClient(client());
});
afterAll(() => _setClient(null));

describe("durable budget reconciliation", () => {
  test("provider termination carries a durable request id and times out below its lease", async () => {
    let posts = 0;
    let requestId: string | null = null;
    let signal: AbortSignal | null = null;
    const pending = requestProviderTermination({
      openaiCallId: "rtc-timeout",
      mode: "hangup",
      requestId: "90000000-0000-4000-8000-000000000099",
      timeoutMs: 10,
      fetchImpl: async (_input, init) => {
        posts += 1;
        requestId = new Headers(init?.headers).get("X-Client-Request-Id");
        signal = init?.signal as AbortSignal;
        return await new Promise<Response>(() => {});
      },
    } as any);
    const result = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("outer_timeout"), 80)),
    ]);

    expect(result).not.toBe("outer_timeout");
    expect(result).toMatchObject({ confirmed: false, error: "provider_hangup_timeout" });
    expect(posts).toBe(1);
    expect(requestId).toBe("90000000-0000-4000-8000-000000000099");
    expect(signal?.aborted).toBe(true);
  });

  test("a persisted provider termination attempt permits at most one POST", async () => {
    let posts = 0;
    const fetchImpl = async () => { posts += 1; return new Response(null, { status: 200 }); };

    expect((await terminateProviderCall({
      callId: "call-at-most-once", openaiCallId: "rtc-at-most-once", mode: "hangup",
      reason: "synthetic_first", fetchImpl,
    })).confirmed).toBe(true);
    expect((await terminateProviderCall({
      callId: "call-at-most-once", openaiCallId: "rtc-at-most-once", mode: "hangup",
      reason: "synthetic_retry", fetchImpl,
    })).confirmed).toBe(false);

    expect(posts).toBe(1);
    expect(providerRpcCalls.filter((call) => call.name === "begin_provider_termination_attempt")).toHaveLength(2);
    expect(providerRpcCalls.filter((call) => call.name === "complete_provider_termination_attempt")).toHaveLength(1);
  });

  test("omitting the runtime usage-resolution flag cannot settle", async () => {
    const settled = await finalizeTerminalBudget({
      tenantId: "tenant-1",
      callId: "call-1",
      actualCostUsd: 0,
      minutes: 0,
      outcome: "startup_error",
    } as any);

    expect(settled).toBe(false);
    expect(settleAttempts).toBe(0);
    expect(deferred.some((row) => String(row.reconcile_last_error).includes("provider_usage_unresolved"))).toBe(true);
  });

  test("a failed first settlement stays discoverable and the second pass settles", async () => {
    expect(await reconcileBudgetReservations()).toBe(0);
    expect(deferred.some((row) => String(row.reconcile_last_error).includes("temporary database error"))).toBe(true);

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(settleAttempts).toBe(2);
  });

  test("confirmed termination with unresolved usage remains active", async () => {
    claimRow = {
      ...claimRow,
      provider_termination_state: "confirmed",
      provider_usage_state: "unknown",
      provider_terminated_at: "2026-08-20T20:00:00Z",
      openai_call_id: "rtc-ambiguous",
    };

    expect(await reconcileBudgetReservations()).toBe(0);
    expect(settleAttempts).toBe(0);
    expect(deferred.some((row) => String(row.reconcile_last_error).includes("provider_usage_unresolved"))).toBe(true);
  });

  test("missing, null, or malformed usage state defers instead of settling", async () => {
    for (const providerUsageState of [undefined, null, "resolved ", "bogus", 1, {}]) {
      settleAttempts = 0;
      deferred = [];
      claimRow = {
        reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
        actual_cost_usd: 0, minutes: 0, outcome: "startup_error",
        provider_termination_state: "not_required", provider_termination_mode: null,
        openai_call_id: null,
      };
      if (providerUsageState !== undefined) claimRow.provider_usage_state = providerUsageState;

      expect(await reconcileBudgetReservations()).toBe(0);
      expect(settleAttempts).toBe(0);
      expect(deferred.some((row) => String(row.reconcile_last_error).includes("provider_usage"))).toBe(true);
    }
  });

  test("a failed deferral update is propagated instead of reporting safe deferral", async () => {
    deferError = { message: "permission denied for budget_reservations" };

    await expect(finalizeTerminalBudget({
      tenantId: "tenant-1",
      callId: "call-1",
      actualCostUsd: 0,
      minutes: 0,
      outcome: "startup_error",
      usageResolved: false,
    })).rejects.toMatchObject({
      message: "budget_reconciliation_defer_failed",
      status: 503,
      detail: "permission denied for budget_reservations",
    });
  });

  test("provider termination reconciliation rediscovers a terminal call with no reservation", async () => {
    terminationClaim = {
      call_id: "call-without-reservation",
      openai_call_id: "rtc-no-reservation",
      provider_termination_mode: "reject",
      provider_termination_reason: "budget_denied_before_accept",
    };
    const urls: string[] = [];

    expect(await reconcileProviderTerminations(async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 200 });
    })).toBe(1);

    expect(urls).toEqual(["https://api.openai.com/v1/realtime/calls/rtc-no-reservation/reject"]);
    expect(providerRpcCalls.some((call) => call.name === "complete_provider_termination_attempt"
      && call.args?.p_confirmed === true)).toBe(true);
    expect(settleAttempts).toBe(0);
  });

  test("a terminal call whose provider usage never resolves settles at a bounded rate instead of holding forever", async () => {
    // Media that never connects produces no usage events, so usage stays unknown.
    // Holding the full reservation forever silently consumes the daily budget, so
    // after a bounded number of attempts the reservation settles at the same rate
    // it was reserved at, priced by the duration we do durably know.
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 37 / 60, outcome: "ended",
      provider_termination_state: "confirmed", provider_termination_mode: "hangup",
      provider_usage_state: "unknown", openai_call_id: "rtc-unresolved",
      reconcile_attempts: 24, reserved_cost_usd: 1.5, reserved_minutes: 15,
    };

    expect(await reconcileBudgetReservations()).toBe(1);

    expect(unresolvedSettlements).toHaveLength(1);
    expect(unresolvedSettlements[0].p_call).toBe("call-1");
    expect(unresolvedSettlements[0].p_tenant).toBe("tenant-1");
    expect(unresolvedSettlements[0].p_outcome).toBe("ended");
    // 37s at the reservation rate of 1.5 USD per 15 minutes = 0.10 USD/min.
    expect(unresolvedSettlements[0].p_estimated_cost).toBeCloseTo(0.0617, 4);
    expect(settleAttempts).toBe(0);
    expect(deferred).toHaveLength(0);
  });

  test("unresolved usage keeps deferring while attempts remain under the bound or termination is unconfirmed", async () => {
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 0.5, outcome: "ended",
      provider_termination_state: "confirmed", provider_termination_mode: "hangup",
      provider_usage_state: "unknown", openai_call_id: "rtc-early",
      reconcile_attempts: 3, reserved_cost_usd: 1.5, reserved_minutes: 15,
    };
    expect(await reconcileBudgetReservations()).toBe(0);
    expect(unresolvedSettlements).toHaveLength(0);
    expect(deferred).toHaveLength(1);

    deferred = [];
    claimRow = { ...claimRow, reconcile_attempts: 40, provider_termination_state: "unknown" };
    // Termination still unconfirmed: an ambiguous provider reply must not unlock settlement.
    expect(await reconcileBudgetReservations(async () => new Response(null, { status: 500 }))).toBe(0);
    expect(unresolvedSettlements).toHaveLength(0);
  });

  test("a claim without an explicit reserved length prices at the configured session ceiling", async () => {
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 3, outcome: "ended",
      provider_termination_state: "not_required", provider_termination_mode: null,
      provider_usage_state: "unknown", openai_call_id: null,
      reconcile_attempts: 20, reserved_cost_usd: 1.5,
    };

    expect(await reconcileBudgetReservations()).toBe(1);

    // 3 minutes at 1.5 USD per the configured 15-minute ceiling = 0.30 USD.
    expect(unresolvedSettlements[0].p_estimated_cost).toBeCloseTo(0.3, 4);
  });

  test("the estimate can never exceed the amount actually reserved", async () => {
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 999, outcome: "ended",
      provider_termination_state: "confirmed", provider_termination_mode: "hangup",
      provider_usage_state: "unknown", openai_call_id: "rtc-long",
      reconcile_attempts: 20, reserved_cost_usd: 1.5, reserved_minutes: 15,
    };

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(unresolvedSettlements[0].p_estimated_cost).toBe(1.5);
  });

  test("calls left active by a dead controller are reaped so their budget can reconcile", async () => {
    // A controller restart abandons its in-flight calls: nothing transitions them
    // out of 'active', so the reconciliation claim (which requires a terminal call)
    // never sees them and their reservations are held forever. Production had 115
    // such calls, three of them holding a reservation each.
    reapResult = 3;
    expect(await reapAbandonedCalls()).toBe(3);
    expect(reapCalls).toHaveLength(1);
    // The grace window must be well beyond the longest legitimate session.
    expect(reapCalls[0].p_grace_minutes).toBeGreaterThanOrEqual(60);
  });

  test("an exhausted at-most-once termination stops blocking the bounded settlement", async () => {
    // The single permitted hangup POST was already spent and never confirmed. No
    // further POST is allowed and no read-back exists, so the termination outcome
    // is permanently unknowable — holding the budget forever is the worse answer.
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 2, outcome: "error",
      provider_termination_state: "unknown", provider_termination_mode: "hangup",
      provider_termination_attempted_at: "2026-08-22T05:20:00.000Z",
      provider_termination_attempt_id: "8aa3b407-25b1-45a8-a68c-35ab1b9e7538",
      provider_usage_state: "unknown", openai_call_id: "rtc-exhausted",
      reconcile_attempts: 48, reserved_cost_usd: 1,
    };

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(unresolvedSettlements).toHaveLength(1);
    expect(unresolvedSettlements[0].p_outcome).toBe("error");
    // 2 minutes at 1.00 USD per the configured 15-minute ceiling.
    expect(unresolvedSettlements[0].p_estimated_cost).toBeCloseTo(0.1333, 4);
  });

  test("an ambiguous attempt awaiting external evidence also settles at the bound", async () => {
    // The real production shape: the single POST timed out, so the design parks the
    // call in external_evidence_required. That evidence may never arrive, and the
    // reservation must not be held hostage to it.
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 2, outcome: "error",
      provider_termination_state: "external_evidence_required",
      provider_termination_mode: "hangup",
      provider_termination_attempted_at: "2026-08-22T05:31:44.028Z",
      provider_termination_attempt_id: "8aa3b407-25b1-45a8-a68c-35ab1b9e7538",
      provider_usage_state: "unknown", openai_call_id: "rtc-evidence",
      reconcile_attempts: 48, reserved_cost_usd: 1,
    };

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(unresolvedSettlements).toHaveLength(1);
    expect(unresolvedSettlements[0].p_estimated_cost).toBeCloseTo(0.1333, 4);
  });

  test("an unknown termination that was never attempted still retries instead of settling", async () => {
    claimRow = {
      reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
      actual_cost_usd: 0, minutes: 2, outcome: "error",
      provider_termination_state: "unknown", provider_termination_mode: "hangup",
      provider_termination_attempted_at: null,
      provider_usage_state: "unknown", openai_call_id: "rtc-never-attempted",
      reconcile_attempts: 48, reserved_cost_usd: 1,
    };

    expect(await reconcileBudgetReservations(async () => new Response(null, { status: 500 }))).toBe(0);
    expect(unresolvedSettlements).toHaveLength(0);
  });

  test("the reaper reports zero rather than throwing when the RPC is unavailable", async () => {
    reapResult = null;
    expect(await reapAbandonedCalls()).toBe(0);
  });
});
