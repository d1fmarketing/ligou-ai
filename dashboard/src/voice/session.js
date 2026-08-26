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

async function boundedRead(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then((value) => ({ ok: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
      }),
    ]);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
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

export function settleStartedSession({ session, cancelled, ended, onAccepted }) {
  if (cancelled || ended) {
    session?.end?.(cancelled ? "manual_hangup" : "remote_hangup");
    return false;
  }
  onAccepted?.(session);
  return true;
}

export async function resolveOnboardingOutcome({ client, reason, callId, timeoutMs = 3_000 }) {
  if (MANUAL_END_REASONS.has(reason)
    || !client
    || typeof client.from !== "function"
    || typeof callId !== "string"
    || !callId.trim()) return { status: "interrupted" };

  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3_000;
  const [approvalRead, callRead] = await Promise.all([
    boundedRead(() => client
      .from("receipts")
      .select("id,call_id,kind,outcome,readback,created_at")
      .eq("call_id", callId)
      .eq("kind", "onboarding_voice_approval")
      .eq("outcome", "accepted")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(), boundedTimeout),
    boundedRead(() => client
      .from("calls")
      .select("id,session_type,status,provider_termination_state")
      .eq("id", callId)
      .eq("session_type", "onboarding")
      .maybeSingle(), boundedTimeout),
  ]);

  const approvalResult = approvalRead.ok ? approvalRead.value : null;
  const revision = approvalResult && !approvalResult.error
    ? approvalRevision(approvalResult.data, callId)
    : null;
  if (revision === null) return { status: "interrupted" };

  const callResult = callRead.ok ? callRead.value : null;
  const call = callResult && !callResult.error && isObject(callResult.data)
    ? callResult.data
    : null;
  if (!call || call.id !== callId || call.session_type !== "onboarding") {
    return { status: "finalizing", revision };
  }
  if (TERMINAL_FAILURE_STATUSES.has(call.status)) {
    return { status: "interrupted", revision };
  }
  if (call.status === "ended" && call.provider_termination_state === "confirmed") {
    return { status: "complete", revision };
  }
  return { status: "finalizing", revision };
}

export function onboardingOutcomeCopy(outcome) {
  if (outcome?.status === "complete") {
    return `Entrevista concluída. Cobertura confirmada por voz · revisão ${outcome.revision}. Regras ainda aguardando aprovação na Memória.`;
  }
  if (outcome?.status === "finalizing") {
    return `Finalizando… Cobertura confirmada por voz · revisão ${outcome.revision}. O encerramento do provedor ainda não foi confirmado. Regras ainda aguardando aprovação na Memória.`;
  }
  return "Entrevista interrompida. A conclusão não foi confirmada. Revise na Memória as sugestões que já foram registradas.";
}

export async function startVoiceSession({ accessToken, sessionType = "owner_browser", model, onEvent, onEnd }) {
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection();
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;

  pc.ontrack = (event) => { audioEl.srcObject = event.streams[0]; };
  for (const track of media.getTracks()) pc.addTrack(track, media);

  // data channel: local visibility only (captions); nothing authoritative happens here
  const channel = pc.createDataChannel("oai-events");
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
  // These live before the handlers because a handler can fire during the setup awaits.
  let disconnectGrace = null;
  let deadline = null;
  let endedOnce = false;
  let callId = null;
  channel.onclose = () => end("remote_hangup");
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      end("remote_hangup");
    } else if (pc.connectionState === "disconnected") {
      // 15s: transient ICE blips (wifi roaming, cell handoff) routinely exceed 5s and
      // recover; the terminal signals above never wait on this timer.
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
    stop();
    throw new Error(body.error === "budget_exceeded" ? "Orçamento diário de voz atingido — sessão bloqueada." : body.error || `Falha ao iniciar sessão (${res.status})`);
  }
  const { sdp, call_id, max_minutes } = await res.json();
  callId = call_id;
  await pc.setRemoteDescription({ type: "answer", sdp });

  if (!endedOnce) deadline = setTimeout(() => end("deadline"), max_minutes * 60_000);

  function stop() {
    for (const track of media.getTracks()) track.stop();
    try { pc.close(); } catch { /* noop */ }
  }
  function end(reason = "user") {
    if (endedOnce) return;
    endedOnce = true;
    if (deadline) clearTimeout(deadline);
    if (disconnectGrace) clearTimeout(disconnectGrace);
    stop();
    onEnd?.({ reason, callId });
  }

  return { end, callId, maxMinutes: max_minutes };
}
