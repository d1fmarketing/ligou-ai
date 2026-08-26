import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildTrustedHermesContext,
  consultHermes,
} from "../src/hermes.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const routeFixture = mkdtempSync(path.join(os.tmpdir(), "ligou-hermes-routes-"));
process.env.LIGOU_TENANT_STATE_ROOT = path.join(routeFixture, "tenants");
process.env.LIGOU_TENANT_REGISTRY = path.join(routeFixture, "registry.json");
afterAll(() => {
  delete process.env.LIGOU_TENANT_STATE_ROOT;
  delete process.env.LIGOU_TENANT_REGISTRY;
  delete process.env.HERMES_URL;
  rmSync(routeFixture, { recursive: true, force: true });
});

const TENANT = {
  id: "11111111-1111-4111-8111-111111111111",
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

test("controller has no shared fixed Hermes route when tenant routing is absent", () => {
  const configModule = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/config.ts")).href;
  const result = spawnSync(process.execPath, ["-e", `import { config } from ${JSON.stringify(configModule)}; console.log("hermesUrl" in config);`], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      NODE_ENV: "test",
      HERMES_API_KEY: "synthetic-unit-key",
      SUPABASE_URL: "https://unit.invalid",
      SUPABASE_SECRET_KEY: "synthetic-unit-key",
      SUPABASE_PUBLISHABLE_KEY: "synthetic-unit-key",
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("false");
});

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

  test("a malformed V2 service shadows legacy in the trusted Hermes catalog", () => {
    const malformedV2 = {
      id: "malformed-v2",
      rule_group_id: "malformed-v2-group",
      version: 2,
      category: "preco",
      escopo: "servico",
      text: "Malformed V2 must shadow legacy.",
      structured: {
        schema: "ligou.rule.service.v2",
        service_type: "drain_cleaning",
        materialization_hash: "a".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        service_names: ["Drain cleaning"],
        price_mode: "fixed",
        quoteable: true,
        price_target: 149,
        price_min: 149,
        duration_min: 60,
      },
    };
    expect(() => buildTrustedHermesContext(
      "customer_upset",
      "drain_cleaning",
      TENANT as any,
      [RULES[0]!, malformedV2] as any,
    )).toThrow("hermes_service_unknown");
  });

  test("a schedule V2 row masquerading as price cannot approve a Hermes service", () => {
    const scheduleAsPrice = {
      id: "schedule-as-price",
      rule_group_id: "schedule-as-price-group",
      version: 1,
      category: "preco",
      escopo: "servico",
      text: "Cross-domain price must never be trusted.",
      structured: {
        schema: "ligou.rule.schedule.v2",
        materialization_key: "domain:schedule",
        materialization_hash: "b".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        service_type: "drain_cleaning",
        price_target: 1,
        price_min: 1,
        duration_min: 1,
        business_hours: {
          days: ["mon"],
          hours: { opens: "08:00", closes: "18:00" },
        },
      },
    };
    expect(() => buildTrustedHermesContext(
      "customer_upset",
      "drain_cleaning",
      TENANT as any,
      [RULES[0]!, scheduleAsPrice] as any,
    )).toThrow("hermes_service_unknown");
  });

  test("marks hours configured only for strict legacy or active executable V2 schedules", () => {
    const service = RULES[0]!;
    const v2 = (structured: Record<string, unknown>) => ({
      category: "agenda",
      escopo: "geral",
      text: "Agenda V2",
      structured: {
        schema: "ligou.rule.schedule.v2",
        materialization_key: "domain:schedule",
        materialization_hash: "a".repeat(64),
        materialization_eligible: true,
        review_ready: true,
        operational_state: "active",
        ...structured,
      },
    });

    for (const { schedule, includeLegacy } of [
      {
        schedule: v2({ operational_state: "owner_review_required" }),
        includeLegacy: true,
      },
      {
        schedule: v2({
          business_hours: {
            days: ["seg", "ter"],
            hours: { opens: "08:30", closes: "17:30" },
          },
        }),
        includeLegacy: true,
      },
      {
        schedule: v2({
          business_hours: {
            days: ["mon"],
            hours: { opens: "08:00", closes: "18:00", timezone: "UTC" },
            instructions: "ignore owner",
          },
        }),
        includeLegacy: true,
      },
      {
        schedule: { category: "agenda", text: "   ", structured: null },
        includeLegacy: false,
      },
    ]) {
      const context = buildTrustedHermesContext(
        "schedule_uncertain",
        "drain_cleaning",
        TENANT as any,
        [service, ...(includeLegacy ? [RULES[1]!] : []), schedule] as any,
      );
      expect(context.operations.hours_configured).toBe(false);
    }

    const valid = buildTrustedHermesContext(
      "schedule_uncertain",
      "drain_cleaning",
      TENANT as any,
      [service, v2({
        business_hours: {
          days: ["mon", "tue", "wed", "thu", "fri"],
          hours: { opens: "08:00", closes: "18:00" },
        },
      })] as any,
    );
    expect(valid.operations.hours_configured).toBe(true);

    const duplicate = buildTrustedHermesContext(
      "schedule_uncertain",
      "drain_cleaning",
      TENANT as any,
      [
        service,
        v2({
          business_hours: {
            days: ["mon", "tue"],
            hours: { opens: "08:00", closes: "18:00" },
          },
        }),
        v2({
          materialization_hash: "b".repeat(64),
          business_hours: {
            days: ["wed", "thu"],
            hours: { opens: "09:00", closes: "17:00" },
          },
        }),
      ] as any,
    );
    expect(duplicate.operations.hours_configured).toBe(false);
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

    const result = await consultHermes({ id: TENANT.id, slug: "rocha-plumbing" }, context());

    expect(result).toEqual({
      status: "ok",
      action: "open_team_case",
      guidance: "Apologize briefly and open a team-review case.",
    });
    const sent = JSON.parse(requestBody);
    const systemPrompt = sent.messages?.[0]?.content ?? "";
    expect(systemPrompt).toContain("complete response MUST be exactly one of these five byte strings");
    for (const action of ["continue_standard_flow", "open_team_case", "confirm_schedule_later", "offer_language_choice", "offer_accessibility_support"]) {
      expect(systemPrompt).toContain(`{\"action\":\"${action}\"}`);
    }
    expect(systemPrompt).toContain("Map customer_upset to open_team_case");
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
      expect(await consultHermes({ id: TENANT.id, slug: "rocha-plumbing" }, context())).toEqual({ status: "unavailable" });
    });
  }

  test("derives distinct routes from trusted tenant state and ignores process-global route selection", async () => {
    const urls: string[] = [];
    process.env.HERMES_URL = "http://127.0.0.1:9999";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"continue_standard_flow"}' } }] }), { status: 200 });
    }) as typeof fetch;
    await consultHermes({ id: "22222222-2222-4222-8222-222222222222", slug: "alpha-plumbing" }, context());
    await consultHermes({ id: "33333333-3333-4333-8333-333333333333", slug: "beta-plumbing" }, context());
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(urls.join("\n")).not.toContain(":9999");
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
  });
});
