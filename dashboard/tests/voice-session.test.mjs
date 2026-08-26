import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root: dashboardRoot,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const sessionModule = await vite.ssrLoadModule("/src/voice/session.js");
after(async () => { await vite.close(); });

const {
  applyCurrentSessionRun,
  endedVoiceSessionCopy,
  onboardingOutcomeCopy,
  resolveOnboardingOutcome,
  settleStartedSession,
  startVoiceSession,
  watchOnboardingOutcome,
} = sessionModule;

const CALL_ID = "7f58ee06-6a13-4d45-a2d5-c60244dc92a3";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";

function approvalRow(overrides = {}) {
  return {
    id: APPROVAL_ID,
    call_id: CALL_ID,
    kind: "onboarding_voice_approval",
    outcome: "accepted",
    readback: {
      call_id: CALL_ID,
      snapshot_revision: 8,
      snapshot_receipt_id: "22222222-2222-4222-8222-222222222222",
      snapshot_digest: "a".repeat(64),
    },
    ...overrides,
  };
}

function callRow(overrides = {}) {
  return {
    id: CALL_ID,
    session_type: "onboarding",
    status: "ended",
    provider_termination_state: "confirmed",
    provider_termination_reason: "agent_ended_session",
    ...overrides,
  };
}

function queryClient({ receipt = { data: null, error: null }, call = { data: null, error: null } } = {}) {
  const queries = [];
  return {
    queries,
    from(table) {
      const query = { table, columns: null, equals: [], orders: [], limit: null, abortSignal: null };
      queries.push(query);
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(column, value) { query.equals.push([column, value]); return builder; },
        order(column, options) { query.orders.push([column, options]); return builder; },
        limit(value) { query.limit = value; return builder; },
        abortSignal(signal) { query.abortSignal = signal; return builder; },
        maybeSingle() {
          const configured = table === "receipts" ? receipt : call;
          return typeof configured === "function" ? configured(query) : Promise.resolve(configured);
        },
      };
      return builder;
    },
  };
}

function installVoiceBrowser({ fetchImpl, remoteDescriptionError } = {}) {
  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    RTCPeerConnection: Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
  };
  const tracks = [{ stopped: false, stopCalls: 0, stop() { this.stopped = true; this.stopCalls += 1; } }];
  const channel = { onmessage: null, onclose: null };
  const peers = [];

  class Peer {
    constructor() { peers.push(this); }
    connectionState = "new";
    closeCalls = 0;
    ontrack = null;
    onconnectionstatechange = null;
    createDataChannel() { return channel; }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
    async setLocalDescription() {}
    async setRemoteDescription() { if (remoteDescriptionError) throw remoteDescriptionError; }
    close() { this.closeCalls += 1; this.connectionState = "closed"; }
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ autoplay: false, srcObject: null }) },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl ?? (async () => ({
      ok: true,
      json: async () => ({ sdp: "answer-sdp", call_id: CALL_ID, max_minutes: 1 }),
    })),
  });

  return {
    tracks,
    peers,
    restore() {
      for (const [name, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test("session end reports explicit reason and exact call identity", async () => {
  const browser = installVoiceBrowser();
  try {
    let ended = null;
    const session = await startVoiceSession({
      accessToken: "owner-token",
      sessionType: "onboarding",
      onEnd: (event) => { ended = event; },
    });

    session.end("manual_hangup");

    assert.deepEqual(ended, { reason: "manual_hangup", callId: CALL_ID });
    assert.equal(browser.tracks[0].stopped, true);
  } finally {
    browser.restore();
  }
});

test("onEnd during setup prevents a late start resolution from restoring live", async () => {
  let status = "connecting";
  let ended = false;
  let release;
  const start = new Promise((resolve) => { release = resolve; });
  const session = { endCalls: 0, end() { this.endCalls += 1; } };
  const settled = start.then((resolved) => settleStartedSession({
    session: resolved,
    runId: 1,
    currentRunId: 1,
    cancelled: false,
    ended,
    onAccepted() { status = "live"; },
  }));

  ended = true;
  status = "ended";
  release(session);

  assert.equal(await settled, false);
  assert.equal(status, "ended");
  assert.equal(session.endCalls, 1);
});

test("manual close during setup also rejects the late session", async () => {
  let status = "interrupted";
  const session = { endCalls: 0, end() { this.endCalls += 1; } };

  const accepted = settleStartedSession({
    session,
    runId: 1,
    currentRunId: 1,
    cancelled: true,
    ended: false,
    onAccepted() { status = "live"; },
  });

  assert.equal(accepted, false);
  assert.equal(status, "interrupted");
  assert.equal(session.endCalls, 1);
});

test("overlapping A and B setup keeps stale A callbacks and resolution out of B", async () => {
  let currentRunId = 1;
  let status = "connecting-a";
  const sessionA = { endCalls: 0, end() { this.endCalls += 1; } };
  const sessionB = { endCalls: 0, end() { this.endCalls += 1; } };

  assert.equal(applyCurrentSessionRun({
    runId: 1,
    currentRunId,
    onCurrent() { status = "ended-a"; },
  }), true);
  currentRunId = 2;
  status = "connecting-b";

  assert.equal(settleStartedSession({
    session: sessionA,
    runId: 1,
    currentRunId,
    cancelled: false,
    ended: false,
    onAccepted() { status = "live-a"; },
  }), false);
  assert.equal(applyCurrentSessionRun({
    runId: 1,
    currentRunId,
    onCurrent() { status = "overwritten-by-a"; },
  }), false);
  assert.equal(status, "connecting-b");
  assert.equal(sessionA.endCalls, 1);

  assert.equal(settleStartedSession({
    session: sessionB,
    runId: 2,
    currentRunId,
    cancelled: false,
    ended: false,
    onAccepted() { status = "live-b"; },
  }), true);
  assert.equal(status, "live-b");
  assert.equal(sessionB.endCalls, 0);
});

test("fetch rejection after microphone acquisition releases every browser resource", async () => {
  const browser = installVoiceBrowser({ fetchImpl: async () => { throw new Error("fetch_failed"); } });
  try {
    await assert.rejects(() => startVoiceSession({ accessToken: "owner-token" }), /fetch_failed/);
    assert.equal(browser.tracks[0].stopCalls, 1);
    assert.equal(browser.peers[0].closeCalls, 1);
  } finally {
    browser.restore();
  }
});

test("remote-description failure releases resources and normal cleanup stays idempotent", async () => {
  const failed = installVoiceBrowser({ remoteDescriptionError: new Error("remote_description_failed") });
  try {
    await assert.rejects(() => startVoiceSession({ accessToken: "owner-token" }), /remote_description_failed/);
    assert.equal(failed.tracks[0].stopCalls, 1);
    assert.equal(failed.peers[0].closeCalls, 1);
  } finally {
    failed.restore();
  }

  const normal = installVoiceBrowser();
  try {
    const session = await startVoiceSession({ accessToken: "owner-token" });
    session.end("manual_hangup");
    session.end("manual_hangup");
    assert.equal(normal.tracks[0].stopCalls, 1);
    assert.equal(normal.peers[0].closeCalls, 1);
  } finally {
    normal.restore();
  }
});

test("peer close without an acknowledgement is interrupted and queries only the exact call", async () => {
  const client = queryClient({ call: { data: callRow(), error: null } });

  const outcome = await resolveOnboardingOutcome({
    client,
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "interrupted" });
  const receiptQuery = client.queries.find((entry) => entry.table === "receipts");
  const callQuery = client.queries.find((entry) => entry.table === "calls");
  assert.deepEqual(receiptQuery.equals, [
    ["call_id", CALL_ID],
    ["kind", "onboarding_voice_approval"],
    ["outcome", "accepted"],
  ]);
  assert.deepEqual(callQuery.equals, [
    ["id", CALL_ID],
    ["session_type", "onboarding"],
  ]);
});

test("durable acknowledgement with provider termination pending is finalizing", async () => {
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: { data: callRow({ status: "active", provider_termination_state: "pending" }), error: null },
  });

  const outcome = await resolveOnboardingOutcome({
    client, reason: "remote_hangup", callId: CALL_ID, timeoutMs: 5, pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "finalizing", revision: 8 });
});

test("only exact acknowledgement plus confirmed provider and ended call is complete", async () => {
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: { data: callRow(), error: null },
  });

  const outcome = await resolveOnboardingOutcome({ client, reason: "remote_hangup", callId: CALL_ID });

  assert.deepEqual(outcome, { status: "complete", revision: 8 });
});

test("confirmed provider termination is complete only for application-owned agent close", async () => {
  for (const provider_termination_reason of ["caller_hung_up", null, "abandoned", "sideband_error"]) {
    const client = queryClient({
      receipt: { data: approvalRow(), error: null },
      call: { data: callRow({ provider_termination_reason }), error: null },
    });

    const outcome = await resolveOnboardingOutcome({
      client, reason: "remote_hangup", callId: CALL_ID, timeoutMs: 5, pollIntervalMs: 1,
    });

    assert.deepEqual(outcome, { status: "interrupted", revision: 8 });
    assert.match(client.queries.find((entry) => entry.table === "calls").columns, /provider_termination_reason/);
  }
});

test("bounded polling reaches durable completion from active provider state", async () => {
  let callReads = 0;
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: () => Promise.resolve({
      data: callReads++ === 0
        ? callRow({ status: "active", provider_termination_state: "pending" })
        : callRow(),
      error: null,
    }),
  });

  const outcome = await resolveOnboardingOutcome({
    client, reason: "remote_hangup", callId: CALL_ID, timeoutMs: 500, pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "complete", revision: 8 });
  assert.equal(callReads, 2);
});

test("the production outcome window spans the provider timeout plus database margin", async () => {
  let clock = 0;
  let callReads = 0;
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: () => {
      callReads += 1;
      return Promise.resolve({
        data: clock < 6_000
          ? callRow({ status: "active", provider_termination_state: "pending" })
          : callRow(),
        error: null,
      });
    },
  });

  const outcome = await resolveOnboardingOutcome({
    client,
    reason: "remote_hangup",
    callId: CALL_ID,
    pollIntervalMs: 1_000,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    isCancelled: () => callReads > 12,
  });

  assert.deepEqual(outcome, { status: "complete", revision: 8 });
  assert.ok(clock >= 6_000);
  assert.ok(callReads <= 12);
});

test("deadline aborts both real query builders through their captured child signals", async () => {
  const captured = [];
  let active = 0;
  let maxActive = 0;
  const hangingRead = (query) => new Promise((resolve) => {
    const signal = query.abortSignal;
    captured.push(signal);
    active += 1;
    maxActive = Math.max(maxActive, active);
    signal.addEventListener("abort", () => {
      active -= 1;
      resolve({ data: null, error: { message: "aborted" } });
    }, { once: true });
  });

  const outcome = await resolveOnboardingOutcome({
    client: queryClient({ receipt: hangingRead, call: hangingRead }),
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "interrupted" });
  assert.equal(captured.length, 2);
  assert.equal(captured.every((signal) => signal instanceof AbortSignal && signal.aborted), true);
  assert.equal(active, 0);
  assert.equal(maxActive, 2);
});

test("watcher never overlaps a new probe with the prior aborted receipt and call reads", async () => {
  let active = 0;
  let maxActive = 0;
  let queryStarts = 0;
  const hangingRead = (query) => new Promise((resolve) => {
    queryStarts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    query.abortSignal.addEventListener("abort", () => {
      active -= 1;
      resolve({ data: null, error: { message: "aborted" } });
    }, { once: true });
  });
  const published = [];

  await watchOnboardingOutcome({
    client: queryClient({ receipt: hangingRead, call: hangingRead }),
    reason: "remote_hangup",
    callId: CALL_ID,
    knownRevision: 8,
    timeoutMs: 5,
    pollIntervalMs: 1,
    retryDelayMs: 250,
    sleep: async () => {},
    isCancelled: () => queryStarts >= 4,
    onOutcome: (value) => { published.push(value); },
  });

  assert.equal(queryStarts, 4);
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
  assert.deepEqual(published, [{ status: "finalizing", revision: 8 }]);
});

test("a finalizing watcher re-enters exact resolution and publishes terminal truth", async () => {
  const outcomes = [
    { status: "finalizing", revision: 8 },
    { status: "complete", revision: 8 },
  ];
  const published = [];
  const sleeps = [];
  const scopes = [];
  let resolveCalls = 0;

  const outcome = await watchOnboardingOutcome({
    client: {},
    reason: "remote_hangup",
    callId: CALL_ID,
    resolve: async (scope) => {
      scopes.push({ callId: scope.callId, reason: scope.reason });
      return outcomes[resolveCalls++];
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    onOutcome: (value) => { published.push(value); },
  });

  assert.deepEqual(outcome, { status: "complete", revision: 8 });
  assert.deepEqual(published, outcomes);
  assert.equal(resolveCalls, 2);
  assert.deepEqual(scopes, [
    { callId: CALL_ID, reason: "remote_hangup" },
    { callId: CALL_ID, reason: "remote_hangup" },
  ]);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 250, "finalizing recheck must not hot-poll");
});

test("known finalizing revision survives a transient receipt outage but cannot authorize completion", async () => {
  const clients = [
    queryClient({
      receipt: { data: approvalRow(), error: null },
      call: { data: callRow({ status: "active", provider_termination_state: "pending" }), error: null },
    }),
    queryClient({
      receipt: { data: null, error: { message: "temporary outage" } },
      call: { data: callRow(), error: null },
    }),
    queryClient({
      receipt: { data: approvalRow(), error: null },
      call: { data: callRow(), error: null },
    }),
  ];
  const published = [];
  const known = [];
  let probe = 0;

  const outcome = await watchOnboardingOutcome({
    client: {},
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
    retryDelayMs: 250,
    sleep: async () => {},
    resolve: async (scope) => {
      known.push(scope.knownRevision ?? null);
      return resolveOnboardingOutcome({ ...scope, client: clients[probe++] });
    },
    onOutcome: (value) => { published.push(value); },
  });

  assert.deepEqual(outcome, { status: "complete", revision: 8 });
  assert.deepEqual(known, [null, 8, 8]);
  assert.deepEqual(published, [
    { status: "finalizing", revision: 8 },
    { status: "finalizing", revision: 8 },
    { status: "complete", revision: 8 },
  ]);
});

test("non-reconcilable or structurally invalid provider state interrupts once", async () => {
  for (const provider_termination_state of ["external_evidence_required", "not_required", "bogus", null]) {
    const published = [];
    const outcome = await watchOnboardingOutcome({
      client: queryClient({
        receipt: { data: approvalRow(), error: null },
        call: { data: callRow({ provider_termination_state }), error: null },
      }),
      reason: "remote_hangup",
      callId: CALL_ID,
      timeoutMs: 5,
      retryDelayMs: 250,
      sleep: async () => {},
      isCancelled: () => published.length >= 2,
      onOutcome: (value) => { published.push(value); },
    });

    assert.deepEqual(outcome, { status: "interrupted", revision: 8 });
    assert.deepEqual(published, [{ status: "interrupted", revision: 8 }]);
  }
});

test("aborting a finalizing watcher clears its retry timer and prevents future reads or writes", async () => {
  const controller = new AbortController();
  const published = [];
  let resolveCalls = 0;
  const watching = watchOnboardingOutcome({
    resolve: async () => {
      resolveCalls += 1;
      return { status: "finalizing", revision: 8 };
    },
    retryDelayMs: 10_000,
    signal: controller.signal,
    onOutcome: (value) => { published.push(value); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  const outcome = await Promise.race([
    watching,
    new Promise((resolve) => setTimeout(() => resolve("watcher_did_not_cancel"), 80)),
  ]);

  assert.notEqual(outcome, "watcher_did_not_cancel");
  assert.equal(resolveCalls, 1);
  assert.deepEqual(published, [{ status: "finalizing", revision: 8 }]);
});

test("bounded polling stops on terminal failure instead of waiting for its deadline", async () => {
  let callReads = 0;
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: () => Promise.resolve({
      data: callReads++ === 0
        ? callRow({ status: "active", provider_termination_state: "pending" })
        : callRow({ status: "killed_deadline", provider_termination_state: "confirmed", provider_termination_reason: "sideband_killed_deadline" }),
      error: null,
    }),
  });

  const outcome = await resolveOnboardingOutcome({
    client, reason: "remote_hangup", callId: CALL_ID, timeoutMs: 50, pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "interrupted", revision: 8 });
  assert.equal(callReads, 2);
});

test("polling deadline is finalizing with acknowledgement and interrupted without it", async () => {
  const pendingCall = { data: callRow({ status: "active", provider_termination_state: "pending" }), error: null };
  const withReceipt = await resolveOnboardingOutcome({
    client: queryClient({ receipt: { data: approvalRow(), error: null }, call: pendingCall }),
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });
  const withoutReceipt = await resolveOnboardingOutcome({
    client: queryClient({ call: pendingCall }),
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.deepEqual(withReceipt, { status: "finalizing", revision: 8 });
  assert.deepEqual(withoutReceipt, { status: "interrupted" });
});

test("polling cancellation stops retries and cannot claim a stale completion", async () => {
  let callReads = 0;
  let cancelled = false;
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: () => {
      callReads += 1;
      cancelled = true;
      return Promise.resolve({
        data: callRow({ status: "active", provider_termination_state: "pending" }),
        error: null,
      });
    },
  });

  const outcome = await resolveOnboardingOutcome({
    client,
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 50,
    pollIntervalMs: 1,
    isCancelled: () => cancelled,
  });

  assert.deepEqual(outcome, { status: "interrupted" });
  assert.equal(callReads, 1);
});

test("manual hangup never becomes successful even when durable rows already exist", async () => {
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: { data: callRow(), error: null },
  });

  const outcome = await resolveOnboardingOutcome({ client, reason: "manual_hangup", callId: CALL_ID });

  assert.deepEqual(outcome, { status: "interrupted" });
  assert.deepEqual(client.queries, []);
});

test("a generic completed signal or WebRTC close is not durable success", async () => {
  const client = queryClient();

  const outcome = await resolveOnboardingOutcome({
    client, reason: "completed", callId: CALL_ID, timeoutMs: 5, pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "interrupted" });
});

test("mismatched acknowledgement identity fails closed", async () => {
  const client = queryClient({
    receipt: {
      data: approvalRow({
        call_id: "33333333-3333-4333-8333-333333333333",
        readback: { ...approvalRow().readback, call_id: CALL_ID },
      }),
      error: null,
    },
    call: { data: callRow(), error: null },
  });

  const outcome = await resolveOnboardingOutcome({
    client, reason: "remote_hangup", callId: CALL_ID, timeoutMs: 5, pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "interrupted" });
});

test("unavailable or timed-out acknowledgement read is interrupted", async () => {
  const unavailable = await resolveOnboardingOutcome({
    client: null,
    reason: "remote_hangup",
    callId: CALL_ID,
  });
  const timedOut = await resolveOnboardingOutcome({
    client: queryClient({ receipt: () => new Promise(() => {}) }),
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.deepEqual(unavailable, { status: "interrupted" });
  assert.deepEqual(timedOut, { status: "interrupted" });
});

test("acknowledgement plus unavailable terminal read remains finalizing", async () => {
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: () => new Promise(() => {}),
  });

  const outcome = await resolveOnboardingOutcome({
    client,
    reason: "remote_hangup",
    callId: CALL_ID,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  assert.deepEqual(outcome, { status: "finalizing", revision: 8 });
});

test("terminal error cannot be relabeled as a completed interview", async () => {
  const client = queryClient({
    receipt: { data: approvalRow(), error: null },
    call: { data: callRow({ status: "error" }), error: null },
  });

  const outcome = await resolveOnboardingOutcome({ client, reason: "remote_hangup", callId: CALL_ID });

  assert.deepEqual(outcome, { status: "interrupted", revision: 8 });
});

test("onboarding result copy distinguishes interrupted, finalizing, and durable completion", () => {
  assert.equal(onboardingOutcomeCopy(null), "Verificando conclusão…");
  assert.equal(
    onboardingOutcomeCopy({ status: "interrupted" }),
    "Entrevista interrompida. A conclusão não foi confirmada. Revise na Memória as sugestões que já foram registradas.",
  );
  assert.equal(
    onboardingOutcomeCopy({ status: "finalizing", revision: 8 }),
    "Finalizando… Cobertura confirmada por voz · revisão 8. O encerramento do provedor ainda não foi confirmado. Regras ainda aguardando aprovação na Memória.",
  );
  assert.equal(
    onboardingOutcomeCopy({ status: "complete", revision: 8 }),
    "Entrevista concluída. Cobertura confirmada por voz · revisão 8. Regras ainda aguardando aprovação na Memória.",
  );
});

test("ended copy follows the ended run type rather than the next-run selector", () => {
  assert.equal(endedVoiceSessionCopy({
    endedSessionType: "owner_browser",
    selectedSessionType: "onboarding",
    onboardingOutcome: null,
  }), "Chamada encerrada. Resumo e custo aparecem no histórico.");
  assert.equal(endedVoiceSessionCopy({
    endedSessionType: "onboarding",
    selectedSessionType: "owner_browser",
    onboardingOutcome: null,
  }), "Verificando conclusão…");
});
