import { useState } from "react";
import { supabase } from "../lib/supabase.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
        <img src="/assets/ligou-avatar-head.png" alt="" width="56" height="56" />
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
