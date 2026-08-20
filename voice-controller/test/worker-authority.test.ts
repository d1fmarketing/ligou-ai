import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { _setClient } from "../src/rules.ts";
import { executeIntent } from "../src/worker.ts";

let validation: { data: boolean | null; error: { message: string } | null } = { data: false, error: null };
let providerCalls = 0;
let reconciliationCalls = 0;
let intentUpdates: any[] = [];
let busyIntervals: Array<{ start: string; end: string }> = [];
let prepareCalls = 0;
let beginCalls = 0;

const providerInput = {
  tenantId: "tenant-1", bookingId: "booking-1", summary: "Drain cleaning", description: "Test",
  startIso: "2026-08-21T17:00:00Z", endIso: "2026-08-21T18:00:00Z", idempotencyKey: "idem-1",
};

function client() {
  return {
    rpc(name: string) {
      if (name === "validate_booking_intent_authority") return Promise.resolve(validation);
      if (name === "prepare_booking_provider_write") {
        if (validation.error) return Promise.resolve({ data: null, error: validation.error });
        if (!validation.data) return Promise.resolve({ data: false, error: null });
        prepareCalls += 1;
        return Promise.resolve({ data: prepareCalls === 1 ? { ready: true, provider_input: providerInput } : null, error: null });
      }
      if (name === "begin_provider_write") {
        beginCalls += 1;
        return Promise.resolve({ data: beginCalls === 1 ? { authorized: true, provider_input: providerInput } : null, error: null });
      }
      if (name === "get_booking_provider_input") return Promise.resolve({ data: providerInput, error: null });
      if (name === "record_booking_delivery") return Promise.resolve({ data: { authoritative: true, receipt_id: "receipt-1" }, error: null });
      if (name === "transition_claimed_intent") {
        intentUpdates.push({ status: "failed", last_error: "slot_became_busy" });
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const api: any = {
        update(row: any) { if (table === "action_intents") intentUpdates.push(row); return api; },
        insert() { return api; }, select() { return api; }, eq() { return api; }, in() { return api; },
        single: async () => ({ data: { id: "receipt-1" }, error: null }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
  } as any;
}

const intent = {
  id: "intent-1", tenant_id: "tenant-1", call_id: "call-1", booking_id: "booking-1",
  kind: "calendar_book", idempotency_key: "idem-1",
  claim_token: "claim-1",
  payload: { summary: "Drain cleaning", description: "Test", start_iso: "2026-08-21T17:00:00Z", end_iso: "2026-08-21T18:00:00Z" },
};

const calendar = {
  async book() {
    providerCalls += 1;
    return { outcome: "accepted" as const, externalId: "event-1", readback: { id: "event-1" }, payloadHash: "hash", latencyMs: 1 };
  },
  async write() {
    providerCalls += 1;
    return { outcome: "accepted" as const, externalId: "event-1", readback: { id: "event-1" }, payloadHash: "hash", latencyMs: 1 };
  },
  async reconcile() {
    reconciliationCalls += 1;
    return { outcome: "unknown" as const, error: "lookup_503", latencyMs: 1 };
  },
  async busy() { return { intervals: busyIntervals }; },
};

beforeEach(() => {
  validation = { data: false, error: null };
  providerCalls = 0;
  reconciliationCalls = 0;
  intentUpdates = [];
  busyIntervals = [];
  prepareCalls = 0;
  beginCalls = 0;
  _setClient(client());
});
afterAll(() => _setClient(null));

describe("worker authority at the provider boundary", () => {
  test("revocation after queue causes zero provider calls", async () => {
    await executeIntent(intent, calendar);
    expect(providerCalls).toBe(0);
  });

  test("authority lookup error fails closed with zero provider calls", async () => {
    validation = { data: null, error: { message: "authority unavailable" } };
    await executeIntent(intent, calendar);
    expect(providerCalls).toBe(0);
  });

  test("current referenced grant and rule allow one provider call", async () => {
    validation = { data: true, error: null };
    await executeIntent(intent, calendar);
    expect(providerCalls).toBe(1);
  });

  test("a slot that became busy after it was offered causes zero provider writes", async () => {
    validation = { data: true, error: null };
    busyIntervals = [{ start: intent.payload.start_iso, end: intent.payload.end_iso }];
    await executeIntent(intent, calendar as any);
    expect(providerCalls).toBe(0);
    expect(intentUpdates.some((row) => row.last_error === "slot_became_busy")).toBe(true);
  });

  test("two concurrent workers competing for one slot produce at most one provider write", async () => {
    validation = { data: true, error: null };
    await Promise.all([executeIntent({ ...intent }, calendar as any), executeIntent({ ...intent, id: "intent-2" }, calendar as any)]);
    expect(providerCalls).toBe(1);
  });

  test("an unknown action intent performs reconciliation only", async () => {
    validation = { data: true, error: null };
    await executeIntent({ ...intent, execution_mode: "reconcile" }, calendar as any);
    expect(reconciliationCalls).toBe(1);
    expect(providerCalls).toBe(0);
  });
});
