import { useEffect, useMemo, useReducer, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconExternalLink,
  IconFileSearch,
  IconLock,
  IconMicrophone2,
  IconPencil,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import {
  buildDiscoveryReviewRequest,
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
  service_territory: "Área atendida publicada",
  business_hours: "Horário publicado",
  guarantee: "Garantia publicada",
  booking_restriction: "Restrição de agendamento",
  emergency: "Orientação de emergência",
};

function StatusSurface({ phase, reason, processingStage, onDiscover }) {
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
    const label = processingStage === "queued"
      ? "Na fila para leitura pública."
      : processingStage === "fetching"
        ? "Lendo páginas públicas permitidas."
        : processingStage === "analyzing"
          ? "Organizando sugestões para sua revisão."
          : "Leitura pública em andamento.";
    return (
      <aside className="discovery-status" aria-live="polite">
        <IconFileSearch aria-hidden="true" />
        <p><strong>{label}</strong> Você não precisa esperar. A entrevista em português continua disponível agora; qualquer resultado que chegar depois será apenas sugestão.</p>
      </aside>
    );
  }

  if (phase === "fallback" || phase === "unavailable") {
    const label = reason === "failed"
      ? "A leitura do site não terminou."
      : reason === "deadline_expired" || reason === "company_discovery_deadline_expired"
        ? "O tempo reservado para a leitura terminou."
        : reason === "disabled"
          ? "A leitura automática do site está desativada."
          : reason === "not_allowlisted"
            ? "A leitura automática do site não foi liberada para esta empresa."
            : reason === "allowlist_expired"
              ? "A permissão para leitura automática expirou."
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

function EvidenceRail({ decision, groupId, claim }) {
  const accepted = decision === "approve" || decision === "edit";
  const stage0b = claim.claimSchemaVersion === "company_discovery.claim.v2";
  const finalLabel = stage0b
    ? "Rascunho de onboarding"
    : groupId === "descriptive" ? "Perfil da empresa" : "Regra da Ligou";
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
        <strong>{finalLabel}</strong>
        <small>{accepted ? "Só após confirmar" : decision === "reject" ? "Não será incluído" : "Bloqueado"}</small>
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
  const confidence = ({ high: "alta", medium: "média", low: "baixa" })[claim.confidence];
  if (!confidence && !claim.contradictions.length && !claim.uncertainty.length &&
      !claim.missingFields?.length && !claim.ambiguousFields?.length) return null;
  return (
    <div className="discovery-signals">
      {confidence ? (
        <div className="discovery-signal">
          <strong>Confiança {confidence}</strong>
          <p>Extraído por {claim.model || "modelo textual"} via {claim.adapterId || "adapter registrado"}.</p>
        </div>
      ) : null}
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
      {claim.missingFields?.length ? (
        <div className="discovery-signal">
          <strong>Campos ainda ausentes</strong>
          <ul>{claim.missingFields.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      {claim.ambiguousFields?.length ? (
        <div className="discovery-signal discovery-signal--conflict">
          <strong>Campos ambíguos</strong>
          <ul>{claim.ambiguousFields.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

function EditValue({ claim, editor, onField }) {
  const error = editor?.error;
  if (editor?.kind === "structured") {
    return (
      <fieldset className="discovery-edit-field">
        <legend>Corrigir {TYPE_LABELS[claim.type]?.toLowerCase() || "dado estruturado"}</legend>
        <label>
          <span>Estrutura completa que será enviada</span>
          <textarea
            name="structuredJson"
            rows="12"
            value={editor.draft.json}
            onChange={(event) => onField("json", event.target.value)}
            spellCheck="false"
          />
          <small>Edite somente o fato público. Autoridade, preço privado e ativação não são aceitos.</small>
        </label>
        {error ? <small className="discovery-editor-error" role="alert">{error}</small> : null}
      </fieldset>
    );
  }
  if (editor?.kind === "service" || editor?.kind === "service_v2") {
    const draft = editor.draft;
    return (
      <fieldset className="discovery-edit-field discovery-service-editor">
        <legend>Corrigir dados públicos do serviço</legend>
        <label className="discovery-edit-wide">
          <span>Nomes publicados do serviço</span>
          <input name="serviceNames" value={draft.serviceNames} onChange={(event) => onField("serviceNames", event.target.value)} />
          <small>Separe nomes diferentes com vírgulas.</small>
        </label>
        <label className="discovery-price-toggle discovery-edit-wide">
          <input name="publicPricePublished" type="checkbox" checked={draft.pricePublished} onChange={(event) => onField("pricePublished", event.target.checked)} />
          <span>O site publica um preço para este serviço</span>
        </label>
        <label>
          <span>Valor público</span>
          <input name="publicAmount" inputMode="decimal" placeholder="149.00" disabled={!draft.pricePublished} value={draft.amount} onChange={(event) => onField("amount", event.target.value)} />
        </label>
        <label>
          <span>Moeda</span>
          <input name="publicCurrency" inputMode="text" maxLength="3" disabled={!draft.pricePublished} value={draft.currency} onChange={(event) => onField("currency", event.target.value.toUpperCase())} />
        </label>
        <label>
          <span>Como aparece</span>
          <select name="publicQualifier" disabled={!draft.pricePublished} value={draft.qualifier} onChange={(event) => onField("qualifier", event.target.value)}>
            {editor.kind === "service" ? <option value="exact">Preço exato</option> : <option value="fixed">Preço fixo</option>}
            <option value="starting_at">A partir de</option>
            {editor.kind === "service_v2" ? <>
              <option value="estimate">Estimativa</option>
              <option value="promotional">Promocional</option>
              <option value="conditional">Condicional</option>
              <option value="unknown">Valor não informado</option>
            </> : null}
          </select>
        </label>
        {editor.kind === "service_v2" ? (
          <label className="discovery-edit-wide">
            <span>Condição pública do preço</span>
            <input name="publicPriceCondition" value={draft.condition} onChange={(event) => onField("condition", event.target.value)} />
          </label>
        ) : null}
        <label>
          <span>Duração pública em minutos</span>
          <input name="durationMinutes" type="number" min="1" max="10080" value={draft.durationMinutes} onChange={(event) => onField("durationMinutes", event.target.value)} />
        </label>
        <p className="discovery-editor-boundary discovery-edit-wide">Preço privado, piso e negociação não fazem parte desta revisão.</p>
        {error ? <small className="discovery-editor-error discovery-edit-wide" role="alert">{error}</small> : null}
      </fieldset>
    );
  }
  if (editor?.kind === "emergency") {
    return (
      <fieldset className="discovery-edit-field">
        <legend>Corrigir orientação pública de segurança</legend>
        <label>
          <span>Orientação de emergência</span>
          <textarea name="emergencyGuidance" rows="5" maxLength="2000" value={editor.draft.guidance} onChange={(event) => onField("guidance", event.target.value)} />
        </label>
        {error ? <small className="discovery-editor-error" role="alert">{error}</small> : null}
      </fieldset>
    );
  }
  return (
    <fieldset className="discovery-edit-field">
      <legend>Corrigir dado público</legend>
      <label>
        <span>{TYPE_LABELS[claim.type] || "Valor público"}</span>
        <textarea name="descriptiveValue" rows="3" maxLength="2000" value={editor?.draft.text ?? ""} onChange={(event) => onField("text", event.target.value)} />
      </label>
      {error ? <small className="discovery-editor-error" role="alert">{error}</small> : null}
    </fieldset>
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

      <EvidenceRail decision={selected.decision} groupId={groupId} claim={claim} />
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
          editor={selected.editor}
          onField={(field, value) => dispatch({ type: "editField", claimId: claim.id, field, value })}
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
  const copy = group.id === "descriptive" || group.id === "company"
    ? "Revisei os dados públicos escolhidos. Eles podem atualizar o perfil da empresa."
    : group.id === "operational"
      ? "Confirmo explicitamente este grupo operacional. Os itens aprovados ou editados podem criar regras de atendimento, sem conceder negociação privada."
      : group.id === "safety"
        ? "Confirmo explicitamente o grupo de segurança depois de ler cada evidência reconhecida."
        : `Confirmo explicitamente ${group.label.toLowerCase()} como entrada do rascunho de onboarding, sem ativação automática.`;
  return (
    <label className={`discovery-group-confirmation discovery-group-confirmation--${group.id}`}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{copy}</span>
    </label>
  );
}

function GlobalUnresolvedCard({ item, state, dispatch }) {
  const selected = state.unresolvedDecisions?.[item.id] ?? {
    decision: "ask",
    ownerResponse: "",
  };
  return (
    <article className="discovery-unresolved-item">
      <header>
        <strong>{item.question}</strong>
        <small>{item.sourceKind === "missing_question" ? "Informação ausente ou privada" : item.sourceKind === "contradiction" ? "Contradição global" : "Incerteza global"}</small>
      </header>
      {item.evidence?.length ? (
        <details>
          <summary>Ver evidência pública relacionada</summary>
          {item.evidence.map((evidence) => (
            <p key={evidence.id}>
              <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.url}</a>
              {evidence.excerpt ? ` — ${evidence.excerpt}` : ""}
            </p>
          ))}
        </details>
      ) : null}
      <label>
        <span>Como tratar</span>
        <select
          value={selected.decision}
          onChange={(event) => dispatch({
            type: "decideUnresolved",
            itemId: item.id,
            decision: event.target.value,
          })}
        >
          <option value="ask">Levar para a entrevista</option>
          <option value="answer">Responder agora</option>
          <option value="reject">Rejeitar sugestão</option>
          <option value="not_applicable">Não se aplica</option>
          <option value="defer">Adiar para revisão do dono</option>
        </select>
      </label>
      {selected.decision === "answer" ? (
        <label>
          <span>Resposta confirmada pelo dono</span>
          <textarea
            value={selected.ownerResponse}
            onChange={(event) => dispatch({
              type: "editUnresolved",
              itemId: item.id,
              value: event.target.value,
            })}
          />
        </label>
      ) : null}
    </article>
  );
}

export function DiscoveryReviewReadiness({ message }) {
  return (
    <p
      className={`discovery-review-readiness${message ? " is-blocked" : " is-ready"}`}
      id="discovery-review-readiness"
      role="status"
      aria-live="polite"
    >
      {message ? <IconAlertTriangle aria-hidden="true" /> : <IconCheck aria-hidden="true" />}
      <span>{message || "Revisão pronta para confirmação em um lote."}</span>
    </p>
  );
}

export function DiscoveryReviewView({
  discovery = { phase: "loading" },
  onDiscover,
  onReview,
  onStartInterview,
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
  const reviewError = useMemo(() => {
    if (discovery.phase !== "review") return "";
    try {
      buildDiscoveryReviewRequest(discovery, reviewState, "readiness-check");
      return "";
    } catch (caught) {
      return caught?.message || "Revise todos os campos antes de confirmar.";
    }
  }, [discovery, reviewState]);

  if (discovery.phase !== "review") {
    return <StatusSurface phase={discovery.phase} reason={discovery.reason} processingStage={discovery.processingStage} onDiscover={onDiscover} />;
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
          <strong>Sugestão pública · sem efeito automático</strong>
          <small>job v{discovery.job.version} · resultado {discovery.result.hash?.slice(0, 12)}</small>
          <span className="discovery-review-toggle">Abrir revisão</span>
        </div>
      </summary>

      <div className="discovery-review-body">
      {onStartInterview ? (
        <aside className="discovery-interview-shortcut-wrap">
          <p><strong>Prefere responder falando?</strong> A entrevista em português continua disponível agora.</p>
          <button className="button button--ghost discovery-interview-shortcut" type="button" onClick={onStartInterview}>
            <IconMicrophone2 aria-hidden="true" /> Começar entrevista em português
          </button>
        </aside>
      ) : null}
      {(discovery.contradictions.length || discovery.uncertainty.length) ? (
        <aside className="discovery-result-caveats">
          <IconAlertTriangle aria-hidden="true" />
          <div>
            <strong>{discovery.result?.schema === "company_discovery.result.v2" ? "Contradições e pontos para conferir" : "A leitura encontrou pontos para conferir."}</strong>
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

        {(discovery.globalUnresolved?.length || discovery.privateQuestions.length) ? (
          <section className="discovery-private" aria-labelledby="discovery-private-title">
            <IconLock aria-hidden="true" />
            <div>
              <h3 id="discovery-private-title">{discovery.result?.schema === "company_discovery.result.v2" ? "Perguntas que ainda faltam" : "Perguntas para a entrevista"}</h3>
              <p>{discovery.result?.schema === "company_discovery.result.v2" ? "A entrevista em português fará somente perguntas ainda ausentes, ambíguas, contraditórias, rejeitadas ou privadas." : "Assuntos privados aparecem somente como perguntas não respondidas. Nunca são aprovados como fatos."}</p>
              {discovery.result?.schema === "company_discovery.result.v2"
                ? discovery.globalUnresolved.map((item) => (
                    <GlobalUnresolvedCard
                      key={item.id}
                      item={item}
                      state={reviewState}
                      dispatch={dispatch}
                    />
                  ))
                : <ul>{discovery.privateQuestions.map((item) => <li key={item.id}>{item.question}</li>)}</ul>}
            </div>
          </section>
        ) : null}

        {error ? <p className="discovery-submit-error" role="alert">{error}</p> : null}
        <footer className="discovery-review-actions">
          <DiscoveryReviewReadiness message={reviewError} />
          <p><IconLock aria-hidden="true" /> Um nonce curto vincula exatamente este job, resultado e conjunto de claims.</p>
          <button className="button button--primary" type="submit" disabled={busy || Boolean(reviewError)} aria-describedby="discovery-review-readiness">
            {busy ? "Confirmando o lote…" : "Confirmar revisão em um lote"}
          </button>
        </footer>
      </form>
      </div>
    </details>
  );
}
