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
import type {
  CleanupAuthority,
  RuntimeIdentityBinding,
} from "../src/job-store";
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

const runtimeSlotId = "44444444-4444-4444-8444-444444444444";
const runtimeIdentity: RuntimeIdentityBinding = {
  cell_container_name: "ligou-cell-a",
  bridge_container_name: "ligou-bridge-a",
  internal_network_name: "ligou-internal-a",
  egress_network_name: "ligou-egress-a",
  config_volume_name: "ligou-config-a",
  state_volume_name: "ligou-state-a",
  workspace_volume_name: "ligou-workspace-a",
  output_volume_name: "ligou-output-a",
  gateway_secret_volume_name: "ligou-gateway-secret-a",
  bridge_secret_volume_name: "ligou-bridge-secret-a",
  profile_name: "ligou-profile-a",
  loopback_port: 30_123,
};
const runtimeIdentityHash = "7518844113ab6430b45bd1b9fd96c6cb95bc47c41c1c4970e95a5726fc33ecc1";
const recoveryClaimRow = {
  job_id: job.job_id,
  attempt_id: job.attempt_id,
  attempt_number: 1,
  adapter_id: "openclaw",
  fence_generation: 3,
  claim_token: "claim-token",
  runtime_slot_id: runtimeSlotId,
  job_version: 2,
  normalized_origin: "https://example.com/",
  deadline_at: "2026-09-01T10:10:00+00:00",
  budget: job.budget,
};
const directClaimRow = {
  ...recoveryClaimRow,
  adapter_id: "direct_model",
  deadline_at: "2026-09-01T10:10:00.000Z",
};
const detailedCleanupProof = {
  gateway_exited: true,
  container_removed: true,
  bridge_removed: true,
  config_removed: true,
  state_removed: true,
  workspace_removed: true,
  output_removed: true,
  network_removed: true,
  credential_revoked: true,
  listener_closed: true,
  identity_process_absent: true,
  late_result_rejected: true,
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

describe("JobStore recovery authority seam", () => {
  test("claims an adapter-bound attempt with exact slot/version readback and trusted cleanup authority", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const store = new JobStore({
      async rpc(name, args) {
        calls.push({ name, args });
        return { data: [recoveryClaimRow], error: null };
      },
    });

    const claimed = await store.claimAttempt("openclaw-slot-1", "openclaw", 300);

    expect(calls).toEqual([{
      name: "claim_company_discovery_attempt",
      args: {
        p_worker_id: "openclaw-slot-1",
        p_adapter_id: "openclaw",
        p_lease_seconds: 300,
      },
    }]);
    expect(claimed).toEqual({
      job: { ...job, deadline_at: "2026-09-01T10:10:00+00:00", source_snapshots: [] },
      adapter_id: "openclaw",
      runtime_slot_id: runtimeSlotId,
      job_version: 2,
      cleanup_authority: {
        job_id: job.job_id,
        attempt_id: job.attempt_id,
        runtime_slot_id: runtimeSlotId,
        fence_generation: 3,
        claim_token: "claim-token",
      },
    });
    expect("tenant_id" in claimed!.job).toBe(false);
  });

  test("rejects claim adapter mismatch and extra readback fields", async () => {
    for (const data of [[{ ...recoveryClaimRow, adapter_id: "direct_model" }], [{
      ...recoveryClaimRow,
      tenant_id: "55555555-5555-4555-8555-555555555555",
    }]]) {
      const store = new JobStore({ async rpc() { return { data, error: null }; } });
      await expect(store.claimAttempt("openclaw-slot-2", "openclaw", 300)).rejects.toThrow(
        "claim readback",
      );
    }
  });

  test("binds one exact nonsecret runtime identity and terminalizes to rotated cleanup authority", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const store = new JobStore({
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === "claim_company_discovery_attempt")
          return { data: [recoveryClaimRow], error: null };
        if (name === "bind_company_discovery_runtime") {
          return {
            data: {
              attempt_id: job.attempt_id,
              runtime_slot_id: runtimeSlotId,
              job_id: job.job_id,
              job_version: 2,
              fence_generation: 3,
              runtime_identity: runtimeIdentity,
              runtime_identity_hash: runtimeIdentityHash,
            },
            error: null,
          };
        }
        if (name === "terminalize_company_discovery_attempt") {
          return {
            data: {
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              runtime_slot_id: runtimeSlotId,
              job_version: 3,
              fence_generation: 4,
              claim_token: "rotated-cleanup-token",
              status: "failed",
              cleanup_state: "pending",
            },
            error: null,
          };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    });
    const claimed = await store.claimAttempt("openclaw-slot-3", "openclaw", 300);

    expect(await store.bindRuntime(claimed!, runtimeIdentity)).toEqual({
      attempt_id: job.attempt_id,
      runtime_slot_id: runtimeSlotId,
      job_id: job.job_id,
      job_version: 2,
      fence_generation: 3,
      runtime_identity: runtimeIdentity,
      runtime_identity_hash: runtimeIdentityHash,
    });
    await expect(store.bindRuntime(claimed!, runtimeIdentity)).rejects.toThrow("already bound");
    const authority = await store.terminalizeAttempt(claimed!, "failed", "adapter_failed");
    expect(authority).toEqual({
      job_id: job.job_id,
      attempt_id: job.attempt_id,
      runtime_slot_id: runtimeSlotId,
      job_version: 3,
      fence_generation: 4,
      claim_token: "rotated-cleanup-token",
      runtime_identity: runtimeIdentity,
      runtime_identity_hash: runtimeIdentityHash,
      status: "failed",
      cleanup_state: "pending",
    });
    expect(calls[1]).toEqual({
      name: "bind_company_discovery_runtime",
      args: {
        p_attempt_id: job.attempt_id,
        p_fence_generation: 3,
        p_claim_token: "claim-token",
        p_runtime_identity: runtimeIdentity,
      },
    });
    expect(calls[2]).toEqual({
      name: "terminalize_company_discovery_attempt",
      args: {
        p_attempt_id: job.attempt_id,
        p_fence_generation: 3,
        p_claim_token: "claim-token",
        p_outcome: "failed",
        p_reason: "adapter_failed",
      },
    });
    expect(() => store.bindSourceSnapshots(claimed!.job, [snapshot])).toThrow("stale");
    await expect(store.recordCleanup(claimed!.cleanup_authority, detailedCleanupProof))
      .rejects.toThrow("stale");
  });

  test("reclaims expired cleanup repeatedly and accepts only the newest authority object", async () => {
    let reclaim = 0;
    const store = new JobStore({
      async rpc(name) {
        if (name === "claim_expired_company_discovery_cleanup") {
          reclaim += 1;
          return {
            data: [{
              job_id: job.job_id,
              attempt_id: job.attempt_id,
              adapter_id: "openclaw",
              runtime_slot_id: runtimeSlotId,
              runtime_identity: runtimeIdentity,
              fence_generation: 3 + reclaim,
              claim_token: `reaper-token-${reclaim}`,
              job_version: 3,
            }],
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
        throw new Error(`unexpected RPC ${name}`);
      },
    });

    const first = await store.claimExpiredCleanup("reaper-1", 300);
    const second = await store.claimExpiredCleanup("reaper-2", 300);

    expect(first).toMatchObject({
      adapter_id: "openclaw",
      runtime_identity: runtimeIdentity,
      runtime_identity_hash: runtimeIdentityHash,
      fence_generation: 4,
      claim_token: "reaper-token-1",
    });
    expect(second).toMatchObject({
      runtime_identity_hash: runtimeIdentityHash,
      fence_generation: 5,
      claim_token: "reaper-token-2",
    });
    await expect(store.recordCleanup(first!.cleanup_authority, detailedCleanupProof))
      .rejects.toThrow("stale");
    expect(await store.recordCleanup(second!.cleanup_authority, detailedCleanupProof)).toEqual({
      attempt_id: job.attempt_id,
      cleanup_state: "proved",
      slot_updated: true,
    });
    await expect(store.recordCleanup({ ...second!.cleanup_authority }, detailedCleanupProof))
      .rejects.toThrow("trusted cleanup authority");
  });

  test("treats an empty expired-cleanup readback as database-handled runtime_not_bound or idle", async () => {
    const store = new JobStore({
      async rpc(name, args) {
        expect(name).toBe("claim_expired_company_discovery_cleanup");
        expect(args).toEqual({ p_worker_id: "reaper-runtime-not-bound", p_lease_seconds: 300 });
        return { data: [], error: null };
      },
    });

    expect(await store.claimExpiredCleanup("reaper-runtime-not-bound", 300)).toBeNull();
  });

  test("rejects malformed bind, terminal, expired, and cleanup readbacks", async () => {
    const malformedByRpc: Record<string, unknown> = {
      bind_company_discovery_runtime: {
        attempt_id: job.attempt_id,
        runtime_slot_id: runtimeSlotId,
        job_id: job.job_id,
        job_version: 2,
        fence_generation: 3,
        runtime_identity: runtimeIdentity,
        runtime_identity_hash: runtimeIdentityHash,
        extra: true,
      },
      terminalize_company_discovery_attempt: {
        job_id: job.job_id,
        attempt_id: job.attempt_id,
        runtime_slot_id: runtimeSlotId,
        job_version: 3,
        fence_generation: 4,
        claim_token: "rotated-cleanup-token",
        status: "selected",
        cleanup_state: "pending",
      },
      claim_expired_company_discovery_cleanup: [{
        job_id: job.job_id,
        attempt_id: job.attempt_id,
        adapter_id: "openclaw",
        runtime_slot_id: runtimeSlotId,
        runtime_identity: { ...runtimeIdentity, claim_token: "forbidden" },
        fence_generation: 5,
        claim_token: "reaper-token",
        job_version: 3,
      }],
    };
    for (const target of Object.keys(malformedByRpc)) {
      const store = new JobStore({
        async rpc(name) {
          if (name === "claim_company_discovery_attempt")
            return { data: [recoveryClaimRow], error: null };
          if (name === "bind_company_discovery_runtime" &&
              target !== "bind_company_discovery_runtime") {
            return {
              data: {
                attempt_id: job.attempt_id,
                runtime_slot_id: runtimeSlotId,
                job_id: job.job_id,
                job_version: 2,
                fence_generation: 3,
                runtime_identity: runtimeIdentity,
                runtime_identity_hash: runtimeIdentityHash,
              },
              error: null,
            };
          }
          return { data: malformedByRpc[name], error: null };
        },
      });
      const claimed = await store.claimAttempt("openclaw-malformed", "openclaw", 300);
      if (target === "bind_company_discovery_runtime") {
        await expect(store.bindRuntime(claimed!, runtimeIdentity)).rejects.toThrow("runtime bind readback");
      } else if (target === "terminalize_company_discovery_attempt") {
        await store.bindRuntime(claimed!, runtimeIdentity).catch(() => undefined);
        await expect(store.terminalizeAttempt(claimed!, "failed", "adapter_failed"))
          .rejects.toThrow("terminal readback");
      } else {
        await expect(store.claimExpiredCleanup("reaper-malformed", 300))
          .rejects.toThrow("expired cleanup readback");
      }
    }
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
        return { data: [directClaimRow], error: null };
      },
    };
    const store = new JobStore(rpc);

    const claimed = await store.claimAttempt("direct-model-slot-1", "direct_model", 300);

    expect(calls).toEqual([{
      name: "claim_company_discovery_attempt",
      args: {
        p_worker_id: "direct-model-slot-1",
        p_adapter_id: "direct_model",
        p_lease_seconds: 300,
      },
    }]);
    expect(claimed?.job).toEqual({ ...job, source_snapshots: [] });
    expect("tenant_id" in claimed!.job).toBe(false);
    expect(store.bindSourceSnapshots(claimed!.job, [snapshot])).toEqual(job);
  });

  test("accepts the exact ISO offset returned for a timestamptz claim deadline", async () => {
    const store = new JobStore({
      async rpc() {
        return {
          data: [{ ...directClaimRow, deadline_at: "2026-09-01T10:10:00+00:00" }],
          error: null,
        };
      },
    });

    const claimed = await store.claimAttempt("direct-model-offset-slot", "direct_model", 300);

    expect(claimed?.job.deadline_at).toBe("2026-09-01T10:10:00+00:00");
  });

  test("allows terminal cleanup for a trusted attempt before evidence was fetched", async () => {
    const calls: string[] = [];
    const store = new JobStore({
      async rpc(name: string) {
        calls.push(name);
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [directClaimRow],
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
    const claimed = await store.claimAttempt("direct-model-slot-3", "direct_model", 300);

    await store.recordCleanup(claimed!.cleanup_authority, detailedCleanupProof);

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
            data: [directClaimRow],
            error: null,
          };
        }
        throw new Error("must not commit replaced evidence");
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-4", "direct_model", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!.job, [snapshot]);
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
            data: [directClaimRow],
            error: null,
          };
        }
        if (name === "bind_company_discovery_runtime") {
          return {
            data: {
              attempt_id: job.attempt_id,
              runtime_slot_id: runtimeSlotId,
              job_id: job.job_id,
              job_version: 2,
              fence_generation: 3,
              runtime_identity: runtimeIdentity,
              runtime_identity_hash: runtimeIdentityHash,
            },
            error: null,
          };
        }
        return { data: "not-a-result-uuid", error: null };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-5", "direct_model", 300);
    await store.bindRuntime(claimed!, runtimeIdentity);
    const trustedJob = store.bindSourceSnapshots(claimed!.job, [snapshot]);

    await expect(store.commitResult(trustedJob, result)).rejects.toThrow("commit readback");
  });

  test("rejects selection readbacks with extras or mismatched trusted identity", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [directClaimRow],
            error: null,
          };
        }
        return {
          data: {
            job_id: "55555555-5555-4555-8555-555555555555",
            attempt_id: job.attempt_id,
            result_id: "33333333-3333-4333-8333-333333333333",
            version: 3,
            fence_generation: 4,
            approval_state: "approved",
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-6", "direct_model", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!.job, [snapshot]);

    await expect(store.selectResult(trustedJob, 2)).rejects.toThrow("selection readback");
  });

  test("rejects exact selection readbacks for the wrong job identity", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [directClaimRow],
            error: null,
          };
        }
        return {
          data: {
            job_id: "55555555-5555-4555-8555-555555555555",
            attempt_id: job.attempt_id,
            result_id: "33333333-3333-4333-8333-333333333333",
            version: 3,
            fence_generation: 4,
          },
          error: null,
        };
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-9", "direct_model", 300);
    const trustedJob = store.bindSourceSnapshots(claimed!.job, [snapshot]);

    await expect(store.selectResult(trustedJob, 2)).rejects.toThrow("trusted identity");
  });

  test("rejects cleanup readbacks with wrong attempt, state, or extra fields", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [directClaimRow],
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
    const claimed = await store.claimAttempt("direct-model-slot-7", "direct_model", 300);

    await expect(store.recordCleanup(claimed!.cleanup_authority, detailedCleanupProof))
      .rejects.toThrow("cleanup readback");
  });

  test("rejects exact cleanup readbacks with wrong attempt and state", async () => {
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [directClaimRow],
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
    const claimed = await store.claimAttempt("direct-model-slot-10", "direct_model", 300);

    await expect(store.recordCleanup(claimed!.cleanup_authority, detailedCleanupProof))
      .rejects.toThrow("identity, state");
  });

  test("rejects class instances as cleanup proof JSON", async () => {
    class CleanupProofObject {
      gateway_exited = true;
      container_removed = true;
      bridge_removed = true;
      config_removed = true;
      state_removed = true;
      workspace_removed = true;
      output_removed = true;
      network_removed = true;
      credential_revoked = true;
      listener_closed = true;
      identity_process_absent = true;
      late_result_rejected = true;
    }
    const store = new JobStore({
      async rpc(name: string) {
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [directClaimRow],
            error: null,
          };
        }
        throw new Error("must reject before cleanup RPC");
      },
    });
    const claimed = await store.claimAttempt("direct-model-slot-8", "direct_model", 300);

    await expect(store.recordCleanup(
      claimed!.cleanup_authority,
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
            data: [directClaimRow],
            error: null,
          };
        }
        if (name === "bind_company_discovery_runtime") {
          return {
            data: {
              attempt_id: job.attempt_id,
              runtime_slot_id: runtimeSlotId,
              job_id: job.job_id,
              job_version: 2,
              fence_generation: 3,
              runtime_identity: runtimeIdentity,
              runtime_identity_hash: runtimeIdentityHash,
            },
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
              version: 3,
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
    const cleanupProof = detailedCleanupProof;

    const claimed = await store.claimAttempt("direct-model-slot-2", "direct_model", 300);
    await store.bindRuntime(claimed!, runtimeIdentity);
    const trustedJob = store.bindSourceSnapshots(claimed!.job, [snapshot]);
    expect(await store.commitResult(trustedJob, result)).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(await store.selectResult(trustedJob, 2)).toEqual({
      job_id: job.job_id,
      attempt_id: job.attempt_id,
      result_id: "33333333-3333-4333-8333-333333333333",
      version: 3,
      fence_generation: 4,
    });
    expect(await store.recordCleanup(claimed!.cleanup_authority, cleanupProof)).toEqual({
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
      "bind_company_discovery_runtime",
      "commit_company_discovery_result",
      "select_company_discovery_result",
      "record_company_discovery_cleanup",
      "quarantine_company_discovery_slot",
    ]);
    expect(calls[2]!.args).toEqual({
      p_attempt_id: job.attempt_id,
      p_fence_generation: 3,
      p_claim_token: "claim-token",
      p_result: result,
      p_result_hash: "f199655726b66c8a333468ce2432572ffaf0adbfb87713f615e9fc9878bad40d",
    });
    expect(calls[3]!.args).toEqual({
      p_job_id: job.job_id,
      p_attempt_id: job.attempt_id,
      p_expected_version: 2,
    });
    expect(calls[4]!.args).toEqual({
      p_attempt_id: job.attempt_id,
      p_fence_generation: 3,
      p_claim_token: "claim-token",
      p_proof: cleanupProof,
    });
    expect(calls[5]!.args).toEqual({
      p_slot_id: "44444444-4444-4444-8444-444444444444",
      p_reason: "cleanup_unresolved",
      p_proof_hash: "b".repeat(64),
    });
  });
});
