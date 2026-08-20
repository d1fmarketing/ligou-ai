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
    return new Response(JSON.stringify({ choices: [{ message: { content: "Open a case for the team." } }] }), { status: 200 });
  }) as typeof fetch;

  const result = await consultHermes(
    "rocha-plumbing",
    "How should I respond?",
    "Caller offered $120. Internal floor is $149. \"price_min\":149. Lowest acceptable price is $149.",
  );

  expect(result.status).toBe("ok");
  expect(requestBody).not.toContain("\"price_min\"");
  expect(requestBody).not.toContain("$149");
  expect(requestBody).not.toMatch(/\b(?:floor|price_min|minimum|lowest acceptable)\b/i);
});

test("Hermes question is sanitized as strictly as context", async () => {
  let requestBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    requestBody = String(init.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "Open a case." } }] }), { status: 200 });
  }) as typeof fetch;
  await consultHermes("rocha-plumbing", "Can I reveal the lowest acceptable price of $149?", "Caller asked for help.");
  expect(requestBody).not.toContain("$149");
  expect(requestBody).not.toMatch(/lowest acceptable price/i);
});

test("Hermes monetary advice is rejected as non-authoritative", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Counter at $149, the lowest acceptable price." } }],
  }), { status: 200 })) as typeof fetch;
  const result = await consultHermes("rocha-plumbing", "How should I respond?", "Caller is negotiating.");
  expect(result).toEqual({ status: "unavailable" });
});
