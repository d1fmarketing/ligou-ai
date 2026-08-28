// Task 5 integration: sideband is a serialized transport adapter for the pure
// onboarding reducer. Valid legacy transport/reconnect/provider invariants stay;
// recap-character, watchdog, refusal-count and close-grace assertions are replaced
// with exact Realtime response/audio/playback evidence.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import {
  applyCoverageFact,
  canonicalizeLocalityInput,
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
import { hashOnboardingToolArgs } from "../src/onboarding-coordinator.ts";
import { makeCapability, runTool, type Capability } from "../src/tools.ts";

const ownerId = "owner-1";
const onboardingOptions = {
  onboarding: { expectedBusinessName: "Rocha Plumbing" },
};

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
    expectedOnboardingBusinessName: "Rocha Plumbing",
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

function test9ServiceFacts(ownerWords: string) {
  return [
    {
      topic: "servicos",
      field: "service.name_synonyms",
      subject: "desentupimento",
      disposition: "answered",
      rule_text: "Oferece desentupimento.",
      structured: { value: ["desentupimento"] },
      owner_words: ownerWords,
    },
    {
      topic: "servicos",
      field: "service.name_synonyms",
      subject: "conserto_de_vazamento",
      disposition: "answered",
      rule_text: "Oferece conserto de vazamento.",
      structured: { value: ["conserto de vazamento"] },
      owner_words: ownerWords,
    },
    {
      topic: "servicos",
      field: "service.name_synonyms",
      subject: "diagnostico_hidraulico",
      disposition: "answered",
      rule_text: "Oferece diagnóstico hidráulico.",
      structured: { value: ["diagnóstico hidráulico"] },
      owner_words: ownerWords,
    },
    {
      topic: "servicos",
      field: "service.catalog_closure",
      disposition: "answered",
      rule_text: "O catálogo tem somente os três serviços informados.",
      structured: { value: true },
      owner_words: ownerWords,
    },
  ];
}

function outputAck(l: SessionLedger, toolCallIdOrOutputItemId: string) {
  const receipts = l.onboarding?.lifecycle.toolOutbox ?? {};
  const receipt = receipts[toolCallIdOrOutputItemId] ??
    Object.values(receipts).find(
      (candidate) => candidate.outputItemId === toolCallIdOrOutputItemId,
    );
  if (!receipt?.output)
    throw new Error(`missing output receipt ${toolCallIdOrOutputItemId}`);
  return exactCreatedOutput(
    receipt.outputItemId,
    receipt.toolCallId,
    receipt.output,
  );
}

function exactCreatedOutput(
  outputItemId: string,
  toolCallId: string,
  output: string,
) {
  return {
    type: "conversation.item.created",
    item: {
      id: outputItemId,
      type: "function_call_output",
      call_id: toolCallId,
      output,
    },
  };
}

function outputRetrieved(
  outputItemId: string,
  toolCallId: string,
  output: string,
) {
  return {
    type: "conversation.item.retrieved",
    event_id: `server-event:${outputItemId}`,
    item: {
      id: outputItemId,
      type: "function_call_output",
      call_id: toolCallId,
      output,
    },
  };
}

async function completeGreetingTrace(
  cap: Capability,
  l: SessionLedger,
  ws: ReturnType<typeof socket>,
  responseId = "resp-bootstrap",
) {
  await handleEvent(cap, l, ws as any, { type: "session.created" });
  const lifecycle = l.onboarding!.lifecycle;
  const intentKey = `greeting:${cap.callId}`;
  lifecycle.responseIntents[intentKey] = {
    intentKey,
    purpose: "greeting",
    state: "sent",
  };
  await handleEvent(
    cap,
    l,
    ws as any,
    responseCreated(responseId, intentKey),
  );
  await handleEvent(cap, l, ws as any, {
    type: "response.output_audio_transcript.done",
    response_id: responseId,
    transcript:
      "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
  });
  await handleEvent(cap, l, ws as any, {
    type: "response.output_audio.done",
    response_id: responseId,
  });
  await handleEvent(cap, l, ws as any, responseDone(responseId));
  await handleEvent(cap, l, ws as any, {
    type: "output_audio_buffer.stopped",
    response_id: responseId,
  });
  expect(l.onboarding!.lifecycle.phase).toBe("collecting");
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
    await completeGreetingTrace(cap, l, ws);
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
    l.onboarding!.pendingCallerTurns = [{
      turnId: "turn-vad-cancelled",
      transcriptCompleted: true,
    }];

    await handleEvent(cap, l, ws as any, responseCreated("resp-vad-cancelled"));
    expect(l.onboarding!.pendingCallerTurns[0]?.responseId)
      .toBe("resp-vad-cancelled");
    await handleEvent(cap, l, ws as any, {
      type: "response.done",
      response: { id: "resp-vad-cancelled", status: "cancelled" },
    });
    expect(l.onboarding!.lifecycle.phase).toBe("summary_speaking");
    expect(l.onboarding!.speechPending).toBe(true);
    expect(l.onboarding!.pendingCallerTurns[0]?.responseId).toBeUndefined();
    expect(l.onboarding!.lifecycle.terminalResponseIds)
      .toContain("resp-vad-cancelled");
    expect(framesOfType(ws, "response.create")).toHaveLength(0);

    await handleEvent(cap, l, ws as any, responseCreated("resp-vad-rebound"));
    expect(l.onboarding!.pendingCallerTurns[0]?.responseId)
      .toBe("resp-vad-rebound");
    await handleEvent(cap, l, ws as any, responseDone("resp-vad-rebound"));
    expect(l.onboarding!.speechPending).toBe(false);
    expect(l.onboarding!.pendingCallerTurns).toEqual([]);
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
        "resp-item-status", "fc-item-status", "end_session", "{}", 0,
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
      functionCallDone("resp-index-duplicate", "fc-index-a", "end_session", "{}", 3));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-index-duplicate", "fc-index-b", "end_session", "{}", 3));
    await handleEvent(cap, l, ws as any, responseDone("resp-index-duplicate"));
    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(l.toolLog).toEqual([]);
    expect(functionOutputs(ws)).toEqual([]);
  });

  test("a malformed second member blocks the complete ordered batch before the valid first member has any effect", async () => {
    const cap = onboardingCap("call-malformed-member-preflight");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 1, digest: "1".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    const valid = {
      topic: "area",
      field: "area.coverage",
      disposition: "answered",
      rule_text: "Atende Irvine.",
      structured: {
        value: {
          localities: [{
            display_name: "Irvine",
            country_code: "US",
            region_code: "CA",
          }],
        },
      },
      owner_words: "Atendemos Irvine.",
    };

    await handleEvent(cap, l, ws as any, responseCreated("resp-atomic"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-atomic",
      "fc-valid-first",
      "record_interview_answer",
      JSON.stringify(valid),
      0,
    ));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-atomic",
      "fc-malformed-second",
      "record_interview_answer",
      '{"topic":"area"',
      1,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-atomic"));

    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(boundary.rpcFacts).toEqual([]);
    expect(l.toolLog).toEqual([]);
    expect(functionOutputs(ws)).toEqual([]);
    expect(l.onboarding!.lifecycle.toolOutbox).toEqual({});
    expect(l.onboarding!.lifecycle.toolBatches).toEqual({});
  });

  test("schema, capability, and JSON-object admission validate every member before the first effect", async () => {
    const valid = {
      topic: "area",
      field: "area.coverage",
      disposition: "answered",
      rule_text: "Atende Irvine.",
      structured: {
        value: {
          localities: [{
            display_name: "Irvine",
            country_code: "US",
            region_code: "CA",
          }],
        },
      },
      owner_words: "Atendemos Irvine.",
    };
    const invalidMembers = [
      {
        name: "quote_price",
        args: JSON.stringify({ service_type: "drain_cleaning" }),
      },
      {
        name: "record_interview_answer",
        args: JSON.stringify({
          topic: "area",
          field: "area.coverage",
          disposition: "answered",
          rule_text: "Atende Irvine.",
          owner_words: "Atendemos Irvine.",
        }),
      },
      { name: "record_interview_answer", args: "null" },
    ];
    for (const [index, invalid] of invalidMembers.entries()) {
      const cap = onboardingCap(`call-complete-preflight-${index}`);
      const boundary = sequentialAnswerBoundary([
        { status: "recorded", revision: 1, digest: "1".repeat(64) },
      ]);
      _setClient(boundary.client);
      const l = ledger(cap.callId);
      const ws = socket();
      await completeGreetingTrace(cap, l, ws);
      const responseId = `resp-complete-preflight-${index}`;
      await handleEvent(cap, l, ws as any, responseCreated(responseId));
      await handleEvent(cap, l, ws as any, functionCallDone(
        responseId,
        `fc-valid-${index}`,
        "record_interview_answer",
        JSON.stringify(valid),
        0,
      ));
      await handleEvent(cap, l, ws as any, functionCallDone(
        responseId,
        `fc-invalid-${index}`,
        invalid.name,
        invalid.args,
        1,
      ));
      await handleEvent(cap, l, ws as any, responseDone(responseId));

      expect(l.onboarding!.lifecycle.phase).toBe("blocked");
      expect(boundary.rpcFacts).toEqual([]);
      expect(l.toolLog).toEqual([]);
      expect(functionOutputs(ws)).toEqual([]);
      expect(l.onboarding!.lifecycle.toolOutbox).toEqual({});
      expect(l.onboarding!.lifecycle.toolBatches).toEqual({});
    }
  });

  test("expired or owner-unbound onboarding capability blocks the complete batch before its first effect", async () => {
    const fact = {
      topic: "area",
      field: "area.coverage",
      disposition: "answered",
      rule_text: "Atende Irvine.",
      structured: {
        value: {
          localities: [{
            display_name: "Irvine",
            country_code: "US",
            region_code: "CA",
          }],
        },
      },
      owner_words: "Atendemos Irvine.",
    };
    for (const [index, invalidate] of [
      (cap: Capability) => { cap.expiresAt = Date.now() - 1; },
      (cap: Capability) => { delete cap.ownerUserId; },
    ].entries()) {
      const cap = onboardingCap(`call-capability-preflight-${index}`);
      const boundary = sequentialAnswerBoundary([
        { status: "recorded", revision: 1, digest: "1".repeat(64) },
      ]);
      _setClient(boundary.client);
      const l = ledger(cap.callId);
      const ws = socket();
      await completeGreetingTrace(cap, l, ws);
      invalidate(cap);
      const responseId = `resp-capability-preflight-${index}`;
      await handleEvent(cap, l, ws as any, responseCreated(responseId));
      await handleEvent(cap, l, ws as any, functionCallDone(
        responseId,
        `fc-capability-fact-${index}`,
        "record_interview_answer",
        JSON.stringify(fact),
        0,
      ));
      await handleEvent(cap, l, ws as any, functionCallDone(
        responseId,
        `fc-capability-close-${index}`,
        "end_session",
        "{}",
        1,
      ));
      await handleEvent(cap, l, ws as any, responseDone(responseId));

      expect(l.onboarding!.lifecycle.phase).toBe("blocked");
      expect(boundary.rpcFacts).toEqual([]);
      expect(l.toolLog).toEqual([]);
      expect(functionOutputs(ws)).toEqual([]);
      expect(l.onboarding!.lifecycle.toolOutbox).toEqual({});
      expect(l.onboarding!.lifecycle.toolBatches).toEqual({});
    }
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
    await completeGreetingTrace(cap, l, ws);
    await handleEvent(cap, l, ws as any, responseCreated("resp-tools"));
    const first = handleEvent(
      cap, l, ws as any,
      functionCallDone("resp-tools", "fc-z", "end_session", JSON.stringify({ z: 2, a: 1 }), 9),
    );
    const second = handleEvent(
      cap, l, ws as any,
      functionCallDone("resp-tools", "fc-a", "end_session", JSON.stringify({ b: true }), 2),
    );
    const terminal = handleEvent(cap, l, ws as any, responseDone("resp-tools"));
    await Promise.all([first, second, terminal]);
    expect(functionOutputs(ws).map((frame) => frame.item)).toEqual([
      expect.objectContaining({
        id: l.onboarding!.lifecycle.toolOutbox["fc-a"]?.outputItemId,
        call_id: "fc-a",
      }),
      expect.objectContaining({
        id: l.onboarding!.lifecycle.toolOutbox["fc-z"]?.outputItemId,
        call_id: "fc-z",
      }),
    ]);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-z"]?.state).toBe("output_pending");
    expect(l.onboarding!.lifecycle.toolOutbox["fc-a"]?.state).toBe("output_pending");
    const batches = Object.values(l.onboarding!.lifecycle.toolBatches);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      providerResponseId: "resp-tools", toolCallIds: ["fc-a", "fc-z"],
    });
    expect(batches[0]!.batchHash).toMatch(/^[a-f0-9]{64}$/);
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-z"));
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-a"));
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
      functionCallDone("resp-tools", "fc-z", "end_session", JSON.stringify({ a: 1, z: 2 }), 9));
    await handleEvent(replayCap, replayLedger, replaySocket as any,
      functionCallDone("resp-tools", "fc-a", "end_session", JSON.stringify({ b: true }), 2));
    await handleEvent(replayCap, replayLedger, replaySocket as any, responseDone("resp-tools"));
    expect(Object.values(replayLedger.onboarding!.lifecycle.toolBatches)[0]!.batchHash)
      .toBe(batches[0]!.batchHash);
  });

  test("GA added→done acknowledges exact function output once while legacy created remains compatible", async () => {
    const makePending = async (
      callId: string,
      delivery: "create" | "retrieve",
    ) => {
      const cap = onboardingCap(callId);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, { type: "session.created" });
      const adapter = l.onboarding!;
      adapter.lifecycle.phase = "collecting";
      adapter.lifecycle.socketGeneration = 1;
      adapter.lifecycle.toolOutbox["call_0123456789abcdef"] = {
        toolCallId: "call_0123456789abcdef",
        toolName: "end_session",
        argsHash: "created-args",
        state: "output_pending",
        providerResponseId: "created-response",
        batchHash: "created-batch",
        output: "{\"status\":\"application_owned_close\"}",
        resultHash: "created-result",
        outputItemId: "tlo-f04070b5629817764d00825d4e17",
        socketGeneration: 1,
        outputRequest: {
          delivery,
          eventId: `created-${delivery}-event`,
          socketGeneration: 1,
        },
      };
      return { cap, l, ws, adapter };
    };

    const ga = await makePending("call-done-exact", "create");
    await handleEvent(
      ga.cap,
      ga.l,
      ga.ws as any,
      {
        ...exactCreatedOutput(
          "tlo-f04070b5629817764d00825d4e17",
          "call_0123456789abcdef",
          "{\"status\":\"application_owned_close\"}",
        ),
        type: "conversation.item.added",
      },
    );
    expect(ga.adapter.lifecycle.toolOutbox["call_0123456789abcdef"]?.state)
      .toBe("output_pending");
    const done = {
      ...exactCreatedOutput(
        "tlo-f04070b5629817764d00825d4e17",
        "call_0123456789abcdef",
        "{\"status\":\"application_owned_close\"}",
      ),
      type: "conversation.item.done",
    };
    await handleEvent(ga.cap, ga.l, ga.ws as any, done);
    await handleEvent(ga.cap, ga.l, ga.ws as any, done);
    expect(ga.adapter.lifecycle.toolOutbox["call_0123456789abcdef"]?.state)
      .toBe("output_acked");

    const legacy = await makePending("call-created-legacy", "create");
    await handleEvent(
      legacy.cap,
      legacy.l,
      legacy.ws as any,
      exactCreatedOutput(
        "tlo-f04070b5629817764d00825d4e17",
        "call_0123456789abcdef",
        "{\"status\":\"application_owned_close\"}",
      ),
    );
    expect(legacy.adapter.lifecycle.toolOutbox["call_0123456789abcdef"]?.state)
      .toBe("output_acked");

    const mismatch = await makePending("call-created-mismatch", "create");
    await handleEvent(
      mismatch.cap,
      mismatch.l,
      mismatch.ws as any,
      {
        ...exactCreatedOutput(
          "tlo-f04070b5629817764d00825d4e17",
          "call_0123456789abcdef",
          "{\"status\":\"attacker_changed\"}",
        ),
        type: "conversation.item.done",
      },
    );
    expect(mismatch.adapter.lifecycle.phase).toBe("blocked");
    expect(mismatch.adapter.lifecycle.toolOutbox["call_0123456789abcdef"]?.state)
      .toBe("output_pending");

    const retrieving = await makePending("call-created-during-retrieve", "retrieve");
    await handleEvent(
      retrieving.cap,
      retrieving.l,
      retrieving.ws as any,
      {
        ...exactCreatedOutput(
          "tlo-f04070b5629817764d00825d4e17",
          "call_0123456789abcdef",
          "{\"status\":\"application_owned_close\"}",
        ),
        type: "conversation.item.done",
      },
    );
    expect(retrieving.adapter.lifecycle.phase).toBe("collecting");
    expect(retrieving.adapter.lifecycle.toolOutbox["call_0123456789abcdef"]?.state)
      .toBe("output_pending");
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
    await completeGreetingTrace(cap, l, ws);
    const firstArgs = {
      topic: "area", field: "area.coverage", disposition: "answered",
      rule_text: "FIRST authoritative correction.",
      structured: { value: { localities: [{ display_name: "Irvine", country_code: "US", region_code: "CA" }] } }, owner_words: "Primeiro Irvine.",
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
      { status: "recorded", revision: 4, digest: "4".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    const nextQuestion = {
      field: "service.catalog_closure",
      questionPt: "Esses são todos os serviços?",
    };
    l.onboarding!.lifecycle.coverage = {
      revision: 2,
      digest: "2".repeat(64),
      complete: false,
      missing: [{ field: "service.catalog_closure" }],
      ambiguous: [],
      nextQuestion,
    };
    boundary.seedCoverage(cap, 2, "2".repeat(64), nextQuestion);
    const reusedArgs = {
      topic: "area", field: "area.coverage", disposition: "answered",
      rule_text: "Serve Irvine.", structured: { value: { localities: [{ display_name: "Irvine", country_code: "US", region_code: "CA" }] } },
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
      outputAck(l, "fc-reused-new-provider-id"));
    expect(l.onboarding!.lifecycle.toolOutbox["fc-reused-new-provider-id"]?.state)
      .toBe("output_acked");

    await handleEvent(cap, l, ws as any, responseCreated("resp-advance"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-advance", "fc-real-advance", "record_interview_answer",
      JSON.stringify({ ...reusedArgs, rule_text: "Serve Irvine e Anaheim." }), 0,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-advance"));
    expect(l.onboarding!.lifecycle.coverage).toMatchObject({
      revision: 4, digest: "4".repeat(64),
    });
  });

  test("a same-semantic direct negotiation repair persists the corrected floor through the tool outbox", async () => {
    const cap = onboardingCap("call-direct-negotiation-repair");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 5, digest: "5".repeat(64) },
    ]);
    _setClient(boundary.client);
    const subject = "drain_cleaning";
    const snapshot = {
      ...createCoverage({ tenantId: cap.tenantId, callId: cap.callId }),
      revision: 4,
      services: [subject],
      currentSubject: subject,
      cells: {
        [`service:${subject}:service.price_target`]: {
          state: "answered" as const,
          attempts: 2,
          value: 149,
        },
        [`service:${subject}:service.negotiation`]: {
          state: "answered" as const,
          attempts: 1,
          value: { mode: "non_negotiable", floor: 100 },
        },
      },
    };
    const nextQuestion = {
      field: "service.negotiation",
      subject,
      questionPt: "O preço é negociável?",
    };
    boundary.seedSnapshot(cap, snapshot, "4".repeat(64), nextQuestion);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    l.onboarding!.lifecycle.phase = "collecting";
    l.onboarding!.lifecycle.coverage = {
      revision: 4,
      digest: "4".repeat(64),
      complete: false,
      missing: [{ field: "service.negotiation", subject }],
      ambiguous: [],
      nextQuestion,
    };
    await handleEvent(cap, l, ws as any, responseCreated("resp-neg-repair"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-neg-repair",
      "fc-neg-repair",
      "record_interview_answer",
      JSON.stringify({
        topic: "precos",
        field: "service.negotiation",
        subject,
        disposition: "answered",
        rule_text: "Preço não negociável.",
        structured: { value: "non_negotiable" },
        owner_words: "O preço não é negociável.",
      }),
      0,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-neg-repair"));
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(JSON.parse(functionOutputs(ws).at(-1)!.item.output).status)
      .toBe("recorded");
    expect((boundary.rpcCoverages[0] as any).snapshot.cells[
      `service:${subject}:service.negotiation`
    ]).toMatchObject({
      attempts: 2,
      value: { mode: "non_negotiable", floor: 149 },
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      outputAck(l, "fc-neg-repair"),
    );
    expect(l.onboarding!.lifecycle.toolOutbox["fc-neg-repair"]?.state)
      .toBe("output_acked");
  });

  test("coverage correction drops queued old signoff command and ignores its late response", async () => {
    const cap = onboardingCap("call-stale-signoff-command");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 2, digest: "b".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
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
    await completeGreetingTrace(cap, l, ws);
    const item = functionCallDone(
      "resp-dup", "fc-dup", "end_session", JSON.stringify({ one: 1 }),
    );
    await handleEvent(cap, l, ws as any, responseCreated("resp-dup"));
    await handleEvent(cap, l, ws as any, item);
    await handleEvent(cap, l, ws as any, item);
    await handleEvent(cap, l, ws as any, responseDone("resp-dup"));
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(l.toolLog).toHaveLength(0);
    expect(Object.keys(l.onboarding!.lifecycle.toolOutbox)).toEqual(["fc-dup"]);
    expect(Object.values(l.onboarding!.lifecycle.toolOutbox)).toHaveLength(1);
  });

  test("same provider call_id with changed payload blocks before any tool execution", async () => {
    const cap = onboardingCap();
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, responseCreated("resp-mismatch"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-mismatch", "fc-mismatch", "end_session", JSON.stringify({ value: 1 })));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-mismatch", "fc-mismatch", "end_session", JSON.stringify({ value: 2 })));
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
      functionCallDone("resp-original", "fc-reused", "end_session", JSON.stringify({ value: 1 }), 1));
    await handleEvent(cap, l, ws as any, responseDone("resp-original"));
    const outputsBefore = functionOutputs(ws).length;
    const toolsBefore = l.toolLog.length;

    await handleEvent(cap, l, ws as any, responseCreated("resp-changed"));
    await handleEvent(cap, l, ws as any,
      functionCallDone("resp-changed", "fc-reused", "end_session", JSON.stringify({ value: 2 }), 1));
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
          structured: { value: { localities: [{ display_name: "Irvine", country_code: "US", region_code: "CA" }] } },
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
          structured: { value: { localities: [{
            display_name: "Anaheim",
            country_code: "US",
            region_code: "CA",
          }] } },
          owner_words: "Também não deve persistir.",
        }),
        0,
      ));
    await handleEvent(cap, l, ws as any, responseDone("resp-after-block"));
    expect(l.toolLog).toHaveLength(toolsBefore);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-after-block"]).toBeUndefined();
    expect(boundary.rpcFacts).toEqual([]);
  });

  test("a pruned terminal response identity cannot reopen with a new tool batch", async () => {
    const cap = onboardingCap("call-pruned-terminal-reopen");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 1, digest: "1".repeat(64) },
    ]);
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    const responseId = "resp-terminal-before-prune";
    await handleEvent(cap, l, ws as any, responseCreated(responseId));
    await handleEvent(cap, l, ws as any, responseDone(responseId));
    expect(l.onboarding!.lifecycle.terminalResponseIds).toContain(responseId);

    l.onboarding!.responses = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `terminal-buffer-${index}`,
        {
          responseId: `terminal-buffer-${index}`,
          tools: [],
          terminal: true,
        },
      ]),
    );
    await handleEvent(cap, l, ws as any, responseDone("resp-prune-trigger"));
    expect(l.onboarding!.responses[responseId]).toBeUndefined();

    const fact = {
      topic: "area",
      field: "area.coverage",
      disposition: "answered",
      rule_text: "Atende Irvine.",
      structured: {
        value: {
          localities: [{
            display_name: "Irvine",
            country_code: "US",
            region_code: "CA",
          }],
        },
      },
      owner_words: "Atendemos Irvine.",
    };
    await handleEvent(cap, l, ws as any, responseCreated(responseId));
    await handleEvent(cap, l, ws as any, functionCallDone(
      responseId,
      "fc-reopened-terminal",
      "record_interview_answer",
      JSON.stringify(fact),
      0,
    ));
    await handleEvent(cap, l, ws as any, responseDone(responseId));

    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(boundary.rpcFacts).toEqual([]);
    expect(l.toolLog).toEqual([]);
    expect(functionOutputs(ws).filter((frame) =>
      frame.item?.call_id === "fc-reopened-terminal"
    )).toEqual([]);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-reopened-terminal"])
      .toBeUndefined();
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
      outputAck(pendingLedger, "fc-pending-overflow"));
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
      await handleEvent(cap, l, ws as any, outputAck(l, String(toolCallId)));
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
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-close"));

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

  test("barge-in finds terminal authority speech still awaiting playback and queues its retry behind the caller VAD turn", async () => {
    const cap = onboardingCap("call-summary-playback-barge-in");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });
    const adapter = l.onboarding!;
    const digest = "e".repeat(64);
    adapter.lifecycle.phase = "summary_speaking";
    adapter.lifecycle.socketGeneration = 1;
    adapter.lifecycle.coverage = {
      revision: 4,
      digest,
      complete: true,
      missing: [],
      ambiguous: [],
    };
    adapter.lifecycle.preparedSnapshotDigests = [digest];
    adapter.lifecycle.summary = {
      receiptId: "coverage-summary-barge-in",
      revision: 4,
      digest,
      requiredAnchors: ["Área: Irvine"],
      responseId: "response-summary-awaiting-playback",
      transcript: "Área: Irvine. Você confirma que tudo está correto?",
      transcriptFinal: true,
      audioDone: true,
      responseDone: true,
      playbackStopped: false,
      interrupted: false,
      validated: true,
      attempt: 0,
    };
    adapter.lifecycle.responseIntents[`summary:${digest}`] = {
      intentKey: `summary:${digest}`,
      purpose: "summary",
      state: "terminal",
      responseId: "response-summary-awaiting-playback",
      sentSocketGeneration: 1,
    };
    adapter.lifecycle.terminalResponseIds.push(
      "response-summary-awaiting-playback",
    );
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "caller-summary-barge-in",
    });

    expect(adapter.lifecycle.summary).toMatchObject({
      attempt: 1,
      interrupted: false,
    });
    expect(adapter.lifecycle.summary?.responseId).toBeUndefined();
    expect(adapter.lifecycle.responseIntents[`summary:${digest}:retry:1`])
      .toMatchObject({ state: "queued", purpose: "summary" });
    expect(adapter.pendingResponseCommands[`summary:${digest}:retry:1`])
      .toBeDefined();
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
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
      "area.coverage": { localities: [canonicalizeLocalityInput({
        display_name: "Irvine", country_code: "US", region_code: "CA",
      })!] },
      "schedule.business_hours": {
        days: ["mon", "tue", "wed", "thu", "fri"],
        hours: { opens: "08:00", closes: "18:00" },
      },
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
  options: {
    approvalChanged?: boolean;
    approvalSuccess?: boolean;
    approvalAmbiguousAttempts?: number;
  } = {},
) {
  const ruleId = receipt.readback.selected_rule_ids[0]!;
  const calls = {
    receiptReads: 0,
    ruleReads: 0,
    rpc: [] as string[],
    rpcArgs: [] as Array<{ name: string; args?: Record<string, unknown> }>,
  };
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
      rpc(name: string, args?: Record<string, unknown>) {
        calls.rpc.push(name);
        calls.rpcArgs.push({ name, args });
        const approvalAttempt = calls.rpc.filter((candidate) =>
          candidate === "record_onboarding_voice_approval"
        ).length;
        if (
          name === "record_onboarding_voice_approval" &&
          approvalAttempt <= (options.approvalAmbiguousAttempts ?? 0)
        )
          return Promise.resolve({
            data: null, error: { message: "network socket closed" },
          });
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
}>, options: {
  followupAmbiguousAttempts?: number;
  responseFromProjection?: boolean;
} = {}) {
  const rpcFacts: Array<Record<string, unknown>> = [];
  const rpcCoverages: Array<Record<string, unknown>> = [];
  let followupRpcCalls = 0;
  let receiptRows: Array<{ id: string; readback: Record<string, unknown> }> = [];
  let resultIndex = 0;
  return {
    rpcFacts,
    rpcCoverages,
    get followupRpcCalls() { return followupRpcCalls; },
    seedCoverage(
      cap: Capability,
      revision: number,
      digest: string,
      nextQuestion: { field: string; subject?: string; questionPt: string },
    ) {
      receiptRows = [{
        id: `seed-receipt-${revision}`,
        readback: {
          schema_version: 1,
          tenant_id: cap.tenantId,
          call_id: cap.callId,
          revision,
          complete: false,
          snapshot: {
            ...createCoverage({ tenantId: cap.tenantId, callId: cap.callId }),
            revision,
          },
          progress: {
            missingRequired: [{
              field: nextQuestion.field,
              ...(nextQuestion.subject ? { subject: nextQuestion.subject } : {}),
            }],
            ambiguous: [],
          },
          selected_rule_ids: [],
          next_action: {
            type: "ask",
            field: nextQuestion.field,
            ...(nextQuestion.subject ? { subject: nextQuestion.subject } : {}),
            question_pt: nextQuestion.questionPt,
          },
          snapshot_digest: digest,
          authority: {
            rules_approved: false,
            powers_granted: false,
            operational_mode_changed: false,
          },
        },
      }];
    },
    seedSnapshot(
      cap: Capability,
      snapshot: CoverageSnapshot,
      digest: string,
      nextQuestion: { field: string; subject?: string; questionPt: string },
    ) {
      receiptRows = [{
        id: `seed-receipt-${snapshot.revision}`,
        readback: {
          schema_version: 2,
          transition_kind: "answer",
          tenant_id: cap.tenantId,
          call_id: cap.callId,
          revision: snapshot.revision,
          complete: false,
          snapshot,
          progress: {
            missingRequired: [{
              field: nextQuestion.field,
              ...(nextQuestion.subject ? { subject: nextQuestion.subject } : {}),
            }],
            ambiguous: [],
          },
          selected_rule_ids: [],
          current_answer_hashes: {},
          materializations: [],
          summary_projection: null,
          summary_hash: null,
          next_action: {
            type: "ask",
            field: nextQuestion.field,
            ...(nextQuestion.subject ? { subject: nextQuestion.subject } : {}),
            question_pt: nextQuestion.questionPt,
          },
          snapshot_digest: digest,
          authority: {
            rules_approved: false,
            powers_granted: false,
            operational_mode_changed: false,
          },
        },
      }];
    },
    client: {
      from(table: string) {
        const query: any = {
          select() { return query; }, eq() { return query; }, order() { return query; },
          in() { return query; },
          limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: table === "receipts" ? receiptRows : [], error: null,
            }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string, args: Record<string, unknown>) {
        if (name === "record_onboarding_followup") {
          followupRpcCalls += 1;
          if (
            followupRpcCalls <= (options.followupAmbiguousAttempts ?? 0)
          )
            return Promise.resolve({
              data: null, error: { message: "network socket closed" },
            });
          const coverage = structuredClone(
            args.p_coverage as Record<string, unknown>,
          );
          const revision = Number(args.p_expected_revision) + 1;
          const digest = String(revision).slice(-1).repeat(64);
          receiptRows = [{
            id: `followup-receipt-${revision}`,
            readback: {
              ...coverage,
              revision,
              snapshot_digest: digest,
            },
          }];
          return Promise.resolve({
            data: {
              status: "recorded",
              coverage_receipt_id: `followup-receipt-${revision}`,
              revision,
              snapshot_digest: digest,
              complete: false,
              missing: (coverage.progress as any)?.missingRequired ?? [],
              ambiguous: (coverage.progress as any)?.ambiguous ?? [],
              next_action: coverage.next_action,
              coverage: receiptRows[0]!.readback,
            },
            error: null,
          });
        }
        if (name !== "record_onboarding_answer")
          return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
        rpcFacts.push(args.p_fact as Record<string, unknown>);
        rpcCoverages.push(args.p_coverage as Record<string, unknown>);
        const next = results[Math.min(resultIndex, results.length - 1)]!;
        resultIndex += 1;
        const projectedCoverage = args.p_coverage as Record<string, unknown>;
        const projectedProgress = projectedCoverage.progress as
          | Record<string, unknown>
          | undefined;
        const response = {
            status: next.status,
            rule_id: `rule-${resultIndex}`,
            rule_group_id: `group-${resultIndex}`,
            coverage_receipt_id: `receipt-${next.revision}`,
            revision: next.revision,
            snapshot_digest: next.digest,
            complete: false,
            missing: options.responseFromProjection &&
                Array.isArray(projectedProgress?.missingRequired)
              ? projectedProgress.missingRequired
              : [],
            ambiguous: options.responseFromProjection &&
                Array.isArray(projectedProgress?.ambiguous)
              ? projectedProgress.ambiguous
              : [],
            next_action: options.responseFromProjection
              ? projectedCoverage.next_action
              : {
                  type: "ask",
                  field: "service.catalog_closure",
                  question_pt: "Esses são todos os serviços?",
                },
            coverage: {},
        };
        if (next.status === "recorded") {
          const coverage = structuredClone(
            args.p_coverage as Record<string, unknown>,
          );
          coverage.revision = next.revision;
          if (coverage.snapshot && typeof coverage.snapshot === "object")
            (coverage.snapshot as Record<string, unknown>).revision = next.revision;
          coverage.snapshot_digest = next.digest;
          response.coverage = coverage;
          receiptRows = [{
            id: `receipt-${next.revision}`,
            readback: coverage,
          }];
        }
        return Promise.resolve({
          data: response,
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
            if (table === "onboarding_locality_registry")
              return resolve({
                data: [{
                  locality_id: "loc_4bc5a435c3c9a7013a252ae4",
                  display_name: "Anaheim",
                  country_code: "US",
                  region_code: "CA",
                  aliases: ["anaheim"],
                }],
                error: null,
              });
            if (table === "onboarding_locality_aliases")
              return resolve({ data: [], error: null });
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
  withCandidate = true,
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
    playbackStopped: true, validated: true, interrupted: false, attempt: 0,
  };
  if (withCandidate)
    lifecycle.approvalCandidate = {
      turnId: "turn-approval", ownerWords: "Aprovado.",
    };
  else delete lifecycle.approvalCandidate;
  if (withCandidate) {
    l.onboarding!.activeCallerTurnId = "turn-approval";
    l.onboarding!.pendingCallerTurns = [{
      turnId: "turn-approval",
      transcriptCompleted: true,
    }];
    l.onboarding!.speechPending = true;
    l.onboarding!.speechGeneration += 1;
  }
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
        outputAck(l, "fc-vad-correction"));
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
      (frame) => frame.item.call_id === "fc-approval",
    );
    expect(JSON.parse(changedOutput.item.output)).toEqual({
      status: "snapshot_changed", retrying_summary: true,
    });
    expect(l.onboarding!.lifecycle.snapshotRefresh).toBeUndefined();
    expect(l.onboarding!.lifecycle.coverage).toMatchObject({
      revision: 2, digest, complete: true,
    });
    expect(boundary.calls.ruleReads).toBe(1);
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-approval"));
    expect(boundary.calls.ruleReads).toBe(2);
    expect(framesOfType(ws, "response.create").at(-1)!.response.metadata)
      .toMatchObject({ intent_key: `summary:${digest}`, purpose: "summary" });
  });

  test("approval tool before caller transcription waits for the correlated fresh turn and persists the exact transcript", async () => {
    const cap = onboardingCap("call-approval-before-transcript");
    const snapshot = completeCoverage(cap, 1);
    const digest = "6".repeat(64);
    const receipt = coverageReceipt(cap, snapshot, digest, "rule-approval-race");
    const boundary = snapshotBoundary(receipt, { approvalSuccess: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });
    seedAwaitingApproval(l, receipt.id, 1, digest, false);

    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-approval-race",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("resp-approval-race"),
    );
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval-race",
      "fc-approval-race",
      "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado" }),
      0,
    ));
    await handleEvent(cap, l, ws as any, responseDone("resp-approval-race"));

    expect(boundary.calls.rpc).not.toContain("record_onboarding_voice_approval");
    expect(l.onboarding!.lifecycle.toolOutbox["fc-approval-race"])
      .toMatchObject({
        state: "running",
        approvalTurnId: "turn-approval-race",
      });
    expect(functionOutputs(ws)).toHaveLength(0);

    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-approval-race",
      transcript: "Aprovado.",
    });

    const approvalRpc = boundary.calls.rpcArgs.find((call) =>
      call.name === "record_onboarding_voice_approval"
    );
    expect(approvalRpc?.args?.p_owner_words).toBe("Aprovado.");
    expect(boundary.calls.rpc.filter((name) =>
      name === "record_onboarding_voice_approval"
    )).toHaveLength(1);
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-approval-race"]?.state)
      .toBe("output_pending");
    expect(l.onboarding!.lifecycle.phase).toBe("approval_persisting");
  });

  test("caller transcription before the VAD response keeps the same approval turn authority", async () => {
    const cap = onboardingCap("call-approval-transcript-first");
    const snapshot = completeCoverage(cap, 1);
    const digest = "9".repeat(64);
    const receipt = coverageReceipt(
      cap,
      snapshot,
      digest,
      "rule-approval-transcript-first",
    );
    const boundary = snapshotBoundary(receipt, { approvalSuccess: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });
    seedAwaitingApproval(l, receipt.id, 1, digest, false);

    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-approval-transcript-first",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-approval-transcript-first",
      transcript: "Aprovado.",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("resp-approval-transcript-first"),
    );
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval-transcript-first",
      "fc-approval-transcript-first",
      "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado" }),
      0,
    ));
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("resp-approval-transcript-first"),
    );

    const approvalRpc = boundary.calls.rpcArgs.find((call) =>
      call.name === "record_onboarding_voice_approval"
    );
    expect(approvalRpc?.args?.p_owner_words).toBe("Aprovado.");
    expect(boundary.calls.rpc.filter((name) =>
      name === "record_onboarding_voice_approval"
    )).toHaveLength(1);
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(l.onboarding!.lifecycle.toolOutbox["fc-approval-transcript-first"])
      .toMatchObject({
        state: "output_pending",
        approvalTurnId: "turn-approval-transcript-first",
      });
    expect(l.onboarding!.lifecycle.phase).toBe("approval_persisting");
  });

  test("multiple caller turns bind responses by speech order rather than transcription completion order", async () => {
    const cap = onboardingCap("call-multiple-turn-order");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });

    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-A",
    });
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-B",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-B",
      transcript: "B",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-A",
      transcript: "A",
    });
    await handleEvent(cap, l, ws as any, responseCreated("response-A"));
    await handleEvent(cap, l, ws as any, responseCreated("response-B"));

    expect(l.onboarding!.responses["response-A"]?.callerTurnId).toBe("turn-A");
    expect(l.onboarding!.responses["response-B"]?.callerTurnId).toBe("turn-B");
  });

  test("one VAD response completing cannot strand the next speech-owned caller turn", async () => {
    const cap = onboardingCap("call-multiple-turn-pending");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });

    for (const turnId of ["turn-A", "turn-B"]) {
      await handleEvent(cap, l, ws as any, {
        type: "input_audio_buffer.speech_started",
        item_id: turnId,
      });
      await handleEvent(cap, l, ws as any, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: turnId,
        transcript: turnId,
      });
    }
    await handleEvent(cap, l, ws as any, responseCreated("response-A"));
    await handleEvent(cap, l, ws as any, responseDone("response-A"));
    await handleEvent(cap, l, ws as any, responseCreated("response-B"));

    expect(l.onboarding!.responses["response-A"]?.callerTurnId).toBe("turn-A");
    expect(l.onboarding!.responses["response-B"]?.callerTurnId).toBe("turn-B");
  });

  test("turn-detected cancellation retires the interrupted turn before binding the barge-in response", async () => {
    const cap = onboardingCap("call-turn-detected-order");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });

    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-A",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-A",
      transcript: "A",
    });
    await handleEvent(cap, l, ws as any, responseCreated("response-A"));
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-B",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-B",
      transcript: "B",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.done",
      response: {
        id: "response-A",
        status: "cancelled",
        status_details: { type: "cancelled", reason: "turn_detected" },
      },
    });
    await handleEvent(cap, l, ws as any, responseCreated("response-B"));

    expect(l.onboarding!.responses["response-A"]?.callerTurnId).toBe("turn-A");
    expect(l.onboarding!.responses["response-B"]?.callerTurnId).toBe("turn-B");
    expect(l.onboarding!.pendingCallerTurns.map((turn) => turn.turnId))
      .toEqual(["turn-B"]);
  });

  test("late transcript from a turn-detected approval turn has zero correction or approval authority", async () => {
    for (const [index, transcript] of [
      "Não está correto.",
      "Confirmo.",
    ].entries()) {
      const cap = onboardingCap(`call-late-cancelled-approval-${index}`);
      const snapshot = completeCoverage(cap, 1);
      const digest = String(index + 7).repeat(64);
      const receipt = coverageReceipt(
        cap,
        snapshot,
        digest,
        `rule-late-cancelled-approval-${index}`,
      );
      const boundary = snapshotBoundary(receipt, { approvalSuccess: true });
      _setClient(boundary.client);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, { type: "session.created" });
      seedAwaitingApproval(l, receipt.id, 1, digest, false);

      await handleEvent(cap, l, ws as any, {
        type: "input_audio_buffer.speech_started",
        item_id: "turn-cancelled-approval-A",
      });
      await handleEvent(
        cap,
        l,
        ws as any,
        responseCreated("response-cancelled-approval-A"),
      );
      await handleEvent(cap, l, ws as any, {
        type: "input_audio_buffer.speech_started",
        item_id: "turn-live-approval-B",
      });
      await handleEvent(cap, l, ws as any, {
        type: "response.done",
        response: {
          id: "response-cancelled-approval-A",
          status: "cancelled",
          status_details: { type: "cancelled", reason: "turn_detected" },
        },
      });
      await handleEvent(cap, l, ws as any, {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "turn-cancelled-approval-A",
        transcript,
      });
      await handleEvent(
        cap,
        l,
        ws as any,
        responseCreated("response-live-approval-B"),
      );

      expect(l.onboarding!.lifecycle.phase, transcript)
        .toBe("awaiting_owner_approval");
      expect(l.onboarding!.lifecycle.approvalCandidate, transcript)
        .toBeUndefined();
      expect(l.onboarding!.lifecycle.freshCallerTurnIds, transcript)
        .toEqual(["turn-live-approval-B"]);
      expect(l.onboarding!.lifecycle.consumedCallerTurnIds, transcript)
        .not.toContain("turn-cancelled-approval-A");
      expect(l.onboarding!.responses["response-live-approval-B"]?.callerTurnId)
        .toBe("turn-live-approval-B");
      expect(l.onboarding!.pendingCallerTurns.map((turn) => turn.turnId))
        .toEqual(["turn-live-approval-B"]);
      expect(boundary.calls.rpc).not.toContain(
        "record_onboarding_voice_approval",
      );
      expect(framesOfType(ws, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "recovery",
      )).toHaveLength(0);
    }
  });

  test("Test 9 late transcript after turn-detected cannot strand the three-service persistence turn", async () => {
    const cap = onboardingCap("call-test-9-late-transcript");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 1, digest: "1".repeat(64) },
      { status: "recorded", revision: 2, digest: "2".repeat(64) },
      { status: "recorded", revision: 3, digest: "3".repeat(64) },
      { status: "recorded", revision: 4, digest: "4".repeat(64) },
    ], { responseFromProjection: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);

    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-test-9-crosstalk",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-crosstalk"),
    );
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-test-9-services",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.done",
      response: {
        id: "response-test-9-crosstalk",
        status: "cancelled",
        status_details: { type: "cancelled", reason: "turn_detected" },
      },
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-test-9-crosstalk",
      transcript: "Oi.",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-test-9-services",
      transcript:
        "A gente faz desentupimento, conserto de vazamento e diagnóstico hidráulico. Só esses três por enquanto.",
    });

    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-services"),
    );
    const ownerWords =
      "A gente faz desentupimento, conserto de vazamento e diagnóstico hidráulico. Só esses três por enquanto.";
    const extractedFacts = test9ServiceFacts(ownerWords);
    for (const [outputIndex, fact] of extractedFacts.entries())
      await handleEvent(cap, l, ws as any, functionCallDone(
        "response-test-9-services",
        `tool-test-9-${outputIndex + 1}`,
        "record_interview_answer",
        JSON.stringify(fact),
        outputIndex,
      ));
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-test-9-services"),
    );

    expect(boundary.rpcFacts).toHaveLength(4);
    expect(boundary.rpcFacts.map((fact) => [fact.field, fact.subject ?? null]))
      .toEqual([
        ["service.name_synonyms", "desentupimento"],
        ["service.name_synonyms", "conserto_de_vazamento"],
        ["service.name_synonyms", "diagnostico_hidraulico"],
        ["service.catalog_closure", null],
      ]);
    expect(functionOutputs(ws)).toHaveLength(4);
    for (let index = 1; index <= 4; index += 1)
      await handleEvent(
        cap,
        l,
        ws as any,
        outputAck(l, `tool-test-9-${index}`),
      );

    const nextQuestions = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "tool_continuation",
    );
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(boundary.followupRpcCalls).toBe(1);
    expect(nextQuestions).toHaveLength(1);
    expect(JSON.stringify(nextQuestions[0])).toContain("desentupimento");
    expect(l.onboarding!.responses["response-test-9-services"]?.callerTurnId)
      .toBe("turn-test-9-services");
  });

  test("real Test 9 greeting retry survives ambiguous crosstalk before the three-service turn", async () => {
    const cap = onboardingCap("call-test-9-greeting-correlation");
    const boundary = sequentialAnswerBoundary([
      { status: "recorded", revision: 1, digest: "1".repeat(64) },
      { status: "recorded", revision: 2, digest: "2".repeat(64) },
      { status: "recorded", revision: 3, digest: "3".repeat(64) },
      { status: "recorded", revision: 4, digest: "4".repeat(64) },
    ], { responseFromProjection: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });
    const greetingKey = `greeting:${cap.callId}`;
    l.onboarding!.lifecycle.responseIntents[greetingKey] = {
      intentKey: greetingKey,
      purpose: "greeting",
      state: "sent",
    };
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-wrong-greeting", greetingKey),
    );
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "response-test-9-wrong-greeting",
      transcript: "Olá, eu sou a ChatGPT, sua assistente virtual.",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio.done",
      response_id: "response-test-9-wrong-greeting",
    });
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-test-9-opening-A",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.done",
      response: {
        id: "response-test-9-wrong-greeting",
        status: "cancelled",
        status_details: { type: "cancelled", reason: "turn_detected" },
      },
    });
    const retryKey = `${greetingKey}:retry:1`;
    expect(l.onboarding!.lifecycle.responseIntents[retryKey]).toMatchObject({
      state: "queued",
      purpose: "greeting",
    });
    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.intent_key === retryKey,
    )).toHaveLength(0);
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-opening-crosstalk"),
    );
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-test-9-opening-crosstalk"),
    );
    expect(l.onboarding!.lifecycle.phase).toBe("greeting");
    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.intent_key === retryKey,
    )).toHaveLength(1);
    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    )).toHaveLength(0);

    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-test-9-opening-B",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Oi.",
    });

    const retries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.intent_key === retryKey,
    );
    expect(l.onboarding!.lifecycle.phase).toBe("greeting");
    expect(l.onboarding!.pendingCallerTurns).toEqual([]);
    expect(retries).toHaveLength(1);
    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    )).toHaveLength(0);

    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-correct-greeting", retryKey),
    );
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "response-test-9-correct-greeting",
      transcript:
        "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio.done",
      response_id: "response-test-9-correct-greeting",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-test-9-correct-greeting"),
    );
    await handleEvent(cap, l, ws as any, {
      type: "output_audio_buffer.stopped",
      response_id: "response-test-9-correct-greeting",
    });
    expect(l.onboarding!.lifecycle.phase).toBe("collecting");
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-test-9-opening-A",
      transcript: "Oi, replay tardio.",
    });
    expect(l.onboarding!.lifecycle.phase).toBe("collecting");
    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    )).toHaveLength(0);

    const ownerWords =
      "A gente faz desentupimento, conserto de vazamento e diagnóstico hidráulico. Só esses três por enquanto.";
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-test-9-real-services",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-test-9-real-services",
      transcript: ownerWords,
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-real-services"),
    );
    for (const [outputIndex, fact] of test9ServiceFacts(ownerWords).entries())
      await handleEvent(cap, l, ws as any, functionCallDone(
        "response-test-9-real-services",
        `tool-test-9-real-${outputIndex + 1}`,
        "record_interview_answer",
        JSON.stringify(fact),
        outputIndex,
      ));
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-test-9-real-services"),
    );
    for (let index = 1; index <= 4; index += 1)
      await handleEvent(
        cap,
        l,
        ws as any,
        outputAck(l, `tool-test-9-real-${index}`),
      );

    expect(boundary.rpcFacts).toHaveLength(4);
    expect(boundary.followupRpcCalls).toBe(1);
    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "tool_continuation",
    )).toHaveLength(1);
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
  });

  test("single-service incomplete first turn persists once and asks one directed follow-up", async () => {
    const cap = onboardingCap("call-single-service-first-turn");
    const boundary = sequentialAnswerBoundary([{
      status: "recorded",
      revision: 1,
      digest: "1".repeat(64),
    }], { responseFromProjection: true });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-single-service",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-single-service",
      transcript: "Desentupimento.",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-single-service"),
    );
    await handleEvent(cap, l, ws as any, functionCallDone(
      "response-single-service",
      "tool-single-service",
      "record_interview_answer",
      JSON.stringify({
        topic: "servicos",
        field: "service.name_synonyms",
        subject: "desentupimento",
        disposition: "answered",
        rule_text: "Oferece desentupimento.",
        structured: { value: ["desentupimento"] },
        owner_words: "Desentupimento.",
      }),
    ));
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-single-service"),
    );
    await handleEvent(
      cap,
      l,
      ws as any,
      outputAck(l, "tool-single-service"),
    );

    const questions = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "tool_continuation",
    );
    expect(boundary.rpcFacts).toHaveLength(1);
    expect(boundary.rpcFacts[0]).toMatchObject({
      field: "service.name_synonyms",
      subject: "desentupimento",
      owner_words: "Desentupimento.",
    });
    expect(boundary.followupRpcCalls).toBe(1);
    expect(questions).toHaveLength(1);
    expect(JSON.stringify(questions[0])).toContain("serviço");
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
  });

  test("ambiguous transcript without item_id fails closed on authority and speaks one recovery", async () => {
    const cap = onboardingCap("call-transcript-correlation-ambiguous");
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    for (const turnId of ["turn-ambiguous-A", "turn-ambiguous-B"])
      await handleEvent(cap, l, ws as any, {
        type: "input_audio_buffer.speech_started",
        item_id: turnId,
      });

    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Resposta sem identidade causal.",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Replay sem identidade causal.",
    });

    const recoveries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    );
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(l.onboarding!.pendingCallerTurns).toEqual([]);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].response.tool_choice).toBe("none");
    expect(recoveries[0].response.instructions).toContain("Não consegui confirmar");
    expect(recoveries[0].response.instructions).toContain("repita");
    expect(l.onboarding!.lifecycle.freshCallerTurnIds).toEqual([]);
  });

  test("unknown transcript item_id fails closed on authority and speaks one recovery", async () => {
    const cap = onboardingCap("call-transcript-correlation-unknown");
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);

    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-not-owned-by-this-session",
      transcript: "Resposta com identidade desconhecida.",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-not-owned-by-this-session",
      transcript: "Replay com identidade desconhecida.",
    });

    const recoveries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    );
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].response.instructions).toContain("Não consegui confirmar");
    expect(l.onboarding!.lifecycle.freshCallerTurnIds).toEqual([]);
  });

  test("terminal response drains the recovery queued by an unmatched active caller turn", async () => {
    const cap = onboardingCap("call-active-correlation-recovery-drain");
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-active-correlation-owned",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-active-correlation"),
    );
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-active-correlation-unknown",
      transcript: "Resposta sem correlação válida.",
    });

    expect(framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    )).toHaveLength(0);
    expect(Object.keys(l.onboarding!.pendingResponseCommands)).toHaveLength(1);

    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-active-correlation"),
    );
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-active-correlation"),
    );

    const recoveries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    );
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].response.tool_choice).toBe("none");
    expect(Object.keys(l.onboarding!.pendingResponseCommands)).toHaveLength(0);
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(l.status).toBe("active");
  });

  test("Test 9 speech-only process narration cannot leave collecting idle", async () => {
    const cap = onboardingCap("call-test-9-speech-only");
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-test-9-speech-only",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-test-9-speech-only",
      transcript:
        "A gente faz desentupimento, conserto de vazamento e diagnóstico hidráulico. Só esses três por enquanto.",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-test-9-speech-only"),
    );
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "response-test-9-speech-only",
      transcript:
        "Beleza. Vou registrar isso direitinho e em seguida sigo com a próxima pergunta do fluxo.",
    });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio.done",
      response_id: "response-test-9-speech-only",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-test-9-speech-only"),
    );
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-test-9-speech-only"),
    );

    const recoveries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    );
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].response.instructions).toContain("Não consegui confirmar");
    expect(recoveries[0].response.instructions).toContain("repita");
    expect(functionOutputs(ws)).toHaveLength(0);
    expect(l.responseActive).toBe(true);
    expect(l.status).toBe("active");
  });

  test("first-turn persistence failure speaks one truthful recovery instead of blocking silently", async () => {
    const cap = onboardingCap("call-first-turn-persistence-failure");
    let answerCalls = 0;
    _setClient({
      from() {
        const query: any = {
          select() { return query; },
          eq() { return query; },
          in() { return query; },
          order() { return query; },
          limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string) {
        if (name !== "record_onboarding_answer")
          return Promise.resolve({
            data: null,
            error: { message: `unexpected rpc ${name}` },
          });
        answerCalls += 1;
        return Promise.resolve({
          data: null,
          error: { code: "XX000", message: "synthetic persistence failure" },
        });
      },
    } as any);
    const l = ledger(cap.callId);
    const ws = socket();
    await completeGreetingTrace(cap, l, ws);
    await handleEvent(cap, l, ws as any, {
      type: "input_audio_buffer.speech_started",
      item_id: "turn-persistence-failure",
    });
    await handleEvent(cap, l, ws as any, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "turn-persistence-failure",
      transcript: "Desentupimento.",
    });
    await handleEvent(
      cap,
      l,
      ws as any,
      responseCreated("response-persistence-failure"),
    );
    await handleEvent(cap, l, ws as any, functionCallDone(
      "response-persistence-failure",
      "tool-persistence-failure",
      "record_interview_answer",
      JSON.stringify({
        topic: "servicos",
        field: "service.name_synonyms",
        subject: "desentupimento",
        disposition: "answered",
        rule_text: "Oferece desentupimento.",
        structured: { value: ["desentupimento"] },
        owner_words: "Desentupimento.",
      }),
    ));
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-persistence-failure"),
    );
    await handleEvent(
      cap,
      l,
      ws as any,
      responseDone("response-persistence-failure"),
    );

    const recoveriesBeforeAck = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    );
    expect(answerCalls).toBe(1);
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(l.onboarding!.lifecycle.toolOutbox["tool-persistence-failure"]?.state)
      .toBe("output_pending");
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
    expect(recoveriesBeforeAck).toHaveLength(0);
    const failureOutput = functionOutputs(ws)[0];
    expect(JSON.parse(failureOutput.item.output)).toEqual({
      status: "error",
      error: "persistence_failed",
      retry_safe: true,
    });
    const ack = outputAck(l, "tool-persistence-failure");
    await handleEvent(cap, l, ws as any, ack);
    await handleEvent(cap, l, ws as any, ack);

    const recoveries = framesOfType(ws, "response.create").filter(
      (frame) => frame.response?.metadata?.purpose === "recovery",
    );
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].response.tool_choice).toBe("none");
    expect(recoveries[0].response.instructions).toContain("repita");
    expect(l.responseActive).toBe(true);
  });

  test("speech-owned pending turn correlation fails closed at its deterministic bound", async () => {
    const cap = onboardingCap("call-pending-turn-capacity");
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });

    for (let index = 0; index < 513; index += 1)
      await handleEvent(cap, l, ws as any, {
        type: "input_audio_buffer.speech_started",
        item_id: `turn-capacity-${index}`,
      });

    expect(l.onboarding!.pendingCallerTurns).toHaveLength(512);
    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(l.transcript.at(-1)?.text)
      .toBe("onboarding blocked: adapter_capacity_exceeded");
  });

  test("an indeterminate approval reconciles once on the same socket and emits one output", async () => {
    const cap = onboardingCap("call-approval-indeterminate-same-socket");
    const snapshot = completeCoverage(cap, 1);
    const digest = "7".repeat(64);
    const receipt = coverageReceipt(
      cap,
      snapshot,
      digest,
      "rule-approval-indeterminate",
    );
    const boundary = snapshotBoundary(receipt, {
      approvalSuccess: true,
      approvalAmbiguousAttempts: 2,
    });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });
    seedAwaitingApproval(l, receipt.id, 1, digest);
    await handleEvent(cap, l, ws as any,
      responseCreated("resp-approval-indeterminate"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval-indeterminate",
      "fc-approval-indeterminate",
      "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado" }),
    ));
    await handleEvent(cap, l, ws as any,
      responseDone("resp-approval-indeterminate"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const approvalArgs = boundary.calls.rpcArgs.filter((call) =>
      call.name === "record_onboarding_voice_approval"
    ).map((call) => call.args!);
    expect(approvalArgs).toHaveLength(3);
    expect(approvalArgs.map(hashOnboardingToolArgs)).toEqual(
      Array(3).fill(hashOnboardingToolArgs(approvalArgs[0]!)),
    );
    expect(functionOutputs(ws)).toHaveLength(1);
    expect(l.onboarding!.lifecycle.toolOutbox[
      "fc-approval-indeterminate"
    ]?.state).toBe("output_pending");
    expect(l.onboarding!.pendingMutationCommands).toEqual({});
    expect(l.onboarding!.pendingMutationRetryTimers).toEqual({});
    expect(l.onboarding!.lifecycle.phase).not.toBe("blocked");
  });

  test("a twice-indeterminate approval blocks with zero output and no running receipt", async () => {
    const cap = onboardingCap("call-approval-indeterminate-exhausted");
    const snapshot = completeCoverage(cap, 1);
    const digest = "8".repeat(64);
    const receipt = coverageReceipt(
      cap,
      snapshot,
      digest,
      "rule-approval-indeterminate-exhausted",
    );
    const boundary = snapshotBoundary(receipt, {
      approvalSuccess: true,
      approvalAmbiguousAttempts: Number.POSITIVE_INFINITY,
    });
    _setClient(boundary.client);
    const l = ledger(cap.callId);
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "session.created" });
    seedAwaitingApproval(l, receipt.id, 1, digest);
    await handleEvent(cap, l, ws as any,
      responseCreated("resp-approval-indeterminate-exhausted"));
    await handleEvent(cap, l, ws as any, functionCallDone(
      "resp-approval-indeterminate-exhausted",
      "fc-approval-indeterminate-exhausted",
      "approve_onboarding_summary",
      JSON.stringify({ owner_words: "Aprovado" }),
    ));
    await handleEvent(cap, l, ws as any,
      responseDone("resp-approval-indeterminate-exhausted"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(boundary.calls.rpc.filter((name) =>
      name === "record_onboarding_voice_approval"
    )).toHaveLength(4);
    expect(functionOutputs(ws)).toHaveLength(0);
    expect(l.onboarding!.lifecycle.phase).toBe("blocked");
    expect(l.onboarding!.lifecycle.toolOutbox[
      "fc-approval-indeterminate-exhausted"
    ]).toBeUndefined();
    expect(l.onboarding!.pendingMutationCommands).toEqual({});
    expect(l.onboarding!.pendingMutationRetryTimers).toEqual({});
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
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-approval"));
    const creates = framesOfType(ws, "response.create");
    expect(creates).toHaveLength(1);
    expect(creates[0].response.metadata).toEqual({
      intent_key: "final-signoff:approval-receipt-1",
      purpose: "final_signoff",
      approval_receipt_id: "approval-receipt-1",
    });
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-approval"));
    expect(framesOfType(ws, "response.create")).toHaveLength(1);
    await handleEvent(cap, l, ws as any,
      responseCreated("resp-signoff", "final-signoff:approval-receipt-1"));
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "resp-signoff",
      transcript:
        "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.",
    });
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

    await handleEvent(cap, l, ws as any, outputAck(l, "fc-approval"));
    expect(l.onboarding!.lifecycle.phase).toBe("approval_persisting");
    expect(framesOfType(ws, "response.create")).toHaveLength(0);
    await handleEvent(cap, l, ws as any, outputAck(l, "fc-close-sibling"));
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

  async function completePhysicalGreeting(
    ws: SyntheticWebSocket,
    cap: Capability,
    responseId = "resp-greeting",
  ) {
    ws.message(responseCreated(responseId, `greeting:${cap.callId}`));
    ws.message({
      type: "response.output_audio_transcript.done",
      response_id: responseId,
      transcript:
        "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
    });
    ws.message({ type: "response.output_audio.done", response_id: responseId });
    ws.message(responseDone(responseId));
    ws.message({ type: "output_audio_buffer.stopped", response_id: responseId });
    await flushAsync();
  }

  const applicationOpeningPayload = {
    version: 1,
    item_id: "lgo-a89f1f9391ab7a82b4f27f198407",
    text: "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?",
    text_sha256: "413f79d3d184ea3985fdb593f99ac331c612c157e871034df0135f06a7817e06",
    audio_base64: "SUQzBAAAAAAAAP/7kGQ=",
    audio_sha256: "b15db04aea85ebd3f59185796229df945e67f42931c7e9da411e97b83c856ce8",
    mime: "audio/mpeg",
    voice: "ash",
    tts_model: "tts-1",
    cost_usd: 0.001605,
  };
  const applicationOptions = {
    onboarding: {
      expectedBusinessName: "D1F Marketing",
      openingMode: "application_tts_v1",
      openingPayload: applicationOpeningPayload,
    },
    externalCostUsd: 0.001605,
  } as any;

  function applicationOpeningCreated(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      type: "conversation.item.created",
      item: {
        id: applicationOpeningPayload.item_id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: applicationOpeningPayload.text,
        }],
        ...overrides,
      },
    };
  }

  function applicationOpeningRetrieved(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      type: "conversation.item.retrieved",
      item: {
        id: applicationOpeningPayload.item_id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: applicationOpeningPayload.text,
        }],
        ...overrides,
      },
    };
  }

  const activeSessionUpdated = {
    type: "session.updated",
    session: {
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
            eagerness: "low",
            create_response: true,
            interrupt_response: true,
          },
        },
      },
    },
  };

  test("Test 10 application opening has zero response.create and activates only after exact item plus session.updated", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-test-10-application-opening");
    try {
      const control = attachSideband(
        cap,
        "rtc-test-10-application-opening",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const ws = SyntheticWebSocket.instances[0]!;
      ws.emit("open");
      await control.opened;

      expect(framesOfType(ws, "response.create")).toHaveLength(0);
      expect(framesOfType(ws, "session.update")[0]?.session.audio.input.turn_detection)
        .toEqual({
          type: "semantic_vad",
          eagerness: "low",
          create_response: false,
          interrupt_response: false,
        });
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("greeting");

      const gaOpeningDone = {
        ...applicationOpeningCreated(),
        type: "conversation.item.done",
      };
      ws.message({
        ...applicationOpeningCreated(),
        type: "conversation.item.added",
      });
      await flushAsync();
      expect(framesOfType(ws, "session.update")).toHaveLength(1);
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("greeting");
      ws.message(gaOpeningDone);
      ws.message(gaOpeningDone);
      await flushAsync();
      const updates = framesOfType(ws, "session.update");
      expect(updates).toHaveLength(2);
      expect(updates[1]?.session.audio.input.turn_detection).toEqual({
        type: "semantic_vad",
        eagerness: "low",
        create_response: true,
        interrupt_response: true,
      });
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("greeting");

      ws.message(activeSessionUpdated);
      await flushAsync();
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("collecting");
      expect(framesOfType(ws, "response.create")).toHaveLength(0);
      expect(control.ledger.transcript).toContainEqual(expect.objectContaining({
        role: "agent",
        text: applicationOpeningPayload.text,
      }));
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("first sideband open listens before publication without a speculative opening retrieve", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-test-10-delayed-first-open");
    try {
      const control = attachSideband(
        cap,
        "rtc-test-10-delayed-first-open",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const ws = SyntheticWebSocket.instances[0]!;
      ws.emit("open");
      await control.opened;
      expect(framesOfType(ws, "conversation.item.retrieve")).toEqual([]);
      expect(framesOfType(ws, "response.create")).toEqual([]);

      ws.message(applicationOpeningCreated());
      await flushAsync();
      expect(framesOfType(ws, "session.update")).toHaveLength(2);
      ws.message(activeSessionUpdated);
      await flushAsync();
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("collecting");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("wrong application opening or any model response before activation blocks instead of speaking a model greeting", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = SyntheticWebSocket as any;
    try {
      for (const [suffix, event] of [
        ["wrong-text", applicationOpeningCreated({
          content: [{ type: "output_text", text: "Sou uma assistente virtual brasileira." }],
        })],
        ["wrong-id", applicationOpeningCreated({ id: "item-from-wrong-opening" })],
        ["model-response", responseCreated("resp-forbidden-model-greeting")],
      ] as const) {
        SyntheticWebSocket.instances = [];
        const cap = onboardingCap(`call-test-10-${suffix}`);
        const control = attachSideband(
          cap,
          `rtc-test-10-${suffix}`,
          "gpt-realtime-2.1",
          applicationOptions,
        );
        const ws = SyntheticWebSocket.instances[0]!;
        ws.emit("open");
        await control.opened;
        ws.message(event);
        await flushAsync();
        expect(control.ledger.onboarding!.lifecycle.phase).toBe("blocked");
        expect(framesOfType(ws, "response.create")).toHaveLength(0);
        expect(framesOfType(ws, "session.update")).toHaveLength(1);
        control.cancel("test_cleanup");
        liveSessions.delete(cap.callId);
      }
    } finally {
      globalThis.WebSocket = original;
    }
  });

  test("duplicate exact application item enables once, and tool output before activation is fail-closed", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = SyntheticWebSocket as any;
    try {
      SyntheticWebSocket.instances = [];
      const duplicateCap = onboardingCap("call-test-10-duplicate-opening");
      const duplicate = attachSideband(
        duplicateCap,
        "rtc-test-10-duplicate-opening",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const duplicateSocket = SyntheticWebSocket.instances[0]!;
      duplicateSocket.emit("open");
      await duplicate.opened;
      duplicateSocket.message(applicationOpeningCreated());
      duplicateSocket.message(applicationOpeningCreated());
      await flushAsync();
      expect(framesOfType(duplicateSocket, "session.update")).toHaveLength(2);
      expect(duplicate.ledger.onboarding!.lifecycle.phase).toBe("greeting");
      duplicate.cancel("test_cleanup");
      liveSessions.delete(duplicateCap.callId);

      SyntheticWebSocket.instances = [];
      const toolCap = onboardingCap("call-test-10-tool-before-opening");
      const tool = attachSideband(
        toolCap,
        "rtc-test-10-tool-before-opening",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const toolSocket = SyntheticWebSocket.instances[0]!;
      toolSocket.emit("open");
      await tool.opened;
      toolSocket.message(functionCallDone(
        "resp-forbidden-tool",
        "fc-forbidden-tool",
        "record_interview_answer",
        JSON.stringify({
          topic: "servicos",
          field: "service.catalog_closure",
          disposition: "answered",
          rule_text: "Só desentupimento.",
          structured: { value: true },
          owner_words: "Desentupimento.",
        }),
      ));
      toolSocket.message(responseDone("resp-forbidden-tool"));
      await flushAsync();
      expect(tool.ledger.onboarding!.lifecycle.phase).toBe("blocked");
      expect(functionOutputs(toolSocket)).toHaveLength(0);
      expect(tool.ledger.toolLog).toHaveLength(0);
      tool.cancel("test_cleanup");
      liveSessions.delete(toolCap.callId);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  test("application opening reattach reasserts disabled VAD and retrieves the exact item without a provider greeting", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-test-10-opening-reattach");
    try {
      const control = attachSideband(
        cap,
        "rtc-test-10-opening-reattach",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      first.message(applicationOpeningCreated());
      await flushAsync();
      expect(framesOfType(first, "session.update")).toHaveLength(2);

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(framesOfType(second, "response.create")).toHaveLength(0);
      expect(framesOfType(second, "session.update")[0]?.session.audio.input.turn_detection)
        .toEqual(expect.objectContaining({
          create_response: false,
          interrupt_response: false,
        }));
      expect(framesOfType(second, "conversation.item.retrieve")).toEqual([
        expect.objectContaining({
          item_id: applicationOpeningPayload.item_id,
          event_id: expect.any(String),
        }),
      ]);
      second.message(applicationOpeningRetrieved());
      await flushAsync();
      expect(framesOfType(second, "session.update")).toHaveLength(2);
      second.message(activeSessionUpdated);
      await flushAsync();
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("collecting");
      expect(framesOfType(second, "response.create")).toHaveLength(0);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("reattach retrieve errors stay unactivated without depending on provider error codes, then later item.created can activate", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-test-10-opening-not-created-yet");
    try {
      const control = attachSideband(
        cap,
        "rtc-test-10-opening-not-created-yet",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("greeting");
      expect(framesOfType(first, "response.create")).toEqual([]);

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const retrieve = framesOfType(second, "conversation.item.retrieve")[0];
      expect(retrieve.item_id).toBe(applicationOpeningPayload.item_id);
      expect(typeof retrieve.event_id).toBe("string");
      const retrieveEventId = String(retrieve.event_id);
      expect(control.ledger.applicationOpening?.retrieveEventId)
        .toBe(retrieveEventId);

      second.message({
        type: "error",
        error: {
          code: "synthetic_provider_error",
          message: "Retrieve outcome unavailable",
          event_id: retrieveEventId,
        },
      });
      await flushAsync();
      expect(control.ledger.status).toBe("active");
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("greeting");
      expect(second.closed).toBe(0);
      expect(framesOfType(second, "response.create")).toEqual([]);

      second.message(applicationOpeningCreated());
      await flushAsync();
      expect(framesOfType(second, "session.update")).toHaveLength(2);
      second.message(activeSessionUpdated);
      await flushAsync();
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("collecting");
      expect(framesOfType(second, "response.create")).toEqual([]);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("reattach releases no pending tool output or response until the exact opening handshake is active again", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-test-10-opening-gates-pending");
    try {
      const control = attachSideband(
        cap,
        "rtc-test-10-opening-gates-pending",
        "gpt-realtime-2.1",
        applicationOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      first.message(applicationOpeningCreated());
      await flushAsync();
      first.message(activeSessionUpdated);
      await flushAsync();

      const adapter = control.ledger.onboarding!;
      adapter.lifecycle.toolOutbox["pending-opening-tool"] = {
        toolCallId: "pending-opening-tool",
        toolName: "record_interview_answer",
        argsHash: "pending-opening-args",
        state: "executed",
        providerResponseId: "pending-opening-response",
        batchHash: "pending-opening-batch",
        resultHash: "pending-opening-result",
        output: "{\"status\":\"recorded\"}",
        outputItemId: "tlo-0a22764d83123f17dec9a8f4f754",
        socketGeneration: 1,
      };

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(functionOutputs(second)).toEqual([]);
      expect(framesOfType(second, "response.create")).toEqual([]);
      expect(framesOfType(second, "conversation.item.retrieve")).toEqual([
        expect.objectContaining({ item_id: applicationOpeningPayload.item_id }),
      ]);
      second.message(applicationOpeningRetrieved());
      await flushAsync();
      expect(functionOutputs(second)).toEqual([]);
      second.message(activeSessionUpdated);
      await flushAsync();
      expect(functionOutputs(second)).toHaveLength(1);
      expect(functionOutputs(second)[0].item).toMatchObject({
        id: "tlo-0a22764d83123f17dec9a8f4f754",
        call_id: "pending-opening-tool",
        output: "{\"status\":\"recorded\"}",
      });
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  function ambiguousAnswerBoundary(succeedOnAttempt?: number) {
    let answerAttempts = 0;
    const answerRpcArgs: Record<string, unknown>[] = [];
    return {
      get answerAttempts() { return answerAttempts; },
      answerRpcArgs,
      client: {
        from() {
          const query: any = {
            select() { return query; },
            eq() { return query; },
            in() { return query; },
            order() { return query; },
            limit() { return query; },
            maybeSingle: async () => ({ data: null, error: null }),
            then(resolve: (value: unknown) => unknown) {
              return Promise.resolve({ data: [], error: null }).then(resolve);
            },
          };
          return query;
        },
        rpc(name: string, args: Record<string, unknown>) {
          if (name !== "record_onboarding_answer")
            return Promise.resolve({
              data: null,
              error: { message: `unexpected rpc ${name}` },
            });
          answerAttempts += 1;
          answerRpcArgs.push(structuredClone(args));
          if (answerAttempts !== succeedOnAttempt)
            return Promise.resolve({
              data: null,
              error: { message: answerAttempts % 2 === 1
                ? "fetch failed"
                : "network socket closed" },
            });
          return Promise.resolve({
            data: {
              status: "recorded",
              rule_id: null,
              rule_group_id: null,
              coverage_receipt_id: "receipt-after-reconciliation",
              revision: 1,
              snapshot_digest: "9".repeat(64),
              complete: false,
              missing: [{ field: "service.catalog_closure" }],
              ambiguous: [],
              next_action: {
                type: "ask",
                field: "service.catalog_closure",
                question_pt: "Há mais algum serviço?",
              },
              coverage: args.p_coverage,
            },
            error: null,
          });
        },
      } as any,
    };
  }

  test("a sent greeting without response.created blocks reattach instead of creating a duplicate response", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-greeting");
    try {
      const control = attachSideband(
        cap, "rtc-greeting", "gpt-realtime-2.1", onboardingOptions,
      );
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
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("blocked");
      expect(control.ledger.transcript).toContainEqual(expect.objectContaining({
        role: "system",
        text: "onboarding blocked: response_intent_ack_indeterminate",
      }));
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("transport loss finds nonterminal authority speech awaiting playback and blocks its reattach", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-summary-transport-interruption");
    try {
      const control = attachSideband(
        cap,
        "rtc-summary-transport-interruption",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
      const adapter = control.ledger.onboarding!;
      const digest = "d".repeat(64);
      adapter.lifecycle.phase = "summary_speaking";
      adapter.lifecycle.summary = {
        receiptId: "coverage-transport-interruption",
        revision: 5,
        digest,
        requiredAnchors: ["Área: Irvine"],
        responseId: "response-summary-nonterminal",
        transcript: "Área: Irvine.",
        transcriptFinal: false,
        audioDone: true,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      adapter.lifecycle.responseIntents[`summary:${digest}`] = {
        intentKey: `summary:${digest}`,
        purpose: "summary",
        state: "acknowledged",
        responseId: "response-summary-nonterminal",
        sentSocketGeneration: 1,
      };
      delete adapter.lifecycle.activeResponseId;
      control.ledger.responseActive = false;

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(adapter.lifecycle.phase).toBe("blocked");
      expect(control.ledger.transcript).toContainEqual(expect.objectContaining({
        text: "onboarding blocked: authority_speech_terminal_indeterminate",
      }));
      expect(framesOfType(second, "response.create")).toHaveLength(0);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("transport loss after budget-pause response.done cannot lose playback proof or duplicate the warning", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-budget-pause-transport");
    try {
      const control = attachSideband(
        cap,
        "rtc-budget-pause-transport",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
      const adapter = control.ledger.onboarding!;
      adapter.lifecycle.phase = "budget_pause_speaking" as any;
      adapter.lifecycle.budgetPause = {
        costUsd: 6.5,
        softLimitUsd: 6.5,
        hardLimitUsd: 7.5,
        responseId: "response-budget-pause-playback-pending",
        transcript:
          "Estamos chegando ao limite desta sessão. Suas informações foram salvas. Vou encerrar esta sessão agora.",
        transcriptFinal: true,
        audioDone: true,
        responseDone: true,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      adapter.lifecycle.responseIntents[`budget-pause:${cap.callId}`] = {
        intentKey: `budget-pause:${cap.callId}`,
        purpose: "budget_pause" as any,
        state: "terminal",
        responseId: "response-budget-pause-playback-pending",
        sentSocketGeneration: 1,
      };
      delete adapter.lifecycle.activeResponseId;
      control.ledger.responseActive = false;

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(control.ledger.status).toBe("error");
      expect(control.ledger.transcript).toContainEqual(expect.objectContaining({
        text: "session ended: budget pause delivery indeterminate (budget_pause_playback_indeterminate)",
      }));
      expect(second.closed).toBe(1);
      expect(framesOfType(second, "response.create").filter((frame) =>
        frame.response?.metadata?.purpose === "budget_pause"
      )).toHaveLength(0);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("blocked reattach prunes queued authority speech and retrieves only the exact pending output", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-blocked-reattach");
    try {
      const control = attachSideband(
        cap, "rtc-blocked-reattach", "gpt-realtime-2.1", onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
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
        outputItemId: "tlo-5c6ed66e497e8824a3ec139a93fc",
        socketGeneration: 1,
      };
      // Keep the transport genuinely idle. `responseActive=true` would hide a
      // stale authority send behind an unrelated response-coordinator denial.
      control.ledger.responseActive = false;

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(adapter.lifecycle.phase).toBe("blocked");
      expect(adapter.lifecycle.socketGeneration).toBe(2);
      expect(framesOfType(second, "response.create")).toHaveLength(0);
      expect(functionOutputs(second)).toEqual([]);
      expect(framesOfType(second, "conversation.item.retrieve")).toEqual([
        expect.objectContaining({
          item_id: "tlo-5c6ed66e497e8824a3ec139a93fc",
          event_id: expect.any(String),
        }),
      ]);
      second.message(outputRetrieved(
        "tlo-5c6ed66e497e8824a3ec139a93fc",
        "blocked-output",
        "{\"status\":\"application_owned_close\"}",
      ));
      await flushAsync();
      expect(adapter.lifecycle.toolOutbox["blocked-output"]?.state)
        .toBe("output_acked");
      expect(adapter.pendingResponseCommands).toEqual({});
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("lost output acknowledgement reattaches by exact retrieval, never recreates or reruns, and continues once", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-output-retrieve");
    try {
      const control = attachSideband(
        cap, "rtc-output-retrieve", "gpt-realtime-2.1", onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
      const adapter = control.ledger.onboarding!;
      adapter.lifecycle.phase = "collecting";
      adapter.lifecycle.toolOutbox["retrieve-tool"] = {
        toolCallId: "retrieve-tool",
        toolName: "record_interview_answer",
        argsHash: "retrieve-args",
        state: "output_pending",
        providerResponseId: "retrieve-response",
        batchHash: "retrieve-batch",
        output: "{\"status\":\"recorded\"}",
        resultHash: "retrieve-result",
        outputItemId: "tlo-c7a5772dbcd9da39fffdcce950fa",
        socketGeneration: 1,
      };
      adapter.lifecycle.toolBatches["retrieve-response:retrieve-batch"] = {
        providerResponseId: "retrieve-response",
        batchHash: "retrieve-batch",
        toolCallIds: ["retrieve-tool"],
        closed: true,
        continuationRequested: false,
      };
      adapter.lifecycle.terminalResponseIds.push("retrieve-response");
      control.ledger.responseActive = false;
      const toolLogBefore = [...control.ledger.toolLog];

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(functionOutputs(second)).toEqual([]);
      expect(framesOfType(second, "conversation.item.retrieve")).toEqual([
        expect.objectContaining({
          type: "conversation.item.retrieve",
          item_id: "tlo-c7a5772dbcd9da39fffdcce950fa",
          event_id: expect.any(String),
        }),
      ]);
      second.message(outputRetrieved(
        "tlo-c7a5772dbcd9da39fffdcce950fa",
        "retrieve-tool",
        "{\"status\":\"recorded\"}",
      ));
      await flushAsync();

      expect(adapter.lifecycle.toolOutbox["retrieve-tool"]?.state)
        .toBe("output_acked");
      expect(control.ledger.toolLog).toEqual(toolLogBefore);
      expect(functionOutputs(second)).toEqual([]);
      expect(framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "tool_continuation",
      )).toHaveLength(1);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("failed persistence output reattaches by exact retrieval before one recovery", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-failed-output-retrieve");
    try {
      const control = attachSideband(
        cap,
        "rtc-failed-output-retrieve",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
      const adapter = control.ledger.onboarding!;
      const output = JSON.stringify({
        status: "error",
        error: "persistence_failed",
        retry_safe: true,
      });
      adapter.lifecycle.toolOutbox["failed-retrieve-tool"] = {
        toolCallId: "failed-retrieve-tool",
        toolName: "record_interview_answer",
        argsHash: "failed-retrieve-args",
        state: "output_pending",
        providerResponseId: "failed-retrieve-response",
        batchHash: "failed-retrieve-batch",
        output,
        resultHash: hashOnboardingToolArgs({ output }),
        outputItemId: "tlo-717e8433b4a1d07a4225663c68a1",
        socketGeneration: 1,
        outputRequest: {
          delivery: "create",
          eventId: "ligou-create-failed-retrieve",
          socketGeneration: 1,
        },
        failureKind: "deterministic",
      } as any;
      adapter.lifecycle.toolBatches[
        "failed-retrieve-response:failed-retrieve-batch"
      ] = {
        providerResponseId: "failed-retrieve-response",
        batchHash: "failed-retrieve-batch",
        toolCallIds: ["failed-retrieve-tool"],
        closed: true,
        continuationRequested: false,
      };
      adapter.lifecycle.terminalResponseIds.push("failed-retrieve-response");
      control.ledger.responseActive = false;
      const toolLogBefore = [...control.ledger.toolLog];

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(functionOutputs(second)).toEqual([]);
      expect(framesOfType(second, "conversation.item.retrieve")).toEqual([
        expect.objectContaining({
          item_id: "tlo-717e8433b4a1d07a4225663c68a1",
          event_id: expect.any(String),
        }),
      ]);
      expect(framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "recovery",
      )).toHaveLength(0);

      second.message(outputRetrieved(
        "tlo-717e8433b4a1d07a4225663c68a1",
        "failed-retrieve-tool",
        output,
      ));
      await flushAsync();
      second.message(outputRetrieved(
        "tlo-717e8433b4a1d07a4225663c68a1",
        "failed-retrieve-tool",
        output,
      ));
      await flushAsync();

      expect(adapter.lifecycle.toolOutbox["failed-retrieve-tool"]?.state)
        .toBe("output_acked");
      expect(adapter.lifecycle.toolBatches[
        "failed-retrieve-response:failed-retrieve-batch"
      ]?.continuationRequested).toBe(true);
      expect(control.ledger.toolLog).toEqual(toolLogBefore);
      expect(functionOutputs(second)).toEqual([]);
      expect(framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "recovery",
      )).toHaveLength(1);
      expect(framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "tool_continuation",
      )).toHaveLength(0);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
    }
  });

  test("retrieved output mismatch or missing item blocks without recreating the mutation output", async () => {
    for (const [index, retrieved] of [
      {
        type: "conversation.item.retrieved",
        item: {
          id: "tlo-f52489dbf6259346e63e343762c3",
          type: "function_call_output",
          call_id: "mismatch-tool",
          output: "{\"status\":\"attacker_changed\"}",
        },
      },
      { type: "conversation.item.retrieved" },
    ].entries()) {
      const cap = onboardingCap(`call-retrieve-mismatch-${index}`);
      const l = ledger(cap.callId);
      const ws = socket();
      await handleEvent(cap, l, ws as any, { type: "session.created" });
      const adapter = l.onboarding!;
      adapter.lifecycle.phase = "collecting";
      adapter.lifecycle.socketGeneration = 1;
      adapter.lifecycle.toolOutbox["mismatch-tool"] = {
        toolCallId: "mismatch-tool",
        toolName: "record_interview_answer",
        argsHash: "mismatch-args",
        state: "output_pending",
        providerResponseId: "mismatch-response",
        batchHash: "mismatch-batch",
        output: "{\"status\":\"recorded\"}",
        resultHash: "mismatch-result",
        outputItemId: "tlo-f52489dbf6259346e63e343762c3",
        socketGeneration: 1,
        outputRequest: {
          delivery: "retrieve",
          eventId: "ligou-retrieve-test",
          socketGeneration: 1,
        },
      };

      await handleEvent(cap, l, ws as any, retrieved);

      expect(adapter.lifecycle.phase).toBe("blocked");
      expect(adapter.lifecycle.toolOutbox["mismatch-tool"]?.state)
        .toBe("output_pending");
      expect(functionOutputs(ws)).toEqual([]);
    }
  });

  test("correlated duplicate create retrieves the deterministic item while a correlated retrieve error blocks", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-duplicate-output-create");
    try {
      const control = attachSideband(
        cap, "rtc-duplicate-output-create", "gpt-realtime-2.1", onboardingOptions,
      );
      const ws = SyntheticWebSocket.instances[0]!;
      const adapter = control.ledger.onboarding!;
      adapter.lifecycle.phase = "collecting";
      adapter.lifecycle.toolOutbox["duplicate-tool"] = {
        toolCallId: "duplicate-tool",
        toolName: "record_interview_answer",
        argsHash: "duplicate-args",
        state: "executed",
        providerResponseId: "duplicate-response",
        batchHash: "duplicate-batch",
        output: "{\"status\":\"recorded\"}",
        resultHash: "duplicate-result",
        outputItemId: "tlo-eca9d56ddb0ac2205aeac36bc064",
        socketGeneration: 0,
      };
      ws.emit("open");
      await control.opened;
      await flushAsync();

      const creates = functionOutputs(ws);
      expect(creates).toHaveLength(1);
      const createEventId = creates[0].event_id;
      expect(typeof createEventId).toBe("string");
      expect(creates[0]).toMatchObject({
        event_id: createEventId,
        item: {
          id: "tlo-eca9d56ddb0ac2205aeac36bc064",
          type: "function_call_output",
          call_id: "duplicate-tool",
          output: "{\"status\":\"recorded\"}",
        },
      });
      expect(adapter.lifecycle.toolOutbox["duplicate-tool"]?.outputRequest)
        .toMatchObject({
          delivery: "create",
          eventId: createEventId,
          socketGeneration: 1,
        });
      ws.message({
        type: "error",
        error: {
          code: "invalid_request_error",
          event_id: createEventId,
          message: "Item 'tlo-eca9d56ddb0ac2205aeac36bc064' already exists",
        },
      });
      await flushAsync();

      const retrieves = framesOfType(ws, "conversation.item.retrieve");
      expect(retrieves).toHaveLength(1);
      const retrieveEventId = retrieves[0].event_id;
      expect(typeof retrieveEventId).toBe("string");
      expect(retrieves[0]).toMatchObject({
        item_id: "tlo-eca9d56ddb0ac2205aeac36bc064",
        event_id: retrieveEventId,
      });
      expect(control.ledger.status).toBe("active");
      ws.message({
        type: "error",
        error: {
          code: "invalid_request_error",
          event_id: retrieveEventId,
          message: "Item could not be retrieved",
        },
      });
      await flushAsync();
      expect(adapter.lifecycle.phase).toBe("blocked");
      expect(functionOutputs(ws)).toHaveLength(1);
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
        cap, "rtc-greeting-send-retry", "gpt-realtime-2.1", onboardingOptions,
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
        cap, "rtc-delayed-snapshot-reattach", "gpt-realtime-2.1", onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
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
        cap, "rtc-output-reattach", "gpt-realtime-2.1", onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
      first.failFunctionOutputs = true;
      first.message(responseCreated("resp-tool"));
      first.message(functionCallDone(
        "resp-tool", "fc-reattach", "end_session", "{}",
      ));
      first.message(responseDone("resp-tool"));
      await flushAsync();
      expect(control.ledger.onboarding!.lifecycle.toolOutbox["fc-reattach"]?.state)
        .toBe("executed");
      expect(control.ledger.toolLog).toHaveLength(0);
      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const resent = functionOutputs(second);
      expect(resent).toHaveLength(1);
      expect(resent[0].item).toMatchObject({
        id: control.ledger.onboarding!.lifecycle.toolOutbox["fc-reattach"]
          ?.outputItemId,
        call_id: "fc-reattach",
      });
      expect(control.ledger.onboarding!.lifecycle.toolOutbox["fc-reattach"]?.state)
        .toBe("output_pending");
      expect(control.ledger.toolLog).toHaveLength(0);
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
          in() { return query; },
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
        cap, "rtc-mid-persist-reattach", "gpt-realtime-2.1", onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
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
          structured: { value: { localities: [{ display_name: "Irvine", country_code: "US", region_code: "CA" }] } },
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
        .toBe(control.ledger.onboarding!.lifecycle
          .toolOutbox["fc-mid-persist"]?.outputItemId);
      expect(functionOutputs(second)[0].item.id)
        .toMatch(/^tlo-[0-9a-f]{28}$/);
      expect(functionOutputs(second)[0].item.id)
        .not.toContain("fc-mid-persist");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("an indeterminate fact reconciles once on the same socket with the exact fingerprint and one output", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-indeterminate-same-socket");
    const boundary = ambiguousAnswerBoundary(3);
    _setClient(boundary.client);
    try {
      const control = attachSideband(
        cap,
        "rtc-indeterminate-same-socket",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
      first.message(responseCreated("resp-indeterminate"));
      first.message(functionCallDone(
        "resp-indeterminate",
        "fc-indeterminate",
        "record_interview_answer",
        JSON.stringify({
          topic: "area",
          field: "area.coverage",
          disposition: "answered",
          rule_text: "Atende Irvine.",
          structured: { value: { localities: [{ display_name: "Irvine", country_code: "US", region_code: "CA" }] } },
          owner_words: "Atendemos Irvine.",
        }),
      ));
      first.message(responseDone("resp-indeterminate"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(boundary.answerAttempts).toBe(3);
      expect(boundary.answerRpcArgs.map((args) =>
        hashOnboardingToolArgs(args)
      )).toEqual(Array(3).fill(
        hashOnboardingToolArgs(boundary.answerRpcArgs[0]!),
      ));
      expect(SyntheticWebSocket.instances).toHaveLength(1);
      expect(functionOutputs(first)).toHaveLength(1);
      expect(functionOutputs(first)[0].item).toMatchObject({
        id: control.ledger.onboarding!.lifecycle
          .toolOutbox["fc-indeterminate"]?.outputItemId,
        call_id: "fc-indeterminate",
      });
      expect(control.ledger.onboarding!.lifecycle.toolOutbox["fc-indeterminate"]?.state)
        .toBe("output_pending");
      expect(control.ledger.onboarding!.pendingMutationCommands).toEqual({});
      expect(control.ledger.onboarding!.lifecycle.phase).not.toBe("blocked");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("a twice-indeterminate fact speaks one truthful recovery with zero output or rerun", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-indeterminate-exhausted");
    const boundary = ambiguousAnswerBoundary();
    _setClient(boundary.client);
    try {
      const control = attachSideband(
        cap,
        "rtc-indeterminate-exhausted",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const ws = SyntheticWebSocket.instances[0]!;
      ws.emit("open");
      await control.opened;
      await completePhysicalGreeting(ws, cap);
      ws.message(responseCreated("resp-indeterminate-exhausted"));
      ws.message(functionCallDone(
        "resp-indeterminate-exhausted",
        "fc-indeterminate-exhausted",
        "record_interview_answer",
        JSON.stringify({
          topic: "outro",
          field: "business.customer_types",
          disposition: "answered",
          rule_text: "Atende clientes residenciais.",
          structured: { value: ["residencial"] },
          owner_words: "Atendemos clientes residenciais.",
        }),
      ));
      ws.message(responseDone("resp-indeterminate-exhausted"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(boundary.answerAttempts).toBe(4);
      expect(SyntheticWebSocket.instances).toHaveLength(1);
      expect(functionOutputs(ws)).toHaveLength(1);
      expect(JSON.parse(functionOutputs(ws)[0].item.output)).toEqual({
        status: "unknown",
        error: "persistence_indeterminate",
        retry_safe: false,
      });
      expect(framesOfType(ws, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "recovery",
      )).toHaveLength(0);
      expect(control.ledger.onboarding!.lifecycle.toolOutbox[
        "fc-indeterminate-exhausted"
      ]?.state).toBe("output_pending");
      ws.message(outputAck(
        control.ledger,
        "fc-indeterminate-exhausted",
      ));
      await flushAsync();
      const recoveries = framesOfType(ws, "response.create").filter(
        (frame) => frame.response?.metadata?.purpose === "recovery",
      );
      expect(recoveries).toHaveLength(1);
      expect(recoveries[0].response.instructions)
        .toContain("Encerre este teste");
      expect(recoveries[0].response.instructions).not.toContain("repita");
      expect(control.ledger.onboarding!.pendingMutationCommands).toEqual({});
      expect(control.ledger.onboarding!.pendingMutationRetryTimers).toEqual({});
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("an indeterminate directed follow-up reconciles on the same socket and asks once", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-followup-same-socket");
    const boundary = sequentialAnswerBoundary([{
      status: "recorded",
      revision: 1,
      digest: "1".repeat(64),
    }], {
      followupAmbiguousAttempts: 2,
      responseFromProjection: true,
    });
    _setClient(boundary.client);
    try {
      const control = attachSideband(
        cap,
        "rtc-followup-same-socket",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const ws = SyntheticWebSocket.instances[0]!;
      ws.emit("open");
      await control.opened;
      await completePhysicalGreeting(ws, cap);
      ws.message(responseCreated("resp-followup-same-socket"));
      ws.message(functionCallDone(
        "resp-followup-same-socket",
        "fc-followup-same-socket",
        "record_interview_answer",
        JSON.stringify({
          topic: "outro",
          field: "business.customer_types",
          disposition: "answered",
          rule_text: "Atende clientes residenciais.",
          structured: { value: ["residencial"] },
          owner_words: "Atendemos clientes residenciais.",
        }),
      ));
      ws.message(responseDone("resp-followup-same-socket"));
      await flushAsync();
      expect(functionOutputs(ws)).toHaveLength(1);

      ws.message(outputAck(
        control.ledger,
        "fc-followup-same-socket",
      ));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(boundary.followupRpcCalls).toBe(3);
      expect(SyntheticWebSocket.instances).toHaveLength(1);
      expect(framesOfType(ws, "response.create").filter((frame) =>
        frame.response?.metadata?.purpose === "tool_continuation"
      )).toHaveLength(1);
      expect(functionOutputs(ws)).toHaveLength(1);
      expect(control.ledger.onboarding!.pendingMutationCommands).toEqual({});
      expect(control.ledger.onboarding!.pendingMutationRetryTimers).toEqual({});
      expect(control.ledger.onboarding!.lifecycle.phase).not.toBe("blocked");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("a twice-indeterminate directed follow-up blocks without another output or running receipt", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-followup-exhausted");
    const boundary = sequentialAnswerBoundary([{
      status: "recorded",
      revision: 1,
      digest: "1".repeat(64),
    }], {
      followupAmbiguousAttempts: Number.POSITIVE_INFINITY,
      responseFromProjection: true,
    });
    _setClient(boundary.client);
    try {
      const control = attachSideband(
        cap,
        "rtc-followup-exhausted",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const ws = SyntheticWebSocket.instances[0]!;
      ws.emit("open");
      await control.opened;
      await completePhysicalGreeting(ws, cap);
      ws.message(responseCreated("resp-followup-exhausted"));
      ws.message(functionCallDone(
        "resp-followup-exhausted",
        "fc-followup-exhausted",
        "record_interview_answer",
        JSON.stringify({
          topic: "outro",
          field: "business.customer_types",
          disposition: "answered",
          rule_text: "Atende clientes residenciais.",
          structured: { value: ["residencial"] },
          owner_words: "Atendemos clientes residenciais.",
        }),
      ));
      ws.message(responseDone("resp-followup-exhausted"));
      await flushAsync();
      ws.message(outputAck(
        control.ledger,
        "fc-followup-exhausted",
      ));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(boundary.followupRpcCalls).toBe(4);
      expect(SyntheticWebSocket.instances).toHaveLength(1);
      expect(functionOutputs(ws)).toHaveLength(1);
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("blocked");
      expect(Object.values(control.ledger.onboarding!.lifecycle.toolOutbox)
        .some((receipt) => receipt.state === "running")).toBe(false);
      expect(control.ledger.onboarding!.pendingMutationCommands).toEqual({});
      expect(control.ledger.onboarding!.pendingMutationRetryTimers).toEqual({});
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = original;
      _setClient(null);
    }
  });

  test("a late-committed follow-up recovers on physical reattach and asks exactly one question without blocking", async () => {
    const original = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const cap = onboardingCap("call-late-followup-reattach");
    const sourceDigest = "a".repeat(64);
    const committedDigest = "b".repeat(64);
    const questionPt = "Quais cidades vocês atendem?";
    const committed = {
      id: "99999999-9999-4999-8999-999999999999",
      readback: {
        schema_version: 1,
        tenant_id: cap.tenantId,
        call_id: cap.callId,
        revision: 2,
        complete: false,
        snapshot: {
          ...createCoverage({ tenantId: cap.tenantId, callId: cap.callId }),
          revision: 2,
          followUps: 1,
          followUpGroups: { "area.coverage": 1 },
        },
        progress: {
          missingRequired: [{ field: "area.coverage" }],
          ambiguous: [],
        },
        selected_rule_ids: [],
        next_action: {
          type: "ask",
          field: "area.coverage",
          question_pt: questionPt,
        },
        snapshot_digest: committedDigest,
        authority: {
          rules_approved: false,
          powers_granted: false,
          operational_mode_changed: false,
        },
      },
      detail: {
        transition_kind: "directed_followup",
        source_revision: 1,
        source_digest: sourceDigest,
        field: "area.coverage",
        subject: null,
        question_pt: questionPt,
      },
    };
    let rpcCalls = 0;
    _setClient({
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        const query: any = {
          select() { return query; },
          eq(column: string, value: unknown) { filters.push([column, value]); return query; },
          in() { return query; }, order() { return query; }, limit() { return query; },
          maybeSingle: async () => ({
            data: table === "receipts" && filters.some(
                ([column]) => column === "external_id",
              )
              ? committed
              : null,
            error: null,
          }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              data: table === "receipts" ? [committed] : [],
              error: null,
            }).then(resolve);
          },
        };
        return query;
      },
      rpc() {
        rpcCalls += 1;
        return Promise.resolve({
          data: null,
          error: { message: "RPC must not rerun after exact late commit" },
        });
      },
    } as any);
    try {
      const control = attachSideband(
        cap,
        "rtc-late-followup-reattach",
        "gpt-realtime-2.1",
        onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);

      const adapter = control.ledger.onboarding!;
      const intentKey = "tool-batch:resp-late-followup:batch-late-followup";
      adapter.lifecycle.phase = "follow_up";
      adapter.lifecycle.coverage = {
        revision: 1,
        digest: sourceDigest,
        complete: false,
        missing: [{ field: "area.coverage" }],
        ambiguous: [],
        nextQuestion: { field: "area.coverage", questionPt },
      };
      adapter.lifecycle.pendingFollowup = {
        sourceRevision: 1,
        sourceDigest,
        field: "area.coverage",
        questionPt,
        intentKey,
      };
      const pendingFollowupCommand = {
        type: "persist_followup",
        revision: 1,
        digest: sourceDigest,
        field: "area.coverage",
        questionPt,
        intentKey,
      } as const;
      adapter.pendingMutationCommands["followup:1:area.coverage:"] = {
        command: pendingFollowupCommand,
        reconciliationAttempts: 0,
        retryScheduled: true,
        fingerprint: hashOnboardingToolArgs(pendingFollowupCommand),
      };
      let staleTimerFired = 0;
      adapter.pendingMutationRetryTimers["followup:1:area.coverage:"] =
        setTimeout(() => { staleTimerFired += 1; }, 900);

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const questions = framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.intent_key === intentKey,
      );
      expect(questions).toHaveLength(1);
      expect(questions[0].response.metadata.purpose).toBe("tool_continuation");
      expect(JSON.stringify(questions[0])).toContain(questionPt);
      expect(functionOutputs(second)).toHaveLength(0);
      expect(rpcCalls).toBe(0);
      expect(adapter.lifecycle.coverage).toMatchObject({
        revision: 2,
        digest: committedDigest,
      });
      expect(adapter.pendingMutationCommands).toEqual({});
      expect(adapter.pendingMutationRetryTimers).toEqual({});
      expect(staleTimerFired).toBe(0);
      expect(adapter.lifecycle.phase).not.toBe("blocked");
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
        cap, "rtc-final-close-reattach", "gpt-realtime-2.1", onboardingOptions,
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      await completePhysicalGreeting(first, cap);
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
        transcript:
          "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.",
        transcriptFinal: true,
        validated: true,
        audioDone: true,
        responseDone: true,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      lifecycle.responseIntents["final-signoff:approval-receipt-final"] = {
        intentKey: "final-signoff:approval-receipt-final",
        purpose: "final_signoff",
        state: "terminal",
        responseId: "resp-final-reattach",
        sentSocketGeneration: 1,
      };
      lifecycle.terminalResponseIds.push("resp-final-reattach");
      delete lifecycle.activeResponseId;
      control.ledger.responseActive = false;

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const retries = framesOfType(second, "response.create").filter(
        (frame) => frame.response?.metadata?.intent_key ===
          "final-signoff:approval-receipt-final:retry:1",
      );
      expect(retries).toHaveLength(1);
      second.message({
        type: "output_audio_buffer.stopped",
        response_id: "resp-final-reattach",
      });
      await flushAsync();
      expect(control.ledger.status).toBe("active");

      second.message(responseCreated(
        "resp-final-retry",
        "final-signoff:approval-receipt-final:retry:1",
      ));
      second.message({
        type: "response.output_audio_transcript.done",
        response_id: "resp-final-retry",
        transcript:
          "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.",
      });
      second.message({
        type: "response.output_audio.done",
        response_id: "resp-final-retry",
      });
      second.message(responseDone("resp-final-retry"));
      second.suppressCloseEvent = true;
      second.message({
        type: "output_audio_buffer.stopped",
        response_id: "resp-final-retry",
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
  const rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  let fetchCount = 0;
  _setClient({
    from(table: string) {
      const api: any = {
        update(row: any) { if (table === "calls") rows.push(row); return api; },
        select() { return api; }, eq() { return api; }, insert() { return api; },
        maybeSingle: async () => ({
          data: { id: "call-1", provider_termination_state: "confirmed" },
          error: null,
        }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args?: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "begin_provider_termination_attempt")
        return Promise.resolve({
          data: {
            should_attempt: true,
            attempt_id: "attempt-agent-ended",
            request_id: "request-agent-ended",
            openai_call_id: "rtc-call-1",
            provider_termination_mode: "hangup",
          },
          error: null,
        });
      if (name === "complete_provider_termination_attempt")
        return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: "reservation-1", error: null });
    },
  } as any);
  const cap = onboardingCap();
  const agentEnded = ledger(cap.callId);
  agentEnded.status = "ended";
  agentEnded.agentEnded = true;
  agentEnded.openaiCallId = "rtc-call-1";
  await persistLedger(cap, agentEnded, async () => {
    fetchCount += 1;
    return new Response(null, { status: 200 });
  });
  const callerEnded = ledger(cap.callId);
  callerEnded.status = "ended";
  await persistLedger(cap, callerEnded, async () => new Response(null, { status: 200 }));
  expect(rows[0].provider_termination_state).toBeUndefined();
  expect(rows[0].provider_termination_reason).toBeUndefined();
  expect(rpcCalls.find((call) =>
    call.name === "begin_provider_termination_attempt"
  )?.args?.p_reason).toBe("agent_ended_session");
  expect(fetchCount).toBe(1);
  expect(rows[1]).toMatchObject({
    provider_termination_state: "confirmed",
    provider_termination_reason: "caller_hung_up",
  });
});

test("application TTS cost participates in both the live kill switch and terminal settlement", async () => {
  const cap = customerCap("call-external-tts-cost");
  const overCap = ledger(cap.callId);
  (overCap as any).externalCostUsd = 2;
  const overCapSocket = socket();
  await handleEvent(cap, overCap, overCapSocket as any, responseDone("resp-cost"));
  expect(overCap.status).toBe("killed_budget");
  expect(overCapSocket.closed).toBe(1);

  const rows: Record<string, unknown>[] = [];
  const settlements: Record<string, unknown>[] = [];
  _setClient({
    from(table: string) {
      const api: any = {
        update(row: Record<string, unknown>) {
          if (table === "calls") rows.push(structuredClone(row));
          return api;
        },
        eq() { return api; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "settle_call_budget") settlements.push(structuredClone(args));
      return Promise.resolve({ data: "settled", error: null });
    },
  } as any);
  const settled = ledger(cap.callId);
  settled.status = "ended";
  settled.providerTerminalEvidence = {
    observed: true,
    reason: "provider_session_ended",
    receivedAt: "2026-08-27T21:00:00.000Z",
  };
  settled.providerUsageEvidence.terminal = true;
  (settled as any).externalCostUsd = 0.001605;
  expect(await persistLedger(cap, settled)).toBe(true);
  expect(rows[0]?.cost_estimate_usd).toBe(0.001605);
  expect((settlements[0] as any)?.p_actual_cost).toBe(0.001605);
});

test("the real Test 10 USD 1.52 shape remains active for onboarding while customer calls retain the USD 1.50 kill", async () => {
  const onboarding = onboardingCap("call-test-10-budget");
  const onboardingLedger = ledger(onboarding.callId);
  onboardingLedger.externalCostUsd = 1.52;
  onboardingLedger.startedAt = Date.now() - 432_000;
  const onboardingSocket = socket();
  await handleEvent(
    onboarding,
    onboardingLedger,
    onboardingSocket as any,
    responseDone("resp-test-10-budget"),
  );
  expect(onboardingLedger.status).toBe("active");
  expect(onboardingSocket.closed).toBe(0);

  const customer = customerCap("call-customer-budget");
  const customerLedger = ledger(customer.callId);
  customerLedger.externalCostUsd = 1.52;
  const customerSocket = socket();
  await handleEvent(
    customer,
    customerLedger,
    customerSocket as any,
    responseDone("resp-customer-budget"),
  );
  expect(customerLedger.status).toBe("killed_budget");
  expect(customerSocket.closed).toBe(1);
});

test("onboarding soft limit speaks once and closes only after the truthful pause playback is confirmed", async () => {
  const cap = onboardingCap("call-budget-pause");
  const l = ledger(cap.callId);
  const ws = socket();
  await completeGreetingTrace(cap, l, ws, "resp-budget-greeting");
  ws.sent = [];
  l.externalCostUsd = 6.5;
  await handleEvent(cap, l, ws as any, responseCreated("resp-before-budget-pause"));
  await handleEvent(cap, l, ws as any, responseDone("resp-before-budget-pause"));
  const pauseCreates = framesOfType(ws, "response.create").filter((frame) =>
    frame.response?.metadata?.purpose === "budget_pause"
  );
  expect(pauseCreates).toHaveLength(1);
  expect(pauseCreates[0]?.response?.tool_choice).toBe("none");
  expect(l.status).toBe("active");
  expect(ws.closed).toBe(0);

  const intentKey = `budget-pause:${cap.callId}`;
  await handleEvent(cap, l, ws as any, responseCreated("resp-budget-pause", intentKey));
  await handleEvent(cap, l, ws as any, {
    type: "response.output_audio_transcript.done",
    response_id: "resp-budget-pause",
    transcript:
      "Estamos chegando ao limite desta sessão. Suas informações foram salvas. Vou encerrar esta sessão agora.",
  });
  await handleEvent(cap, l, ws as any, {
    type: "response.output_audio.done",
    response_id: "resp-budget-pause",
  });
  await handleEvent(cap, l, ws as any, responseDone("resp-budget-pause", {
    usage: {
      input_tokens: 0,
      output_tokens: 100,
      total_tokens: 100,
      input_token_details: {
        text_tokens: 0,
        audio_tokens: 0,
        cached_tokens: 0,
        cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 0, audio_tokens: 100 },
    },
  }));
  expect(l.status).toBe("active");
  expect(ws.closed).toBe(0);
  await handleEvent(cap, l, ws as any, {
    type: "output_audio_buffer.stopped",
    response_id: "resp-budget-pause",
  });
  expect(l.status).toBe("killed_budget");
  expect(ws.closed).toBe(1);
  expect(l.onboarding?.lifecycle.phase)
    .toBe("budget_pause_provider_terminating" as any);

  await handleEvent(cap, l, ws as any, {
    type: "output_audio_buffer.stopped",
    response_id: "resp-budget-pause",
  });
  expect(ws.closed).toBe(1);
  expect(framesOfType(ws, "response.create").filter((frame) =>
    frame.response?.metadata?.purpose === "budget_pause"
  )).toHaveLength(1);
});

test("duplicate response.done usage cannot manufacture a soft pause and USD 7.50 remains a hard fail-closed bound", async () => {
  const validUsage = {
    input_tokens: 0,
    output_tokens: 52_000,
    total_tokens: 52_000,
    input_token_details: {
      text_tokens: 0,
      audio_tokens: 0,
      cached_tokens: 0,
      cached_tokens_details: { text_tokens: 0, audio_tokens: 0 },
    },
    output_token_details: { text_tokens: 0, audio_tokens: 52_000 },
  };
  const cap = onboardingCap("call-duplicate-usage");
  const l = ledger(cap.callId);
  const ws = socket();
  await completeGreetingTrace(cap, l, ws, "resp-duplicate-greeting");
  ws.sent = [];
  const done = responseDone("resp-duplicate-usage", { usage: validUsage });
  await handleEvent(cap, l, ws as any, done);
  await handleEvent(cap, l, ws as any, done);
  expect(l.usage.audioOut).toBe(52_000);
  expect(framesOfType(ws, "response.create").filter((frame) =>
    frame.response?.metadata?.purpose === "budget_pause"
  )).toHaveLength(0);
  expect(l.status).toBe("active");

  const hard = onboardingCap("call-hard-budget");
  const hardLedger = ledger(hard.callId);
  hardLedger.externalCostUsd = 7.5;
  const hardSocket = socket();
  await handleEvent(
    hard,
    hardLedger,
    hardSocket as any,
    responseDone("resp-hard-budget"),
  );
  expect(hardLedger.status).toBe("killed_budget");
  expect(hardSocket.closed).toBe(1);
  expect(framesOfType(hardSocket, "response.create").filter((frame) =>
    frame.response?.metadata?.purpose === "budget_pause"
  )).toHaveLength(0);
});

test("partial response.done spend is retained as an unresolved durable lower bound", async () => {
  const cap = onboardingCap("call-partial-usage-floor");
  const l = ledger(cap.callId);
  l.status = "killed_budget";
  l.externalCostUsd = 0.001605;
  l.usage.audioOut = 23_725;
  l.providerUsageEvidence.eventCount = 1;
  l.providerUsageEvidence.lastResponseId = "resp-partial-floor";
  l.providerUsageEvidence.lastReceivedAt = "2026-08-28T16:33:22.297Z";
  l.providerUsageEvidence.terminal = false;
  const rows: Record<string, unknown>[] = [];
  _setClient({
    from(table: string) {
      const api: any = {
        update(row: Record<string, unknown>) {
          if (table === "calls") rows.push(structuredClone(row));
          return api;
        },
        select() { return api; },
        eq() { return api; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  } as any);

  await persistLedger(cap, l);
  expect(rows[0]).toMatchObject({
    status: "killed_budget",
    provider_usage_state: "unknown",
    usage_tokens: null,
    cost_estimate_usd: 1.520005,
  });
});

afterAll(() => _setClient(null));
