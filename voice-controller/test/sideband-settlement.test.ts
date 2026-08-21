import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import { _setClient } from "../src/rules.ts";
import { handleEvent, persistLedger, terminalStatusForReason, type SessionLedger } from "../src/sideband.ts";
import { makeCapability } from "../src/tools.ts";

let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let directUsageInserts = 0;
let callUpdates: any[] = [];

function client() {
  return {
    from(table: string) {
      const api: any = {
        update(row: any) { if (table === "calls") callUpdates.push(row); return api; }, eq() { return api; },
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
  callUpdates = [];
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
    providerUsageEvidence: {
      eventCount: 0,
      lastResponseId: null,
      lastReceivedAt: null,
      continuous: true,
      terminal: false,
    },
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

  test("terminal persistence before any provider usage event never settles or invents zero usage", async () => {
    for (const status of ["ended", "killed_deadline", "killed_budget", "error"] as const) {
      rpcCalls = [];
      callUpdates = [];
      await persistLedger(cap, ledger(status), async () => new Response(null, { status: 200 }));
      expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
      expect(callUpdates.some((row) => row.provider_usage_state === "unknown"
        && row.usage_tokens === null && row.cost_estimate_usd === null)).toBe(true);
    }
    expect(directUsageInserts).toBe(0);
  });

  test("turn usage alone remains unresolved until a validated terminal usage receipt arrives", async () => {
    const ended = ledger("active");
    await handleEvent(cap, ended, { send() {}, close() {} } as any, {
      type: "response.done",
      response: {
        id: "resp-usage-1",
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          input_token_details: {
            text_tokens: 4,
            audio_tokens: 8,
            cached_tokens: 3,
            cached_tokens_details: { text_tokens: 1, audio_tokens: 2 },
          },
          output_token_details: { text_tokens: 2, audio_tokens: 3 },
        },
      },
    });
    ended.status = "ended";

    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));

    expect(ended.providerUsageEvidence.eventCount).toBe(1);
    expect(ended.providerUsageEvidence.lastResponseId).toBe("resp-usage-1");
    expect(ended.usage).toEqual({
      textIn: 4, audioIn: 8, textInCached: 1, audioInCached: 2, textOut: 2, audioOut: 3,
    });
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(callUpdates.some((row) => row.provider_usage_state === "unknown")).toBe(true);
  });

  test("continuous sideband plus exact terminal usage resolves settlement", async () => {
    const ended = ledger("active");
    await handleEvent(cap, ended, { send() {}, close() {} } as any, {
      type: "session.ended",
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
        input_token_details: {
          text_tokens: 4,
          audio_tokens: 8,
          cached_tokens: 3,
          cached_tokens_details: { text_tokens: 1, audio_tokens: 2 },
        },
        output_token_details: { text_tokens: 2, audio_tokens: 3 },
      },
    });
    expect(ended.status).toBe("ended");

    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));

    expect(ended.providerUsageEvidence.terminal).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
    expect(callUpdates.some((row) => row.provider_usage_state === "resolved"
      && row.provider_usage_evidence?.terminal === true
      && row.provider_usage_evidence?.continuous === true)).toBe(true);
  });

  test("a sideband continuity gap keeps even terminal usage unknown for reconciliation", async () => {
    const ended = ledger("active");
    ended.providerUsageEvidence.continuous = false;
    await handleEvent(cap, ended, { send() {}, close() {} } as any, {
      type: "session.ended",
      usage: {
        input_tokens: 0, output_tokens: 0, total_tokens: 0,
        input_token_details: { text_tokens: 0, audio_tokens: 0, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } },
        output_token_details: { text_tokens: 0, audio_tokens: 0 },
      },
    });
    expect(ended.status).toBe("ended");
    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(callUpdates.some((row) => row.provider_usage_state === "unknown")).toBe(true);
  });

  test("malformed response.done usage does not become settlement evidence", async () => {
    const ended = ledger("active");
    await handleEvent(cap, ended, { send() {}, close() {} } as any, {
      type: "response.done",
      response: {
        id: "resp-malformed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_token_details: {
            text_tokens: -1,
            audio_tokens: 2,
            cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
          },
          output_token_details: { text_tokens: 1, audio_tokens: 0 },
        },
      },
    });
    ended.status = "ended";

    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));

    expect(ended.providerUsageEvidence.eventCount).toBe(0);
    expect(ended.usage).toEqual(emptyUsage());
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("a repeated persistence attempt relies on SQL idempotency instead of duplicating ledger inserts", async () => {
    const ended = ledger("active");
    await handleEvent(cap, ended, { send() {}, close() {} } as any, {
      type: "session.ended",
      usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_token_details: {
            text_tokens: 0,
            audio_tokens: 0,
            cached_tokens: 0,
            cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
          },
          output_token_details: { text_tokens: 0, audio_tokens: 0 },
      },
    });
    expect(ended.status).toBe("ended");
    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));
    await persistLedger(cap, ended, async () => new Response(null, { status: 200 }));

    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(2);
    expect(directUsageInserts).toBe(0);
  });
});
