import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowRight,
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

function TimelineAvatar({ className = "" }) {
  return (
    <span className={`timeline-avatar-node ${className}`.trim()} aria-hidden="true">
      <img src={`${import.meta.env.BASE_URL}assets/ligou-avatar-head.png`} alt="" />
    </span>
  );
}

function ChatMessage({ message, showAvatar = true }) {
  const role = message.role || "agent";
  if (role === "system") {
    // tabIndex -1: o Dialog devolve o foco para cá quando o gatilho (Aprovar)
    // deixou de pertencer ao caso decidido — o leitor ouve a confirmação.
    return (
      <div className="system-message" role="status" tabIndex={-1}>
        <IconChecks aria-hidden="true" />
        <span>{message.text}</span>
        <time>{message.time}</time>
      </div>
    );
  }

  const isOwner = role === "owner" || role === "user";
  return (
    <div className={`message-row message-row--${isOwner ? "owner" : "agent"}${!isOwner && !message.label ? " message-row--prompt" : ""}`}>
      {!isOwner && showAvatar ? <TimelineAvatar /> : null}
      <article className="message-bubble">
        {isOwner || !message.label ? <span className="sr-only">{isOwner ? "Rafael: " : "Ligou: "}</span> : null}
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

const APPROVAL_CARD_ANCHOR = "approval-card";

function jumpToApprovalCard(event) {
  const target = document.getElementById(APPROVAL_CARD_ANCHOR);
  if (!target) return; // sem alvo, o href="#approval-card" segue como âncora comum
  event.preventDefault();
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  target.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  target.focus?.({ preventScroll: true });
}

function CausalStrip({ context, jumpTarget = false }) {
  const pending = ["pending", "aguardando"].includes(context?.status);
  // Ícone segue o mesmo predicado do texto: laranja = aguardando, teal = registrada.
  const statusCell = (
    <>
      <span className={`causal-icon ${pending ? "causal-icon--pending" : "causal-icon--done"}`}><IconClock aria-hidden="true" /></span>
      <p><small>Aguardando</small><strong>{pending ? "sua decisão" : "decisão registrada"}</strong></p>
    </>
  );
  return (
    <div className="causal-strip" aria-label="Contexto da ligação">
      {context?.language ? (
        <div data-cell="call">
          <span className="causal-icon"><IconPhone aria-hidden="true" /></span>
          <p><small>Ligação</small><strong>{context.language}</strong></p>
        </div>
      ) : null}
      {context?.rule ? (
        <div data-cell="rule">
          <span className="causal-icon"><IconNotebook aria-hidden="true" /></span>
          <p><small>Regra consultada</small><strong>{context.rule}</strong></p>
        </div>
      ) : null}
      <div data-cell="status">
        {pending && jumpTarget ? (
          // Telefone baixo (375×667): a célula de status leva ao card num toque.
          <a className="causal-jump" href={`#${APPROVAL_CARD_ANCHOR}`} onClick={jumpToApprovalCard}>{statusCell}</a>
        ) : statusCell}
      </div>
    </div>
  );
}

function focusInspectorApproval() {
  document.querySelector(".context-inspector .approval-actions button")?.focus();
}

function OperationalTimeline({ messages, context, approval, resolution, pendingApproval, onApprove, onAdjust, onReject }) {
  // `approval` = caso narrado pelas mensagens 2-3 (só se ainda pendente);
  // `pendingApproval` = próximo caso global (badge, inspector, handoff).
  return (
    <div className="operational-timeline">
      <span className="timeline-rail" aria-hidden="true" />

      <TimelineAvatar className="timeline-avatar-node--call" />
      <div className="timeline-content timeline-content--message">
        {messages[0] ? <ChatMessage message={messages[0]} showAvatar={false} /> : null}
      </div>

      {context ? (
        <>
          <span className="timeline-context-node" aria-hidden="true" />
          <div className="timeline-content timeline-content--context">
            <CausalStrip context={context} jumpTarget={Boolean(approval)} />
          </div>
        </>
      ) : null}

      <TimelineAvatar className="timeline-avatar-node--decision" />
      <div className="timeline-content timeline-content--message timeline-content--prompt">
        {messages[1] ? <ChatMessage message={messages[1]} showAvatar={false} /> : null}
      </div>

      {/* Nó de ação segue o mesmo `!pendingApproval` do handoff: teal só quando
          nada está pendente (senão pintaria "registrado" ao lado de um card vivo). */}
      <span className={`timeline-approval-node${pendingApproval ? "" : " is-resolved"}`} aria-hidden="true" />
      <div className="timeline-content timeline-content--approval">
        {/* id no wrapper (não dentro do ApprovalCard, que também vive no inspector ≥1200). */}
        <div className="mobile-approval" id={APPROVAL_CARD_ANCHOR} tabIndex={-1}>
          {approval ? (
            <>
              <ApprovalCard
                approval={approval}
                onApprove={onApprove}
                onAdjust={onAdjust}
                onReject={onReject}
              />
              <p className="approval-caption">Aprovação necessária para exceção de regra.</p>
            </>
          ) : resolution ? (
            // O caso narrado fechou: a confirmação ocupa o lugar do card.
            <ChatMessage message={resolution} />
          ) : !pendingApproval ? (
            <ApprovalCard approval={null} />
          ) : null}
        </div>

        {pendingApproval ? (
          <button type="button" className="desktop-timeline-handoff" onClick={focusInspectorApproval}>
            <span>Exceção pronta</span>
            <strong>Decida no painel à direita</strong>
            <IconArrowRight aria-hidden="true" />
          </button>
        ) : (
          <div className="desktop-timeline-handoff is-resolved" role="status">
            <span>Decisão registrada</span>
            <strong>Nenhuma exceção pendente</strong>
            <IconChecks aria-hidden="true" />
          </div>
        )}
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
  onboardingCtaLabel = null,
  onStartOnboarding,
  prototype = false,
  onApprove,
  onAdjust,
  onReject,
}) {
  const [draft, setDraft] = useState("");
  const initialMessages = useMemo(() => messages.slice(0, 3), [messages]);
  const hasOperationalTimeline = Boolean(callContext || pendingApproval);
  // O card do timeline pertence ao caso que as mensagens 2-3 narram. Se esse
  // caso já foi decidido, o próximo pendente NÃO herda a narrativa do John:
  // ele segue no badge, na aba Aprovações e no inspector (desktop).
  const narratedApprovalId = initialMessages[2]?.relatedApprovalId || initialMessages[1]?.relatedApprovalId || null;
  const timelineApproval = pendingApproval && (!narratedApprovalId || pendingApproval.id === narratedApprovalId)
    ? pendingApproval
    : null;
  const narratedResolution = useMemo(
    () => (narratedApprovalId
      ? messages.find((message) => message.role === "system" && message.relatedApprovalId === narratedApprovalId) || null
      : null),
    [messages, narratedApprovalId],
  );
  const recentMessages = useMemo(
    () => messages
      .slice(hasOperationalTimeline ? 3 : 1)
      .filter((message) => !narratedResolution || message !== narratedResolution),
    [messages, hasOperationalTimeline, narratedResolution],
  );

  // New messages land below the fold; follow them — but only when the owner
  // is already at the tail or just sent something. Never yank someone who
  // scrolled up to reread history. First render stays at the top (approved).
  const conversationEndRef = useRef(null);
  const seenCountRef = useRef(messages.length);
  const followNextRef = useRef(false);
  const inputRef = useRef(null);
  useEffect(() => {
    if (messages.length > seenCountRef.current) {
      const doc = document.scrollingElement;
      const nearBottom = doc.scrollHeight - window.scrollY - window.innerHeight < 160;
      if (followNextRef.current || nearBottom) {
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        conversationEndRef.current?.scrollIntoView({ block: "end", behavior: reduced ? "auto" : "smooth" });
      }
      followNextRef.current = false;
    }
    seenCountRef.current = messages.length;
  }, [messages.length]);

  const submit = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    followNextRef.current = true;
    inputRef.current?.focus();
    const delivered = await onSend(text);
    // A falha honesta devolve o texto — ninguém redigita mensagem perdida.
    if (delivered === false) setDraft((current) => current || text);
  };

  const today = useMemo(
    () => new Date().toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" }),
    [],
  );

  return (
    <section className="chat-view" aria-labelledby="chat-title">
      <header className="page-heading chat-heading">
        {prototype ? <span className="prototype-badge">Protótipo <i aria-hidden="true">·</i> dados de exemplo</span> : null}
        <h1 id="chat-title">Conversa Operacional</h1>
        <span className="heading-rule" aria-hidden="true" />
        <p>{prototype ? "15 de agosto de 2026" : today}</p>
      </header>

      {onboardingCtaLabel && onStartOnboarding ? (
        <div className="onboarding-cta" role="status">
          <p>
            <strong>Seu Ligou ainda está em onboarding.</strong>{" "}
            Numa conversa curta em português, ele te entrevista e monta a primeira versão do atendimento.
          </p>
          <button className="button button--primary" type="button" onClick={onStartOnboarding}>
            <IconMicrophone2 aria-hidden="true" /> {onboardingCtaLabel}
          </button>
        </div>
      ) : null}

      <div className="conversation" aria-live="polite" aria-relevant="additions text">
        {initialMessages[0] ? <ChatMessage message={initialMessages[0]} /> : null}

        {hasOperationalTimeline ? (
          <OperationalTimeline
            messages={[initialMessages[1], initialMessages[2]]}
            context={callContext}
            approval={timelineApproval}
            resolution={narratedResolution}
            pendingApproval={pendingApproval}
            onApprove={onApprove}
            onAdjust={onAdjust}
            onReject={onReject}
          />
        ) : null}

        {recentMessages.map((message, index) => (
          <ChatMessage key={message.id || `recent-${index}`} message={message} />
        ))}
        <span ref={conversationEndRef} className="conversation-end" aria-hidden="true" />
      </div>

      <form className="composer" onSubmit={submit}>
        <button className="composer-attachment" type="button" aria-label="Anexar — indisponível no protótipo" disabled>
          <IconPaperclip aria-hidden="true" />
        </button>
        <label className="sr-only" htmlFor="chat-input">Fale com o Ligou em português</label>
        <input
          id="chat-input"
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Fale com o Ligou..."
          autoComplete="off"
        />
        {/* Os dois botões ocupam o MESMO slot: o input não muda de largura
            (e o caret não pula) quando digitar troca voz por enviar. */}
        <span className="composer-action">
          <button
            className="composer-send"
            type="submit"
            disabled={sending}
            aria-label="Enviar mensagem"
            data-hidden={draft.trim() ? undefined : "true"}
            tabIndex={draft.trim() ? 0 : -1}
          >
            <IconSend aria-hidden="true" />
          </button>
          <button
            className="voice-demo-button"
            type="button"
            onClick={onVoice}
            data-hidden={draft.trim() ? "true" : undefined}
            tabIndex={draft.trim() ? -1 : 0}
          >
            <IconMicrophone2 aria-hidden="true" />
            <span>{prototype ? "Voz · demo" : "Voz"}</span>
          </button>
        </span>
        {sending ? <span className="sending-status"><IconMessageCircle2 aria-hidden="true" /> Respondendo…</span> : null}
      </form>
    </section>
  );
}
