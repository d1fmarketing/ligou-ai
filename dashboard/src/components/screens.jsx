// Presentational full-screen states shared by App and AppInner. No logic here:
// callers own retry/logout handlers and all copy that was already approved.
import { IconAlertTriangle, IconPlugConnected } from "@tabler/icons-react";

export function LoadingScreen({ children }) {
  return (
    <main className="loading-screen">
      <span className="loading-avatar">
        <img src={`${import.meta.env.BASE_URL}assets/ligou-avatar-v1.png`} alt="" width="64" height="64" />
      </span>
      <p>{children}</p>
    </main>
  );
}

export function ErrorScreen({ title, detail = null, children }) {
  return (
    <main className="error-screen">
      <IconAlertTriangle aria-hidden="true" />
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
      <div className="dialog-actions">{children}</div>
    </main>
  );
}

// Prototype mode has no Google session, so Poderes/Conta cannot show real
// data. An honest locked state beats the dead blank tab it replaces.
export function LockedView({ title, description }) {
  return (
    <section className="locked-view" aria-labelledby={`locked-${title}`}>
      <header className="view-header">
        <h1 id={`locked-${title}`}>{title}</h1>
        <p>{description}</p>
      </header>
      <div className="locked-note" role="status">
        <IconPlugConnected aria-hidden="true" />
        <p>
          <strong>Disponível com a conta Google conectada.</strong> Este protótipo
          usa dados de exemplo e não tem sessão real.
        </p>
      </div>
    </section>
  );
}
