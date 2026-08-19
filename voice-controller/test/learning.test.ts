// Learning pipeline unit tests — redaction and strict proposal validation ($0).
import { describe, expect, test } from "bun:test";
import { redactEvidence, validateProposals } from "../src/learning.ts";

describe("redactEvidence", () => {
  test("masks long digit runs and emails; drops system lines; truncates", () => {
    const out = redactEvidence([
      { role: "caller", text: "my card is 4111111111111111 and email bob@x.com, gate code 4321" },
      { role: "system", text: "internal" },
      { role: "agent", text: "a".repeat(1000) },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("[number-redacted]");
    expect(out[0].text).toContain("[email-redacted]");
    expect(out[0].text).toContain("4321"); // short codes stay — they're the useful memory
    expect(out[1].text.length).toBeLessThanOrEqual(600);
  });
});

describe("validateProposals (strict — malformed is rejected, never repaired)", () => {
  test("accepts well-formed proposals only", () => {
    const out = validateProposals([
      { text: "Customer at 12 Oak St has two dogs; use the side gate.", category: "cliente", escopo: "cliente", evidence: "I have two dogs" },
      { text: "bad category", category: "hack", escopo: "geral" },
      { text: "", category: "cliente", escopo: "cliente" },
      "not-an-object",
      { text: "bad escopo", category: "cliente", escopo: "everything" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("two dogs");
  });
  test("non-array input yields nothing", () => {
    expect(validateProposals({ evil: true })).toHaveLength(0);
    expect(validateProposals("[]")).toHaveLength(0);
  });
  test("caps volume at 8 proposals", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `fact ${i}`, category: "geral", escopo: "geral" }));
    expect(validateProposals(many)).toHaveLength(8);
  });
});
