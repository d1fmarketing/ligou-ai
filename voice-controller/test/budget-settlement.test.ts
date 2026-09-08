import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as configModule from "../src/config.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { createVoiceStartupTrace, startSession as startSessionImplementation } from "../src/server.ts";
import { liveSessions } from "../src/sideband.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUnitTestEnvironment } from "../scripts/run-unit-tests.mjs";
import websiteFixture from './fixtures/foghorn-website-first-voice.json';
import {buildWebsiteAgendaSeeds} from '../src/onboarding-agenda-seed.ts';
import {buildWebsiteCandidateContext} from '../src/onboarding-website-summary.ts';
import {createOnboardingAgenda,applyVerifiedOwnerTurn,getAgendaAction} from '../src/onboarding-agenda.ts';
import {onboardingAgendaDigest,type StoredWebsiteInterview} from '../src/onboarding-agenda-store.ts';

const TENANT = {
  id: "11111111-1111-4111-8111-111111111111", slug: "rocha-plumbing", name: "Rocha Plumbing", vertical: "plumbing",
  languages: ["en", "es"], timezone: "America/Los_Angeles", session_max_minutes: 15,
  owner_user_id: "22222222-2222-4222-8222-222222222222", auth_epoch: 2, policy_epoch: 3,
};

const { config } = configModule;
const NATIVE_CALL='11111111-1111-4111-8111-111111111119';
const nativeOptions=(callId=NATIVE_CALL)=>({browserRequestId:callId.replace(/^11111111/,'44444444'),requestedCallId:callId,openingModeRequested:'realtime_native_v1' as const,onboardingProtocolVersion:5 as const});
const {tenant_id:_fixtureTenant,...draftReadback}=websiteFixture.draft_row;
let sourceError:{message:string;code?:string}|null=null,preparationError:{message:string;code?:string}|null=null;
let sourceGate:Promise<void>|null=null,preparationGate:Promise<void>|null=null,resumeSource:StoredWebsiteInterview|null=null,lastPrepared:StoredWebsiteInterview|null=null;
let preparationReached=false;
const cleanupControls=new Set<{cancel(reason:string):Promise<void>}>(),pendingStarts=new Set<Promise<unknown>>(),releases=new Set<()=>void>();
function startSession(...args:Parameters<typeof startSessionImplementation>){
  const registered=args[5];args[5]=control=>{cleanupControls.add(control);registered?.(control);};
  const pending=startSessionImplementation(...args);const observed=pending.then(()=>undefined,()=>undefined);pendingStarts.add(observed);void observed.then(()=>pendingStarts.delete(observed));return pending;
}
function heldGate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});releases.add(release);return{promise,release};}
async function until(check:()=>unknown,label:string){const deadline=Date.now()+1000;while(!check()){if(Date.now()>=deadline)throw new Error(`fixture did not reach ${label}`);await new Promise(resolve=>setImmediate(resolve));}}
function storedAgenda(agenda:any,version=0):StoredWebsiteInterview{return{agenda,revision:agenda.revision,storeVersion:version,digest:onboardingAgendaDigest(agenda),receiptId:'55555555-5555-4555-8555-555555555555',nextAction:getAgendaAction(agenda),state:getAgendaAction(agenda).itemId?'unfinished':'reviewing',replayed:false};}
function savedWebsiteSource(callId:string,answered=false){
  const projection=buildWebsiteAgendaSeeds({draftReadback,initialCoverage:{...websiteFixture.initial_coverage.snapshot,tenantId:TENANT.id,callId} as any});
  let agenda=createOnboardingAgenda({interviewId:callId,callId,draftId:projection.provenance.draftId,draftHash:projection.provenance.draftHash,sourceResultId:projection.provenance.sourceResultId,sourceResultHash:projection.provenance.sourceResultHash},projection.seeds,buildWebsiteCandidateContext(projection));
  if(answered)agenda=applyVerifiedOwnerTurn(agenda,{type:'verified_owner_turn',binding:agenda.binding,turnId:callId+':saved-territory',text:'Atendemos somente Novato.',proposal:{kind:'answer',itemId:getAgendaAction(agenda).itemId!}}).agenda;
  return storedAgenda(agenda,answered?1:0);
}

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
let providerIdentityMode: "success" | "error" | "zero" = "success";
let durableProviderIdentity: Record<string, unknown> | null = null;
let reserveGate: Promise<void> | null = null;
let providerMarkerGate: Promise<void> | null = null;
let terminalWriteError = false;
let identityResponseGate: Promise<void> | null = null;
let terminalResponseGate: Promise<void> | null = null;
let heldResponseReached = false;
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
          return durableProviderIdentity ? {data:structuredClone(durableProviderIdentity),error:null} : {data:null,error:null};
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
      if(['resolve_prepared_website_source','initialize_website_interview','attach_website_interview'].includes(name)){
        if(args.p_owner!==TENANT.owner_user_id||typeof args.p_call!=='string'||typeof args.p_request!=='string')return{data:null,error:{code:'42501',message:'interview_call_not_owner_bound'}};
        if(name==='resolve_prepared_website_source'){
          if(sourceGate)await sourceGate;if(sourceError)return{data:null,error:sourceError};
          return{data:{prepared:true,preparationId:'66666666-6666-4666-8666-666666666666',draftId:draftReadback.draft_id,draftHash:draftReadback.draft_hash,
            sourceResultId:draftReadback.draft.source_result_id,sourceResultHash:draftReadback.draft.source_result_hash,draft_readback:draftReadback,
            resume:resumeSource?{interviewId:resumeSource.agenda.binding.interviewId,priorCallId:resumeSource.agenda.binding.callId}:null},error:null};
        }
        if(preparationError)return{data:null,error:preparationError};
        if(name==='initialize_website_interview'){
          lastPrepared=storedAgenda(args.p_agenda);preparationReached=true;if(preparationGate)await preparationGate;
          return{data:lastPrepared,error:null};
        }
        if(name==='attach_website_interview'){
          if(!resumeSource||args.p_interview!==resumeSource.agenda.binding.interviewId||args.p_prior_call!==resumeSource.agenda.binding.callId)return{data:null,error:{message:'interview_resume_source_changed'}};
          const agenda=structuredClone(resumeSource.agenda);agenda.binding.callId=String(args.p_call);lastPrepared=storedAgenda(agenda,resumeSource.storeVersion+1);
          preparationReached=true;if(preparationGate)await preparationGate;return{data:lastPrepared,error:null};
        }
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
  globalThis.fetch = async()=>{throw new Error('unmocked network forbidden in budget fixture');};
  globalThis.WebSocket = class {constructor(){throw new Error('unmocked socket forbidden in budget fixture');}} as any;
  fetchUrls = [];
  callUpdates = [];
  budgetUpdates = [];
  providerAttempts = new Set();
  callInserts = 0;
  callInsertRows = [];
  providerIdentityMode = "success";
  durableProviderIdentity = null;
  reserveGate = null;
  providerMarkerGate = null;
  terminalWriteError = false;
  identityResponseGate = terminalResponseGate = null;
  heldResponseReached = false;
  sourceError=preparationError=null;sourceGate=preparationGate=null;resumeSource=lastPrepared=null;preparationReached=false;
  cleanupControls.clear();pendingStarts.clear();releases.clear();
  invalidateTenant("rocha-plumbing");
  _setClient(client());
});

afterEach(async () => {
  for(const release of releases)release();
  await new Promise(resolve=>setImmediate(resolve));
  for(const control of cleanupControls)await control.cancel('isolated_budget_fixture_cleanup');
  await Promise.allSettled([...pendingStarts]);
  expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);
  expect(rpcCalls.some(call=>['claim_website_interview_speech','claim_website_interview_stream','complete_website_interview_speech','prepare_website_interview_summary'].includes(call.name))).toBe(false);
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
    releases.add(()=>releaseIdentity());releases.add(()=>releaseTerminal());
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
      if(url.endsWith("/v1/audio/speech"))throw new Error("TTS forbidden");
      return new Response("answer-sdp",{status:200,headers:{Location:"/v1/realtime/calls/rtc-late-guard"}});
    };
    let cleanup: {cancel(reason:string):Promise<void>} | null=null;
    const pending=startSession(TENANT.owner_user_id,"onboarding","test-sdp",undefined,TENANT.id,control=>{cleanup=control;},
      nativeOptions());
    const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    await until(()=>identityStarted,"provider identity write");
    await cleanup!.cancel("late_guard_cancel");
    expect(row.provider_termination_state).toBe("confirmed");
    expect(fetchUrls.filter(url=>url.endsWith("/hangup"))).toHaveLength(1);
    // Model a faster terminal writer while both earlier responses are delayed.
    row.status="ended";releaseIdentity();releaseTerminal();
    for(let turn=0;turn<10;turn++)await new Promise(resolve=>setImmediate(resolve));
    expect(await outcome).toBe("browser_request_cancelled");
    expect(staleWritesRejected).toBe(2);
    expect(row.status).toBe("ended");expect(row.provider_termination_state).toBe("confirmed");
    expect(row.cost_estimate_usd).toBeNull();
    expect(rpcCalls.filter(call=>call.name==="settle_call_budget")).toHaveLength(0);
  });

  for (const held of ["provider identity", "terminal state"] as const) {
    test(`native cancellation hangs up a known provider while the ${held} response remains held`, async () => {
      config.openaiKey = "synthetic-openai-key";
      const gate=heldGate();
      if(held==='provider identity')identityResponseGate=gate.promise;
      else {terminalResponseGate=gate.promise;(config as any).sidebandOpenTimeoutMs=20;globalThis.WebSocket=class {addEventListener(){}send(){}close(){}} as any;}
      globalThis.fetch=async input=>{const url=String(input);fetchUrls.push(url);
        if(url.endsWith('/hangup'))return new Response(null,{status:200});
        if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');
        return new Response('answer-sdp',{status:200,headers:{Location:'/v1/realtime/calls/rtc-held-receipt'}});};
      let cleanup:{cancel(reason:string):Promise<void>}|null=null;
      const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());
      const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
      try{
        await until(()=>heldResponseReached,'held cleanup receipt');
        const cancelled=cleanup!.cancel('held_response_cancel');
        await until(()=>fetchUrls.some(url=>url.endsWith('/hangup')),'early provider hangup');
        const completedWhileHeld=await Promise.race([cancelled.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),750))]);
        gate.release();await cancelled;
        expect(await outcome).not.toBe('ready');expect(completedWhileHeld).toBe(true);
        expect(fetchUrls.filter(url=>url.endsWith('/hangup'))).toHaveLength(1);
        expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);
        expect(rpcCalls.filter(call=>call.name==='settle_call_budget')).toHaveLength(0);
        expect(callUpdates.filter(row=>row.status==='error').every(row=>!Object.hasOwn(row,'provider_termination_state'))).toBe(true);
      }finally{gate.release();await cleanup?.cancel('held_receipt_test_cleanup');await outcome;}
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
    const preparation = trace.measure("website_context", () => held);
    now = 102;
    await trace.measure("provider_create", () => { now = 105; });
    now = 110;
    release();
    await preparation;
    expect(events).toEqual([
      { evt: "voice.startup.stage", timing_version: 1, trace_scope: "session", request_id: scope.requestId, call_id: scope.callId,
        stage: "provider_create", outcome: "ok", stage_start_ms: 2, duration_ms: 3, elapsed_ms: 5 },
      { evt: "voice.startup.stage", timing_version: 1, trace_scope: "session", request_id: scope.requestId, call_id: scope.callId,
        stage: "website_context", outcome: "ok", stage_start_ms: 0, duration_ms: 10, elapsed_ms: 10 },
    ]);
    await expect(trace.measure("provider_identity", () => {
      throw new Error("synthetic-secret private transcript SDP");
    })).rejects.toThrow("synthetic-secret");
    expect(events.at(-1)?.outcome).toBe("error");
    expect(JSON.stringify(events)).not.toContain("synthetic-secret");
    const brokenLogger = createVoiceStartupTrace(scope, { write: () => { throw new Error("logger unavailable"); } });
    expect(await brokenLogger.measure("provider_identity", () => "preserved")).toBe("preserved");
  });

  test("persisted preparation finishes before provider creation and never generates an MP3", async () => {
    config.openaiKey='synthetic-openai-key';globalThis.WebSocket=AutoOpenWebSocket as any;
    const gate=heldGate();preparationGate=gate.promise;let published=false;
    globalThis.fetch=async input=>{const url=String(input);fetchUrls.push(url);if(url.endsWith('/hangup'))return new Response(null,{status:200});
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');
      return new Response('answer-sdp',{status:200,headers:{Location:'/v1/realtime/calls/rtc-stream-opening'}});};
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions()).then(result=>{published=true;return result;});
    pending.catch(()=>{});
    try{
      await until(()=>preparationReached,'persisted preparation');
      if(process.env.LIGOU_BUDGET_FORCE_PREPARATION_FAILURE==='1')throw new Error('intentional held-preparation teardown probe');
      expect(providerCreationRequests()).toHaveLength(0);expect(published).toBe(false);
      gate.release();const result=await pending;
      expect(result.sdp).toBe('answer-sdp');expect(result.opening_payload).toEqual({version:5,native:{callId:NATIVE_CALL,interviewId:NATIVE_CALL,revision:0,sourceDigest:lastPrepared!.digest}});
      expect(rpcCalls.some(call=>call.name==='claim_website_interview_stream'||call.name==='claim_website_interview_speech')).toBe(false);
      expect(providerCreationRequests()).toHaveLength(1);expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);
      expect(liveSessions.get(NATIVE_CALL)?.externalCostUsd).toBe(0);
    }finally{gate.release();}
  });

  test('a failed assertion during a held persisted preparation tears down its isolated process',()=>{
    const file=fileURLToPath(import.meta.url);
    let failure:any;
    try{execFileSync(process.execPath,['test',file,'--test-name-pattern','persisted preparation finishes before provider creation'],{
      env:{...createUnitTestEnvironment(),LIGOU_BUDGET_FORCE_PREPARATION_FAILURE:'1'},cwd:tmpdir(),encoding:'utf8',timeout:2000,stdio:['ignore','pipe','pipe'],
    });}catch(error){failure=error;}
    expect(failure?.status).toBe(1);expect(failure?.signal).toBeNull();
    expect(String(failure?.stderr)).toContain('intentional held-preparation teardown probe');
  });

  test("a failed terminal write still terminates an accepted native provider and defers budget settlement", async () => {
    config.openaiKey='synthetic-openai-key';terminalWriteError=true;(config as any).sidebandOpenTimeoutMs=20;
    globalThis.WebSocket=class {addEventListener(){}send(){}close(){}} as any;
    globalThis.fetch=async input=>{const url=String(input);fetchUrls.push(url);if(url.endsWith('/hangup'))return new Response(null,{status:200});
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');
      return new Response('answer-sdp',{status:200,headers:{Location:'/v1/realtime/calls/rtc-terminal-write-failed'}});};
    await expect(startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions())).rejects.toMatchObject({message:'sideband_open_timeout'});
    expect(fetchUrls.filter(url=>url.endsWith('/hangup'))).toEqual(['https://api.openai.com/v1/realtime/calls/rtc-terminal-write-failed/hangup']);
    expect(rpcCalls.filter(call=>call.name==='settle_call_budget')).toHaveLength(0);
    expect(budgetUpdates).toContainEqual(expect.objectContaining({reconcile_last_error:'provider_usage_unresolved'}));
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
      {...nativeOptions(),openingModeRequested:'application_tts_v1' as const,onboardingProtocolVersion:3 as const},
      {...nativeOptions(),openingModeRequested:'realtime_stream_v1' as const,onboardingProtocolVersion:4 as const},
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
      nativeOptions(),
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

  test("native start reserves and prepares current website context before Realtime; definitive rejection settles zero", async () => {
    config.openaiKey='synthetic-openai-key';
    globalThis.fetch=async(input,init)=>{const url=String(input);fetchUrls.push(url);
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('No TTS or other provider');
      expect(rpcCalls.map(call=>call.name)).toEqual(['reserve_call_budget','resolve_prepared_website_source','initialize_website_interview']);
      const session=JSON.parse(String((init?.body as FormData).get('session')));
      expect(session.output_modalities).toEqual(['audio']);expect(session.tool_choice).toBe('auto');
      expect(session.tools.map((tool:any)=>tool.name)).toContain('submit_website_interview_proposal');
      expect(session.audio.input.turn_detection.create_response).toBe(true);
      expect(session.instructions).toContain(lastPrepared!.nextAction.questionPt);
      return new Response('model rejected',{status:400});};
    await expect(startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions())).rejects.toMatchObject({message:'realtime_unavailable',status:502});
    expect(providerCreationRequests()).toHaveLength(2);expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);
    expect(rpcCalls.find(call=>call.name==='settle_call_budget')?.args).toMatchObject({p_actual_cost:0,p_minutes:0,p_outcome:'startup_error'});
    expect(callUpdates).toContainEqual(expect.objectContaining({provider_usage_state:'not_applicable',cost_estimate_usd:0}));
    expect(lastPrepared?.agenda.items).toHaveLength(114);
  });

  for(const boundary of ['source','preparation'] as const)test(`failed website ${boundary} settles before every provider and cannot fall through`,async()=>{
    config.openaiKey='synthetic-openai-key';
    if(boundary==='source')sourceError={code:'55000',message:'interview_resume_source_not_settled'};
    else preparationError={code:'42501',message:'interview_preparation_unproven'};
    globalThis.fetch=async input=>{fetchUrls.push(String(input));throw new Error('Provider forbidden');};
    await expect(startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions())).rejects.toMatchObject({status:503});
    expect(fetchUrls).toEqual([]);expect(rpcCalls.some(call=>call.name==='initialize_onboarding_resume')).toBe(false);
    expect(rpcCalls.filter(call=>call.name==='settle_call_budget')).toHaveLength(1);
    expect(rpcCalls.find(call=>call.name==='settle_call_budget')?.args.p_actual_cost).toBe(0);
  });

  test("successful native resume binds the persisted next question and raw answers to sideband custody",async()=>{
    config.openaiKey='synthetic-openai-key';(config as any).voice='cedar';globalThis.WebSocket=AutoOpenWebSocket as any;
    resumeSource=savedWebsiteSource('33333333-3333-4333-8333-333333333333',true);const original=structuredClone(resumeSource);
    let realtimeSession:any;
    globalThis.fetch=async(input,init)=>{const url=String(input);fetchUrls.push(url);if(url.endsWith('/hangup'))return new Response(null,{status:200});
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');
      realtimeSession=JSON.parse(String((init?.body as FormData).get('session')));
      return new Response('answer-sdp',{status:200,headers:{Location:'/v1/realtime/calls/rtc-resumed-stream'}});};
    const result=await startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions());
    expect(result.opening_payload).toEqual({version:5,native:{callId:NATIVE_CALL,interviewId:original.agenda.binding.interviewId,revision:1,sourceDigest:lastPrepared!.digest}});
    expect(realtimeSession.instructions).toContain(lastPrepared!.nextAction.questionPt);
    expect(realtimeSession.instructions).toContain(original.agenda.ownerTurns[0].text);
    expect(realtimeSession.audio.output.voice).toBe('ash');expect(realtimeSession.output_modalities).toEqual(['audio']);
    expect(realtimeSession.tools.map((tool:any)=>tool.name)).toContain('submit_website_interview_proposal');
    expect(liveSessions.get(NATIVE_CALL)?.websiteInterviewRuntime?.state.stored.agenda.ownerTurns).toEqual(original.agenda.ownerTurns);
    expect(liveSessions.get(NATIVE_CALL)?.externalCostUsd).toBe(0);expect(resumeSource).toEqual(original);
    expect(rpcCalls.filter(call=>call.name==='attach_website_interview')).toHaveLength(1);
    expect(rpcCalls.some(call=>call.name==='initialize_website_interview'||call.name==='initialize_onboarding_resume')).toBe(false);
    expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);
  });

  for(const boundary of ['source','preparation'] as const)test(`cancellation while website ${boundary} is held creates no provider session or TTS charge`,async()=>{
    config.openaiKey='synthetic-openai-key';const gate=heldGate();if(boundary==='source')sourceGate=gate.promise;else preparationGate=gate.promise;
    let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    globalThis.fetch=async input=>{fetchUrls.push(String(input));throw new Error('Provider forbidden');};
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());
    const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    try{
      await until(()=>boundary==='source'?rpcCalls.some(call=>call.name==='resolve_prepared_website_source'):preparationReached,'held website boundary');
      await cleanup!.cancel('cancel_held_website');gate.release();
      expect(await outcome).toBe('browser_request_cancelled');expect(fetchUrls).toEqual([]);
      expect(rpcCalls.find(call=>call.name==='settle_call_budget')?.args).toMatchObject({p_actual_cost:0,p_minutes:0});
    }finally{gate.release();await outcome;}
  });

  test("abandoned native preparation resumes the same finite question in a new call without resetting its source",async()=>{
    config.openaiKey='synthetic-openai-key';const gate=heldGate();preparationGate=gate.promise;
    const abandonedCall='11111111-1111-4111-8111-111111111118',recoveredCall='11111111-1111-4111-8111-111111111117';
    let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    globalThis.fetch=async input=>{fetchUrls.push(String(input));return new Response('rejected',{status:400});};
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions(abandonedCall));
    const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    try{
      await until(()=>preparationReached,'abandoned persisted preparation');const before=structuredClone(lastPrepared!);
      await cleanup!.cancel('cancel_prepared_stream');gate.release();expect(await outcome).toBe('browser_request_cancelled');
      resumeSource=before;preparationGate=null;preparationReached=false;durableProviderIdentity=null;
      await expect(startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions(recoveredCall))).rejects.toMatchObject({message:'realtime_unavailable'});
      expect(lastPrepared!.agenda.binding).toMatchObject({interviewId:abandonedCall,callId:recoveredCall,draftId:before.agenda.binding.draftId});
      expect(lastPrepared!.nextAction.questionPt).toBe(before.nextAction.questionPt);expect(lastPrepared!.agenda.items).toEqual(before.agenda.items);
      expect(rpcCalls.filter(call=>call.name==='initialize_website_interview')).toHaveLength(1);expect(rpcCalls.filter(call=>call.name==='attach_website_interview')).toHaveLength(1);
      expect(fetchUrls.every(url=>url.endsWith('/v1/realtime/calls'))).toBe(true);
    }finally{gate.release();await outcome;}
  });

  test("cancellation during held budget reservation prevents source, preparation and provider work",async()=>{
    config.openaiKey='synthetic-openai-key';const gate=heldGate();reserveGate=gate.promise;let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());
    const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    try{
      await until(()=>cleanup&&rpcCalls.some(call=>call.name==='reserve_call_budget'),'reservation');const cancelled=cleanup!.cancel('cancel_held_reserve');
      expect(fetchUrls).toEqual([]);expect(rpcCalls.some(call=>call.name==='resolve_prepared_website_source')).toBe(false);
      gate.release();await cancelled;expect(await outcome).toBe('browser_request_cancelled');expect(fetchUrls).toEqual([]);
      expect(rpcCalls.filter(call=>call.name==='settle_call_budget')).toHaveLength(1);
    }finally{gate.release();await outcome;}
  });

  test("native cancellation joins a late accepted Realtime call and hangs up exactly once with no invented TTS cost",async()=>{
    config.openaiKey='synthetic-openai-key';let releaseProvider!:(response:Response)=>void,providerSignal:AbortSignal|null=null;
    globalThis.fetch=async(input,init)=>{const url=String(input);fetchUrls.push(url);if(url.endsWith('/hangup'))return new Response(null,{status:200});
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');providerSignal=init?.signal as AbortSignal;
      return new Promise<Response>(resolve=>{releaseProvider=resolve;releases.add(()=>resolve(new Response('late cleanup rejection',{status:400})));});};
    let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    await until(()=>releaseProvider,'provider POST');let finished=false;const cancelled=cleanup!.cancel('cancel_late_provider').then(()=>{finished=true;});
    await new Promise(resolve=>setImmediate(resolve));expect(finished).toBe(false);
    releaseProvider(new Response('late-answer',{status:200,headers:{Location:'/v1/realtime/calls/rtc-late-stream'}}));await cancelled;
    expect(await outcome).toBe('browser_request_cancelled');expect(providerSignal?.aborted).toBe(true);expect(providerCreationRequests()).toHaveLength(1);
    expect(fetchUrls.filter(url=>url.endsWith('/hangup'))).toEqual(['https://api.openai.com/v1/realtime/calls/rtc-late-stream/hangup']);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("accepted Realtime SDP body abort retains provider cleanup and unresolved usage",async()=>{
    config.openaiKey='synthetic-openai-key';let bodyStarted=false,aborted=false;
    globalThis.fetch=async(input,init)=>{const url=String(input);fetchUrls.push(url);if(url.endsWith('/hangup'))return new Response(null,{status:200});
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');
      const body=new ReadableStream<Uint8Array>({start(controller){bodyStarted=true;init?.signal?.addEventListener('abort',()=>{aborted=true;controller.error(new DOMException('aborted','AbortError'));});}});
      return new Response(body,{status:200,headers:{Location:'/v1/realtime/calls/rtc-body-cancel'}});};
    let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    await until(()=>bodyStarted,'SDP body');await cleanup!.cancel('cancel_sdp_body');expect(await outcome).toBe('browser_request_cancelled');
    expect(aborted).toBe(true);expect(providerCreationRequests()).toHaveLength(1);expect(fetchUrls.filter(url=>url.endsWith('/hangup'))).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("cancellation while the provider marker is held settles zero without a provider POST",async()=>{
    config.openaiKey='synthetic-openai-key';const gate=heldGate();providerMarkerGate=gate.promise;let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    try{
      await until(()=>callUpdates.some(row=>row.provider_termination_reason==='provider_create_inflight'),'provider marker');
      await cleanup!.cancel('cancel_provider_marker');gate.release();expect(await outcome).toBe('browser_request_cancelled');expect(fetchUrls).toEqual([]);
      expect(callUpdates).toContainEqual(expect.objectContaining({status:'error',cost_estimate_usd:0,provider_usage_state:'not_applicable',provider_termination_state:'not_required'}));
    }finally{gate.release();await outcome;}
  });

  test("cancellation during an abortable provider POST neither falls back nor publishes ready",async()=>{
    config.openaiKey='synthetic-openai-key';let providerSignal:AbortSignal|null=null;
    globalThis.fetch=async(input,init)=>{const url=String(input);fetchUrls.push(url);if(!url.endsWith('/v1/realtime/calls'))throw new Error('unexpected provider operation');
      providerSignal=init?.signal as AbortSignal;return new Promise<Response>((_resolve,reject)=>{providerSignal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));});};
    let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    const pending=startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());const outcome=pending.then(()=>"ready",(error:Error)=>error.message);
    await until(()=>providerSignal,'abortable provider POST');await cleanup!.cancel('cancel_provider_post');
    expect(await outcome).toBe('browser_request_cancelled');expect(providerSignal?.aborted).toBe(true);expect(providerCreationRequests()).toHaveLength(1);
    assertUnknownProviderRemainsDiscoverable();
  });

  test("unknown native provider outcome remains discoverable with no TTS charge or duplicate creation",async()=>{
    config.openaiKey='synthetic-openai-key';globalThis.fetch=async input=>{fetchUrls.push(String(input));throw new TypeError('synthetic Realtime transport loss');};
    await expect(startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,undefined,nativeOptions())).rejects.toMatchObject({message:'provider_outcome_unknown'});
    expect(providerCreationRequests()).toHaveLength(1);expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);assertUnknownProviderRemainsDiscoverable();
  });

  test("post-start native cleanup preserves unknown Realtime usage with zero external TTS cost",async()=>{
    config.openaiKey='synthetic-openai-key';globalThis.WebSocket=AutoOpenWebSocket as any;
    globalThis.fetch=async input=>{const url=String(input);fetchUrls.push(url);if(url.endsWith('/hangup'))return new Response(null,{status:200});
      if(!url.endsWith('/v1/realtime/calls'))throw new Error('TTS forbidden');return new Response('answer-sdp',{status:200,headers:{Location:'/v1/realtime/calls/rtc-stream-cleanup'}});};
    let cleanup:{cancel(reason:string):Promise<void>}|null=null;
    await startSession(TENANT.owner_user_id,'onboarding','test-sdp',undefined,TENANT.id,c=>{cleanup=c;},nativeOptions());
    expect(liveSessions.get(NATIVE_CALL)?.externalCostUsd).toBe(0);await cleanup!.cancel('ready_publication_unknown');
    expect(fetchUrls.some(url=>url.includes('/audio/speech'))).toBe(false);assertUnknownProviderRemainsDiscoverable();
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
      if (url.endsWith("/v1/audio/speech")) throw new Error("TTS forbidden");
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
      nativeOptions(),
    ).then((result) => { settled = true; return result; });
    pending.catch(()=>{});releases.add(()=>DelayedOpenSocket.instance?.emit("open"));
    await until(()=>DelayedOpenSocket.instance,"sideband socket construction");
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
      if (url.endsWith("/v1/audio/speech")) throw new Error("TTS forbidden");
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
      nativeOptions(),
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
      cost_estimate_usd: null,
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
