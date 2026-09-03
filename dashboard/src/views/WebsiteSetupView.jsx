import { useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconWorldSearch,
} from "@tabler/icons-react";
import { validateWebsiteUrl } from "../website-setup-model.js";

const PROGRESS = [
  { id: "fetching", label: "Lendo o website" },
  { id: "analyzing", label: "Organizando as informações" },
  { id: "ready_for_onboarding", label: "Preparando o onboarding" },
];

function progressRank(stage) {
  if (stage === "ready_for_onboarding") return 3;
  if (stage === "analyzing") return 2;
  if (stage === "fetching" || stage === "queued") return 1;
  return 0;
}

function WebsiteForm({ initialUrl = "", busy, disabled = false, onSubmit }) {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState("");
  const blocked = busy || disabled;
  return (
    <form className="website-setup-form" onSubmit={async (event) => {
      event.preventDefault();
      if (blocked || !onSubmit) return;
      setError("");
      try {
        await onSubmit(validateWebsiteUrl(url));
      } catch (caught) {
        setError(caught?.message || "Não foi possível iniciar a análise.");
      }
    }}>
      <label htmlFor="company-website">Website da empresa</label>
      <div className="website-setup-input-row">
        <input
          id="company-website"
          name="website"
          type="url"
          inputMode="url"
          placeholder="https://suaempresa.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          autoComplete="url"
          required
          disabled={blocked}
        />
        <button className="button button--primary" type="submit" disabled={blocked}>
          {busy ? "Iniciando…" : "Conhecer minha empresa"}
        </button>
      </div>
      {error ? <p className="website-setup-error" role="alert">{error}</p> : null}
    </form>
  );
}

function SetupReadWarning({ message }) {
  return message ? <p className="website-setup-refresh-warning" role="status">{message}</p> : null;
}

export function WebsiteSetupView({
  setup,
  busy = false,
  loadError = null,
  onSubmit,
  onRetry,
  onStartOnboarding,
}) {
  const state = setup?.state;
  if (state === "payment_pending") {
    return (
      <main className="website-setup-shell" id="main-content">
        <section className="website-setup-card">
          <span className="website-setup-kicker">Configuração</span>
          <h1>Seu acesso ao setup ainda não está disponível</h1>
          <SetupReadWarning message={loadError} />
          <p>Assim que sua conta estiver liberada, você poderá apresentar sua empresa ao Ligou.</p>
        </section>
      </main>
    );
  }
  if (state === "onboarding_complete") return null;
  if (state === "onboarding_in_progress") {
    return (
      <main className="website-setup-shell" id="main-content">
        <section className="website-setup-card">
          <span className="website-setup-kicker">Onboarding</span>
          <h1>Seu onboarding está em andamento</h1>
          <SetupReadWarning message={loadError} />
          <p>Continue de onde parou para concluir as regras da sua empresa.</p>
          <button className="button button--primary" type="button" onClick={onStartOnboarding}>
            Continuar onboarding
          </button>
        </section>
      </main>
    );
  }
  if (state === "learning") {
    const currentRank = progressRank(setup.job?.processingStage);
    return (
      <main className="website-setup-shell" id="main-content">
        <section className="website-setup-card website-setup-card--learning" aria-live="polite">
          <IconWorldSearch className="website-setup-hero-icon" aria-hidden="true" />
          <span className="website-setup-kicker">Preparando sua empresa</span>
          <h1>O Ligou está conhecendo sua empresa</h1>
          <SetupReadWarning message={loadError} />
          <p>Você pode sair desta página. O progresso continuará salvo.</p>
          <ol className="website-setup-progress">
            {PROGRESS.map((item, index) => {
              const rank = index + 1;
              const done = currentRank > rank;
              const active = currentRank === rank;
              return (
                <li className={done ? "is-done" : active ? "is-active" : ""} key={item.id}>
                  {done ? <IconCheck aria-hidden="true" /> : active
                    ? <IconLoader2 className="is-spinning" aria-hidden="true" />
                    : <span aria-hidden="true" />}
                  <strong>{item.label}</strong>
                </li>
              );
            })}
          </ol>
          <button className="button button--primary" type="button" disabled>
            Começar onboarding
          </button>
        </section>
      </main>
    );
  }
  if (state === "learning_failed") {
    return (
      <main className="website-setup-shell" id="main-content">
        <section className="website-setup-card">
          <IconAlertTriangle className="website-setup-hero-icon is-warning" aria-hidden="true" />
          <span className="website-setup-kicker">Não foi possível concluir</span>
          <h1>Vamos tentar novamente</h1>
          <SetupReadWarning message={loadError} />
          <p>{setup.failureMessage}</p>
          <div className="website-setup-actions">
            <button className="button button--primary" type="button" disabled={busy || !setup.canStart} onClick={onRetry}>
              {busy ? "Tentando…" : "Tentar novamente"}
            </button>
          </div>
          <WebsiteForm
            initialUrl={setup.job?.normalizedOrigin || ""}
            busy={busy}
            disabled={!setup.canStart}
            onSubmit={onSubmit}
          />
        </section>
      </main>
    );
  }
  if (state === "ready_for_onboarding") {
    const summary = setup.summary;
    return (
      <main className="website-setup-shell" id="main-content">
        <section className="website-setup-card website-setup-card--ready">
          <IconCheck className="website-setup-hero-icon is-ready" aria-hidden="true" />
          <span className="website-setup-kicker">Análise concluída</span>
          <h1>O Ligou já conhece o básico da sua empresa</h1>
          <SetupReadWarning message={loadError} />
          <p>Agora vamos confirmar alguns pontos e completar somente o que ainda falta.</p>
          <dl className="website-setup-summary">
            <div><dt>Empresa</dt><dd>{summary.companyName || "A confirmar"}</dd></div>
            <div><dt>Páginas</dt><dd>{summary.pagesAnalyzed} páginas analisadas</dd></div>
            <div><dt>Informações</dt><dd>{summary.claimsFound} encontradas</dd></div>
            <div><dt>Confirmações</dt><dd>{summary.questionsRemaining} pontos restantes</dd></div>
          </dl>
          {summary.services.length ? (
            <div className="website-setup-services">
              <strong>Serviços encontrados</strong>
              <p>{summary.services.join(" · ")}</p>
            </div>
          ) : (
            <p>Analisamos seu site, mas precisamos confirmar mais informações durante o onboarding.</p>
          )}
          <button
            className="button button--primary website-setup-start"
            type="button"
            disabled={busy || !setup.startOnboardingEnabled}
            onClick={onStartOnboarding}
          >
            Começar onboarding
          </button>
        </section>
      </main>
    );
  }
  return (
    <main className="website-setup-shell" id="main-content">
      <section className="website-setup-card">
        <IconWorldSearch className="website-setup-hero-icon" aria-hidden="true" />
        <span className="website-setup-kicker">Primeiro passo</span>
        <h1>Vamos conhecer sua empresa</h1>
        <SetupReadWarning message={loadError} />
        <p>Cole o endereço do site da sua empresa. O Ligou vai analisar as informações públicas antes de começar o onboarding.</p>
        <WebsiteForm busy={busy} disabled={!setup.canStart} onSubmit={onSubmit} />
      </section>
    </main>
  );
}
