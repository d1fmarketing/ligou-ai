// Browser side of a voice session: microphone + WebRTC only.
// All authority (tools, budget, deadline, transcript of record) lives in the voice-controller.
import { createWebsiteStreamPlayer, validateWebsiteStream, observeRemoteStreamMedia } from "./website-stream.js";
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

function notifyVoiceObserver(observer, value) {
  try { observer?.(value); } catch { /* Measurement cannot alter session custody. */ }
}

export function createVoiceSessionTiming({ onTiming, startedAt, attemptId, now = () => performance.now() } = {}) {
  const origin = Number.isFinite(startedAt) ? startedAt : now();
  const browserAttemptId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId ?? "")
    ? attemptId : globalThis.crypto?.randomUUID?.() ?? `local-${origin.toFixed(3)}`;
  return {
    startedAt: origin,
    attemptId: browserAttemptId,
    mark(event, details = {}) {
      const entry = { event, attemptId: browserAttemptId, elapsedMs: Math.max(0, now() - origin), ...details };
      notifyVoiceObserver(onTiming, entry);
      // A local acceptance harness may subscribe without collecting credentials,
      // SDP, business text, owner transcripts, or wall clocks from another host.
      try {
        globalThis.dispatchEvent?.(new CustomEvent("ligou:voice-timing", { detail: entry }));
      } catch { /* Optional browser-only diagnostics. */ }
      return entry;
    },
  };
}

function voiceAbortError(signal) {
  return Object.assign(new Error(signal?.reason === "connection_timeout"
    ? "A conexão demorou mais que o esperado. Tente iniciar novamente."
    : "Início da chamada cancelado."), {
    name: "AbortError", code: signal?.reason === "connection_timeout" ? "voice_connection_timeout" : "voice_start_cancelled",
  });
}

function abortableVoiceOperation(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(voiceAbortError(signal));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
  });
}

async function requestVoiceMicrophone(signal, timeoutMs) {
  let abandoned = false;
  let timer;
  let onAbort;
  try {
    if (signal?.aborted) throw voiceAbortError(signal);
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(
      new Error("Microfone indisponível neste navegador. Abra o painel em um navegador compatível."),
      { code: "microphone_unavailable" },
    );
    const request = Promise.resolve(navigator.mediaDevices.getUserMedia({ audio: true })).then((media) => {
      if (abandoned || signal?.aborted) {
        for (const track of media.getTracks()) track.stop();
        throw voiceAbortError(signal);
      }
      return media;
    });
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        onAbort = () => { abandoned = true; reject(voiceAbortError(signal)); };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer = setTimeout(() => {
          abandoned = true;
          reject(Object.assign(new Error("Permita o uso do microfone no navegador e tente novamente."), { code: "microphone_permission_timeout" }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function authenticateVoiceSession({ client, signal, timeoutMs = 10_000 }) {
  const read = await boundedRead(() => client?.auth?.getSession(), timeoutMs, signal);
  if (signal?.aborted) throw voiceAbortError(signal);
  if (!read.ok) throw Object.assign(
    new Error("Não consegui verificar sua sessão. Tente novamente."), { code: "voice_auth_timeout" },
  );
  if (read.value?.error) throw Object.assign(
    new Error("Não consegui verificar sua sessão. Tente novamente."), { code: "voice_auth_failed" },
  );
  const token = read.value?.data?.session?.access_token;
  if (!token) throw Object.assign(new Error("Sessão expirada — entre novamente."), { code: "voice_auth_required" });
  return token;
}

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
  if ([3, 4].includes(onboardingProtocolVersion)) return resolveWebsiteInterviewOutcome({
    client,reason,callId,timeoutMs,pollIntervalMs,isCancelled,signal,now,sleep,knownRevision,protocolVersion:onboardingProtocolVersion,
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

async function resolveWebsiteInterviewOutcome({client,reason,callId,timeoutMs,pollIntervalMs,isCancelled,signal,now,sleep,knownRevision,protocolVersion}) {
  if(!client?.rpc || typeof callId !== "string")return {status:"interrupted"};
  const deadline=now()+(Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:ONBOARDING_OUTCOME_WINDOW_MS);
  let revision=Number.isSafeInteger(knownRevision)?knownRevision:null;
  let approvedReceiptId=null;
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
        return {status:"complete",revision,protocolVersion};
      if(uuid(data.approvalReceiptId)){
        approvedReceiptId=data.approvalReceiptId;
        if(data.amendmentPending===true && uuid(data.amendmentRequestReceiptId))
          return {status:"amendment_pending",revision,protocolVersion,approvalReceiptId:approvedReceiptId,canResume:data.amendmentCanResume===true};
        if(t?.outcome==="unfinished" && data.budgetStatus==="settled" && data.providerTerminationState==="confirmed")
          return {status:"approved",revision,protocolVersion,approvalReceiptId:approvedReceiptId};
      }
      if(data.resumeEligible===true && data.state==="unfinished")return {status:"resumable",revision,snapshotDigest:data.digest,protocolVersion};
      if(t?.outcome==="unfinished" || (data.budgetStatus==="settled" && ["ended","error","killed_budget","killed_deadline"].includes(data.callStatus)
        && data.state!=="closing" && data.state!=="complete"))return {status:"interrupted",revision,protocolVersion};
    }
    const delay=Math.min(Math.max(1,pollIntervalMs??250),Math.max(0,deadline-now()));
    if(delay && !await pause(delay,{signal,sleep}))return {status:"interrupted"};
  }
  return {status:"finalizing",...(revision!==null?{revision}:{}),...(approvedReceiptId?{approvalReceiptId:approvedReceiptId}:{}),protocolVersion};
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
    if (outcome.status !== "finalizing" && !(outcome.status==="amendment_pending" && !outcome.canResume)) return outcome;
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
  if(outcome.status==="amendment_pending")return outcome.canResume
    ? "Pedido de correção salvo. A versão anterior continua aprovada. Continue para revisar os pontos alterados."
    : "Pedido de correção salvo. A versão anterior continua aprovada. Confirmando o encerramento antes de retomar.";
  if(outcome.status==="approved")return "Sua configuração foi aprovada e está salva. A conversa terminou antes da confirmação final de encerramento.";
  if (outcome?.status === "complete") {
    if([3,4].includes(outcome.protocolVersion))return `Entrevista concluída e salva · revisão ${outcome.revision}. Os pontos pendentes continuam sujeitos à revisão; nenhum poder foi concedido automaticamente.`;
    return `Entrevista concluída. Cobertura confirmada por voz · revisão ${outcome.revision}. Regras ainda aguardando aprovação na Memória.`;
  }
  if (outcome?.status === "finalizing") {
    if(outcome.approvalReceiptId)return "Configuração aprovada e salva. Confirmando o encerramento da conversa…";
    const revision = Number.isSafeInteger(outcome.revision) && outcome.revision > 0
      ? ` · revisão ${outcome.revision}`
      : "";
    return `Finalizando… A pausa e a possibilidade de continuar ainda estão sendo confirmadas${revision}.`;
  }
  if (outcome?.status === "resumable") {
    if([3,4].includes(outcome.protocolVersion))return "A configuração continua incompleta. Você pode retomar da pergunta salva.";
    return `Entrevista pausada com segurança · revisão ${outcome.revision}. Você pode continuar da pergunta salva.`;
  }
  return "Entrevista interrompida. A conclusão não foi confirmada. Revise na Memória as sugestões que já foram registradas.";
}

export function voiceSessionRestartLabel({
  endedSessionType,
  onboardingOutcome,
}) {
  if(endedSessionType==="onboarding" && onboardingOutcome?.status==="amendment_pending")return "Revisar correção";
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

const STREAM_OPENING_MODE = "realtime_stream_v1";
const ONBOARDING_PROTOCOL_VERSION = 4;
const DEFAULT_OPENING_TIMEOUT_MS = 15_000;
function safeOpeningError(detail) {
  return new Error(`Abertura segura indisponível — sessão encerrada (${detail}).`);
}
export function resolveOpeningTimeouts(openingTimeoutMs, openingPlaybackTimeoutMs) {
  const bounded = (value, fallback) => Number.isFinite(value) && value >= 1 && value <= 60_000 ? value : fallback;
  const controlMs = bounded(openingTimeoutMs, DEFAULT_OPENING_TIMEOUT_MS);
  return { controlMs, playbackMs: bounded(openingPlaybackTimeoutMs, openingTimeoutMs === undefined ? 45_000 : controlMs) };
}
function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
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

export async function startVoiceSession({
  accessToken,
  sessionType = "owner_browser",
  model,
  onEvent,
  onEnd,
  onCallCreated,
  onStage,
  onTiming,
  startedAt,
  attemptId,
  signal,
  permissionTimeoutMs = 60_000,
  connectionTimeoutMs = 30_000,
  stopTimeoutMs = 10_000,
  openingTimeoutMs,
  openingPlaybackTimeoutMs,
  onboardingProtocolVersion = ONBOARDING_PROTOCOL_VERSION,
  speechClient,
}) {
  const timing = createVoiceSessionTiming({ onTiming, startedAt, attemptId });
  if (!Number.isFinite(startedAt)) timing.mark("start");
  let currentStage;
  let stopRequested = false;
  const stage = (value) => {
    if (currentStage === value || ((signal?.aborted || stopRequested) && value !== "stopping")) return;
    currentStage = value;
    notifyVoiceObserver(onStage, value);
  };
  if (signal?.aborted) throw voiceAbortError(signal);
  const onboarding = sessionType === "onboarding";
  const websiteInterview = onboarding && onboardingProtocolVersion === 4;
  if (onboarding && !websiteInterview) {
    stage("failed");
    throw Object.assign(new Error(CLIENT_UPGRADE_MESSAGE_PT), { code: CLIENT_UPGRADE_REQUIRED });
  }
  stage("permission-required");
  timing.mark("microphone_requested");
  let media;
  try {
    media = await requestVoiceMicrophone(signal,
      Number.isFinite(permissionTimeoutMs) && permissionTimeoutMs > 0 ? permissionTimeoutMs : 60_000);
    timing.mark("microphone_ready");
  } catch (error) {
    timing.mark(signal?.aborted ? "start_cancelled" : "microphone_failed");
    if (!signal?.aborted) stage("failed");
    throw error;
  }
  stage("connecting");
  const {
    controlMs: boundedOpeningTimeout,
  } = resolveOpeningTimeouts(openingTimeoutMs, openingPlaybackTimeoutMs);
  let pc = null;
  let channel = null;
  let remoteAudio = null;
  let externalAbort = null;
  const setupAbort = new AbortController();
  let disconnectGrace = null;
  let connectionDeadline = null;
  let deadline = null;
  let endedOnce = false;
  let stopped = false;
  let mediaSilenced = false;
  let stopSent = false;
  let requestedStopReason = null;
  let requestedStopMessage;
  let stopTechnical = false;
  let remoteAnswerSdp = null;
  let remoteDescriptionPromise = null;
  let remoteDescriptionApplied = false;
  let stopTimer = null;
  let resolveStop;
  const stopCompleted = new Promise((resolve) => { resolveStop = resolve; });
  let callId = null;
  let openingActivated = !onboarding;
  let websitePlayer = null;
  let websiteOpeningPlayback = null;
  let releaseWebsiteOpening = null;
  let websitePhase = "idle";
  let earlyWebsiteVad = null;
  const earlyWebsiteEvents = [];
  let remoteTrackResolve;
  const remoteTrackReady = new Promise(resolve => { remoteTrackResolve = resolve; });

  const clearConnectionDeadline = () => {
    clearTimeout(connectionDeadline);
    connectionDeadline = null;
  };
  const ready = () => {
    if (stopped || stopRequested || signal?.aborted) return;
    clearConnectionDeadline();
    stage("ready");
    timing.mark("ready");
  };
  function setSpeechCustody(active) {
    if (!onboarding) return;
    for (const track of media.getTracks()) track.enabled = active && !stopRequested && !stopped;
  }

  function silenceMedia() {
    if (mediaSilenced) return;
    mediaSilenced = true;
    websitePlayer?.stop();
    setSpeechCustody(false);
    if (remoteAudio) {
      try { remoteAudio.pause(); } catch { /* noop */ }
      remoteAudio.srcObject = null;
    }
    for (const track of media.getTracks()) track.stop();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    silenceMedia();
    websitePlayer?.stop();
    setupAbort.abort("voice_session_stopped");
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
    clearConnectionDeadline();
    if (externalAbort) signal?.removeEventListener("abort", externalAbort);
    externalAbort = null;
    if (deadline) clearTimeout(deadline);
    if (disconnectGrace) clearTimeout(disconnectGrace);
    deadline = null;
    disconnectGrace = null;
    if (channel) channel.onclose = null;
    if (channel) channel.onmessage = null;
    if (channel) channel.onopen = null;
    if (pc) pc.onconnectionstatechange = null;
    if (pc) pc.ontrack = null;
    if (remoteAudio) remoteAudio.onplaying = null;
    try { pc?.close(); } catch { /* noop */ }
  }
  function finishEnd(reason, message) {
    if (endedOnce) return;
    endedOnce = true;
    reason = requestedStopReason ?? reason;
    message = requestedStopMessage ?? message;
    timing.mark("session_ended", { reason });
    stop();
    onEnd?.({ reason, callId, ...(message ? { message } : {}) });
    resolveStop();
  }
  function sendStopIfOpen() {
    if (!stopRequested || stopSent || stopped || channel?.readyState !== "open") return;
    stopSent = true;
    try {
      channel.send(JSON.stringify({ type: "conversation.item.create", item: {
        id: `lgt-${callId.replaceAll("-", "").slice(0, 28)}`, type: "message", role: "system", status: "completed",
        content: [{ type: "input_text", text: `ligou.website_stop:${callId}${stopTechnical ? ":technical_failure" : ""}` }],
      } }));
      timing.mark("stop_control_sent");
    } catch {
      timing.mark("stop_control_unavailable");
      finishEnd(requestedStopReason);
    }
  }
  function applyRemoteDescription() {
    if (!remoteDescriptionPromise) remoteDescriptionPromise = abortableVoiceOperation(
      pc.setRemoteDescription({ type: "answer", sdp: remoteAnswerSdp }), setupAbort.signal,
    ).then(() => { remoteDescriptionApplied = true; timing.mark("remote_sdp_applied"); });
    return remoteDescriptionPromise;
  }
  function end(reason = "user", message) {
    if (endedOnce) return;
    const technical = ["application_speech_error", "startup_failed"].includes(reason);
    if (websiteInterview && (MANUAL_END_REASONS.has(reason) || (technical && remoteDescriptionApplied && channel?.readyState === "open"))
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId ?? "")
      && channel?.readyState !== "closed" && !["failed", "closed"].includes(pc?.connectionState)) {
      if (stopRequested) return;
      stopRequested = true; requestedStopReason = reason; requestedStopMessage = message; stopTechnical = technical;
      silenceMedia(); clearConnectionDeadline();
      if (deadline) clearTimeout(deadline);
      deadline = null;
      stage("stopping");
      const timeout = Number.isFinite(stopTimeoutMs) && stopTimeoutMs > 0 ? Math.min(stopTimeoutMs, 10_000) : 10_000;
      stopTimer = setTimeout(() => {
        timing.mark("stop_control_deadline");
        finishEnd(reason);
      }, timeout);
      sendStopIfOpen();
      if (!remoteDescriptionApplied && remoteAnswerSdp) void applyRemoteDescription()
        .then(sendStopIfOpen).catch(() => finishEnd(reason, message));
      return;
    }
    finishEnd(reason, message);
  }

  try {
    if (signal) {
      externalAbort = () => {
        if (websiteInterview && callId) end("manual_hangup");
        else stop();
      };
      signal.addEventListener("abort", externalAbort, { once: true });
      if (signal.aborted) throw safeOpeningError("abertura cancelada");
    }
    connectionDeadline = setTimeout(() => setupAbort.abort("connection_timeout"),
      Number.isFinite(connectionTimeoutMs) && connectionTimeoutMs > 0 ? connectionTimeoutMs : 30_000);
    pc = new RTCPeerConnection();
    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.muted = onboarding;
    let remotePlaybackResolve;
    let remotePlaybackReject;
    const remotePlayback = new Promise((resolve, reject) => { remotePlaybackResolve = resolve; remotePlaybackReject = reject; });
    remotePlayback.catch(() => {});
    remoteAudio.onplaying = () => {
      if (stopped || onboarding || remoteAudio.muted || !remoteAudio.srcObject) return;
      timing.mark("speech_playing", { audioRole: "provider", evidence: "html_media_playing" });
      remotePlaybackResolve();
    };
    pc.ontrack = (event) => {
      if (stopped) return;
      remoteAudio.srcObject = event.streams[0];
      remoteTrackResolve();
      timing.mark("remote_audio_track");
      if (!onboarding) {
        Promise.resolve().then(() => { if (!stopped) return remoteAudio.play(); })
          .catch(() => remotePlaybackReject(safeOpeningError("reprodução da abertura bloqueada")));
      }
    };
    for (const track of media.getTracks()) {
      if (onboarding) track.enabled = false;
      pc.addTrack(track, media);
    }

    // data channel: local visibility only (captions); nothing authoritative happens here
    channel = pc.createDataChannel("oai-events");
    let channelOpenReported = false;
    const channelOpened = () => {
      if (channelOpenReported || stopped) return;
      channelOpenReported = true;
      timing.mark("data_channel_open");
    };
    channel.onopen = () => { channelOpened(); sendStopIfOpen(); };
    if (channel.readyState === "open") channelOpened();
    channel.onmessage = (msg) => {
      if (stopRequested || stopped) return;
      try {
        const ev = JSON.parse(msg.data);
        if (ev.type === "input_audio_buffer.speech_started") timing.mark("transport_owner_speech_started");
        if (ev.type === "input_audio_buffer.speech_stopped") timing.mark("transport_owner_speech_ended");
        if (ev.type === "conversation.item.input_audio_transcription.completed") timing.mark("transport_owner_transcript_final");
        if (websiteInterview) {
          if (websitePlayer) websitePlayer.handleEvent(ev);
          else if (ev.type === "session.updated") earlyWebsiteVad = ev;
          else if (earlyWebsiteEvents.length < 100) earlyWebsiteEvents.push(ev);
          return;
        }
        if (ev.type === "response.output_audio_transcript.done" && ev.transcript) onEvent?.({ kind: "agent", text: ev.transcript });
        if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) onEvent?.({ kind: "caller", text: ev.transcript });
      } catch { /* Invalid provider events cannot authorize session work. */ }
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

    timing.mark("offer_started");
    const offer = await abortableVoiceOperation(pc.createOffer(), setupAbort.signal);
    await abortableVoiceOperation(pc.setLocalDescription(offer), setupAbort.signal);
    timing.mark("offer_ready");
    const requestBody = { sdp: offer.sdp, session_type: sessionType, model };
    if (onboarding) {
      requestBody.opening_mode_requested = STREAM_OPENING_MODE;
      requestBody.onboarding_protocol_version = onboardingProtocolVersion;
      requestBody.speech_contract_version = 3;
    }
    timing.mark("bootstrap_started");
    const res = await abortableVoiceOperation(fetch(SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(requestBody),
      signal: setupAbort.signal,
    }), setupAbort.signal);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw voiceSessionStartError(body, res.status);
    }
    const response = await abortableVoiceOperation(res.json(), setupAbort.signal);
    const { sdp, call_id, max_minutes } = response;
    remoteAnswerSdp = sdp;
    callId = call_id;
    timing.mark("bootstrap_response", /^[0-9a-f-]{36}$/i.test(callId ?? "") ? { callId } : {});
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId??""))
      notifyVoiceObserver(onCallCreated,{callId,end,maxMinutes:max_minutes});
    // A known-call Stop may arrive before SDP/channel readiness. Negotiate only
    // the authenticated control path; never restart opening audio or microphone.
    if (stopRequested) {
      await applyRemoteDescription();
      sendStopIfOpen();
      await stopCompleted;
      throw voiceAbortError(signal);
    }
    if (websiteInterview) {
      const envelope = response.opening_payload;
      if (response.onboarding_protocol_version !== 4 || response.opening_mode_applied !== STREAM_OPENING_MODE
        || !exactKeys(envelope, ["version", "stream"]) || envelope.version !== 4
        || response.opening_text !== undefined || response.resume_context !== undefined
        || typeof response.business_name !== "string" || !response.business_name.trim()
        || response.business_name.length > 256 || !speechClient?.rpc) throw safeOpeningError("contrato da entrevista divergente");
      const authorization = validateWebsiteStream(envelope.stream, { callId, interviewId: envelope.stream?.action?.interviewId });
      if (authorization.action.kind === "ASK_NEXT_GAP"
        && !authorization.action.text.startsWith(`Oi! Aqui é o Ligou, agente de inteligência artificial da ${response.business_name}. Eu já analisei seu website. `))
        throw safeOpeningError("identidade da entrevista divergente");
      websitePlayer = createWebsiteStreamPlayer({ callId, interviewId: authorization.action.interviewId,
        signal: setupAbort.signal, controlTimeoutMs: boundedOpeningTimeout,
        readStream: async (actionId, dispatchId, abortSignal) => {
          const request = speechClient.rpc("read_website_interview_stream", { p_call: callId, p_action: actionId, p_dispatch: dispatchId });
          const result = await (typeof request.abortSignal === "function" ? request.abortSignal(abortSignal) : request);
          if (result.error) throw safeOpeningError("fala atual indisponível");
          return result.data;
        },
        prepareOutput: async () => {
          await abortableVoiceOperation(remoteTrackReady, setupAbort.signal);
          if (stopped || stopRequested || !remoteAudio.srcObject) throw safeOpeningError("áudio remoto indisponível");
          try { await remoteAudio.play(); } catch { throw safeOpeningError("reprodução da abertura bloqueada"); }
        },
        observeMedia: (onSample, onUnavailable) => observeRemoteStreamMedia(remoteAudio, onSample, onUnavailable),
        outputIsActive: () => !remoteAudio.muted && remoteAudio.volume > 0 && !remoteAudio.paused,
        setOutput: active => { remoteAudio.muted = !active || stopRequested || stopped; },
        send: event => {
          if (stopped || stopRequested || channel.readyState !== "open") throw safeOpeningError("sessão encerrada");
          channel.send(JSON.stringify(event));
        },
        setMicrophone: active => {
          setSpeechCustody(active);
          if (active && websitePhase === "idle") ready();
          else if (!active && !stopped && currentStage === "ready") stage("processing");
        },
        onPhase: phase => {
          websitePhase = phase;
          if (["loading", "waiting-response"].includes(phase)) stage(openingActivated ? "processing" : "connecting");
          else if (phase === "ack_pending") stage("verifying-playback");
          else if (phase === "processing") stage("processing");
          else if (phase === "owner-speaking") stage("ready");
        },
        onTiming: (event, details) => {
          if (event === "speech_first_nonzero_sample") {
            clearConnectionDeadline(); stage(["SPEAK_TERMINAL_ERROR","SPEAK_AMENDMENT_SIGNOFF"].includes(details.actionKind) ? "closing" : "playing");
          }
          timing.mark(event, { ...details,
            audioRole: details.actionId === authorization.action.actionId ? "opening" : "interview_turn" });
        },
        onProgress: () => { stage("retrying"); timing.mark("backend_retrying"); },
        onCaption: onEvent, onFailure: error => { stage("failed"); end("application_speech_error", voiceSessionErrorMessage(error)); },
      });
      const playbackReady = new Promise(resolve => { releaseWebsiteOpening = resolve; });
      websiteOpeningPlayback = websitePlayer.start(authorization, playbackReady);
      if (earlyWebsiteVad) websitePlayer.handleEvent(earlyWebsiteVad);
    }
    if (stopped || (signal?.aborted && !stopRequested)) throw safeOpeningError("abertura cancelada");
    await applyRemoteDescription();
    if (stopRequested) {
      websitePlayer?.stop(); sendStopIfOpen(); await stopCompleted;
      throw voiceAbortError(signal);
    }
    if (websiteInterview) {
      await waitForDataChannelOpen(channel,boundedOpeningTimeout,setupAbort.signal);
      if (stopRequested) { sendStopIfOpen(); await stopCompleted; throw voiceAbortError(signal); }
      releaseWebsiteOpening();
      for (const event of earlyWebsiteEvents.splice(0)) websitePlayer.handleEvent(event);
      await websiteOpeningPlayback;
      if(stopped || signal?.aborted)throw safeOpeningError("entrevista encerrada");
      openingActivated=true;
    } else {
      await waitForDataChannelOpen(channel, boundedOpeningTimeout, setupAbort.signal);
      await abortableVoiceOperation(remotePlayback, setupAbort.signal);
      ready();
    }
    if (!endedOnce) deadline = setTimeout(() => end("deadline"), max_minutes * 60_000);
    return { end, callId, maxMinutes: max_minutes };
  } catch (error) {
    if (stopRequested) {
      await stopCompleted;
      throw error;
    }
    timing.mark(signal?.aborted ? "start_cancelled" : "start_failed");
    if (!signal?.aborted && !endedOnce) stage("failed");
    if(!endedOnce && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId??""))
      end(signal?.aborted?"manual_hangup":"startup_failed",voiceSessionErrorMessage(error));
    if (stopRequested) { await stopCompleted; throw error; }
    stop();
    throw error;
  }
}

export function voiceSessionErrorMessage(error) {
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name)) {
    return "Permita o uso do microfone nas configurações deste site e tente novamente.";
  }
  if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name)) {
    return "Não encontrei um microfone. Conecte um dispositivo de áudio e tente novamente.";
  }
  if (["NotReadableError", "TrackStartError"].includes(error?.name)) {
    return "O microfone está em uso ou indisponível. Feche o outro aplicativo de áudio e tente novamente.";
  }
  if (error?.name === "OverconstrainedError") return "Este microfone não está disponível. Escolha outro dispositivo e tente novamente.";
  if (/reprodução da abertura bloqueada/.test(error?.message ?? "")) {
    return "O navegador bloqueou o áudio. Permita a reprodução de som neste site e tente novamente.";
  }
  if (/^(Abertura segura indisponível|Fala segura do onboarding):?/.test(error?.message ?? "")) {
    return "Houve uma falha técnica no áudio. Tente iniciar novamente.";
  }
  const message = typeof error?.message === "string" ? error.message : "Não foi possível iniciar a chamada. Tente novamente.";
  if (["interview_resume_source_not_settled", "interview_prior_not_settled"].includes(message)) {
    return "A entrevista anterior ainda está sendo encerrada. Aguarde um momento e tente novamente. Se continuar, fale com o suporte; suas respostas estão preservadas.";
  }
  return message;
}
