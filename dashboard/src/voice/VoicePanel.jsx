import { useEffect, useRef, useState } from "react";
import { IconMicrophone2, IconPhoneOff } from "@tabler/icons-react";
import { Dialog } from "../components/Dialog.jsx";
import { supabase } from "../lib/supabase.js";
import { startVoiceSession } from "./session.js";

// Live voice panel: talk to the agent as if you were a caller. Cases created mid-call surface here in realtime.
export function VoicePanel({ onClose }) {
  const [status, setStatus] = useState("idle"); // idle | connecting | live | ended | error
  const [error, setError] = useState(null);
  const [lines, setLines] = useState([]);
  const [liveCases, setLiveCases] = useState([]);
  const [model, setModel] = useState("gpt-realtime-2.1");
  const [sessionType, setSessionType] = useState("owner_browser");
  const sessionRef = useRef(null);

  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase
      .channel("voice-panel-cases")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "approval_cases" }, (payload) => {
        setLiveCases((prev) => [payload.new, ...prev].slice(0, 5));
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
        onEnd: (reason) => setStatus(reason === "deadline" ? "ended" : "ended"),
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

  return (
    <Dialog open title="Falar com o Ligou" description="Converse por voz como se fosse um cliente. Casos abertos durante a chamada aparecem aqui ao vivo." onClose={() => { hangup(); onClose(); }}>
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
              <IconMicrophone2 aria-hidden="true" /> {status === "ended" ? "Ligar de novo" : "Iniciar chamada"}
            </button>
            {status === "ended" ? <p className="voice-live-note">Chamada encerrada. Resumo e custo aparecem no histórico.</p> : null}
            {error ? <p className="voice-live-error">{error}</p> : null}
          </div>
        ) : (
          <div className="voice-live-active">
            <p className="voice-live-status">{status === "connecting" ? "Conectando…" : "Ao vivo — fale em inglês ou espanhol"}</p>
            <div className="voice-live-transcript" aria-live="polite">
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
