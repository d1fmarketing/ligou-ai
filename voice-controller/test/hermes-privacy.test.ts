import { afterAll, expect, test } from "bun:test";
import { consultHermes } from "../src/hermes.ts";

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("Hermes live-call context redacts private pricing policy", async () => {
  let requestBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    requestBody = String(init.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "Use the public quote." } }] }), { status: 200 });
  }) as typeof fetch;

  const result = await consultHermes(
    "rocha-plumbing",
    "How should I respond?",
    "Caller offered $120. Internal floor is $149. price_min=149. Public quote is $225.",
  );

  expect(result.status).toBe("ok");
  expect(requestBody).toContain("Public quote is $225");
  expect(requestBody).not.toContain("$149");
  expect(requestBody).not.toMatch(/\b(?:floor|price_min|minimum)\b/i);
});
