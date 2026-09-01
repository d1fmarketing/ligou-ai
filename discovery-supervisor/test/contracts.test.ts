import { describe, expect, test } from "bun:test";
import { parseWorkerResult, type WorkerResult } from "../src/contracts";

const validResult = {
  schema_version: "company_discovery.result.v1",
  source_snapshots: [{
    url: "https://example.com/about",
    retrieved_at: "2026-09-01T10:00:00.000Z",
    http_status: 200,
    mime_type: "text/html",
    byte_length: 128,
    content_hash: "a".repeat(64),
    excerpt: "Example Plumbing serves Orange County.",
    crawl_order: 0,
    crawl_depth: 0,
  }],
  candidate_facts: [{
    claim_class: "descriptive",
    claim_type: "business_name",
    normalized_value: "Example Plumbing",
    evidence_refs: [0],
    contradictions: [],
    uncertainty: {},
  }, {
    claim_class: "operational",
    claim_type: "service",
    normalized_value: {
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      price_mode: "fixed",
      negotiation_mode: "non_negotiable",
      price_target: 149,
      price_min: 149,
      duration_min: 90,
    },
    evidence_refs: [0],
    contradictions: [],
    uncertainty: {},
  }],
  missing_questions: ["Qual e o preco minimo privado autorizado?"],
  contradictions: [],
  uncertainty: {},
};

describe("company_discovery.result.v1 contract", () => {
  test("returns a detached immutable result with the six exact top-level keys", () => {
    const parsed = parseWorkerResult(validResult);

    expect(parsed).toEqual(validResult as unknown as WorkerResult);
    expect(parsed).not.toBe(validResult);
    expect(Object.keys(parsed)).toEqual([
      "schema_version",
      "source_snapshots",
      "candidate_facts",
      "missing_questions",
      "contradictions",
      "uncertainty",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.source_snapshots[0]!)).toBe(true);
  });

  test("rejects authority, identity, approval, effective, and action fields at any depth", () => {
    const cases: Array<[string, unknown]> = [
      ["tenant identity", { ...validResult, tenant_id: "tenant-from-model" }],
      ["nested tenant identity", {
        ...validResult,
        uncertainty: { tenant_id: "tenant-from-model" },
      }],
      ["canonical identity", {
        ...validResult,
        uncertainty: { canonical_id: "canonical-from-model" },
      }],
      ["approval", {
        ...validResult,
        candidate_facts: [{
          ...validResult.candidate_facts[0]!,
          normalized_value: { value: "Example Plumbing", approved: true },
        }],
      }],
      ["effective state", {
        ...validResult,
        candidate_facts: [{ ...validResult.candidate_facts[0]!, effective: true }],
      }],
      ["action completion", {
        ...validResult,
        uncertainty: { action_completion: "done" },
      }],
      ["authority grant", {
        ...validResult,
        uncertainty: { authority: "book_without_owner" },
      }],
    ];

    for (const [label, candidate] of cases) {
      expect(() => parseWorkerResult(candidate), label).toThrow();
    }
  });

  test("rejects owner-private facts while allowing owner-private unanswered questions", () => {
    const candidate = structuredClone(validResult) as Record<string, any>;
    candidate.candidate_facts[0].claim_class = "owner_private";

    expect(() => parseWorkerResult(candidate)).toThrow("owner_private");
    expect(parseWorkerResult(validResult).missing_questions).toEqual([
      "Qual e o preco minimo privado autorizado?",
    ]);
  });

  test("rejects malformed, missing, duplicate, and out-of-range evidence", () => {
    const cases: unknown[] = [
      {
        ...validResult,
        source_snapshots: [{ ...validResult.source_snapshots[0]!, mime_type: "application/pdf" }],
      },
      {
        ...validResult,
        source_snapshots: [{ ...validResult.source_snapshots[0]!, crawl_order: 1 }],
      },
      {
        ...validResult,
        candidate_facts: [{ ...validResult.candidate_facts[0]!, evidence_refs: [] }],
      },
      {
        ...validResult,
        candidate_facts: [{ ...validResult.candidate_facts[0]!, evidence_refs: [0, 0] }],
      },
      {
        ...validResult,
        candidate_facts: [{ ...validResult.candidate_facts[0]!, evidence_refs: [1] }],
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerResult(candidate)).toThrow();
    }
  });

  test("rejects oversize values and unbounded result collections", () => {
    const cases: unknown[] = [
      {
        ...validResult,
        candidate_facts: [{
          ...validResult.candidate_facts[0]!,
          normalized_value: "x".repeat(2_001),
        }],
      },
      {
        ...validResult,
        source_snapshots: Array.from({ length: 26 }, (_, index) => ({
          ...validResult.source_snapshots[0]!,
          url: `https://example.com/${index}`,
          crawl_order: index,
        })),
      },
      {
        ...validResult,
        candidate_facts: Array.from({ length: 101 }, () => validResult.candidate_facts[0]),
      },
      {
        ...validResult,
        missing_questions: Array.from({ length: 51 }, () => "Question?"),
      },
      {
        ...validResult,
        contradictions: Array.from({ length: 51 }, () => "Contradiction"),
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerResult(candidate)).toThrow();
    }
  });

  test("rejects extra claim keys and invalid supported materialization values", () => {
    const cases: unknown[] = [
      {
        ...validResult,
        candidate_facts: [{ ...validResult.candidate_facts[0]!, confidence: 1 }],
      },
      {
        ...validResult,
        candidate_facts: [{
          ...validResult.candidate_facts[1]!,
          normalized_value: {
            ...validResult.candidate_facts[1]!.normalized_value as Record<string, unknown>,
            price_min: 150,
          },
        }],
      },
      {
        ...validResult,
        candidate_facts: [{
          ...validResult.candidate_facts[1]!,
          claim_type: "authority",
        }],
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerResult(candidate)).toThrow();
    }
  });
});
