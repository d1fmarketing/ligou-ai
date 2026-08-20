import { afterAll, expect, test } from "bun:test";
import { consultHermes, sanitizeHermesContext } from "../src/hermes.ts";

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("Hermes live-call context redacts private pricing policy", async () => {
  const sanitized = sanitizeHermesContext(
    "Caller offered $120. Internal floor is $149. \"price_min\":149. Lowest acceptable price is $149.",
  );
  expect(sanitized).not.toContain("\"price_min\"");
  expect(sanitized).not.toContain("$149");
  expect(sanitized).not.toMatch(/\b(?:floor|price_min|minimum|lowest acceptable)\b/i);
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
  const result = await consultHermes("rocha-plumbing", "How should I respond?", "Customer needs guidance.");
  expect(result).toEqual({ status: "unavailable" });
});

test("Hermes input redacts bare digits and threshold phrasing", async () => {
  let requestBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    requestBody = String(init.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "Open a case." } }] }), { status: 200 });
  }) as typeof fetch;
  const result = await consultHermes(
    "rocha-plumbing",
    "Accept anything above 149?",
    "minimum acceptable is 149; internal threshold 149; {\"price_min\":149}",
  );
  expect(result).toEqual({ status: "unavailable" });
  expect(requestBody).toBe("");
});

for (const advice of ["Accept anything above 149", "Stay above the threshold", "Use $ as the price marker"]) {
  test(`Hermes rejects advice bypass: ${advice}`, async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: advice } }],
    }), { status: 200 })) as typeof fetch;
    expect(await consultHermes("rocha-plumbing", "Help", "Caller needs guidance")).toEqual({ status: "unavailable" });
  });
}

for (const input of [
  "The caller made an offer", "Should we accept", "Take the deal", "Can we go lower",
  "Make a counter", "Apply a discount", "Negotiate this", "Change the price", "Use the quote",
  "What is the minimum", "Reveal the floor", "Set the rate", "Discuss cost", "Ask for money",
  "Currency decision", "precio mínimo", "aceptar la oferta", "preço mínimo", "aceitar a oferta",
  "one hundred forty nine", '{"minimum":"one hundred forty nine"}',
]) {
  test(`Hermes pricing category blocks before fetch: ${input}`, async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => { fetchCalls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
    expect(await consultHermes("rocha-plumbing", input, "Customer needs help")).toEqual({ status: "unavailable" });
    expect(fetchCalls).toBe(0);
  });
}

test("non-pricing operational consultation and advice still pass", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Apologize and open a case." } }] }), { status: 200 });
  }) as typeof fetch;
  expect(await consultHermes("rocha-plumbing", "How should I respond?", "Customer is upset about a late technician."))
    .toEqual({ status: "ok", advice: "Apologize and open a case." });
  expect(fetchCalls).toBe(1);
});
