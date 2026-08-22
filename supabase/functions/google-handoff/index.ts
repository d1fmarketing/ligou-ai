// One-time custody handoff of the Google provider tokens obtained by the
// Supabase Auth PKCE login. The browser sends the tokens exactly once, bound to a
// single-use handoff intent; this function verifies the caller, the tenant, the
// provider identity and scopes, encrypts the refresh token with the AES-GCM
// connector envelope, proves decryption, and discards the raw material.
// Provider tokens never appear in responses, logs, or error messages.
// Deploy: supabase functions deploy google-handoff --no-verify-jwt   (JWT verified explicitly)
import { createClient } from "@supabase/supabase-js";
import { decryptConnectorToken, encryptConnectorToken } from "../_shared/connector-crypto.ts";
import {
  decideConnectorTransition,
  nonceHashFromBase64Url,
  parseHandoffRequest,
  verifyTokenInfo,
  type ConnectorStatus,
} from "../_shared/handoff-core.ts";
import { requireTenantOwnerById } from "../_shared/tenant-ownership-id.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER = "google_calendar";

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SERVICE_KEY");
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const encryptionKey = Deno.env.get("CONNECTOR_TOKEN_ENCRYPTION_KEY");
  if (!url || !serviceKey || !clientId || !encryptionKey) {
    return reply({ error: "handoff_not_configured" }, 503);
  }
  const supa = createClient(url, serviceKey, { auth: { persistSession: false } });

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: serviceKey, Authorization: auth } });
  if (!userRes.ok) return reply({ error: "unauthorized" }, 401);
  const user = await userRes.json();
  if (!user?.id) return reply({ error: "unauthorized" }, 401);

  let request;
  try {
    request = parseHandoffRequest(await req.json().catch(() => null));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "handoff_body_invalid" }, 400);
  }

  try {
    await requireTenantOwnerById(supa, request.tenantId, user.id);
  } catch (error: any) {
    return reply({ error: error?.message ?? "ownership_check_failed" }, error?.status ?? 500);
  }

  // Single-use intent consumption: replays, expiry, and any tenant/user/nonce
  // mismatch all fail here atomically.
  let kind: "login" | "reconnect";
  try {
    const nonceHash = await nonceHashFromBase64Url(request.nonce);
    const { data, error: consumeError } = await supa
      .rpc("consume_connector_handoff", {
        p_intent: request.intentId,
        p_nonce_hash: nonceHash,
        p_tenant: request.tenantId,
        p_user: user.id,
      })
      .single();
    const consumed = data as { kind?: string } | null;
    if (consumeError || (consumed?.kind !== "login" && consumed?.kind !== "reconnect")) {
      return reply({ error: "handoff_intent_invalid" }, 403);
    }
    kind = consumed.kind;
  } catch {
    return reply({ error: "handoff_intent_invalid" }, 403);
  }

  const { data: profile } = await supa
    .from("owner_profiles")
    .select("google_subject,google_email")
    .eq("user_id", user.id)
    .maybeSingle();

  // Verify the token against Google: audience, account identity, scopes, expiry.
  let verified;
  try {
    const infoRes = await fetch("https://oauth2.googleapis.com/tokeninfo", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: request.providerToken }),
    });
    if (!infoRes.ok) return reply({ error: "provider_token_invalid" }, 400);
    verified = verifyTokenInfo(await infoRes.json(), {
      clientId,
      expectedSubject: profile?.google_subject ?? null,
      expectedEmail: profile?.google_email ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "provider_token_invalid";
    return reply({ error: message }, 403);
  }

  const { data: existing, error: existingError } = await supa
    .from("connector_accounts")
    .select("id,status,token_account_ref,account_email")
    .eq("tenant_id", request.tenantId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (existingError) return reply({ error: "connector_lookup_failed" }, 500);

  let decision;
  try {
    decision = decideConnectorTransition({
      existingStatus: (existing?.status ?? null) as ConnectorStatus | null,
      kind,
      hasRefreshToken: request.providerRefreshToken !== null,
    });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "handoff_failed" }, 409);
  }

  const nowIso = new Date().toISOString();

  if (decision === "preserve_active") {
    // Repeated login without a fresh refresh token: never overwrite the stored
    // credential; the verified provider access still counts as a success signal.
    await supa
      .from("connector_accounts")
      .update({ last_success_at: nowIso, updated_at: nowIso })
      .eq("tenant_id", request.tenantId)
      .eq("provider", PROVIDER)
      .eq("status", "active");
    return reply({ connector_status: "active", preserved: true, account_email: existing?.account_email ?? null });
  }

  if (decision === "refuse_reactivation") {
    // A plain login never silently reactivates a revoked or errored connector.
    return reply({
      connector_status: existing?.status ?? null,
      reactivated: false,
      reconnect_from_settings_required: true,
    });
  }

  if (decision === "needs_refresh_token") {
    if (!existing) {
      await supa.from("connector_accounts").insert({
        tenant_id: request.tenantId,
        provider: PROVIDER,
        status: "reconnect_required",
        account_email: verified.email,
        scopes: verified.scopes.slice(0, 2000),
        updated_at: nowIso,
      });
    } else if (existing.status === "reconnect_required") {
      await supa
        .from("connector_accounts")
        .update({ account_email: verified.email ?? existing.account_email, scopes: verified.scopes.slice(0, 2000), updated_at: nowIso })
        .eq("tenant_id", request.tenantId)
        .eq("provider", PROVIDER)
        .eq("status", "reconnect_required");
    }
    return reply({ connector_status: existing?.status ?? "reconnect_required", needs_consent: true });
  }

  // decision === "activate": encrypt, prove decryption, persist, prove persisted decryption.
  const refreshToken = request.providerRefreshToken!;
  const accountRef = verified.email ?? existing?.token_account_ref ?? "google-calendar-primary";
  const aad = { tenantId: request.tenantId, provider: PROVIDER, accountRef, keyVersion: 1 };
  let wire;
  try {
    wire = await encryptConnectorToken(refreshToken, aad, encryptionKey);
    const roundTrip = await decryptConnectorToken(wire, aad, { 1: encryptionKey });
    if (roundTrip !== refreshToken) throw new Error("verify");
  } catch {
    return reply({ error: "handoff_encryption_failed" }, 500);
  }

  const { error: writeError } = await supa
    .from("connector_accounts")
    .upsert({
      tenant_id: request.tenantId,
      provider: PROVIDER,
      refresh_token_ciphertext: wire.ciphertext,
      refresh_token_iv: wire.iv,
      token_key_version: wire.keyVersion,
      token_account_ref: accountRef,
      calendar_id: "primary",
      account_email: verified.email,
      scopes: verified.scopes.slice(0, 2000),
      status: "active",
      last_error: null,
      connected_at: nowIso,
      last_success_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: "tenant_id,provider" });
  if (writeError) return reply({ error: "connector_write_failed" }, 500);

  // Post-write decrypt verification against what was actually persisted.
  try {
    const { data: persisted, error: readError } = await supa
      .from("connector_accounts")
      .select("refresh_token_ciphertext,refresh_token_iv,token_key_version,token_account_ref,status")
      .eq("tenant_id", request.tenantId)
      .eq("provider", PROVIDER)
      .single();
    if (readError || !persisted || persisted.status !== "active") throw new Error("verify");
    const decrypted = await decryptConnectorToken(
      {
        ciphertext: persisted.refresh_token_ciphertext,
        iv: persisted.refresh_token_iv,
        keyVersion: persisted.token_key_version,
      },
      { ...aad, accountRef: persisted.token_account_ref },
      { 1: encryptionKey },
    );
    if (decrypted !== refreshToken) throw new Error("verify");
  } catch {
    await supa
      .from("connector_accounts")
      .update({
        status: "reconnect_required",
        refresh_token_ciphertext: null,
        refresh_token_iv: null,
        token_key_version: null,
        last_error: "handoff_persisted_verification_failed",
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", request.tenantId)
      .eq("provider", PROVIDER);
    return reply({ error: "handoff_verification_failed" }, 500);
  }

  return reply({ connector_status: "active", account_email: verified.email, scopes_ok: true });
});
