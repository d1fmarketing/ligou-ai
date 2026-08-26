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
  onboardingOutcomeCopy,
  resolveOnboardingOutcome,
  settleStartedSession,
  startVoiceSession,
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
    ...overrides,
  };
}

function queryClient({ receipt = { data: null, error: null }, call = { data: null, error: null } } = {}) {
  const queries = [];
  return {
    queries,
    from(table) {
      const query = { table, columns: null, equals: [], orders: [], limit: null };
      queries.push(query);
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(column, value) { query.equals.push([column, value]); return builder; },
        order(column, options) { query.orders.push([column, options]); return builder; },
        limit(value) { query.limit = value; return builder; },
        maybeSingle() {
          const configured = table === "receipts" ? receipt : call;
          return typeof configured === "function" ? configured() : Promise.resolve(configured);
        },
      };
      return builder;
    },
  };
}

function installVoiceBrowser() {
  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    RTCPeerConnection: Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
  };
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const channel = { onmessage: null, onclose: null };

  class Peer {
    connectionState = "new";
    ontrack = null;
    onconnectionstatechange = null;
    createDataChannel() { return channel; }
    addTrack() {}
    async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() { this.connectionState = "closed"; }
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
    value: async () => ({
      ok: true,
      json: async () => ({ sdp: "answer-sdp", call_id: CALL_ID, max_minutes: 1 }),
    }),
  });

  return {
    tracks,
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
    cancelled: true,
    ended: false,
    onAccepted() { status = "live"; },
  });

  assert.equal(accepted, false);
  assert.equal(status, "interrupted");
  assert.equal(session.endCalls, 1);
});

test("peer close without an acknowledgement is interrupted and queries only the exact call", async () => {
  const client = queryClient({ call: { data: callRow(), error: null } });

  const outcome = await resolveOnboardingOutcome({
    client,
    reason: "remote_hangup",
    callId: CALL_ID,
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

  const outcome = await resolveOnboardingOutcome({ client, reason: "remote_hangup", callId: CALL_ID });

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

  const outcome = await resolveOnboardingOutcome({ client, reason: "completed", callId: CALL_ID });

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

  const outcome = await resolveOnboardingOutcome({ client, reason: "remote_hangup", callId: CALL_ID });

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
