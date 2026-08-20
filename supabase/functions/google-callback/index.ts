// Google OAuth callback. The callback carries no user JWT: authority comes from the authenticated start
// binding plus the atomic, short-lived, one-time state proof consumed below.
// Deploy: supabase functions deploy google-callback --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";
import { encryptConnectorToken } from "../_shared/connector-crypto.ts";
import { renderCallbackPage } from "../_shared/callback-page.ts";
import { parseOAuthState } from "../_shared/oauth-state.ts";

function page(title: string, body: string, ok = true): Response {
  return new Response(renderCallbackPage({
    title,
    body,
    ok,
    returnUrl: Deno.env.get("LIGOU_DASHBOARD_URL") ?? "/",
  }), {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function safeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(trimmed) ? trimmed.slice(0, 254) : null;
}

Deno.serve(async (req) => {
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code");
  const publicState = requestUrl.searchParams.get("state");
  if (requestUrl.searchParams.has("error")) {
    return page("Conexão cancelada", "Nenhuma agenda foi conectada.", false);
  }
  if (!code || !publicState) return page("Link inválido", "Faltam parâmetros da conexão.", false);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SERVICE_KEY");
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  const configuredRedirect = Deno.env.get("GOOGLE_OAUTH_REDIRECT");
  const encryptionKey = Deno.env.get("CONNECTOR_TOKEN_ENCRYPTION_KEY");
  if (!supabaseUrl || !serviceKey || !clientId || !clientSecret || !configuredRedirect || !encryptionKey) {
    return page("Conexão indisponível", "A configuração segura da agenda está incompleta.", false);
  }

  let proof;
  try {
    proof = await parseOAuthState(publicState, configuredRedirect);
  } catch {
    return page("Link expirado", "Peça a conexão novamente no painel.", false);
  }

  const supa = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: consumed, error: consumeError } = await supa.rpc("consume_oauth_state", {
    p_state: proof.stateId,
    p_nonce_hash: proof.nonceHash,
    p_tenant: proof.tenantId,
    p_user: proof.userId,
    p_redirect: proof.redirectUri,
  }).single();
  const consumedState = consumed as { tenant_id?: string; user_id?: string; redirect_uri?: string } | null;
  if (consumeError || !consumedState
    || consumedState.tenant_id !== proof.tenantId
    || consumedState.user_id !== proof.userId
    || consumedState.redirect_uri !== proof.redirectUri) {
    return page("Link expirado", "Peça a conexão novamente no painel.", false);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: proof.redirectUri,
      grant_type: "authorization_code",
    }),
  }).catch(() => null);
  if (!tokenResponse?.ok) {
    return page("Não deu para conectar", "O Google não concluiu a autorização. Tente novamente.", false);
  }

  const tokenBody = await tokenResponse.json().catch(() => null) as Record<string, unknown> | null;
  const refreshToken = typeof tokenBody?.refresh_token === "string"
    ? tokenBody.refresh_token.slice(0, 16_384)
    : "";
  const accessToken = typeof tokenBody?.access_token === "string"
    ? tokenBody.access_token.slice(0, 16_384)
    : "";
  if (!refreshToken) {
    return page("Faltou a permissão contínua", "O Google não devolveu acesso permanente. Tente de novo.", false);
  }

  let email: string | null = null;
  if (accessToken) {
    try {
      const identity = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (identity.ok) email = safeEmail((await identity.json()).email);
    } catch {
      // Identity metadata is cosmetic. Token storage remains bound to a non-secret account reference.
    }
  }
  const accountRef = email ?? "google-calendar-primary";
  let wire;
  try {
    wire = await encryptConnectorToken(refreshToken, {
      tenantId: proof.tenantId,
      provider: "google_calendar",
      accountRef,
      keyVersion: 1,
    }, encryptionKey);
  } catch {
    return page("Conexão indisponível", "Não foi possível proteger a credencial da agenda.", false);
  }

  const now = new Date().toISOString();
  const { error: storeError } = await supa.from("connector_accounts").upsert({
    tenant_id: proof.tenantId,
    provider: "google_calendar",
    refresh_token: null,
    refresh_token_ciphertext: wire.ciphertext,
    refresh_token_iv: wire.iv,
    token_key_version: wire.keyVersion,
    token_account_ref: accountRef,
    calendar_id: "primary",
    account_email: email,
    scopes: typeof tokenBody?.scope === "string" ? tokenBody.scope.slice(0, 2_000) : null,
    status: "active",
    last_error: null,
    connected_at: now,
    updated_at: now,
  }, { onConflict: "tenant_id,provider" });
  if (storeError) {
    return page("Conexão indisponível", "Não foi possível salvar a conexão com segurança.", false);
  }

  return page("Agenda conectada", email
    ? `O Ligou agora usa ${email} para consultar horários e marcar serviços.`
    : "O Ligou agora usa sua agenda do Google para consultar horários e marcar serviços.");
});
