import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { _setClient } from "../src/rules.ts";
import { executeIntent } from "../src/worker.ts";

const LOCKED_INPUT = {
  tenantId: "tenant-1",
  bookingId: "booking-1",
  summary: "drain_cleaning — Customer ($180)",
  description: "Booked by Ligou. Contact: +15555550100. Call call-1.",
  startIso: "2026-08-21T17:00:00.000Z",
  endIso: "2026-08-21T18:00:00.000Z",
  idempotencyKey: "idem-1",
};
const EXPECTED_PROOF = {
  provider: "google_calendar",
  account_id: "account-1",
  calendar_id: "calendar-1",
  summary: LOCKED_INPUT.summary,
  description: LOCKED_INPUT.description,
  start: LOCKED_INPUT.startIso,
  end: LOCKED_INPUT.endIso,
  status: "confirmed",
  private: {
    ligouKey: "idem-1",
    ligouProvider: "google_calendar",
    ligouTenantId: "tenant-1",
    ligouBookingId: "booking-1",
    ligouCalendarId: "calendar-1",
    ligouAccountId: "account-1",
    ligouPayloadHash: "hash-1",
  },
  payload_hash: "hash-1",
};
const READBACK = {
  id: "event-1",
  summary: LOCKED_INPUT.summary,
  description: LOCKED_INPUT.description,
  start: { dateTime: LOCKED_INPUT.startIso },
  end: { dateTime: LOCKED_INPUT.endIso },
  status: "confirmed",
  extendedProperties: { private: EXPECTED_PROOF.private },
};

const intent = (claimToken = "claim-a", mode = "write") => ({
  id: "intent-1", tenant_id: "tenant-1", call_id: "call-1", booking_id: "booking-1",
  kind: "calendar_book", idempotency_key: "idem-1", claim_token: claimToken,
  execution_mode: mode,
  payload: {
    summary: LOCKED_INPUT.summary, description: LOCKED_INPUT.description,
    start_iso: LOCKED_INPUT.startIso, end_iso: LOCKED_INPUT.endIso,
  },
});

let writeCalls = 0;
let reconcileCalls = 0;
let beginGranted = false;
let deliveryError: { message: string } | null = null;
let directConfirmed = false;
let authoritativeConfirmed = false;
let deliveryOutcomes: string[] = [];
let acceptedReceiptCount = 0;
let writtenInputs: any[] = [];
let writeOutcomes: any[] = [];
let reconcileOutcomes: any[] = [];
let leaseHeld = true;
let claimedStatus = "running";
let currentClaimToken = "claim-a";
let busyResult: any = { intervals: [] };
let busyHook: (() => void) | null = null;
let transitionOrder: string[] = [];

function accepted() {
  return {
    outcome: "accepted" as const, externalId: "event-1", readback: READBACK,
    payloadHash: "hash-1", expected: EXPECTED_PROOF, latencyMs: 1,
  };
}

function client() {
  return {
    rpc(name: string, args: any) {
      if (name === "prepare_booking_provider_write") {
        return Promise.resolve({ data: { ready: true, provider_input: LOCKED_INPUT }, error: null });
      }
      if (name === "begin_provider_write") {
        if (beginGranted) return Promise.resolve({ data: null, error: null });
        beginGranted = true;
        return Promise.resolve({ data: { authorized: true, provider_input: LOCKED_INPUT }, error: null });
      }
      if (name === "get_booking_provider_input") {
        return Promise.resolve({ data: LOCKED_INPUT, error: null });
      }
      if (name === "record_booking_delivery") {
        if (deliveryError) return Promise.resolve({ data: null, error: deliveryError });
        deliveryOutcomes.push(args.p_outcome);
        if (args.p_outcome === "accepted") {
          if (!authoritativeConfirmed) acceptedReceiptCount += 1;
          authoritativeConfirmed = true;
          return Promise.resolve({ data: { authoritative: true, receipt_id: "receipt-accepted" }, error: null });
        }
        return Promise.resolve({ data: { authoritative: false, receipt_id: `receipt-${deliveryOutcomes.length}` }, error: null });
      }
      if (name === "release_booking_slot_lease") {
        leaseHeld = false;
        return Promise.resolve({ data: null, error: null });
      }
      if (name === "transition_claimed_intent") {
        if (currentClaimToken === null || args.p_claim_token === null || args.p_claim_token !== currentClaimToken) {
          return Promise.resolve({ data: false, error: null });
        }
        claimedStatus = args.p_transition === "defer" ? "queued" : "failed";
        transitionOrder.push("status");
        leaseHeld = false;
        transitionOrder.push("lease");
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const api: any = {
        insert() { return api; }, select() { return api; }, eq() { return api; }, in() { return api; },
        update(row: any) {
          if (table === "bookings" && row.status === "confirmed") directConfirmed = true;
          if (table === "action_intents" && row.status) claimedStatus = row.status;
          return api;
        },
        single: async () => table === "receipts"
          ? { data: deliveryError ? null : { id: "legacy-direct-receipt" }, error: deliveryError }
          : { data: null, error: null },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
  } as any;
}

const calendar = {
  async write(input: any) {
    writeCalls += 1;
    writtenInputs.push(input);
    return writeOutcomes.shift() ?? accepted();
  },
  async reconcile() {
    reconcileCalls += 1;
    return reconcileOutcomes.shift() ?? accepted();
  },
  async busy() { busyHook?.(); return busyResult; },
};

beforeEach(() => {
  writeCalls = 0;
  reconcileCalls = 0;
  beginGranted = false;
  deliveryError = null;
  directConfirmed = false;
  authoritativeConfirmed = false;
  deliveryOutcomes = [];
  acceptedReceiptCount = 0;
  writtenInputs = [];
  writeOutcomes = [];
  reconcileOutcomes = [];
  leaseHeld = true;
  claimedStatus = "running";
  currentClaimToken = "claim-a";
  busyResult = { intervals: [] };
  busyHook = null;
  transitionOrder = [];
  _setClient(client());
});
afterAll(() => _setClient(null));

describe("booking delivery authority", () => {
  test("receipt storage failure never confirms or commits a booking", async () => {
    deliveryError = { message: "receipt storage unavailable" };
    await executeIntent(intent(), calendar as any);
    expect(authoritativeConfirmed).toBe(false);
    expect(directConfirmed).toBe(false);
  });

  test("unknown delivery attempt can later reconcile to one accepted authority receipt", async () => {
    writeOutcomes.push({ outcome: "unknown", error: "transport_unknown", latencyMs: 1 });
    await executeIntent(intent(), calendar as any);
    await executeIntent(intent("claim-b", "reconcile"), calendar as any);
    expect(deliveryOutcomes).toEqual(["unknown", "accepted"]);
    expect(authoritativeConfirmed).toBe(true);
    expect(acceptedReceiptCount).toBe(1);
  });

  test("conflicting accepted receipt error never confirms through a side path", async () => {
    deliveryError = { message: "accepted_receipt_conflict" };
    await executeIntent(intent(), calendar as any);
    expect(authoritativeConfirmed).toBe(false);
    expect(directConfirmed).toBe(false);
  });

  test("repeated exact acceptance reuses one accepted receipt authority", async () => {
    await executeIntent(intent(), calendar as any);
    await executeIntent(intent("claim-b", "reconcile"), calendar as any);
    expect(authoritativeConfirmed).toBe(true);
    expect(acceptedReceiptCount).toBe(1);
  });

  test("same-intent lease reclaim can invoke provider write at most once", async () => {
    await Promise.all([
      executeIntent(intent("claim-old"), calendar as any),
      executeIntent(intent("claim-new"), calendar as any),
    ]);
    expect(writeCalls).toBe(1);
  });

  test("provider write uses locked booking input instead of corrupt intent payload", async () => {
    const corrupt = intent();
    corrupt.payload.start_iso = "2099-01-01T00:00:00.000Z";
    corrupt.payload.end_iso = "2099-01-01T01:00:00.000Z";
    await executeIntent(corrupt, calendar as any);
    expect(writtenInputs[0]).toEqual(LOCKED_INPUT);
  });

  test("old claim cannot defer or release after a newer claim wins", async () => {
    currentClaimToken = "claim-old";
    busyResult = { intervals: [], unknown: true };
    busyHook = () => { currentClaimToken = "claim-new"; };
    await executeIntent(intent("claim-old"), calendar as any);
    expect(leaseHeld).toBe(true);
    expect(claimedStatus).toBe("running");
  });

  test("current claim can atomically defer and release before write start", async () => {
    currentClaimToken = "claim-current";
    busyResult = { intervals: [], unknown: true };
    await executeIntent(intent("claim-current"), calendar as any);
    expect(leaseHeld).toBe(false);
    expect(claimedStatus).toBe("queued");
    expect(transitionOrder).toEqual(["status", "lease"]);
  });

  test("NULL stored and NULL input claim tokens mutate nothing", async () => {
    currentClaimToken = null as any;
    busyResult = { intervals: [], unknown: true };
    await executeIntent(intent(null as any), calendar as any);
    expect(leaseHeld).toBe(true);
    expect(claimedStatus).toBe("running");
  });

  test("NULL stored token rejects a non-NULL input token", async () => {
    currentClaimToken = null as any;
    busyResult = { intervals: [], unknown: true };
    await executeIntent(intent("claim-input"), calendar as any);
    expect(leaseHeld).toBe(true);
    expect(claimedStatus).toBe("running");
  });
});
