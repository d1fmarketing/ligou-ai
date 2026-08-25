// Reproduces the 2026-08-24 onboarding stall (call ec929149): the model answered one
// interview topic with speech plus three record_interview_answer calls in a single
// response. The sideband issued `response.create` per completed function_call while the
// parent response was still streaming, OpenAI rejected the continuation
// ("Conversation already has an active response in progress"), and the generic error
// handler killed the session. The interview must be self-driving: exactly one
// continuation, issued only once no response is active, and that provider error must
// never be terminal.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import { _setClient } from "../src/rules.ts";
import { attachSideband, handleEvent, liveSessions, persistLedger, type SessionLedger } from "../src/sideband.ts";
import { makeCapability, runTool } from "../src/tools.ts";

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
function functionCallDone(callId: string, name = "not_a_real_tool", args = "{}", responseId?: string) {
  return {
    type: "response.output_item.done",
    response_id: responseId,
    item: { type: "function_call", name, call_id: callId, arguments: args },
  };
}

const LONG_RECAP = "Resumo completo: desentupimento 225 dólares com mínimo de 175 e uma hora; conserto de vazamento 320 com mínimo 260 e noventa minutos; diagnóstico hidráulico 129 fixo sem desconto. Atendemos Novato, San Rafael e Petaluma, de segunda a sábado das 8 às 18, nunca domingo. Aprove tudo na aba Memória. Até mais!";

afterEach(() => { _setClient(null); });

// The end_session refusal and the recap push both read the persisted snapshot; a fast
// empty-rules client keeps those paths instant in unit tests.
function emptyRulesClient() {
  return {
    from() {
      const api: any = {
        select() { return api; }, eq() { return api; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
  } as any;
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

  test("a stale tool call from a superseded socket cannot corrupt the new generation's batch counter", async () => {
    const l = ledger();
    let socketACurrent = true;
    const isSocketA = () => socketACurrent;
    const wsA = socket();
    const wsB = socket();

    // fc_X is still executing on socket A when the socket drops and a reattach resets the counter.
    const pX = handleEvent(cap, l, wsA as any, functionCallDone("fc_X"), isSocketA);
    socketACurrent = false;
    l.responseActive = false;
    l.pendingToolCalls = 0;

    // A fresh batch of two tool calls streams on socket B; its response finishes while both run.
    const pCreated = handleEvent(cap, l, wsB as any, { type: "response.created" });
    const pY = handleEvent(cap, l, wsB as any, functionCallDone("fc_Y"));
    const pZ = handleEvent(cap, l, wsB as any, functionCallDone("fc_Z"));
    const pDone = handleEvent(cap, l, wsB as any, { type: "response.done", response: {} });
    await Promise.all([pX, pCreated, pY, pZ, pDone]);

    // The stale fc_X must neither speak on the old socket nor release socket B's continuation early.
    expect(wsA.sent).toHaveLength(0);
    expect(sentTypes(wsB)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
    expect(l.pendingToolCalls).toBe(0);
  });

  test("a tool batch straddling response.done continues exactly once, after the last output", async () => {
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    // Both tool calls are still executing when the parent response finishes.
    const p1 = handleEvent(cap, l, ws as any, functionCallDone("fc_1"));
    const p2 = handleEvent(cap, l, ws as any, functionCallDone("fc_2"));
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await p1;
    await p2;
    expect(sentTypes(ws)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
    expect(l.status).toBe("active");
  });
});

describe("agent-initiated session end (end_session)", () => {
  test("end_session is a pure close signal: allowed in onboarding, denied elsewhere, no tenant access", async () => {
    const allowed = await runTool(cap, "end_session", {});
    expect(allowed.ok).toBe(true);
    const customerCap = makeCapability("rocha-plumbing", "tenant-1", "call-2", 15, "customer", {
      authEpoch: 1, policyEpoch: 1,
    });
    const denied = await runTool(customerCap, "end_session", {});
    expect(denied.ok).toBe(false);
    expect(denied.body.error).toBe("tool_not_allowed");
  });

  test("after the farewell response finishes, the session closes within the grace period", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, functionCallDone("fc_end", "end_session"));

    // The output goes back, but no continuation is requested and nothing closes mid-response.
    expect(sentTypes(ws).filter((t) => t === "conversation.item.create")).toHaveLength(1);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);
    expect(l.agentEndRequested).toBe(true);
    expect(l.status).toBe("active");

    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(l.status).toBe("active");
    expect(ws.closed).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(l.status).toBe("ended");
    expect(l.agentEnded).toBe(true);
    expect(ws.closed).toBe(1);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);
    expect(l.transcript.some((entry) => entry.role === "system" && entry.text.includes("end_session"))).toBe(true);
  });

  test("a provider session end before the grace expires wins and is not double-closed", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, functionCallDone("fc_end", "end_session"));
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await handleEvent(cap, l, ws as any, { type: "session.ended" });
    expect(l.status).toBe("ended");
    expect(ws.closed).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ws.closed).toBe(1);
    expect(l.agentEnded).toBeUndefined();
  });

  test("end_session wins over a sibling tool still executing at response.done: outputs delivered, no extra turn, then close", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    const pSibling = handleEvent(cap, l, ws as any, functionCallDone("fc_rec"));
    const pEnd = handleEvent(cap, l, ws as any, functionCallDone("fc_end", "end_session"));
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await pSibling;
    await pEnd;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sentTypes(ws).filter((t) => t === "conversation.item.create")).toHaveLength(2);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);
    expect(l.status).toBe("ended");
    expect(ws.closed).toBe(1);
  });

  test("a pending continuation from a sibling tool is suppressed once end_session is honored", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    const l = ledger();
    const ws = socket();
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, functionCallDone("fc_rec"));
    await handleEvent(cap, l, ws as any, functionCallDone("fc_end", "end_session"));
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);
    expect(l.status).toBe("ended");
    expect(ws.closed).toBe(1);
  });

  test("end_session is refused until the agent speaks after the last recorded rule (test-3 stall)", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    const RECAP_TENANT = {
      id: "tenant-1", slug: "recap-plumbing", name: "Recap Plumbing", vertical: "plumbing",
      languages: ["en"], timezone: "America/Los_Angeles", session_max_minutes: 15,
      owner_user_id: "u-1", auth_epoch: 1, policy_epoch: 1,
    };
    _setClient({
      from(table: string) {
        const api: any = {
          select() { return api; }, eq() { return api; }, insert() { return api; },
          update() { return api; }, upsert() { return api; },
          single: async () => (table === "tenants"
            ? { data: RECAP_TENANT, error: null }
            : { data: { id: "rule-1" }, error: null }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return api;
      },
      rpc() { return Promise.resolve({ data: "reservation-1", error: null }); },
    } as any);
    const recapCap = makeCapability("recap-plumbing", "tenant-1", "call-recap", 15, "onboarding", {
      authEpoch: 1, policyEpoch: 1,
    });
    try {
      const l = ledger();
      const ws = socket();

      // Final rules land, then the model tries to hang up without speaking the recap.
      await handleEvent(recapCap, l, ws as any, { type: "response.created" });
      await handleEvent(recapCap, l, ws as any, functionCallDone("fc_rec", "record_interview_answer",
        JSON.stringify({ topic: "outro", rule_text: "Never negotiate below approved minimums." })));
      expect(l.pendingRecapAfterRecords).toBe(true);
      await handleEvent(recapCap, l, ws as any, { type: "response.done", response: {} });
      await handleEvent(recapCap, l, ws as any, { type: "response.created" });
      await handleEvent(recapCap, l, ws as any, functionCallDone("fc_end1", "end_session"));
      const rejected = JSON.parse(ws.sent.filter((raw) => JSON.parse(raw).type === "conversation.item.create").at(-1)!);
      expect(JSON.parse(rejected.item.output).error).toBe("recap_required");
      expect(l.agentEndRequested).toBeUndefined();

      // The refusal prompts a new turn instead of silence (one continuation after the
      // record, one after the refused end_session).
      await handleEvent(recapCap, l, ws as any, { type: "response.done", response: {} });
      expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(l.status).toBe("active");

      // The agent speaks the recap; a second end_session is now honored.
      await handleEvent(recapCap, l, ws as any, { type: "response.created" });
      await handleEvent(recapCap, l, ws as any, {
        type: "response.output_audio_transcript.done",
        response_id: "resp_recap",
        transcript: LONG_RECAP,
      });
      expect(l.pendingRecapAfterRecords).toBe(false);
      await handleEvent(recapCap, l, ws as any, functionCallDone("fc_end2", "end_session"));
      expect(l.agentEndRequested).toBe(true);
      await handleEvent(recapCap, l, ws as any, { type: "response.done", response: {} });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(l.status).toBe("ended");
      expect(l.agentEnded).toBe(true);
      expect(ws.closed).toBe(1);
      expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(2);
    } finally {
      _setClient(null);
    }
  });

  test("a short promise in a later response does not satisfy the recap gate (test-4 replay)", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    _setClient(emptyRulesClient());
    const l = ledger();
    const ws = socket();
    // Response A: "vou registrar" ack + the registration itself.
    l.pendingRecapAfterRecords = true;
    l.recapBlockedResponseId = "resp_a";
    l.postRecordSpeechChars = 0;
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "resp_a",
      transcript: "Certo, vou registrar essas regras extras como políticas operacionais.",
    });
    // Response B: the promise, then a bare end_session in the same breath.
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "resp_b",
      transcript: "Vou recapitular tudo rapidinho para você aprovar, e já encerramos.",
    });
    expect(l.pendingRecapAfterRecords).toBe(true);
    await handleEvent(cap, l, ws as any, functionCallDone("fc_end", "end_session", "{}", "resp_b"));
    expect(l.agentEndRequested).toBeUndefined();
    const rejected = JSON.parse(ws.sent.filter((raw) => JSON.parse(raw).type === "conversation.item.create").at(-1)!);
    expect(JSON.parse(rejected.item.output).error).toBe("recap_required");

    // Response C: the real, substantive recap — now the close is honored.
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done",
      response_id: "resp_c",
      transcript: LONG_RECAP,
    });
    expect(l.pendingRecapAfterRecords).toBe(false);
    await handleEvent(cap, l, ws as any, functionCallDone("fc_end2", "end_session", "{}", "resp_c"));
    expect(l.agentEndRequested).toBe(true);
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(l.status).toBe("ended");
    expect(ws.closed).toBe(1);
  });

  test("short utterances across turns never sum into a fake recap", async () => {
    const l = ledger();
    const ws = socket();
    l.pendingRecapAfterRecords = true;
    l.recapBlockedResponseId = "resp_a";
    // Three ~80-char turns in three different responses: 240 chars total, none substantive.
    const chatter = "Só um instante enquanto eu organizo tudo aqui pra você, tá bom? Já volto com o resumo.";
    for (const rid of ["resp_b", "resp_c", "resp_d"]) {
      await handleEvent(cap, l, ws as any, { type: "response.output_audio_transcript.done", response_id: rid, transcript: chatter });
    }
    expect(l.pendingRecapAfterRecords).toBe(true);
    // One substantive response (even split across two transcript items) does clear it.
    await handleEvent(cap, l, ws as any, { type: "response.output_audio_transcript.done", response_id: "resp_e", transcript: LONG_RECAP.slice(0, 150) });
    await handleEvent(cap, l, ws as any, { type: "response.output_audio_transcript.done", response_id: "resp_e", transcript: LONG_RECAP.slice(150) });
    expect(l.pendingRecapAfterRecords).toBe(false);
  });

  test("the recap gate is best-effort: after two refusals, or a text turn, end_session is honored", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    _setClient(emptyRulesClient());
    // Two refusals cap the guard even when no transcript event ever arrives.
    const l = ledger();
    const ws = socket();
    l.pendingRecapAfterRecords = true;
    await handleEvent(cap, l, ws as any, functionCallDone("fc_e1", "end_session"));
    await handleEvent(cap, l, ws as any, functionCallDone("fc_e2", "end_session"));
    expect(l.agentEndRequested).toBeUndefined();
    expect(l.recapRefusals).toBe(2);
    await handleEvent(cap, l, ws as any, functionCallDone("fc_e3", "end_session"));
    expect(l.agentEndRequested).toBe(true);

    // A substantive text-modality turn also clears the pending recap.
    const l2 = ledger();
    l2.pendingRecapAfterRecords = true;
    await handleEvent(cap, l2, socket() as any, { type: "response.output_text.done", response_id: "resp_t", text: LONG_RECAP });
    expect(l2.pendingRecapAfterRecords).toBe(false);
  });

  test("an agent-ended call still gets the audited provider hangup; a caller hangup does not", async () => {
    const rows: any[] = [];
    _setClient({
      from(table: string) {
        const api: any = {
          update(row: any) { if (table === "calls") rows.push(row); return api; },
          eq() { return api; },
          insert() { return api; },
          then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(resolve); },
        };
        return api;
      },
      rpc() { return Promise.resolve({ data: "reservation-1", error: null }); },
    } as any);
    try {
      const agentEnded = ledger();
      agentEnded.status = "ended";
      agentEnded.agentEnded = true;
      await persistLedger(cap, agentEnded, async () => new Response(null, { status: 200 }));
      const callerEnded = ledger();
      callerEnded.status = "ended";
      await persistLedger(cap, callerEnded, async () => new Response(null, { status: 200 }));
    } finally {
      _setClient(null);
    }
    expect(rows[0].provider_termination_state).toBe("active");
    expect(rows[0].provider_termination_reason).toBe("agent_ended_session");
    expect(rows[1].provider_termination_state).toBe("confirmed");
    expect(rows[1].provider_termination_reason).toBe("caller_hung_up");
  });
});

afterAll(() => {
  delete process.env.LIGOU_AGENT_END_GRACE_MS;
  _setClient(null);
});

describe("agent speaks first and the owed recap is pushed", () => {
  test("a browser session greets on first attach only — never again on reattach", async () => {
    class SyntheticWebSocket {
      static instances: SyntheticWebSocket[] = [];
      listeners = new Map<string, Array<(event: any) => void>>();
      sent: string[] = [];
      constructor() { SyntheticWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(payload: string) { this.sent.push(payload); }
      close() { this.emit("close", { code: 1000 }); }
      emit(type: string, event: any = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const greetCap = makeCapability("rocha-plumbing", "tenant-1", "call-greet", 15, "onboarding", {
      authEpoch: 1, policyEpoch: 1,
    });
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = SyntheticWebSocket as any;
    try {
      const control = attachSideband(greetCap, "rtc-greet", "gpt-realtime-2.1");
      SyntheticWebSocket.instances[0]!.emit("open");
      await control.opened;
      const first = SyntheticWebSocket.instances[0]!;
      expect(first.sent.map((raw) => JSON.parse(raw).type).filter((t) => t === "response.create")).toHaveLength(1);
      expect(control.ledger.greetingRequested).toBe(true);
      expect(control.ledger.responseActive).toBe(true);

      // Drop and reattach: the greeting must not repeat (no owed turn either).
      control.ledger.responseActive = false;
      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1];
      expect(second).toBeDefined();
      second!.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(second!.sent.map((raw) => JSON.parse(raw).type).filter((t) => t === "response.create")).toHaveLength(0);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete("call-greet");
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("promise-turns while a recap is owed get bounded pushes; user speech cancels the pending push", async () => {
    process.env.LIGOU_RECAP_PUSH_DELAY_MS = "40";
    _setClient(emptyRulesClient());
    const l = ledger();
    const ws = socket();
    l.pendingRecapAfterRecords = true;
    l.recapBlockedResponseId = "resp_a";

    // Turn 1: a short promise ("vou recapitular…") and then silence.
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done", response_id: "resp_b",
      transcript: "Vou recapitular tudo rapidinho para você validar.",
    });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(1);
    expect(l.recapPushes).toBe(1);

    // Turn 2: another promise, but the owner starts talking before the push fires.
    // The cancelled attempt still consumes a slot — the bound counts schedules, not fires.
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    expect(l.recapPushes).toBe(2);
    await handleEvent(cap, l, ws as any, { type: "input_audio_buffer.speech_started" });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(1);

    // Turns 3-4: idle again — one final push remains, then the bound stops everything.
    for (const _ of [3, 4]) {
      await handleEvent(cap, l, ws as any, { type: "response.created" });
      await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    expect(l.recapPushes).toBe(3);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(2);

    // A substantive recap clears the debt — no further pushes get scheduled.
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, {
      type: "response.output_audio_transcript.done", response_id: "resp_final", transcript: LONG_RECAP,
    });
    expect(l.pendingRecapAfterRecords).toBe(false);
  });
});

describe("response coordinator invariants (voice-orchestration contract)", () => {
  const COORD_TENANT = {
    id: "tenant-1", slug: "coord-plumbing", name: "Coord Plumbing", vertical: "plumbing",
    languages: ["en"], timezone: "America/Los_Angeles", session_max_minutes: 15,
    owner_user_id: "u-1", auth_epoch: 1, policy_epoch: 1,
  };
  function recordingClient(ruleRows: Array<Record<string, unknown>> = []) {
    const inserts: Array<Record<string, unknown>> = [];
    const client = {
      from(table: string) {
        const api: any = {
          select() { return api; }, eq() { return api; },
          insert(row: any) { inserts.push({ table, ...row }); return api; },
          update() { return api; }, upsert() { return api; },
          single: async () => (table === "tenants"
            ? { data: COORD_TENANT, error: null }
            : { data: { id: `row-${inserts.length}` }, error: null }),
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: table === "rules" ? ruleRows : [], error: null }).then(resolve);
          },
        };
        return api;
      },
      rpc() { return Promise.resolve({ data: "reservation-1", error: null }); },
    } as any;
    return { client, inserts };
  }
  const coordCap = () => makeCapability("coord-plumbing", "tenant-1", "call-coord", 15, "onboarding", {
    authEpoch: 1, policyEpoch: 1,
  });

  test("a duplicated response.output_item.done runs the tool once, sends one output, earns one continuation", async () => {
    const { client, inserts } = recordingClient();
    _setClient(client);
    const c = coordCap();
    const l = ledger();
    const ws = socket();
    const fc = functionCallDone("fc_dup", "record_interview_answer",
      JSON.stringify({ topic: "outro", rule_text: "Never negotiate below approved minimums." }), "resp_a");
    await handleEvent(c, l, ws as any, { type: "response.created" });
    await handleEvent(c, l, ws as any, fc);
    await handleEvent(c, l, ws as any, fc); // replayed event, same call_id
    await handleEvent(c, l, ws as any, { type: "response.done", response: {} });

    expect(inserts.filter((row) => row.table === "rules")).toHaveLength(1);
    const outputs = ws.sent.map((raw) => JSON.parse(raw))
      .filter((f) => f.type === "conversation.item.create" && f.item?.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(1);
    expect(l.executedToolCallIds).toEqual(["fc_dup"]);
  });

  test("the forced recap turn injects the persisted snapshot before the response", async () => {
    process.env.LIGOU_RECAP_PUSH_DELAY_MS = "40";
    const { client } = recordingClient([
      { category: "preco", text: "Drain cleaning 225 target, 175 floor.", structured: { service_type: "drain_cleaning", price_min: 175, price_target: 225 } },
      { category: "area", text: "Serve only Novato, San Rafael, Petaluma.", structured: null },
    ]);
    _setClient(client);
    const l = ledger();
    const ws = socket();
    l.pendingRecapAfterRecords = true;
    l.recapBlockedResponseId = "resp_a";
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const frames = ws.sent.map((raw) => JSON.parse(raw));
    const snapshotItem = frames.find((f) => f.type === "conversation.item.create" && f.item?.role === "system");
    expect(snapshotItem).toBeDefined();
    expect(snapshotItem.item.content[0].text).toContain("DADOS REGISTRADOS NESTA ENTREVISTA");
    expect(snapshotItem.item.content[0].text).toContain("drain_cleaning");
    // The snapshot precedes the pushed response.create.
    const snapIdx = frames.indexOf(snapshotItem);
    const createIdx = frames.findIndex((f) => f.type === "response.create");
    expect(createIdx).toBeGreaterThan(snapIdx);
  });

  test("speech starting during the snapshot fetch aborts the push (no talking over the owner)", async () => {
    process.env.LIGOU_RECAP_PUSH_DELAY_MS = "40";
    // The rules read resolves only after 80ms — speech arrives inside that window.
    const slowClient = {
      from() {
        const api: any = {
          select() { return api; }, eq() { return api; },
          then(resolve: (value: unknown) => unknown) {
            return new Promise((r) => setTimeout(() => r({ data: [{ category: "preco", text: "x", structured: null }], error: null }), 80)).then(resolve);
          },
        };
        return api;
      },
      rpc() { return Promise.resolve({ data: null, error: null }); },
    } as any;
    _setClient(slowClient);
    const l = ledger();
    const ws = socket();
    l.pendingRecapAfterRecords = true;
    l.recapBlockedResponseId = "resp_a";
    await handleEvent(cap, l, ws as any, { type: "response.created" });
    await handleEvent(cap, l, ws as any, { type: "response.done", response: {} });
    // Timer fires at 40ms and starts the fetch; the owner speaks at ~60ms, mid-await.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handleEvent(cap, l, ws as any, { type: "input_audio_buffer.speech_started" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(0);
  });

  test("text-only onboarding: records → owed recap → grounded summary turn → honored close (Layer B)", async () => {
    process.env.LIGOU_RECAP_PUSH_DELAY_MS = "40";
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    const { client, inserts } = recordingClient([
      { category: "preco", text: "Drain cleaning 225/175/60.", structured: { service_type: "drain_cleaning", price_min: 175, price_target: 225, duration_min: 60 } },
    ]);
    _setClient(client);
    const c = coordCap();
    const l = ledger();
    const ws = socket();

    // Five topics: each turn registers and continues exactly once.
    for (let topic = 0; topic < 5; topic += 1) {
      await handleEvent(c, l, ws as any, { type: "response.created" });
      await handleEvent(c, l, ws as any, functionCallDone(`fc_t${topic}`, "record_interview_answer",
        JSON.stringify({ topic: "outro", rule_text: `Rule for topic ${topic}.` }), `resp_t${topic}`));
      await handleEvent(c, l, ws as any, { type: "response.done", response: {} });
    }
    expect(inserts.filter((row) => row.table === "rules")).toHaveLength(5);
    expect(sentTypes(ws).filter((t) => t === "response.create")).toHaveLength(5);
    expect(l.pendingRecapAfterRecords).toBe(true);

    // The model idles on a promise: the coordinator forces the grounded summary turn.
    await handleEvent(c, l, ws as any, { type: "response.created" });
    await handleEvent(c, l, ws as any, {
      type: "response.output_audio_transcript.done", response_id: "resp_promise",
      transcript: "Vou recapitular tudo rapidinho.",
    });
    await handleEvent(c, l, ws as any, { type: "response.done", response: {} });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(l.phase).toBe("summarizing");

    // The pushed turn speaks the real summary; the owner approves; the close is honored.
    await handleEvent(c, l, ws as any, {
      type: "response.output_audio_transcript.done", response_id: "resp_summary", transcript: LONG_RECAP,
    });
    expect(l.pendingRecapAfterRecords).toBe(false);
    await handleEvent(c, l, ws as any, { type: "response.done", response: {} });
    await handleEvent(c, l, ws as any, { type: "response.created" });
    await handleEvent(c, l, ws as any, functionCallDone("fc_end", "end_session", "{}", "resp_end"));
    expect(l.agentEndRequested).toBe(true);
    await handleEvent(c, l, ws as any, { type: "response.done", response: {} });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(l.status).toBe("ended");
    expect(l.agentEnded).toBe(true);
    expect(l.phase).toBe("closing");
    expect(ws.closed).toBe(1);
  });
});

describe("sideband reattach continuation state", () => {
  test("a reattached socket clears stale streaming flags and re-requests the owed turn", async () => {
    class SyntheticWebSocket {
      static instances: SyntheticWebSocket[] = [];
      listeners = new Map<string, Array<(event: any) => void>>();
      sent: string[] = [];
      constructor() { SyntheticWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(payload: string) { this.sent.push(payload); }
      close() { this.emit("close", { code: 1000 }); }
      emit(type: string, event: any = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const reattachCap = makeCapability("rocha-plumbing", "tenant-1", "call-reattach", 15, "onboarding", {
      authEpoch: 1, policyEpoch: 1,
    });
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = SyntheticWebSocket as any;
    try {
      const control = attachSideband(reattachCap, "rtc-reattach", "gpt-realtime-2.1");
      SyntheticWebSocket.instances[0]!.emit("open");
      await control.opened;

      // The socket drops mid-response with a turn still owed from a delivered tool output.
      control.ledger.responseActive = true;
      control.ledger.continuationWanted = true;
      control.ledger.pendingToolCalls = 0;
      SyntheticWebSocket.instances[0]!.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));

      const second = SyntheticWebSocket.instances[1];
      expect(second).toBeDefined();
      second!.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const types = second!.sent.map((raw) => JSON.parse(raw).type);
      expect(types.filter((t) => t === "response.create")).toHaveLength(1);
      expect(control.ledger.pendingToolCalls).toBe(0);
      expect(control.ledger.status).toBe("active");
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete("call-reattach");
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("a reattach mid-farewell still schedules the agent end (no lost close)", async () => {
    process.env.LIGOU_AGENT_END_GRACE_MS = "40";
    class SyntheticWebSocket {
      static instances: SyntheticWebSocket[] = [];
      listeners = new Map<string, Array<(event: any) => void>>();
      sent: string[] = [];
      closed = 0;
      constructor() { SyntheticWebSocket.instances.push(this); }
      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(payload: string) { this.sent.push(payload); }
      close() { this.closed += 1; this.emit("close", { code: 1000 }); }
      emit(type: string, event: any = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const endCap = makeCapability("rocha-plumbing", "tenant-1", "call-end-reattach", 15, "onboarding", {
      authEpoch: 1, policyEpoch: 1,
    });
    _setClient({
      from() {
        const api: any = {
          update() { return api; }, eq() { return api; }, insert() { return api; },
          then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(resolve); },
        };
        return api;
      },
      rpc() { return Promise.resolve({ data: "reservation-1", error: null }); },
    } as any);
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = SyntheticWebSocket as any;
    try {
      const control = attachSideband(endCap, "rtc-end-reattach", "gpt-realtime-2.1", {
        fetchImpl: async () => new Response(null, { status: 200 }),
      });
      SyntheticWebSocket.instances[0]!.emit("open");
      await control.opened;

      // end_session was honored on socket A while its farewell was still streaming; then the socket drops.
      control.ledger.agentEndRequested = true;
      control.ledger.responseActive = true;
      SyntheticWebSocket.instances[0]!.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));

      const second = SyntheticWebSocket.instances[1];
      expect(second).toBeDefined();
      second!.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(second!.sent.map((raw) => JSON.parse(raw).type).filter((t) => t === "response.create")).toHaveLength(0);
      expect(control.ledger.status).toBe("ended");
      expect(control.ledger.agentEnded).toBe(true);
    } finally {
      liveSessions.delete("call-end-reattach");
      globalThis.WebSocket = originalWebSocket;
      _setClient(null);
    }
  });
});
