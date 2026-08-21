import { expect, test } from "bun:test";
import { persistPhoneEvent } from "../../supabase/functions/_shared/accept-call.ts";

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
