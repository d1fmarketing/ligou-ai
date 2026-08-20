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

test("Hermes input redacts bare digits and threshold phrasing", async () => {
  let requestBody = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    requestBody = String(init.body ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: "Open a case." } }] }), { status: 200 });
  }) as typeof fetch;
  await consultHermes(
    "rocha-plumbing",
    "Accept anything above 149?",
    "minimum acceptable is 149; internal threshold 149; {\"price_min\":149}",
  );
  expect(requestBody).not.toMatch(/149|minimum acceptable|threshold|price_min/i);
});

for (const advice of ["Accept anything above 149", "Stay above the threshold", "Use $ as the price marker"]) {
  test(`Hermes rejects advice bypass: ${advice}`, async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: advice } }],
    }), { status: 200 })) as typeof fetch;
    expect(await consultHermes("rocha-plumbing", "Help", "Caller is negotiating")).toEqual({ status: "unavailable" });
  });
}
