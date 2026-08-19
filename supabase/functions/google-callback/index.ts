// Step 2 of "Connect Google Calendar": Google redirects the owner back here with a code.
// We exchange it for a refresh token, store it against the tenant, and show a plain confirmation page.
// The token never travels to the browser.
// Deploy: supabase functions deploy google-callback --no-verify-jwt   (Google calls this, not the app)
import { createClient } from "npm:@supabase/supabase-js@2";

const page = (title: string, body: string, ok = true) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#faf9f7;color:#1c1917}` +
    `.c{max-width:28rem;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 1px 3px #0001;text-align:center}` +
    `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#57534e;line-height:1.5}` +
    `.b{display:inline-block;margin-top:1rem;padding:.6rem 1rem;border-radius:.6rem;background:#e2703a;color:#fff;text-decoration:none}</style>` +
    `<div class="c"><h1>${ok ? "✅" : "⚠️"} ${title}</h1><p>${body}</p>` +
    `<a class="b" href="${Deno.env.get("LIGOU_DASHBOARD_URL") ?? "/"}">Voltar ao painel</a></div>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (u.searchParams.get("error")) return page("Conexão cancelada", "Nenhuma agenda foi conectada.", false);
  if (!code || !state) return page("Link inválido", "Faltam parâmetros do Google.", false);

  const url = Deno.env.get("SUPABASE_URL")!;
  const supa = createClient(url, Deno.env.get("SERVICE_KEY")!, { auth: { persistSession: false } });

  // single-use state
  const { data: st } = await supa.from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state).is("consumed_at", null).select("tenant_id").maybeSingle();
  if (!st) return page("Link expirado", "Peça a conexão novamente no painel.", false);

  const body = new URLSearchParams({
    code,
    client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!,
    client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!,
    redirect_uri: Deno.env.get("GOOGLE_OAUTH_REDIRECT")!,
    grant_type: "authorization_code",
  });
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!tok.ok) return page("Não deu para conectar", `O Google recusou a troca (${tok.status}).`, false);
  const t = await tok.json();
  if (!t.refresh_token) {
    return page("Faltou a permissão contínua", "O Google não devolveu acesso permanente. Tente de novo.", false);
  }

  // whose calendar is it? (nice to show in the dashboard)
  let email: string | null = null;
  try {
    const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (me.ok) email = (await me.json()).email ?? null;
  } catch { /* cosmetic only */ }

  await supa.from("connector_accounts").upsert({
    tenant_id: st.tenant_id,
    provider: "google_calendar",
    refresh_token: t.refresh_token,
    calendar_id: "primary",
    account_email: email,
    scopes: t.scope ?? null,
    status: "active",
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,provider" });

  return page("Agenda conectada", `O Ligou agora usa ${email ?? "sua agenda do Google"} para ver horários e marcar serviços.`);
});
