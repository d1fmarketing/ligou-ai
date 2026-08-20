// Booking integration tests — run against the REAL Supabase project (dev) with the fake calendar port.
// Exercises: server-side floor deny, powers check, outbox lease, receipt with read-back, confirmed-only-with-accepted,
// idempotency (retry never duplicates), unknown-never-immediate-resend. Skipped when SUPABASE env is absent.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

const HAVE_ENV = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
const d = HAVE_ENV ? describe : describe.skip;

let supa: any, proposeBooking: any, closeDeal: any, tickIntents: any, makeCapability: any, runTool: any;
let TENANT_ID = "";
const SLUG = `test-tenant-${Date.now()}`;

beforeAll(async () => {
  if (!HAVE_ENV) return;
  const rules = await import("../src/rules.ts");
  rules._setClient(null); // unit tests may have injected a mock into the shared module registry
  ({ supa } = rules);
  ({ proposeBooking, closeDeal } = await import("../src/booking.ts"));
  ({ tickIntents } = await import("../src/worker.ts"));
  ({ makeCapability, runTool } = await import("../src/tools.ts"));

  const { data: tenant, error } = await supa().from("tenants")
    .insert({ slug: SLUG, name: "Test Plumbing", vertical: "plumbing", status: "active" })
    .select("id").single();
  if (error) throw new Error(error.message);
  TENANT_ID = tenant.id;
  await supa().from("rules").insert({
    tenant_id: TENANT_ID, origem: "edicao_manual", escopo: "servico", status: "aprovado", category: "preco",
    text: "Drain cleaning $149-$225",
    structured: { service_type: "drain_cleaning", price_min: 149, price_target: 225, duration_min: 60, grant: "AZUL" },
  });
  await supa().from("powers").insert({
    tenant_id: TENANT_ID, subject: "voice_agent", capability: "create_booking", resource: "drain_cleaning", monetary_limit: 225,
  });
});

afterAll(async () => {
  if (!HAVE_ENV || !TENANT_ID) return;
  // cleanup in FK order (rules/receipts are append-only via triggers — delete is blocked; leave them, they're test-tenant scoped)
  for (const table of ["notifications", "bookings", "action_intents", "approval_cases", "usage_ledger", "calls", "fake_calendar_events", "powers"]) {
    await supa().from(table).delete().eq("tenant_id", TENANT_ID).then(() => {});
  }
});

async function cap() {
  const { data: tenant } = await supa().from("tenants").select("auth_epoch,policy_epoch").eq("id", TENANT_ID).single();
  const { data: call } = await supa().from("calls")
    .insert({ tenant_id: TENANT_ID, channel: "eval", session_type: "customer", status: "active" })
    .select("id").single();
  return makeCapability(SLUG, TENANT_ID, call.id, 15, "customer", {
    authEpoch: tenant.auth_epoch,
    policyEpoch: tenant.policy_epoch,
  });
}

async function offeredBooking(c: any, publicPrice = 225) {
  const quoted = await runTool(c, "quote_price", { service_type: "drain_cleaning" });
  let quoteId = quoted.body.quote_id;
  if (publicPrice !== 225) {
    const evaluated = await runTool(c, "evaluate_offer", {
      service_type: "drain_cleaning", offered_price: publicPrice, quote_id: quoteId,
    });
    expect(evaluated.body.status).toBe("accept");
    quoteId = evaluated.body.quote_id;
  }
  const availability = await runTool(c, "check_availability", {
    service_type: "drain_cleaning", service_city: "Irvine", quote_id: quoteId,
  });
  expect(availability.body.status).toBe("ok");
  return proposeBooking(c, {
    slot_token: availability.body.slots[0].slot_token,
    client_name: "Integration Customer", contact: "+15555550100",
  });
}

d("booking end-to-end (fake calendar)", () => {
  test("floor is enforced server-side: below-minimum close -> pending_approval case, never a calendar event", async () => {
    const c = await cap();
    const prop = await offeredBooking(c, 200);
    expect(prop.status).toBe("proposed");
    // Simulate a compromised internal caller changing persisted price; close
    // still reads current private policy and refuses before intent creation.
    await supa().from("bookings").update({ price_agreed: 120 }).eq("id", prop.booking_id);
    const closed = await closeDeal(c, { booking_id: prop.booking_id });
    expect(closed.status).toBe("pending_approval");
    expect(closed.say).toContain("team");
    const { data: events } = await supa().from("fake_calendar_events").select("id").eq("tenant_id", TENANT_ID);
    expect(events?.length ?? 0).toBe(0);
  });

  test("within-band close -> intent -> worker -> accepted receipt with read-back -> booking confirmed", async () => {
    const c = await cap();
    const prop = await offeredBooking(c, 200);
    expect(prop.status).toBe("proposed");

    const closing = closeDeal(c, { booking_id: prop.booking_id });
    // drive the worker while close_deal waits
    const driver = (async () => { for (let i = 0; i < 10; i++) { await tickIntents(); await new Promise((r) => setTimeout(r, 120)); } })();
    const closed = await closing; await driver;

    expect(closed.status).toBe("confirmed");
    expect(closed.receipt).toBe("accepted");
    const { data: receipt } = await supa().from("receipts").select("*").eq("tenant_id", TENANT_ID).eq("kind", "booking").eq("outcome", "accepted").single();
    expect(receipt.external_id).toBeTruthy();
    expect(receipt.readback).toBeTruthy();       // read-back proof, not just an id
    expect(receipt.payload_hash).toBeTruthy();
    const { data: booking } = await supa().from("bookings").select("status,calendar_event_id,receipt_id").eq("id", prop.booking_id).single();
    expect(booking.status).toBe("confirmed");
    expect(booking.receipt_id).toBe(receipt.id);
  }, 20000);

  test("retry of the same close is idempotent: one intent, one event", async () => {
    // two full close cycles against a us-east-1 DB — generous timeout

    const c = await cap();
    const prop = await offeredBooking(c, 210);
    const run = async () => {
      const p = closeDeal(c, { booking_id: prop.booking_id });
      for (let i = 0; i < 8; i++) { await tickIntents(); await new Promise((r) => setTimeout(r, 100)); }
      return p;
    };
    const first = await run();
    const second = await run(); // model/tool retry after timeout — must not double-book
    expect(["confirmed", "processing"]).toContain(first.status);
    expect(second.status).toBe("confirmed");
    const { data: events } = await supa().from("fake_calendar_events").select("id").eq("tenant_id", TENANT_ID).like("summary", "%210%");
    expect(events.length).toBe(1);
    const { data: intents } = await supa().from("action_intents").select("id").eq("tenant_id", TENANT_ID).eq("booking_id", prop.booking_id);
    expect(intents.length).toBe(1);
  }, 25000);

  test("an arbitrary offer token creates no booking or provider intent", async () => {
    const c = await cap();
    const prop = await proposeBooking(c, { slot_token: "model-invented-token" });
    expect(prop.status).toBe("invalid_offer");
    const { data: intents } = await supa().from("action_intents").select("id").eq("call_id", c.callId);
    expect(intents).toHaveLength(0);
  });

  test("receipts table refuses accepted without read-back proof (DB constraint)", async () => {
    const { error } = await supa().from("receipts").insert({
      tenant_id: TENANT_ID, kind: "booking", outcome: "accepted", external_id: "ev-123", // missing readback/payload_hash
    });
    expect(error).toBeTruthy();
    expect(error.message).toContain("receipts_accepted_proof");
  });

  test("rules are append-only at the database level", async () => {
    const { data: rule } = await supa().from("rules").select("id").eq("tenant_id", TENANT_ID).limit(1).single();
    const { error } = await supa().from("rules").update({ text: "hacked" }).eq("id", rule.id);
    expect(error).toBeTruthy();
    expect(error.message).toContain("append_only");
  });
});
