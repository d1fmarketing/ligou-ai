import { useCallback, useEffect, useState } from "react";
import { IconCalendarCheck, IconCalendarPlus } from "@tabler/icons-react";
import { supabase } from "../lib/supabase.js";
import { loadConnectorStatus } from "../data/connectors.js";

const FN = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL || "";

// "Connect Google Calendar" — the whole customer-facing setup (docs/CLIENTE-CALENDARIO.md, Caso A).
// One click, Google's own consent screen, done. Until the owner connects, the Ligou-managed calendar
// (Caso B) keeps working, so nobody is ever blocked on this.
export function CalendarConnection({ onToast }) {
  const [status, setStatus] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus((await loadConnectorStatus(supabase)) ?? false);
    } catch {
      setStatus(false);
      onToast?.({ kind: "warning", text: "Não foi possível verificar a conexão da agenda." });
    }
  }, [onToast]);

  useEffect(() => { load(); }, [load]);

  async function connect() {
    setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (!sess?.session?.access_token) throw new Error("Entre novamente para conectar a agenda.");
      const res = await fetch(`${FN}/google-connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.session.access_token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error === "oauth_app_not_configured"
        ? "O app do Google ainda não foi configurado pela Ligou."
        : body.error ?? "Falha ao iniciar a conexão");
      window.location.href = body.url; // Google's consent screen
    } catch (e) {
      onToast?.({ kind: "warning", text: e.message });
      setBusy(false);
    }
  }

  if (status === null) return null;

  return (
    <section className="calendar-connection">
      <h2>Agenda</h2>
      {status ? (
        <p className="calendar-connected">
          <IconCalendarCheck aria-hidden="true" /> Conectada
          {status.account_email ? <> — <strong>{status.account_email}</strong></> : null}
          <span className="calendar-note">O Ligou consulta e marca nessa agenda.</span>
        </p>
      ) : (
        <>
          <p className="calendar-note">
            Hoje o Ligou usa a agenda que criamos para você. Se preferir que ele use a <strong>sua</strong> agenda
            do Google, conecte abaixo — leva alguns segundos.
          </p>
          <button type="button" className="calendar-connect" onClick={connect} disabled={busy}>
            <IconCalendarPlus aria-hidden="true" /> {busy ? "Abrindo o Google…" : "Conectar Google Calendar"}
          </button>
        </>
      )}
    </section>
  );
}
