// Provider-token custody in the browser: the storage adapter must never persist
// provider tokens, the PKCE verifier lives only in the temporary store, and the
// bootstrap hands the token to the Edge function exactly once.
import test from "node:test";
import assert from "node:assert/strict";
import { createCustodyStorage, stripProviderFields } from "../src/auth/session-storage.js";
import { runOwnerBootstrap } from "../src/auth/bootstrap.js";

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map,
  };
}

const SESSION_KEY = "sb-project-auth-token";
const VERIFIER_KEY = "sb-project-auth-token-code-verifier";

function sessionJson(extra = {}) {
  return JSON.stringify({
    access_token: "sb-access-token",
    refresh_token: "sb-refresh-token",
    expires_at: 1_800_000_000,
    token_type: "bearer",
    provider_token: "ya29.provider-access-secret",
    provider_refresh_token: "1//provider-refresh-secret",
    user: { id: "11111111-1111-4111-8111-111111111111" },
    ...extra,
  });
}

test("persisted sessions are stripped of provider tokens", () => {
  const persistent = memoryStore();
  const temporary = memoryStore();
  const storage = createCustodyStorage({ persistent, temporary });
  storage.setItem(SESSION_KEY, sessionJson());
  const stored = persistent.getItem(SESSION_KEY);
  assert.ok(stored, "session must persist");
  assert.ok(!stored.includes("provider-access-secret"));
  assert.ok(!stored.includes("provider-refresh-secret"));
  assert.ok(!stored.includes("provider_token"));
  const parsed = JSON.parse(stored);
  assert.equal(parsed.access_token, "sb-access-token");
  assert.equal(parsed.refresh_token, "sb-refresh-token");
  assert.equal(storage.getItem(SESSION_KEY), stored);
});

test("the PKCE verifier is routed to the temporary store only", () => {
  const persistent = memoryStore();
  const temporary = memoryStore();
  const storage = createCustodyStorage({ persistent, temporary });
  storage.setItem(VERIFIER_KEY, "verifier-value-123");
  assert.equal(temporary.getItem(VERIFIER_KEY), "verifier-value-123");
  assert.equal(persistent.getItem(VERIFIER_KEY), null);
  assert.equal(storage.getItem(VERIFIER_KEY), "verifier-value-123");
});

test("the temporary path rejects session or provider token payloads", () => {
  const persistent = memoryStore();
  const temporary = memoryStore();
  const storage = createCustodyStorage({ persistent, temporary });
  assert.throws(() => storage.setItem(VERIFIER_KEY, sessionJson()), /custody/);
  assert.throws(() => storage.setItem(VERIFIER_KEY, '{"provider_token":"x"}'), /custody/);
  assert.equal(temporary.getItem(VERIFIER_KEY), null);
});

test("an unparseable payload mentioning provider tokens is dropped, never persisted", () => {
  const persistent = memoryStore();
  const temporary = memoryStore();
  const storage = createCustodyStorage({ persistent, temporary });
  storage.setItem(SESSION_KEY, "not-json provider_token=ya29.secret");
  assert.equal(persistent.getItem(SESSION_KEY), null);
});

test("the React-state session shape never carries provider tokens", () => {
  const raw = JSON.parse(sessionJson());
  const stripped = stripProviderFields(raw);
  assert.equal(stripped.access_token, "sb-access-token");
  assert.equal(stripped.user.id, "11111111-1111-4111-8111-111111111111");
  assert.equal("provider_token" in stripped, false);
  assert.equal("provider_refresh_token" in stripped, false);
  // The original object is not mutated — the caller decides what to keep where.
  assert.equal(raw.provider_token, "ya29.provider-access-secret");
});

test("an unparseable payload mentioning only the refresh token is also dropped", () => {
  const persistent = memoryStore();
  const temporary = memoryStore();
  const storage = createCustodyStorage({ persistent, temporary });
  storage.setItem(SESSION_KEY, "not-json provider_refresh_token=1//secret");
  assert.equal(persistent.getItem(SESSION_KEY), null);
});

test("removeItem clears both stores", () => {
  const persistent = memoryStore();
  const temporary = memoryStore();
  const storage = createCustodyStorage({ persistent, temporary });
  storage.setItem(SESSION_KEY, sessionJson());
  storage.setItem(VERIFIER_KEY, "verifier");
  storage.removeItem(SESSION_KEY);
  storage.removeItem(VERIFIER_KEY);
  assert.equal(persistent.getItem(SESSION_KEY), null);
  assert.equal(temporary.getItem(VERIFIER_KEY), null);
});

// ---- bootstrap orchestration ----

const TENANT = "44444444-4444-4444-8444-444444444444";

function stubClient({ ensure, beginHandoff, connectorRows } = {}) {
  const calls = { rpc: [] };
  return {
    calls,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === "ensure_owner_tenant") {
        return ensure ?? { data: { tenant_id: TENANT, created: true, status: "onboarding", operational_mode: "simulation_only", name: "Meu negócio", timezone: "America/Los_Angeles" }, error: null };
      }
      if (name === "begin_connector_handoff") {
        return beginHandoff ?? { data: { intent_id: "55555555-5555-4555-8555-555555555555", expires_at: "2026-08-22T20:00:00Z" }, error: null };
      }
      if (name === "get_connector_status") {
        return { data: connectorRows ?? [{ provider: "google_calendar", status: "reconnect_required", account_email: null, calendar_id: "primary", connected_at: null, scopes: null, last_success_at: null }], error: null };
      }
      if (name === "get_calendar_test_state") {
        return { data: { outcome: null }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
}

function bootstrapInput(overrides = {}) {
  const fetchCalls = [];
  const flags = memoryStore();
  return {
    fetchCalls,
    flags,
    options: {
      client: stubClient(),
      session: { access_token: "sb-access-token" },
      providerToken: "ya29.provider-access-secret",
      providerRefreshToken: "1//provider-refresh-secret",
      functionsBase: "https://project.supabase.co/functions/v1",
      flagStorage: flags,
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ connector_status: "active", account_email: "owner@example.com", scopes_ok: true }) };
      },
      ...overrides,
    },
  };
}

test("bootstrap resolves the tenant from the RPC and hands the token off exactly once", async () => {
  const { options, fetchCalls } = bootstrapInput();
  const result = await runOwnerBootstrap(options);
  assert.equal(result.tenant.tenant_id, TENANT);
  assert.equal(result.connector.connector_status, "active");
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url, "https://project.supabase.co/functions/v1/google-handoff");
  assert.equal(call.init.headers.Authorization, "Bearer sb-access-token");
  const body = JSON.parse(call.init.body);
  assert.equal(body.tenant_id, TENANT);
  assert.equal(body.provider, "google");
  assert.equal(body.provider_token, "ya29.provider-access-secret");
  assert.equal(body.provider_refresh_token, "1//provider-refresh-secret");
  assert.match(body.nonce, /^[A-Za-z0-9_-]{43,}$/);
  assert.match(String(body.intent_id), /^[a-f0-9-]{36}$/i);
});

test("the nonce hash sent to the intent RPC never contains the provider token", async () => {
  const { options } = bootstrapInput();
  const client = options.client;
  await runOwnerBootstrap(options);
  const begin = client.calls.rpc.find((entry) => entry.name === "begin_connector_handoff");
  assert.ok(begin);
  assert.equal(begin.args.p_tenant, TENANT);
  assert.equal(begin.args.p_kind, "login");
  assert.match(begin.args.p_nonce_hash, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(client.calls.rpc);
  assert.ok(!serialized.includes("ya29.provider-access-secret"));
  assert.ok(!serialized.includes("1//provider-refresh-secret"));
});

test("without a provider token the bootstrap reads connector state and never posts", async () => {
  const { options, fetchCalls } = bootstrapInput({ providerToken: null, providerRefreshToken: null });
  const result = await runOwnerBootstrap(options);
  assert.equal(fetchCalls.length, 0);
  assert.equal(result.connector.connector_status, "reconnect_required");
  assert.equal(result.tenant.tenant_id, TENANT);
});

test("needs_consent triggers exactly one automatic consent retry", async () => {
  const { options, flags } = bootstrapInput({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ connector_status: "reconnect_required", needs_consent: true }) }),
  });
  const first = await runOwnerBootstrap(options);
  assert.equal(first.action, "reauth_consent");
  assert.ok(flags.getItem("ligou.consent.retry"));
  const second = await runOwnerBootstrap(options);
  assert.notEqual(second.action, "reauth_consent");
  assert.equal(second.connector.connector_status, "reconnect_required");
});

test("a pending reconnect flag switches the intent kind and is consumed", async () => {
  const { options, flags } = bootstrapInput();
  flags.setItem("ligou.reconnect.pending", "1");
  await runOwnerBootstrap(options);
  const begin = options.client.calls.rpc.find((entry) => entry.name === "begin_connector_handoff");
  assert.equal(begin.args.p_kind, "reconnect");
  assert.equal(flags.getItem("ligou.reconnect.pending"), null);
});

test("a tenant bootstrap error fails closed instead of picking any tenant row", async () => {
  const { options } = bootstrapInput({
    client: stubClient({ ensure: { data: null, error: { message: "authenticated_role_required" } } }),
  });
  await assert.rejects(() => runOwnerBootstrap(options), /authenticated_role_required/);
});

test("a refused reactivation is reported truthfully without retry", async () => {
  const { options, fetchCalls } = bootstrapInput({
    fetchImpl: async (url, init) => {
      fetchCalls?.push?.({ url, init });
      return { ok: true, status: 200, json: async () => ({ connector_status: "revoked", reactivated: false, reconnect_from_settings_required: true }) };
    },
  });
  const result = await runOwnerBootstrap(options);
  assert.equal(result.connector.connector_status, "revoked");
  assert.equal(result.connector.reconnect_from_settings_required, true);
  assert.notEqual(result.action, "reauth_consent");
});
