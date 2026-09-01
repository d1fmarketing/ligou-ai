// M2 simulation: a simulation_only tenant role-plays the FULL booking conversation —
// real rules, real quotes, real free/busy — but nothing ever reaches the provider,
// the offers ledger, or the powers system. Zero powers stay zero.
import { describe, expect, test, beforeEach } from "bun:test";
import { emptyUsage } from "../src/config.ts";
import { _setClient, invalidateTenant } from "../src/rules.ts";
import { handleEvent, type SessionLedger } from "../src/sideband.ts";
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
let coverageRows: any[] = [];

function mockSupabase() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const api: any = {
        select() { return api; },
        eq(column: string, value: unknown) { filters[column] = value; return api; },
        in() { return api; },
        is() { return api; },
        lt() { return api; },
        order() { return api; },
        limit() { return api; },
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
          return Promise.resolve({
            data: table === "effective_rules"
              ? RULES
              : table === "receipts"
                ? coverageRows
                : [],
            error: null,
          }).then(resolve);
        },
      };
      return api;
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "record_onboarding_answer") {
        const input = args as any;
        const revision = Number(input.p_coverage.revision);
        const digest = String(revision % 10).repeat(64);
        const readback = {
          ...input.p_coverage,
          rule_id: `onboarding-rule-${rpcCalls.length}`,
          rule_group_id: `onboarding-group-${rpcCalls.length}`,
          selected_rule_ids: [],
          snapshot_digest: digest,
        };
        coverageRows = [{
          id: `onboarding-receipt-${revision}`,
          readback,
        }];
        return {
          data: {
            status: "recorded",
            rule_id: `onboarding-rule-${rpcCalls.length}`,
            rule_group_id: `onboarding-group-${rpcCalls.length}`,
            coverage_receipt_id: `onboarding-receipt-${rpcCalls.length}`,
            revision,
            snapshot_digest: digest,
            complete: false,
            missing: input.p_coverage.progress.missingRequired,
            ambiguous: input.p_coverage.progress.ambiguous,
            next_action: input.p_coverage.next_action,
            coverage: readback,
          },
          error: null,
        };
      }
      if (name === "record_onboarding_followup") {
        const input = args as any;
        const revision = Number(input.p_coverage.revision);
        const digest = String(revision % 10).repeat(64);
        const readback = {
          ...input.p_coverage,
          rule_id: coverageRows[0]?.readback?.rule_id ?? null,
          rule_group_id: coverageRows[0]?.readback?.rule_group_id ?? null,
          materialization_action:
            coverageRows[0]?.readback?.materialization_action ?? "coverage_only",
          snapshot_digest: digest,
        };
        coverageRows = [{ id: `followup-receipt-${revision}`, readback }];
        return {
          data: {
            status: "recorded",
            coverage_receipt_id: coverageRows[0].id,
            revision,
            snapshot_digest: digest,
            complete: false,
            missing: readback.progress.missingRequired,
            ambiguous: readback.progress.ambiguous,
            next_action: readback.next_action,
            coverage: readback,
          },
          error: null,
        };
      }
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
  coverageRows = [];
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

test("interview facts use atomic onboarding coverage without touching booking, power, or direct rule writes", async () => {
  const cap = makeCapability(
    TENANT.slug,
    TENANT.id,
    "call-ob",
    30,
    "onboarding",
    { authEpoch: 1, policyEpoch: 1, simulation: true },
    "owner-a",
  );
  const result = await runTool(cap, "record_interview_answer", {
    topic: "precos",
    field: "service.price_target",
    subject: "basic_visit",
    disposition: "answered",
    rule_text: "Basic visit has a public price of $200.",
    structured: { value: 200 },
    owner_words: "A visita básica custa duzentos dólares.",
  }, "provider-price-target");

  expect(result.body.status).toBe("recorded");
  const persistence = rpcCalls.find((call) => call.name === "record_onboarding_answer");
  expect(persistence.args).toMatchObject({
    p_owner: "owner-a",
    p_fact: {
      field: "service.price_target",
      subject: "basic_visit",
      structured: { value: 200 },
    },
    p_coverage: {
      snapshot: {
        cells: {
          "service:basic_visit:service.price_target": {
            state: "answered",
            value: 200,
          },
        },
      },
    },
  });
  expect(inserted.some((entry) => entry.table === "rules")).toBe(false);
  expect(inserted.some((entry) => entry.table === "bookings")).toBe(false);
  expect(inserted.some((entry) => entry.table === "action_intents")).toBe(false);
  expect(rpcCalls.some((call) => String(call.name).includes("power"))).toBe(false);
});

test("junk price targets remain ambiguous coverage and never become authority", async () => {
  const cap = makeCapability(
    TENANT.slug,
    TENANT.id,
    "call-ob2",
    30,
    "onboarding",
    { authEpoch: 1, policyEpoch: 1, simulation: true },
    "owner-a",
  );
  const junkTargets = ["", false, "200", -50];
  for (const [index, target] of junkTargets.entries()) {
    await runTool(cap, "record_interview_answer", {
      topic: "precos",
      field: "service.price_target",
      subject: `junk_${index}`,
      disposition: "answered",
      rule_text: `Junk price ${index}.`,
      structured: { value: target },
      owner_words: `Valor inválido ${index}.`,
    }, `provider-junk-${index}`);
  }
  const persistenceCalls = rpcCalls.filter(
    (call) => call.name === "record_onboarding_answer",
  );
  expect(persistenceCalls).toHaveLength(junkTargets.length);
  for (const call of persistenceCalls) {
    const coverage = call.args.p_coverage as any;
    const cell = Object.values(coverage.snapshot.cells).find(
      (value: any) => value?.state === "ambiguous",
    ) as any;
    expect(cell?.reason).toBe("price_target_must_be_nonnegative_number");
    expect(coverage.authority).toEqual({
      rules_approved: false,
      powers_granted: false,
      operational_mode_changed: false,
    });
  }
  expect(inserted.some((entry) => entry.table === "rules")).toBe(false);
});

test("serialized sideband passes exact provider call_id and acknowledges simulation output without authority writes", async () => {
  const cap = makeCapability(
    TENANT.slug,
    TENANT.id,
    "call-ob-sideband",
    30,
    "onboarding",
    { authEpoch: 1, policyEpoch: 1, simulation: true },
    "owner-a",
  );
  const ledger: SessionLedger = {
    callId: cap.callId,
    openaiCallId: "rtc-ob-sideband",
    model: "gpt-realtime-2.1",
    startedAt: Date.now(),
    usage: emptyUsage(),
    providerUsageEvidence: {
      eventCount: 0,
      lastResponseId: null,
      lastReceivedAt: null,
      continuous: true,
      terminal: false,
    },
    transcript: [],
    toolLog: [],
    status: "active",
    expectedOnboardingBusinessName: TENANT.name,
  };
  const ws = {
    sent: [] as string[],
    send(frame: string) { this.sent.push(frame); },
    close() {},
  };
  const greetingResponseId = "resp-sideband-greeting";
  await handleEvent(cap, ledger, ws as any, { type: "session.created" });
  await handleEvent(cap, ledger, ws as any, {
    type: "response.created",
    response: {
      id: greetingResponseId,
      metadata: { intent_key: `greeting:${cap.callId}` },
    },
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "response.output_audio_transcript.done",
    response_id: greetingResponseId,
    transcript:
      "Oi! Aqui é o Ligou, agente de inteligência artificial da D1f Marketing. Quais serviços sua empresa oferece?",
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "response.output_audio.done",
    response_id: greetingResponseId,
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "response.done",
    response: { id: greetingResponseId, status: "completed" },
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "output_audio_buffer.stopped",
    response_id: greetingResponseId,
  });
  expect(ledger.onboarding!.lifecycle.phase).toBe("collecting");
  await handleEvent(cap, ledger, ws as any, {
    type: "input_audio_buffer.speech_started",
    item_id: "turn-sideband-answer",
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "turn-sideband-answer",
    transcript: "A visita básica custa duzentos dólares.",
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "response.created",
    response: { id: "resp-sideband-answer", metadata: {} },
  });
  await handleEvent(cap, ledger, ws as any, {
    type: "response.output_item.done",
    response_id: "resp-sideband-answer",
    output_index: 0,
    item: {
      type: "function_call",
      status: "completed",
      name: "record_interview_answer",
      call_id: "provider-sideband-answer-1",
      arguments: JSON.stringify({
        topic: "precos",
        field: "service.price_target",
        subject: "basic_visit",
        disposition: "answered",
        rule_text: "Basic visit has a public price of $200.",
        structured: { value: 200 },
        owner_words: "A visita básica custa duzentos dólares.",
      }),
    },
  });
  expect(ws.sent).toEqual([]);
  await handleEvent(cap, ledger, ws as any, {
    type: "response.done",
    response: { id: "resp-sideband-answer", status: "completed" },
  });

  const persistence = rpcCalls.find(
    (call) => call.name === "record_onboarding_answer",
  );
  expect(persistence.args.p_provider_tool_call_id)
    .toBe("provider-sideband-answer-1");
  const outputFrame = ws.sent.map((frame) => JSON.parse(frame)).find(
    (frame) => frame.item?.type === "function_call_output",
  );
  expect(outputFrame.item).toMatchObject({
    id: "tlo-25f29b2ecfe6efcb769e1683eeb4",
    call_id: "provider-sideband-answer-1",
  });
  expect(ledger.onboarding!.lifecycle.toolOutbox["provider-sideband-answer-1"]?.state)
    .toBe("output_pending");
  await handleEvent(cap, ledger, ws as any, {
    type: "conversation.item.added",
    item: outputFrame.item,
  });
  expect(ledger.onboarding!.lifecycle.toolOutbox["provider-sideband-answer-1"]?.state)
    .toBe("output_pending");
  await handleEvent(cap, ledger, ws as any, {
    type: "conversation.item.done",
    item: outputFrame.item,
  });
  expect(ledger.onboarding!.lifecycle.toolOutbox["provider-sideband-answer-1"]?.state)
    .toBe("output_acked");
  expect(ledger.onboarding!.lifecycle.phase).not.toBe("blocked");
  expect(inserted.some((entry) => [
    "rules", "bookings", "action_intents", "powers",
  ].includes(entry.table))).toBe(false);
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
