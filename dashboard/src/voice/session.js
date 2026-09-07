// Browser side of a voice session: microphone + WebRTC only.
// All authority (tools, budget, deadline, transcript of record) lives in the voice-controller.
import { createWebsiteSpeechPlayer, validateWebsiteSpeech } from "./website-speech.js";
const CONTROLLER_URL = import.meta.env.VITE_CONTROLLER_URL || "http://127.0.0.1:8790";
// Remote mode (production): a public Supabase Edge Function bootstraps the session and the EC2 controller
// (zero inbound ports) services it via Realtime. Set VITE_SESSION_URL to the function URL to enable.
const SESSION_URL = import.meta.env.VITE_SESSION_URL || `${CONTROLLER_URL}/session`;
const CLIENT_UPGRADE_REQUIRED = "client_upgrade_required";
const CLIENT_UPGRADE_RELOAD_SENTINEL = "ligou.voice.client-upgrade-reload.v1";
const CLIENT_UPGRADE_MESSAGE_PT =
  "O Ligou foi atualizado. Recarregue esta página para continuar.";

const MANUAL_END_REASONS = new Set(["user", "manual_hangup", "dialog_close"]);
const TERMINAL_FAILURE_STATUSES = new Set(["error", "killed_budget", "killed_deadline"]);
const RECONCILABLE_PROVIDER_STATES = new Set(["active", "pending", "unknown"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function browserSessionStorage(provided) {
  if (provided !== undefined) return provided;
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

export function handleClientUpgradeRequired(error, options = {}) {
  if (error?.code !== CLIENT_UPGRADE_REQUIRED) return {
    handled: false,
    reloaded: false,
    message: null,
  };
  const storage = browserSessionStorage(options.storage);
  if (!storage) return {
    handled: true,
    reloaded: false,
    message: CLIENT_UPGRADE_MESSAGE_PT,
  };
  try {
    if (storage.getItem(CLIENT_UPGRADE_RELOAD_SENTINEL) === "1") return {
      handled: true,
      reloaded: false,
      message: CLIENT_UPGRADE_MESSAGE_PT,
    };
    storage.setItem(CLIENT_UPGRADE_RELOAD_SENTINEL, "1");
  } catch {
    return {
      handled: true,
      reloaded: false,
      message: CLIENT_UPGRADE_MESSAGE_PT,
    };
  }
  const reload = options.reload ?? (() => globalThis.location?.reload?.());
  try {
    reload();
    return { handled: true, reloaded: true, message: null };
  } catch {
    return {
      handled: true,
      reloaded: false,
      message: CLIENT_UPGRADE_MESSAGE_PT,
    };
  }
}

export function markVoiceSessionAccepted(options = {}) {
  const storage = browserSessionStorage(options.storage);
  if (!storage) return false;
  try {
    storage.removeItem(CLIENT_UPGRADE_RELOAD_SENTINEL);
    return true;
  } catch {
    return false;
  }
}

function voiceSessionStartError(body, status) {
  const code = typeof body?.error === "string" && body.error
    ? body.error
    : `voice_session_start_${status}`;
  const message = code === "budget_exceeded"
    ? "Orçamento diário de voz atingido — sessão bloqueada."
    : code === CLIENT_UPGRADE_REQUIRED
      ? CLIENT_UPGRADE_MESSAGE_PT
      : typeof body?.error === "string" && body.error
        ? body.error
        : `Falha ao iniciar sessão (${status})`;
  return Object.assign(new Error(message), { code, status });
}

async function boundedRead(read, timeoutMs, signal) {
  const readAbort = new AbortController();
  let timer;
  let onExternalAbort;
  try {
    const readPromise = Promise.resolve()
      .then(() => read(readAbort.signal))
      .then((value) => ({ ok: true, value }))
      .catch(() => ({ ok: false }));
    const candidates = [
      readPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          readAbort.abort("read_deadline");
          resolve({ ok: false });
        }, timeoutMs);
      }),
    ];
    if (signal) candidates.push(new Promise((resolve) => {
      onExternalAbort = () => {
        readAbort.abort(signal.reason);
        resolve({ ok: false, cancelled: true });
      };
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }));
    return await Promise.race(candidates);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onExternalAbort) signal.removeEventListener("abort", onExternalAbort);
  }
}

function approvalRevision(row, callId) {
  if (!isObject(row)
    || typeof row.id !== "string"
    || row.call_id !== callId
    || row.kind !== "onboarding_voice_approval"
    || row.outcome !== "accepted"
    || !isObject(row.readback)
    || row.readback.call_id !== callId
    || typeof row.readback.snapshot_receipt_id !== "string"
    || !/^[0-9a-f]{64}$/.test(row.readback.snapshot_digest ?? "")
    || !Number.isSafeInteger(row.readback.snapshot_revision)
    || row.readback.snapshot_revision < 1) return null;
  return row.readback.snapshot_revision;
}

function onboardingResumeStatus(row) {
  if (!isObject(row)
    || Object.keys(row).length !== 3
    || !Object.hasOwn(row, "status")
    || !Object.hasOwn(row, "revision")
    || !Object.hasOwn(row, "snapshot_digest")
    || !["pending", "eligible", "blocked"].includes(row.status)) return null;
  const revision = Number.isSafeInteger(row.revision) && row.revision > 0
    ? row.revision
    : null;
  const snapshotDigest = /^[0-9a-f]{64}$/.test(row.snapshot_digest ?? "")
    ? row.snapshot_digest
    : null;
  if ((row.revision !== null && revision === null)
    || (row.snapshot_digest !== null && snapshotDigest === null)
    || (row.status === "eligible" && (revision === null || snapshotDigest === null))) return null;
  return { status: row.status, revision, snapshotDigest };
}

export function settleStartedSession({ session, runId, currentRunId, cancelled, ended, onAccepted }) {
  if (runId !== currentRunId || cancelled || ended) {
    session?.end?.(cancelled ? "manual_hangup" : "remote_hangup");
    return false;
  }
  onAccepted?.(session);
  return true;
}

export function applyCurrentSessionRun({ runId, currentRunId, onCurrent }) {
  if (runId !== currentRunId) return false;
  onCurrent?.();
  return true;
}

function cancellationRequested(isCancelled, signal) {
  if (signal?.aborted) return true;
  try { return Boolean(isCancelled?.()); } catch { return true; }
}

async function pause(milliseconds, { signal, sleep } = {}) {
  if (signal?.aborted) return false;
  if (sleep) {
    await sleep(milliseconds);
    return !signal?.aborted;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

const ONBOARDING_OUTCOME_WINDOW_MS = 8_000;
const ONBOARDING_OUTCOME_RECHECK_MS = 1_000;

export async function resolveOnboardingOutcome({
  client,
  reason,
  callId,
  timeoutMs = ONBOARDING_OUTCOME_WINDOW_MS,
  pollIntervalMs = 250,
  isCancelled,
  signal,
  now = Date.now,
  sleep,
  knownRevision,
  onboardingProtocolVersion = 2,
}) {
  if (onboardingProtocolVersion === 3) return resolveWebsiteInterviewOutcome({
    client,reason,callId,timeoutMs,pollIntervalMs,isCancelled,signal,now,sleep,knownRevision,
  });
  if (MANUAL_END_REASONS.has(reason)
    || !client
    || typeof client.from !== "function"
    || typeof callId !== "string"
    || !callId.trim()) return { status: "interrupted" };

  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : ONBOARDING_OUTCOME_WINDOW_MS;
  const boundedPoll = Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0 ? pollIntervalMs : 250;
  const deadline = now() + boundedTimeout;
  let revision = Number.isSafeInteger(knownRevision) && knownRevision > 0 ? knownRevision : null;

  while (!cancellationRequested(isCancelled, signal)) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const [approvalRead, callRead] = await Promise.all([
      boundedRead((readSignal) => client
        .from("receipts")
        .select("id,call_id,kind,outcome,readback,created_at")
        .eq("call_id", callId)
        .eq("kind", "onboarding_voice_approval")
        .eq("outcome", "accepted")
        .order("created_at", { ascending: false })
        .limit(1)
        .abortSignal(readSignal)
        .maybeSingle(), remaining, signal),
      boundedRead((readSignal) => client
        .from("calls")
        .select("id,session_type,status,provider_termination_state,provider_termination_reason")
        .eq("id", callId)
        .eq("session_type", "onboarding")
        .abortSignal(readSignal)
        .maybeSingle(), remaining, signal),
    ]);
    if (cancellationRequested(isCancelled, signal)) return { status: "interrupted" };

    const approvalResult = approvalRead.ok ? approvalRead.value : null;
    const observedRevision = approvalResult && !approvalResult.error
      ? approvalRevision(approvalResult.data, callId)
      : null;
    const freshRevision = observedRevision !== null
      && (revision === null || observedRevision >= revision)
      ? observedRevision
      : null;
    if (freshRevision !== null) revision = freshRevision;

    const callResult = callRead.ok ? callRead.value : null;
    const call = callResult && !callResult.error && isObject(callResult.data)
      && callResult.data.id === callId && callResult.data.session_type === "onboarding"
      ? callResult.data
      : null;
    if (call && ["error", "killed_budget", "killed_deadline"].includes(call.status)) {
      const finalizing = () => revision === null
        ? { status: "finalizing" }
        : { status: "finalizing", revision };
      const statusRemaining = deadline - now();
      if (statusRemaining <= 0 || typeof client.rpc !== "function") return finalizing();
      const resumeRead = await boundedRead((readSignal) => client
        .rpc("get_onboarding_resume_status", { p_call: callId })
        .abortSignal(readSignal), statusRemaining, signal);
      if (cancellationRequested(isCancelled, signal)) return { status: "interrupted" };
      const resumeResult = resumeRead.ok ? resumeRead.value : null;
      const resume = resumeResult && !resumeResult.error
        ? onboardingResumeStatus(resumeResult.data)
        : null;
      if (!resume || resume.status === "pending") {
        if (resume?.revision != null) revision = resume.revision;
        return finalizing();
      }
      if (resume.status === "eligible") return {
        status: "resumable",
        revision: resume.revision,
        snapshotDigest: resume.snapshotDigest,
      };
      return revision === null ? { status: "interrupted" } : {
        status: "interrupted",
        revision,
      };
    }
    if (call && TERMINAL_FAILURE_STATUSES.has(call.status)) {
      return revision === null ? { status: "interrupted" } : { status: "interrupted", revision };
    }
    if (call) {
      const providerState = call.provider_termination_state;
      if (providerState === "confirmed") {
        if (call.status !== "ended" || call.provider_termination_reason !== "agent_ended_session") {
          return revision === null ? { status: "interrupted" } : { status: "interrupted", revision };
        }
        if (freshRevision !== null) return { status: "complete", revision: freshRevision };
      } else if (!RECONCILABLE_PROVIDER_STATES.has(providerState)) {
        return revision === null ? { status: "interrupted" } : { status: "interrupted", revision };
      }
    }

    const waitFor = Math.min(boundedPoll, Math.max(0, deadline - now()));
    if (waitFor > 0 && !await pause(waitFor, { signal, sleep })) return { status: "interrupted" };
  }

  return revision === null ? { status: "interrupted" } : { status: "finalizing", revision };
}

async function resolveWebsiteInterviewOutcome({client,reason,callId,timeoutMs,pollIntervalMs,isCancelled,signal,now,sleep,knownRevision}) {
  if(MANUAL_END_REASONS.has(reason) || !client?.rpc || typeof callId !== "string")return {status:"interrupted"};
  const deadline=now()+(Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:ONBOARDING_OUTCOME_WINDOW_MS);
  let revision=Number.isSafeInteger(knownRevision)?knownRevision:null;
  while(!cancellationRequested(isCancelled,signal)){
    const remaining=deadline-now();if(remaining<=0)break;
    const read=await boundedRead(readSignal=>{
      const request=client.rpc("get_website_interview_status",{p_call:callId});
      return typeof request.abortSignal==="function"?request.abortSignal(readSignal):request;
    },remaining,signal);
    if(cancellationRequested(isCancelled,signal))return {status:"interrupted"};
    const data=read.ok && !read.value?.error?read.value?.data:null;
    if(data?.callId===callId && data.currentCallId===callId && Number.isSafeInteger(data.revision) && data.revision>=0){
      revision=data.revision;
      const t=data.terminal;
      const uuid=value=>typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
      if(data.state==="complete" && data.completed===true && t?.outcome==="complete"
        && t.callId===callId && t.interviewId===data.interviewId && t.callStatus==="ended"
        && uuid(t.receiptId) && uuid(data.approvalReceiptId) && t.approvalReceiptId===data.approvalReceiptId
        && t.providerConfirmed===true && t.budgetSettled===true && uuid(t.budgetReservationId))
        return {status:"complete",revision,protocolVersion:3};
      if(data.resumeEligible===true && data.state==="unfinished")return {status:"resumable",revision,snapshotDigest:data.digest,protocolVersion:3};
      if(t?.outcome==="unfinished" || (data.budgetStatus==="settled" && ["ended","error","killed_budget","killed_deadline"].includes(data.callStatus)
        && data.state!=="closing" && data.state!=="complete"))return {status:"interrupted",revision,protocolVersion:3};
    }
    const delay=Math.min(Math.max(1,pollIntervalMs??250),Math.max(0,deadline-now()));
    if(delay && !await pause(delay,{signal,sleep}))return {status:"interrupted"};
  }
  return {status:"finalizing",...(revision!==null?{revision}:{}),protocolVersion:3};
}

export async function watchOnboardingOutcome({
  resolve = resolveOnboardingOutcome,
  onOutcome,
  retryDelayMs = ONBOARDING_OUTCOME_RECHECK_MS,
  signal,
  isCancelled,
  sleep,
  ...resolution
}) {
  let knownRevision = Number.isSafeInteger(resolution.knownRevision) && resolution.knownRevision > 0
    ? resolution.knownRevision
    : null;
  while (!cancellationRequested(isCancelled, signal)) {
    const outcome = await resolve({ ...resolution, knownRevision, signal, isCancelled, sleep });
    if (cancellationRequested(isCancelled, signal)) return { status: "interrupted" };
    onOutcome?.(outcome);
    if (outcome.status !== "finalizing") return outcome;
    if (Number.isSafeInteger(outcome.revision) && outcome.revision > 0) knownRevision = outcome.revision;
    const boundedRetry = Number.isFinite(retryDelayMs) && retryDelayMs >= 250
      ? retryDelayMs
      : ONBOARDING_OUTCOME_RECHECK_MS;
    if (!await pause(boundedRetry, { signal, sleep })) return { status: "interrupted" };
  }
  return { status: "interrupted" };
}

export function onboardingOutcomeCopy(outcome) {
  if (!outcome) return "Verificando conclusão…";
  if (outcome?.status === "complete") {
    if(outcome.protocolVersion===3)return `Entrevista concluída e salva · revisão ${outcome.revision}. Os pontos pendentes continuam sujeitos à revisão; nenhum poder foi concedido automaticamente.`;
    return `Entrevista concluída. Cobertura confirmada por voz · revisão ${outcome.revision}. Regras ainda aguardando aprovação na Memória.`;
  }
  if (outcome?.status === "finalizing") {
    const revision = Number.isSafeInteger(outcome.revision) && outcome.revision > 0
      ? ` · revisão ${outcome.revision}`
      : "";
    return `Finalizando… A pausa e a possibilidade de continuar ainda estão sendo confirmadas${revision}.`;
  }
  if (outcome?.status === "resumable") {
    return `Entrevista pausada com segurança · revisão ${outcome.revision}. Você pode continuar da pergunta salva.`;
  }
  return "Entrevista interrompida. A conclusão não foi confirmada. Revise na Memória as sugestões que já foram registradas.";
}

export function voiceSessionRestartLabel({
  endedSessionType,
  onboardingOutcome,
}) {
  return endedSessionType === "onboarding"
      && onboardingOutcome?.status === "resumable"
    ? "Continuar entrevista"
    : "Ligar de novo";
}

export function endedVoiceSessionCopy({ endedSessionType, onboardingOutcome }) {
  return endedSessionType === "onboarding"
    ? onboardingOutcomeCopy(onboardingOutcome)
    : "Chamada encerrada. Resumo e custo aparecem no histórico.";
}

const APPLICATION_OPENING_MODE = "application_tts_v1";
const ONBOARDING_PROTOCOL_VERSION = 2;
const APPLICATION_OPENING_V1_KEYS = [
  "version",
  "item_id",
  "text",
  "text_sha256",
  "audio_base64",
  "audio_sha256",
  "mime",
  "voice",
  "tts_model",
  "cost_usd",
];
const APPLICATION_OPENING_V2_KEYS = [
  ...APPLICATION_OPENING_V1_KEYS,
  "resume_context",
];
const MAX_OPENING_BUSINESS_NAME_LENGTH = 256;
const MAX_OPENING_TEXT_LENGTH = 1_000;
const MAX_OPENING_BASE64_LENGTH = 2_000_000;
const DEFAULT_OPENING_TIMEOUT_MS = 15_000;
const DEFAULT_OPENING_PLAYBACK_TIMEOUT_MS = 45_000;

function safeOpeningError(detail) {
  return new Error(`Abertura segura indisponível — sessão encerrada (${detail}).`);
}

function safeOpeningTimeout(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000
    ? timeoutMs
    : DEFAULT_OPENING_TIMEOUT_MS;
}

export function resolveOpeningTimeouts(
  openingTimeoutMs,
  openingPlaybackTimeoutMs,
) {
  const controlMs = safeOpeningTimeout(
    openingTimeoutMs ?? DEFAULT_OPENING_TIMEOUT_MS,
  );
  const playbackMs = safeOpeningTimeout(
    openingPlaybackTimeoutMs ??
      (openingTimeoutMs === undefined
        ? DEFAULT_OPENING_PLAYBACK_TIMEOUT_MS
        : controlMs),
  );
  return { controlMs, playbackMs };
}

function exactKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function exactTtsCost(text, rate) {
  return Number(([...text].length * rate / 1_000_000).toFixed(8));
}

function validOpeningResumeContext(value) {
  if (!exactKeys(value, [
    "coverage_receipt_id",
    "revision",
    "snapshot_digest",
    "next_action",
  ])
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.coverage_receipt_id ?? "",
    )
    || value.revision !== 1
    || !/^[0-9a-f]{64}$/.test(value.snapshot_digest ?? "")
    || !isObject(value.next_action)) return false;
  const actionKeys = ["type", "field", "question_pt"];
  if (value.next_action.subject !== undefined) actionKeys.push("subject");
  return exactKeys(value.next_action, actionKeys)
    && value.next_action.type === "ask"
    && typeof value.next_action.field === "string"
    && Boolean(value.next_action.field.trim())
    && typeof value.next_action.question_pt === "string"
    && Boolean(value.next_action.question_pt.trim())
    && (value.next_action.subject === undefined
      || (typeof value.next_action.subject === "string"
        && Boolean(value.next_action.subject.trim())));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isObject(value)) return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJson(nested)]),
  );
  return value;
}

function decodeBoundedBase64(value) {
  if (typeof value !== "string"
    || value.length < 4
    || value.length > MAX_OPENING_BASE64_LENGTH
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw safeOpeningError("payload de áudio inválido");
  }
  try {
    const binary = atob(value);
    if (!binary.length || binary.length > Math.floor(MAX_OPENING_BASE64_LENGTH * 3 / 4)) {
      throw safeOpeningError("payload de áudio fora do limite");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch (error) {
    if (error?.message?.startsWith("Abertura segura")) throw error;
    throw safeOpeningError("payload de áudio inválido");
  }
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.subtle.digest !== "function") {
    throw safeOpeningError("verificação criptográfica indisponível");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateApplicationOpening(response) {
  if (!isObject(response) || response.opening_mode_applied !== APPLICATION_OPENING_MODE) {
    throw safeOpeningError("modo de abertura não aplicado");
  }
  const businessName = response.business_name;
  if (typeof businessName !== "string"
    || !businessName
    || businessName !== businessName.trim()
    || businessName.length > MAX_OPENING_BUSINESS_NAME_LENGTH) {
    throw safeOpeningError("nome da empresa inválido");
  }
  const payload = response.opening_payload;
  const legacyV1 = payload?.version === 1;
  const currentV2 = payload?.version === 2;
  if (!(legacyV1 || currentV2)
    || !exactKeys(
      payload,
      currentV2 ? APPLICATION_OPENING_V2_KEYS : APPLICATION_OPENING_V1_KEYS,
    )
    || typeof payload.item_id !== "string"
    || payload.item_id.length !== 32
    || !/^lgo-[0-9a-f]{28}$/.test(payload.item_id)
    || typeof payload.text !== "string"
    || !payload.text
    || payload.text.length > MAX_OPENING_TEXT_LENGTH
    || !/^[0-9a-f]{64}$/.test(payload.text_sha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(payload.audio_sha256 ?? "")
    || payload.mime !== "audio/mpeg"
    || payload.voice !== "ash"
    || payload.tts_model !== (currentV2 ? "tts-1-hd" : "tts-1")
    || typeof payload.cost_usd !== "number"
    || !Number.isFinite(payload.cost_usd)
    || payload.cost_usd !== exactTtsCost(payload.text, currentV2 ? 30 : 15)
    || (currentV2 && !(payload.resume_context === null
      || validOpeningResumeContext(payload.resume_context)))) {
    throw safeOpeningError("contrato do payload inválido");
  }
  const identity =
    `Oi! Aqui é o Ligou, agente de inteligência artificial da ${businessName}.`;
  const resumeQuestion = currentV2 && payload.resume_context !== null
    ? payload.resume_context.next_action.question_pt
    : null;
  const expectedText = resumeQuestion !== null
    ? resumeQuestion.startsWith("Eu já analisei seu website")
      ? `${identity} ${resumeQuestion}`
      : `${identity} Vamos continuar de onde paramos. ${resumeQuestion}`
    : `${identity} Quais serviços sua empresa oferece?`;
  if (payload.text !== expectedText) throw safeOpeningError("texto de abertura divergente");
  if (legacyV1 && (
    response.onboarding_protocol_version !== undefined
    || response.opening_text !== undefined
    || response.resume_context !== undefined
  )) throw safeOpeningError("identidade de protocolo divergente");
  if (currentV2 && (
    response.onboarding_protocol_version !== ONBOARDING_PROTOCOL_VERSION
    || response.opening_text !== payload.text
    || JSON.stringify(canonicalJson(response.resume_context)) !==
      JSON.stringify(canonicalJson(payload.resume_context))
  )) throw safeOpeningError("contexto de abertura divergente");
  const audioBytes = decodeBoundedBase64(payload.audio_base64);
  const [textHash, audioHash] = await Promise.all([
    sha256Hex(new TextEncoder().encode(payload.text)),
    sha256Hex(audioBytes),
  ]);
  if (textHash !== payload.text_sha256 || audioHash !== payload.audio_sha256) {
    throw safeOpeningError("hash da abertura divergente");
  }
  return { payload, audioBytes };
}

function openingItemMatches(item, payload) {
  return isObject(item)
    && item.id === payload.item_id
    && item.type === "message"
    && item.role === "assistant"
    && item.status === "completed"
    && Array.isArray(item.content)
    && item.content.length === 1
    && isObject(item.content[0])
    && item.content[0].type === "output_text"
    && item.content[0].text === payload.text;
}

function hasLiveTurnDetection(event) {
  const turnDetection = event?.session?.audio?.input?.turn_detection;
  return Array.isArray(event?.session?.output_modalities)
    && event.session.output_modalities.length === 1
    && event.session.output_modalities[0] === "text"
    && isObject(turnDetection)
    && turnDetection.type === "semantic_vad"
    && turnDetection.eagerness === "low"
    && turnDetection.create_response === true
    && turnDetection.interrupt_response === true;
}

function waitForDataChannelOpen(channel, timeoutMs, signal) {
  if (channel.readyState === "open") return Promise.resolve();
  if (channel.readyState === "closed" || signal?.aborted) {
    return Promise.reject(safeOpeningError("canal de eventos fechado"));
  }
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onClose = () => finish(safeOpeningError("canal de eventos fechado"));
    const onError = () => finish(safeOpeningError("canal de eventos indisponível"));
    const onAbort = () => finish(safeOpeningError("abertura cancelada"));
    const timer = setTimeout(() => finish(safeOpeningError("tempo do canal de eventos excedido")), timeoutMs);
    channel.addEventListener("open", onOpen, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    channel.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function playApplicationOpening(audioBytes, timeoutMs, signal, onOwnedResource) {
  const blob = new Blob([audioBytes], { type: "audio/mpeg" });
  const objectUrl = URL.createObjectURL(blob);
  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.src = objectUrl;
  onOwnedResource(audio, objectUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(safeOpeningError("reprodução da abertura falhou"));
    const onAbort = () => finish(safeOpeningError("abertura cancelada"));
    const timer = setTimeout(() => finish(safeOpeningError("tempo da reprodução excedido")), timeoutMs);
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(audio.play()).catch(() => finish(safeOpeningError("reprodução da abertura bloqueada")));
  });
}

export async function startVoiceSession({
  accessToken,
  sessionType = "owner_browser",
  model,
  onEvent,
  onEnd,
  signal,
  openingTimeoutMs,
  openingPlaybackTimeoutMs,
  onboardingProtocolVersion = ONBOARDING_PROTOCOL_VERSION,
  speechClient,
}) {
  if (signal?.aborted) throw safeOpeningError("abertura cancelada");
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const onboarding = sessionType === "onboarding";
  const websiteInterview = onboarding && onboardingProtocolVersion === 3;
  if (onboarding && ![2, 3].includes(onboardingProtocolVersion)) {
    for (const track of media.getTracks()) track.stop();
    throw safeOpeningError("protocolo desconhecido");
  }
  const {
    controlMs: boundedOpeningTimeout,
    playbackMs: boundedOpeningPlaybackTimeout,
  } = resolveOpeningTimeouts(openingTimeoutMs, openingPlaybackTimeoutMs);
  let pc = null;
  let channel = null;
  let remoteAudio = null;
  let openingAudio = null;
  let openingObjectUrl = null;
  let externalAbort = null;
  const setupAbort = new AbortController();
  let disconnectGrace = null;
  let deadline = null;
  let endedOnce = false;
  let stopped = false;
  let callId = null;
  let openingPayload = null;
  let openingItemAcked = false;
  let openingVadActive = false;
  let openingActivated = !onboarding;
  let openingGateResolve = null;
  let openingGateReject = null;
  let openingGateTimer = null;
  let websitePlayer = null;
  let earlyWebsiteVad = null;
  let earlyWebsiteNotice = null;

  function setSpeechCustody(active) {
    if (!onboarding) return;
    for (const track of media.getTracks()) track.enabled = active;
    if (remoteAudio) remoteAudio.muted = websiteInterview || !active;
  }

  function releaseOpeningObjectUrl() {
    if (!openingObjectUrl) return;
    URL.revokeObjectURL(openingObjectUrl);
    openingObjectUrl = null;
  }

  function rejectOpeningGate(error) {
    if (!openingGateReject) return;
    const reject = openingGateReject;
    openingGateResolve = null;
    openingGateReject = null;
    if (openingGateTimer) clearTimeout(openingGateTimer);
    openingGateTimer = null;
    reject(error);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    websitePlayer?.stop();
    setupAbort.abort("voice_session_stopped");
    if (externalAbort) signal?.removeEventListener("abort", externalAbort);
    externalAbort = null;
    if (deadline) clearTimeout(deadline);
    if (disconnectGrace) clearTimeout(disconnectGrace);
    if (openingGateTimer) clearTimeout(openingGateTimer);
    deadline = null;
    disconnectGrace = null;
    openingGateTimer = null;
    rejectOpeningGate(safeOpeningError("abertura cancelada"));
    if (channel) channel.onclose = null;
    if (channel) channel.onmessage = null;
    if (pc) pc.onconnectionstatechange = null;
    setSpeechCustody(false);
    if (openingAudio) {
      try { openingAudio.pause(); } catch { /* noop */ }
      openingAudio.removeAttribute?.("src");
      try { openingAudio.load?.(); } catch { /* noop */ }
    }
    releaseOpeningObjectUrl();
    for (const track of media.getTracks()) track.stop();
    try { pc?.close(); } catch { /* noop */ }
  }
  function end(reason = "user") {
    if (endedOnce) return;
    endedOnce = true;
    stop();
    onEnd?.({ reason, callId });
  }

  try {
    if (signal) {
      externalAbort = () => stop();
      signal.addEventListener("abort", externalAbort, { once: true });
      if (signal.aborted) throw safeOpeningError("abertura cancelada");
    }
    pc = new RTCPeerConnection();
    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.muted = onboarding;
    pc.ontrack = (event) => { remoteAudio.srcObject = event.streams[0]; };
    for (const track of media.getTracks()) {
      if (onboarding) track.enabled = false;
      pc.addTrack(track, media);
    }

    // data channel: local visibility only (captions); nothing authoritative happens here
    channel = pc.createDataChannel("oai-events");
    channel.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (websiteInterview) {
          if (websitePlayer) websitePlayer.handleEvent(ev);
          else if (ev.type === "session.updated") earlyWebsiteVad = ev;
          else if (["conversation.item.created", "conversation.item.done"].includes(ev.type)
            && ev.item?.role === "system" && ev.item?.content?.[0]?.text?.startsWith("ligou.website_speech:"))
            earlyWebsiteNotice = ev;
          return;
        }
        const openingAckEvent = ev.type === "conversation.item.done"
          || ev.type === "conversation.item.created";
        if (onboarding && openingAckEvent && openingPayload
          && !openingItemAcked && openingItemMatches(ev.item, openingPayload)) {
          openingItemAcked = true;
        }
        if (onboarding && ev.type === "session.updated") {
          // A VAD echo observed before the exact opening item ACK cannot
          // authorize live speech. Sideband/provider events may be reordered,
          // so require a fresh session.updated after item custody is proven.
          openingVadActive = openingActivated || openingItemAcked
            ? hasLiveTurnDetection(ev)
            : false;
          if (!openingActivated) setSpeechCustody(false);
          else setSpeechCustody(openingVadActive);
        }
        if (onboarding && openingItemAcked && openingVadActive && openingGateResolve) {
          const resolve = openingGateResolve;
          openingGateResolve = null;
          openingGateReject = null;
          if (openingGateTimer) clearTimeout(openingGateTimer);
          openingGateTimer = null;
          resolve();
        }
        if (ev.type === "response.output_audio_transcript.done" && ev.transcript
          && (!onboarding || openingActivated)) onEvent?.({ kind: "agent", text: ev.transcript });
        if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) onEvent?.({ kind: "caller", text: ev.transcript });
      } catch { /* ignore */ }
    };

    // The application can end the provider call after the onboarding close gates:
    // surface it as an ended session instead of a silent dead line with the microphone
    // still open. "disconnected" can be a transient ICE blip, so it gets
    // a short grace; "failed"/"closed" and a closed data channel are terminal.
    channel.onclose = () => end("remote_hangup");
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        end("remote_hangup");
      } else if (pc.connectionState === "disconnected") {
        if (!disconnectGrace) disconnectGrace = setTimeout(() => end("remote_hangup"), 15_000);
      } else if (pc.connectionState === "connected" && disconnectGrace) {
        clearTimeout(disconnectGrace);
        disconnectGrace = null;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const requestBody = { sdp: offer.sdp, session_type: sessionType, model };
    if (onboarding) {
      requestBody.opening_mode_requested = APPLICATION_OPENING_MODE;
      requestBody.onboarding_protocol_version = onboardingProtocolVersion;
    }
    const res = await fetch(SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody),
      signal: setupAbort.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw voiceSessionStartError(body, res.status);
    }
    const response = await res.json();
    const { sdp, call_id, max_minutes } = response;
    callId = call_id;
    let opening = null;
    if (websiteInterview) {
      const envelope = response.opening_payload;
      if (response.onboarding_protocol_version !== 3 || response.opening_mode_applied !== APPLICATION_OPENING_MODE
        || !exactKeys(envelope, ["version", "item_id", "speech"]) || envelope.version !== 3
        || envelope.item_id !== `lgs-${envelope.speech?.actionId?.slice(0, 28)}`
        || response.opening_text !== undefined || response.resume_context !== undefined
        || typeof response.business_name !== "string" || !response.business_name.trim()
        || !envelope.speech?.text?.startsWith(`Oi! Aqui é o Ligou, agente de inteligência artificial da ${response.business_name}. Eu já analisei seu website. `)
        || !speechClient?.rpc) throw safeOpeningError("contrato da entrevista divergente");
      await validateWebsiteSpeech(envelope.speech, {callId, interviewId:envelope.speech.interviewId, actionId:envelope.speech.actionId});
      websitePlayer = createWebsiteSpeechPlayer({callId,interviewId:envelope.speech.interviewId,
        signal:setupAbort.signal,controlTimeoutMs:boundedOpeningTimeout,
        readSpeech:async(actionId,abortSignal)=>{
          const request=speechClient.rpc("read_website_interview_speech",{p_call:callId,p_action:actionId});
          const result=await (typeof request.abortSignal === "function" ? request.abortSignal(abortSignal) : request);
          if(result.error || !result.data)throw safeOpeningError("fala atual indisponível");
          return result.data;
        },
        play:async(bytes,abortSignal)=>{
          try {
            await playApplicationOpening(bytes,180_000,abortSignal,(audio,url)=>{openingAudio=audio;openingObjectUrl=url;});
          } finally {
            if(openingAudio){try{openingAudio.pause();}catch{}openingAudio.removeAttribute?.("src");try{openingAudio.load?.();}catch{}openingAudio=null;}
            releaseOpeningObjectUrl();
          }
        },
        send:event=>{if(stopped)throw safeOpeningError("sessão encerrada");channel.send(JSON.stringify(event));},
        setMicrophone:setSpeechCustody,onCaption:onEvent,onFailure:()=>end("application_speech_error"),
      });
      if(earlyWebsiteVad)websitePlayer.handleEvent(earlyWebsiteVad);
      opening=envelope;
    } else if (onboarding) opening = await validateApplicationOpening(response);
    if (stopped || signal?.aborted) throw safeOpeningError("abertura cancelada");
    await pc.setRemoteDescription({ type: "answer", sdp });
    if (websiteInterview) {
      await waitForDataChannelOpen(channel,boundedOpeningTimeout,setupAbort.signal);
      const played=websitePlayer.start(opening.speech);
      if(earlyWebsiteNotice)websitePlayer.handleEvent(earlyWebsiteNotice);
      await played;
      if(stopped || signal?.aborted)throw safeOpeningError("entrevista encerrada");
      openingActivated=true;
    } else if (onboarding) {
      openingPayload = opening.payload;
      await waitForDataChannelOpen(channel, boundedOpeningTimeout, setupAbort.signal);
      await playApplicationOpening(
        opening.audioBytes,
        boundedOpeningPlaybackTimeout,
        setupAbort.signal,
        (audio, objectUrl) => {
          openingAudio = audio;
          openingObjectUrl = objectUrl;
        },
      );
      releaseOpeningObjectUrl();
      if (stopped || signal?.aborted) throw safeOpeningError("abertura cancelada");
      const openingGate = new Promise((resolve, reject) => {
        openingGateResolve = resolve;
        openingGateReject = reject;
        openingGateTimer = setTimeout(
          () => rejectOpeningGate(safeOpeningError("confirmação da abertura excedeu o tempo")),
          boundedOpeningTimeout,
        );
      });
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          id: openingPayload.item_id,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: openingPayload.text }],
        },
      }));
      await openingGate;
      if (stopped || signal?.aborted || !openingVadActive) throw safeOpeningError("custódia de voz não confirmada");
      openingActivated = true;
      setSpeechCustody(true);
      onEvent?.({ kind: "agent", text: openingPayload.text });
    }
    if (!endedOnce) deadline = setTimeout(() => end("deadline"), max_minutes * 60_000);
    return { end, callId, maxMinutes: max_minutes };
  } catch (error) {
    stop();
    throw error;
  }
}

export function voiceSessionErrorMessage(error) {
  const message = typeof error?.message === "string" ? error.message : "Não foi possível iniciar a chamada. Tente novamente.";
  if (["interview_resume_source_not_settled", "interview_prior_not_settled"].includes(message)) {
    return "A entrevista anterior ainda está sendo encerrada. Aguarde um momento e tente novamente. Se continuar, fale com o suporte; suas respostas estão preservadas.";
  }
  return message;
}
