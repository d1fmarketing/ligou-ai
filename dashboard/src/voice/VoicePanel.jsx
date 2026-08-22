import { useEffect, useRef, useState } from "react";
import { IconMicrophone2, IconPhoneOff } from "@tabler/icons-react";
import { Dialog } from "../components/Dialog.jsx";
import { supabase } from "../lib/supabase.js";
import { startVoiceSession } from "./session.js";
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

  useEffect(() => () => { sessionRef.current?.end?.(); }, []);

  async function begin() {
    setStatus("connecting");
    setError(null);
    setLines([]);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) throw new Error("Sessão expirada — entre novamente.");
      sessionRef.current = await startVoiceSession({
        accessToken: token,
        model,
        sessionType,
        onEvent: (ev) => setLines((prev) => [...prev.slice(-30), ev]),
        onEnd: () => setStatus("ended"),
      });
      setStatus("live");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  function hangup() {
    sessionRef.current?.end?.();
    setStatus("ended");
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
                  ? "Entrevista encerrada. Aprove as sugestões na aba Memória para o Ligou passar a usá-las."
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
