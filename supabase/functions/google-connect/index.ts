// Step 1 of "Connect Google Calendar": the owner clicks the button, we hand back the consent URL.
// Nothing is stored yet — only a single-use state tying the callback to this tenant.
// Deploy: supabase functions deploy google-connect --no-verify-jwt  (JWT verified explicitly below)
import { createClient } from "@supabase/supabase-js";
import { buildOAuthState } from "../_shared/oauth-state.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TENANT = Deno.env.get("LIGOU_TENANT") ?? "rocha-plumbing";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const redirect = Deno.env.get("GOOGLE_OAUTH_REDIRECT");   // .../functions/v1/google-callback
  if (!clientId || !redirect) {
    return Response.json({ error: "oauth_app_not_configured" }, { status: 503, headers: CORS });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SERVICE_KEY")!;
  const auth = req.headers.get("authorization") ?? "";
  const who = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: auth } });
  if (!who.ok) return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  const user = await who.json();

  const supa = createClient(url, key, { auth: { persistSession: false } });
  const { data: tenant } = await supa.from("tenants").select("id,owner_user_id").eq("slug", TENANT).single();
  if (!tenant || tenant.owner_user_id !== user.id) {
    return Response.json({ error: "not_tenant_owner" }, { status: 403, headers: CORS });
  }

  const oauthState = await buildOAuthState({
    stateId: crypto.randomUUID(),
    tenantId: tenant.id,
    userId: user.id,
    redirectUri: redirect,
  });
  const { error: stateError } = await supa.from("oauth_states").insert({
    state: oauthState.record.stateId,
    tenant_id: oauthState.record.tenantId,
    user_id: oauthState.record.userId,
    nonce_hash: oauthState.record.nonceHash,
    redirect_uri: oauthState.record.redirectUri,
    expires_at: oauthState.record.expiresAt,
  });
  if (stateError) {
    return Response.json({ error: "oauth_state_unavailable" }, { status: 503, headers: CORS });
  }

  const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consent.searchParams.set("client_id", clientId);
  consent.searchParams.set("redirect_uri", oauthState.record.redirectUri);
  consent.searchParams.set("response_type", "code");
  // narrowest scope that still lets us read free/busy and write the appointment
  consent.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
  consent.searchParams.set("access_type", "offline");
  consent.searchParams.set("prompt", "consent");   // force a refresh token even on re-connect
  consent.searchParams.set("state", oauthState.publicState);

  return Response.json({ url: consent.toString() }, { headers: CORS });
});
