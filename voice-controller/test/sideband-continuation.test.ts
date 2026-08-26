// Task 5 integration: sideband is a serialized transport adapter for the pure
// onboarding reducer. Valid legacy transport/reconnect/provider invariants stay;
// recap-character, watchdog, refusal-count and close-grace assertions are replaced
// with exact Realtime response/audio/playback evidence.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import {
  applyCoverageFact,
  createCoverage,
  evaluateCoverage,
  type CoverageFact,
  type CoverageField,
  type CoverageSnapshot,
} from "../src/onboarding-coverage.ts";
import { _setClient } from "../src/rules.ts";
import {
  attachSideband,
  handleEvent,
  liveSessions,
  persistLedger,
  type SessionLedger,
} from "../src/sideband.ts";
import { makeCapability, runTool, type Capability } from "../src/tools.ts";

const ownerId = "owner-1";

function onboardingCap(callId = "call-1"): Capability {
  return makeCapability(
    "rocha-plumbing", "tenant-1", callId, 15, "onboarding",
    { authEpoch: 1, policyEpoch: 1, simulation: true }, ownerId,
  );
}

function customerCap(callId = "call-customer"): Capability {
  return makeCapability(
    "rocha-plumbing", "tenant-1", callId, 15, "customer",
    { authEpoch: 1, policyEpoch: 1 },
  );
}

function ledger(callId = "call-1"): SessionLedger {
  return {
    callId,
    openaiCallId: `rtc-${callId}`,
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

function frames(ws: { sent: string[] }): any[] {
  return ws.sent.map((raw) => JSON.parse(raw));
}

function framesOfType(ws: { sent: string[] }, type: string): any[] {
  return frames(ws).filter((frame) => frame.type === type);
}

function functionOutputs(ws: { sent: string[] }): any[] {
  return frames(ws).filter(
    (frame) => frame.type === "conversation.item.create" &&
      frame.item?.type === "function_call_output",
  );
}

function responseCreated(responseId: string, intentKey?: string) {
  return {
    type: "response.created",
    response: { id: responseId, metadata: intentKey ? { intent_key: intentKey } : {} },
  };
}

function responseDone(responseId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "response.done",
    response: { id: responseId, status: "completed", ...extra },
  };
}

function functionCallDone(
  responseId: string,
  callId: string,
  name = "not_a_real_tool",
  args = "{}",
  outputIndex = 0,
  itemStatus = "completed",
) {
  return {
    type: "response.output_item.done",
    response_id: responseId,
    output_index: outputIndex,
    item: {
      type: "function_call",
      status: itemStatus,
      name,
      call_id: callId,
      arguments: args,
    },
  };
}

function outputAck(outputItemId: string) {
  return {
    type: "conversation.item.created",
    item: { id: outputItemId, type: "function_call_output" },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => _setClient(null));

describe("non-onboarding transport behavior remains source-compatible", () => {
  test("customer tool batches still yield one continuation after the terminal parent", async () => {
    const cap = customerCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, functionCallDone("resp-1", "fc-1"));
    await handleEvent(cap, l, ws as any, functionCallDone("resp-1", "fc-2"));
    await handleEvent(cap, l, ws as any, functionCallDone("resp-1", "fc-3"));
    expect(functionOutputs(ws)).toHaveLength(3);
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
    expect(l.status).toBe("active");
  });

  test("active-response races stay recoverable and other provider errors stay terminal", async () => {
    const cap = customerCap();
    const recoverable = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, recoverable, ws as any, {
      type: "error",
      error: {
        code: "conversation_already_has_active_response",
        message: "Conversation already has an active response in progress",
      },
    });
    expect(recoverable.status).toBe("active");
    await handleEvent(cap, recoverable, ws as any, { type: "response.done", response: {} });
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
    const terminal = ledger(cap.callId);
    const terminalSocket = socket();
    await handleEvent(cap, terminal, terminalSocket as any, {
      type: "error", error: { code: "server_error", message: "boom" },
    });
    expect(terminal.status).toBe("error");
    expect(terminalSocket.closed).toBe(1);
  });

  test("stale non-onboarding callbacks cannot deliver outputs", async () => {
    const cap = customerCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(
      cap, l, ws as any, functionCallDone("resp-stale", "fc-stale"), () => false,
    );
    expect(ws.sent).toEqual([]);
    expect(l.toolLog).toEqual([]);
  });

  test("single tool completing after its terminal response continues immediately", async () => {
    const cap = customerCap("call-single-after-terminal");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-single", "fc-single"));
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
  });

  test("idle terminal response emits no application continuation", async () => {
    const cap = customerCap("call-idle-terminal");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(ws.sent).toEqual([]);
  });

  test("tool batch straddling response.done waits for the final result and continues once", async () => {
    const cap = customerCap("call-straddled-batch");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    const first = handleEvent(cap, l, ws as any,
      functionCallDone("resp-straddled", "fc-straddled-1"));
    const second = handleEvent(cap, l, ws as any,
      functionCallDone("resp-straddled", "fc-straddled-2"));
    const terminal = handleEvent(
      cap, l, ws as any, { type: "response.done", response: {} },
    );
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await Promise.all([first, second, terminal]);
    expect(functionOutputs(ws)).toHaveLength(2);
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
  });

  test("stale in-flight old socket cannot corrupt a fresh batch or its one continuation", async () => {
    const cap = customerCap("call-stale-vs-fresh");
    const l = ledger(cap.callId);
    const oldSocket = socket();
    const freshSocket = socket();
    let oldCurrent = true;
    const oldWork = handleEvent(
      cap, l, oldSocket as any,
      functionCallDone("resp-old", "fc-old"),
      () => oldCurrent,
    );
    oldCurrent = false;
    l.responseActive = false;
    l.pendingToolCalls = 0;
    await handleEvent(cap, l, freshSocket as any, { type: "response.created" });
    const freshOne = handleEvent(cap, l, freshSocket as any,
      functionCallDone("resp-fresh", "fc-fresh-1"));
    const freshTwo = handleEvent(cap, l, freshSocket as any,
      functionCallDone("resp-fresh", "fc-fresh-2"));
    await handleEvent(cap, l, freshSocket as any, { type: "response.done", response: {} });
    await Promise.all([oldWork, freshOne, freshTwo]);
    expect(oldSocket.sent).toEqual([]);
    expect(functionOutputs(freshSocket)).toHaveLength(2);
    expect(framesOfType(freshSocket, "response.create")).toHaveLength(1);
    expect(l.pendingToolCalls).toBe(0);
  });
});

describe("onboarding raw correlation and durable tool outbox", () => {
  test("non-completed response terminal statuses have zero tool, store, or output effects", async () => {
    for (const status of ["cancelled", "failed", "incomplete", undefined]) {
      const cap = onboardingCap(`call-response-${status ?? "missing"}`);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, responseCreated("resp-status"));
      await handleEvent(cap, l, ws as any,
        functionCallDone("resp-status", "fc-status"));
      await handleEvent(cap, l, ws as any, {
        type: "response.done",
        response: {
          id: "resp-status",
          ...(status ? { status } : {}),
        },
      });
      expect(l.onboarding!.lifecycle.phase).toBe("blocked");
      expect(l.toolLog).toEqual([]);
      expect(functionOutputs(ws)).toEqual([]);
      expect(Object.keys(l.onboarding!.lifecycle.toolOutbox)).toEqual([]);
    }
  });

  test("ordinary cancelled VAD response is recoverable and rebinds pending speech to the next completed response", async () => {
    const cap = onboardingCap("call-cancelled-vad-rebind");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    const digest = "c".repeat(64);
    l.onboarding!.lifecycle.phase = "summary_speaking";
    l.onboarding!.lifecycle.coverage = {
      revision: 4, digest, complete: true, missing: [], ambiguous: [],
    };
    l.onboarding!.lifecycle.preparedSnapshotDigests = [digest];
    l.onboarding!.lifecycle.summary = {
      receiptId: "coverage-cancel",
      revision: 4,
      digest,
      requiredAnchors: ["Área: Irvine"],
      transcript: "",
      transcriptFinal: false,
      audioDone: false,
      responseDone: false,
      playbackStopped: false,
      interrupted: false,
    };
    const intentKey = `summary:${digest}`;
    l.onboarding!.lifecycle.responseIntents[intentKey] = {
      intentKey, purpose: "summary", state: "queued",
    };
    l.onboarding!.pendingResponseCommands[intentKey] = {
      type: "request_response",
      intentKey,
      purpose: "summary",
      snapshotDigest: digest,
      instructions: "Resumo atual.",
    };
    l.onboarding!.speechGeneration = 1;
    l.onboarding!.speechPending = true;

    await handleEvent(cap, l, ws as any, responseCreated("resp-vad-cancelled"));
    expect(l.onboarding!.speechResponseId).toBe("resp-vad-cancelled");
    await handleEvent(cap, l, ws as any, {
      type: "response.done",
      response: { id: "resp-vad-cancelled", status: "cancelled" },
    });
    expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    expect(l.onboarding!.speechPending).toBe(true);
    expect(l.onboarding!.speechResponseId).toBeUndefined();
    expect(l.onboarding!.lifecycle.terminalResponseIds)
      .toContain("resp-vad-cancelled");
    expect(framesOfType(ws, "response.create")).toHaveLength(0);

    await handleEvent(cap, l, ws as any, responseCreated("resp-vad-rebound"));
    expect(l.onboarding!.speechResponseId).toBe("resp-vad-rebound");
    await handleEvent(cap, l, ws as any, responseDone("resp-vad-rebound"));
    expect(l.onboarding!.speechPending).toBe(false);
    expect(l.onboarding!.speechResponseId).toBeUndefined();
    const summaries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].response.metadata.intent_key).toBe(intentKey);
  });

  test("failed or incomplete response without tools remains fail-closed", async () => {
    for (const status of ["failed", "incomplete"]) {
      const cap = onboardingCap(`call-empty-${status}`);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, responseCreated("resp-empty-invalid"));
      await handleEvent(cap, l, ws as any, {
        type: "response.done",
        response: { id: "resp-empty-invalid", status },
      });
      expect(l.onboarding!.lifecycle.phase).toBe("blocked");
      expect(l.toolLog).toEqual([]);
      expect(functionOutputs(ws)).toEqual([]);
    }
  });

  test("non-completed function item statuses have zero tool, store, or output effects", async () => {
    for (const status of ["cancelled", "failed", "incomplete", undefined]) {
      const cap = onboardingCap(`call-item-${status ?? "missing"}`);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, responseCreated("resp-item-status"));
      const item = functionCallDone(
        "resp-item-status", "fc-item-status", "not_a_real_tool", "{}", 0,
        status ?? "completed",
      );
      if (status === undefined) delete (item.item as any).status;
      await handleEvent(cap, l, ws as any, item);
      await handleEvent(cap, l, ws as any, responseDone("resp-item-status"));
      expect(l.onboarding!.lifecycle.phase).toBe("blocked");
      expect(l.toolLog).toEqual([]);
      expect(functionOutputs(ws)).toEqual([]);
    }
  });

  test("missing, invalid, or duplicate output_index blocks the complete batch before execution", async () => {
    const invalidIndexes: unknown[] = [undefined, -1, 1.5, "0"];
    for (const [position, outputIndex] of invalidIndexes.entries()) {
      const cap = onboardingCap(`call-index-${position}`);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, responseCreated("resp-index"));
      const item = functionCallDone("resp-index", "fc-index");
      (item as any).output_index = outputIndex;
      await handleEvent(cap, l, ws as any, item);
      await handleEvent(cap, l, ws as any, responseDone("resp-index"));
      expect(l.onboarding!.lifecycle.phase).toBe("blocked");
      expect(l.toolLog).toEqual([]);
      expect(functionOutputs(ws)).toEqual([]);
    }

    const cap = onboardingCap("call-index-duplicate");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-index-duplicate"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-index-duplicate", "fc-index-a", "not_a_real_tool", "{}", 3));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-index-duplicate", "fc-index-b", "not_a_real_tool", "{}", 3));
    await handleEvent(cap, l, ws as any, responseDone("resp-index-duplicate"));
    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(l.toolLog).toEqual([]);
    expect(functionOutputs(ws)).toEqual([]);
  });

  test("metadata-less VAD never claims a queued application intent", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-vad"));
    expect(l.onboarding!.lifecycle.activeResponseId).toBe("resp-vad");
    expect(l.onboarding!.lifecycle.responseIntents[`greeting:${cap.callId}`]?.responseId)
      .toBeUndefined();
    await handleEvent(cap, l, ws as any, responseDone("resp-vad"));
    await handleEvent(
      cap, l, ws as any,
      responseCreated("resp-greeting", `greeting:${cap.callId}`),
    );
    expect(l.onboarding!.lifecycle.responseIntents[`greeting:${cap.callId}`])
      .toMatchObject({ state: "acknowledged", responseId: "resp-greeting" });
  });

  test("ordered membership has a stable hash and exact send-to-ack state", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-tools"));
    const first = handleEvent(
      cap, l, ws as any,
      functionCallDone("resp-tools", "fc-z", "not_a_real_tool", JSON.stringify({ z: 2, a: 1 }), 9),
    );
    const second = handleEvent(
      cap, l, ws as any,
      functionCallDone("resp-tools", "fc-a", "not_a_real_tool", JSON.stringify({ b: true }), 2),
    );
    const terminal = handleEvent(cap, l, ws as any, responseDone("resp-tools"));
    await Promise.all([first, second, terminal]);
    expect(functionOutputs(ws).map((frame) => frame.item)).toEqual([
      expect.objectContaining({ id: "tool-output:fc-a", call_id: "fc-a" }),
      expect.objectContaining({ id: "tool-output:fc-z", call_id: "fc-z" }),
    ]);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-z"]?.state).toBe("output_pending");
    expect(l.onboarding!.lifecycle.toolOutbox["fc-a"]?.state).toBe("output_pending");
    const batches = Object.values(l.onboarding!.lifecycle.toolBatches);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      providerResponseId: "resp-tools", toolCallIds: ["fc-a", "fc-z"],
    });
    expect(batches[0]!.batchHash).toMatch(/^[a-f0-9]{64}$/);
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-z"));
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-a"));
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
    expect(framesOfType(ws, "response.create")[0].response.metadata).toMatchObject({
      purpose: "tool_continuation",
      intent_key: `tool-batch:resp-tools:${batches[0]!.batchHash}`,
    });
    const replayLedger = ledger("call-replay-hash");
    const replayCap = onboardingCap(replayLedger.callId);
    const replaySocket = socket();
    await handleEvent(replayCap, replayLedger, replaySocket as any, responseCreated("resp-tools"));
    await handleEvent(replayCap, replayLedger, replaySocket as any,
      functionCallDone("resp-tools", "fc-z", "not_a_real_tool", JSON.stringify({ a: 1, z: 2 }), 9));
    await handleEvent(replayCap, replayLedger, replaySocket as any,
      functionCallDone("resp-tools", "fc-a", "not_a_real_tool", JSON.stringify({ b: true }), 2));
    await handleEvent(replayCap, replayLedger, replaySocket as any, responseDone("resp-tools"));
    expect(Object.values(replayLedger.onboarding!.lifecycle.toolBatches)[0]!.batchHash)
      .toBe(batches[0]!.batchHash);
  });

  test("reversed arrival persists two interview answers in numeric output_index order", async () => {
    const cap = onboardingCap("call-index-order-rpc");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 1, digest: "1".repeat(64) },
      { status: "recorded", revision: 2, digest: "2".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    const firstArgs = {
      topic: "area", field: "area.coverage", disposition: "answered",
      rule_text: "FIRST authoritative correction.",
      structured: { value: ["Irvine"] }, owner_words: "Primeiro Irvine.",
    };
    const secondArgs = {
      topic: "area", field: "area.out_of_area_policy", disposition: "answered",
      rule_text: "SECOND authoritative correction.",
      structured: { value: "owner_review" }, owner_words: "Depois revisão.",
    };
    await handleEvent(cap, l, ws as any, responseCreated("resp-index-order"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-index-order", "fc-second", "record_interview_answer",
      JSON.stringify(secondArgs), 8,
    ));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-index-order", "fc-first", "record_interview_answer",
      JSON.stringify(firstArgs), 2,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-index-order"));

    expect(boundary.rpcFacts.map((fact) => fact.rule_text)).toEqual([
      "FIRST authoritative correction.",
      "SECOND authoritative correction.",
    ]);
    expect(functionOutputs(ws).map((frame) => frame.item.call_id)).toEqual([
      "fc-first", "fc-second",
    ]);
    expect(l.onboarding!.lifecycle.coverage.revision).toBe(2);
  });

  test("semantic reused answer is output-acked without regressing coverage; a real advance still changes it", async () => {
    const cap = onboardingCap("call-semantic-reused");
    const boundary = sequentialAnswerBoundary([
      { status: "reused", revision: 1, digest: "1".repeat(64) },
      { status: "recorded", revision: 3, digest: "3".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    l.onboarding!.lifecycle.coverage = {
      revision: 2,
      digest: "2".repeat(64),
      complete: false,
      missing: [],
      ambiguous: [],
    };
    const reusedArgs = {
      topic: "area", field: "area.coverage", disposition: "answered",
      rule_text: "Serve Irvine.", structured: { value: ["Irvine"] },
      owner_words: "Atendemos Irvine.",
    };
    await handleEvent(cap, l, ws as any, responseCreated("resp-reused"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-reused", "fc-reused-new-provider-id", "record_interview_answer",
      JSON.stringify(reusedArgs), 0,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-reused"));
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(l.onboarding!.lifecycle.coverage).toMatchObject({
      revision: 2, digest: "2".repeat(64),
    });
    expect(JSON.parse(functionOutputs(ws).at(-1)!.item.output).status).toBe("reused");
    await handleEvent(cap, l, ws as any,
      outputAck("tool-output:fc-reused-new-provider-id"));
    expect(l.onboarding!.lifecycle.toolOutbox["fc-reused-new-provider-id"]?.state)
      .toBe("output_acked");

    await handleEvent(cap, l, ws as any, responseCreated("resp-advance"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-advance", "fc-real-advance", "record_interview_answer",
      JSON.stringify({ ...reusedArgs, rule_text: "Serve Irvine e Anaheim." }), 0,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-advance"));
    expect(l.onboarding!.lifecycle.coverage).toMatchObject({
      revision: 3, digest: "3".repeat(64),
    });
  });

  test("coverage correction drops queued old signoff command and ignores its late response", async () => {
    const cap = onboardingCap("call-stale-signoff-command");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 2, digest: "b".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    const adapter = l.onboarding!;
    adapter.lifecycle.phase = "final_signoff_speaking";
    adapter.lifecycle.coverage = {
      revision: 1,
      digest: "a".repeat(64),
      complete: true,
      missing: [],
      ambiguous: [],
    };
    adapter.lifecycle.approval = {
      toolCallId: "approval-tool-A",
      approvalReceiptId: "approval-A",
      coverageReceiptId: "coverage-A",
      revision: 1,
      digest: "a".repeat(64),
    };
    adapter.lifecycle.signoff = {
      approvalReceiptId: "approval-A",
      audioDone: false,
      responseDone: false,
      playbackStopped: false,
      interrupted: false,
    };
    const oldIntent = "final-signoff:approval-A";
    adapter.lifecycle.responseIntents[oldIntent] = {
      intentKey: oldIntent,
      purpose: "final_signoff",
      state: "queued",
    };
    adapter.pendingResponseCommands[oldIntent] = {
      type: "request_response",
      intentKey: oldIntent,
      purpose: "final_signoff",
      approvalReceiptId: "approval-A",
      instructions: "Fechamento A.",
    };

    await handleEvent(cap, l, ws as any, responseCreated("resp-correction-B"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-correction-B",
      "fc-correction-B",
      "record_interview_answer",
      JSON.stringify({
        topic: "area",
        field: "area.coverage",
        disposition: "answered",
        rule_text: "Correção B.",
        structured: { value: ["Anaheim"] },
        owner_words: "Agora Anaheim.",
      }),
      0,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-correction-B"));
    expect(adapter.lifecycle.approval).toBeUndefined();
    expect(adapter.lifecycle.signoff).toBeUndefined();
    expect(adapter.lifecycle.responseIntents[oldIntent]?.state).toBe("terminal");
    expect(adapter.pendingResponseCommands[oldIntent]).toBeUndefined();

    const beforeLate = adapter.lifecycle;
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("late-old-signoff", oldIntent),
    );
    expect(adapter.lifecycle).toBe(beforeLate);
    expect(adapter.lifecycle.activeResponseId).toBeUndefined();
    expect(adapter.lifecycle.signoff).toBeUndefined();
    expect(adapter.lifecycle.requestedHangupKeys).toEqual([]);
  });

  test("exact duplicated provider items execute and send once", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    const item = functionCallDone(
      "resp-dup", "fc-dup", "not_a_real_tool", JSON.stringify({ one: 1 }),
    );
    await handleEvent(cap, l, ws as any, responseCreated("resp-dup"));
    await handleEvent(cap, l, ws as any, item);
    await handleEvent(cap, l, ws as any, item);
    await handleEvent(cap, l, ws as any, responseDone("resp-dup"));
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(l.toolLog).toHaveLength(1);
    expect(Object.values(l.onboarding!.lifecycle.toolOutbox)).toHaveLength(1);
  });

  test("same provider call_id with changed payload blocks before any tool execution", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-mismatch"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-mismatch", "fc-mismatch", "not_a_real_tool", JSON.stringify({ value: 1 })));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-mismatch", "fc-mismatch", "not_a_real_tool", JSON.stringify({ value: 2 })));
    await handleEvent(cap, l, ws as any, responseDone("resp-mismatch"));

    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(l.toolLog).toEqual([]);
    expect(functionOutputs(ws)).toEqual([]);
    expect(Object.values(l.onboarding!.lifecycle.toolOutbox)).toEqual([]);
  });

  test("cross-response changed call_id preflights the whole batch and never admits siblings", async () => {
    const cap = onboardingCap("call-cross-response-preflight");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 1, digest: "1".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-original"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-original", "fc-reused", "not_a_real_tool", JSON.stringify({ value: 1 }), 1));
    await handleEvent(cap, l, ws as any, responseDone("resp-original"));
    const outputsBefore = functionOutputs(ws).length;
    const toolsBefore = l.toolLog.length;

    await handleEvent(cap, l, ws as any, responseCreated("resp-changed"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-changed", "fc-reused", "not_a_real_tool", JSON.stringify({ value: 2 }), 1));
    await handleEvent(cap, l, ws as any,
      functionCallDone(
        "resp-changed",
        "fc-sibling",
        "record_interview_answer",
        JSON.stringify({
          topic: "area",
          field: "area.coverage",
          disposition: "answered",
          rule_text: "Sibling must never persist.",
          structured: { value: ["Irvine"] },
          owner_words: "Nunca deve persistir.",
        }),
        4,
      ));
    await handleEvent(cap, l, ws as any, responseDone("resp-changed"));
    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(l.toolLog).toHaveLength(toolsBefore);
    expect(functionOutputs(ws)).toHaveLength(outputsBefore);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-sibling"]).toBeUndefined();
    expect(boundary.rpcFacts).toEqual([]);

    await handleEvent(cap, l, ws as any, responseCreated("resp-after-block"));
    await handleEvent(cap, l, ws as any,
      functionCallDone(
        "resp-after-block",
        "fc-after-block",
        "record_interview_answer",
        JSON.stringify({
          topic: "area",
          field: "area.coverage",
          disposition: "answered",
          rule_text: "Blocked member must never persist.",
          structured: { value: ["Anaheim"] },
          owner_words: "Também não deve persistir.",
        }),
        0,
      ));
    await handleEvent(cap, l, ws as any, responseDone("resp-after-block"));
    expect(l.toolLog).toHaveLength(toolsBefore);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-after-block"]).toBeUndefined();
    expect(boundary.rpcFacts).toEqual([]);
  });

  test("adapter response and pending-command maps stay bounded with deterministic overflow", async () => {
    const responseCap = onboardingCap("call-response-capacity");
    const responseLedger = ledger(responseCap.callId);
    const responseSocket = socket();
    await handleEvent(
      responseCap, responseLedger, responseSocket as any,
      responseCreated("resp-bootstrap"),
    );
    await handleEvent(
      responseCap, responseLedger, responseSocket as any,
      responseDone("resp-bootstrap"),
    );
    responseLedger.onboarding!.responses = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `pending-response-${index}`,
        {
          responseId: `pending-response-${index}`,
          tools: [],
          terminal: false,
        },
      ]),
    );
    await handleEvent(
      responseCap, responseLedger, responseSocket as any,
      responseDone("overflow-response"),
    );
    expect(responseLedger.onboarding!.lifecycle.phase).toBe("blocked");
    expect(Object.keys(responseLedger.onboarding!.responses).length)
      .toBeLessThanOrEqual(512);

    const pruneCap = onboardingCap("call-response-prune");
    const pruneLedger = ledger(pruneCap.callId);
    const pruneSocket = socket();
    await handleEvent(pruneCap, pruneLedger, pruneSocket as any,
      responseCreated("resp-bootstrap"));
    await handleEvent(pruneCap, pruneLedger, pruneSocket as any,
      responseDone("resp-bootstrap"));
    pruneLedger.onboarding!.responses = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `terminal-response-${index}`,
        {
          responseId: `terminal-response-${index}`,
          tools: [],
          terminal: true,
        },
      ]),
    );
    await handleEvent(pruneCap, pruneLedger, pruneSocket as any,
      responseDone("new-pruned-response"));
    expect(pruneLedger.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(Object.keys(pruneLedger.onboarding!.responses)).toHaveLength(512);
    expect(pruneLedger.onboarding!.responses["terminal-response-0"]).toBeUndefined();
    expect(pruneLedger.onboarding!.responses["new-pruned-response"]).toBeDefined();

    const pendingCap = onboardingCap("call-pending-capacity");
    const pendingLedger = ledger(pendingCap.callId);
    const pendingSocket = socket();
    await handleEvent(pendingCap, pendingLedger, pendingSocket as any,
      responseCreated("resp-bootstrap"));
    await handleEvent(pendingCap, pendingLedger, pendingSocket as any,
      responseDone("resp-bootstrap"));
    pendingLedger.onboarding!.pendingResponseCommands = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `pending-intent-${index}`,
        {
          type: "request_response",
          intentKey: `pending-intent-${index}`,
          purpose: "tool_continuation",
        },
      ]),
    );
    await handleEvent(pendingCap, pendingLedger, pendingSocket as any,
      responseCreated("resp-pending-overflow"));
    await handleEvent(pendingCap, pendingLedger, pendingSocket as any,
      functionCallDone("resp-pending-overflow", "fc-pending-overflow", "end_session"));
    await handleEvent(pendingCap, pendingLedger, pendingSocket as any,
      responseDone("resp-pending-overflow"));
    await handleEvent(pendingCap, pendingLedger, pendingSocket as any,
      outputAck("tool-output:fc-pending-overflow"));
    expect(pendingLedger.onboarding!.lifecycle.phase).toBe("blocked");
    expect(Object.keys(pendingLedger.onboarding!.pendingResponseCommands))
      .toHaveLength(0);
    expect(framesOfType(pendingSocket, "response.create")).toHaveLength(0);
  });

  test("first through hundredth premature end_session stays refused", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const responseId = `resp-close-${attempt}`;
      const toolCallId = `fc-close-${attempt}`;
      await handleEvent(cap, l, ws as any, responseCreated(responseId));
      await handleEvent(cap, l, ws as any,
        functionCallDone(responseId, toolCallId, "end_session"));
      await handleEvent(cap, l, ws as any, responseDone(responseId));
      await handleEvent(cap, l, ws as any, outputAck(`tool-output:${toolCallId}`));
    }
    expect(l.status).toBe("active");
    expect(l.agentEnded).toBeUndefined();
    expect(ws.closed).toBe(0);
    expect(functionOutputs(ws)).toHaveLength(100);
    for (const frame of functionOutputs(ws))
      expect(JSON.parse(frame.item.output)).toEqual({
        status: "application_owned_close", ending: false,
      });
    expect(l.onboarding!.lifecycle.requestedHangupKeys).toEqual([]);
  });

  test("premature end_session after a proven summary refuses and continues instead of stalling", async () => {
    const cap = onboardingCap("call-close-after-summary");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    seedAwaitingApproval(l, "coverage-receipt-1", 1, "1".repeat(64));

    await handleEvent(cap, l, ws as any, responseCreated("resp-close"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-close", "fc-close", "end_session"));
    await handleEvent(cap, l, ws as any, responseDone("resp-close"));
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-close"));

    expect(l.status).toBe("active");
    expect(l.onboarding!.lifecycle.phase).toBe("awaiting_owner_approval");
    const creates = framesOfType(ws, "response.create");
    expect(creates).toHaveLength(1);
    expect(creates[0].response.metadata.purpose).toBe("tool_continuation");
  });

  function seedSummary(l: SessionLedger) {
    const lifecycle = l.onboarding!.lifecycle;
    lifecycle.phase = "summary_speaking";
    lifecycle.summary = {
      receiptId: "coverage-1",
      revision: 1,
      digest: "digest-1",
      requiredAnchors: ["Área: Irvine"],
      responseId: "resp-summary",
      transcript: "",
      transcriptFinal: false,
      audioDone: false,
      responseDone: false,
      playbackStopped: false,
      interrupted: false,
    };
    lifecycle.activeResponseId = "resp-summary";
    l.responseActive = true;
  }

  test("long text and terminal response never substitute for generated audio", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    seedSummary(l);
    await handleEvent(cap, l, ws as any, {
      type: "response.output_text.done",
      response_id: "resp-summary",
      text: "x".repeat(1_000),
    });
    await handleEvent(cap, l, ws as any, responseDone("resp-summary"));
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped", response_id: "resp-summary",
    });
    expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    expect(l.onboarding!.lifecycle.summary).toMatchObject({
      transcriptFinal: false, audioDone: false,
      responseDone: true, playbackStopped: true,
    });
  });

  test("summary proof accepts transcript/audio/terminal/playback only for the exact response", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    seedSummary(l);
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "resp-other",
      transcript: "Área: Irvine. Você confirma que está tudo correto?",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio.done", response_id: "resp-other",
    });
    await handleEvent(cap, l, ws as any, responseDone("resp-other"));
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped", response_id: "resp-other",
    });
    expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "resp-summary",
      transcript: "Área: Irvine. Você confirma que está tudo correto?",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio.done", response_id: "resp-summary",
    });
    await handleEvent(cap, l, ws as any, responseDone("resp-summary"));
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped", response_id: "resp-other",
    });
    expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped", response_id: "resp-summary",
    });
    expect(l.onboarding!.lifecycle.phase).toBe("awaiting_owner_approval");
    expect(l.onboarding!.lifecycle.summary?.validated).toBe(true);
  });

  test("caller speech, cancelled response and output clear invalidate current summary audio", async () => {
    for (const interrupt of [
      { type: "input_audio_buffer.speech_started", item_id: "turn-1" },
      { type: "response.cancelled", response_id: "resp-summary" },
      { type: "output_audio_buffer.cleared", response_id: "resp-summary" },
    ]) {
      const cap = onboardingCap(`call-${interrupt.type}`);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
      await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
      seedSummary(l);
      l.onboarding!.lifecycle.summary!.transcript =
        "Área: Irvine. Você confirma que está tudo correto?";
      l.onboarding!.lifecycle.summary!.transcriptFinal = true;
      l.onboarding!.lifecycle.summary!.audioDone = true;
      await handleEvent(cap, l, ws as any, interrupt);
      expect(l.onboarding!.lifecycle.summary).toMatchObject({
        interrupted: true, audioDone: false, playbackStopped: false,
      });
      expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    }
  });

  test("provider terminal before approval-bound signoff is interruption, not success", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    await handleEvent(cap, l, socket() as any, { type: "session.ended" });
    expect(l.status).toBe("error");
    expect(l.onboarding!.interrupted).toBe(true);
    const terminating = ledger("call-provider-terminating");
    const terminatingCap = onboardingCap(terminating.callId);
    const terminatingSocket = socket();
    await handleEvent(
      terminatingCap, terminating, terminatingSocket as any,
      responseCreated("resp-bootstrap"),
    );
    terminating.onboarding!.lifecycle.phase = "provider_terminating";
    terminating.onboarding!.interrupted = false;
    await handleEvent(terminatingCap, terminating, terminatingSocket as any, {
      type: "session.ended",
    });
    expect(terminating.status).toBe("ended");
    expect(terminating.onboarding!.interrupted).toBe(false);
  });

  test("no character watchdog, recap push or delayed close owner remains", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-promise"));
    await handleEvent(cap, l, ws as any, {
      type: "response.output_text.done",
      response_id: "resp-promise",
      text: "Vou recapitular tudo em seguida. ".repeat(20),
    });
    await handleEvent(cap, l, ws as any, responseDone("resp-promise"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.sent).toEqual([]);
    expect("pendingRecapAfterRecords" in l).toBe(false);
    expect("recapPushTimer" in l).toBe(false);
    expect("recapRefusals" in l).toBe(false);
  });
});

const universalFields: CoverageField[] = [
  "business.customer_types", "business.excluded_work",
  "business.languages_tone", "area.coverage", "area.out_of_area_policy",
  "area.travel_fee", "schedule.business_hours", "schedule.same_day_lead_time",
  "schedule.capacity_buffer", "schedule.reschedule_cancel", "schedule.holidays",
  "emergency.types", "emergency.safety_escalation", "emergency.after_hours",
  "emergency.fee_authority", "policy.payment_estimate",
  "policy.warranty_materials", "policy.access_cancellation",
  "policy.complaints_returns", "authority.quote_price",
  "authority.negotiate_floor", "authority.read_calendar", "authority.book",
  "authority.reschedule_cancel", "authority.charge_fee",
  "authority.emergency", "authority.out_of_area",
];

function completeCoverage(cap: Capability, revision: number): CoverageSnapshot {
  let snapshot = createCoverage({ tenantId: cap.tenantId, callId: cap.callId });
  snapshot = applyCoverageFact(snapshot, {
    field: "service.catalog_closure", disposition: "answered", value: true,
    ownerWords: "Esses são todos os serviços.",
  });
  for (const field of universalFields) {
    const values: Partial<Record<CoverageField, unknown>> = {
      "business.customer_types": ["residencial"],
      "area.coverage": ["Irvine"],
      "schedule.business_hours": "segunda a sexta, 08:00 às 18:00",
      "emergency.types": ["vazamento"],
      "emergency.safety_escalation": "ligar 911 em risco imediato",
    };
    const fact: CoverageFact = values[field] !== undefined
      ? {
          field, disposition: "answered", value: values[field],
          ownerWords: "Resposta explícita do dono.",
        }
      : {
          field, disposition: "owner_review_required", value: null,
          ownerWords: "Preciso revisar depois.",
        };
    snapshot = applyCoverageFact(snapshot, fact);
  }
  return { ...snapshot, revision };
}

function coverageReceipt(
  cap: Capability,
  snapshot: CoverageSnapshot,
  digest: string,
  ruleId: string,
) {
  const progress = evaluateCoverage(snapshot);
  expect(progress.readyForReview).toBe(true);
  return {
    id: `coverage-receipt-${snapshot.revision}`,
    readback: {
      schema_version: 1,
      tenant_id: cap.tenantId,
      call_id: cap.callId,
      revision: snapshot.revision,
      complete: true,
      snapshot,
      progress,
      selected_rule_ids: [ruleId],
      next_action: { type: "prepare_summary" },
      snapshot_digest: digest,
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
    },
  };
}

function snapshotBoundary(
  receipt: ReturnType<typeof coverageReceipt>,
  options: { approvalChanged?: boolean; approvalSuccess?: boolean } = {},
) {
  const ruleId = receipt.readback.selected_rule_ids[0]!;
  const calls = { receiptReads: 0, ruleReads: 0, rpc: [] as string[] };
  return {
    calls,
    client: {
      from(table: string) {
        const query: any = {
          select() { return query; }, eq() { return query; },
          in() { return query; }, order() { return query; }, limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          then(resolve: (value: unknown) => unknown) {
            if (table === "receipts") {
              calls.receiptReads += 1;
              return Promise.resolve({ data: [receipt], error: null }).then(resolve);
            }
            if (table === "rules") {
              calls.ruleReads += 1;
              return Promise.resolve({
                data: [{
                  id: ruleId, rule_group_id: "rule-group-1", version: 1,
                  structured: { coverage_field: "area.coverage" },
                  created_at: "2026-08-25T00:00:00.000Z",
                }],
                error: null,
              }).then(resolve);
            }
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string) {
        calls.rpc.push(name);
        if (name === "record_onboarding_voice_approval" && options.approvalChanged)
          return Promise.resolve({
            data: null, error: { code: "40001", message: "snapshot changed" },
          });
        if (name === "record_onboarding_voice_approval" && options.approvalSuccess)
          return Promise.resolve({
            data: {
              status: "recorded",
              approval_receipt_id: "approval-receipt-1",
              coverage_receipt_id: receipt.id,
              revision: receipt.readback.revision,
              snapshot_digest: receipt.readback.snapshot_digest,
            },
            error: null,
          });
        return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
      },
    } as any,
  };
}

function delayedSnapshotBoundary(receipt: ReturnType<typeof coverageReceipt>) {
  const ruleId = receipt.readback.selected_rule_ids[0]!;
  let firstReceiptRead = true;
  let resolveReceipt!: () => void;
  const gate = new Promise<void>((resolve) => { resolveReceipt = resolve; });
  return {
    resolveReceipt,
    client: {
      from(table: string) {
        const query: any = {
          select() { return query; }, eq() { return query; }, in() { return query; },
          order() { return query; }, limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          async then(resolve: (value: unknown) => unknown) {
            if (table === "receipts") {
              if (firstReceiptRead) {
                firstReceiptRead = false;
                await gate;
              }
              return resolve({ data: [receipt], error: null });
            }
            if (table === "rules")
              return resolve({
                data: [{
                  id: ruleId,
                  rule_group_id: "rule-group-delayed",
                  version: 1,
                  structured: { coverage_field: "area.coverage" },
                  created_at: "2026-08-25T00:00:00.000Z",
                }],
                error: null,
              });
            return resolve({ data: null, error: null });
          },
        };
        return query;
      },
      rpc() {
        return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
      },
    } as any,
  };
}

function sequentialAnswerBoundary(results: Array<{
  status: "recorded" | "reused";
  revision: number;
  digest: string;
}>) {
  const rpcFacts: Array<Record<string, unknown>> = [];
  let resultIndex = 0;
  return {
    rpcFacts,
    client: {
      from(table: string) {
        const query: any = {
          select() { return query; }, eq() { return query; }, order() { return query; },
          limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: table === "receipts" ? [] : [], error: null,
            }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string, args: Record<string, unknown>) {
        if (name !== "record_onboarding_answer")
          return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
        rpcFacts.push(args.p_fact as Record<string, unknown>);
        const next = results[Math.min(resultIndex, results.length - 1)]!;
        resultIndex += 1;
        return Promise.resolve({
          data: {
            status: next.status,
            rule_id: `rule-${resultIndex}`,
            rule_group_id: `group-${resultIndex}`,
            coverage_receipt_id: `receipt-${next.revision}`,
            revision: next.revision,
            snapshot_digest: next.digest,
            complete: false,
            missing: [],
            ambiguous: [],
            next_action: {
              type: "ask",
              field: "service.catalog_closure",
              question_pt: "Esses são todos os serviços?",
            },
            coverage: {},
          },
          error: null,
        });
      },
    } as any,
  };
}

function staleSummaryCorrectionBoundary(
  oldReceipt: ReturnType<typeof coverageReceipt>,
  newReceipt: ReturnType<typeof coverageReceipt>,
  newComplete: boolean,
) {
  let correctionPersisted = false;
  let firstReceiptRead = true;
  let resolveOldSnapshot!: () => void;
  const oldSnapshotGate = new Promise<void>((resolve) => {
    resolveOldSnapshot = resolve;
  });
  const ruleRows = [
    {
      id: oldReceipt.readback.selected_rule_ids[0]!,
      rule_group_id: "old-group",
      version: 1,
      structured: { coverage_field: "area.coverage" },
      created_at: "2026-08-25T00:00:00.000Z",
    },
    {
      id: newReceipt.readback.selected_rule_ids[0]!,
      rule_group_id: "new-group",
      version: 2,
      structured: { coverage_field: "area.coverage" },
      created_at: "2026-08-25T00:01:00.000Z",
    },
  ];
  return {
    resolveOldSnapshot,
    client: {
      from(table: string) {
        let requestedIds: unknown[] | undefined;
        const query: any = {
          select() { return query; }, eq() { return query; }, order() { return query; },
          limit() { return query; },
          in(_column: string, values: unknown[]) { requestedIds = values; return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          async then(resolve: (value: unknown) => unknown) {
            if (table === "receipts") {
              if (firstReceiptRead) {
                firstReceiptRead = false;
                await oldSnapshotGate;
              }
              return resolve({
                data: [correctionPersisted ? newReceipt : oldReceipt],
                error: null,
              });
            }
            if (table === "rules") {
              const data = requestedIds
                ? ruleRows.filter((row) => requestedIds!.includes(row.id))
                : ruleRows;
              return resolve({ data, error: null });
            }
            return resolve({ data: null, error: null });
          },
        };
        return query;
      },
      rpc(name: string) {
        if (name !== "record_onboarding_answer")
          return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
        correctionPersisted = true;
        return Promise.resolve({
          data: {
            status: "recorded",
            rule_id: newReceipt.readback.selected_rule_ids[0],
            rule_group_id: "new-group",
            coverage_receipt_id: newReceipt.id,
            revision: newReceipt.readback.revision,
            snapshot_digest: newReceipt.readback.snapshot_digest,
            complete: newComplete,
            missing: newComplete ? [] : [{ field: "area.coverage" }],
            ambiguous: [],
            next_action: newComplete
              ? { type: "prepare_summary" }
              : {
                  type: "ask",
                  field: "area.coverage",
                  question_pt: "Qual é a nova área?",
                },
            coverage: {},
          },
          error: null,
        });
      },
    } as any,
  };
}

function seedAwaitingApproval(
  l: SessionLedger,
  receiptId: string,
  revision: number,
  digest: string,
) {
  const lifecycle = l.onboarding!.lifecycle;
  lifecycle.phase = "awaiting_owner_approval";
  lifecycle.coverage = {
    revision, digest, complete: true, missing: [], ambiguous: [],
  };
  lifecycle.preparedSnapshotDigests = [digest];
  lifecycle.summary = {
    receiptId, revision, digest, requiredAnchors: ["Área: Irvine"],
    responseId: "resp-summary", transcript:
      "Área: Irvine. Você confirma que está tudo correto?",
    transcriptFinal: true, audioDone: true, responseDone: true,
    playbackStopped: true, validated: true, interrupted: false,
  };
  lifecycle.approvalCandidate = {
    turnId: "turn-approval", ownerWords: "Aprovado.",
  };
}

describe("snapshot, approval, signoff and hangup command execution", () => {
  test("prepare_summary loads one authoritative snapshot and sends one digest-bound response", async () => {
    const cap = onboardingCap("call-summary-load");
    const snapshot = completeCoverage(cap, 1);
    const digest = "1".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-1");
    const boundary = snapshotBoundary(receipt);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-collecting"));
    l.onboarding!.lifecycle.phase = "coverage_check";
    l.onboarding!.lifecycle.coverage = {
      revision: 1, digest, complete: true, missing: [], ambiguous: [],
    };
    await handleEvent(cap, l, ws as any, responseDone("resp-collecting"));
    expect(boundary.calls.ruleReads).toBe(1);
    expect(boundary.calls.receiptReads).toBe(2);
    expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    const summaryCreates = framesOfType(ws, "response.create");
    expect(summaryCreates).toHaveLength(1);
    expect(summaryCreates[0].response.metadata).toMatchObject({
      intent_key: `summary:${digest}`, purpose: "summary", snapshot_digest: digest,
    });
  });

  test("speech ingress during a slow snapshot suppresses summary until the same-socket VAD response is terminal", async () => {
    const cap = onboardingCap("call-slow-snapshot-speech");
    const snapshot = completeCoverage(cap, 1);
    const digest = "9".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-slow-speech");
    const boundary = delayedSnapshotBoundary(receipt);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-coverage"));
    l.onboarding!.lifecycle.phase = "coverage_check";
    l.onboarding!.lifecycle.coverage = {
      revision: 1, digest, complete: true, missing: [], ambiguous: [],
    };
    const snapshotWork = handleEvent(cap, l, ws as any, responseDone("resp-coverage"));
    await flushAsync();
    const speechWork = handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-during-snapshot",
    });
    const transcriptWork = handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-during-snapshot",
      transcript: "Só um momento, quero acrescentar uma correção.",
    });
    expect(l.onboarding!.speechGeneration).toBe(1);
    boundary.resolveReceipt();
    await Promise.all([snapshotWork, speechWork, transcriptWork]);

    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "summary",
    )).toHaveLength(0);
    expect(l.transcript.some((entry) =>
      entry.role === "caller" && entry.text.includes("correção")
    )).toBe(true);

    await handleEvent(cap, l, ws as any, responseCreated("resp-vad-fresh"));
    await handleEvent(cap, l, ws as any, responseDone("resp-vad-fresh"));
    const summaries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].response.metadata.intent_key).toBe(`summary:${digest}`);
  });

  test("VAD correction invalidates delayed old summary; only a complete new digest may speak", async () => {
    for (const newComplete of [false, true]) {
      const cap = onboardingCap(`call-stale-summary-${newComplete}`);
      const oldSnapshot = completeCoverage(cap, 1);
      const newSnapshot = completeCoverage(cap, 2);
      const oldDigest = "a".repeat(64);
      const newDigest = "b".repeat(64);
      const oldReceipt = coverageReceipt(cap, oldSnapshot, oldDigest, "old-rule");
      const newReceipt = coverageReceipt(cap, newSnapshot, newDigest, "new-rule");
      const boundary = staleSummaryCorrectionBoundary(
        oldReceipt, newReceipt, newComplete,
      );
      _setClient(boundary.client);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, responseCreated("resp-old-coverage"));
      l.onboarding!.lifecycle.phase = "coverage_check";
      l.onboarding!.lifecycle.coverage = {
        revision: 1,
        digest: oldDigest,
        complete: true,
        missing: [],
        ambiguous: [],
      };
      const snapshotWork = handleEvent(
        cap, l, ws as any, responseDone("resp-old-coverage"),
      );
      await flushAsync();
      const speechWork = handleEvent(cap, l, ws as any, {
        type: "input_audio_buffer.speech_started",
        item_id: "turn-correction",
      });
      const transcriptWork = handleEvent(cap, l, ws as any, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "turn-correction",
        transcript: "Corrigindo a área de atendimento.",
      });
      boundary.resolveOldSnapshot();
      await Promise.all([snapshotWork, speechWork, transcriptWork]);
      expect(l.onboarding!.pendingResponseCommands[`summary:${oldDigest}`])
        .toBeDefined();

      await handleEvent(cap, l, ws as any, responseCreated("resp-vad-correction"));
      await handleEvent(cap, l, ws as any, functionCallDone(
        "resp-vad-correction",
        "fc-vad-correction",
        "record_interview_answer",
        JSON.stringify({
          topic: "area",
          field: "area.coverage",
          disposition: "answered",
          rule_text: "Nova área corrigida.",
          structured: { value: ["Anaheim"] },
          owner_words: "Agora atendemos Anaheim.",
        }),
        0,
      ));
      await handleEvent(cap, l, ws as any, responseDone("resp-vad-correction"));
      expect(framesOfType(ws, "response.create").filter(
        (frame) => frame.response?.metadata?.intent_key === `summary:${oldDigest}`,
      )).toHaveLength(0);
      expect(l.onboarding!.pendingResponseCommands[`summary:${oldDigest}`])
        .toBeUndefined();
      expect(l.onboarding!.lifecycle.responseIntents[`summary:${oldDigest}`]?.state)
        .toBe("terminal");

      await handleEvent(cap, l, ws as any,
        outputAck("tool-output:fc-vad-correction"));
      const newSummaries = framesOfType(ws, "response.create").filter(
        (frame) => frame.response?.metadata?.intent_key === `summary:${newDigest}`,
      );
      expect(newSummaries).toHaveLength(newComplete ? 1 : 0);
      expect(framesOfType(ws, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "summary",
      )).toHaveLength(newComplete ? 1 : 0);
      _setClient(null);
    }
  });

  test("changed approval refreshes, acks its output, then runs ordinary summary preparation", async () => {
    const cap = onboardingCap("call-refresh-load");
    const snapshot = completeCoverage(cap, 2);
    const digest = "2".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-2");
    const boundary = snapshotBoundary(receipt, { approvalChanged: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    seedAwaitingApproval(l, "coverage-receipt-1", 1, "1".repeat(64));
    await handleEvent(cap, l, ws as any, responseCreated("resp-approval"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval", "fc-approval", "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado." }),
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-approval"));
    const changedOutput = functionOutputs(ws).find(
      (frame) => frame.item.id === "tool-output:fc-approval",
    );
    expect(JSON.parse(changedOutput.item.output)).toEqual({
      status: "snapshot_changed", retrying_summary: true,
    });
    expect(l.onboarding!.lifecycle.snapshotRefresh).toBeUndefined();
    expect(l.onboarding!.lifecycle.coverage).toMatchObject({
      revision: 2, digest, complete: true,
    });
    expect(boundary.calls.ruleReads).toBe(1);
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-approval"));
    expect(boundary.calls.ruleReads).toBe(2);
    expect(framesOfType(ws, "response.create").at(-1)!.response.metadata)
      .toMatchObject({ intent_key: `summary:${digest}`, purpose: "summary" });
  });

  test("approval ack requests one signoff; exact final playback requests one hangup", async () => {
    const cap = onboardingCap("call-signoff");
    const snapshot = completeCoverage(cap, 1);
    const digest = "3".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-3");
    const boundary = snapshotBoundary(receipt, { approvalSuccess: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    seedAwaitingApproval(l, receipt.id, 1, digest);
    await handleEvent(cap, l, ws as any, responseCreated("resp-approval"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval", "fc-approval", "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado." }),
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-approval"));
    expect(l.onboarding!.lifecycle.phase).toBe("approval_persisting");
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-approval"));
    const creates = framesOfType(ws, "response.create");
    expect(creates).toHaveLength(1);
    expect(creates[0].response.metadata).toEqual({
      intent_key: "final-signoff:approval-receipt-1",
      purpose: "final_signoff",
      approval_receipt_id: "approval-receipt-1",
    });
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-approval"));
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
    await handleEvent(cap, l, ws as any,
      responseCreated("resp-signoff", "final-signoff:approval-receipt-1"));
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio.done", response_id: "resp-signoff",
    });
    await handleEvent(cap, l, ws as any, responseDone("resp-signoff"));
    expect(l.status).toBe("active");
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped", response_id: "resp-other",
    });
    expect(l.status).toBe("active");
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped", response_id: "resp-signoff",
    });
    expect(l.status).toBe("ended");
    expect(l.agentEnded).toBe(true);
    expect(ws.closed).toBe(1);
    expect(l.onboarding!.pendingHangupIntentKey).toBe("hangup:approval-receipt-1");
    expect(l.onboarding!.lifecycle.requestedHangupKeys)
      .toEqual(["hangup:approval-receipt-1"]);
  });

  test("approval cannot start signoff until every sibling output in its terminal batch is acknowledged", async () => {
    const cap = onboardingCap("call-approval-sibling");
    const snapshot = completeCoverage(cap, 1);
    const digest = "4".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-4");
    const boundary = snapshotBoundary(receipt, { approvalSuccess: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-bootstrap"));
    await handleEvent(cap, l, ws as any, responseDone("resp-bootstrap"));
    seedAwaitingApproval(l, receipt.id, 1, digest);

    await handleEvent(cap, l, ws as any, responseCreated("resp-approval-batch"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval-batch", "fc-approval", "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado." }),
    ));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-approval-batch", "fc-close-sibling", "end_session", "{}", 1));
    await handleEvent(cap, l, ws as any, responseDone("resp-approval-batch"));

    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-approval"));
    expect(l.onboarding!.lifecycle.phase).toBe("approval_persisting");
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await handleEvent(cap, l, ws as any, outputAck("tool-output:fc-close-sibling"));
    expect(l.onboarding!.lifecycle.phase).toBe("final_signoff_speaking");
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
    expect(framesOfType(ws, "response.create")[0].response.metadata.purpose)
      .toBe("final_signoff");
  });
});

describe("physical socket attach and reconnect", () => {
  class SyntheticWebSocket {
    static instances: SyntheticWebSocket[] = [];
    listeners = new Map<string, Array<(event: any) => void>>();
    sent: string[] = [];
    failFunctionOutputs = false;
    failResponseCreates = false;
    suppressCloseEvent = false;
    closed = 0;
    constructor() { SyntheticWebSocket.instances.push(this); }
    addEventListener(type: string, listener: (event: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(payload: string) {
      const frame = JSON.parse(payload);
      if (this.failFunctionOutputs && frame.item?.type === "function_call_output")
        throw new Error("synthetic output send failure");
      if (this.failResponseCreates && frame.type === "response.create")
        throw new Error("synthetic response send failure");
      this.sent.push(payload);
    }
    close() {
      this.closed += 1;
      if (!this.suppressCloseEvent) this.emit("close", { code: 1000 });
    }
    emit(type: string, event: any = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    message(value: unknown) {
      this.emit("message", { data: JSON.stringify(value) });
    }
  }

  test("greeting is keyed once and is not replayed just because the socket reattached", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-greeting");
    try {
      const control = attachSideband(cap, "rtc-greeting", "gpt-realtime-2.1");
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      const firstCreates = framesOfType(first, "response.create");
      expect(firstCreates).toHaveLength(1);
      expect(firstCreates[0].response.metadata.intent_key)
        .toBe(`greeting:${cap.callId}`);
      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(framesOfType(second, "response.create")).toHaveLength(0);
      expect(control.ledger.onboarding!.lifecycle.socketGeneration).toBe(2);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("blocked reattach prunes queued authority speech and resends only exact pending output", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-blocked-reattach");
    try {
      const control = attachSideband(
        cap, "rtc-blocked-reattach", "gpt-realtime-2.1",
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      const adapter = control.ledger.onboarding!;
      adapter.lifecycle.phase = "blocked";
      adapter.lifecycle.responseIntents["summary:old"] = {
        intentKey: "summary:old", purpose: "summary", state: "queued",
      };
      adapter.lifecycle.responseIntents["final-signoff:old"] = {
        intentKey: "final-signoff:old", purpose: "final_signoff", state: "queued",
      };
      adapter.pendingResponseCommands["summary:old"] = {
        type: "request_response",
        intentKey: "summary:old",
        purpose: "summary",
        snapshotDigest: "old",
        instructions: "Resumo antigo.",
      };
      adapter.pendingResponseCommands["final-signoff:old"] = {
        type: "request_response",
        intentKey: "final-signoff:old",
        purpose: "final_signoff",
        approvalReceiptId: "old",
        instructions: "Fechamento antigo.",
      };
      adapter.lifecycle.toolOutbox["blocked-output"] = {
        toolCallId: "blocked-output",
        toolName: "end_session",
        argsHash: "blocked-args",
        state: "output_pending",
        providerResponseId: "blocked-response",
        batchHash: "blocked-batch",
        output: "{\"status\":\"application_owned_close\"}",
        resultHash: "blocked-result",
        outputItemId: "tool-output:blocked-output",
        socketGeneration: 1,
      };

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(adapter.lifecycle.phase).toBe("blocked");
      expect(adapter.lifecycle.socketGeneration).toBe(2);
      expect(framesOfType(second, "response.create")).toHaveLength(0);
      expect(functionOutputs(second)).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({
            id: "tool-output:blocked-output",
            call_id: "blocked-output",
          }),
        }),
      ]);
      expect(adapter.pendingResponseCommands).toEqual({});
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("an application response that never left the old socket retries once on reattach", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-greeting-send-retry");
    try {
      const control = attachSideband(
        cap, "rtc-greeting-send-retry", "gpt-realtime-2.1",
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.failResponseCreates = true;
      first.emit("open");
      await control.opened;
      expect(framesOfType(first, "response.create")).toHaveLength(0);
      expect(control.ledger.onboarding!.lifecycle.responseIntents[
        `greeting:${cap.callId}`
      ]?.state).toBe("queued");

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const creates = framesOfType(second, "response.create");
      expect(creates).toHaveLength(1);
      expect(creates[0].response.metadata.intent_key)
        .toBe(`greeting:${cap.callId}`);
      expect(control.ledger.onboarding!.lifecycle.responseIntents[
        `greeting:${cap.callId}`
      ]?.state).toBe("sent");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("summary intent created after delayed snapshot and socket replacement drains on the new generation", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-delayed-snapshot-reattach");
    const snapshot = completeCoverage(cap, 1);
    const digest = "8".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-delayed");
    const boundary = delayedSnapshotBoundary(receipt);
    _setClient(boundary.client);
    try {
      const control = attachSideband(
        cap, "rtc-delayed-snapshot-reattach", "gpt-realtime-2.1",
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      first.message(responseCreated("resp-greeting", `greeting:${cap.callId}`));
      first.message(responseDone("resp-greeting"));
      await flushAsync();
      control.ledger.onboarding!.lifecycle.phase = "coverage_check";
      control.ledger.onboarding!.lifecycle.coverage = {
        revision: 1, digest, complete: true, missing: [], ambiguous: [],
      };
      first.message(responseCreated("resp-coverage"));
      first.message(responseDone("resp-coverage"));
      await flushAsync();
      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      boundary.resolveReceipt();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(framesOfType(first, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "summary",
      )).toHaveLength(0);
      const summaries = framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "summary",
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0].response.metadata.intent_key).toBe(`summary:${digest}`);
      expect(control.ledger.onboarding!.lifecycle.socketGeneration).toBe(2);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("failed output send stays executed and reattach resends without rerunning", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-output-reattach");
    try {
      const control = attachSideband(
        cap, "rtc-output-reattach", "gpt-realtime-2.1",
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      first.message(responseCreated("resp-greeting", `greeting:${cap.callId}`));
      first.message(responseDone("resp-greeting"));
      await flushAsync();
      first.failFunctionOutputs = true;
      first.message(responseCreated("resp-tool"));
      first.message(functionCallDone("resp-tool", "fc-reattach"));
      first.message(responseDone("resp-tool"));
      await flushAsync();
      expect(control.ledger.onboarding!.lifecycle.toolOutbox["fc-reattach"]?.state)
        .toBe("executed");
      expect(control.ledger.toolLog).toHaveLength(1);
      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const resent = functionOutputs(second);
      expect(resent).toHaveLength(1);
      expect(resent[0].item).toMatchObject({
        id: "tool-output:fc-reattach", call_id: "fc-reattach",
      });
      expect(control.ledger.onboarding!.lifecycle.toolOutbox["fc-reattach"]?.state)
        .toBe("output_pending");
      expect(control.ledger.toolLog).toHaveLength(1);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("socket loss during persistence retains the executed result for the new generation", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-mid-persist-reattach");
    let resolvePersistence!: (value: { data: unknown; error: null }) => void;
    let persistenceCalls = 0;
    _setClient({
      from(table: string) {
        const query: any = {
          select() { return query; }, eq() { return query; }, order() { return query; },
          limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: table === "receipts" ? [] : [], error: null,
            }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string) {
        if (name !== "record_onboarding_answer")
          return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
        persistenceCalls += 1;
        return new Promise((resolve) => { resolvePersistence = resolve; });
      },
    } as any);
    try {
      const control = attachSideband(
        cap, "rtc-mid-persist-reattach", "gpt-realtime-2.1",
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      first.message(responseCreated("resp-greeting", `greeting:${cap.callId}`));
      first.message(responseDone("resp-greeting"));
      await flushAsync();
      first.message(responseCreated("resp-persist"));
      first.message(functionCallDone(
        "resp-persist",
        "fc-mid-persist",
        "record_interview_answer",
        JSON.stringify({
          topic: "area",
          field: "area.coverage",
          disposition: "answered",
          rule_text: "Atende Irvine.",
          structured: { value: ["Irvine"] },
          owner_words: "Atendemos Irvine.",
        }),
      ));
      first.message(responseDone("resp-persist"));
      await flushAsync();
      expect(persistenceCalls).toBe(1);

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      resolvePersistence({
        data: {
          status: "recorded",
          rule_id: "rule-mid-persist",
          rule_group_id: "group-mid-persist",
          coverage_receipt_id: "receipt-mid-persist",
          revision: 1,
          snapshot_digest: "a".repeat(64),
          complete: false,
          missing: [],
          ambiguous: [],
          next_action: {
            type: "ask",
            field: "service.catalog_closure",
            question_pt: "Esses são todos os serviços?",
          },
          coverage: {},
        },
        error: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(persistenceCalls).toBe(1);
      expect(control.ledger.onboarding!.lifecycle.toolOutbox["fc-mid-persist"]?.state)
        .toBe("output_pending");
      expect(functionOutputs(second)).toHaveLength(1);
      expect(functionOutputs(second)[0].item.id)
        .toBe("tool-output:fc-mid-persist");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("final playback arriving after sideband reattach still enters the single hangup path", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-final-close-reattach");
    try {
      const control = attachSideband(
        cap, "rtc-final-close-reattach", "gpt-realtime-2.1",
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      const lifecycle = control.ledger.onboarding!.lifecycle;
      const digest = "f".repeat(64);
      lifecycle.phase = "final_signoff_speaking";
      lifecycle.coverage = {
        revision: 9, digest, complete: true, missing: [], ambiguous: [],
      };
      lifecycle.preparedSnapshotDigests = [digest];
      lifecycle.approval = {
        toolCallId: "approval-tool-final",
        approvalReceiptId: "approval-receipt-final",
        coverageReceiptId: "coverage-receipt-final",
        revision: 9,
        digest,
      };
      lifecycle.signoff = {
        approvalReceiptId: "approval-receipt-final",
        responseId: "resp-final-reattach",
        audioDone: true,
        responseDone: true,
        playbackStopped: false,
        interrupted: false,
      };
      delete lifecycle.activeResponseId;
      control.ledger.responseActive = false;

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      second.suppressCloseEvent = true;
      second.message({
        type: "output_audio_buffer.stopped",
        response_id: "resp-final-reattach",
      });
      await flushAsync();

      expect(control.ledger.status).toBe("ended");
      expect(control.ledger.agentEnded).toBe(true);
      expect(control.ledger.onboarding!.pendingHangupIntentKey)
        .toBe("hangup:approval-receipt-final");
      expect(control.ledger.onboarding!.lifecycle.requestedHangupKeys)
        .toEqual(["hangup:approval-receipt-final"]);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });
});

test("end_session is application-owned in onboarding and unavailable to customers", async () => {
  const onboarding = await runTool(onboardingCap(), "end_session", {});
  expect(onboarding).toMatchObject({
    ok: true, body: { status: "application_owned_close", ending: false },
  });
  const customer = await runTool(customerCap(), "end_session", {});
  expect(customer).toMatchObject({
    ok: false, body: { error: "tool_not_allowed" },
  });
});

test("agent-requested termination uses the audited provider path; caller end does not", async () => {
  const rows: any[] = [];
  _setClient({
    from(table: string) {
      const api: any = {
        update(row: any) { if (table === "calls") rows.push(row); return api; },
        eq() { return api; }, insert() { return api; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc() { return Promise.resolve({ data: "reservation-1", error: null }); },
  } as any);
  const cap = onboardingCap();
  const agentEnded = ledger(cap.callId);
  agentEnded.status = "ended";
  agentEnded.agentEnded = true;
  await persistLedger(cap, agentEnded, async () => new Response(null, { status: 200 }));
  const callerEnded = ledger(cap.callId);
  callerEnded.status = "ended";
  await persistLedger(cap, callerEnded, async () => new Response(null, { status: 200 }));
  expect(rows[0]).toMatchObject({
    provider_termination_state: "active",
    provider_termination_reason: "agent_ended_session",
  });
  expect(rows[1]).toMatchObject({
    provider_termination_state: "confirmed",
    provider_termination_reason: "caller_hung_up",
  });
});

afterAll(() => _setClient(null));
