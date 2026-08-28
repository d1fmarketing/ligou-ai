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
  voiceSessionRestartLabel,
  watchOnboardingOutcome,
} = sessionModule;

const CALL_ID = "7f58ee06-6a13-4d45-a2d5-c60244dc92a3";
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const OPENING_ITEM_ID = "lgo-0123456789abcdef0123456789ab";
const OPENING_TEXT = "Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Quais serviços sua empresa oferece?";
const OPENING_AUDIO_BASE64 = "SUQzZmFrZS1tcDM=";
const OPENING_TEXT_SHA256 = "413f79d3d184ea3985fdb593f99ac331c612c157e871034df0135f06a7817e06";
const OPENING_AUDIO_SHA256 = "5adfb17f8a9c1829a1e83bd24bb4133262fd8f45027bb35a7124c5dbd3690e9a";
const RESUME_QUESTION = "Quais cidades e regiões sua empresa atende?";
const RESUME_TEXT =
  `Oi! Aqui é o Ligou, agente de inteligência artificial da D1F Marketing. Vamos continuar de onde paramos. ${RESUME_QUESTION}`;
const RESUME_TEXT_SHA256 =
  "643ca15a2dbc57364f4eca5ae9e846674df997f7837b42873c9998ed2ff5bbf3";
const RESUME_CONTEXT = {
  coverage_receipt_id: "44444444-4444-4444-8444-444444444444",
  revision: 1,
  snapshot_digest: "c".repeat(64),
  next_action: {
    type: "ask",
    field: "area.coverage",
    question_pt: RESUME_QUESTION,
  },
};

function openingResponse(overrides = {}) {
  const payload = {
    version: 1,
    item_id: OPENING_ITEM_ID,
    text: OPENING_TEXT,
    text_sha256: OPENING_TEXT_SHA256,
    audio_base64: OPENING_AUDIO_BASE64,
    audio_sha256: OPENING_AUDIO_SHA256,
    mime: "audio/mpeg",
    voice: "ash",
    tts_model: "tts-1",
    cost_usd: 0.001605,
    ...(overrides.opening_payload ?? {}),
  };
  return {
    sdp: "answer-sdp",
    call_id: CALL_ID,
    max_minutes: 1,
    model: "gpt-realtime-2.1",
    opening_mode_applied: "application_tts_v1",
    business_name: "D1F Marketing",
    opening_payload: payload,
    ...overrides,
    ...(overrides.opening_payload ? { opening_payload: payload } : {}),
  };
}

function openingResponseV2({ resumeContext = null, ...overrides } = {}) {
  const resumed = resumeContext !== null;
  const text = resumed ? RESUME_TEXT : OPENING_TEXT;
  const payload = {
    version: 2,
    item_id: resumed
      ? "lgo-b00cbaf9911210b676ace0d7dda5"
      : "lgo-a89f1f9391ab7a82b4f27f198407",
    text,
    text_sha256: resumed ? RESUME_TEXT_SHA256 : OPENING_TEXT_SHA256,
    audio_base64: OPENING_AUDIO_BASE64,
    audio_sha256: OPENING_AUDIO_SHA256,
    mime: "audio/mpeg",
    voice: "ash",
    tts_model: "tts-1-hd",
    cost_usd: resumed ? 0.00444 : 0.00321,
    resume_context: resumeContext,
    ...(overrides.opening_payload ?? {}),
  };
  return {
    sdp: "answer-sdp",
    call_id: CALL_ID,
    max_minutes: 30,
    model: "gpt-realtime-2.1",
    opening_mode_applied: "application_tts_v1",
    onboarding_protocol_version: 2,
    business_name: "D1F Marketing",
    opening_text: text,
    resume_context: resumeContext,
    opening_payload: payload,
    ...overrides,
    ...(overrides.opening_payload ? { opening_payload: payload } : {}),
  };
}

const LIVE_VAD_EVENT = {
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

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(`timed out waiting for ${label}`);
}

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

function queryClient({
  receipt = { data: null, error: null },
  call = { data: null, error: null },
  resumeStatus = { data: { status: "blocked", revision: null, snapshot_digest: null }, error: null },
} = {}) {
  const queries = [];
  return {
    queries,
    rpc(name, args) {
      const query = { table: "rpc", name, args, abortSignal: null };
      queries.push(query);
      const operation = {
        abortSignal(signal) { query.abortSignal = signal; return operation; },
        then(resolve, reject) {
          const configured = typeof resumeStatus === "function"
            ? resumeStatus(query)
            : resumeStatus;
          return Promise.resolve(configured).then(resolve, reject);
        },
      };
      return operation;
    },
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

function installVoiceBrowser({
  fetchImpl,
  remoteDescriptionError,
  response = openingResponse(),
  channelInitiallyOpen = true,
  autoPlayback = "ended",
  autoOpeningEvents = true,
  providerGreetingTranscript,
} = {}) {
  const originals = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    RTCPeerConnection: Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    createObjectURL: Object.getOwnPropertyDescriptor(globalThis.URL, "createObjectURL"),
    revokeObjectURL: Object.getOwnPropertyDescriptor(globalThis.URL, "revokeObjectURL"),
  };
  const actions = [];
  const tracks = [{
    kind: "audio",
    enabled: true,
    stopped: false,
    stopCalls: 0,
    stop() { this.stopped = true; this.stopCalls += 1; actions.push("track:stop"); },
  }];
  const listeners = new Map();
  const channel = {
    readyState: channelInitiallyOpen ? "open" : "connecting",
    onmessage: null,
    onclose: null,
    onopen: null,
    onerror: null,
    sent: [],
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
    },
    dispatch(type, event = {}) {
      this[`on${type}`]?.(event);
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    emit(event) { this.dispatch("message", { data: JSON.stringify(event) }); },
    open() { this.readyState = "open"; this.dispatch("open"); },
    close() { this.readyState = "closed"; this.dispatch("close"); },
    send(data) {
      const event = JSON.parse(data);
      this.sent.push(event);
      actions.push(`channel:send:${event.type}`);
      if (!autoOpeningEvents || event.type !== "conversation.item.create") return;
      queueMicrotask(() => {
        if (providerGreetingTranscript) this.emit({
          type: "response.output_audio_transcript.done",
          transcript: providerGreetingTranscript,
        });
        this.emit({ type: "conversation.item.added", item: event.item });
        this.emit({ type: "conversation.item.done", item: event.item });
        this.emit(LIVE_VAD_EVENT);
      });
    },
  };
  const peers = [];
  const audios = [];
  const objectUrls = [];
  const revokedObjectUrls = [];
  const requestBodies = [];

  class FakeAudio {
    constructor() {
      this.index = audios.length;
      this.autoplay = false;
      this.muted = false;
      this.srcObject = null;
      this.src = "";
      this.currentTime = 0;
      this.pauseCalls = 0;
      this.playCalls = 0;
      this.listeners = new Map();
      audios.push(this);
    }
    addEventListener(type, listener) {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }
    dispatch(type, event = {}) {
      this[`on${type}`]?.(event);
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    async play() {
      this.playCalls += 1;
      actions.push(`audio:${this.index}:play:remote-muted=${audios[0]?.muted}:mic=${tracks[0].enabled}`);
      if (autoPlayback === "reject") throw new Error("play_rejected");
      if (autoPlayback === "ended") queueMicrotask(() => this.dispatch("ended"));
      if (autoPlayback === "error") queueMicrotask(() => this.dispatch("error", new Error("audio_error")));
    }
    pause() { this.pauseCalls += 1; actions.push(`audio:${this.index}:pause`); }
  }

  class Peer {
    constructor() { peers.push(this); }
    connectionState = "new";
    closeCalls = 0;
    ontrack = null;
    onconnectionstatechange = null;
    createDataChannel() { return channel; }
    addTrack(track) { actions.push(`peer:addTrack:enabled=${track.enabled}`); }
    async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {
      actions.push("peer:setRemoteDescription");
      if (remoteDescriptionError) throw remoteDescriptionError;
    }
    close() { this.closeCalls += 1; this.connectionState = "closed"; }
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => new FakeAudio() },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (...args) => {
      const options = args[1] ?? {};
      if (options.body) requestBodies.push(JSON.parse(options.body));
      if (fetchImpl) return fetchImpl(...args);
      return { ok: true, json: async () => response };
    },
  });
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    configurable: true,
    value: (blob) => {
      const url = `blob:opening-${objectUrls.length + 1}`;
      objectUrls.push({ url, blob });
      return url;
    },
  });
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    configurable: true,
    value: (url) => { revokedObjectUrls.push(url); },
  });

  return {
    actions,
    audios,
    channel,
    objectUrls,
    tracks,
    peers,
    requestBodies,
    revokedObjectUrls,
    restore() {
      if (channel.readyState !== "closed") channel.close();
      for (const [name, descriptor] of Object.entries(originals)) {
        if (name === "createObjectURL" || name === "revokeObjectURL") continue;
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      for (const name of ["createObjectURL", "revokeObjectURL"]) {
        const descriptor = originals[name];
        if (descriptor) Object.defineProperty(globalThis.URL, name, descriptor);
        else delete globalThis.URL[name];
      }
    },
  };
}

test("Test 10 invariant: verified application MP3 is the only audible onboarding opening", async () => {
  const browser = installVoiceBrowser({
    providerGreetingTranscript: "Oi, eu sou uma assistente virtual brasileira.",
  });
  const events = [];
  try {
    const session = await startVoiceSession({
      accessToken: "owner-token",
      sessionType: "onboarding",
      onEvent: (event) => { events.push(event); },
    });

    assert.deepEqual(browser.requestBodies, [{
      sdp: "offer-sdp",
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }]);
    assert.equal(browser.actions.includes("peer:addTrack:enabled=false"), true);
    assert.equal(browser.actions.includes("audio:1:play:remote-muted=true:mic=false"), true);
    assert.equal(browser.audios[0].playCalls, 0, "provider audio is autoplay-only and must remain muted during opening");
    assert.equal(browser.audios[1].playCalls, 1, "application owns exactly one opening playback");
    assert.equal(browser.objectUrls.length, 1);
    assert.equal(browser.objectUrls[0].blob.type, "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await browser.objectUrls[0].blob.arrayBuffer())], [...Buffer.from("ID3fake-mp3")]);
    assert.deepEqual(browser.channel.sent, [{
      type: "conversation.item.create",
      item: {
        id: OPENING_ITEM_ID,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: OPENING_TEXT }],
      },
    }]);
    assert.deepEqual(events, [{ kind: "agent", text: OPENING_TEXT }]);
    assert.equal(browser.tracks[0].enabled, true);
    assert.equal(browser.audios[0].muted, false);
    assert.deepEqual(browser.revokedObjectUrls, ["blob:opening-1"]);
    session.end();
  } finally {
    browser.restore();
  }
});

test("protocol v2 fresh opening validates exact HD Ash cost and service question before voice release", async () => {
  const response = openingResponseV2();
  const browser = installVoiceBrowser({ response });
  const events = [];
  try {
    const session = await startVoiceSession({
      accessToken: "owner-token",
      sessionType: "onboarding",
      onEvent: (event) => { events.push(event); },
    });
    assert.deepEqual(browser.requestBodies, [{
      sdp: "offer-sdp",
      session_type: "onboarding",
      opening_mode_requested: "application_tts_v1",
      onboarding_protocol_version: 2,
    }]);
    assert.equal(browser.audios[1].playCalls, 1);
    assert.equal(browser.actions.includes("audio:1:play:remote-muted=true:mic=false"), true);
    assert.equal(browser.tracks[0].enabled, true);
    assert.equal(browser.audios[0].muted, false);
    assert.deepEqual(events, [{ kind: "agent", text: OPENING_TEXT }]);
    assert.equal(response.opening_payload.resume_context, null);
    session.end();
  } finally {
    browser.restore();
  }
});

test("protocol v2 resume speaks identity, continuation, and persisted question exactly once", async () => {
  const response = openingResponseV2({ resumeContext: RESUME_CONTEXT });
  const browser = installVoiceBrowser({ response });
  const events = [];
  try {
    const session = await startVoiceSession({
      accessToken: "owner-token",
      sessionType: "onboarding",
      onEvent: (event) => { events.push(event); },
    });
    assert.equal(response.opening_payload.text.split(
      "Vamos continuar de onde paramos.",
    ).length, 2);
    assert.equal(response.opening_payload.text.split(RESUME_QUESTION).length, 2);
    assert.deepEqual(browser.channel.sent[0].item.content, [{
      type: "output_text",
      text: RESUME_TEXT,
    }]);
    assert.deepEqual(events, [{ kind: "agent", text: RESUME_TEXT }]);
    assert.equal(browser.audios[1].playCalls, 1);
    assert.equal(browser.actions.includes("audio:1:play:remote-muted=true:mic=false"), true);
    assert.equal(browser.tracks[0].enabled, true);
    session.end();
  } finally {
    browser.restore();
  }
});

test("onboarding rejects every provider or missing opening mode before accepting remote speech", async () => {
  for (const opening_mode_applied of [null, "provider", "application_tts_v2", 1]) {
    const browser = installVoiceBrowser({ response: openingResponse({ opening_mode_applied }) });
    try {
      await assert.rejects(
        () => startVoiceSession({ accessToken: "owner-token", sessionType: "onboarding" }),
        /abertura|opening|modo/i,
      );
      assert.equal(browser.peers[0].closeCalls, 1);
      assert.equal(browser.tracks[0].stopCalls, 1);
      assert.equal(browser.audios[0].muted, true);
      assert.equal(browser.actions.includes("peer:setRemoteDescription"), false);
      assert.equal(browser.audios.slice(1).every((audio) => audio.playCalls === 0), true);
    } finally {
      browser.restore();
    }
  }
});

test("onboarding validates exact server-owned opening text, payload shape, hashes, and cost before playback", async () => {
  const invalidResponses = [
    openingResponse({ business_name: " D1F Marketing " }),
    openingResponse({
      onboarding_protocol_version: 2,
      resume_context: null,
      opening_text: OPENING_TEXT,
    }),
    openingResponse({ opening_payload: { text: "Oi, eu sou uma assistente virtual brasileira." } }),
    openingResponse({ opening_payload: { text_sha256: "0".repeat(64) } }),
    openingResponse({ opening_payload: { audio_sha256: "0".repeat(64) } }),
    openingResponse({ opening_payload: { mime: "audio/wav" } }),
    openingResponse({ opening_payload: { voice: "alloy" } }),
    openingResponse({ opening_payload: { tts_model: "other" } }),
    openingResponse({ opening_payload: { cost_usd: -1 } }),
    openingResponse({ opening_payload: { item_id: `lgo-${"f".repeat(29)}` } }),
    (() => {
      const candidate = openingResponse();
      candidate.opening_payload.unexpected = true;
      return candidate;
    })(),
  ];

  for (const response of invalidResponses) {
    const browser = installVoiceBrowser({ response });
    try {
      await assert.rejects(
        () => startVoiceSession({ accessToken: "owner-token", sessionType: "onboarding" }),
        /abertura|opening|payload|áudio|audio|hash|custo|empresa/i,
      );
      assert.equal(browser.audios.slice(1).every((audio) => audio.playCalls === 0), true);
      assert.equal(browser.tracks[0].stopCalls, 1);
    } finally {
      browser.restore();
    }
  }
});

test("protocol v2 mismatches fail before remote description, playback, or microphone release", async () => {
  const invalidResponses = [
    openingResponseV2({ opening_text: "wrong" }),
    openingResponseV2({ resume_context: RESUME_CONTEXT }),
    openingResponseV2({
      resumeContext: RESUME_CONTEXT,
      opening_payload: { resume_context: null },
    }),
    openingResponseV2({
      resumeContext: RESUME_CONTEXT,
      opening_payload: { text: `${RESUME_TEXT} ${RESUME_QUESTION}` },
    }),
    openingResponseV2({ opening_payload: { tts_model: "tts-1" } }),
    openingResponseV2({ opening_payload: { voice: "alloy" } }),
    openingResponseV2({ opening_payload: { cost_usd: 0.0032 } }),
    openingResponseV2({ opening_payload: { text_sha256: "0".repeat(64) } }),
  ];
  for (const response of invalidResponses) {
    const browser = installVoiceBrowser({ response });
    try {
      await assert.rejects(
        () => startVoiceSession({
          accessToken: "owner-token",
          sessionType: "onboarding",
        }),
        /abertura|opening|payload|contexto|texto|hash|custo|voz|modelo/i,
      );
      assert.equal(browser.actions.includes("peer:setRemoteDescription"), false);
      assert.equal(browser.audios.slice(1).every((audio) => audio.playCalls === 0), true);
      assert.equal(browser.tracks[0].enabled, false);
      assert.equal(browser.tracks[0].stopCalls, 1);
    } finally {
      browser.restore();
    }
  }
});

test("onboarding stays gated through mismatched and duplicate ACKs until exact item and VAD echoes", async () => {
  const browser = installVoiceBrowser({ autoOpeningEvents: false });
  const events = [];
  try {
    let settled = false;
    const starting = startVoiceSession({
      accessToken: "owner-token",
      sessionType: "onboarding",
      onEvent: (event) => { events.push(event); },
    }).then((session) => { settled = true; return session; });
    await waitUntil(() => browser.channel.sent.length === 1, "opening conversation item");

    browser.channel.emit({
      type: "conversation.item.created",
      item: { ...browser.channel.sent[0].item, id: "msg_wrong" },
    });
    browser.channel.emit(LIVE_VAD_EVENT);
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(browser.tracks[0].enabled, false);
    assert.equal(browser.audios[0].muted, true);

    browser.channel.emit({ type: "conversation.item.created", item: browser.channel.sent[0].item });
    browser.channel.emit({ type: "conversation.item.created", item: browser.channel.sent[0].item });
    browser.channel.emit({
      ...LIVE_VAD_EVENT,
      session: { audio: { input: { turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: false } } } },
    });
    await nextTurn();
    assert.equal(settled, false);
    assert.deepEqual(events, []);

    browser.channel.emit(LIVE_VAD_EVENT);
    const session = await starting;
    assert.equal(browser.channel.sent.length, 1);
    assert.equal(browser.tracks[0].enabled, true);
    assert.equal(browser.audios[0].muted, false);
    assert.deepEqual(events, [{ kind: "agent", text: OPENING_TEXT }]);
    session.end();
  } finally {
    browser.restore();
  }
});

test("GA item added is non-authoritative and exact duplicate done ACKs release only with fresh VAD", async () => {
  const browser = installVoiceBrowser({ autoOpeningEvents: false });
  const events = [];
  let settled = false;
  let session = null;
  const starting = startVoiceSession({
    accessToken: "owner-token",
    sessionType: "onboarding",
    openingTimeoutMs: 1_000,
    onEvent: (event) => { events.push(event); },
  }).then((value) => {
    settled = true;
    session = value;
    return value;
  });
  try {
    await waitUntil(() => browser.channel.sent.length === 1, "opening conversation item");
    const item = browser.channel.sent[0].item;

    browser.channel.emit({ type: "conversation.item.added", item });
    browser.channel.emit(LIVE_VAD_EVENT);
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(browser.tracks[0].enabled, false);
    assert.equal(browser.audios[0].muted, true);

    browser.channel.emit({
      type: "conversation.item.done",
      item: { ...item, id: "lgo-0000000000000000000000000000" },
    });
    browser.channel.emit({ type: "conversation.item.added", item });
    browser.channel.emit({ type: "conversation.item.done", item });
    browser.channel.emit({ type: "conversation.item.done", item });
    browser.channel.emit({
      ...LIVE_VAD_EVENT,
      session: { audio: { input: { turn_detection: {
        type: "semantic_vad",
        eagerness: "low",
        create_response: true,
        interrupt_response: false,
      } } } },
    });
    await nextTurn();
    assert.equal(settled, false);

    browser.channel.emit(LIVE_VAD_EVENT);
    await waitUntil(() => settled, "GA conversation.item.done opening ACK");
    assert.equal(browser.channel.sent.length, 1);
    assert.deepEqual(events, [{ kind: "agent", text: OPENING_TEXT }]);
  } finally {
    if (!settled && browser.channel.sent[0]?.item) {
      browser.channel.emit({ type: "conversation.item.created", item: browser.channel.sent[0].item });
      browser.channel.emit(LIVE_VAD_EVENT);
    }
    await starting.catch(() => null);
    session?.end();
    browser.restore();
  }
});

test("later sideband session updates revoke and restore browser speech custody", async () => {
  const browser = installVoiceBrowser();
  try {
    const session = await startVoiceSession({ accessToken: "owner-token", sessionType: "onboarding" });
    browser.channel.emit({
      type: "session.updated",
      session: { audio: { input: { turn_detection: { type: "semantic_vad", eagerness: "low", create_response: false, interrupt_response: false } } } },
    });
    assert.equal(browser.tracks[0].enabled, false);
    assert.equal(browser.audios[0].muted, true);

    browser.channel.emit(LIVE_VAD_EVENT);
    assert.equal(browser.tracks[0].enabled, true);
    assert.equal(browser.audios[0].muted, false);
    session.end();
  } finally {
    browser.restore();
  }
});

test("opening playback rejection and timeout fail closed with complete cleanup", async () => {
  for (const [autoPlayback, openingTimeoutMs] of [["reject", 100], ["pending", 5]]) {
    const browser = installVoiceBrowser({ autoPlayback });
    try {
      await assert.rejects(
        () => startVoiceSession({
          accessToken: "owner-token",
          sessionType: "onboarding",
          openingTimeoutMs,
        }),
        /abertura|opening|reprodu|play|tempo|timeout/i,
      );
      assert.equal(browser.tracks[0].stopCalls, 1);
      assert.equal(browser.peers[0].closeCalls, 1);
      assert.equal(browser.audios[0].muted, true);
      assert.equal(browser.audios[1].pauseCalls >= 1, true);
      assert.deepEqual(browser.revokedObjectUrls, ["blob:opening-1"]);
    } finally {
      browser.restore();
    }
  }
});

test("aborting a stale onboarding setup stops TTS, microphone, peer, and pending timers", async () => {
  const browser = installVoiceBrowser({ autoPlayback: "pending" });
  const abort = new AbortController();
  try {
    const starting = startVoiceSession({
      accessToken: "owner-token",
      sessionType: "onboarding",
      openingTimeoutMs: 10_000,
      signal: abort.signal,
    });
    await waitUntil(() => browser.audios[1]?.playCalls === 1, "application opening playback");
    abort.abort("stale_run");

    await assert.rejects(() => starting, /cancel|abort|interromp/i);
    assert.equal(browser.tracks[0].stopCalls, 1);
    assert.equal(browser.peers[0].closeCalls, 1);
    assert.equal(browser.audios[1].pauseCalls >= 1, true);
    assert.deepEqual(browser.revokedObjectUrls, ["blob:opening-1"]);
  } finally {
    browser.restore();
  }
});

test("hangup aborts the paid onboarding bootstrap before remote description or playback", async () => {
  let fetchInit = null;
  let releaseFetch = null;
  const browser = installVoiceBrowser({
    fetchImpl: async (_url, init) => await new Promise((resolve, reject) => {
      fetchInit = init;
      releaseFetch = () => reject(new Error("test_fetch_release"));
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("bootstrap aborted", "AbortError"));
      }, { once: true });
    }),
  });
  const hangup = new AbortController();
  const starting = startVoiceSession({
    accessToken: "owner-token",
    sessionType: "onboarding",
    signal: hangup.signal,
  });
  try {
    await waitUntil(() => fetchInit !== null, "browser session bootstrap fetch");
    assert.ok(fetchInit.signal instanceof AbortSignal, "bootstrap fetch must receive an AbortSignal");
    assert.notEqual(fetchInit.signal, hangup.signal, "network uses the internal setup custody signal");

    hangup.abort("manual_hangup");
    await assert.rejects(() => starting, /cancel|abort|interromp/i);

    assert.equal(fetchInit.signal.aborted, true);
    assert.equal(browser.actions.includes("peer:setRemoteDescription"), false);
    assert.equal(browser.audios.length, 1);
    assert.equal(browser.channel.sent.length, 0);
    assert.equal(browser.tracks[0].enabled, false);
    assert.equal(browser.tracks[0].stopCalls, 1);
    assert.equal(browser.peers[0].closeCalls, 1);
  } finally {
    hangup.abort("test_cleanup");
    releaseFetch?.();
    await starting.catch(() => {});
    browser.restore();
  }
});

test("owner browser sessions keep the existing request and immediate duplex media path", async () => {
  const browser = installVoiceBrowser();
  try {
    const session = await startVoiceSession({
      accessToken: "owner-token",
      sessionType: "owner_browser",
      model: "gpt-realtime-2.1",
    });
    assert.deepEqual(browser.requestBodies, [{
      sdp: "offer-sdp",
      session_type: "owner_browser",
      model: "gpt-realtime-2.1",
    }]);
    assert.equal(browser.actions.includes("peer:addTrack:enabled=true"), true);
    assert.equal(browser.audios[0].muted, false);
    assert.equal(browser.audios.length, 1);
    assert.equal(browser.channel.sent.length, 0);
    session.end();
  } finally {
    browser.restore();
  }
});

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

test("budget or deadline termination is resumable only when the owner-safe RPC says eligible", async () => {
  for (const status of ["killed_budget", "killed_deadline"]) {
    const client = queryClient({
      resumeStatus: {
        data: {
          status: "eligible",
          revision: 7,
          snapshot_digest: "b".repeat(64),
        },
        error: null,
      },
      call: {
        data: callRow({
          status,
          provider_termination_state: "confirmed",
          provider_termination_reason: `sideband_${status}`,
        }),
        error: null,
      },
    });
    const outcome = await resolveOnboardingOutcome({
      client,
      reason: "remote_hangup",
      callId: CALL_ID,
      timeoutMs: 50,
      pollIntervalMs: 1,
    });
    assert.deepEqual(outcome, {
      status: "resumable",
      revision: 7,
      snapshotDigest: "b".repeat(64),
    });
    const resumeQuery = client.queries.find((entry) =>
      entry.table === "rpc"
    );
    assert.equal(resumeQuery.name, "get_onboarding_resume_status");
    assert.deepEqual(resumeQuery.args, { p_call: CALL_ID });
  }
});

test("provider reconciliation, unsettled budget, and ambiguous status stay finalizing", async () => {
  for (const candidate of [
    {
      providerState: "pending",
      resumeStatus: {
        data: { status: "pending", revision: 7, snapshot_digest: "b".repeat(64) },
        error: null,
      },
    },
    {
      providerState: "unknown",
      resumeStatus: {
        data: { status: "pending", revision: 7, snapshot_digest: "b".repeat(64) },
        error: null,
      },
    },
    {
      providerState: "confirmed",
      resumeStatus: {
        data: { status: "pending", revision: 7, snapshot_digest: "b".repeat(64) },
        error: null,
      },
    },
    { providerState: "confirmed", resumeStatus: { data: null, error: { message: "fetch ambiguous" } } },
    { providerState: "confirmed", resumeStatus: () => new Promise(() => {}) },
  ]) {
    const client = queryClient({
      resumeStatus: candidate.resumeStatus,
      call: {
        data: callRow({
          status: "killed_budget",
          provider_termination_state: candidate.providerState,
          provider_termination_reason: "sideband_killed_budget",
        }),
        error: null,
      },
    });
    const outcome = await resolveOnboardingOutcome({
      client,
      reason: "remote_hangup",
      callId: CALL_ID,
      timeoutMs: 5,
      pollIntervalMs: 1,
      knownRevision: 7,
    });
    assert.deepEqual(outcome, { status: "finalizing", revision: 7 });
  }
});

test("Test 10 pause sequence stays finalizing until the owner-safe RPC becomes eligible", async () => {
  const clients = [
    queryClient({
      resumeStatus: {
        data: { status: "pending", revision: 33, snapshot_digest: "c".repeat(64) },
        error: null,
      },
      call: { data: callRow({
        status: "killed_budget",
        provider_termination_state: "pending",
        provider_termination_reason: "sideband_killed_budget",
      }), error: null },
    }),
    queryClient({
      resumeStatus: {
        data: { status: "pending", revision: 33, snapshot_digest: "c".repeat(64) },
        error: null,
      },
      call: { data: callRow({
        status: "killed_budget",
        provider_termination_state: "confirmed",
        provider_termination_reason: "sideband_killed_budget",
      }), error: null },
    }),
    queryClient({
      resumeStatus: {
        data: { status: "eligible", revision: 33, snapshot_digest: "c".repeat(64) },
        error: null,
      },
      call: { data: callRow({
        status: "killed_budget",
        provider_termination_state: "confirmed",
        provider_termination_reason: "sideband_killed_budget",
      }), error: null },
    }),
  ];
  const published = [];
  let probe = 0;
  const outcome = await watchOnboardingOutcome({
    client: {},
    reason: "remote_hangup",
    callId: CALL_ID,
    retryDelayMs: 250,
    sleep: async () => {},
    resolve: (scope) => resolveOnboardingOutcome({
      ...scope,
      client: clients[probe++],
      timeoutMs: 50,
      pollIntervalMs: 1,
    }),
    onOutcome: (value) => { published.push(value); },
  });

  assert.deepEqual(published, [
    { status: "finalizing", revision: 33 },
    { status: "finalizing", revision: 33 },
    { status: "resumable", revision: 33, snapshotDigest: "c".repeat(64) },
  ]);
  assert.deepEqual(outcome, published.at(-1));
  assert.equal(probe, 3);
});

test("manual, generic error, and RPC-blocked pause states remain non-resumable", async () => {
  const cases = [
    {
      reason: "manual_hangup",
      call: callRow({ status: "killed_budget" }),
    },
    {
      reason: "remote_hangup",
      call: callRow({ status: "error" }),
    },
    {
      reason: "remote_hangup",
      call: callRow({ status: "killed_budget" }),
    },
    {
      reason: "remote_hangup",
      call: callRow({ status: "killed_deadline" }),
    },
  ];
  for (const candidate of cases) {
    const client = queryClient({
      resumeStatus: {
        data: { status: "blocked", revision: null, snapshot_digest: null },
        error: null,
      },
      call: { data: candidate.call, error: null },
    });
    assert.deepEqual(await resolveOnboardingOutcome({
      client,
      reason: candidate.reason,
      callId: CALL_ID,
      timeoutMs: 5,
      pollIntervalMs: 1,
    }), { status: "interrupted" });
  }
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
    "Finalizando… A pausa e a possibilidade de continuar ainda estão sendo confirmadas · revisão 8.",
  );
  assert.equal(
    onboardingOutcomeCopy({ status: "finalizing" }),
    "Finalizando… A pausa e a possibilidade de continuar ainda estão sendo confirmadas.",
  );
  assert.equal(
    onboardingOutcomeCopy({ status: "complete", revision: 8 }),
    "Entrevista concluída. Cobertura confirmada por voz · revisão 8. Regras ainda aguardando aprovação na Memória.",
  );
  assert.equal(
    onboardingOutcomeCopy({ status: "resumable", revision: 7 }),
    "Entrevista pausada com segurança · revisão 7. Você pode continuar da pergunta salva.",
  );
  assert.equal(voiceSessionRestartLabel({
    endedSessionType: "onboarding",
    onboardingOutcome: { status: "resumable", revision: 7 },
  }), "Continuar entrevista");
  for (const [endedSessionType, onboardingOutcome] of [
    ["onboarding", { status: "interrupted" }],
    ["owner_browser", { status: "resumable", revision: 7 }],
    ["onboarding", null],
  ]) assert.equal(voiceSessionRestartLabel({
    endedSessionType,
    onboardingOutcome,
  }), "Ligar de novo");
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
