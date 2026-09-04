import { useId } from "react";
import {
  IconCalendarEvent,
  IconCircleCheck,
  IconCircleX,
  IconFileDescription,
  IconMapPin,
  IconPencil,
  IconUser,
} from "@tabler/icons-react";

// Nada de estado inventado: kicker, etiqueta "Novo cliente" e localização só
// aparecem quando o dado existe. Os valores do mock aprovado vivem na fixture
// approval-john-urgent (src/data/fixtures.js), não em defaults do componente.
export function ApprovalCard({ approval, onApprove, onAdjust, onReject, compact = false }) {
  // Por instância (o card renderiza duas vezes: timeline mobile e inspector),
  // senão o id do cliente duplicaria no DOM.
  const clientId = useId();

  if (!approval) {
    return (
      <div className="approval-empty">
        <IconCircleCheck aria-hidden="true" />
        <strong>Nenhuma decisão pendente</strong>
        <p>O Ligou continua operando dentro das regras já aprovadas.</p>
      </div>
    );
  }

  const buttonProps = { "data-approval-id": approval.id, "aria-describedby": clientId };

  return (
    <article className={`approval-card ${compact ? "approval-card--compact" : ""}`}>
      {approval.urgencyLabel ? (
        <div className="approval-kicker">
          <IconCalendarEvent aria-hidden="true" />
          <span>{approval.urgencyLabel}</span>
        </div>
      ) : null}
      <dl className="approval-facts">
        <div>
          <dt><IconUser aria-hidden="true" /><span className="sr-only">Cliente</span></dt>
          <dd id={clientId}>
            {approval.clientName}
            {approval.isNewClient ? <> <span className="client-tag">Novo cliente</span></> : null}
          </dd>
        </div>
        {approval.location ? (
          <div>
            <dt><IconMapPin aria-hidden="true" /><span className="sr-only">Localização</span></dt>
            <dd>{approval.location}</dd>
          </div>
        ) : null}
        {approval.date ? (
          <div>
            <dt><IconCalendarEvent aria-hidden="true" /><span className="sr-only">Data</span></dt>
            <dd>{approval.date === "2026-08-15" ? "Hoje · 15/08/2026" : approval.date}</dd>
          </div>
        ) : null}
        {approval.request ? (
          <div>
            <dt><IconFileDescription aria-hidden="true" /><span className="sr-only">Solicitação</span></dt>
            <dd>
              <strong>Solicitação:</strong> {approval.request}
              {approval.note ? <small>{approval.note}</small> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      {approval.rule ? (
        <div className="approval-context">
          <span>Regra consultada</span>
          <p>{approval.rule}</p>
        </div>
      ) : null}
      <div className="approval-actions">
        <button className="button button--primary" type="button" onClick={() => onApprove(approval)} {...buttonProps}>
          <IconCircleCheck aria-hidden="true" /> Aprovar
        </button>
        <button className="button button--outline-dark" type="button" onClick={() => onAdjust(approval)} {...buttonProps}>
          <IconPencil aria-hidden="true" /> Ajustar
        </button>
        <button className="button button--outline-dark" type="button" onClick={() => onReject(approval)} {...buttonProps}>
          <IconCircleX aria-hidden="true" /> Recusar
        </button>
      </div>
    </article>
  );
}
