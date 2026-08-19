import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";

// TEST MODE (RJ, 2026-08-19): while testing, the login screen is skipped. The password is NEVER in this
// bundle — it travels only in the link RJ keeps (#k=...), like a permanent magic link, and is stashed in
// sessionStorage so reloads survive. Re-enabling real login later = republish without VITE_TEST_AUTOLOGIN_EMAIL.
const TEST_EMAIL = import.meta.env.VITE_TEST_AUTOLOGIN_EMAIL;
function testPassword() {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("k");
  if (fromHash) {
    sessionStorage.setItem("ligou.test.k", fromHash);
    history.replaceState(null, "", window.location.pathname); // keep the secret out of the address bar
    return fromHash;
  }
  return sessionStorage.getItem("ligou.test.k");
}
const TEST_PASSWORD = TEST_EMAIL ? testPassword() : null;

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (TEST_EMAIL && TEST_PASSWORD) {
      setBusy(true);
      supabase.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .then(({ error: err }) => { if (err) { setError(`Modo teste: ${err.message}`); setBusy(false); } });
    }
  }, []);

  if (TEST_EMAIL) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <img src={`${import.meta.env.BASE_URL}assets/ligou-avatar-head.png`} alt="" width="56" height="56" />
          <h1>Ligou · Painel</h1>
          <p>{error ?? (TEST_PASSWORD ? "Entrando (modo teste)…" : "Modo teste: abra o link completo que a Isa te passou (com #k=…).")}</p>
        </div>
      </div>
    );
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (err) setError(err.message);
    else setSent(true);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src={`${import.meta.env.BASE_URL}assets/ligou-avatar-head.png`} alt="" width="56" height="56" />
        <h1>Ligou · Painel</h1>
        {sent ? (
          <p>Link enviado para <strong>{email}</strong>. Abra o e-mail neste dispositivo para entrar.</p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="login-email">Seu e-mail</label>
            <input id="login-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@empresa.com" />
            <button type="submit" disabled={busy}>{busy ? "Enviando…" : "Entrar com link mágico"}</button>
            {error ? <p className="login-error">{error}</p> : null}
          </form>
        )}
      </div>
    </div>
  );
}
