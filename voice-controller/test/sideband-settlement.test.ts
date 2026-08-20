import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import { _setClient } from "../src/rules.ts";
import { handleEvent, persistLedger, terminalStatusForReason, type SessionLedger } from "../src/sideband.ts";
import { makeCapability } from "../src/tools.ts";

let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let directUsageInserts = 0;

function client() {
  return {
    from(table: string) {
      const api: any = {
        update() { return api; }, eq() { return api; },
        insert() { if (table === "usage_ledger") directUsageInserts += 1; return api; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: "reservation-1", error: null });
    },
  } as any;
}

beforeEach(() => {
  rpcCalls = [];
  directUsageInserts = 0;
  _setClient(client());
});
afterAll(() => _setClient(null));

const cap = makeCapability("rocha-plumbing", "tenant-1", "call-1", 15, "customer", {
  authEpoch: 1, policyEpoch: 1,
});

function ledger(status: SessionLedger["status"]): SessionLedger {
  return {
    callId: "call-1",
    openaiCallId: "rtc-1",
    model: "gpt-realtime-2.1-mini",
    startedAt: Date.now(),
    usage: emptyUsage(),
    transcript: [],
    toolLog: [],
    status,
  };
}

describe("sideband budget finalization", () => {
  test("reattach exhaustion and terminal OpenAI errors transition to error", async () => {
    expect(terminalStatusForReason("active", "reattach_exhausted")).toBe("error");
    const active = ledger("active");
    await handleEvent(cap, active, { send() {}, close() {} } as any, { type: "error", error: { message: "terminal" } });
    expect(active.status).toBe("error");
  });

  test("normal end, deadline, cost kill, and error settle through the idempotent RPC", async () => {
    const expected = [
      ["ended", "ended"],
      ["killed_deadline", "killed_deadline"],
      ["killed_budget", "killed_budget"],
      ["error", "error"],
    ] as const;

    for (const [status, outcome] of expected) {
      rpcCalls = [];
      await persistLedger(cap, ledger(status), async () => new Response(null, { status: 200 }));
      const settlements = rpcCalls.filter((call) => call.name === "settle_call_budget");
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.args.p_outcome).toBe(outcome);
    }
    expect(directUsageInserts).toBe(0);
  });

  test("a repeated persistence attempt relies on SQL idempotency instead of duplicating ledger inserts", async () => {
    const ended = ledger("ended");
    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));
    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));

    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(2);
    expect(directUsageInserts).toBe(0);
  });
});
