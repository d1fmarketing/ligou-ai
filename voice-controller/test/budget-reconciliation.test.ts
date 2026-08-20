import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { reconcileBudgetReservations } from "../src/budget.ts";
import { _setClient } from "../src/rules.ts";

let settleAttempts = 0;
let deferred: any[] = [];

function client() {
  return {
    rpc(name: string) {
      if (name === "claim_budget_reconciliation") {
        return Promise.resolve({ data: {
          reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
          actual_cost_usd: 0, minutes: 0, outcome: "startup_error",
          provider_termination_state: "not_required", provider_termination_mode: null,
          openai_call_id: null,
        }, error: null });
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
        update(row: any) { if (table === "budget_reservations") deferred.push(row); return api; },
        eq() { return api; },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(resolve); },
      };
      return api;
    },
  } as any;
}

beforeEach(() => {
  settleAttempts = 0;
  deferred = [];
  _setClient(client());
});
afterAll(() => _setClient(null));

describe("durable budget reconciliation", () => {
  test("a failed first settlement stays discoverable and the second pass settles", async () => {
    expect(await reconcileBudgetReservations()).toBe(0);
    expect(deferred.some((row) => String(row.reconcile_last_error).includes("temporary database error"))).toBe(true);

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(settleAttempts).toBe(2);
  });
});
