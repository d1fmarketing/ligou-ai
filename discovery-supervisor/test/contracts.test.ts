import { describe, expect, test } from "bun:test";
import {
  parseWorkerJob,
  parseWorkerResult,
  type WorkerResult,
} from "../src/contracts";

const snapshot = {
  url: "https://example.com/about",
  retrieved_at: "2026-09-01T10:00:00.000Z",
  http_status: 200,
  mime_type: "text/html",
  byte_length: 128,
  content_hash: "a".repeat(64),
  excerpt: "Example Plumbing serves Orange County.",
  crawl_order: 0,
  crawl_depth: 0,
};

const validResult = {
  schema_version: "company_discovery.result.v1",
  source_snapshots: [snapshot],
  candidate_facts: [{
    claim_class: "descriptive",
    claim_type: "business_name",
    normalized_value: "Example Plumbing",
    evidence_refs: [0],
    contradictions: [],
    uncertainty: [],
  }, {
    claim_class: "operational",
    claim_type: "service",
    normalized_value: {
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      public_price: {
        amount: "149.00",
        currency: "USD",
        qualifier: "exact",
      },
      duration_minutes: 90,
    },
    evidence_refs: [0],
    contradictions: [],
    uncertainty: [],
  }],
  missing_questions: [
    "Qual é o preço mínimo privado e qual autoridade de desconto é permitida?",
  ],
  contradictions: [],
  uncertainty: [],
};

describe("company_discovery.result.v1 exact contract", () => {
  test("returns a detached immutable result with six exact top-level keys", () => {
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

  test("keeps website price public and rejects private floor or negotiation authority", () => {
    const service = validResult.candidate_facts[1]!;
    expect(parseWorkerResult(validResult).candidate_facts[1]!.normalized_value).toEqual({
      service_type: "drain_cleaning",
      service_names: ["Drain cleaning"],
      public_price: {
        amount: "149.00",
        currency: "USD",
        qualifier: "exact",
      },
      duration_minutes: 90,
    });

    for (const privateField of [
      { price_min: "120.00" },
      { negotiation_mode: "non_negotiable" },
      { discount_authority: "10_percent" },
    ]) {
      expect(() => parseWorkerResult({
        ...validResult,
        candidate_facts: [{
          ...service,
          normalized_value: {
            ...service.normalized_value as Record<string, unknown>,
            ...privateField,
          },
        }],
      })).toThrow();
    }
  });

  test("rejects authority-like fields structurally at every object boundary", () => {
    const service = validResult.candidate_facts[1]!;
    const cases: unknown[] = [
      { ...validResult, approval_state: "approved" },
      {
        ...validResult,
        candidate_facts: [{ ...validResult.candidate_facts[0]!, effective_rule_id: "rule" }],
      },
      {
        ...validResult,
        candidate_facts: [{
          ...service,
          normalized_value: {
            ...service.normalized_value as Record<string, unknown>,
            action_id: "action",
          },
        }],
      },
      { ...validResult, uncertainty: { tenant_identity: "tenant" } },
      {
        ...validResult,
        candidate_facts: [{
          ...validResult.candidate_facts[0]!,
          uncertainty: [{ canonical_id: "canonical" }],
        }],
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerResult(candidate)).toThrow();
    }
  });

  test("rejects arbitrary uncertainty objects without guessing forbidden key names", () => {
    const legacyShapeWithUnknownAlias = {
      ...validResult,
      candidate_facts: [{
        ...validResult.candidate_facts[0]!,
        uncertainty: {},
      }],
      uncertainty: { next_policy_phase: "automatic" },
    };

    expect(() => parseWorkerResult(legacyShapeWithUnknownAlias)).toThrow();
  });

  test("rejects owner-private facts while allowing Portuguese unanswered questions", () => {
    const candidate = structuredClone(validResult) as Record<string, any>;
    candidate.candidate_facts[0].claim_class = "owner_private";

    expect(() => parseWorkerResult(candidate)).toThrow("owner_private");
    expect(parseWorkerResult(validResult).missing_questions).toEqual([
      "Qual é o preço mínimo privado e qual autoridade de desconto é permitida?",
    ]);
  });

  test("rejects malformed, missing, duplicate, and out-of-range evidence", () => {
    const cases: unknown[] = [
      { ...validResult, source_snapshots: [{ ...snapshot, mime_type: "application/pdf" }] },
      { ...validResult, source_snapshots: [{ ...snapshot, crawl_order: 1 }] },
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
          ...snapshot,
          url: `https://example.com/${index}`,
          crawl_order: index,
        })),
      },
      {
        ...validResult,
        candidate_facts: Array.from({ length: 101 }, () => validResult.candidate_facts[0]),
      },
      { ...validResult, missing_questions: Array.from({ length: 51 }, () => "Question?") },
      { ...validResult, contradictions: Array.from({ length: 51 }, () => "Contradiction") },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerResult(candidate)).toThrow();
    }
  });

  test("rejects non-plain objects", () => {
    class ModelObject {
      candidate_facts: unknown[] = [];
      missing_questions: string[] = [];
      contradictions: string[] = [];
      uncertainty: string[] = [];
    }

    expect(() => parseWorkerResult(new Date())).toThrow("plain object");
    expect(() => parseWorkerResult(new Map())).toThrow("plain object");
    expect(() => parseWorkerResult(new ModelObject())).toThrow("plain object");
    expect(() => parseWorkerResult({ ...validResult, uncertainty: new Date() })).toThrow();
  });

  test("accepts only integer numeric fields and decimal-string public prices", () => {
    const service = validResult.candidate_facts[1]!;
    for (const invalid of [
      { ...snapshot, byte_length: 1e-1 },
      { ...snapshot, crawl_depth: 1.5 },
    ]) {
      expect(() => parseWorkerResult({ ...validResult, source_snapshots: [invalid] })).toThrow();
    }
    for (const invalidPrice of [149, "149", "1.49e2", "0149.00", "149.000"] as unknown[]) {
      expect(() => parseWorkerResult({
        ...validResult,
        candidate_facts: [{
          ...service,
          normalized_value: {
            ...service.normalized_value as Record<string, unknown>,
            public_price: {
              amount: invalidPrice,
              currency: "USD",
              qualifier: "exact",
            },
          },
        }],
      })).toThrow();
    }
  });

  test("enforces lower per-job page, depth, page-byte, and total-byte budgets", () => {
    const baseJob = {
      job_type: "company_discovery.v1",
      job_id: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222",
      attempt_number: 1,
      fence_generation: 3,
      claim_token: "claim-token",
      normalized_origin: "https://example.com/",
      deadline_at: "2026-09-01T10:10:00.000Z",
      budget: {
        max_pages: 1,
        max_depth: 0,
        max_page_bytes: 128,
        max_job_bytes: 128,
        deadline_seconds: 600,
      },
      source_snapshots: [snapshot],
    };
    expect(parseWorkerJob(baseJob).source_snapshots).toHaveLength(1);

    const cases: unknown[] = [
      {
        ...baseJob,
        source_snapshots: [snapshot, { ...snapshot, url: "https://example.com/2", crawl_order: 1 }],
      },
      { ...baseJob, source_snapshots: [{ ...snapshot, crawl_depth: 1 }] },
      { ...baseJob, source_snapshots: [{ ...snapshot, byte_length: 129 }] },
      {
        ...baseJob,
        budget: { ...baseJob.budget, max_pages: 2, max_job_bytes: 200 },
        source_snapshots: [
          snapshot,
          { ...snapshot, url: "https://example.com/2", byte_length: 80, crawl_order: 1 },
        ],
      },
    ];
    for (const candidate of cases) {
      expect(() => parseWorkerJob(candidate)).toThrow("budget");
    }
  });
});
