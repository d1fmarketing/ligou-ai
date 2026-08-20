// Learning pipeline unit tests — redaction and strict proposal validation ($0).
import { describe, expect, test } from "bun:test";
import { redactEvidence, validateProposals } from "../src/learning.ts";

describe("redactEvidence", () => {
  test("uses the shared redactor for contact, payment, address, and access data", () => {
    const out = redactEvidence([
      { role: "caller", text: "card 4111 1111 1111 1111; bob@x.com; 123 Oak St; gate code 4321; phone (949) 555-0101" },
      { role: "system", text: "internal" },
      { role: "agent", text: "a".repeat(1000) },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("[payment-redacted]");
    expect(out[0].text).toContain("[email-redacted]");
    expect(out[0].text).toContain("[address-redacted]");
    expect(out[0].text).toContain("[access-code-redacted]");
    expect(out[0].text).toContain("[phone-redacted]");
    expect(out[0].text).not.toMatch(/4321|4111|123 Oak|949/);
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
  test("redacts sensitive model-authored proposal and evidence fields before staging", () => {
    const [proposal] = validateProposals([{
      text: "Use gate code 4321 at 123 Oak Street and call (949) 555-0101",
      category: "cliente",
      escopo: "cliente",
      evidence: "My PIN is 4321 and card is 4111 1111 1111 1111",
    }]);
    expect(JSON.stringify(proposal)).not.toMatch(/4321|123 Oak|949|4111/);
    expect(proposal.text).toContain("[access-code-redacted]");
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
