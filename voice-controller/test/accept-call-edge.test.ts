import { expect, test } from "bun:test";
import { persistPhoneEvent } from "../../supabase/functions/_shared/accept-call.ts";
import { makeCapability } from "../src/tools.ts";

const row = { openai_call_id: "call-1", called_number: "+19495550100", caller_number_hash: "a".repeat(64), sip_headers: {} };

test("accept-call returns retryable non-2xx when persistence fails", async () => {
  const client = {
    from() {
      return { async upsert() { return { error: { message: "database unavailable" } }; } };
    },
  };
  const response = await persistPhoneEvent(client as any, row);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "phone_event_persistence_failed" });
});

test("accept-call acknowledges only after durable persistence", async () => {
  const client = {
    from() {
      return { async upsert() { return { error: null }; } };
    },
  };
  const response = await persistPhoneEvent(client as any, row);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true });
});

test("phone/customer capabilities retain their session type without an authenticated browser owner", () => {
  const capability = makeCapability(
    "rocha-plumbing",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    15,
    "customer",
    { authEpoch: 1, policyEpoch: 1 },
  );
  expect(capability.sessionType).toBe("customer");
  expect(capability.ownerUserId).toBeUndefined();
});
