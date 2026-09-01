import { describe, expect, test } from "bun:test";
import type {
  DiscoveryAdapterId,
  WorkerAdapter,
  WorkerHandle,
  WorkerJob,
  WorkerResult,
  WorkerStatus,
} from "../src/contracts";
import { JobStore } from "../src/job-store";
import { WorkerBroker } from "../src/worker-broker";

const snapshot = {
  url: "https://example.com/about",
  retrieved_at: "2026-09-01T10:00:00.000Z",
  http_status: 200,
  mime_type: "text/html" as const,
  byte_length: 128,
  content_hash: "a".repeat(64),
  excerpt: "Example Plumbing serves Orange County.",
  crawl_order: 0,
  crawl_depth: 0,
};

const job: WorkerJob = {
  job_type: "company_discovery.v1",
  job_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
  attempt_number: 1,
  fence_generation: 3,
  claim_token: "claim-token",
  normalized_origin: "https://example.com/",
  deadline_at: "2026-09-01T10:10:00.000Z",
  budget: {
    max_pages: 25,
    max_depth: 2,
    max_page_bytes: 1_048_576,
    max_job_bytes: 10_485_760,
    deadline_seconds: 600,
  },
  source_snapshots: [snapshot],
};

const result: WorkerResult = {
  schema_version: "company_discovery.result.v1",
  source_snapshots: [snapshot],
  candidate_facts: [{
    claim_class: "descriptive",
    claim_type: "business_name",
    normalized_value: "Example Plumbing",
    evidence_refs: [0],
    contradictions: [],
    uncertainty: [],
  }],
  missing_questions: [],
  contradictions: [],
  uncertainty: [],
};

class MemoryAdapter implements WorkerAdapter {
  #state: WorkerStatus = { state: "running" };
  #result: WorkerResult;

  constructor(
    private readonly adapterId: DiscoveryAdapterId,
    candidate: WorkerResult = result,
  ) {
    this.#result = candidate;
  }

  supports(jobType: string): boolean {
    return jobType === "company_discovery.v1";
  }

  async submit(candidate: WorkerJob): Promise<WorkerHandle> {
    this.#state = { state: "succeeded" };
    return {
      adapter_id: this.adapterId,
      job_type: candidate.job_type,
      job_id: candidate.job_id,
      attempt_id: candidate.attempt_id,
      fence_generation: candidate.fence_generation,
    };
  }

  async cancel(_handle: WorkerHandle): Promise<void> {
    this.#state = { state: "cancelled" };
  }

  async status(_handle: WorkerHandle): Promise<WorkerStatus> {
    return this.#state;
  }

  async result(_handle: WorkerHandle): Promise<WorkerResult> {
    return this.#result;
  }
}

describe("WorkerBroker", () => {
  test("routes all four lifecycle methods to one capable selected adapter", async () => {
    const broker = new WorkerBroker({ direct_model: new MemoryAdapter("direct_model") });

    const handle = await broker.submit("direct_model", job);
    expect(handle).toEqual({
      adapter_id: "direct_model",
      job_type: "company_discovery.v1",
      job_id: job.job_id,
      attempt_id: job.attempt_id,
      fence_generation: 3,
    });
    expect(await broker.status(handle)).toEqual({ state: "succeeded" });
    expect(await broker.result(handle)).toEqual(result);
    await broker.cancel(handle);
    expect(await broker.status(handle)).toEqual({ state: "cancelled" });
  });

  test("supports only company_discovery.v1 and the two fixed adapter IDs", async () => {
    const broker = new WorkerBroker({ direct_model: new MemoryAdapter("direct_model") });

    await expect(broker.submit("openclaw", job)).rejects.toThrow("adapter unavailable");
    await expect(broker.submit(
      "direct_model",
      { ...job, job_type: "general_workflow.v1" } as unknown as WorkerJob,
    )).rejects.toThrow("company_discovery.v1");
    await expect(broker.submit(
      "marketplace" as DiscoveryAdapterId,
      job,
    )).rejects.toThrow("adapter");
  });

  test("rejects a capable adapter that returns a handle for another attempt", async () => {
    class WrongHandleAdapter extends MemoryAdapter {
      override async submit(candidate: WorkerJob): Promise<WorkerHandle> {
        return { ...(await super.submit(candidate)), attempt_id: crypto.randomUUID() };
      }
    }
    const broker = new WorkerBroker({
      direct_model: new WrongHandleAdapter("direct_model"),
    });

    await expect(broker.submit("direct_model", job)).rejects.toThrow("handle identity");
  });

  test("normalizes and detaches adapter results before returning them", async () => {
    const mutable = structuredClone(result) as WorkerResult;
    const broker = new WorkerBroker({
      direct_model: new MemoryAdapter("direct_model", mutable),
    });
    const handle = await broker.submit("direct_model", job);

    const normalized = await broker.result(handle);
    (mutable.source_snapshots[0] as { excerpt: string }).excerpt = "mutated";

    expect(normalized.source_snapshots[0]!.excerpt).toBe(snapshot.excerpt);
    expect(Object.isFrozen(normalized)).toBe(true);
  });
});

describe("JobStore service RPC boundary", () => {
  test("rejects caller-authored job and fence identity that did not come from claim readback", async () => {
    const store = new JobStore({
      async rpc() {
        throw new Error("must not call RPC for untrusted identity");
      },
    });

    await expect(store.commitResult(job, result)).rejects.toThrow("trusted claim readback");
  });

  test("constructs trusted job identity only from the claim RPC readback", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return {
          data: [{
            job_id: job.job_id,
            attempt_id: job.attempt_id,
            attempt_number: 1,
            fence_generation: 3,
            claim_token: "claim-token",
            normalized_origin: "https://example.com/",
            deadline_at: "2026-09-01T10:10:00.000Z",
            budget: job.budget,
          }],
          error: null,
        };
      },
    };
    const store = new JobStore(rpc);

    const claimed = await store.claimAttempt("direct-model-slot-1", 300);

    expect(calls).toEqual([{
      name: "claim_company_discovery_attempt",
      args: { p_worker_id: "direct-model-slot-1", p_lease_seconds: 300 },
    }]);
    expect(claimed).toEqual({ ...job, source_snapshots: [] });
    expect("tenant_id" in claimed!).toBe(false);
    expect(store.bindSourceSnapshots(claimed!, [snapshot])).toEqual(job);
  });

  test("allows terminal cleanup for a trusted attempt before evidence was fetched", async () => {
    const calls: string[] = [];
    const store = new JobStore({
      async rpc(name: string) {
        calls.push(name);
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        return {
          data: {
            attempt_id: job.attempt_id,
            cleanup_state: "proved",
            slot_updated: true,
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-3", 300);

    await store.recordCleanup(claimed!, {
      gateway_exited: true,
      container_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_revoked: true,
      listener_closed: true,
      late_result_rejected: true,
    });

    expect(calls).toEqual([
      "claim_company_discovery_attempt",
      "record_company_discovery_cleanup",
    ]);
  });

  test("rejects a result whose evidence snapshots differ from the trusted fetched evidence", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        throw new Error("must not commit replaced evidence");
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-4", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!, [snapshot]);
    const replacedEvidence = {
      ...result,
      source_snapshots: [{ ...snapshot, excerpt: "model-authored replacement" }],
    };

    await expect(store.commitResult(trustedJob, replacedEvidence)).rejects.toThrow(
      "trusted fetched evidence",
    );
  });

  test("rejects a non-UUID commit readback", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        return { data: "not-a-result-uuid", error: null };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-5", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!, [snapshot]);

    await expect(store.commitResult(trustedJob, result)).rejects.toThrow("commit readback");
  });

  test("rejects selection readbacks with extras or mismatched trusted identity", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        return {
          data: {
            job_id: "55555555-5555-4555-8555-555555555555",
            attempt_id: job.attempt_id,
            result_id: "33333333-3333-4333-8333-333333333333",
            version: 8,
            fence_generation: 4,
            approval_state: "approved",
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-6", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!, [snapshot]);

    await expect(store.selectResult(trustedJob, 7)).rejects.toThrow("selection readback");
  });

  test("rejects exact selection readbacks for the wrong job identity", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        return {
          data: {
            job_id: "55555555-5555-4555-8555-555555555555",
            attempt_id: job.attempt_id,
            result_id: "33333333-3333-4333-8333-333333333333",
            version: 8,
            fence_generation: 4,
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-9", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!, [snapshot]);

    await expect(store.selectResult(trustedJob, 7)).rejects.toThrow("trusted identity");
  });

  test("rejects cleanup readbacks with wrong attempt, state, or extra fields", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        return {
          data: {
            attempt_id: "66666666-6666-4666-8666-666666666666",
            cleanup_state: "available",
            slot_updated: true,
            status: "done",
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-7", 300);

    await expect(store.recordCleanup(claimed!, {
      gateway_exited: true,
      container_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_revoked: true,
      listener_closed: true,
      late_result_rejected: true,
    })).rejects.toThrow("cleanup readback");
  });

  test("rejects exact cleanup readbacks with wrong attempt and state", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        return {
          data: {
            attempt_id: "66666666-6666-4666-8666-666666666666",
            cleanup_state: "available",
            slot_updated: true,
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-10", 300);

    await expect(store.recordCleanup(claimed!, {
      gateway_exited: true,
      container_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_revoked: true,
      listener_closed: true,
      late_result_rejected: true,
    })).rejects.toThrow("identity, state");
  });

  test("rejects class instances as cleanup proof JSON", async () => {
    class CleanupProofObject {
      gateway_exited = true;
      container_removed = true;
      state_removed = true;
      workspace_removed = true;
      output_removed = true;
      network_removed = true;
      credential_revoked = true;
      listener_closed = true;
      late_result_rejected = true;
    }
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        throw new Error("must reject before cleanup RPC");
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-8", 300);

    await expect(store.recordCleanup(
      claimed!,
      new CleanupProofObject(),
    )).rejects.toThrow("plain object");
  });

  test("rejects non-null quarantine readbacks", async () => {
    const store = new JobStore({
      async rpc() {
        return { data: { ok: true }, error: null };
      },
    });

    await expect(store.quarantineSlot(
      "44444444-4444-4444-8444-444444444444",
      "cleanup_unresolved",
      "b".repeat(64),
    )).rejects.toThrow("quarantine readback");
  });

  test("commits, selects, cleans up, and quarantines only through fixed service RPCs", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              attempt_number: 1,
              fence_generation: 3,
              claim_token: "claim-token",
              normalized_origin: "https://example.com/",
              deadline_at: "2026-09-01T10:10:00.000Z",
              budget: job.budget,
            }],
            error: null,
          };
        }
        if (name === "commit_company_discovery_result")
          return { data: "33333333-3333-4333-8333-333333333333", error: null };
        if (name === "select_company_discovery_result") {
          return {
            data: {
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              result_id: "33333333-3333-4333-8333-333333333333",
              version: 8,
              fence_generation: 4,
            },
            error: null,
          };
        }
        if (name === "record_company_discovery_cleanup") {
          return {
            data: {
              attempt_id: job.attempt_id,
              cleanup_state: "proved",
              slot_updated: true,
            },
            error: null,
          };
        }
        if (name === "quarantine_company_discovery_slot")
          return { data: null, error: null };
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const store = new JobStore(rpc);
    const cleanupProof = {
      gateway_exited: true,
      container_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_revoked: true,
      listener_closed: true,
      late_result_rejected: true,
    };

    const claimed = await store.claimAttempt("direct-model-slot-2", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!, [snapshot]);
    expect(await store.commitResult(trustedJob, result)).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(await store.selectResult(trustedJob, 7)).toEqual({
      job_id: job.job_id,
      attempt_id: job.attempt_id,
      result_id: "33333333-3333-4333-8333-333333333333",
      version: 8,
      fence_generation: 4,
    });
    expect(await store.recordCleanup(trustedJob, cleanupProof)).toEqual({
      attempt_id: job.attempt_id,
      cleanup_state: "proved",
      slot_updated: true,
    });
    expect(await store.quarantineSlot(
      "44444444-4444-4444-8444-444444444444",
      "cleanup_unresolved",
      "b".repeat(64),
    )).toBeUndefined();

    expect(calls.map((call) => call.name)).toEqual([
      "claim_company_discovery_attempt",
      "commit_company_discovery_result",
      "select_company_discovery_result",
      "record_company_discovery_cleanup",
      "quarantine_company_discovery_slot",
    ]);
    expect(calls[1]!.args).toEqual({
      p_attempt_id: job.attempt_id,
      p_fence_generation: 3,
      p_claim_token: "claim-token",
      p_result: result,
      p_result_hash: "f199655726b66c8a333468ce2432572ffaf0adbfb87713f615e9fc9878bad40d",
    });
    expect(calls[2]!.args).toEqual({
      p_job_id: job.job_id,
      p_attempt_id: job.attempt_id,
      p_expected_version: 7,
    });
    expect(calls[3]!.args).toEqual({
      p_attempt_id: job.attempt_id,
      p_fence_generation: 3,
      p_claim_token: "claim-token",
      p_proof: cleanupProof,
    });
    expect(calls[4]!.args).toEqual({
      p_slot_id: "44444444-4444-4444-8444-444444444444",
      p_reason: "cleanup_unresolved",
      p_proof_hash: "b".repeat(64),
    });
  });
});
