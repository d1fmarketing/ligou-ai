import {
  IconAdjustments,
  IconArrowRight,
  IconCalendarEvent,
  IconCheck,
  IconCircleCheck,
  IconClockHour4,
  IconFileDescription,
  IconMapPin,
  IconMessageQuestion,
  IconShieldCheck,
  IconUser,
  IconX,
} from '@tabler/icons-react';

const STATUS_LABELS = {
  pendente: 'Aguardando sua decisão',
  aprovada: 'Aprovada',
  recusada: 'Recusada',
};

function readable(value, fallback = 'Não informado') {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function customerName(approval) {
  if (typeof approval?.customer === 'string') return approval.customer;
  return readable(approval?.customer?.name || approval?.clientName || approval?.client, 'Cliente');
}

function approvalStatus(approval) {
  return approval?.status || 'pendente';
}

function isPending(approval) {
  return approvalStatus(approval) === 'pendente';
}

function requestText(approval) {
  return readable(approval?.request || approval?.summary || approval?.proposal, 'Pedido sem descrição.');
}

function ruleText(approval) {
  return readable(
    approval?.consultedRule || approval?.rule || approval?.ruleConsulted,
    'Nenhuma regra correspondente foi encontrada.',
  );
}

export function ApprovalsView({
  approvals = [],
  selectedId,
  onSelect,
  onApprove,
  onAdjust,
  onReject,
}) {
  const selected = approvals.find((approval) => approval.id === selectedId) || approvals[0];
  const pendingCount = approvals.filter(isPending).length;

  return (
    <section className="approvals-view" aria-labelledby="approvals-title">
      <header className="approvals-header">
        <div className="approvals-heading-copy">
          <span className="approvals-kicker">Decisões sob seu controle</span>
          <h1 id="approvals-title">Aprovações</h1>
          <p>
            Revise exceções antes de o Ligou agir. Nada vira regra sem sua decisão.
          </p>
        </div>
        <div className="approvals-count" aria-label={`${pendingCount} aprovações pendentes`}>
          <IconClockHour4 aria-hidden="true" />
          <strong>{pendingCount}</strong>
          <span>{pendingCount === 1 ? 'pendente' : 'pendentes'}</span>
        </div>
      </header>

      {approvals.length > 0 ? (
        <div className="approvals-workspace">
          <aside className="approvals-list-panel" aria-label="Lista de aprovações">
            <div className="approvals-list-heading">
              <h2>Solicitações</h2>
              <span>{approvals.length}</span>
            </div>
            <ul className="approvals-list">
              {approvals.map((approval) => {
                const status = approvalStatus(approval);
                const active = approval.id === selected?.id;

                return (
                  <li key={approval.id}>
                    <button
                      className="approvals-list-item"
                      data-active={active ? 'true' : undefined}
                      type="button"
                      onClick={() => onSelect?.(approval.id)}
                      aria-current={active ? 'true' : undefined}
                    >
                      <span className="approvals-list-icon" data-status={status}>
                        {isPending(approval) ? (
                          <IconClockHour4 aria-hidden="true" />
                        ) : (
                          <IconCircleCheck aria-hidden="true" />
                        )}
                      </span>
                      <span className="approvals-list-copy">
                        <strong>{customerName(approval)}</strong>
                        <span>{requestText(approval)}</span>
                        <small>{STATUS_LABELS[status] || status}</small>
                      </span>
                      <IconArrowRight className="approvals-list-arrow" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <article className="approvals-detail" aria-labelledby={`approval-${selected.id}`}>
            <header className="approvals-detail-header">
              <div>
                <span className="approvals-detail-kicker">Pedido urgente · mesmo dia</span>
                <h2 id={`approval-${selected.id}`}>{customerName(selected)}</h2>
              </div>
              <span className="approvals-status" data-status={approvalStatus(selected)}>
                {isPending(selected) ? (
                  <IconClockHour4 aria-hidden="true" />
                ) : (
                  <IconCircleCheck aria-hidden="true" />
                )}
                {STATUS_LABELS[approvalStatus(selected)] || approvalStatus(selected)}
              </span>
            </header>

            <dl className="approvals-context">
              <div>
                <dt>
                  <IconUser aria-hidden="true" />
                  Cliente
                </dt>
                <dd>{customerName(selected)}</dd>
              </div>
              <div>
                <dt>
                  <IconMapPin aria-hidden="true" />
                  Localização
                </dt>
                <dd>{readable(selected.location || selected.customer?.location, 'San Rafael, CA')}</dd>
              </div>
              <div>
                <dt>
                  <IconCalendarEvent aria-hidden="true" />
                  Quando
                </dt>
                <dd>{readable(selected.date || selected.requestedFor, 'Hoje · 15/08/2026')}</dd>
              </div>
            </dl>

            <div className="approvals-decision-flow" aria-label="Contexto da decisão">
              <section className="approvals-decision-block">
                <span className="approvals-decision-icon">
                  <IconMessageQuestion aria-hidden="true" />
                </span>
                <div>
                  <h3>Pedido do cliente</h3>
                  <p>{requestText(selected)}</p>
                  {selected.note ? <small>{selected.note}</small> : null}
                </div>
              </section>

              <section className="approvals-decision-block">
                <span className="approvals-decision-icon">
                  <IconFileDescription aria-hidden="true" />
                </span>
                <div>
                  <h3>Regra consultada</h3>
                  <p>{ruleText(selected)}</p>
                </div>
              </section>

              <section className="approvals-decision-block">
                <span className="approvals-decision-icon">
                  <IconShieldCheck aria-hidden="true" />
                </span>
                <div>
                  <h3>{isPending(selected) ? 'Ação proposta' : 'Ação tomada'}</h3>
                  <p>
                    {readable(
                      selected.actionTaken || selected.proposedAction || selected.action,
                      'Confirmar o encaixe e avisar o cliente.',
                    )}
                  </p>
                </div>
              </section>

              <section className="approvals-decision-block approvals-consequence">
                <span className="approvals-decision-icon">
                  <IconArrowRight aria-hidden="true" />
                </span>
                <div>
                  <h3>O que acontece depois</h3>
                  <p>
                    {readable(
                      selected.consequence,
                      'O Ligou confirma o horário com o cliente e registra sua decisão.',
                    )}
                  </p>
                </div>
              </section>
            </div>

            {isPending(selected) ? (
              <footer className="approvals-actions" aria-label="Ações para esta aprovação">
                <button
                  className="approvals-approve-button"
                  type="button"
                  onClick={() => onApprove?.(selected)}
                >
                  <IconCheck aria-hidden="true" />
                  Aprovar
                </button>
                <button
                  className="approvals-adjust-button"
                  type="button"
                  onClick={() => onAdjust?.(selected)}
                >
                  <IconAdjustments aria-hidden="true" />
                  Ajustar
                </button>
                <button
                  className="approvals-reject-button"
                  type="button"
                  onClick={() => onReject?.(selected)}
                >
                  <IconX aria-hidden="true" />
                  Recusar
                </button>
              </footer>
            ) : (
              <footer className="approvals-resolved">
                <IconCircleCheck aria-hidden="true" />
                <div>
                  <strong>Decisão registrada</strong>
                  <span>Esta solicitação não está mais pendente.</span>
                </div>
              </footer>
            )}
          </article>
        </div>
      ) : (
        <div className="approvals-empty" role="status">
          <IconCircleCheck aria-hidden="true" />
          <h2>Nenhuma aprovação pendente</h2>
          <p>Quando o Ligou encontrar uma exceção, ela aparecerá aqui para sua decisão.</p>
        </div>
      )}
    </section>
  );
}
