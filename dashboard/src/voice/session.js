// Browser side of a voice session: microphone + WebRTC only.
// All authority (tools, budget, deadline, transcript of record) lives in the voice-controller.
const CONTROLLER_URL = import.meta.env.VITE_CONTROLLER_URL || "http://127.0.0.1:8790";
// Remote mode (production): a public Supabase Edge Function bootstraps the session and the EC2 controller
// (zero inbound ports) services it via Realtime. Set VITE_SESSION_URL to the function URL to enable.
const SESSION_URL = import.meta.env.VITE_SESSION_URL || `${CONTROLLER_URL}/session`;

const MANUAL_END_REASONS = new Set(["user", "manual_hangup", "dialog_close"]);
const TERMINAL_FAILURE_STATUSES = new Set(["error", "killed_budget", "killed_deadline"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function boundedRead(read, timeoutMs, signal) {
  let timer;
  let onAbort;
  try {
    const candidates = [
      Promise.resolve().then(read).then((value) => ({ ok: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
      }),
    ];
    if (signal) candidates.push(new Promise((resolve) => {
      onAbort = () => resolve({ ok: false, cancelled: true });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }));
    return await Promise.race(candidates);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
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
}) {
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
  let revision = null;

  while (!cancellationRequested(isCancelled, signal)) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const [approvalRead, callRead] = await Promise.all([
      boundedRead(() => client
        .from("receipts")
        .select("id,call_id,kind,outcome,readback,created_at")
        .eq("call_id", callId)
        .eq("kind", "onboarding_voice_approval")
        .eq("outcome", "accepted")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(), remaining, signal),
      boundedRead(() => client
        .from("calls")
        .select("id,session_type,status,provider_termination_state,provider_termination_reason")
        .eq("id", callId)
        .eq("session_type", "onboarding")
        .maybeSingle(), remaining, signal),
    ]);
    if (cancellationRequested(isCancelled, signal)) return { status: "interrupted" };

    const approvalResult = approvalRead.ok ? approvalRead.value : null;
    const observedRevision = approvalResult && !approvalResult.error
      ? approvalRevision(approvalResult.data, callId)
      : null;
    if (observedRevision !== null) revision = observedRevision;

    const callResult = callRead.ok ? callRead.value : null;
    const call = callResult && !callResult.error && isObject(callResult.data)
      && callResult.data.id === callId && callResult.data.session_type === "onboarding"
      ? callResult.data
      : null;
    if (call && TERMINAL_FAILURE_STATUSES.has(call.status)) {
      return revision === null ? { status: "interrupted" } : { status: "interrupted", revision };
    }
    if (call?.status === "ended" && call.provider_termination_state === "confirmed") {
      if (call.provider_termination_reason !== "agent_ended_session") {
        return revision === null ? { status: "interrupted" } : { status: "interrupted", revision };
      }
      if (revision !== null) return { status: "complete", revision };
    }

    const waitFor = Math.min(boundedPoll, Math.max(0, deadline - now()));
    if (waitFor > 0 && !await pause(waitFor, { signal, sleep })) return { status: "interrupted" };
  }

  return revision === null ? { status: "interrupted" } : { status: "finalizing", revision };
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
  while (!cancellationRequested(isCancelled, signal)) {
    const outcome = await resolve({ ...resolution, signal, isCancelled, sleep });
    if (cancellationRequested(isCancelled, signal)) return { status: "interrupted" };
    onOutcome?.(outcome);
    if (outcome.status !== "finalizing") return outcome;
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
    return `Entrevista concluída. Cobertura confirmada por voz · revisão ${outcome.revision}. Regras ainda aguardando aprovação na Memória.`;
  }
  if (outcome?.status === "finalizing") {
    return `Finalizando… Cobertura confirmada por voz · revisão ${outcome.revision}. O encerramento do provedor ainda não foi confirmado. Regras ainda aguardando aprovação na Memória.`;
  }
  return "Entrevista interrompida. A conclusão não foi confirmada. Revise na Memória as sugestões que já foram registradas.";
}

export function endedVoiceSessionCopy({ endedSessionType, onboardingOutcome }) {
  return endedSessionType === "onboarding"
    ? onboardingOutcomeCopy(onboardingOutcome)
    : "Chamada encerrada. Resumo e custo aparecem no histórico.";
}

export async function startVoiceSession({ accessToken, sessionType = "owner_browser", model, onEvent, onEnd }) {
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  let pc = null;
  let channel = null;
  let disconnectGrace = null;
  let deadline = null;
  let endedOnce = false;
  let stopped = false;
  let callId = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (deadline) clearTimeout(deadline);
    if (disconnectGrace) clearTimeout(disconnectGrace);
    deadline = null;
    disconnectGrace = null;
    if (channel) channel.onclose = null;
    if (pc) pc.onconnectionstatechange = null;
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
    pc = new RTCPeerConnection();
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    pc.ontrack = (event) => { audioEl.srcObject = event.streams[0]; };
    for (const track of media.getTracks()) pc.addTrack(track, media);

    // data channel: local visibility only (captions); nothing authoritative happens here
    channel = pc.createDataChannel("oai-events");
    channel.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (ev.type === "response.output_audio_transcript.done" && ev.transcript) onEvent?.({ kind: "agent", text: ev.transcript });
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
    const res = await fetch(SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ sdp: offer.sdp, session_type: sessionType, model }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error === "budget_exceeded" ? "Orçamento diário de voz atingido — sessão bloqueada." : body.error || `Falha ao iniciar sessão (${res.status})`);
    }
    const { sdp, call_id, max_minutes } = await res.json();
    callId = call_id;
    await pc.setRemoteDescription({ type: "answer", sdp });
    if (!endedOnce) deadline = setTimeout(() => end("deadline"), max_minutes * 60_000);
    return { end, callId, maxMinutes: max_minutes };
  } catch (error) {
    stop();
    throw error;
  }
}
