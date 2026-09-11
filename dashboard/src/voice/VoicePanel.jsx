import { useEffect, useRef, useState } from "react";
import { IconMicrophone2, IconPhoneOff } from "@tabler/icons-react";
import { Dialog } from "../components/Dialog.jsx";
import { supabase } from "../lib/supabase.js";
import {
  applyCurrentSessionRun,
  authenticateVoiceSession,
  createVoiceSessionTiming,
  endedVoiceSessionCopy,
  handleClientUpgradeRequired,
  isPriorInterviewNotSettled,
  markVoiceSessionAccepted,
  settleStartedSession,
  startVoiceSession,
  voiceSessionRestartLabel,
  voiceSessionErrorMessage,
  watchOnboardingOutcome,
} from "./session.js";
import { appendVoiceCaption } from "./website-live.js";
import { statusLineFor } from "./panel-copy.js";

// Live voice panel: role-play a caller or run the Portuguese onboarding interview.
// Cases and interview suggestions created mid-call surface here in realtime.
export function VoicePanel({
  onClose,
  initialSessionType = "owner_browser",
  lockedOnboarding = false,
  onboardingProtocolVersion = 6,
  onTiming,
}) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [lines, setLines] = useState([]);
  const [liveCases, setLiveCases] = useState([]);
  const [liveSuggestions, setLiveSuggestions] = useState([]);
  const [model, setModel] = useState("gpt-realtime-2.1-mini");
  const [sessionType, setSessionType] = useState(
    lockedOnboarding ? "onboarding" : initialSessionType,
  );
  const [onboardingOutcome, setOnboardingOutcome] = useState(null);
  // Consecutive "prior interview not settled" failures: only the copy changes;
  // the button is never disabled for this, and success resets the count.
  const notSettledAttemptsRef = useRef(0);
  const [endedSessionType, setEndedSessionType] = useState(null);
  const [endedCallId,setEndedCallId]=useState(null);
  const sessionRef = useRef(null);
  const endedCallRef=useRef(null),outcomeRef=useRef(null);
  const resumable=outcome=>outcome?.status==="resumable" || (outcome?.status==="amendment_pending" && outcome.canResume===true);

  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel("voice-panel-cases")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "approval_cases" }, (payload) => {
        setLiveCases((prev) => [payload.new, ...prev].slice(0, 5));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "rules" }, (payload) => {
        if (payload.new?.status !== "sugerido") return;
        setLiveSuggestions((prev) => [payload.new, ...prev].slice(0, 8));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // Encerrar durante o "Conectando…" acontece antes de sessionRef existir; o
  // cancelledRef garante que a sessão que resolver depois seja fechada na hora
  // (mic solto) em vez de ressuscitar a chamada.
  const cancelledRef = useRef(false);
  // Um hangup remoto pode disparar onEnd enquanto o setup ainda está em voo; a
  // exceção de setup que sobra não pode sobrescrever o estado "ended" com erro cru.
  const endedRef = useRef(false);
  // Cada begin ganha uma identidade monotônica. Refs booleanos continuam
  // descrevendo somente a execução atual; callbacks de uma execução anterior
  // nunca podem observar os valores que a próxima execução resetou.
  const sessionRunRef = useRef(0);
  const outcomeAbortRef = useRef(null);
  const startAbortRef = useRef(null);
  const startTimingRef = useRef(null);

  useEffect(() => {
    const timing = startTimingRef.current;
    if (timing && !timing.visible && !["idle", "ended", "failed"].includes(status)) {
      timing.visible = true;
      timing.mark("visible_response");
    }
  }, [status]);

  useEffect(() => () => {
    outcomeAbortRef.current?.abort();
    startAbortRef.current?.abort("dialog_close");
    sessionRunRef.current += 1;
    cancelledRef.current = true;
    sessionRef.current?.end?.("dialog_close");
  }, []);

  function handleEnd(event, endedSessionType, runId) {
    if (sessionRunRef.current !== runId) return;
    const end = event && typeof event === "object"
      ? event
      : { reason: "remote_hangup", callId: null };
    endedRef.current = true;
    sessionRef.current = null;
    setStatus("ended");
    setError(typeof end.message === "string" ? end.message : null);
    setEndedSessionType(endedSessionType);
    endedCallRef.current=end.callId??null;outcomeRef.current=null;setEndedCallId(end.callId??null);
    setOnboardingOutcome(null);
    outcomeAbortRef.current?.abort();
    outcomeAbortRef.current = null;
    if (endedSessionType !== "onboarding") return;
    const outcomeAbort = new AbortController();
    outcomeAbortRef.current = outcomeAbort;
    void watchOnboardingOutcome({
      client: supabase,
      reason: end.reason,
      callId: end.callId,
      onboardingProtocolVersion,
      signal: outcomeAbort.signal,
      isCancelled: () => sessionRunRef.current !== runId,
      onOutcome: (outcome) => applyCurrentSessionRun({
        runId,
        currentRunId: sessionRunRef.current,
        onCurrent: () => { if (endedRef.current) { outcomeRef.current=outcome;setOnboardingOutcome(outcome); } },
      }),
    });
  }

  async function begin() {
    // React may batch two click handlers before repainting. Claim custody in a
    // ref before the first await so one click cannot supersede another start.
    if (startAbortRef.current || sessionRef.current) return;
    if(endedRef.current && sessionType==="onboarding" && [3,4,5,6].includes(onboardingProtocolVersion) && endedCallRef.current && !resumable(outcomeRef.current))return;
    outcomeAbortRef.current?.abort();
    outcomeAbortRef.current = null;
    const startAbort = new AbortController();
    startAbortRef.current = startAbort;
    const timing = createVoiceSessionTiming({ onTiming });
    startTimingRef.current = timing;
    timing.mark("start");
    const runId = sessionRunRef.current + 1;
    sessionRunRef.current = runId;
    const startedSessionType = sessionType;
    cancelledRef.current = false;
    endedRef.current = false;
    setStatus(status === "failed" ? "retrying" : "authenticating");
    setError(null);
    setOnboardingOutcome(null);
    setEndedSessionType(null);
    endedCallRef.current=null;outcomeRef.current=null;setEndedCallId(null);
    setLines([]);
    setLiveCases([]);
    setLiveSuggestions([]);
    try {
      timing.mark("auth_started");
      const token = await authenticateVoiceSession({ client: supabase, signal: startAbort.signal });
      if (sessionRunRef.current !== runId || startAbort.signal.aborted) return;
      timing.mark("auth_completed");
      const session = await startVoiceSession({
        accessToken: token,
        model: startedSessionType === "onboarding" && onboardingProtocolVersion === 6 ? "gpt-live-1" : model,
        sessionType: startedSessionType,
        onboardingProtocolVersion,
        signal: startAbort.signal,
        startedAt: timing.startedAt,
        attemptId: timing.attemptId,
        onTiming,
        onCallCreated: (partialSession) => settleStartedSession({
          session:partialSession,runId,currentRunId:sessionRunRef.current,cancelled:cancelledRef.current,ended:endedRef.current,
          onAccepted:owned=>{sessionRef.current=owned;},
        }),
        onStage: (stage) => applyCurrentSessionRun({
          runId,
          currentRunId: sessionRunRef.current,
          onCurrent: () => { if (!endedRef.current && (!cancelledRef.current || stage === "stopping")) setStatus(stage); },
        }),
        onEvent: (ev) => applyCurrentSessionRun({
          runId,
          currentRunId: sessionRunRef.current,
          onCurrent: () => setLines((prev) => appendVoiceCaption(prev, ev)),
        }),
        onEnd: (event) => applyCurrentSessionRun({
          runId,
          currentRunId: sessionRunRef.current,
          onCurrent: () => handleEnd(event, startedSessionType, runId),
        }),
      });
      settleStartedSession({
        session,
        runId,
        currentRunId: sessionRunRef.current,
        cancelled: cancelledRef.current,
        ended: endedRef.current,
        onAccepted: (acceptedSession) => {
          markVoiceSessionAccepted();
          notSettledAttemptsRef.current = 0;
          sessionRef.current = acceptedSession;
        },
      });
    } catch (e) {
      if (sessionRunRef.current !== runId || cancelledRef.current || endedRef.current) return;
      const upgrade = handleClientUpgradeRequired(e);
      if (upgrade.reloaded) return;
      notSettledAttemptsRef.current = isPriorInterviewNotSettled(e) ? notSettledAttemptsRef.current + 1 : 0;
      setError(upgrade.handled ? upgrade.message : voiceSessionErrorMessage(e, { notSettledAttempts: notSettledAttemptsRef.current }));
      timing.mark("panel_failed");
      setStatus("failed");
    } finally {
      if (startAbortRef.current === startAbort) startAbortRef.current = null;
    }
  }

  function hangup() {
    const runId = sessionRunRef.current;
    cancelledRef.current = true;
    startTimingRef.current?.mark("stop_requested");
    const session = sessionRef.current;
    if (session?.end) {
      if (sessionType === "onboarding" && [3,4,5,6].includes(onboardingProtocolVersion)) setStatus("stopping");
      session.end("manual_hangup");
    }
    else handleEnd({ reason: "manual_hangup", callId: null }, sessionType, runId);
    startAbortRef.current?.abort("manual_hangup");
    startAbortRef.current = null;
  }

  const interviewing = sessionType === "onboarding";
  const starting = ["authenticating", "permission-required", "connecting", "retrying"].includes(status);
  const progress = {
    authenticating: ["Verificando sua sessão…", "Preparando uma conexão segura para a conversa."],
    "permission-required": ["Aguardando o microfone…", "Permita o uso do microfone no navegador. Você pode cancelar enquanto aguarda."],
    connecting: ["Conectando o áudio…", "Preparando a conversa. Você pode cancelar a qualquer momento."],
    playing: ["Ligou está falando", "Você pode interromper para responder ou corrigir."],
    closing: ["Encerrando a conversa…", "Concluindo a despedida. O painel confirma quando você pode retomar."],
    stopping: ["Encerrando a chamada…", "O microfone foi desligado. Aguardando a confirmação do encerramento."],
    "verifying-playback": ["Confirmando a fala…", "Concluindo a confirmação do áudio."],
    processing: ["Preparando a próxima resposta…", "O Ligou está processando sua resposta."],
    retrying: ["Tentando novamente…", "Houve uma falha técnica. O Ligou está tentando continuar."],
    ready: [interviewing ? "Conversa em andamento — pode falar" : statusLineFor(sessionType), "Pode falar — o Ligou está ouvindo."],
  }[status];

  return (
    <Dialog
      open
      title={interviewing ? "Entrevista de onboarding" : "Falar com o Ligou"}
      description={interviewing
        ? [3,4,5,6].includes(onboardingProtocolVersion)
          ? "O Ligou conversa com você em português para confirmar as informações da sua empresa. Ao final, você revisa e aprova a configuração."
          : "O Ligou te entrevista em português e registra cada regra como sugestão. Você aprova o lote na aba Memória."
        : "Converse por voz como se fosse um cliente. Casos abertos durante a chamada aparecem aqui ao vivo."}
      onClose={() => { hangup(); onClose(); }}
    >
      <div className="voice-live" data-voice-stage={status}>
        {status === "idle" || status === "failed" || status === "ended" ? (
          <div className="voice-live-start">
            {!lockedOnboarding ? (
              <>
                <label>
                  Tipo de conversa
                  <select value={sessionType} onChange={(e) => setSessionType(e.target.value)}>
                    <option value="owner_browser">Testar como cliente (EN/ES)</option>
                    <option value="onboarding">Entrevista de onboarding (PT)</option>
                  </select>
                </label>
                {sessionType !== "onboarding" || onboardingProtocolVersion !== 6 ? <label>
                  Modelo
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="gpt-realtime-2.1">gpt-realtime-2.1 (validação final de qualidade)</option>
                    <option value="gpt-realtime-2.1-mini">gpt-realtime-2.1-mini (padrão dos testes)</option>
                    <option value="gpt-realtime">gpt-realtime (GA)</option>
                  </select>
                </label> : null}
              </>
            ) : null}
            <button type="button" className="voice-live-button" onClick={begin}
              disabled={status==="ended" && endedSessionType==="onboarding" && [3,4,5,6].includes(onboardingProtocolVersion) && Boolean(endedCallId) && !resumable(onboardingOutcome)}>
              <IconMicrophone2 aria-hidden="true" /> {status === "ended"
                ? voiceSessionRestartLabel({ endedSessionType, onboardingOutcome })
                : status === "failed" ? "Tentar novamente"
                  : (interviewing ? "Começar entrevista" : "Iniciar chamada")}
            </button>
            {status === "ended" ? (
              <p className="voice-live-note">
                {endedVoiceSessionCopy({ endedSessionType, onboardingOutcome })}
              </p>
            ) : null}
            {error ? <p className="voice-live-error" role="alert">{error}</p> : null}
          </div>
        ) : (
          <div className="voice-live-active">
            <p className={`voice-live-status ${status === "ready" || status === "playing" ? "is-live" : "is-connecting"}`} role="status" aria-live="polite">
              <span className="voice-live-dot" aria-hidden="true" />
              {progress?.[0]}
            </p>
            <div className="voice-live-transcript" aria-live="polite">
              {lines.length === 0 || status === "retrying" ? (
                <p className="voice-live-hint">
                  {progress?.[1]}
                </p>
              ) : null}
              {lines.map((l, i) => (
                <p key={l.id ?? i} className={l.kind === "agent" ? "line-agent" : "line-caller"}>
                  <strong>{l.kind === "agent" ? "Ligou" : "Você"}:</strong> {l.text}
                </p>
              ))}
            </div>
            <button type="button" className="voice-live-hangup" onClick={hangup}>
              <IconPhoneOff aria-hidden="true" /> {starting ? "Cancelar" : "Encerrar"}
            </button>
          </div>
        )}
        {interviewing && liveSuggestions.length > 0 ? (
          <div className="voice-live-cases">
            <h3>Sugestões registradas nesta entrevista · {liveSuggestions.length}</h3>
            {liveSuggestions.map((r) => (
              <div key={r.id} className="voice-live-case">
                <span className="case-badge">{r.category}</span>
                <p>{r.text}</p>
              </div>
            ))}
          </div>
        ) : null}
        {liveCases.length > 0 ? (
          <div className="voice-live-cases">
            <h3>Casos abertos nesta conversa</h3>
            {liveCases.map((c) => (
              <div key={c.id} className="voice-live-case">
                <span className={`case-badge ${c.urgency === "urgente" ? "is-urgent" : ""}`}>{c.urgency === "urgente" ? "URGENTE" : "Pendente"}</span>
                <p>{c.request}</p>
                {c.price_quoted ? <p className="case-price">Valor citado: ${c.price_quoted}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
