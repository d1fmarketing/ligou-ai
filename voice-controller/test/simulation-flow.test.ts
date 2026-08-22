// M2 simulation: a simulation_only tenant role-plays the FULL booking conversation —
// real rules, real quotes, real free/busy — but nothing ever reaches the provider,
// the offers ledger, or the powers system. Zero powers stay zero.
import { describe, expect, test, beforeEach } from "bun:test";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { makeCapability, runTool } from "../src/tools.ts";
import { buildInstructions } from "../src/instructions.ts";
import { _resetSimulationStore, _seedSimulationBooking } from "../src/simulation.ts";

const TENANT = {
  id: "22222222-2222-4222-8222-222222222222", slug: "ligou-sim", name: "D1f Marketing", vertical: null,
  languages: ["pt", "en"], timezone: "America/Los_Angeles", session_max_minutes: 15, owner_user_id: "owner-a",
  auth_epoch: 1, policy_epoch: 1, status: "onboarding", operational_mode: "simulation_only",
};
const RULES = [
  { id: "r-price-drain", rule_group_id: "g1", version: 1, category: "preco", escopo: "servico", text: "Drain cleaning: $149–$225.", structured: { service_type: "drain_cleaning", price_min: 149, price_target: 225, duration_min: 60, grant: "AZUL" } },
  { id: "r-area", rule_group_id: "g2", version: 1, category: "area", escopo: "localizacao", text: "Anaheim and Irvine.", structured: { cities: ["Anaheim", "Irvine"] } },
  { id: "r-hours", rule_group_id: "g3", version: 1, category: "agenda", escopo: "geral", text: "Mon–Sat 08:00–18:00.", structured: null },
];

let inserted: any[] = [];
let rpcCalls: any[] = [];
let quoteRows: any[] = [];

function mockSupabase() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const api: any = {
        select() { return api; },
        eq(column: string, value: unknown) { filters[column] = value; return api; },
        is() { return api; },
        lt() { return api; },
        gt: async () => ({ data: [], error: null }),
        maybeSingle: async () => table === "booking_quotes"
          ? { data: quoteRows.find((row) => row.token_hash === filters.token_hash) ?? null, error: null }
          : { data: null, error: null },
        single: async () => table === "tenants"
          ? { data: { ...TENANT }, error: null }
          : { data: { id: "case-1", status: "pendente" }, error: null },
        upsert(row: any) { inserted.push({ table, row }); return api; },
        update(row: any) { inserted.push({ table, op: "update", row }); return api; },
        insert(row: any) {
          inserted.push({ table, row });
          if (table === "booking_quotes") quoteRows.push({ id: `quote-${quoteRows.length + 1}`, ...row });
          return api;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: table === "effective_rules" ? RULES : [], error: null }).then(resolve);
        },
      };
      return api;
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { data: null, error: { message: `rpc_forbidden_in_simulation:${name}` } };
    },
  };
}

function simCap() {
  return makeCapability(TENANT.slug, TENANT.id, "call-sim-1", 15, "owner_browser", {
    authEpoch: 1, policyEpoch: 1, simulation: true,
  });
}

beforeEach(() => {
  inserted = [];
  rpcCalls = [];
  quoteRows = [];
  _setClient(mockSupabase() as any);
  invalidateTenant(TENANT.slug);
  _resetSimulationStore();
});

test("the capability carries the simulation flag and defaults to live", () => {
  expect(simCap().simulation).toBe(true);
  const live = makeCapability(TENANT.slug, TENANT.id, "c", 15, "owner_browser", { authEpoch: 1, policyEpoch: 1 });
  expect(live.simulation).toBe(false);
});

test("simulated availability offers slots with zero powers and never writes slot_offers", async () => {
  const cap = simCap();
  const quote = await runTool(cap, "quote_price", { service_type: "drain_cleaning" });
  expect(quote.body.status).toBe("quoted");
  const availability = await runTool(cap, "check_availability", {
    service_type: "drain_cleaning", service_city: "Anaheim", quote_id: quote.body.quote_id,
  });
  expect(availability.body.status).toBe("ok");
  expect(availability.body.simulated).toBe(true);
  const slots = availability.body.slots as Array<{ slot_token: string }>;
  expect(slots.length).toBeGreaterThan(0);
  expect(slots[0].slot_token.startsWith("sim.")).toBe(true);
  expect(inserted.filter((i) => i.table === "slot_offers").length).toBe(0);
  expect(rpcCalls.length).toBe(0);
});

test("a full simulated close returns simulated_confirmed without touching booking RPCs or tables", async () => {
  const cap = simCap();
  const quote = await runTool(cap, "quote_price", { service_type: "drain_cleaning" });
  const availability = await runTool(cap, "check_availability", {
    service_type: "drain_cleaning", service_city: "Anaheim", quote_id: quote.body.quote_id,
  });
  const slot = (availability.body.slots as Array<{ slot_token: string }>)[0];
  const proposed = await runTool(cap, "propose_booking", { slot_token: slot.slot_token, client_name: "Cliente Teste" });
  expect(proposed.body.status).toBe("proposed");
  expect(String(proposed.body.booking_id).startsWith("sim.")).toBe(true);
  const closed = await runTool(cap, "close_deal", { booking_id: proposed.body.booking_id });
  expect(closed.body.status).toBe("simulated_confirmed");
  expect(closed.body.receipt).toBe("simulated");
  expect(String(closed.body.say)).toMatch(/simula/i);
  expect(rpcCalls.length).toBe(0);
  expect(inserted.filter((i) => i.table === "bookings").length).toBe(0);
  expect(inserted.filter((i) => i.table === "action_intents").length).toBe(0);
});

test("a simulated close below the approved floor still opens a real approval case", async () => {
  const cap = simCap();
  const bookingId = _seedSimulationBooking(cap.callId, {
    serviceType: "drain_cleaning", price: 100,
    slotStart: "2026-08-24T17:00:00.000Z", slotEnd: "2026-08-24T18:00:00.000Z",
    local: "Monday, August 24 at 10:00", clientName: "Cliente Teste", contact: null,
  });
  const closed = await runTool(cap, "close_deal", { booking_id: bookingId });
  expect(closed.body.status).toBe("pending_approval");
  expect(inserted.some((i) => i.table === "approval_cases")).toBe(true);
  expect(rpcCalls.length).toBe(0);
});

test("a fabricated simulation token is refused", async () => {
  const cap = simCap();
  const proposed = await runTool(cap, "propose_booking", { slot_token: "sim.forged" });
  expect(proposed.body.status).toBe("invalid_offer");
  const closed = await runTool(cap, "close_deal", { booking_id: "sim.forged-booking" });
  expect(closed.body.status).toBe("invalid");
});

test("a live capability never enters the simulation path", async () => {
  const cap = makeCapability(TENANT.slug, TENANT.id, "call-live", 15, "owner_browser", { authEpoch: 1, policyEpoch: 1 });
  const proposed = await runTool(cap, "propose_booking", { slot_token: "sim.anything" });
  // live path goes to the real offers RPC, which our mock refuses — proving no sim shortcut
  expect(proposed.body.status).toBe("invalid_offer");
  expect(rpcCalls.some((c) => c.name === "consume_slot_offer")).toBe(true);
});

test("interview price answers gain a conservative floor when the owner only gave a target", async () => {
  const cap = makeCapability(TENANT.slug, TENANT.id, "call-ob", 30, "onboarding", { authEpoch: 1, policyEpoch: 1 });
  await runTool(cap, "record_interview_answer", {
    topic: "precos", rule_text: "Basic visit: public quote $200.",
    structured: { service_type: "basic_visit", price_target: 200, duration_min: 60 },
  });
  const row = inserted.find((i) => i.table === "rules");
  expect(row.row.structured.price_min).toBe(200);
  expect(row.row.structured.price_target).toBe(200);

  await runTool(cap, "record_interview_answer", {
    topic: "precos", rule_text: "Negotiable visit: $150–$220.",
    structured: { service_type: "nego_visit", price_min: 150, price_target: 220, duration_min: 60 },
  });
  const nego = inserted.filter((i) => i.table === "rules")[1];
  expect(nego.row.structured.price_min).toBe(150);
});

test("junk price targets never become an enforceable zero floor", async () => {
  const cap = makeCapability(TENANT.slug, TENANT.id, "call-ob2", 30, "onboarding", { authEpoch: 1, policyEpoch: 1 });
  const junkTargets = ["", false, "200", 0, -50];
  for (const [index, target] of junkTargets.entries()) {
    await runTool(cap, "record_interview_answer", {
      topic: "precos", rule_text: `Junk price ${index}.`,
      structured: { service_type: `junk_${index}`, price_target: target, duration_min: 60 },
    });
  }
  const rows = inserted.filter((i) => i.table === "rules");
  expect(rows.length).toBe(junkTargets.length);
  for (const row of rows) {
    expect(row.row.structured.price_min).toBeUndefined();
  }
});

describe("instructions", () => {
  test("the onboarding interview locks the language to Portuguese", () => {
    const text = buildInstructions(TENANT as any, RULES as any, "onboarding");
    expect(text).toMatch(/LANGUAGE: .*portugu/i);
    expect(text).not.toMatch(/LANGUAGE: Default to English/);
  });

  test("simulation tenants get the simulation contract in role-play sessions", () => {
    const text = buildInstructions(TENANT as any, RULES as any, "owner_browser");
    expect(text).toMatch(/SIMULATION MODE/);
    expect(text).toMatch(/simulated_confirmed/);
  });

  test("live tenants never see the simulation layer", () => {
    const live = { ...TENANT, operational_mode: "live" };
    const text = buildInstructions(live as any, RULES as any, "owner_browser");
    expect(text).not.toMatch(/SIMULATION MODE/);
  });
});
