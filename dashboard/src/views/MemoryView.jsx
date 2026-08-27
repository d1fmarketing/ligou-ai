import {
  IconAdjustmentsHorizontal,
  IconBook2,
  IconClockHour4,
  IconEdit,
  IconHistory,
  IconSearch,
  IconShieldCheck,
  IconTrash,
} from '@tabler/icons-react';

const FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'ativa', label: 'Ativas' },
  { value: 'sugerida', label: 'Sugeridas' },
  { value: 'temporária', label: 'Temporárias' },
  { value: 'revogada', label: 'Revogadas' },
];

const STATUS_LABELS = {
  ativa: 'Ativa',
  sugerida: 'Sugerida',
  temporária: 'Temporária',
  revogada: 'Revogada',
};

function readable(value, fallback = 'Não informado') {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

function entryTitle(entry) {
  return readable(entry?.title || entry?.name, 'Regra operacional');
}

function entryText(entry) {
  return readable(entry?.text || entry?.content || entry?.rule, 'Sem conteúdo cadastrado.');
}

function entryStatus(entry) {
  return entry?.status || 'sugerida';
}

function OwnerEvidence({ value }) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return (
    <aside className="memory-owner-evidence" aria-label="Evidência do dono">
      <strong>Evidência do dono</strong>
      <blockquote>{value}</blockquote>
      <small>Evidência somente; não concede autoridade operacional.</small>
    </aside>
  );
}

function displayDate(value, fallback) {
  const raw = readable(value, fallback);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.split('-').reverse().join('/') : raw;
}

function canonicalFieldRows(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
  return Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const rendered = Array.isArray(value)
        ? value.map((item) => String(item)).join(', ')
        : typeof value === 'boolean'
          ? (value ? 'sim' : 'não')
          : value == null
            ? 'Não se aplica'
            : String(value);
      return [key, rendered];
    });
}

function normalizedFilter(filter) {
  if (filter && typeof filter === 'object') {
    return {
      status: filter.status || 'all',
      category: filter.category || 'all',
    };
  }

  return { status: filter || 'all', category: 'all' };
}

function visibleEntries(entries, query, filter) {
  const needle = query.trim().toLocaleLowerCase('pt-BR');
  const activeFilter = normalizedFilter(filter);

  return entries.filter((entry) => {
    const matchesStatus =
      activeFilter.status === 'all' || entryStatus(entry) === activeFilter.status;
    const matchesCategory =
      activeFilter.category === 'all' || entry?.category === activeFilter.category;
    if (!matchesStatus || !matchesCategory) return false;
    if (!needle) return true;

    return [
      entryTitle(entry),
      entryText(entry),
      entry?.category,
      entry?.scope,
      entry?.origin,
    ].some((value) => readable(value, '').toLocaleLowerCase('pt-BR').includes(needle));
  });
}

export function MemoryView({
  entries = [],
  query = '',
  setQuery,
  filter = 'all',
  setFilter,
  onEdit,
  onRevoke,
  onApproveSuggestion,
  onRejectSuggestion,
  onApproveAllSuggestions,
  decisionBusy = false,
}) {
  const activeFilter = normalizedFilter(filter);
  const filteredEntries = visibleEntries(entries, query, filter);
  const categories = [...new Set(entries.map((entry) => entry?.category).filter(Boolean))];
  const suggested = entries.filter((entry) => entryStatus(entry) === 'sugerida');

  const updateStatus = (status) => {
    if (filter && typeof filter === 'object') {
      setFilter?.({ ...activeFilter, status });
      return;
    }
    setFilter?.(status);
  };

  const updateCategory = (category) => {
    setFilter?.({ ...activeFilter, category });
  };

  return (
    <section className="memory-view" aria-labelledby="memory-title">
      <header className="memory-header">
        <div className="memory-heading-copy">
          <span className="memory-kicker">Conhecimento aprovado</span>
          <h1 id="memory-title">Memória</h1>
          <p>
            Veja o que o Ligou usa para atender sua operação e mantenha cada regra sob
            seu controle.
          </p>
        </div>

        <div className="memory-count" aria-label={`${entries.length} regras na memória`}>
          <IconBook2 aria-hidden="true" />
          <strong>{entries.length}</strong>
          <span>{entries.length === 1 ? 'regra' : 'regras'}</span>
        </div>
      </header>

      {suggested.length > 0 && onApproveAllSuggestions ? (
        <div className="memory-suggestion-banner" role="status">
          <IconShieldCheck aria-hidden="true" />
          <p>
            <strong>{suggested.length === 1 ? '1 sugestão da entrevista aguarda' : `${suggested.length} sugestões da entrevista aguardam`} sua aprovação.</strong>{' '}
            Aprovadas, viram regras ativas que o Ligou passa a usar nas conversas.
          </p>
          <button
            className="button button--primary"
            type="button"
            disabled={decisionBusy}
            onClick={() => onApproveAllSuggestions(suggested)}
          >
            {decisionBusy ? 'Aprovando…' : 'Aprovar todas'}
          </button>
        </div>
      ) : null}

      <div className="memory-tools">
        <label className="memory-search">
          <span className="memory-search-label">Buscar na memória</span>
          <span className="memory-search-control">
            <IconSearch aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery?.(event.target.value)}
              placeholder="Buscar regra, origem ou escopo"
              autoComplete="off"
            />
          </span>
        </label>

        <div className="memory-filter-group" role="group" aria-labelledby="memory-filter-label">
          <span className="memory-filter-heading" id="memory-filter-label">
            <IconAdjustmentsHorizontal aria-hidden="true" />
            Filtrar por estado
          </span>
          <div className="memory-filter-options">
            {FILTERS.map((option) => (
              <button
                className="memory-filter-button"
                data-active={activeFilter.status === option.value ? 'true' : undefined}
                type="button"
                key={option.value}
                onClick={() => updateStatus(option.value)}
                aria-pressed={activeFilter.status === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <label className="memory-category-filter">
          <span>Categoria</span>
          <select value={activeFilter.category} onChange={(event) => updateCategory(event.target.value)}>
            <option value="all">Todas as categorias</option>
            {categories.map((category) => (
              <option value={category} key={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="memory-results-heading" aria-live="polite">
        <span>
          {filteredEntries.length}{' '}
          {filteredEntries.length === 1 ? 'resultado' : 'resultados'}
        </span>
        {(query || activeFilter.status !== 'all' || activeFilter.category !== 'all') && (
          <button
            className="memory-clear-button"
            type="button"
            onClick={() => {
              setQuery?.('');
              setFilter?.(
                filter && typeof filter === 'object'
                  ? { status: 'all', category: 'all' }
                  : 'all',
              );
            }}
          >
            Limpar filtros
          </button>
        )}
      </div>

      {filteredEntries.length > 0 ? (
        <ul className="memory-list">
          {filteredEntries.map((entry) => {
            const status = entryStatus(entry);
            const isRevoked = status === 'revogada';
            const version = readable(entry.version, '1').replace(/^v/i, '');

            return (
              <li className="memory-card" data-status={status} key={entry.id}>
                <article aria-labelledby={`memory-entry-${entry.id}`}>
                  <header className="memory-card-header">
                    <div className="memory-card-heading">
                      <span className="memory-category">
                        {readable(entry.category, 'Operação')}
                      </span>
                      <h2 id={`memory-entry-${entry.id}`}>{entryTitle(entry)}</h2>
                    </div>
                    <span className="memory-status" data-status={status}>
                      {status === 'temporária' ? (
                        <IconClockHour4 aria-hidden="true" />
                      ) : status === 'revogada' ? (
                        <IconHistory aria-hidden="true" />
                      ) : (
                        <IconShieldCheck aria-hidden="true" />
                      )}
                      {STATUS_LABELS[status] || status}
                    </span>
                  </header>

                  <p className="memory-rule-text">{entryText(entry)}</p>
                  <OwnerEvidence value={entry.evidenceQuote} />

                  {entry.effectivePolicy && entry.draft ? (
                    <section
                      className="memory-policy-comparison"
                      aria-label="Política efetiva e correção"
                    >
                      <div className="memory-policy-comparison-panel" data-kind="effective">
                        <h3>Política efetiva</h3>
                        <p>{entry.effectivePolicy.text}</p>
                        <p>{`Intenção efetiva: ${readable(entry.effectivePolicy.intent)}`}</p>
                        <p>{`Revisão de cobertura efetiva: ${readable(entry.effectivePolicy.coverageRevision)}`}</p>
                        <OwnerEvidence value={entry.effectivePolicy.evidenceQuote} />
                        {canonicalFieldRows(entry.effectivePolicy.canonicalFields).length > 0 ? (
                          <ul aria-label="Campos canônicos da política efetiva">
                            {canonicalFieldRows(entry.effectivePolicy.canonicalFields).map(([key, value]) => (
                              <li key={key}>{`${key}: ${value}`}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <div className="memory-policy-comparison-panel" data-kind="correction">
                        <h3>{`Correção ${entry.draft.status}`}</h3>
                        <p>{entry.draft.text}</p>
                        <p>{`Intenção da correção: ${readable(entry.draft.intent)}`}</p>
                        <p>{`Revisão de cobertura da correção: ${readable(entry.draft.coverageRevision)}`}</p>
                        <OwnerEvidence value={entry.draft.evidenceQuote} />
                        {canonicalFieldRows(entry.draft.canonicalFields).length > 0 ? (
                          <ul aria-label="Campos canônicos da correção">
                            {canonicalFieldRows(entry.draft.canonicalFields).map(([key, value]) => (
                              <li key={key}>{`${key}: ${value}`}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </section>
                  ) : null}

                  <dl className="memory-metadata">
                    <div>
                      <dt>Origem</dt>
                      <dd>{readable(entry.origin, 'Conversa com Rafael')}</dd>
                    </div>
                    <div>
                      <dt>Escopo</dt>
                      <dd>{readable(entry.scope, 'Geral')}</dd>
                    </div>
                    <div>
                      <dt>Versão</dt>
                      <dd>v{version}</dd>
                    </div>
                    <div>
                      <dt>Vigência</dt>
                      <dd>{displayDate(entry.validity || entry.effectiveFrom, 'Permanente')}</dd>
                    </div>
                    <div>
                      <dt>Aprovação</dt>
                      <dd>{readable(entry.approval || entry.approvedBy, status === 'sugerida' ? 'Aguardando aprovação' : 'Rafael')}</dd>
                    </div>
                    {entry.materializationIntent ? (
                      <div>
                        <dt>Intenção canônica</dt>
                        <dd>{entry.materializationIntent}</dd>
                      </div>
                    ) : null}
                    {Number.isSafeInteger(entry.coverageRevision) ? (
                      <div>
                        <dt>Revisão de cobertura</dt>
                        <dd>{entry.coverageRevision}</dd>
                      </div>
                    ) : null}
                    {typeof entry.structured?.price_target === 'number' ? (
                      <div>
                        <dt>Preço aplicado</dt>
                        <dd>
                          {typeof entry.structured?.price_min === 'number' && entry.structured.price_min !== entry.structured.price_target
                            ? `$${entry.structured.price_min} – $${entry.structured.price_target}`
                            : `Fixo: $${entry.structured.price_target}`}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {!entry.effectivePolicy && canonicalFieldRows(entry.canonicalFields).length > 0 ? (
                    <ul className="memory-canonical-fields" aria-label="Campos canônicos">
                      {canonicalFieldRows(entry.canonicalFields).map(([key, value]) => (
                        <li key={key}>{`${key}: ${value}`}</li>
                      ))}
                    </ul>
                  ) : null}

                  <footer className="memory-card-actions">
                    {status === 'sugerida' && onApproveSuggestion ? (
                      <button
                        className="memory-approve-button button button--primary"
                        type="button"
                        disabled={decisionBusy}
                        onClick={() => onApproveSuggestion(entry)}
                      >
                        <IconShieldCheck aria-hidden="true" />
                        Aprovar
                      </button>
                    ) : null}
                    {status === 'sugerida' && onRejectSuggestion ? (
                      <button
                        className="memory-reject-button"
                        type="button"
                        disabled={decisionBusy}
                        onClick={() => onRejectSuggestion(entry)}
                      >
                        Rejeitar
                      </button>
                    ) : null}
                    <button
                      className="memory-edit-button"
                      type="button"
                      onClick={() => onEdit?.(entry)}
                      disabled={isRevoked || decisionBusy}
                    >
                      <IconEdit aria-hidden="true" />
                      Editar regra
                    </button>
                    <button
                      className="memory-revoke-button"
                      type="button"
                      onClick={() => onRevoke?.(entry)}
                      disabled={isRevoked || decisionBusy}
                    >
                      <IconTrash aria-hidden="true" />
                      {isRevoked ? 'Regra revogada' : 'Apagar da memória'}
                    </button>
                  </footer>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="memory-empty" role="status">
          <IconSearch aria-hidden="true" />
          <h2>Nenhuma regra encontrada</h2>
          <p>Tente outro termo ou remova os filtros para ver toda a memória.</p>
        </div>
      )}
    </section>
  );
}
