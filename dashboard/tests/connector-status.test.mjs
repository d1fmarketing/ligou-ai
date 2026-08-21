import assert from "node:assert/strict";
import test from "node:test";
import { loadConnectorStatus } from "../src/data/connectors.js";

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
          refresh_token: "must-never-reach-dashboard",
          refresh_token_ciphertext: "also-private",
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
  });
  assert.deepEqual(rpcArgs, { p_tenant: "11111111-1111-4111-8111-111111111111" });
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
