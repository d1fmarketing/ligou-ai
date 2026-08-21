import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { emptyUsage } from "../src/config.ts";
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
  constructor() { SyntheticWebSocket.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() { if (SyntheticWebSocket.throwOnSend) throw new Error("synthetic send failure"); }
  close() { this.closed += 1; this.emit("close", { code: 1000 }); }
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
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
  };
}

describe("sideband budget finalization", () => {
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
