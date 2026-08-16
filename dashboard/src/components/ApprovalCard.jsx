import {
  IconCalendarEvent,
  IconCircleCheck,
  IconCircleX,
  IconFileDescription,
  IconMapPin,
  IconPencil,
  IconUser,
} from "@tabler/icons-react";

export function ApprovalCard({ approval, onApprove, onAdjust, onReject, compact = false }) {
  if (!approval) {
    return (
      <div className="approval-empty">
        <IconCheck aria-hidden="true" />
        <strong>Nenhuma decisão pendente</strong>
        <p>O Ligou continua operando dentro das regras já aprovadas.</p>
      </div>
    );
  }

  return (
    <article className={`approval-card ${compact ? "approval-card--compact" : ""}`}>
      <div className="approval-kicker">
        <IconCalendarEvent aria-hidden="true" />
        <span>{approval.urgencyLabel || "Pedido urgente · mesmo dia"}</span>
      </div>
      <dl className="approval-facts">
        <div>
          <dt><IconUser aria-hidden="true" /><span className="sr-only">Cliente</span></dt>
          <dd>{approval.clientName || "John Miller"} <span className="client-tag">Novo cliente</span></dd>
        </div>
        <div>
          <dt><IconMapPin aria-hidden="true" /><span className="sr-only">Localização</span></dt>
          <dd>{approval.location || "San Rafael, CA"}</dd>
        </div>
        <div>
          <dt><IconCalendarEvent aria-hidden="true" /><span className="sr-only">Data</span></dt>
          <dd>{approval.date === "2026-08-15" ? "Hoje · 15/08/2026" : (approval.date || "Hoje · 15/08/2026")}</dd>
        </div>
        <div>
          <dt><IconFileDescription aria-hidden="true" /><span className="sr-only">Solicitação</span></dt>
          <dd>
            <strong>Solicitação:</strong> {approval.request || "Antes das 17h · Problema na chaminé"}
            {approval.note ? <small>{approval.note}</small> : null}
          </dd>
        </div>
      </dl>
      <div className="approval-context">
        <span>Regra consultada</span>
        <p>{approval.rule || "Encaixe no mesmo dia exige sua aprovação."}</p>
      </div>
      <div className="approval-actions">
        <button className="button button--primary" type="button" onClick={() => onApprove(approval)}>
          <IconCircleCheck aria-hidden="true" /> Aprovar
        </button>
        <button className="button button--outline-dark" type="button" onClick={() => onAdjust(approval)}>
          <IconPencil aria-hidden="true" /> Ajustar
        </button>
        <button className="button button--outline-dark" type="button" onClick={() => onReject(approval)}>
          <IconCircleX aria-hidden="true" /> Recusar
        </button>
      </div>
    </article>
  );
}
