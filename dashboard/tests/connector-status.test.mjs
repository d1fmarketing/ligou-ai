import assert from "node:assert/strict";
import test from "node:test";
import { loadConnectorStatus } from "../src/data/connectors.js";

test("owner status is projected to metadata even if an upstream row contains credentials", async () => {
  const client = {
    async rpc() {
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
  assert.deepEqual(await loadConnectorStatus(client), {
    provider: "google_calendar",
    account_email: "owner@example.com",
    calendar_id: "primary",
    status: "active",
    connected_at: "2026-08-20T12:00:00.000Z",
  });
});

test("non-owner status errors fail closed", async () => {
  const client = { async rpc() { return { data: null, error: { message: "not_tenant_owner" } }; } };
  await assert.rejects(loadConnectorStatus(client), /not_tenant_owner/);
});

test("token fields are absent from the no-connection result", async () => {
  const client = { async rpc() { return { data: [], error: null }; } };
  assert.equal(await loadConnectorStatus(client), null);
});
