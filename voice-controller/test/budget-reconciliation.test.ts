import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { finalizeTerminalBudget, liveReconcileDelayMs, reapAbandonedCalls, reconcileBudgetReservations, reconcileProviderTerminations } from "../src/budget.ts";
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
let providerTerminationReadbackState: string | null = null;
let providerTerminationReadbackOpenaiCallId: string | null = null;
let unresolvedSettlements: any[] = [];
let reapCalls: any[] = [];
let reapResult: any = 0;
let liveExpiryReceipts: any[] = [];
let liveSettlements: any[] = [];
let liveExpiryResult: any = true;
let liveExpiryError: any = null;
let liveSettleError: any = null;
let liveCallReread: any = null;

function client() {
  return {
    rpc(name: string, args?: Record<string, unknown>) {
      providerRpcCalls.push({ name, args });
      if (name === "begin_provider_termination_attempt") {
        if (providerAttemptStarted) return Promise.resolve({ data: { should_attempt: false }, error: null });
        providerAttemptStarted = true;
        providerTerminationReadbackOpenaiCallId = String(
          args?.p_openai_call_id ?? "",
        );
        return Promise.resolve({ data: {
          should_attempt: true,
          attempt_id: "90000000-0000-4000-8000-000000000001",
          request_id: "90000000-0000-4000-8000-000000000001",
          openai_call_id: args?.p_openai_call_id,
          provider_termination_mode: args?.p_mode,
        }, error: null });
      }
      if (name === "complete_provider_termination_attempt") {
        if (args?.p_confirmed === true)
          providerTerminationReadbackState = "confirmed";
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
      if (name === "reconcile_live_session_expiry") {
        liveExpiryReceipts.push(args ?? {});
        return Promise.resolve({ data: liveExpiryError ? null : liveExpiryResult, error: liveExpiryError });
      }
      if (name === "settle_unresolved_live_call_budget") {
        liveSettlements.push(args ?? {});
        return Promise.resolve({ data: liveSettleError ? null : "reservation-1", error: liveSettleError });
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
      let selectedCallId: string | null = null;
      const api: any = {
        update(row: any) {
          if (table === "budget_reservations") deferred.push(row);
          if (table === "calls") callUpdates.push(row);
          return api;
        },
        select() { return api; },
        eq(column: string, value: unknown) {
          if (table === "calls" && column === "id")
            selectedCallId = String(value);
          return api;
        },
        maybeSingle: async () => table === "calls" && liveCallReread
          ? { data: { id: selectedCallId, ...liveCallReread }, error: null }
          : table === "calls"
          ? {
              data: providerTerminationReadbackState
                ? {
                    id: selectedCallId,
                    openai_call_id: providerTerminationReadbackOpenaiCallId,
                    provider_termination_state: providerTerminationReadbackState,
                  }
                : null,
              error: null,
            }
          : { data: null, error: null },
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
  providerTerminationReadbackState = null;
  providerTerminationReadbackOpenaiCallId = null;
  unresolvedSettlements = [];
  reapCalls = [];
  reapResult = 0;
  liveExpiryReceipts = [];
  liveSettlements = [];
  liveExpiryResult = true;
  liveExpiryError = null;
  liveSettleError = null;
  liveCallReread = null;
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

  test("a persisted confirmed provider termination permits at most one POST and reuses exact readback", async () => {
    let posts = 0;
    const fetchImpl = async () => { posts += 1; return new Response(null, { status: 200 }); };

    expect((await terminateProviderCall({
      callId: "call-at-most-once", openaiCallId: "rtc-at-most-once", mode: "hangup",
      reason: "synthetic_first", fetchImpl,
    })).confirmed).toBe(true);
    expect((await terminateProviderCall({
      callId: "call-at-most-once", openaiCallId: "rtc-at-most-once", mode: "hangup",
      reason: "synthetic_retry", fetchImpl,
    })).confirmed).toBe(true);
    expect((await terminateProviderCall({
      callId: "call-at-most-once", openaiCallId: "rtc-different", mode: "hangup",
      reason: "synthetic_wrong_provider", fetchImpl,
    })).confirmed).toBe(false);

    expect(posts).toBe(1);
    expect(providerRpcCalls.filter((call) => call.name === "begin_provider_termination_attempt")).toHaveLength(3);
    expect(providerRpcCalls.filter((call) => call.name === "complete_provider_termination_attempt")).toHaveLength(1);
  });

  test("a nonconfirmed provider termination readback fails closed without a second POST", async () => {
    for (const state of [null, "active", "pending", "unknown", "external_evidence_required"]) {
      providerRpcCalls = [];
      providerAttemptStarted = true;
      providerTerminationReadbackState = state;
      providerTerminationReadbackOpenaiCallId = "rtc-readback-not-confirmed";
      let posts = 0;
      const result = await terminateProviderCall({
        callId: "call-readback-not-confirmed",
        openaiCallId: "rtc-readback-not-confirmed",
        mode: "hangup",
        reason: "synthetic_readback",
        fetchImpl: async () => {
          posts += 1;
          return new Response(null, { status: 200 });
        },
      });

      expect(result.confirmed).toBe(false);
      expect(posts).toBe(0);
      expect(providerRpcCalls.filter((call) =>
        call.name === "complete_provider_termination_attempt"
      )).toHaveLength(0);
    }
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

  test("budget reconciliation preserves the durable provider termination reason", async () => {
    for (const [storedReason, expectedReason] of [
      ["agent_ended_session", "agent_ended_session"],
      ["caller_hung_up", "caller_hung_up"],
      ["abandoned_call_reaped", "abandoned_call_reaped"],
      [null, "durable_budget_reconciliation"],
      ["", "durable_budget_reconciliation"],
      ["   ", "durable_budget_reconciliation"],
    ] as const) {
      providerRpcCalls = [];
      providerAttemptStarted = false;
      settleAttempts = 0;
      deferred = [];
      claimRow = {
        reservation_id: "reservation-1", tenant_id: "tenant-1", call_id: "call-1",
        actual_cost_usd: 0, minutes: 1, outcome: "ended",
        provider_termination_state: "active", provider_termination_mode: "hangup",
        provider_termination_reason: storedReason,
        provider_usage_state: "resolved", openai_call_id: "rtc-reason",
      };

      await reconcileBudgetReservations(async () => new Response(null, { status: 200 }));

      const begin = providerRpcCalls.find((call) => call.name === "begin_provider_termination_attempt");
      expect(begin?.args?.p_reason).toBe(expectedReason);
    }
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

  test("bounded unresolved settlement never drops the durable external cost floor", async () => {
    claimRow = {
      reservation_id: "reservation-floor", tenant_id: "tenant-1",
      call_id: "call-floor", actual_cost_usd: 0.2, minutes: 37 / 60,
      outcome: "ended", provider_termination_state: "confirmed",
      provider_termination_mode: "hangup", provider_usage_state: "unknown",
      openai_call_id: "rtc-floor", reconcile_attempts: 24,
      reserved_cost_usd: 1.5, reserved_minutes: 15,
    };

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(unresolvedSettlements).toHaveLength(1);
    expect(unresolvedSettlements[0].p_estimated_cost).toBe(0.2);
  });

  test("a confirmed hard-budget overrun settles its exact recorded floor as an estimate without raising the reservation", async () => {
    claimRow = {
      reservation_id: "reservation-hard-overrun", tenant_id: "tenant-1",
      call_id: "call-hard-overrun", actual_cost_usd: 8.2209408, minutes: 8,
      outcome: "killed_budget", provider_termination_state: "confirmed",
      provider_termination_mode: "hangup", provider_usage_state: "unknown",
      openai_call_id: "rtc-hard-overrun", reconcile_attempts: 197,
      reserved_cost_usd: 7.5, reserved_minutes: 55,
    };

    expect(await reconcileBudgetReservations()).toBe(1);
    expect(unresolvedSettlements).toHaveLength(1);
    expect(unresolvedSettlements[0]).toMatchObject({p_estimated_cost:8.2209408,p_minutes:8,p_outcome:'killed_budget',
      p_detail:{settlement_basis:'observed_usage_floor',provider_usage_state:'unknown'}});
    expect(claimRow.reserved_cost_usd).toBe(7.5);expect(settleAttempts).toBe(0);expect(deferred).toHaveLength(0);
  });

  test('an over-reservation floor cannot use the estimate exception before a confirmed budget stop',async()=>{
    for(const [outcome,providerState] of [['error','confirmed'],['ended','confirmed'],['killed_budget','external_evidence_required']]){
      unresolvedSettlements=[];deferred=[];
      claimRow={...claimRow,outcome,provider_termination_state:providerState,provider_termination_attempt_id:'already-attempted',
        provider_usage_state:'unknown',actual_cost_usd:8.2209408,reserved_cost_usd:7.5,reserved_minutes:55,minutes:8,reconcile_attempts:197};
      expect(await reconcileBudgetReservations()).toBe(0);expect(unresolvedSettlements).toHaveLength(0);
      expect(deferred).toContainEqual(expect.objectContaining({reconcile_last_error:'unresolved_cost_floor_exceeds_reservation'}));
    }
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

describe("managed Live reconciliation dispatch", () => {
  test("provider termination uses only stored Live recovery and releases the existing lease on confirmation", async () => {
    terminationClaim={call_id:"live-call",model:"gpt-live-1",openai_call_id:"live-provider",provider_termination_reason:"owner_requested_stop"};
    const recovered:any[]=[],urls:string[]=[];
    const result=await reconcileProviderTerminations(async url=>{urls.push(String(url));return new Response(null,{status:200});},{
      recoverLive:async(callId,reason)=>{recovered.push({callId,reason});return true;},
    });
    expect(result).toBe(1);expect(recovered).toEqual([{callId:"live-call",reason:"owner_requested_stop"}]);expect(urls).toEqual([]);
    expect(providerRpcCalls.some(row=>row.name==="begin_provider_termination_attempt")).toBe(false);
    expect(callUpdates).toContainEqual({provider_termination_reconcile_lease_until:null,provider_termination_reconcile_worker:null});
  });
  test("unconfirmed or failed Live recovery remains discoverable without any Realtime request", async () => {
    for(const throws of [false,true]){
      terminationClaim={call_id:"live-call",model:"gpt-live-1",openai_call_id:"live-provider"};let requests=0;
      expect(await reconcileProviderTerminations(async()=>{requests++;return new Response(null,{status:200});},{
        recoverLive:async()=>{if(throws)throw Error("observer disconnected");return false;},
      })).toBe(0);
      expect(requests).toBe(0);expect(callUpdates.at(-1).provider_termination_last_error).toBe("live_termination_unconfirmed");
    }
  });
  test("Live budget recovery never settles from a snapshot taken before provider reconciliation", async () => {
    for(const state of ["active","pending","unknown"]){
      claimRow={...claimRow,model:"gpt-live-1",provider_termination_state:state,provider_usage_state:"unknown",actual_cost_usd:0.3};
      let requests=0,recovered=0;
      const result=await reconcileBudgetReservations(async()=>{requests++;return new Response(null,{status:200});},{
        recoverLive:async()=>{recovered++;claimRow={...claimRow,provider_termination_state:"confirmed",provider_usage_state:"resolved",actual_cost_usd:0.4};return true;},
      });
      expect(result).toBe(0);expect(requests).toBe(0);expect(recovered).toBe(1);expect(settleAttempts).toBe(0);
      expect(unresolvedSettlements).toHaveLength(0);expect(deferred.at(-1).reconcile_last_error).toBe("live_termination_reconciled_refresh_required");
    }
    settleAttempts=1;
    expect(await reconcileBudgetReservations()).toBe(1);
    expect(providerRpcCalls.filter(row=>row.name==='settle_call_budget').at(-1)?.args?.p_actual_cost).toBe(0.4);
  });
  test("Live partial-cost settlement keeps observed breakdown after the existing retry window, never a ceiling-derived rate", async () => {
    claimRow={...claimRow,model:"gpt-live-1",channel:"browser",session_type:"onboarding",provider_termination_state:"confirmed",
      provider_usage_state:"unknown",outcome:"ended",minutes:3,reconcile_attempts:20,reserved_cost_usd:7.5,reserved_minutes:10,
      actual_cost_usd:0.17,provider_usage_details:{voiceSeconds:180,voiceCostUsd:0.15,backendCostUsd:0.02,responses:[{responseId:"response_a"}]}};
    expect(await reconcileBudgetReservations()).toBe(1);
    expect(unresolvedSettlements).toHaveLength(1);
    expect(unresolvedSettlements[0]).toMatchObject({p_estimated_cost:0.17,p_detail:{settlement_basis:"observed_usage_floor",costComplete:false,
      provider_usage_state:"unknown",voiceSeconds:180,voiceCostUsd:0.15,backendCostUsd:0.02,responses:[{responseId:"response_a"}]}});
    expect(settleAttempts).toBe(0);
  });
  test("Live unknown usage cannot become a zero bill or bypass scope and confirmed-provider requirements", async () => {
    const base={...claimRow,model:"gpt-live-1",channel:"browser",session_type:"onboarding",provider_termination_state:"confirmed",
      provider_usage_state:"unknown",outcome:"ended",minutes:3,reconcile_attempts:20,reserved_cost_usd:7.5,reserved_minutes:10,actual_cost_usd:0.17};
    for(const change of [{actual_cost_usd:0},{actual_cost_usd:null},{actual_cost_usd:-1},{actual_cost_usd:NaN},
      {channel:"sip"},{session_type:"customer"},{provider_termination_state:"external_evidence_required"},{reconcile_attempts:19}]){
      claimRow={...base,...change};
      expect(await reconcileBudgetReservations()).toBe(0);expect(unresolvedSettlements).toHaveLength(0);expect(settleAttempts).toBe(0);
    }
  });
});

describe("Live expiry reconciliation converges without inventing finalization", () => {
  const probeNotFound = async () => ({ outcome: "not_found" as const, status: 404, code: "session_id_not_found", type: "invalid_request_error", checkedAt: new Date().toISOString() });
  const liveRow = () => ({ ...claimRow, model: "gpt-live-1", channel: "browser", session_type: "onboarding", provider_termination_state: "unknown",
    provider_usage_state: "unknown", outcome: "ended", minutes: 92 / 60, reconcile_attempts: 1403, reserved_cost_usd: 7.5, reserved_minutes: 55,
    actual_cost_usd: 0.14330983, openai_call_id: "live_u1_fixture", provider_usage_details: { expiresAt: 1_700_000_000, voiceSeconds: 92 } });
  const reread = (extra: Record<string, unknown> = {}) => ({ status: "ended", ended_at: "2026-09-11T16:59:16Z", openai_call_id: "live_u1_fixture",
    provider_termination_state: "unknown", provider_usage_state: "unknown", cost_estimate_usd: 0.14330983, duration_seconds: 92,
    provider_usage_details: { expiresAt: 1_700_000_000, voiceSeconds: 92 }, ...extra });
  test("backoff doubles from five seconds and caps at five minutes", () => {
    expect(liveReconcileDelayMs(1)).toBe(5_000); expect(liveReconcileDelayMs(2)).toBe(10_000); expect(liveReconcileDelayMs(3)).toBe(20_000);
    expect(liveReconcileDelayMs(7)).toBe(300_000); expect(liveReconcileDelayMs(1403)).toBe(300_000);
    expect(liveReconcileDelayMs(undefined)).toBe(5_000); expect(liveReconcileDelayMs(NaN)).toBe(5_000); expect(liveReconcileDelayMs(0)).toBe(5_000);
  });
  test("a gone provider session past its expires_at records expiry evidence and settles the re-read floor through the locked wrapper", async () => {
    claimRow = liveRow(); liveCallReread = reread({ cost_estimate_usd: 0.2 });
    let requests = 0;
    expect(await reconcileBudgetReservations(async () => { requests++; return new Response(null, { status: 200 }); }, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(1);
    expect(requests).toBe(0); expect(settleAttempts).toBe(0); expect(unresolvedSettlements).toHaveLength(0);
    expect(liveExpiryReceipts).toHaveLength(1);
    expect(liveExpiryReceipts[0]).toMatchObject({ p_call: "call-1", p_provider_session_id: "live_u1_fixture", p_http_status: 404, p_error_code: "session_id_not_found", p_error_type: "invalid_request_error", p_evidence_reference: "live_attach_probe:live_u1_fixture" });
    expect(liveSettlements).toHaveLength(1);
    expect(liveSettlements[0]).toMatchObject({ p_tenant: "tenant-1", p_call: "call-1", p_estimated_cost: 0.2, p_minutes: 92 / 60, p_outcome: "ended",
      p_detail: { reconciled: true, reservation_id: "reservation-1", provider_usage_state: "unknown", provider_termination_state: "unknown", costComplete: false, cost_source: "calls.cost_estimate_usd@reread", expiry_policy: "live_expires_at_and_attach_404_v1", expiresAt: 1_700_000_000 } });
    expect(liveSettlements[0].p_detail).not.toHaveProperty("settlement_basis");
    expect(deferred).toHaveLength(0);
  });
  test("a provider-active row after a controller crash follows the same expiry path", async () => {
    claimRow = { ...liveRow(), provider_termination_state: "active" }; liveCallReread = reread({ provider_termination_state: "active" });
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(1);
    expect(liveSettlements[0].p_detail.provider_termination_state).toBe("active");
  });
  test("a cost that changed under the lock defers five seconds and repeats", async () => {
    claimRow = liveRow(); liveCallReread = reread(); liveSettleError = { message: "live_settlement_cost_changed" };
    const before = Date.now();
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(0);
    expect(liveSettlements).toHaveLength(1); expect(deferred.at(-1).reconcile_last_error).toBe("live_settlement_cost_changed");
    expect(Date.parse(deferred.at(-1).reconcile_after) - before).toBeGreaterThanOrEqual(4_500); expect(Date.parse(deferred.at(-1).reconcile_after) - before).toBeLessThan(10_000);
  });
  test("a re-read that already confirmed or left the terminal state defers without probing or settling", async () => {
    let probes = 0;
    for (const change of [{ provider_termination_state: "confirmed" }, { provider_termination_state: "not_required" }, { status: "active" }]) {
      claimRow = liveRow(); liveCallReread = reread(change);
      expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: async () => { probes++; return probeNotFound(); } })).toBe(0);
      expect(deferred.at(-1).reconcile_last_error).toBe("live_state_changed_refresh_required");
    }
    expect(probes).toBe(0); expect(liveExpiryReceipts).toHaveLength(0); expect(liveSettlements).toHaveLength(0);
  });
  test("probes that do not prove absence never record evidence and back off to the cap", async () => {
    for (const probe of [{ outcome: "exists", status: 101, code: null, type: null }, { outcome: "unknown", status: 500, code: "server_error", type: "server_error" }, { outcome: "unknown", status: 404, code: "other", type: "invalid_request_error" }]) {
      claimRow = liveRow(); liveCallReread = reread(); const before = Date.now();
      expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: async () => ({ ...probe, checkedAt: new Date().toISOString() }) as any })).toBe(0);
      expect(deferred.at(-1).reconcile_last_error).toBe(`live_probe_${probe.outcome}`);
      expect(Date.parse(deferred.at(-1).reconcile_after) - before).toBeGreaterThanOrEqual(295_000);
    }
    expect(liveExpiryReceipts).toHaveLength(0); expect(liveSettlements).toHaveLength(0);
  });
  test("expiry waits for the persisted expires_at and refuses to guess when it is missing", async () => {
    let probes = 0; const probe = async () => { probes++; return probeNotFound(); };
    claimRow = liveRow(); liveCallReread = reread({ provider_usage_details: { expiresAt: Math.floor(Date.now() / 1000) + 600, voiceSeconds: 92 } });
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probe })).toBe(0);
    expect(deferred.at(-1).reconcile_last_error).toBe("live_expiry_not_elapsed");
    claimRow = liveRow(); liveCallReread = reread({ provider_usage_details: { voiceSeconds: 92 } });
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probe })).toBe(0);
    expect(deferred.at(-1).reconcile_last_error).toBe("live_expiry_evidence_missing");
    expect(probes).toBe(0); expect(liveExpiryReceipts).toHaveLength(0);
  });
  test("the first failures back off from five seconds", async () => {
    claimRow = { ...liveRow(), reconcile_attempts: 1 }; liveCallReread = reread(); const before = Date.now();
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: async () => ({ outcome: "unknown", status: null, code: null, type: null, checkedAt: new Date().toISOString() }) })).toBe(0);
    expect(Date.parse(deferred.at(-1).reconcile_after) - before).toBeGreaterThanOrEqual(4_500); expect(Date.parse(deferred.at(-1).reconcile_after) - before).toBeLessThan(10_000);
  });
  test("a recorded receipt below the documented attempt floor does not settle yet", async () => {
    claimRow = { ...liveRow(), reconcile_attempts: 3 }; liveCallReread = reread();
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(0);
    expect(liveExpiryReceipts).toHaveLength(1); expect(liveSettlements).toHaveLength(0); expect(deferred.at(-1).reconcile_last_error).toBe("live_expiry_settlement_awaiting_attempts");
  });
  test("a rejected expiry receipt is deferred with its reason and nothing settles", async () => {
    claimRow = liveRow(); liveCallReread = reread(); liveExpiryError = { message: "live_expiry_not_elapsed" };
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(0);
    expect(liveSettlements).toHaveLength(0); expect(deferred.at(-1).reconcile_last_error).toBe("live_expiry_not_elapsed");
  });
  test("an overrun with unconfirmed termination and out-of-scope rows never settle from expiry", async () => {
    claimRow = { ...liveRow(), outcome: "killed_budget" }; liveCallReread = reread({ cost_estimate_usd: 9 });
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(0);
    expect(deferred.at(-1).reconcile_last_error).toBe("live_overrun_requires_confirmed_termination"); expect(liveSettlements).toHaveLength(0);
    for (const change of [{ channel: "sip" }, { session_type: "customer" }]) {
      claimRow = { ...liveRow(), ...change }; liveCallReread = reread();
      expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(0);
      expect(liveSettlements).toHaveLength(0);
    }
    claimRow = liveRow(); liveCallReread = reread({ cost_estimate_usd: 0 });
    expect(await reconcileBudgetReservations(undefined, { recoverLive: async () => false, probeLive: probeNotFound })).toBe(0);
    expect(liveSettlements).toHaveLength(0);
  });
});
