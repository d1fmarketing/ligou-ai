// Login: exactly one path — Continue with Google. No password, no magic link,
// no code entry. Terms/Privacy links are omitted until real pages exist.
import { useState } from "react";
import { supabase } from "../lib/supabase.js";
import { signInWithGoogle } from "./google.js";

function GoogleMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86a5.4 5.4 0 0 1-5.07-3.71H.93v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.93 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.93a9 9 0 0 0 0 8.08l3-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .93 4.96l3 2.33A5.4 5.4 0 0 1 9 3.58Z" />
    </svg>
  );
}

export function Login() {
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState("");

  const start = async () => {
    setBusy(true);
    setWarning("");
    try {
      const { error } = await signInWithGoogle(supabase, {
        origin: window.location.origin,
        baseUrl: import.meta.env.BASE_URL,
      });
      if (error) throw error;
      // Success navigates the page to Google; no further state here.
    } catch (error) {
      setBusy(false);
      setWarning(error?.message ? "Não foi possível iniciar o login com o Google. Tente novamente." : "");
    }
  };

  return (
    <main className="login-screen">
      <div className="login-card">
        <img src={`${import.meta.env.BASE_URL}assets/ligou-avatar-v1.png`} alt="" width="72" height="72" />
        <h1>Painel do Ligou</h1>
        <p className="login-lead">Entre com a sua conta Google. O Ligou usa a sua agenda do Google Calendar para trabalhar de verdade.</p>
        <button className="button-google" type="button" onClick={start} disabled={busy}>
          <GoogleMark />
          {busy ? "Abrindo o Google…" : "Continuar com Google"}
        </button>
        {warning ? <p className="login-error" role="alert">{warning}</p> : null}
      </div>
    </main>
  );
}
