import { useEffect, useRef, useState } from "react";
import {
  IconBrain,
  IconShieldBolt,
  IconChevronDown,
  IconCircleCheck,
  IconRefresh,
  IconRobot,
  IconUserCircle,
} from "@tabler/icons-react";

const destinations = [
  { id: "ligou", label: "Ligou", icon: IconRobot },
  { id: "memoria", label: "Memória", icon: IconBrain },
  { id: "aprovacoes", label: "Aprovações", icon: IconCircleCheck },
  { id: "poderes", label: "Poderes", icon: IconShieldBolt },
];

function Brand() {
  return (
    <div className="brand-lockup" aria-label="Ligou">
      <img src={`${import.meta.env.BASE_URL}assets/agent-node-mark.svg`} alt="" />
      <strong>Ligou</strong>
    </div>
  );
}

function DestinationLink({ destination, active, pendingCount }) {
  const Icon = destination.icon;
  const badge = destination.id === "aprovacoes" && pendingCount > 0;

  return (
    <a
      className={`destination-link ${active ? "is-active" : ""}`}
      href={`#${destination.id}`}
      aria-current={active ? "page" : undefined}
    >
      <span className="destination-icon">
        {destination.id === "ligou" ? (
          <img
            className="destination-brand-mark"
            src={`${import.meta.env.BASE_URL}assets/agent-node-mark.svg`}
            alt=""
          />
        ) : (
          <Icon aria-hidden="true" />
        )}
        {badge ? <span className="nav-badge" aria-label={`${pendingCount} aprovações pendentes`}>{pendingCount}</span> : null}
      </span>
      <span>{destination.label}</span>
    </a>
  );
}

export function AppShell({ route, pendingCount, business, onReset, children, inspector }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);

  useEffect(() => {
    if (!profileOpen) return undefined;
    const close = (event) => {
      if (event.key === "Escape" || !profileRef.current?.contains(event.target)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [profileOpen]);

  return (
    <div className={`app-shell ${inspector ? "has-inspector" : ""}`}>
      <header className="mobile-header">
        <Brand />
        <div className="business-compact">
          <strong>{business?.name || "Costa Home Services"}</strong>
          <span>{business?.owner || "Rafael"} · Proprietário</span>
        </div>
        <div className="profile-menu" ref={profileRef}>
          <button
            className="profile-button"
            type="button"
            aria-label="Menu do perfil"
            aria-expanded={profileOpen}
            aria-controls="profile-menu-panel"
            onClick={() => setProfileOpen((value) => !value)}
          >
            <IconUserCircle aria-hidden="true" />
            <IconChevronDown aria-hidden="true" />
          </button>
          {profileOpen ? (
            <div className="profile-menu-panel" id="profile-menu-panel">
              <strong>{business?.name || "Costa Home Services"}</strong>
              <span>Dados salvos somente neste navegador.</span>
              <button type="button" onClick={() => { setProfileOpen(false); onReset(); }}>
                <IconRefresh aria-hidden="true" /> Restaurar demonstração
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <aside className="sidebar" aria-label="Navegação principal">
        <div className="sidebar-top">
          <Brand />
          <div className="business-card">
            <span>Empresa</span>
            <strong>{business?.name || "Costa Home Services"}</strong>
            <small>{business?.owner || "Rafael"} · Proprietário</small>
          </div>
          <nav className="desktop-nav">
            {destinations.map((destination) => (
              <DestinationLink
                key={destination.id}
                destination={destination}
                active={route === destination.id}
                pendingCount={pendingCount}
              />
            ))}
          </nav>
        </div>
        <button className="reset-button" type="button" onClick={onReset}>
          <IconRefresh aria-hidden="true" />
          <span>Restaurar demonstração</span>
        </button>
      </aside>

      <main className="workspace" id="main-content">
        {children}
      </main>

      {inspector ? <aside className="context-inspector" aria-label="Contexto atual">{inspector}</aside> : null}

      <nav className="bottom-nav" aria-label="Navegação principal">
        {destinations.map((destination) => (
          <DestinationLink
            key={destination.id}
            destination={destination}
            active={route === destination.id}
            pendingCount={pendingCount}
          />
        ))}
      </nav>
    </div>
  );
}
