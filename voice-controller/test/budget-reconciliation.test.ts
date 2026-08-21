import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { finalizeTerminalBudget, reconcileBudgetReservations, reconcileProviderTerminations } from "../src/budget.ts";
import { _setClient } from "../src/rules.ts";

let settleAttempts = 0;
let deferred: any[] = [];
let claimRow: any;
let deferError: any;
let terminationClaim: any;
let callUpdates: any[] = [];

function client() {
  return {
    rpc(name: string) {
      if (name === "claim_provider_termination_reconciliation") {
        const row = terminationClaim;
        terminationClaim = null;
        return Promise.resolve({ data: row, error: null });
      }
      if (name === "claim_budget_reconciliation") {
        return Promise.resolve({ data: claimRow, error: null });
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
    expect(callUpdates.some((row) => row.provider_termination_state === "confirmed")).toBe(true);
    expect(settleAttempts).toBe(0);
  });
});
