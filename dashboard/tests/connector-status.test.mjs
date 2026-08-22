import assert from "node:assert/strict";
import test from "node:test";
import { loadConnectorStatus, loadCalendarTestState } from "../src/data/connectors.js";

const runtimeConfig = await import("../src/runtime-config.js").catch(() => ({}));

test("owner status is projected to metadata even if an upstream row contains credentials", async () => {
  let rpcArgs;
  const client = {
    async rpc(_name, args) {
      rpcArgs = args;
      return {
        data: [{
          provider: "google_calendar",
          account_email: "owner@example.com",
          calendar_id: "primary",
          status: "active",
          connected_at: "2026-08-20T12:00:00.000Z",
          scopes: "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
          last_success_at: "2026-08-22T15:00:00.000Z",
          refresh_token: "must-never-reach-dashboard",
          refresh_token_ciphertext: "also-private",
          refresh_token_iv: "also-private-iv",
          token_key_version: 1,
        }],
        error: null,
      };
    },
  };
  assert.deepEqual(await loadConnectorStatus(client, "11111111-1111-4111-8111-111111111111"), {
    provider: "google_calendar",
    account_email: "owner@example.com",
    calendar_id: "primary",
    status: "active",
    connected_at: "2026-08-20T12:00:00.000Z",
    scopes: "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
    last_success_at: "2026-08-22T15:00:00.000Z",
  });
  assert.deepEqual(rpcArgs, { p_tenant: "11111111-1111-4111-8111-111111111111" });
});

test("calendar test state projects safe scalars only and hides diagnostics internals", async () => {
  const client = {
    async rpc(name, args) {
      assert.equal(name, "get_calendar_test_state");
      assert.deepEqual(args, { p_tenant: "11111111-1111-4111-8111-111111111111" });
      return {
        data: {
          outcome: "accepted",
          event_id: "abc123",
          summary: "Ligou V0.2 TEST — Google Login and Calendar Verification",
          start_iso: "2026-08-22T12:00:00-07:00",
          end_iso: "2026-08-22T12:30:00-07:00",
          time_zone: "America/Los_Angeles",
          attempt_count: 1,
          accepted_at: "2026-08-22T15:05:00.000Z",
          readback_summary: "Ligou V0.2 TEST — Google Login and Calendar Verification",
          readback_start_iso: "2026-08-22T19:00:00.000Z",
          readback_end_iso: "2026-08-22T19:30:00.000Z",
          last_error: null,
          readback: { should: "never-surface" },
        },
        error: null,
      };
    },
  };
  const state = await loadCalendarTestState(client, "11111111-1111-4111-8111-111111111111");
  assert.equal(state.outcome, "accepted");
  assert.equal(state.readback_summary, "Ligou V0.2 TEST — Google Login and Calendar Verification");
  assert.equal("readback" in state, false);
});

test("calendar scope helper requires both narrow scopes", () => {
  assert.equal(typeof runtimeConfig.calendarScopesGranted, "function");
  assert.equal(runtimeConfig.calendarScopesGranted(
    "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
  ), true);
  assert.equal(runtimeConfig.calendarScopesGranted("https://www.googleapis.com/auth/calendar.events"), false);
  assert.equal(runtimeConfig.calendarScopesGranted(null), false);
});

test("non-owner status errors fail closed", async () => {
  const client = { async rpc() { return { data: null, error: { message: "not_tenant_owner" } }; } };
  await assert.rejects(loadConnectorStatus(client, "11111111-1111-4111-8111-111111111111"), /not_tenant_owner/);
});

test("token fields are absent from the no-connection result", async () => {
  const client = { async rpc() { return { data: [], error: null }; } };
  assert.equal(await loadConnectorStatus(client, "11111111-1111-4111-8111-111111111111"), null);
});

test("missing tenant and ambiguous multiple rows fail closed", async () => {
  const client = { async rpc() { return { data: [{ provider: "a" }, { provider: "b" }], error: null }; } };
  await assert.rejects(loadConnectorStatus(client), /tenant_required/);
  await assert.rejects(loadConnectorStatus(client, "11111111-1111-4111-8111-111111111111"), /connector_status_ambiguous/);
});

test("calendar ownership always comes from the dashboard business UUID", () => {
  assert.equal(typeof runtimeConfig.calendarTenantId, "function");
  assert.equal(runtimeConfig.calendarTenantId({
    business: { id: "11111111-1111-4111-8111-111111111111" },
    tenant: { id: "22222222-2222-4222-8222-222222222222" },
  }), "11111111-1111-4111-8111-111111111111");
  assert.throws(() => runtimeConfig.calendarTenantId({ business: {} }), /business_tenant_required/);
});

test("only an active exact-tenant connector is presented as connected", () => {
  assert.equal(typeof runtimeConfig.connectorPresentation, "function");
  assert.deepEqual(runtimeConfig.connectorPresentation({ status: "active", account_email: "owner@example.com" }), {
    connected: true,
    actionable: false,
    message: "Conectada",
  });
  for (const status of ["reconnect_required", "revoked", "error", undefined]) {
    const presentation = runtimeConfig.connectorPresentation(status ? { status } : null);
    assert.equal(presentation.connected, false, String(status));
    assert.equal(presentation.actionable, true, String(status));
    assert.match(presentation.message, /conectar|reconectar/i, String(status));
  }
});

test("Google connect uses an explicit or Supabase-derived functions base and never same-origin fallback", () => {
  assert.equal(typeof runtimeConfig.resolveFunctionsBase, "function");
  assert.equal(
    runtimeConfig.resolveFunctionsBase("", "https://example.supabase.co"),
    "https://example.supabase.co/functions/v1",
  );
  assert.equal(
    runtimeConfig.resolveFunctionsBase("https://functions.example.invalid/functions/v1/", "https://example.supabase.co"),
    "https://functions.example.invalid/functions/v1",
  );
  assert.throws(() => runtimeConfig.resolveFunctionsBase("", ""), /functions_base_required/);
  assert.throws(() => runtimeConfig.resolveFunctionsBase("/functions/v1", ""), /functions_base_invalid/);
});

test("the OAuth callback is rooted at the Vite dashboard base", () => {
  assert.equal(typeof runtimeConfig.dashboardRedirectUrl, "function");
  assert.equal(
    runtimeConfig.dashboardRedirectUrl("https://ligou.example", "/dashboard/"),
    "https://ligou.example/dashboard/",
  );
  assert.equal(
    runtimeConfig.dashboardRedirectUrl("https://ligou.example/", "/preview/dashboard/"),
    "https://ligou.example/preview/dashboard/",
  );
});
