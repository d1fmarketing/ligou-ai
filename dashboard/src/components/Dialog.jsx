import { useEffect, useId, useRef } from "react";
import { IconX } from "@tabler/icons-react";

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Dialog({ open, title, description, onClose, children, size = "medium" }) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // Guarda o gatilho E o caso a que ele pertencia: o botão Aprovar é o mesmo
    // nó DOM antes e depois de o card trocar de cliente (React reaproveita).
    const trigger = document.activeElement;
    returnFocusRef.current = { el: trigger, key: trigger?.dataset?.approvalId ?? null };
    const panel = panelRef.current;
    // Foco inicial no painel (tabIndex -1 + aria-labelledby/describedby): o
    // título e a consequência são anunciados antes de qualquer controle — não
    // o "Fechar" X. O primeiro Tab ainda cai no X (44px, primeiro do DOM).
    panel?.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll(FOCUSABLE)];
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      // Shift+Tab a partir do painel recém-focado também fecha o ciclo — sem
      // isso o foco vazaria para o app atrás do backdrop.
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("dialog-open");
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("dialog-open");
      // Devolve o foco ao gatilho SÓ se ele ainda é o mesmo controle do mesmo
      // caso (Ajustar mantém o caso pendente → volta ao próprio botão). Se o
      // card trocou de cliente ou desmontou, o foco vai à última confirmação
      // (.system-message, role=status) — nunca ao Aprovar de outro cliente.
      const { el, key } = returnFocusRef.current || {};
      const hadTrigger = el && el !== document.body && el.isConnected;
      if (hadTrigger && (el.dataset?.approvalId ?? null) === key) {
        el.focus?.();
      } else {
        const confirmation = [...document.querySelectorAll(".conversation .system-message")].at(-1);
        (confirmation || document.getElementById("main-content"))?.focus?.();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className={`dialog-panel dialog-panel--${size}`}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="dialog-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Fechar">
            <IconX aria-hidden="true" />
          </button>
        </div>
        <div className="dialog-content">{children}</div>
      </section>
    </div>
  );
}
