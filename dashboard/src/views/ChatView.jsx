import { useMemo, useState } from "react";
import {
  IconChecks,
  IconClock,
  IconMessageCircle2,
  IconMicrophone2,
  IconNotebook,
  IconPaperclip,
  IconPhone,
  IconSend,
} from "@tabler/icons-react";
import { ApprovalCard } from "../components/ApprovalCard.jsx";

function ChatMessage({ message }) {
  const role = message.role || "agent";
  if (role === "system") {
    return (
      <div className="system-message" role="status">
        <IconChecks aria-hidden="true" />
        <span>{message.text}</span>
        <time>{message.time}</time>
      </div>
    );
  }

  const isOwner = role === "owner" || role === "user";
  return (
    <div className={`message-row message-row--${isOwner ? "owner" : "agent"}${!isOwner && !message.label ? " message-row--prompt" : ""}`}>
      {!isOwner ? (
        <img className="message-avatar" src="/assets/ligou-avatar-head.png" alt="Ligou" />
      ) : null}
      <article className="message-bubble">
        {!isOwner && message.label ? <span className="message-label">{message.label}</span> : null}
        <p>{message.text}</p>
        {!isOwner ? <time>{message.time}</time> : null}
      </article>
      {isOwner ? (
        <>
          <time className="owner-message-time">{message.time}</time>
          <span className="message-delivery" aria-label="Entregue">
            <IconChecks aria-hidden="true" />
          </span>
        </>
      ) : null}
    </div>
  );
}

function CausalStrip({ context }) {
  return (
    <div className="causal-strip" aria-label="Contexto da ligação">
      <div>
        <span className="causal-icon"><IconPhone aria-hidden="true" /></span>
        <p><small>Ligação</small><strong>{context?.language || "inglês"}</strong></p>
      </div>
      <div>
        <span className="causal-icon"><IconNotebook aria-hidden="true" /></span>
        <p><small>Regra consultada</small><strong>{context?.rule || "Encaixe no mesmo dia exige sua aprovação."}</strong></p>
      </div>
      <div>
        <span className="causal-icon causal-icon--pending"><IconClock aria-hidden="true" /></span>
        <p><small>Aguardando</small><strong>{["pending", "aguardando"].includes(context?.status) ? "sua decisão" : "decisão registrada"}</strong></p>
      </div>
    </div>
  );
}

export function ChatView({
  messages = [],
  callContext,
  pendingApproval,
  sending,
  onSend,
  onVoice,
  onApprove,
  onAdjust,
  onReject,
}) {
  const [draft, setDraft] = useState("");
  const initialMessages = useMemo(() => messages.slice(0, 3), [messages]);
  const recentMessages = useMemo(() => messages.slice(3), [messages]);

  const submit = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    await onSend(text);
  };

  return (
    <section className="chat-view" aria-labelledby="chat-title">
      <header className="page-heading chat-heading">
        <span className="prototype-badge">Protótipo <i aria-hidden="true">·</i> dados de exemplo</span>
        <h1 id="chat-title">Conversa Operacional</h1>
        <span className="heading-rule" aria-hidden="true" />
        <p>15 de agosto de 2026</p>
      </header>

      <div className="conversation" aria-live="polite" aria-relevant="additions text">
        {initialMessages[0] ? <ChatMessage message={initialMessages[0]} /> : null}

        <div className="agent-timeline">
          {initialMessages[1] ? <ChatMessage message={initialMessages[1]} /> : null}
          <CausalStrip context={callContext} />
          {initialMessages[2] ? <ChatMessage message={initialMessages[2]} /> : null}

          <div className="mobile-approval">
            <ApprovalCard
              approval={pendingApproval}
              onApprove={onApprove}
              onAdjust={onAdjust}
              onReject={onReject}
            />
            {pendingApproval ? <p className="approval-caption">Aprovação necessária para exceção de regra.</p> : null}
          </div>
        </div>

        {recentMessages.map((message, index) => (
          <ChatMessage key={message.id || `recent-${index}`} message={message} />
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        <button className="composer-attachment" type="button" aria-label="Anexar — indisponível no protótipo" disabled>
          <IconPaperclip aria-hidden="true" />
        </button>
        <label className="sr-only" htmlFor="chat-input">Fale com o Ligou em português</label>
        <input
          id="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Fale com o Ligou em português..."
          autoComplete="off"
        />
        {draft.trim() ? (
          <button className="composer-send" type="submit" disabled={sending} aria-label="Enviar mensagem">
            <IconSend aria-hidden="true" />
          </button>
        ) : (
          <button className="voice-demo-button" type="button" onClick={onVoice}>
            <IconMicrophone2 aria-hidden="true" />
            <span>Voz · demo</span>
          </button>
        )}
        {sending ? <span className="sending-status"><IconMessageCircle2 aria-hidden="true" /> Respondendo…</span> : null}
      </form>
    </section>
  );
}
