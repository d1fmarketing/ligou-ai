import { useEffect, useMemo, useReducer, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconExternalLink,
  IconFileSearch,
  IconLock,
  IconPencil,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import {
  createDiscoveryReviewState,
  discoveryReviewReducer,
  formatDiscoveryValue,
} from "../discovery-model.js";

const TYPE_LABELS = {
  business_name: "Nome da empresa",
  business_description: "Descrição pública",
  public_phone: "Telefone público",
  public_email: "E-mail público",
  public_address: "Endereço público",
  public_website: "Site público",
  service: "Serviço publicado",
  emergency: "Orientação de emergência",
};

function StatusSurface({ phase, reason, onDiscover }) {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (phase === "loading") {
    return (
      <aside className="discovery-status discovery-status--loading" aria-label="Carregando descoberta do site">
        <span className="discovery-status-pulse" aria-hidden="true" />
        <p><strong>Buscando sugestões do site…</strong> Você não precisa esperar: a entrevista em português continua disponível abaixo.</p>
      </aside>
    );
  }

  if (phase === "working") {
    return (
      <aside className="discovery-status" aria-live="polite">
        <IconFileSearch aria-hidden="true" />
        <p><strong>Leitura pública em andamento.</strong> Você não precisa esperar. Comece a entrevista agora; qualquer resultado que chegar depois será apenas sugestão.</p>
      </aside>
    );
  }

  if (phase === "fallback" || phase === "unavailable") {
    const label = reason === "failed"
      ? "A leitura do site não terminou."
      : reason === "deadline_expired" || reason === "company_discovery_deadline_expired"
        ? "O tempo reservado para a leitura terminou."
        : "A leitura automática do site não está disponível para esta empresa.";
    return (
      <aside className="discovery-status discovery-status--fallback" role="status">
        <IconAlertTriangle aria-hidden="true" />
        <p><strong>{label}</strong> A entrevista em português continua disponível agora e não depende desta etapa.</p>
      </aside>
    );
  }

  if (phase === "complete") {
    return (
      <aside className="discovery-status discovery-status--complete" role="status">
        <IconCheck aria-hidden="true" />
        <p><strong>Revisão do site concluída.</strong> Só as decisões confirmadas pelo dono podem orientar a Ligou.</p>
      </aside>
    );
  }

  if (phase !== "empty") return null;
  return (
    <aside className="discovery-start" aria-labelledby="discovery-start-title">
      <div>
        <span className="discovery-kicker">Etapa opcional</span>
        <h2 id="discovery-start-title">Adiantar com o site</h2>
        <p>A Ligou pode reunir dados públicos como sugestões. A entrevista em português já está disponível e nunca espera por isso.</p>
      </div>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!onDiscover || submitting) return;
        setSubmitting(true);
        setError("");
        try {
          await onDiscover(url.trim());
          setUrl("");
        } catch (caught) {
          setError(caught?.message || "Não foi possível iniciar a leitura. A entrevista continua disponível.");
        } finally {
          setSubmitting(false);
        }
      }}>
        <label htmlFor="discovery-url">Site público da empresa</label>
        <div>
          <input
            id="discovery-url"
            type="url"
            inputMode="url"
            placeholder="https://suaempresa.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
          <button className="button button--ghost" type="submit" disabled={submitting}>
            {submitting ? "Iniciando…" : "Buscar sugestões"}
          </button>
        </div>
        {error ? <p className="discovery-inline-error" role="alert">{error}</p> : null}
      </form>
    </aside>
  );
}

function EvidenceRail({ decision }) {
  const accepted = decision === "approve" || decision === "edit";
  return (
    <div className="discovery-authority-rail" aria-label="Evidência até autoridade">
      <div className="discovery-rail-step is-evidence">
        <span>1</span><strong>Evidência do site</strong><small>Fonte pública imutável</small>
      </div>
      <IconArrowRight aria-hidden="true" />
      <div className="discovery-rail-step is-candidate">
        <span>2</span><strong>Candidato</strong><small>Sem autoridade</small>
      </div>
      <IconArrowRight aria-hidden="true" />
      <div className={`discovery-rail-step ${decision ? "is-decided" : ""}`}>
        <span>3</span><strong>Decisão do dono</strong><small>{decision ? "Escolhida" : "Pendente"}</small>
      </div>
      <IconArrowRight aria-hidden="true" />
      <div className={`discovery-rail-step ${accepted ? "is-rule" : "is-locked"}`}>
        <span>{accepted ? <IconCheck aria-hidden="true" /> : <IconLock aria-hidden="true" />}</span>
        <strong>Regra da Ligou</strong>
        <small>{accepted ? "Só após confirmar" : decision === "reject" ? "Não será criada" : "Bloqueada"}</small>
      </div>
    </div>
  );
}

function EvidenceList({ claim }) {
  return (
    <div className="discovery-evidence-list">
      {claim.evidence.map((evidence) => (
        <article key={evidence.id} className="discovery-evidence">
          <a href={evidence.url} target="_blank" rel="noreferrer">
            {evidence.url} <IconExternalLink aria-hidden="true" />
          </a>
          <blockquote>{evidence.excerpt || "A fonte não trouxe um trecho legível."}</blockquote>
          <small>SHA-256 · <code>{evidence.contentHash?.slice(0, 12)}</code></small>
        </article>
      ))}
    </div>
  );
}

function ClaimSignals({ claim }) {
  if (!claim.contradictions.length && !claim.uncertainty.length) return null;
  return (
    <div className="discovery-signals">
      {claim.contradictions.length ? (
        <div className="discovery-signal discovery-signal--conflict">
          <strong>Contradições</strong>
          <ul>{claim.contradictions.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      {claim.uncertainty.length ? (
        <div className="discovery-signal">
          <strong>Incerteza</strong>
          <ul>{claim.uncertainty.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

function EditValue({ claim, value, onChange }) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    setError("");
  }, [claim.id]);

  const update = (next) => {
    setDraft(next);
    if (typeof claim.value === "string") {
      setError(next.trim() ? "" : "O valor não pode ficar vazio.");
      if (next.trim()) onChange(next.trim());
      return;
    }
    try {
      const parsed = JSON.parse(next);
      setError("");
      onChange(parsed);
    } catch {
      setError("Revise o formato antes de confirmar.");
    }
  };

  return (
    <label className="discovery-edit-field">
      <span>Valor corrigido</span>
      <textarea rows={typeof claim.value === "string" ? 3 : 7} value={draft} onChange={(event) => update(event.target.value)} />
      {error ? <small role="alert">{error}</small> : null}
    </label>
  );
}

function ClaimCard({ claim, groupId, reviewState, dispatch }) {
  const selected = reviewState.decisions[claim.id];
  return (
    <article className="discovery-claim">
      <header>
        <div>
          <span className="discovery-claim-type">{TYPE_LABELS[claim.type] || claim.type}</span>
          <h4>{formatDiscoveryValue(claim)}</h4>
        </div>
        <span className="discovery-version">claim v{claim.version}</span>
      </header>

      <EvidenceRail decision={selected.decision} />
      <details className="discovery-evidence-details" open={groupId === "safety"}>
        <summary>Ver URL, trecho e hash da evidência</summary>
        <EvidenceList claim={claim} />
      </details>
      <ClaimSignals claim={claim} />

      <fieldset className="discovery-decisions">
        <legend>Sua decisão para este candidato</legend>
        <button
          type="button"
          className={selected.decision === "approve" ? "is-selected" : ""}
          aria-pressed={selected.decision === "approve"}
          onClick={() => dispatch({ type: "decide", claimId: claim.id, decision: "approve" })}
        ><IconCheck aria-hidden="true" /> Aprovar</button>
        <button
          type="button"
          className={selected.decision === "edit" ? "is-selected" : ""}
          aria-pressed={selected.decision === "edit"}
          onClick={() => dispatch({ type: "decide", claimId: claim.id, decision: "edit" })}
        ><IconPencil aria-hidden="true" /> Editar</button>
        <button
          type="button"
          className={selected.decision === "reject" ? "is-selected is-reject" : ""}
          aria-pressed={selected.decision === "reject"}
          onClick={() => dispatch({ type: "decide", claimId: claim.id, decision: "reject" })}
        ><IconX aria-hidden="true" /> Rejeitar</button>
      </fieldset>

      {selected.decision === "edit" ? (
        <EditValue
          claim={claim}
          value={selected.value}
          onChange={(value) => dispatch({ type: "edit", claimId: claim.id, value })}
        />
      ) : null}

      {groupId === "safety" && selected.decision && selected.decision !== "reject" ? (
        <label className="discovery-evidence-ack">
          <input
            type="checkbox"
            checked={Boolean(reviewState.evidenceAcks[claim.id])}
            onChange={(event) => dispatch({ type: "ackEvidence", claimId: claim.id, checked: event.target.checked })}
          />
          <span>Li e reconheço exatamente as {claim.evidenceRefs.length} {claim.evidenceRefs.length === 1 ? "evidência acima" : "evidências acima"}.</span>
        </label>
      ) : null}
    </article>
  );
}

function GroupConfirmation({ group, checked, onChange }) {
  const copy = group.id === "descriptive"
    ? "Revisei os dados públicos escolhidos. Eles podem atualizar o perfil da empresa."
    : group.id === "operational"
      ? "Confirmo explicitamente este grupo operacional. Os itens aprovados ou editados podem criar regras de atendimento, sem conceder negociação privada."
      : "Confirmo explicitamente o grupo de segurança depois de ler cada evidência reconhecida.";
  return (
    <label className={`discovery-group-confirmation discovery-group-confirmation--${group.id}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{copy}</span>
    </label>
  );
}

export function DiscoveryReviewView({
  discovery = { phase: "loading" },
  onDiscover,
  onReview,
  busy = false,
}) {
  const [reviewState, dispatch] = useReducer(discoveryReviewReducer, discovery, createDiscoveryReviewState);
  const [error, setError] = useState("");
  const reviewIdentity = `${discovery?.result?.id || "none"}:${discovery?.job?.version || 0}`;
  useEffect(() => {
    dispatch({ type: "reset", review: discovery });
    setError("");
  }, [reviewIdentity]);

  const claimCount = useMemo(
    () => discovery.phase === "review"
      ? discovery.groups.reduce((count, group) => count + group.claims.length, 0)
      : 0,
    [discovery],
  );

  if (discovery.phase !== "review") {
    return <StatusSurface phase={discovery.phase} reason={discovery.reason} onDiscover={onDiscover} />;
  }

  return (
    <details className="discovery-review">
      <summary className="discovery-review-header">
        <div>
          <span className="discovery-kicker">Sugestões sem autoridade</span>
          <h2 id="discovery-review-title">Revisão do site</h2>
          <p>{claimCount} {claimCount === 1 ? "candidato público" : "candidatos públicos"}. Nada muda até sua confirmação atômica.</p>
        </div>
        <div className="discovery-review-meta">
          {discovery.lateSuggestion ? <strong>Chegou depois da entrevista · apenas sugestão</strong> : <strong>Aguardando sua revisão</strong>}
          <small>job v{discovery.job.version} · resultado {discovery.result.hash?.slice(0, 12)}</small>
          <span className="discovery-review-toggle">Abrir revisão</span>
        </div>
      </summary>

      <div className="discovery-review-body">
      {(discovery.contradictions.length || discovery.uncertainty.length) ? (
        <aside className="discovery-result-caveats">
          <IconAlertTriangle aria-hidden="true" />
          <div>
            <strong>A leitura encontrou pontos para conferir.</strong>
            {[...discovery.contradictions, ...discovery.uncertainty].map((item) => <p key={item}>{item}</p>)}
          </div>
        </aside>
      ) : null}

      <form className="discovery-review-form" onSubmit={async (event) => {
        event.preventDefault();
        if (!onReview || busy) return;
        setError("");
        try {
          await onReview({ review: discovery, reviewState });
        } catch (caught) {
          setError(caught?.message || "A revisão não foi confirmada. Recarregue e tente novamente.");
        }
      }}>
        {discovery.groups.map((group) => (
          <section className={`discovery-group discovery-group--${group.id}`} key={group.id} aria-labelledby={`discovery-group-${group.id}`}>
            <header>
              <span>{group.id === "safety" ? <IconShieldCheck aria-hidden="true" /> : <IconFileSearch aria-hidden="true" />}</span>
              <div><h3 id={`discovery-group-${group.id}`}>{group.label}</h3><p>{group.description}</p></div>
              <strong>{group.claims.length}</strong>
            </header>
            <div className="discovery-claims">
              {group.claims.map((claim) => (
                <ClaimCard key={claim.id} claim={claim} groupId={group.id} reviewState={reviewState} dispatch={dispatch} />
              ))}
            </div>
            <GroupConfirmation
              group={group}
              checked={reviewState.confirmations[group.id]}
              onChange={(checked) => dispatch({ type: "confirm", group: group.id, checked })}
            />
          </section>
        ))}

        {discovery.privateQuestions.length ? (
          <section className="discovery-private" aria-labelledby="discovery-private-title">
            <IconLock aria-hidden="true" />
            <div>
              <h3 id="discovery-private-title">Perguntas para a entrevista</h3>
              <p>Assuntos privados aparecem somente como perguntas não respondidas. Nunca são aprovados como fatos.</p>
              <ul>{discovery.privateQuestions.map((item) => <li key={item.id}>{item.question}</li>)}</ul>
            </div>
          </section>
        ) : null}

        {error ? <p className="discovery-submit-error" role="alert">{error}</p> : null}
        <footer className="discovery-review-actions">
          <p><IconLock aria-hidden="true" /> Um nonce curto vincula exatamente este job, resultado e conjunto de claims.</p>
          <button className="button button--primary" type="submit" disabled={busy}>
            {busy ? "Confirmando o lote…" : "Confirmar revisão em um lote"}
          </button>
        </footer>
      </form>
      </div>
    </details>
  );
}
