import { useEffect, useRef, useState } from "react";
import { IconMicrophone2, IconPhoneOff } from "@tabler/icons-react";
import { Dialog } from "../components/Dialog.jsx";
import { supabase } from "../lib/supabase.js";
import {
  applyCurrentSessionRun,
  endedVoiceSessionCopy,
  settleStartedSession,
  startVoiceSession,
  watchOnboardingOutcome,
} from "./session.js";
import { statusLineFor } from "./panel-copy.js";

// Live voice panel: role-play a caller or run the Portuguese onboarding interview.
// Cases and interview suggestions created mid-call surface here in realtime.
export function VoicePanel({ onClose, initialSessionType = "owner_browser" }) {
  const [status, setStatus] = useState("idle"); // idle | connecting | live | ended | error
  const [error, setError] = useState(null);
  const [lines, setLines] = useState([]);
  const [liveCases, setLiveCases] = useState([]);
  const [liveSuggestions, setLiveSuggestions] = useState([]);
  const [model, setModel] = useState("gpt-realtime-2.1");
  const [sessionType, setSessionType] = useState(initialSessionType);
  const [onboardingOutcome, setOnboardingOutcome] = useState(null);
  const [endedSessionType, setEndedSessionType] = useState(null);
  const sessionRef = useRef(null);

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
    setEndedSessionType(endedSessionType);
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
      signal: outcomeAbort.signal,
      isCancelled: () => sessionRunRef.current !== runId,
      onOutcome: (outcome) => applyCurrentSessionRun({
        runId,
        currentRunId: sessionRunRef.current,
        onCurrent: () => { if (endedRef.current) setOnboardingOutcome(outcome); },
      }),
    });
  }

  async function begin() {
    outcomeAbortRef.current?.abort();
    outcomeAbortRef.current = null;
    startAbortRef.current?.abort("superseded_run");
    const startAbort = new AbortController();
    startAbortRef.current = startAbort;
    const runId = sessionRunRef.current + 1;
    sessionRunRef.current = runId;
    const startedSessionType = sessionType;
    cancelledRef.current = false;
    endedRef.current = false;
    setStatus("connecting");
    setError(null);
    setOnboardingOutcome(null);
    setEndedSessionType(null);
    setLines([]);
    setLiveCases([]);
    setLiveSuggestions([]);
    try {
      const { data } = await supabase.auth.getSession();
      if (sessionRunRef.current !== runId) return;
      const token = data?.session?.access_token;
      if (!token) throw new Error("Sessão expirada — entre novamente.");
      const session = await startVoiceSession({
        accessToken: token,
        model,
        sessionType: startedSessionType,
        signal: startAbort.signal,
        onEvent: (ev) => applyCurrentSessionRun({
          runId,
          currentRunId: sessionRunRef.current,
          onCurrent: () => setLines((prev) => [...prev.slice(-30), ev]),
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
          sessionRef.current = acceptedSession;
          setStatus("live");
        },
      });
    } catch (e) {
      if (sessionRunRef.current !== runId || cancelledRef.current || endedRef.current) return;
      setError(e.message);
      setStatus("error");
    } finally {
      if (startAbortRef.current === startAbort) startAbortRef.current = null;
    }
  }

  function hangup() {
    const runId = sessionRunRef.current;
    cancelledRef.current = true;
    startAbortRef.current?.abort("manual_hangup");
    startAbortRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session?.end) session.end("manual_hangup");
    else handleEnd({ reason: "manual_hangup", callId: null }, sessionType, runId);
  }

  const interviewing = sessionType === "onboarding";

  return (
    <Dialog
      open
      title={interviewing ? "Entrevista de onboarding" : "Falar com o Ligou"}
      description={interviewing
        ? "O Ligou te entrevista em português e registra cada regra como sugestão. Você aprova o lote na aba Memória."
        : "Converse por voz como se fosse um cliente. Casos abertos durante a chamada aparecem aqui ao vivo."}
      onClose={() => { hangup(); onClose(); }}
    >
      <div className="voice-live">
        {status === "idle" || status === "error" || status === "ended" ? (
          <div className="voice-live-start">
            <label>
              Tipo de conversa
              <select value={sessionType} onChange={(e) => setSessionType(e.target.value)}>
                <option value="owner_browser">Testar como cliente (EN/ES)</option>
                <option value="onboarding">Entrevista de onboarding (PT)</option>
              </select>
            </label>
            <label>
              Modelo
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="gpt-realtime-2.1">gpt-realtime-2.1 (padrão; cai pro mini se falhar)</option>
                <option value="gpt-realtime-2.1-mini">gpt-realtime-2.1-mini (fallback/econômico)</option>
                <option value="gpt-realtime">gpt-realtime (GA)</option>
              </select>
            </label>
            <button type="button" className="voice-live-button" onClick={begin}>
              <IconMicrophone2 aria-hidden="true" /> {status === "ended" ? "Ligar de novo" : (interviewing ? "Começar entrevista" : "Iniciar chamada")}
            </button>
            {status === "ended" ? (
              <p className="voice-live-note">
                {endedVoiceSessionCopy({ endedSessionType, onboardingOutcome })}
              </p>
            ) : null}
            {error ? <p className="voice-live-error">{error}</p> : null}
          </div>
        ) : (
          <div className="voice-live-active">
            <p className={`voice-live-status ${status === "connecting" ? "is-connecting" : "is-live"}`}>
              <span className="voice-live-dot" aria-hidden="true" />
              {status === "connecting" ? "Conectando…" : statusLineFor(sessionType)}
            </p>
            <div className="voice-live-transcript" aria-live="polite">
              {lines.length === 0 ? (
                <p className="voice-live-hint">
                  {status === "connecting" ? "Preparando o áudio…" : "Pode falar — o Ligou está ouvindo."}
                </p>
              ) : null}
              {lines.map((l, i) => (
                <p key={i} className={l.kind === "agent" ? "line-agent" : "line-caller"}>
                  <strong>{l.kind === "agent" ? "Ligou" : "Você"}:</strong> {l.text}
                </p>
              ))}
            </div>
            <button type="button" className="voice-live-hangup" onClick={hangup}>
              <IconPhoneOff aria-hidden="true" /> Encerrar
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
