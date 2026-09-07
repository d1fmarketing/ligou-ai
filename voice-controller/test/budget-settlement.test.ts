import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as configModule from "../src/config.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { createVoiceStartupTrace, startSession } from "../src/server.ts";
import { liveSessions } from "../src/sideband.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUnitTestEnvironment } from "../scripts/run-unit-tests.mjs";

const TENANT = {
  id: "11111111-1111-4111-8111-111111111111", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "22222222-2222-4222-8222-222222222222", auth_epoch: 2, policy_epoch: 3,
};

const { config } = configModule;

let reserveError: { message: string } | null = null;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const originalOpenAiKey = config.openaiKey;
const originalCeiling = config.sessionCostCeilingUsd;
const originalProviderCreateTimeoutMs =
  (config as any).realtimeCreateTimeoutMs;
const originalSidebandOpenTimeoutMs = (config as any).sidebandOpenTimeoutMs;
const originalVoice = config.voice;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let fetchUrls: string[] = [];
let callUpdates: any[] = [];
let budgetUpdates: any[] = [];
let providerAttempts = new Set<string>();
let callInserts = 0;
let callInsertRows: Record<string, unknown>[] = [];
let floorWriteMode: "success" | "throw_exact" | "unproven" = "success";
let durableFloor: number | null = null;
let providerIdentityMode: "success" | "error" | "zero" = "success";
let durableProviderIdentity: Record<string, unknown> | null = null;
let reserveGate: Promise<void> | null = null;
let providerMarkerGate: Promise<void> | null = null;
let resumeGate: Promise<void> | null = null;
let terminalWriteError = false;
let costFloorResponseGate: Promise<void> | null = null;
let identityResponseGate: Promise<void> | null = null;
let terminalResponseGate: Promise<void> | null = null;
let heldResponseReached = false;
let resumeRpcResult: { data: unknown; error: { code?: string; message: string } | null } = {
  data: null,
  error: { code: "P0002", message: "onboarding_resume_source_missing" },
};

function resumedCheckpoint(callId: string) {
  const nextAction = {
    type: "ask",
    field: "area.coverage",
    question_pt: "Quais cidades e regiões sua empresa atende?",
  };
  const snapshot = {
    tenantId: TENANT.id,
    callId,
    revision: 1,
    services: ["desentupimento"],
    cells: {
      "service:desentupimento:service.name_synonyms": {
        state: "answered",
        attempts: 1,
        value: ["desentupimento"],
      },
    },
    followUps: 11,
    followUpGroups: {},
    summaryInvalidated: false,
  };
  const coverage = {
    schema_version: 2,
    transition_kind: "resume_checkpoint",
    tenant_id: TENANT.id,
    call_id: callId,
    revision: 1,
    complete: false,
    snapshot,
    progress: {
      missingRequired: [{ field: "area.coverage" }],
      ambiguous: [],
    },
    selected_rule_ids: [],
    next_action: nextAction,
    current_answer_hashes: { "service:desentupimento:service.name_synonyms": "f".repeat(64) },
    materializations: [],
    summary_projection: null,
    summary_hash: null,
    resume_context: {
      source_call_id: "33333333-3333-4333-8333-333333333333",
      source_receipt_id: "44444444-4444-4444-8444-444444444444",
      source_revision: 33,
      source_snapshot_digest: "e".repeat(64),
    },
    authority: {
      rules_approved: false,
      powers_granted: false,
      operational_mode_changed: false,
    },
    snapshot_digest: "c".repeat(64),
  };
  return {
    status: "initialized",
    source_call_id: "33333333-3333-4333-8333-333333333333",
    source_receipt_id: "44444444-4444-4444-8444-444444444444",
    coverage_receipt_id: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    snapshot_digest: "c".repeat(64),
    next_action: nextAction,
    coverage,
  };
}

class AutoOpenWebSocket {
  listeners = new Map<string, Array<(event: any) => void>>();
  constructor() { setTimeout(() => this.emit("open"), 0); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send() {}
  close() {}
  emit(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function client() {
  return {
    from(table: string) {
      let updatedRow: any = null;
      const api: any = {
        select() { return api; }, eq() { return api; }, is() { return api; },
        insert(row: Record<string, unknown>) {
          if (table === "calls") {
            callInserts += 1;
            callInsertRows.push(structuredClone(row));
          }
          return api;
        },
        update(row: any) {
          updatedRow = row;
          if (table === "calls") callUpdates.push(row);
          if (table === "budget_reservations") budgetUpdates.push(row);
          return api;
        },
        single: async () => table === "tenants"
          ? { data: TENANT, error: null }
          : table === "calls"
            ? { data: { id: callInsertRows.at(-1)?.id ?? "call-1" }, error: null }
            : { data: null, error: null },
        maybeSingle: async () => {
          if (table !== "calls") return { data: null, error: null };
          if (updatedRow?.provider_termination_reason ===
            "provider_create_inflight") {
            if (providerMarkerGate) await providerMarkerGate;
            return {
              data: {
                id: String(callInsertRows.at(-1)?.id ?? "call-1"),
                tenant_id: TENANT.id,
                status: "active",
                openai_call_id: null,
                ...structuredClone(updatedRow),
              },
              error: null,
            };
          }
          if (updatedRow?.provider_termination_reason === "tts_inflight")
            return {
              data: {
                id: String(callInsertRows.at(-1)?.id ?? "call-1"),
                tenant_id: TENANT.id,
                status: "active",
                ...structuredClone(updatedRow),
              },
              error: null,
            };
          if (updatedRow && typeof updatedRow.openai_call_id === "string") {
            if (providerIdentityMode === "error")
              return { data: null, error: { message: "identity write failed" } };
            if (providerIdentityMode === "zero")
              return { data: null, error: null };
            durableProviderIdentity = {
              id: String(callInsertRows.at(-1)?.id ?? "call-1"),
              tenant_id: TENANT.id,
              status: "active",
              ...structuredClone(updatedRow),
            };
            if (identityResponseGate) { heldResponseReached = true; await identityResponseGate; }
            return { data: structuredClone(durableProviderIdentity), error: null };
          }
          if (updatedRow && typeof updatedRow.cost_estimate_usd === "number") {
            if (floorWriteMode === "unproven")
              return { data: null, error: { message: "floor write unknown" } };
            durableFloor = updatedRow.cost_estimate_usd;
            if (costFloorResponseGate) { heldResponseReached = true; await costFloorResponseGate; }
            if (floorWriteMode === "throw_exact")
              throw new TypeError("floor write transport lost after commit");
            return {
              data: { id: String(callInsertRows.at(-1)?.id ?? "call-1"), tenant_id: TENANT.id,
                status: "active",
                ...structuredClone(updatedRow) },
              error: null,
            };
          }
          if (durableProviderIdentity)
            return { data: structuredClone(durableProviderIdentity), error: null };
          return durableFloor === null
            ? { data: null, error: { message: "floor absent" } }
            : {
                data: { id: String(callInsertRows.at(-1)?.id ?? "call-1"), tenant_id: TENANT.id,
                  status: "active",
                  cost_estimate_usd: durableFloor,
                  provider_termination_state: "not_required",
                  provider_termination_reason: "tts_resolved",
                  provider_usage_state: "resolved" },
                error: null,
              };
        },
        then(resolve: (value: unknown) => unknown) {
          if (table === "calls" && updatedRow?.status === "error" && terminalResponseGate) {
            heldResponseReached = true;
            return terminalResponseGate.then(() => ({ data: null, error: null })).then(resolve);
          }
          if (table === "calls" && updatedRow?.status === "error" && terminalWriteError)
            return Promise.resolve({ data: null, error: { message: "synthetic terminal write failure" } }).then(resolve);
          return Promise.resolve({ data: table === "effective_rules" ? [] : null, error: null }).then(resolve);
        },
      };
      return api;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "reserve_call_budget") {
        if (reserveGate) await reserveGate;
        return { data: reserveError ? null : "reservation-1", error: reserveError };
      }
      if (name === "settle_call_budget") {
        return Promise.resolve({ data: "reservation-1", error: null });
      }
      if (name === "initialize_onboarding_resume") {
        if (resumeGate) await resumeGate;
        return structuredClone(resumeRpcResult);
      }
      if (name === "begin_provider_termination_attempt") {
        const callId = String(args.p_call_id);
        if (providerAttempts.has(callId)) return Promise.resolve({ data: { should_attempt: false }, error: null });
        providerAttempts.add(callId);
        return Promise.resolve({ data: {
          should_attempt: true,
          attempt_id: "91000000-0000-4000-8000-000000000001",
          request_id: "91000000-0000-4000-8000-000000000001",
          openai_call_id: args.p_openai_call_id,
          provider_termination_mode: args.p_mode,
        }, error: null });
      }
      if (name === "complete_provider_termination_attempt") {
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

beforeEach(() => {
  reserveError = null;
  rpcCalls = [];
  config.openaiKey = originalOpenAiKey;
  config.sessionCostCeilingUsd = originalCeiling;
  (config as any).realtimeCreateTimeoutMs = originalProviderCreateTimeoutMs;
  (config as any).sidebandOpenTimeoutMs = originalSidebandOpenTimeoutMs;
  (config as any).voice = originalVoice;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  fetchUrls = [];
  callUpdates = [];
  budgetUpdates = [];
  providerAttempts = new Set();
  callInserts = 0;
  callInsertRows = [];
  floorWriteMode = "success";
  durableFloor = null;
  providerIdentityMode = "success";
  durableProviderIdentity = null;
  reserveGate = null;
  providerMarkerGate = null;
  resumeGate = null;
  terminalWriteError = false;
  costFloorResponseGate = identityResponseGate = terminalResponseGate = null;
  heldResponseReached = false;
  resumeRpcResult = {
    data: null,
    error: { code: "P0002", message: "onboarding_resume_source_missing" },
  };
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});

afterEach(() => {
  config.openaiKey = originalOpenAiKey;
  config.sessionCostCeilingUsd = originalCeiling;
  (config as any).realtimeCreateTimeoutMs = originalProviderCreateTimeoutMs;
  (config as any).sidebandOpenTimeoutMs = originalSidebandOpenTimeoutMs;
  (config as any).voice = originalVoice;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

afterAll(() => _setClient(null));

describe("session budget lifecycle", () => {
  test("late identity and terminal writes cannot overwrite confirmed termination or an already terminal call", async () => {
    config.openaiKey = "synthetic-openai-key";
    const fallbackClient = client();
    const row: Record<string, any> = { provider_termination_attempt_id: null, openai_call_id: null, cost_estimate_usd: null };
    let releaseIdentity!: () => void, releaseTerminal!: () => void;
    const identityGate = new Promise<void>(resolve => { releaseIdentity = resolve; });
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
    let identityStarted = false, identityWrites = 0, staleWritesRejected = 0;
    _setClient({
      from(table: string) {
        if (table !== "calls") return fallbackClient.from(table);
        let patch: Record<string, unknown> | null = null;
        const filters: Record<string, unknown> = {};
        const execute = async () => {
          if (patch?.openai_call_id && ++identityWrites === 1) { identityStarted = true; await identityGate; }
          if (patch?.status === "error") await terminalGate;
          const matches = Object.entries(filters).every(([key,value]) => row[key] === value);
          if (patch && matches) Object.assign(row,patch);
          else if (patch && !matches) staleWritesRejected++;
          return { data: !patch || matches ? structuredClone(row) : null, error: null };
        };
        const api: any = {
          select() { return api; },
          eq(key: string,value: unknown) { filters[key]=value;return api; },
          is(key: string,value: unknown) { filters[key]=value;return api; },
          insert(value: Record<string,unknown>) { Object.assign(row,value);return api; },
          update(value: Record<string,unknown>) { patch=value;return api; },
          single:execute, maybeSingle:execute,
          then(resolve: (value:unknown)=>unknown,reject:(reason:unknown)=>unknown) { return execute().then(resolve,reject); },
        };
        return api;
      },
      async rpc(name: string,args: Record<string,unknown>) {
        if(name==="begin_provider_termination_attempt") {
          rpcCalls.push({name,args});
          if(row.provider_termination_attempt_id || row.provider_termination_state==="unknown")return {data:{should_attempt:false},error:null};
          Object.assign(row,{openai_call_id:args.p_openai_call_id,provider_termination_state:"pending",provider_termination_attempt_id:"attempt-once"});
          return {data:{should_attempt:true,attempt_id:"attempt-once",request_id:"request-once",openai_call_id:args.p_openai_call_id,provider_termination_mode:"hangup"},error:null};
        }
        if(name==="complete_provider_termination_attempt") {
          rpcCalls.push({name,args});row.provider_termination_state="confirmed";return {data:true,error:null};
        }
        return fallbackClient.rpc(name,args);
      },
    } as any);
    globalThis.fetch=async input=>{
      const url=String(input);fetchUrls.push(url);
      if(url.endsWith("/hangup"))return new Response(null,{status:200});
      if(url.endsWith("/v1/audio/speech"))return new Response(new Uint8Array([0x49,0x44,0x33,0xff]),{status:200,headers:{"content-type":"audio/mpeg"}});
      return new Response("answer-sdp",{status:200,headers:{Location:"/v1/realtime/calls/rtc-late-guard"}});
    };
    let cleanup: {cancel(reason:string):Promise<void>} | null=null;
    const pending=startSession(TENANT.owner_user_id,"onboarding","test-sdp",undefined,TENANT.id,control=>{cleanup=control;},
      {browserRequestId:"request-late-guard",openingModeRequested:"application_tts_v1",requestedCallId:"11111111-1111-4111-8111-111111111119"});
    const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    while(!identityStarted)await new Promise(resolve=>setImmediate(resolve));
    await cleanup!.cancel("late_guard_cancel");
    expect(row.provider_termination_state).toBe("confirmed");
    expect(fetchUrls.filter(url=>url.endsWith("/hangup"))).toHaveLength(1);
    // Model a faster terminal writer while both earlier responses are delayed.
    row.status="ended";releaseIdentity();releaseTerminal();
    for(let turn=0;turn<10;turn++)await new Promise(resolve=>setImmediate(resolve));
    expect(await outcome).toBe("browser_request_cancelled");
    expect(staleWritesRejected).toBe(2);
    expect(row.status).toBe("ended");expect(row.provider_termination_state).toBe("confirmed");
    expect(row.cost_estimate_usd).toBe(0.00324);
    expect(rpcCalls.filter(call=>call.name==="settle_call_budget")).toHaveLength(0);
  });

  for (const held of ["audio cost", "provider identity", "terminal state"] as const) {
    test(`cancellation hangs up a known provider while the ${held} response remains held`, async () => {
      config.openaiKey = "synthetic-openai-key";
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      if (held === "audio cost") costFloorResponseGate = gate;
      if (held === "provider identity") identityResponseGate = gate;
      if (held === "terminal state") terminalResponseGate = gate;
      let releaseTts!: (response: Response) => void;
      const heldTts = new Promise<Response>((resolve) => { releaseTts = resolve; });
      globalThis.fetch = async (input) => {
        const url = String(input); fetchUrls.push(url);
        if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
        if (url.endsWith("/v1/audio/speech")) return held === "terminal state" ? await heldTts : new Response(new Uint8Array([0x49,0x44,0x33,0xff]), {status:200,headers:{"content-type":"audio/mpeg"}});
        return new Response("answer-sdp", {status:200,headers:{Location:"/v1/realtime/calls/rtc-held-receipt"}});
      };
      let cleanup: {cancel(reason:string):Promise<void>} | null = null;
      const pending = startSession(TENANT.owner_user_id,"onboarding","test-sdp",undefined,TENANT.id,
        control=>{cleanup=control;},{browserRequestId:"request-held-receipt",openingModeRequested:"application_tts_v1",requestedCallId:"11111111-1111-4111-8111-111111111119"});
      const outcome = pending.then(()=>"ready", (error:Error)=>error.message);
      if (held === "terminal state") {
        while (!durableProviderIdentity) await new Promise(resolve=>setImmediate(resolve));
        releaseTts(new Response("rejected",{status:400}));
      }
      while (!heldResponseReached) await new Promise(resolve=>setImmediate(resolve));
      const cancelled=cleanup!.cancel("held_response_cancel");
      for(let turn=0;turn<10;turn++)await new Promise(resolve=>setImmediate(resolve));
      const earlyHangups=fetchUrls.filter(url=>url.endsWith("/hangup")).length;
      const completedWhileHeld=await Promise.race([cancelled.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),750))]);
      release();await cancelled;const result=await outcome;
      expect(earlyHangups).toBe(1);
      expect(completedWhileHeld).toBe(true);
      expect(result).not.toBe("ready");
      expect(fetchUrls.filter(url=>url.endsWith("/hangup"))).toHaveLength(1);
      expect(rpcCalls.filter(call=>call.name==="settle_call_budget")).toHaveLength(0);
      expect(callUpdates.filter(row=>row.status==="error").every(row=>!Object.hasOwn(row,"provider_termination_state"))).toBe(true);
    });
  }

  test("the executable controller reaches its HTTP surface without an asynchronous import cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "ligou-startup-main-"));
    const preload = join(dir, "network-free-preload.ts");
    writeFileSync(preload, `
      globalThis.setInterval = (() => 0) as any;
      globalThis.fetch = (async () => { throw new Error("network forbidden in bootstrap test"); }) as any;
      Bun.serve = (() => { console.log("CONTROLLER_HTTP_READY"); process.exit(0); }) as any;
    `);
    try {
      const output = execFileSync(process.execPath, ["--preload", preload,
        fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
        cwd: dir, env: { ...createUnitTestEnvironment(), OPENAI_API_KEY: "" },
        encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"],
      });
      expect(output).toContain("CONTROLLER_HTTP_READY");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("startup timings retain overlapping monotonic offsets without payload or exception contents", async () => {
    let now = 100;
    const events: Record<string, unknown>[] = [];
    const scope = { requestId: "request-timing", callId: "call-timing" };
    const trace = createVoiceStartupTrace(scope, { now: () => now, write: (event) => { events.push(event); } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const audio = trace.measure("opening_audio", () => held);
    now = 102;
    await trace.measure("provider_create", () => { now = 105; });
    now = 110;
    release();
    await audio;
    expect(events).toEqual([
      { evt: "voice.startup.stage", timing_version: 1, trace_scope: "session", request_id: scope.requestId, call_id: scope.callId,
        stage: "provider_create", outcome: "ok", stage_start_ms: 2, duration_ms: 3, elapsed_ms: 5 },
      { evt: "voice.startup.stage", timing_version: 1, trace_scope: "session", request_id: scope.requestId, call_id: scope.callId,
        stage: "opening_audio", outcome: "ok", stage_start_ms: 0, duration_ms: 10, elapsed_ms: 10 },
    ]);
    await expect(trace.measure("provider_identity", () => {
      throw new Error("synthetic-secret private transcript SDP");
    })).rejects.toThrow("synthetic-secret");
    expect(events.at(-1)?.outcome).toBe("error");
    expect(JSON.stringify(events)).not.toContain("synthetic-secret");
    const brokenLogger = createVoiceStartupTrace(scope, { write: () => { throw new Error("logger unavailable"); } });
    expect(await brokenLogger.measure("provider_identity", () => "preserved")).toBe("preserved");
  });

  test("Realtime creation overlaps held opening audio without publishing ready before both succeed", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.WebSocket = AutoOpenWebSocket as any;
    let finishTts!: (response: Response) => void;
    const tts = new Promise<Response>((resolve) => { finishTts = resolve; });
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech")) return await tts;
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200, headers: { Location: "/v1/realtime/calls/rtc-concurrent-opening" },
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    let ready = false;
    const pending = startSession(
      TENANT.owner_user_id, "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-concurrent-opening",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    ).then((result) => { ready = true; return result; });
    for (let turn = 0; turn < 10; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    const providerStartedBeforeAudio = providerCreationRequests().length;
    const publishedBeforeAudio = ready;
    finishTts(new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
      status: 200, headers: { "content-type": "audio/mpeg" },
    }));
    const result = await pending;
    await cleanup!.cancel("test_cleanup");
    expect(result.sdp).toBe("answer-sdp");
    expect(publishedBeforeAudio).toBe(false);
    expect(providerStartedBeforeAudio).toBe(1);
    expect(durableFloor).toBe(0.00324);
    expect(callUpdates.filter((row) => row.cost_estimate_usd === 0.00324 && row.status === undefined))
      .toContainEqual({ cost_estimate_usd: 0.00324 });
  });

  test("a failed terminal write still terminates an accepted provider and defers budget settlement", async () => {
    config.openaiKey = "synthetic-openai-key";
    terminalWriteError = true;
    let releaseTts!: (response: Response) => void;
    const heldTts = new Promise<Response>((resolve) => { releaseTts = resolve; });
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech")) return await heldTts;
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200, headers: { Location: "/v1/realtime/calls/rtc-terminal-write-failed" },
      });
    };
    const pending = startSession(TENANT.owner_user_id, "onboarding", "test-sdp", undefined, TENANT.id,
      undefined, {
        browserRequestId: "request-terminal-write-failed", openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      });
    for (let turn = 0; turn < 10; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(durableProviderIdentity?.openai_call_id).toBe("rtc-terminal-write-failed");
    releaseTts(new Response("rejected", { status: 400 }));
    await expect(pending).rejects.toMatchObject({ message: "onboarding_tts_rejected" });
    expect(fetchUrls.filter((url) => url.endsWith("/hangup"))).toEqual([
      "https://api.openai.com/v1/realtime/calls/rtc-terminal-write-failed/hangup",
    ]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(budgetUpdates).toContainEqual(expect.objectContaining({ reconcile_last_error: "provider_usage_unresolved" }));
  });

  test("onboarding rejects missing or provider opening mode before call, budget, TTS, or Realtime", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new Error("provider must remain unreachable");
    };
    for (const options of [
      undefined,
      {
        browserRequestId: "stale-provider-request",
        openingModeRequested: "provider_model_v1" as const,
      },
    ]) {
      invalidateTenant("rocha-plumbing");
      await expect(startSession(
        "22222222-2222-4222-8222-222222222222",
        "onboarding",
        "test-sdp",
        undefined,
        TENANT.id,
        undefined,
        options,
      )).rejects.toMatchObject({
        message: "client_upgrade_required",
        status: 409,
      });
    }
    expect(callInserts).toBe(0);
    expect(rpcCalls.filter((call) => call.name === "reserve_call_budget"))
      .toHaveLength(0);
    expect(fetchUrls).toEqual([]);
  });

  test("session ceiling defaults to the primary maximum and rejects unbounded overrides", () => {
    expect(typeof configModule.parseSessionCostCeilingUsd).toBe("function");
    expect(configModule.parseSessionCostCeilingUsd(undefined)).toBe(1.5);
    expect(configModule.parseSessionCostCeilingUsd("2.75")).toBe(2.75);
    for (const value of ["0", "-1", "5.01", "NaN", "Infinity", "1.23456"]) {
      expect(() => configModule.parseSessionCostCeilingUsd(value)).toThrow("session_cost_ceiling_invalid");
    }
    expect(configModule.parseRealtimeCreateTimeoutMs(undefined)).toBe(6_000);
    expect(configModule.parseSidebandOpenTimeoutMs(undefined)).toBe(5_000);
    for (const value of ["999", "10001", "NaN"])
      expect(() => configModule.parseRealtimeCreateTimeoutMs(value))
        .toThrow("realtime_create_timeout_invalid");
    for (const value of ["249", "6001", "NaN"])
      expect(() => configModule.parseSidebandOpenTimeoutMs(value))
        .toThrow("sideband_open_timeout_invalid");
  });

  test("reserves the same validated ceiling used by the live cost kill switch", async () => {
    config.sessionCostCeilingUsd = 2.75;
    reserveError = { message: "budget cap" };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "budget_exceeded",
      status: 402,
    });

    const reservation = rpcCalls.find((call) => call.name === "reserve_call_budget");
    expect(reservation?.args.p_est_cost).toBe(2.75);
  });

  test("onboarding reserves its isolated USD 7.50 envelope without changing the customer ceiling", async () => {
    config.openaiKey = "synthetic-openai-key";
    reserveError = { message: "stop after reservation" };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-budget-envelope",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({ message: "budget_exceeded", status: 402 });

    expect(rpcCalls.find((call) => call.name === "reserve_call_budget")?.args)
      .toMatchObject({ p_est_cost: 7.5 });

    rpcCalls = [];
    invalidateTenant("rocha-plumbing");
    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "owner_browser",
      "test-sdp",
    )).rejects.toMatchObject({ message: "budget_exceeded", status: 402 });
    expect(rpcCalls.find((call) => call.name === "reserve_call_budget")?.args)
      .toMatchObject({ p_est_cost: 1.5 });
  });

  test("settles a reservation when startup cannot obtain an OpenAI session", async () => {
    config.openaiKey = "";

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "openai_key_missing",
      status: 503,
    });

    const settlements = rpcCalls.filter((call) => call.name === "settle_call_budget");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.args).toMatchObject({
      p_tenant: TENANT.id,
      p_call: "call-1",
      p_actual_cost: 0,
      p_minutes: 0,
      p_outcome: "startup_error",
    });
  });

  test("all definitive browser 4xx responses remain a safe not-applicable zero settlement", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("model rejected", { status: 400 });
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "realtime_unavailable",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(2);
    expect(callUpdates.some((row) => row.provider_usage_state === "not_applicable"
      && row.cost_estimate_usd === 0)).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(1);
  });

  const assertUnknownProviderRemainsDiscoverable = () => {
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
    expect(callUpdates.some((row) => row.status === "error"
      && row.provider_usage_state === "unknown"
      && row.cost_estimate_usd === null)).toBe(true);
    expect(budgetUpdates.some((row) => row.reconcile_lease_until === null && row.reconcile_last_error)).toBe(true);
  };

  const providerCreationRequests = () => fetchUrls.filter((url) => url.endsWith("/v1/realtime/calls"));

  test("application opening reserves before both providers and settles its known cost after definitive Realtime rejection", async () => {
    config.openaiKey = "synthetic-openai-key";
    floorWriteMode = "throw_exact";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech")) {
        expect(rpcCalls.map((call) => call.name).slice(0, 2)).toEqual([
          "reserve_call_budget",
          "initialize_onboarding_resume",
        ]);
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "tts-1-hd",
          voice: "ash",
          input: "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
          response_format: "mp3",
        });
        return new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      expect(fetchUrls[0]).toBe("https://api.openai.com/v1/audio/speech");
      expect(callUpdates).toContainEqual(expect.objectContaining({
        provider_termination_state: "unknown",
        provider_termination_mode: "hangup",
        provider_termination_reason: "provider_create_inflight",
      }));
      return new Response("model rejected", { status: 400 });
    };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-test-10",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "realtime_unavailable",
      status: 502,
    });

    expect(fetchUrls).toEqual([
      "https://api.openai.com/v1/audio/speech",
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls",
    ]);
    expect(callInsertRows[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111119",
      session_type: "onboarding",
    });
    expect(rpcCalls.find((call) => call.name === "settle_call_budget")?.args)
      .toMatchObject({ p_actual_cost: 0.00324, p_outcome: "startup_error" });
    expect(durableFloor).toBe(0.00324);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      provider_usage_state: "resolved",
      cost_estimate_usd: 0.00324,
    }));
  });

  test("a blocked latest resume state settles before TTS or provider work and never falls through fresh", async () => {
    config.openaiKey = "synthetic-openai-key";
    resumeRpcResult = {
      data: null,
      error: {
        code: "55000",
        message: "onboarding_resume_latest_ineligible",
      },
    };
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new Error("blocked resume must not reach a provider");
    };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-blocked-resume",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_resume_changed",
      status: 503,
    });
    expect(rpcCalls.map((call) => call.name).slice(0, 2)).toEqual([
      "reserve_call_budget",
      "initialize_onboarding_resume",
    ]);
    expect(fetchUrls).toEqual([]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(1);
  });

  test("resume initialization selects the exact persisted question before tts-1-hd", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).voice = "cedar";
    const callId = "11111111-1111-4111-8111-111111111119";
    resumeRpcResult = { data: resumedCheckpoint(callId), error: null };
    let ttsBody: Record<string, unknown> | null = null;
    let realtimeSession: Record<string, any> | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech")) {
        ttsBody = JSON.parse(String(init?.body));
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      const form = init?.body as FormData;
      realtimeSession = JSON.parse(String(form.get("session")));
      return new Response("model rejected", { status: 400 });
    };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-resumed-startup",
        openingModeRequested: "application_tts_v1",
        requestedCallId: callId,
      },
    )).rejects.toMatchObject({ message: "realtime_unavailable" });
    expect(ttsBody).toEqual({
      model: "tts-1-hd",
      voice: "ash",
      input:
        "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Vamos continuar de onde paramos. Quais cidades e regiões sua empresa atende?",
      response_format: "mp3",
    });
    expect(rpcCalls.map((call) => call.name).slice(0, 2)).toEqual([
      "reserve_call_budget",
      "initialize_onboarding_resume",
    ]);
    expect(realtimeSession?.audio?.output?.voice).toBe("ash");
    expect(String(realtimeSession?.instructions).split(
      "VOZ ONBOARDING: fale em português brasileiro natural, com sotaque brasileiro neutro, ritmo moderado, dicção clara e entonação calorosa.",
    )).toHaveLength(2);
  });

  test("successful resumed startup passes the target checkpoint into sideband lifecycle custody", async () => {
    config.openaiKey = "synthetic-openai-key";
    const callId = "11111111-1111-4111-8111-111111111119";
    resumeRpcResult = { data: resumedCheckpoint(callId), error: null };
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-resumed-startup" },
      });
    };
    globalThis.WebSocket = AutoOpenWebSocket as any;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const result = await startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-resumed-success",
        openingModeRequested: "application_tts_v1",
        requestedCallId: callId,
      },
    );
    expect(result.opening_payload).toMatchObject({
      version: 2,
      tts_model: "tts-1-hd",
      resume_context: {
        coverage_receipt_id: "55555555-5555-4555-8555-555555555555",
        revision: 1,
        snapshot_digest: "c".repeat(64),
        next_action: {
          type: "ask",
          field: "area.coverage",
          question_pt: "Quais cidades e regiões sua empresa atende?",
        },
      },
    });
    expect(liveSessions.get(callId)?.onboarding?.lifecycle.coverage)
      .toMatchObject({
        revision: 1,
        digest: "c".repeat(64),
        nextQuestion: {
          field: "area.coverage",
          questionPt: "Quais cidades e regiões sua empresa atende?",
        },
      });
    await cleanup!.cancel("test_cleanup");
    liveSessions.delete(callId);
  });

  test("cancellation while resume initialization is pending reaches neither TTS nor Realtime", async () => {
    config.openaiKey = "synthetic-openai-key";
    let releaseResume!: () => void;
    resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("must-not-run", { status: 400 });
    };
    const pending = startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-cancel-resume",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleanup).not.toBeNull();
    const cancelled = cleanup!.cancel("edge_cancel_resume_pending");
    releaseResume();
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
      status: 499,
    });
    expect(rpcCalls.filter((call) =>
      call.name === "initialize_onboarding_resume"
    )).toHaveLength(1);
    expect(fetchUrls).toEqual([]);
  });

  test("a checkpoint abandoned during TTS can chain once into the next startup with the same question", async () => {
    config.openaiKey = "synthetic-openai-key";
    const abandonedCall = "11111111-1111-4111-8111-111111111118";
    const recoveredCall = "11111111-1111-4111-8111-111111111117";
    resumeRpcResult = { data: resumedCheckpoint(abandonedCall), error: null };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    let ttsStarted!: () => void;
    const observedTts = new Promise<void>((resolve) => { ttsStarted = resolve; });
    globalThis.fetch = async (input, init) => {
      fetchUrls.push(String(input));
      ttsStarted();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      });
    };
    const abandoned = startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-abandoned-resume",
        openingModeRequested: "application_tts_v1",
        requestedCallId: abandonedCall,
      },
    );
    await observedTts;
    await cleanup!.cancel("edge_cancel_after_resume_checkpoint");
    await expect(abandoned).rejects.toMatchObject({
      message: "browser_request_cancelled",
      status: 499,
    });

    const chained = resumedCheckpoint(recoveredCall) as any;
    chained.source_call_id = abandonedCall;
    chained.source_receipt_id =
      "55555555-5555-4555-8555-555555555555";
    chained.coverage_receipt_id =
      "77777777-7777-4777-8777-777777777777";
    chained.coverage.resume_context = {
      source_call_id: abandonedCall,
      source_receipt_id: "55555555-5555-4555-8555-555555555555",
      source_revision: 1,
      source_snapshot_digest: "c".repeat(64),
    };
    resumeRpcResult = { data: chained, error: null };
    fetchUrls = [];
    let recoveredTtsBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech")) {
        recoveredTtsBody = JSON.parse(String(init?.body));
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }
      return new Response("model rejected", { status: 400 });
    };
    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-recovered-resume",
        openingModeRequested: "application_tts_v1",
        requestedCallId: recoveredCall,
      },
    )).rejects.toMatchObject({ message: "realtime_unavailable" });
    expect(recoveredTtsBody).toMatchObject({
      model: "tts-1-hd",
      input:
        "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Vamos continuar de onde paramos. Quais cidades e regiões sua empresa atende?",
    });
    const resumeCalls = rpcCalls.filter((call) =>
      call.name === "initialize_onboarding_resume"
    );
    expect(resumeCalls).toHaveLength(2);
    expect(resumeCalls.map((call) => call.args.p_target_call)).toEqual([
      abandonedCall,
      recoveredCall,
    ]);
  });

  test("cancellation during held budget reservation prevents every TTS/provider step and releases the reservation", async () => {
    config.openaiKey = "synthetic-openai-key";
    let releaseReserve!: () => void;
    reserveGate = new Promise<void>((resolve) => { releaseReserve = resolve; });
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-reserve",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleanup).not.toBeNull();
    const cancelled = cleanup!.cancel("edge_cancel_held_reserve");
    expect(fetchUrls).toEqual([]);
    expect(rpcCalls.filter((call) =>
      call.name === "initialize_onboarding_resume"
    )).toHaveLength(0);
    releaseReserve();
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
      status: 499,
    });
    expect(fetchUrls).toEqual([]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(1);
    expect(callUpdates.filter((row) => row.status === "error")).toHaveLength(1);
  });

  test("cancellation joins a late accepted provider and successful TTS, then hangs up exactly once", async () => {
    config.openaiKey = "synthetic-openai-key";
    let resolveTts!: (response: Response) => void;
    let resolveProvider!: (response: Response) => void;
    let ttsSignal: AbortSignal | null = null;
    let providerSignal: AbortSignal | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      if (url.endsWith("/v1/audio/speech")) {
        ttsSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((resolve) => { resolveTts = resolve; });
      }
      providerSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((resolve) => { resolveProvider = resolve; });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      TENANT.owner_user_id, "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-tts",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!resolveTts || !resolveProvider)
      await new Promise((resolve) => setImmediate(resolve));
    let cleanupFinished = false;
    const cancelled = cleanup!.cancel("edge_cancel_held_tts").then(() => { cleanupFinished = true; });
    resolveTts(new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
      status: 200, headers: { "content-type": "audio/mpeg" },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(cleanupFinished).toBe(false);
    resolveProvider(new Response("late-answer-sdp", {
      status: 200, headers: { Location: "/v1/realtime/calls/rtc-late-accept" },
    }));
    await cancelled;
    await expect(pending).rejects.toMatchObject({ message: "browser_request_cancelled" });
    await cleanup!.cancel("duplicate_cancel");
    expect(ttsSignal?.aborted).toBe(true);
    expect(providerSignal?.aborted).toBe(true);
    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.filter((url) => url.endsWith("/hangup"))).toEqual([
      "https://api.openai.com/v1/realtime/calls/rtc-late-accept/hangup",
    ]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error", cost_estimate_usd: 0.00324,
      provider_usage_state: "unknown",
    }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("HTTP 200 TTS body abort preserves known cost as resolved before cancellation settlement", async () => {
    config.openaiKey = "synthetic-openai-key";
    let releaseMarker!: () => void;
    providerMarkerGate = new Promise<void>((resolve) => { releaseMarker = resolve; });
    let bodyStarted = false;
    globalThis.fetch = async (input, init) => {
      fetchUrls.push(String(input));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyStarted = true;
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-tts-body-abort",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!bodyStarted) await new Promise((resolve) => setImmediate(resolve));
    const cancelled = cleanup!.cancel("edge_cancel_tts_body");
    releaseMarker();
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00324,
      provider_usage_state: "resolved",
      provider_termination_state: "not_required",
    }));
  });

  test("cancellation while provider marker is held retains the TTS floor and performs no provider POST", async () => {
    config.openaiKey = "synthetic-openai-key";
    let releaseMarker!: () => void;
    providerMarkerGate = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-marker",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!providerMarkerGate || callUpdates.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    const cancelled = cleanup!.cancel("edge_cancel_held_marker");
    releaseMarker();
    await cancelled;
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(fetchUrls).toEqual(["https://api.openai.com/v1/audio/speech"]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00324,
      provider_usage_state: "resolved",
      provider_termination_state: "not_required",
    }));
  });

  test("cancellation during held provider POST aborts the chain without fallback or ready", async () => {
    config.openaiKey = "synthetic-openai-key";
    let providerSignal: AbortSignal | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      providerSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    };
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-held-provider",
        openingModeRequested: "application_tts_v1",
        requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    while (!providerSignal) await new Promise((resolve) => setImmediate(resolve));
    await cleanup!.cancel("edge_cancel_held_provider");
    await expect(pending).rejects.toMatchObject({
      message: "browser_request_cancelled",
    });
    expect(providerSignal?.aborted).toBe(true);
    expect(providerCreationRequests()).toHaveLength(1);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      cost_estimate_usd: 0.00324,
      provider_usage_state: "unknown",
    }));
  });

  test("an unprovable TTS cost floor terminates the concurrent accepted Realtime call and preserves its known charge", async () => {
    config.openaiKey = "synthetic-openai-key";
    floorWriteMode = "unproven";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      if (url.endsWith("/v1/realtime/calls")) return new Response("answer-sdp", {
        status: 200, headers: { Location: "/v1/realtime/calls/rtc-unproven-floor" },
      });
      return new Response(audio, {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-floor-unproven",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_tts_cost_floor_unproven",
      status: 503,
    });
    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.filter((url) => url.endsWith("/hangup"))).toEqual([
      "https://api.openai.com/v1/realtime/calls/rtc-unproven-floor/hangup",
    ]);
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error", cost_estimate_usd: 0.00324, provider_usage_state: "unknown",
    }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("definitive rejection from both concurrent providers settles zero", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("rejected", { status: 400 });
    };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-tts-rejected",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_tts_rejected",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(2);
    expect(rpcCalls.find((call) => call.name === "settle_call_budget")?.args)
      .toMatchObject({ p_actual_cost: 0, p_outcome: "startup_error" });
  });

  test("indeterminate concurrent provider outcomes defer the reservation without a duplicate creation", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new TypeError("synthetic TTS transport loss");
    };

    await expect(startSession(
      "22222222-2222-4222-8222-222222222222",
      "onboarding",
      "test-sdp",
      undefined,
      TENANT.id,
      undefined,
      {
        browserRequestId: "request-tts-unknown",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "onboarding_tts_outcome_unknown",
      status: 503,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("unknown Realtime startup preserves the already durable TTS floor", async () => {
    config.openaiKey = "synthetic-openai-key";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      throw new TypeError("synthetic Realtime transport loss");
    };
    await expect(startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      undefined,
      {
        browserRequestId: "request-realtime-unknown-floor",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({ message: "provider_outcome_unknown" });
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0.00324,
    }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(0);
  });

  test("post-start cleanup preserves the TTS floor while Realtime usage is unresolved", async () => {
    config.openaiKey = "synthetic-openai-key";
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      if (url.endsWith("/v1/realtime/calls"))
        return new Response("answer-sdp", {
          status: 200,
          headers: { Location: "/v1/realtime/calls/rtc-cleanup-floor" },
        });
      return new Response(null, { status: 200 });
    };
    globalThis.WebSocket = AutoOpenWebSocket as any;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    await startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-cleanup-floor",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    );
    await cleanup!.cancel("ready_write_unknown");
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0.00324,
    }));
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget"))
      .toHaveLength(0);
  });

  test("first transport exception stops fallback and leaves the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      throw new Error("provider transport unknown");
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("Realtime SDP creation and body share a bounded deadline below the Edge processing expiry", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).realtimeCreateTimeoutMs = 10;
    globalThis.fetch = async (input, init) => {
      fetchUrls.push(String(input));
      return await new Promise<Response>((resolve, reject) => {
        const delayed = setTimeout(() =>
          resolve(new Response("late rejection", { status: 400 })), 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(delayed);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const started = performance.now();
    await expect(startSession(
      "22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp",
    )).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });
    expect(performance.now() - started).toBeLessThan(80);
    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("Realtime SDP body read is covered by the same provider deadline", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).realtimeCreateTimeoutMs = 10;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const delayed = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("late-sdp"));
            controller.close();
          }, 100);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(delayed);
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-body-timeout" },
      });
    };
    const started = performance.now();
    await expect(startSession(
      "22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp",
    )).rejects.toMatchObject({ message: "provider_outcome_unknown" });
    expect(performance.now() - started).toBeLessThan(80);
    expect(fetchUrls).toEqual([
      "https://api.openai.com/v1/realtime/calls",
      "https://api.openai.com/v1/realtime/calls/rtc-body-timeout/hangup",
    ]);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("2xx without Location stops fallback and leaves the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("answer-without-id", { status: 200 })
        : new Response("definitive fallback rejection", { status: 400 });
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("ambiguous 5xx stops fallback and leaves the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("provider internal error", { status: 503 })
        : new Response("definitive fallback rejection", { status: 400 });
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("5xx with Location confirms hangup but keeps usage unresolved", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("provider internal error", { status: 503, headers: { Location: "/v1/realtime/calls/rtc-ambiguous" } })
        : new Response(null, { status: 200 });
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.some((url) => url.endsWith("/rtc-ambiguous/hangup"))).toBe(true);
    expect(rpcCalls.some((call) => call.name === "complete_provider_termination_attempt"
      && call.args.p_confirmed === true)).toBe(true);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("body read failure after Location hangs up but keeps usage unresolved", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ Location: "/v1/realtime/calls/rtc-body-failed" }),
          text: async () => { throw new Error("SDP body transport failed"); },
        } as Response;
      }
      return new Response(null, { status: 200 });
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.some((url) => url.endsWith("/rtc-body-failed/hangup"))).toBe(true);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("empty SDP after Location is ambiguous and cannot fall back or settle", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("   \n", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-empty-sdp" } })
        : new Response(null, { status: 200 });
    };

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toMatchObject({
      message: "provider_outcome_unknown",
      status: 502,
    });

    expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.some((url) => url.endsWith("/rtc-empty-sdp/hangup"))).toBe(true);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("definitive 4xx can fall back and tracks only the successful call", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      return fetchUrls.length === 1
        ? new Response("unsupported model", { status: 400 })
        : new Response("fallback-answer", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-fallback" } });
    };
    globalThis.WebSocket = AutoOpenWebSocket as any;

    const result = await startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp");

    expect(fetchUrls).toHaveLength(2);
    expect(result.fell_back).toBe(true);
    expect(result).toMatchObject({
      opening_mode_applied: "provider_model_v1",
      opening_payload: null,
    });
    expect(callUpdates.some((row) => row.openai_call_id === "rtc-fallback" && row.provider_termination_state === "active")).toBe(true);
    expect(callUpdates.filter((row) =>
      row.provider_termination_state === "unknown"
    )).toEqual([
      expect.objectContaining({
        provider_termination_reason: "provider_create_inflight",
      }),
    ]);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });

  test("unproven provider identity never reaches sideband or ready and terminates by the in-memory provider ID", async () => {
    for (const mode of ["error", "zero"] as const) {
      providerAttempts = new Set();
      durableProviderIdentity = null;
      durableFloor = null;
      callUpdates = [];
      budgetUpdates = [];
      rpcCalls = [];
      providerIdentityMode = mode;
      config.openaiKey = "synthetic-openai-key";
      fetchUrls = [];
      globalThis.fetch = async (input) => {
        const url = String(input);
        fetchUrls.push(url);
        if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
        return new Response("answer-sdp", {
          status: 200,
          headers: { Location: "/v1/realtime/calls/rtc-identity-unproven" },
        });
      };
      let sockets = 0;
      globalThis.WebSocket = class {
        constructor() { sockets += 1; }
      } as any;
      await expect(startSession(
        "22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp",
      )).rejects.toMatchObject({
        message: "provider_identity_unproven",
        status: 503,
      });
      expect(sockets).toBe(0);
      expect(fetchUrls).toContain(
        "https://api.openai.com/v1/realtime/calls/rtc-identity-unproven/hangup",
      );
      expect(callUpdates).toContainEqual(expect.objectContaining({
        status: "error",
        provider_usage_state: "unknown",
      }));
      providerIdentityMode = "success";
    }
  });

  test("startSession does not publish SDP until the first sideband socket is open", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-await-open" },
      });
    };
    class DelayedOpenSocket {
      static instance: DelayedOpenSocket | null = null;
      listeners = new Map<string, Array<(event: any) => void>>();
      constructor() { DelayedOpenSocket.instance = this; }
      addEventListener(type: string, listener: (event: any) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send() {}
      close() {}
      emit(type: string, event: any = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = DelayedOpenSocket as any;
    let settled = false;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const pending = startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      (control) => { cleanup = control; },
      {
        browserRequestId: "request-await-sideband-open",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    ).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    DelayedOpenSocket.instance!.emit("open");
    const result = await pending;
    expect(result.sdp).toBe("answer-sdp");
    await cleanup!.cancel("test_cleanup");
  });

  test("non-onboarding sessions preserve asynchronous sideband-open behavior", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-legacy-open" },
      });
    };
    globalThis.WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    } as any;
    let cleanup: { cancel(reason: string): Promise<void> } | null = null;
    const result = await startSession(
      "22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp", undefined, undefined,
      (control) => { cleanup = control; },
    );
    expect(result.sdp).toBe("answer-sdp");
    await cleanup!.cancel("test_cleanup");
  });

  test("sideband open timeout cleans up the accepted provider call before any ready result", async () => {
    config.openaiKey = "synthetic-openai-key";
    (config as any).sidebandOpenTimeoutMs = 10;
    globalThis.fetch = async (input) => {
      const url = String(input);
      fetchUrls.push(url);
      if (url.endsWith("/v1/audio/speech"))
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0xff]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      if (url.endsWith("/hangup")) return new Response(null, { status: 200 });
      return new Response("answer-sdp", {
        status: 200,
        headers: { Location: "/v1/realtime/calls/rtc-open-timeout" },
      });
    };
    globalThis.WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    } as any;
    await expect(startSession(
      "22222222-2222-4222-8222-222222222222", "onboarding", "test-sdp", undefined, TENANT.id,
      undefined,
      {
        browserRequestId: "request-sideband-open-timeout",
        openingModeRequested: "application_tts_v1",
      requestedCallId: "11111111-1111-4111-8111-111111111119",
      },
    )).rejects.toMatchObject({
      message: "sideband_open_timeout",
      status: 502,
    });
    expect(fetchUrls).toContain(
      "https://api.openai.com/v1/realtime/calls/rtc-open-timeout/hangup",
    );
    expect(callUpdates).toContainEqual(expect.objectContaining({
      status: "error",
      provider_usage_state: "unknown",
      cost_estimate_usd: 0.00324,
    }));
  });

  test("accepted browser call attach failure confirms hangup but keeps unknown usage active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) {
        return new Response("answer-sdp", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-1" } });
      }
      return new Response(null, { status: 200 });
    };
    globalThis.WebSocket = class { constructor() { throw new Error("sideband attach failed"); } } as any;

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toThrow("sideband attach failed");

    expect(fetchUrls.some((url) => url.endsWith("/rtc-1/hangup"))).toBe(true);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("browser hangup transport failure keeps the reservation active", async () => {
    config.openaiKey = "synthetic-openai-key";
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (fetchUrls.length === 1) {
        return new Response("answer-sdp", { status: 200, headers: { Location: "/v1/realtime/calls/rtc-1" } });
      }
      throw new Error("hangup transport unknown");
    };
    globalThis.WebSocket = class { constructor() { throw new Error("sideband attach failed"); } } as any;

    await expect(startSession("22222222-2222-4222-8222-222222222222", "owner_browser", "test-sdp")).rejects.toThrow("sideband attach failed");

    expect(fetchUrls.some((url) => url.endsWith("/rtc-1/hangup"))).toBe(true);
    expect(rpcCalls.filter((call) => call.name === "settle_call_budget")).toHaveLength(0);
  });
});
