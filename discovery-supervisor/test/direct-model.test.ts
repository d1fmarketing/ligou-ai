import { describe, expect, test } from "bun:test";
import type { WorkerJob } from "../src/contracts";
import {
  DirectModelDiscoveryAdapter,
  type DirectModelRequest,
  type DirectModelTransport,
} from "../src/adapters/direct-model";

const sourceSnapshot = {
  url: "https://example.com/about",
  retrieved_at: "2026-09-01T10:00:00.000Z",
  http_status: 200,
  mime_type: "text/html" as const,
  byte_length: 164,
  content_hash: "c".repeat(64),
  excerpt: "Example Plumbing. Drain cleaning costs $149 and takes 90 minutes.",
  crawl_order: 0,
  crawl_depth: 0,
};

const job: WorkerJob = {
  job_type: "company_discovery.v1",
  job_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
  attempt_number: 1,
  fence_generation: 7,
  claim_token: "secret-claim-token",
  normalized_origin: "https://example.com/",
  deadline_at: "2026-09-01T10:10:00.000Z",
  budget: {
    max_pages: 25,
    max_depth: 2,
    max_page_bytes: 1_048_576,
    max_job_bytes: 10_485_760,
    deadline_seconds: 600,
  },
  source_snapshots: [sourceSnapshot],
};

describe("DirectModelDiscoveryAdapter", () => {
  test("derives a bounded result from already-fetched immutable evidence", async () => {
    let request: DirectModelRequest | undefined;
    const transport: DirectModelTransport = {
      async generate(candidate) {
        request = candidate;
        return {
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
          missing_questions: ["O preco publico de $149 ainda esta vigente?"],
          contradictions: [],
          uncertainty: {},
        };
      },
    };
    const adapter = new DirectModelDiscoveryAdapter(transport);

    const handle = await adapter.submit(job);
    const result = await adapter.result(handle);

    expect(result).toEqual({
      schema_version: "company_discovery.result.v1",
      source_snapshots: [sourceSnapshot],
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
      missing_questions: ["O preco publico de $149 ainda esta vigente?"],
      contradictions: [],
      uncertainty: {},
    });
    expect(await adapter.status(handle)).toEqual({ state: "succeeded" });
    expect(request).toEqual({
      schema_version: "company_discovery.model-output.v1",
      source_snapshots: [sourceSnapshot],
    });
    const serializedRequest = JSON.stringify(request);
    for (const forbidden of [
      "tenant_id",
      "job_id",
      "attempt_id",
      "fence_generation",
      "claim_token",
    ]) {
      expect(serializedRequest).not.toContain(forbidden);
    }
  });

  test("supports exactly company_discovery.v1", () => {
    const adapter = new DirectModelDiscoveryAdapter({
      async generate() {
        throw new Error("not called");
      },
    });

    expect(adapter.supports("company_discovery.v1")).toBe(true);
    expect(adapter.supports("general_workflow.v1" as never)).toBe(false);
  });

  test("rejects model attempts to replace evidence or author trusted identity", async () => {
    const adapter = new DirectModelDiscoveryAdapter({
      async generate() {
        return {
          source_snapshots: [],
          candidate_facts: [],
          missing_questions: [],
          contradictions: [],
          uncertainty: { tenant_id: "model-tenant" },
        };
      },
    });

    const handle = await adapter.submit(job);
    await expect(adapter.result(handle)).rejects.toThrow();
    expect(await adapter.status(handle)).toEqual({ state: "failed" });
  });

  test("cancels a running inference and never exposes its late result", async () => {
    let release!: () => void;
    const transport: DirectModelTransport = {
      async generate(_request, { signal }) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        expect(signal.aborted).toBe(true);
        return {
          candidate_facts: [],
          missing_questions: [],
          contradictions: [],
          uncertainty: {},
        };
      },
    };
    const adapter = new DirectModelDiscoveryAdapter(transport);
    const handle = await adapter.submit(job);

    expect(await adapter.status(handle)).toEqual({ state: "running" });
    await adapter.cancel(handle);
    release();

    expect(await adapter.status(handle)).toEqual({ state: "cancelled" });
    await expect(adapter.result(handle)).rejects.toThrow("cancelled");
  });
});
