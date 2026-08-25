// Browser side of a voice session: microphone + WebRTC only.
// All authority (tools, budget, deadline, transcript of record) lives in the voice-controller.
const CONTROLLER_URL = import.meta.env.VITE_CONTROLLER_URL || "http://127.0.0.1:8790";
// Remote mode (production): a public Supabase Edge Function bootstraps the session and the EC2 controller
// (zero inbound ports) services it via Realtime. Set VITE_SESSION_URL to the function URL to enable.
const SESSION_URL = import.meta.env.VITE_SESSION_URL || `${CONTROLLER_URL}/session`;

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

  // The provider can end the call server-side (the agent finishes an interview with
  // end_session): surface it as an ended session instead of a silent dead line with
  // the microphone still open. "disconnected" can be a transient ICE blip, so it gets
  // a short grace; "failed"/"closed" and a closed data channel are terminal.
  // These live before the handlers because a handler can fire during the setup awaits.
  let disconnectGrace = null;
  let deadline = null;
  let endedOnce = false;
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
  await pc.setRemoteDescription({ type: "answer", sdp });

  deadline = setTimeout(() => end("deadline"), max_minutes * 60_000);

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
    onEnd?.(reason);
  }

  return { end, callId: call_id, maxMinutes: max_minutes };
}
