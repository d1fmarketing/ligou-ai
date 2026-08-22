// Minimal M1 settings: the Google account card (safe metadata + logout) and the
// Calendar card (truthful connector state, free/busy proof, one deterministic
// test appointment). No ciphertext, nonce, key version, or token ever reaches
// this component — only the projected safe fields.
import { useCallback, useEffect, useState } from "react";
import {
  IconBrandGoogle,
  IconCalendarCheck,
  IconCalendarEvent,
  IconLogout,
  IconPlugConnected,
  IconRefresh,
} from "@tabler/icons-react";
import { supabase } from "../lib/supabase.js";
import { loadConnectorStatus, loadCalendarTestState } from "../data/connectors.js";
import { calendarScopesGranted, resolveFunctionsBase } from "../runtime-config.js";
import { signInWithGoogle } from "../auth/google.js";
import { RECONNECT_FLAG } from "../auth/bootstrap.js";

const STATUS_LABEL = {
  active: { label: "Conectada", tone: "ok" },
  reconnect_required: { label: "Reconexão necessária", tone: "warn" },
  revoked: { label: "Acesso revogado", tone: "danger" },
  error: { label: "Erro na conexão", tone: "danger" },
};

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "—";
  }
}

async function callCalendarTest(action, tenantId) {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error("Entre novamente para usar a agenda.");
  const base = resolveFunctionsBase(import.meta.env.VITE_SUPABASE_FUNCTIONS_URL, import.meta.env.VITE_SUPABASE_URL);
  const response = await fetch(`${base}/calendar-test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: tenantId, action }),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

export function SettingsView({ user, tenant, onToast, onLogout }) {
  const [connector, setConnector] = useState(null);
  const [testState, setTestState] = useState(null);
  const [busy, setBusy] = useState("");
  const [freeBusy, setFreeBusy] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [status, test] = await Promise.all([
        loadConnectorStatus(supabase, tenant.id),
        loadCalendarTestState(supabase, tenant.id),
      ]);
      setConnector(status);
      setTestState(test);
    } catch {
      onToast({ kind: "warning", text: "Não foi possível carregar o estado da agenda." });
    }
  }, [tenant.id, onToast]);

  useEffect(() => { refresh(); }, [refresh]);

  const reconnect = async () => {
    setBusy("reconnect");
    try {
      window.sessionStorage.setItem(RECONNECT_FLAG, "1");
      const { error } = await signInWithGoogle(supabase, {
        origin: window.location.origin,
        baseUrl: import.meta.env.BASE_URL,
        withConsent: true,
      });
      if (error) throw error;
    } catch {
      window.sessionStorage.removeItem(RECONNECT_FLAG);
      setBusy("");
      onToast({ kind: "warning", text: "Não foi possível abrir o Google para reconectar." });
    }
  };

  const testAvailability = async () => {
    setBusy("freebusy");
    try {
      const { ok, body } = await callCalendarTest("freebusy", tenant.id);
      if (!ok) {
        setFreeBusy(null);
        onToast({ kind: "warning", text: `A agenda não respondeu: ${body?.error ?? "erro"}.` });
      } else {
        setFreeBusy(body);
        onToast({ kind: "success", text: `Disponibilidade lida: ${body.busy_count} compromisso(s) nos próximos 7 dias.` });
      }
    } catch {
      onToast({ kind: "warning", text: "Falha ao consultar a disponibilidade." });
    } finally {
      setBusy("");
      refresh();
    }
  };

  const createTestEvent = async () => {
    setBusy("test-event");
    try {
      const { ok, body } = await callCalendarTest("test_event", tenant.id);
      if (!ok) {
        onToast({ kind: "warning", text: `O teste não foi aceito: ${body?.error ?? body?.detail ?? "erro"}.` });
      } else if (body.outcome === "accepted") {
        onToast({ kind: "success", text: body.reused ? "O compromisso de teste já existia e foi verificado." : "Compromisso de teste criado e verificado na sua agenda." });
      } else {
        onToast({ kind: "warning", text: `Teste em estado ${body.outcome}: ${body.detail ?? body.mismatch ?? ""}` });
      }
    } catch {
      onToast({ kind: "warning", text: "Falha ao criar o compromisso de teste." });
    } finally {
      setBusy("");
      refresh();
    }
  };

  const status = STATUS_LABEL[connector?.status] ?? { label: "Não conectada", tone: "warn" };
  const scopesOk = calendarScopesGranted(connector?.scopes);
  const meta = user?.user_metadata ?? {};

  return (
    <section className="settings-view">
      <header className="view-header">
        <h1>Conta</h1>
        <p>Sua conta Google e a conexão com a agenda.</p>
      </header>

      <article className="settings-card" aria-label="Conta Google">
        <div className="settings-card-head">
          <IconBrandGoogle aria-hidden="true" />
          <h2>Conta Google</h2>
          <span className="status-pill status-pill--ok">Autenticado</span>
        </div>
        <div className="account-row">
          {meta.avatar_url || meta.picture ? (
            <img className="account-avatar" src={meta.avatar_url || meta.picture} alt="" referrerPolicy="no-referrer" />
          ) : null}
          <div>
            <strong>{meta.name || meta.full_name || user?.email || "Conta Google"}</strong>
            <p>{user?.email ?? "—"}</p>
          </div>
        </div>
        <dl className="settings-meta">
          <div><dt>Empresa</dt><dd>{tenant.name}</dd></div>
          <div><dt>Fuso horário</dt><dd>{tenant.timezone}</dd></div>
          <div><dt>Modo</dt><dd>{tenant.operational_mode === "simulation_only" ? "Simulação (sem poderes de agendamento)" : tenant.operational_mode}</dd></div>
        </dl>
        <div className="settings-actions">
          <button className="button button--ghost" type="button" onClick={onLogout}>
            <IconLogout aria-hidden="true" /> Sair
          </button>
        </div>
      </article>

      <article className="settings-card" aria-label="Google Calendar">
        <div className="settings-card-head">
          <IconCalendarEvent aria-hidden="true" />
          <h2>Google Calendar</h2>
          <span className={`status-pill status-pill--${status.tone}`}>{status.label}</span>
        </div>
        <dl className="settings-meta">
          <div><dt>Conta</dt><dd>{connector?.account_email ?? "—"}</dd></div>
          <div><dt>Permissões de agenda</dt><dd>{connector ? (scopesOk ? "Concedidas" : "Incompletas") : "—"}</dd></div>
          <div><dt>Último acesso com sucesso</dt><dd>{fmtDateTime(connector?.last_success_at)}</dd></div>
          <div><dt>Último teste</dt><dd>
            {testState?.outcome === "accepted"
              ? `Aceito com verificação em ${fmtDateTime(testState.accepted_at)}`
              : testState?.outcome
                ? `Estado: ${testState.outcome}`
                : "Nunca executado"}
          </dd></div>
        </dl>
        {freeBusy ? (
          <p className="settings-note">
            Janela {fmtDateTime(freeBusy.time_min)} → {fmtDateTime(freeBusy.time_max)}: {freeBusy.busy_count} ocupação(ões) na agenda {freeBusy.calendar_id}.
          </p>
        ) : null}
        {testState?.outcome === "accepted" && testState.readback_summary ? (
          <p className="settings-note">
            Recibo: “{testState.readback_summary}” de {fmtDateTime(testState.readback_start_iso)} a {fmtDateTime(testState.readback_end_iso)}.
          </p>
        ) : null}
        {testState?.last_error ? <p className="settings-note settings-note--warn">Último erro: {testState.last_error}</p> : null}
        <div className="settings-actions">
          <button className="button button--ghost" type="button" onClick={reconnect} disabled={busy !== ""}>
            <IconPlugConnected aria-hidden="true" /> {busy === "reconnect" ? "Abrindo o Google…" : "Reconectar"}
          </button>
          <button className="button button--ghost" type="button" onClick={testAvailability} disabled={busy !== "" || connector?.status !== "active"}>
            <IconRefresh aria-hidden="true" /> {busy === "freebusy" ? "Consultando…" : "Testar disponibilidade"}
          </button>
          <button className="button button--primary" type="button" onClick={createTestEvent} disabled={busy !== "" || connector?.status !== "active"}>
            <IconCalendarCheck aria-hidden="true" /> {busy === "test-event" ? "Criando…" : "Criar compromisso de teste"}
          </button>
        </div>
      </article>
    </section>
  );
}
