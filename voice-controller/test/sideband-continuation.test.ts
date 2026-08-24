// Reproduces the 2026-08-24 onboarding stall (call ec929149): the model answered one
// interview topic with speech plus three record_interview_answer calls in a single
// response. The sideband issued `response.create` per completed function_call while the
// parent response was still streaming, OpenAI rejected the continuation
// ("Conversation already has an active response in progress"), and the generic error
// handler killed the session. The interview must be self-driving: exactly one
// continuation, issued only once no response is active, and that provider error must
// never be terminal.
import { describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import { handleEvent, type SessionLedger } from "../src/sideband.ts";
import { makeCapability } from "../src/tools.ts";

const cap = makeCapability("rocha-plumbing", "tenant-1", "call-1", 15, "onboarding", {
  authEpoch: 1, policyEpoch: 1,
});

function ledger(): SessionLedger {
  return {
    callId: "call-1",
    openaiCallId: "rtc-1",
    model: "gpt-realtime-2.1",
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
    status: "active",
  };
}

function socket() {
  return {
    sent: [] as string[],
    closed: 0,
    send(payload: string) { this.sent.push(payload); },
    close() { this.closed += 1; },
  };
}

function sentTypes(ws: { sent: string[] }): string[] {
  return ws.sent.map((raw) => JSON.parse(raw).type);
}

// The tool name is deliberately not in the capability's allowlist: runTool fails closed
// without any database access, and the continuation contract must not depend on the
// tool's own outcome.
function functionCallDone(callId: string) {
  return {
    type: "response.output_item.done",
    item: { type: "function_call", name: "not_a_real_tool", call_id: callId, arguments: "{}" },
  };
}

describe("sideband response continuation", () => {
  test("multiple tool calls inside one active response yield exactly one response.create, after response.done", async () => {
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, functionCallDone("fc_1"));
    await handleEvent(cap, l, ws as any, functionCallDone("fc_2"));
    await handleEvent(cap, l, ws as any, functionCallDone("fc_3"));

    // All three tool outputs go back, but no continuation may fire while the response streams.
    expect(sentTypes(ws).filter((t) => t === "conversation.item.create")).toHaveLength(3);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);

    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(1);
    expect(l.status).toBe("active");
    expect(ws.closed).toBe(0);
  });

  test("a tool call completing with no active response continues immediately (M1 single-tool path)", async () => {
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await handleEvent(cap, l, ws as any, functionCallDone("fc_1"));
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(1);
    expect(l.status).toBe("active");
  });

  test("an idle response.done without pending tool output creates nothing", async () => {
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(sentTypes(ws)).toHaveLength(0);
  });

  test("'active response in progress' is recoverable: session survives and continuation retries on response.done", async () => {
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, {
      type: "error",
      error: {
        code: "conversation_already_has_active_response",
        message: "Conversation already has an active response in progress: resp_X. Wait until the response is finished before creating a new one.",
      },
    });
    expect(l.status).toBe("active");
    expect(ws.closed).toBe(0);

    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(1);
    expect(l.status).toBe("active");
  });

  test("any other provider error remains terminal", async () => {
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "error", error: { code: "server_error", message: "boom" } });
    expect(l.status).toBe("error");
    expect(ws.closed).toBe(1);
  });
});
