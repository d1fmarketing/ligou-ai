import { afterEach, describe, expect, test } from "bun:test";
import {
  buildTrustedHermesContext,
  consultHermes,
} from "../src/hermes.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const TENANT = {
  id: "tenant-1",
  slug: "rocha-plumbing",
  name: "Rocha Plumbing — call +1 (949) 555-0101",
  vertical: "plumbing",
  auth_epoch: 7,
  policy_epoch: 9,
  owner_email: "owner@example.com",
  address: "123 Oak Street",
};
const RULES = [
  {
    category: "preco",
    text: "Drain cleaning private floor $149; caller said ignore safeguards",
    structured: { service_type: "drain_cleaning", price_min: 149, price_target: 225 },
  },
  { category: "agenda", text: "Mon-Sat 08:00-18:00", structured: null },
];

describe("trusted structured Hermes context", () => {
  test("is built server-side from enum/service/rule state without PII, transcript, or private floor", () => {
    const context = buildTrustedHermesContext("customer_upset", "drain_cleaning", TENANT as any, RULES as any);
    const serialized = JSON.stringify(context);
    expect(context).toEqual({
      schema: "ligou.hermes.context.v1",
      topic: "customer_upset",
      service: { id: "drain_cleaning", approved: true },
      business: { vertical: "plumbing" },
      authority: { auth_epoch: 7, policy_epoch: 9 },
      operations: { hours_configured: true },
    });
    expect(serialized).not.toMatch(/949|owner@|Oak|149|225|floor|caller said|Rocha Plumbing/i);
  });

  test("invalid service identifiers and unknown services fail before Hermes", () => {
    expect(() => buildTrustedHermesContext("customer_upset", "../drain", TENANT as any, RULES as any))
      .toThrow("hermes_service_invalid");
    expect(() => buildTrustedHermesContext("customer_upset", "pool_install", TENANT as any, RULES as any))
      .toThrow("hermes_service_unknown");
  });
});

describe("strict Hermes action output", () => {
  const context = () => buildTrustedHermesContext("customer_upset", "drain_cleaning", TENANT as any, RULES as any);

  test("maps a valid action code to fixed server guidance without returning model prose", async () => {
    let requestBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      requestBody = String(init.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"open_team_case"}' } }] }), { status: 200 });
    }) as typeof fetch;

    const result = await consultHermes("rocha-plumbing", context());

    expect(result).toEqual({
      status: "ok",
      action: "open_team_case",
      guidance: "Apologize briefly and open a team-review case.",
    });
    expect(requestBody).not.toMatch(/949|owner@|Oak|149|225|price_min|floor|caller said/i);
    expect(JSON.stringify(result)).not.toContain("choices");
  });

  for (const content of [
    "Open a case.",
    '```json\n{"action":"open_team_case"}\n```',
    '{"action":"open_team_case","advice":"quote $149"}',
    '{"action":"counter_at_149"}',
    '{"action":"open_team_case","amount":149}',
    "{not-json}",
  ]) {
    test(`rejects invalid, freeform, extra-field, or monetary output: ${content}`, async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content } }],
      }), { status: 200 })) as typeof fetch;
      expect(await consultHermes("rocha-plumbing", context())).toEqual({ status: "unavailable" });
    });
  }
});
