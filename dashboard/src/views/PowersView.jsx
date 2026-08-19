import { useCallback, useEffect, useState } from "react";
import { IconShieldCheck, IconShieldOff } from "@tabler/icons-react";
import { supabase } from "../lib/supabase.js";

// Powers ledger: the owner GRANTS powers, not per-action approvals. Colors are derived language over granular grants.
const COLOR = (p) => {
  if (p.subject === "hermes") return { tag: "VERDE", cls: "power-verde" };
  if (p.capability === "create_booking") return { tag: "AZUL", cls: "power-azul" };
  return { tag: "AZUL", cls: "power-azul" };
};

export function PowersView({ onToast }) {
  const [powers, setPowers] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("powers")
      .select("*")
      .order("granted_at", { ascending: true });
    if (error) onToast?.({ kind: "warning", text: error.message });
    setPowers(data ?? []);
  }, [onToast]);

  useEffect(() => { load(); }, [load]);

  async function revoke(power) {
    setBusy(power.id);
    const { error } = await supabase.rpc("revoke_power", { p_power: power.id });
    setBusy(null);
    if (error) return onToast?.({ kind: "warning", text: error.message });
    onToast?.({ kind: "success", text: `Poder revogado. Tokens ativos foram invalidados (auth_epoch avançou).` });
    load();
  }

  async function regrant(power) {
    setBusy(power.id);
    const { error } = await supabase.rpc("grant_power", {
      p_tenant: power.tenant_id,
      p_subject: power.subject,
      p_capability: power.capability,
      p_resource: power.resource,
      p_conditions: power.conditions ?? {},
      p_monetary_limit: power.monetary_limit,
      p_expires: null,
    });
    setBusy(null);
    if (error) return onToast?.({ kind: "warning", text: error.message });
    onToast?.({ kind: "success", text: "Poder concedido novamente." });
    load();
  }

  if (powers === null) return <section className="powers-view"><p>Carregando poderes…</p></section>;

  const active = powers.filter((p) => !p.revoked_at);
  const revoked = powers.filter((p) => p.revoked_at);

  return (
    <section className="powers-view">
      <header className="view-header">
        <h1>Poderes</h1>
        <p>Você concede poderes, não aprova cada ação. O Ligou age sozinho dentro do que está concedido; fora disso, abre um caso para você.</p>
      </header>
      <div className="powers-list">
        {active.map((p) => {
          const c = COLOR(p);
          return (
            <article key={p.id} className={`power-card ${c.cls}`}>
              <div className="power-head">
                <span className={`power-tag ${c.cls}`}>{c.tag}</span>
                <strong>{p.subject === "hermes" ? "Cérebro (Hermes)" : "Atendente de voz"}</strong>
              </div>
              <p className="power-desc">
                {p.capability === "create_booking" ? `Agendar ${p.resource}` : `${p.capability} · ${p.resource}`}
                {p.monetary_limit != null ? ` — até $${p.monetary_limit}` : ""}
              </p>
              {p.conditions?.geography ? <p className="power-cond">Área: {p.conditions.geography.join(", ")}</p> : null}
              <button type="button" className="button button--danger" disabled={busy === p.id} onClick={() => revoke(p)}>
                <IconShieldOff aria-hidden="true" /> Revogar
              </button>
            </article>
          );
        })}
        {active.length === 0 ? <p>Nenhum poder ativo — o agente só responde perguntas e abre casos.</p> : null}
      </div>
      {revoked.length > 0 ? (
        <details className="powers-revoked">
          <summary>{revoked.length} poder(es) revogado(s)</summary>
          {revoked.map((p) => (
            <article key={p.id} className="power-card is-revoked">
              <p className="power-desc">{p.capability} · {p.resource}{p.monetary_limit != null ? ` — até $${p.monetary_limit}` : ""}</p>
              <button type="button" className="button button--ghost" disabled={busy === p.id} onClick={() => regrant(p)}>
                <IconShieldCheck aria-hidden="true" /> Conceder de novo
              </button>
            </article>
          ))}
        </details>
      ) : null}
    </section>
  );
}
