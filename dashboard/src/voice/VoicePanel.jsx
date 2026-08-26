import { useEffect, useRef, useState } from "react";
import { IconMicrophone2, IconPhoneOff } from "@tabler/icons-react";
import { Dialog } from "../components/Dialog.jsx";
import { supabase } from "../lib/supabase.js";
import {
  onboardingOutcomeCopy,
  resolveOnboardingOutcome,
  settleStartedSession,
  startVoiceSession,
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
  // Uma leitura durável iniciada por uma sessão antiga não pode sobrescrever a
  // próxima chamada se o usuário ligar de novo antes de a consulta terminar.
  const outcomeRunRef = useRef(0);

  useEffect(() => () => {
    outcomeRunRef.current += 1;
    cancelledRef.current = true;
    sessionRef.current?.end?.("dialog_close");
  }, []);

  function handleEnd(event, endedSessionType) {
    const end = event && typeof event === "object"
      ? event
      : { reason: "remote_hangup", callId: null };
    endedRef.current = true;
    sessionRef.current = null;
    setStatus("ended");
    setOnboardingOutcome(null);
    const run = ++outcomeRunRef.current;
    if (endedSessionType !== "onboarding") return;
    void resolveOnboardingOutcome({
      client: supabase,
      reason: end.reason,
      callId: end.callId,
    }).then((outcome) => {
      if (outcomeRunRef.current !== run || !endedRef.current) return;
      setOnboardingOutcome(outcome);
    });
  }

  async function begin() {
    const startedSessionType = sessionType;
    outcomeRunRef.current += 1;
    cancelledRef.current = false;
    endedRef.current = false;
    setStatus("connecting");
    setError(null);
    setOnboardingOutcome(null);
    setLines([]);
    setLiveCases([]);
    setLiveSuggestions([]);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Sessão expirada — entre novamente.");
      const session = await startVoiceSession({
        accessToken: token,
        model,
        sessionType: startedSessionType,
        onEvent: (ev) => setLines((prev) => [...prev.slice(-30), ev]),
        onEnd: (event) => handleEnd(event, startedSessionType),
      });
      settleStartedSession({
        session,
        cancelled: cancelledRef.current,
        ended: endedRef.current,
        onAccepted: (acceptedSession) => {
          sessionRef.current = acceptedSession;
          setStatus("live");
        },
      });
    } catch (e) {
      if (cancelledRef.current || endedRef.current) return;
      setError(e.message);
      setStatus("error");
    }
  }

  function hangup() {
    cancelledRef.current = true;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session?.end) session.end("manual_hangup");
    else handleEnd({ reason: "manual_hangup", callId: null }, sessionType);
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
                {interviewing
                  ? (onboardingOutcome ? onboardingOutcomeCopy(onboardingOutcome) : null)
                  : "Chamada encerrada. Resumo e custo aparecem no histórico."}
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
