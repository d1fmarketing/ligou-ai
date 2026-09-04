import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import {
  BUDGET_PAUSE_SENTENCE_PT,
  FINAL_SIGNOFF_SENTENCE_PT,
} from "../src/onboarding-coordinator.ts";
import { _setClient } from "../src/rules.ts";
import { attachSideband, handleEvent, liveSessions, persistLedger, terminalStatusForReason, type SessionLedger } from "../src/sideband.ts";
import { makeCapability } from "../src/tools.ts";

let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let directUsageInserts = 0;
let callUpdates: any[] = [];

function client() {
  return {
    from(table: string) {
      const api: any = {
        update(row: any) { if (table === "calls") callUpdates.push(row); return api; }, eq() { return api; },
        select() { return api; },
        maybeSingle: async () => table === "calls"
          ? {
              data: {
                id: "call-1",
                provider_termination_state: "active",
              },
              error: null,
            }
          : { data: null, error: null },
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

class SyntheticWebSocket {
  static instances: SyntheticWebSocket[] = [];
  static throwOnSend = false;
  listeners = new Map<string, Array<(event: any) => void>>();
  closed = 0;
  sent: string[] = [];
  constructor() { SyntheticWebSocket.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(payload: string) {
    if (SyntheticWebSocket.throwOnSend) throw new Error("synthetic send failure");
    this.sent.push(payload);
  }
  close() { this.closed += 1; this.emit("close", { code: 1000 }); }
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function emitTranscriptAndFunctionCall(socket: SyntheticWebSocket, marker: string) {
  socket.emit("message", { data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: marker,
  }) });
  socket.emit("message", { data: JSON.stringify({
    type: "response.output_item.done",
    item: { type: "function_call", name: "synthetic_forbidden_tool", call_id: marker, arguments: "{}" },
  }) });
}

function installSyntheticClock() {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const timeouts = new Map<any, () => void>();
  const intervals = new Map<any, () => void>();
  let sequence = 0;
  globalThis.setTimeout = ((callback: () => void) => {
    const id = { kind: "timeout", id: ++sequence };
    timeouts.set(id, callback);
    return id;
  }) as any;
  globalThis.clearTimeout = ((id: any) => { timeouts.delete(id); }) as any;
  globalThis.setInterval = ((callback: () => void) => {
    const id = { kind: "interval", id: ++sequence };
    intervals.set(id, callback);
    return id;
  }) as any;
  globalThis.clearInterval = ((id: any) => { intervals.delete(id); }) as any;
  return {
    timeouts,
    intervals,
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.setInterval = original.setInterval;
      globalThis.clearInterval = original.clearInterval;
    },
  };
}

function phoneLifecycleClient(options: { errors?: Set<string> } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (options.errors?.has(name)) return Promise.resolve({ data: null, error: { message: `synthetic_${name}_failure` } });
        if (name === "finalize_phone_sideband") {
          return Promise.resolve({ data: { should_attempt: false }, error: null });
        }
        return Promise.resolve({ data: true, error: null });
      },
      from(table: string) {
        const api: any = {
          update(row: any) { if (table === "calls") callUpdates.push(row); return api; },
          eq() { return api; },
          then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(resolve); },
        };
        return api;
      },
    } as any,
  };
}

function deferredPhoneActivationClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let resolveConfirmation!: (value: { data: boolean; error: null }) => void;
  let rejectConfirmation!: (error: Error) => void;
  const confirmation = new Promise<{ data: boolean; error: null }>((resolve, reject) => {
    resolveConfirmation = resolve;
    rejectConfirmation = reject;
  });
  return {
    calls,
    confirm() { resolveConfirmation({ data: true, error: null }); },
    fail(error: Error) { rejectConfirmation(error); },
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "confirm_phone_sideband") return confirmation;
        return Promise.resolve({ data: true, error: null });
      },
    } as any,
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

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
    expectedOnboardingBusinessName: "Rocha Plumbing",
  };
}

describe("sideband budget finalization", () => {
  test("website manual transport close still requires audited provider termination evidence",async()=>{
    const ended=ledger("ended");ended.websiteInterviewRuntime={} as any;
    expect(ended.providerTerminalEvidence).toBeUndefined();expect(ended.agentEnded).toBeUndefined();
    await persistLedger(cap,ended,async()=>{throw new Error("No provider call without an admitted attempt");});
    expect(rpcCalls.filter(call=>call.name==="begin_provider_termination_attempt")).toHaveLength(1);
    expect(callUpdates.some(row=>row.provider_termination_state==="confirmed")).toBe(false);
  });
  test("real sideband constructor failure rolls back live state and every timer", () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class { constructor() { throw new Error("synthetic constructor failure"); } } as any;
    try {
      expect(() => attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any)).toThrow("synthetic constructor failure");
      expect(liveSessions.has(cap.callId)).toBe(false);
      expect(clock.timeouts.size).toBe(0);
      expect(clock.intervals.size).toBe(0);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("real sideband becomes active only after WebSocket open and starts durable heartbeat", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any) as any;
      expect(lifecycle.calls.filter((call) => call.name === "confirm_phone_sideband")).toHaveLength(0);
      SyntheticWebSocket.instances[0]!.emit("open");
      await control.opened;
      expect(lifecycle.calls.filter((call) => call.name === "confirm_phone_sideband")).toHaveLength(1);
      expect(clock.intervals.size).toBe(1);
      await [...clock.intervals.values()][0]!();
      await flushAsync();
      expect(lifecycle.calls.filter((call) => call.name === "heartbeat_phone_sideband")).toHaveLength(1);
      control.cancel("test_cleanup");
      expect(liveSessions.has(cap.callId)).toBe(false);
      expect(clock.timeouts.size).toBe(0);
      expect(clock.intervals.size).toBe(0);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("phone messages cannot run transcripts or tools before durable activation confirms", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = deferredPhoneActivationClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      });
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      emitTranscriptAndFunctionCall(socket, "pre-confirm");
      await flushAsync();

      expect(control.ledger.transcript).toEqual([]);
      expect(control.ledger.toolLog).toEqual([]);
      expect(socket.sent).toEqual([]);
      expect(lifecycle.calls.map((call) => call.name)).toEqual(["confirm_phone_sideband"]);

      lifecycle.confirm();
      await control.opened;
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("a confirmation that returns after cancel cannot reactivate the phone sideband", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = deferredPhoneActivationClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      });
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      control.cancel("cancel_while_confirming");
      await expect(control.opened).rejects.toThrow("phone_sideband_cancelled");

      lifecycle.confirm();
      await flushAsync();

      expect(socket.sent).toEqual([]);
      expect(clock.intervals.size).toBe(0);
      expect(liveSessions.has(cap.callId)).toBe(false);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("a confirmation rejection after cancel cannot mutate the terminated ledger", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = deferredPhoneActivationClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      });
      SyntheticWebSocket.instances[0]!.emit("open");
      control.cancel("cancel_while_confirming");
      await expect(control.opened).rejects.toThrow("phone_sideband_cancelled");

      lifecycle.fail(new Error("synthetic confirmation rejection"));
      await flushAsync();

      expect(control.ledger.status).toBe("active");
      expect(control.ledger.transcript).toEqual([]);
      expect(liveSessions.has(cap.callId)).toBe(false);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("messages arriving after cancel cannot mutate transcript, run tools, or write RPCs", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      });
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      control.cancel("boundary_test");
      const sentBefore = socket.sent.length;
      const rpcBefore = lifecycle.calls.length;

      emitTranscriptAndFunctionCall(socket, "post-cancel");
      await flushAsync();

      expect(control.ledger.transcript).toEqual([]);
      expect(control.ledger.toolLog).toEqual([]);
      expect(socket.sent).toHaveLength(sentBefore);
      expect(lifecycle.calls).toHaveLength(rpcBefore);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("messages from a replaced socket cannot mutate transcript, run tools, or write RPCs", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      });
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      first.emit("close", { code: 1012 });
      const retry = [...clock.timeouts.values()].at(-1)!;
      retry();
      expect(SyntheticWebSocket.instances).toHaveLength(2);
      const sentBefore = first.sent.length;
      const rpcBefore = lifecycle.calls.length;

      emitTranscriptAndFunctionCall(first, "stale-socket");
      await flushAsync();

      expect(control.ledger.transcript).toEqual([]);
      expect(control.ledger.toolLog).toEqual([]);
      expect(first.sent).toHaveLength(sentBefore);
      expect(lifecycle.calls).toHaveLength(rpcBefore);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("messages arriving after terminal finalization cannot mutate transcript or run tools", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      });
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      socket.emit("message", { data: JSON.stringify({ type: "session.ended" }) });
      await flushAsync();
      const transcriptBefore = [...control.ledger.transcript];
      const sentBefore = socket.sent.length;
      const rpcBefore = lifecycle.calls.length;

      emitTranscriptAndFunctionCall(socket, "post-terminal");
      await flushAsync();

      expect(control.ledger.transcript).toEqual(transcriptBefore);
      expect(control.ledger.toolLog).toEqual([]);
      expect(socket.sent).toHaveLength(sentBefore);
      expect(lifecycle.calls).toHaveLength(rpcBefore);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("browser sideband processes messages after the physical socket opens", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini");
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      socket.emit("message", { data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "browser-after-open",
      }) });
      await flushAsync();
      expect(control.ledger.transcript.map((entry) => entry.text)).toEqual(["browser-after-open"]);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("sideband activation persistence failure cancels socket and runtime before hangup", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient({ errors: new Set(["confirm_phone_sideband"]) });
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any) as any;
      SyntheticWebSocket.instances[0]!.emit("open");
      await expect(control.opened).rejects.toThrow("phone_sideband_activation_failed");
      control.cancel("phone_hangup_before_sideband_active");
      expect(SyntheticWebSocket.instances[0]!.closed).toBe(1);
      expect(liveSessions.has(cap.callId)).toBe(false);
      expect(clock.timeouts.size).toBe(0);
      expect(clock.intervals.size).toBe(0);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("session update throw rejects opened and finalizes the durable phone lifecycle", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    SyntheticWebSocket.throwOnSend = true;
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any);
      SyntheticWebSocket.instances[0]!.emit("open");
      await expect(control.opened).rejects.toThrow("phone_sideband_closed_before_open");
      await flushAsync();
      expect(SyntheticWebSocket.instances[0]!.closed).toBe(1);
      expect(liveSessions.has(cap.callId)).toBe(false);
      expect(lifecycle.calls.map((call) => call.name)).toContain("finalize_phone_sideband");
    } finally {
      SyntheticWebSocket.throwOnSend = false;
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("terminal phone sideband failure defers durably before removing local runtime", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient({ errors: new Set(["finalize_phone_sideband"]) });
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any) as any;
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      socket.emit("message", { data: JSON.stringify({
        type: "session.ended",
        usage: {
          input_tokens: 0, output_tokens: 0, total_tokens: 0,
          input_token_details: { text_tokens: 0, audio_tokens: 0, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0 } },
          output_token_details: { text_tokens: 0, audio_tokens: 0 },
        },
      }) });
      await flushAsync();
      expect(lifecycle.calls.map((call) => call.name)).toContain("finalize_phone_sideband");
      expect(lifecycle.calls.map((call) => call.name)).toContain("defer_phone_sideband_finalization");
      expect(liveSessions.has(cap.callId)).toBe(false);
      expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("heartbeat failure closes the socket before durable finalization and cancel stays idempotent", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient({ errors: new Set(["heartbeat_phone_sideband"]) });
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any);
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      await [...clock.intervals.values()][0]!();
      await flushAsync();
      expect(socket.closed).toBe(1);
      expect(lifecycle.calls.map((call) => call.name)).toContain("finalize_phone_sideband");
      control.cancel("late_cancel");
      expect(socket.closed).toBe(1);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("deadline before first WebSocket open rejects the opened boundary", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const lifecycle = phoneLifecycleClient();
    _setClient(lifecycle.client);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any);
      let openedRejected = false;
      void control.opened.catch(() => { openedRejected = true; });
      await [...clock.timeouts.values()][0]!();
      await flushAsync();
      expect(openedRejected).toBe(true);
      expect(liveSessions.has(cap.callId)).toBe(false);
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("browser pre-open deadline is internally handled when caller ignores opened", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini");
      await [...clock.timeouts.values()][0]!();
      await flushAsync();
      expect(unhandled).toEqual([]);
      expect(liveSessions.has(cap.callId)).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("heartbeat renewal is serialized so stale failure cannot race a later success", async () => {
    const clock = installSyntheticClock();
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const calls: string[] = [];
    let resolveHeartbeat!: (value: { data: boolean; error: null }) => void;
    _setClient({
      rpc(name: string) {
        calls.push(name);
        if (name === "heartbeat_phone_sideband") {
          return new Promise((resolve) => { resolveHeartbeat = resolve; });
        }
        return Promise.resolve({ data: true, error: null });
      },
    } as any);
    try {
      const control = attachSideband(cap, "rtc-1", "gpt-realtime-2.1-mini", {
        phone: { eventId: "event-1", claimToken: "claim-1" },
      } as any);
      SyntheticWebSocket.instances[0]!.emit("open");
      await control.opened;
      const heartbeatTick = [...clock.intervals.values()][0]!;
      heartbeatTick();
      heartbeatTick();
      await flushAsync();
      expect(calls.filter((name) => name === "heartbeat_phone_sideband")).toHaveLength(1);
      resolveHeartbeat({ data: true, error: null });
      await flushAsync();
      heartbeatTick();
      await flushAsync();
      expect(calls.filter((name) => name === "heartbeat_phone_sideband")).toHaveLength(2);
      control.cancel("test_cleanup");
    } finally {
      liveSessions.delete(cap.callId);
      globalThis.WebSocket = originalWebSocket;
      clock.restore();
    }
  });

  test("approval-bound onboarding hangup closes only after durable provider and terminal proof while budget defers", async () => {
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const onboardingCap = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-onboarding-close",
      15,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    const providerCalls: string[] = [];
    let providerConfirmed = false;
    let fetchCount = 0;
    _setClient({
      from(table: string) {
        const api: any = {
          update() { return api; },
          select() { return api; },
          eq() { return api; },
          maybeSingle: async () => table === "calls" && providerConfirmed
            ? {
                data: {
                  id: onboardingCap.callId,
                  status: "ended",
                  provider_termination_state: "confirmed",
                },
                error: null,
              }
            : { data: null, error: null },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
      rpc(name: string) {
        providerCalls.push(name);
        if (name === "begin_provider_termination_attempt")
          return Promise.resolve({
            data: {
              should_attempt: true,
              attempt_id: "attempt-1",
              request_id: "request-1",
              openai_call_id: "rtc-onboarding-close",
              provider_termination_mode: "hangup",
            },
            error: null,
          });
        if (name === "complete_provider_termination_attempt") {
          providerConfirmed = true;
          return Promise.resolve({ data: true, error: null });
        }
        if (name === "settle_call_budget")
          return Promise.resolve({ data: "unexpected-settlement", error: null });
        return Promise.resolve({ data: true, error: null });
      },
    } as any);
    try {
      const control = attachSideband(
        onboardingCap,
        "rtc-onboarding-close",
        "gpt-realtime-2.1",
        {
          onboarding: { expectedBusinessName: "Rocha Plumbing" },
          fetchImpl: async () => {
            fetchCount += 1;
            return new Response(null, { status: 200 });
          },
        },
      );
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      control.ledger.responseActive = false;
      const lifecycle = control.ledger.onboarding!.lifecycle;
      lifecycle.phase = "final_signoff_speaking";
      lifecycle.coverage = {
        revision: 7,
        digest: "7".repeat(64),
        complete: true,
        missing: [],
        ambiguous: [],
      };
      lifecycle.preparedSnapshotDigests = ["7".repeat(64)];
      lifecycle.approval = {
        toolCallId: "approval-tool-7",
        approvalReceiptId: "approval-receipt-7",
        coverageReceiptId: "coverage-receipt-7",
        revision: 7,
        digest: "7".repeat(64),
      };
      lifecycle.signoff = {
        approvalReceiptId: "approval-receipt-7",
        responseId: "resp-final-7",
        transcript: "",
        transcriptFinal: false,
        audioDone: false,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      lifecycle.activeResponseId = "resp-final-7";

      socket.emit("message", { data: JSON.stringify({
        type: "response.output_audio_transcript.done",
        response_id: "resp-final-7",
        transcript: FINAL_SIGNOFF_SENTENCE_PT,
      }) });
      socket.emit("message", { data: JSON.stringify({
        type: "response.output_audio.done",
        response_id: "resp-final-7",
      }) });
      socket.emit("message", { data: JSON.stringify({
        type: "response.done",
        response: { id: "resp-final-7", status: "completed" },
      }) });
      socket.emit("message", { data: JSON.stringify({
        type: "output_audio_buffer.stopped",
        response_id: "resp-final-7",
      }) });
      await flushAsync();
      await new Promise((resolve) => setImmediate(resolve));

      expect(control.ledger.onboarding!.lifecycle.phase).toBe("closed");
      expect(control.ledger.onboarding!.lifecycle.providerTerminationConfirmed)
        .toBe(true);
      expect(fetchCount).toBe(1);
      expect(providerCalls.filter((name) => name === "begin_provider_termination_attempt"))
        .toHaveLength(1);
      expect(providerCalls.filter((name) => name === "complete_provider_termination_attempt"))
        .toHaveLength(1);
      expect(providerCalls.filter((name) => name === "settle_call_budget"))
        .toHaveLength(0);
      expect(liveSessions.has(onboardingCap.callId)).toBe(false);
    } finally {
      liveSessions.delete(onboardingCap.callId);
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("playback-proven budget pause reaches reducer closed only after killed_budget and provider confirmation are durable", async () => {
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const onboardingCap = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-onboarding-budget-close",
      30,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    const providerCalls: Array<{
      name: string;
      args?: Record<string, unknown>;
    }> = [];
    let providerConfirmed = false;
    _setClient({
      from(table: string) {
        const api: any = {
          update() { return api; },
          select() { return api; },
          eq() { return api; },
          maybeSingle: async () => table === "calls" && providerConfirmed
            ? {
                data: {
                  id: onboardingCap.callId,
                  status: "killed_budget",
                  provider_termination_state: "confirmed",
                },
                error: null,
              }
            : { data: null, error: null },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
      rpc(name: string, args?: Record<string, unknown>) {
        providerCalls.push({ name, args });
        if (name === "begin_provider_termination_attempt")
          return Promise.resolve({
            data: {
              should_attempt: true,
              attempt_id: "attempt-budget-close",
              request_id: "request-budget-close",
              openai_call_id: "rtc-onboarding-budget-close",
              provider_termination_mode: "hangup",
            },
            error: null,
          });
        if (name === "complete_provider_termination_attempt") {
          providerConfirmed = true;
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: true, error: null });
      },
    } as any);
    try {
      const control = attachSideband(
        onboardingCap,
        "rtc-onboarding-budget-close",
        "gpt-realtime-2.1",
        {
          onboarding: { expectedBusinessName: "Rocha Plumbing" },
          fetchImpl: async () => new Response(null, { status: 200 }),
        },
      );
      const socket = SyntheticWebSocket.instances[0]!;
      socket.emit("open");
      await control.opened;
      control.ledger.responseActive = true;
      const lifecycle = control.ledger.onboarding!.lifecycle;
      lifecycle.phase = "budget_pause_speaking" as any;
      lifecycle.budgetPause = {
        costUsd: 6.5,
        softLimitUsd: 6.5,
        hardLimitUsd: 7.5,
        responseId: "resp-budget-close",
        transcript: "",
        transcriptFinal: false,
        audioDone: false,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      lifecycle.responseIntents[`budget-pause:${onboardingCap.callId}`] = {
        intentKey: `budget-pause:${onboardingCap.callId}`,
        purpose: "budget_pause" as any,
        state: "acknowledged",
        responseId: "resp-budget-close",
        sentSocketGeneration: 1,
      };
      lifecycle.activeResponseId = "resp-budget-close";

      socket.emit("message", { data: JSON.stringify({
        type: "response.output_audio_transcript.done",
        response_id: "resp-budget-close",
        transcript: BUDGET_PAUSE_SENTENCE_PT,
      }) });
      socket.emit("message", { data: JSON.stringify({
        type: "response.output_audio.done",
        response_id: "resp-budget-close",
      }) });
      socket.emit("message", { data: JSON.stringify({
        type: "response.done",
        response: { id: "resp-budget-close", status: "completed" },
      }) });
      socket.emit("message", { data: JSON.stringify({
        type: "output_audio_buffer.stopped",
        response_id: "resp-budget-close",
      }) });
      await flushAsync();
      await new Promise((resolve) => setImmediate(resolve));

      expect(control.ledger.status).toBe("killed_budget");
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("closed");
      expect(control.ledger.onboarding!.lifecycle.providerTerminationConfirmed)
        .toBe(true);
      expect(providerCalls.find((call) =>
        call.name === "begin_provider_termination_attempt"
      )?.args?.p_reason).toBe("sideband_killed_budget");
      expect(providerCalls.filter((call) =>
        call.name === "complete_provider_termination_attempt"
      )).toHaveLength(1);
      expect(liveSessions.has(onboardingCap.callId)).toBe(false);
    } finally {
      liveSessions.delete(onboardingCap.callId);
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("lost budget-pause ACK becomes durable error and closes without replaying uncertain speech", async () => {
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const onboardingCap = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-onboarding-budget-ack-lost",
      30,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    const providerCalls: Array<{
      name: string;
      args?: Record<string, unknown>;
    }> = [];
    let providerConfirmed = false;
    _setClient({
      from(table: string) {
        const api: any = {
          update() { return api; },
          select() { return api; },
          eq() { return api; },
          maybeSingle: async () => table === "calls" && providerConfirmed
            ? {
                data: {
                  id: onboardingCap.callId,
                  status: "error",
                  provider_termination_state: "confirmed",
                },
                error: null,
              }
            : { data: null, error: null },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return api;
      },
      rpc(name: string, args?: Record<string, unknown>) {
        providerCalls.push({ name, args });
        if (name === "begin_provider_termination_attempt")
          return Promise.resolve({
            data: {
              should_attempt: true,
              attempt_id: "attempt-budget-ack-lost",
              request_id: "request-budget-ack-lost",
              openai_call_id: "rtc-onboarding-budget-ack-lost",
              provider_termination_mode: "hangup",
            },
            error: null,
          });
        if (name === "complete_provider_termination_attempt") {
          providerConfirmed = true;
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: true, error: null });
      },
    } as any);
    try {
      const control = attachSideband(
        onboardingCap,
        "rtc-onboarding-budget-ack-lost",
        "gpt-realtime-2.1",
        {
          onboarding: { expectedBusinessName: "Rocha Plumbing" },
          fetchImpl: async () => new Response(null, { status: 200 }),
        },
      );
      const first = SyntheticWebSocket.instances[0]!;
      first.emit("open");
      await control.opened;
      const adapter = control.ledger.onboarding!;
      const intentKey = `budget-pause:${onboardingCap.callId}`;
      adapter.lifecycle.phase = "budget_pause_speaking" as any;
      adapter.lifecycle.responseIntents = {
        [intentKey]: {
          intentKey,
          purpose: "budget_pause" as any,
          state: "sent",
          sentSocketGeneration: 1,
        },
      };
      adapter.pendingResponseCommands = {};
      adapter.lifecycle.budgetPause = {
        costUsd: 6.5,
        softLimitUsd: 6.5,
        hardLimitUsd: 7.5,
        transcript: "",
        transcriptFinal: false,
        audioDone: false,
        responseDone: false,
        playbackStopped: false,
        interrupted: false,
        attempt: 0,
      };
      delete adapter.lifecycle.activeResponseId;
      control.ledger.responseActive = false;

      first.emit("close", { code: 1006 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const second = SyntheticWebSocket.instances[1]!;
      second.emit("open");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(control.ledger.status).toBe("error");
      expect(control.ledger.onboarding!.lifecycle.phase).toBe("closed");
      expect(control.ledger.onboarding!.lifecycle.providerTerminationConfirmed)
        .toBe(true);
      expect(second.sent.map((raw) => JSON.parse(raw)).filter((frame) =>
        frame.type === "response.create" &&
        frame.response?.metadata?.purpose === "budget_pause"
      )).toHaveLength(0);
      expect(providerCalls.find((call) =>
        call.name === "begin_provider_termination_attempt"
      )?.args?.p_reason).toBe("sideband_error");
      expect(liveSessions.has(onboardingCap.callId)).toBe(false);
    } finally {
      liveSessions.delete(onboardingCap.callId);
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("onboarding phone sideband options are rejected before any provider socket exists", () => {
    const originalWebSocket = globalThis.WebSocket;
    SyntheticWebSocket.instances = [];
    globalThis.WebSocket = SyntheticWebSocket as any;
    const onboarding = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-phone-provider-terminal",
      15,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    try {
      expect(() => attachSideband(
        onboarding,
        "rtc-phone-provider-terminal",
        "gpt-realtime-2.1",
        {
          phone: {
            eventId: "event-phone-terminal",
            claimToken: "claim-phone-terminal",
          },
        },
      )).toThrow("onboarding_phone_sideband_forbidden");
      expect(() => attachSideband(
        onboarding,
        "rtc-onboarding-missing-business",
        "gpt-realtime-2.1",
      )).toThrow("onboarding_expected_business_name_required");
      expect(SyntheticWebSocket.instances).toHaveLength(0);
      expect(liveSessions.has(onboarding.callId)).toBe(false);
    } finally {
      liveSessions.delete(onboarding.callId);
      globalThis.WebSocket = originalWebSocket;
    }
  });
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

  test("unknown Realtime usage preserves the known application TTS cost floor", async () => {
    rpcCalls = [];
    callUpdates = [];
    const terminal = ledger("error");
    terminal.externalCostUsd = 0.001605;
    await persistLedger(
      cap,
      terminal,
      async () => new Response(null, { status: 200 }),
    );
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(0);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      provider_usage_state: "unknown",
      usage_tokens: null,
      cost_estimate_usd: 0.001605,
    }));
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

  test("premature onboarding session.ended stays interrupted while provider terminality settles once without hangup", async () => {
    const onboarding = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-1",
      15,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    const ended = ledger("active");
    let fetchCount = 0;
    const fetch404 = async () => {
      fetchCount += 1;
      return new Response(null, { status: 404 });
    };

    await handleEvent(onboarding, ended, { send() {}, close() {} } as any, {
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

    expect(ended.status).toBe("error");
    expect(ended.onboarding?.lifecycle.phase).not.toBe("closed");
    expect(ended.providerTerminalEvidence).toMatchObject({
      observed: true,
      reason: "provider_session_ended",
    });

    await persistLedger(onboarding, ended, fetch404);
    await persistLedger(onboarding, ended, fetch404);

    expect(fetchCount).toBe(0);
    expect(callUpdates.at(-1)).toMatchObject({
      status: "error",
      provider_termination_state: "confirmed",
      provider_termination_reason: "provider_session_ended",
      provider_usage_state: "resolved",
    });
    expect(rpcCalls.filter((call) =>
      call.name === "begin_provider_termination_attempt" ||
      call.name === "complete_provider_termination_attempt"
    )).toEqual([]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(1);
  });

  test("session.ended after an authorized agent close preserves the approval-bound success reason", async () => {
    const onboarding = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-1",
      15,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    const ended = ledger("active");
    await handleEvent(onboarding, ended, { send() {}, close() {} } as any, {
      type: "session.created",
    });
    ended.agentEnded = true;
    ended.onboarding!.lifecycle.phase = "provider_terminating";
    await handleEvent(onboarding, ended, { send() {}, close() {} } as any, {
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

    await persistLedger(onboarding, ended, async () =>
      new Response(null, { status: 404 })
    );

    expect(callUpdates.at(-1)).toMatchObject({
      status: "ended",
      provider_termination_state: "confirmed",
      provider_termination_reason: "agent_ended_session",
    });
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(1);
  });

  test("authorized provider termination persistence is monotonic across successful and settlement-failed retries", async () => {
    const retryCap = makeCapability(
      "rocha-plumbing",
      "tenant-1",
      "call-1",
      15,
      "onboarding",
      { authEpoch: 1, policyEpoch: 1, simulation: true },
      "owner-1",
    );
    for (const scenario of [
      "success",
      "settlement_failure",
      "usage_unresolved",
      "provider_identity_mismatch",
    ] as const) {
      const settleFirstFails = scenario === "settlement_failure" ||
        scenario === "provider_identity_mismatch";
      let providerState = "active";
      let beginCount = 0;
      let completeCount = 0;
      let settleCount = 0;
      let fetchCount = 0;
      const callWrites: Array<Record<string, unknown>> = [];
      _setClient({
        rpc(name: string, args: Record<string, unknown>) {
          if (name === "begin_provider_termination_attempt") {
            beginCount += 1;
            if (providerState === "confirmed")
              return Promise.resolve({
                data: { should_attempt: false },
                error: null,
              });
            providerState = "pending";
            return Promise.resolve({
              data: {
                should_attempt: true,
                attempt_id: "attempt-monotonic",
                request_id: "request-monotonic",
                openai_call_id: "rtc-monotonic",
                provider_termination_mode: "hangup",
              },
              error: null,
            });
          }
          if (name === "complete_provider_termination_attempt") {
            completeCount += 1;
            if (args.p_confirmed === true) providerState = "confirmed";
            return Promise.resolve({ data: true, error: null });
          }
          if (name === "settle_call_budget") {
            settleCount += 1;
            return Promise.resolve(
              settleFirstFails && settleCount === 1
                ? { data: null, error: { message: "temporary settlement failure" } }
                : { data: "reservation-monotonic", error: null },
            );
          }
          return Promise.resolve({ data: true, error: null });
        },
        from(table: string) {
          let selectedCallId: string | null = null;
          const api: any = {
            update(row: Record<string, unknown>) {
              if (table === "calls") {
                callWrites.push(row);
                if (typeof row.provider_termination_state === "string")
                  providerState = row.provider_termination_state;
              }
              return api;
            },
            select() { return api; },
            eq(column: string, value: unknown) {
              if (table === "calls" && column === "id")
                selectedCallId = String(value);
              return api;
            },
            maybeSingle: async () => table === "calls"
              ? {
                  data: {
                    id: selectedCallId,
                    openai_call_id: "rtc-monotonic",
                    provider_termination_state: providerState,
                  },
                  error: null,
                }
              : { data: null, error: null },
            then(resolve: (value: unknown) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return api;
        },
      } as any);
      const ended = ledger("ended");
      ended.agentEnded = true;
      ended.openaiCallId = "rtc-monotonic";
      ended.providerUsageEvidence.terminal = scenario !== "usage_unresolved";
      const fetchImpl = async () => {
        fetchCount += 1;
        return new Response(null, { status: 200 });
      };

      const first = await persistLedger(retryCap, ended, fetchImpl);
      if (scenario === "provider_identity_mismatch")
        ended.openaiCallId = "rtc-different";
      const second = await persistLedger(retryCap, ended, fetchImpl);

      expect(first).toBe(scenario === "success");
      expect(second).toBe(
        scenario === "success" || scenario === "settlement_failure",
      );
      expect(providerState).toBe("confirmed");
      expect(fetchCount).toBe(1);
      expect(completeCount).toBe(1);
      expect(settleCount).toBe(
        scenario === "success"
          ? 1
          : scenario === "settlement_failure"
            ? 2
            : scenario === "provider_identity_mismatch"
              ? 1
              : 0,
      );
      expect(beginCount).toBe(scenario === "success" ? 1 : 2);
      expect(callWrites.filter((row) =>
        row.provider_termination_state === "active"
      )).toHaveLength(0);
    }
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

  test("a repeated persistence attempt does not resubmit an already completed settlement", async () => {
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

    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
    expect(directUsageInserts).toBe(0);
  });
});
