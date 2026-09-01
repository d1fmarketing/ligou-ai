import { describe, expect, test } from "bun:test";
import type {
  DiscoveryAdapterId,
  DiscoverySourceSnapshot,
  ModelAccessCapability,
  SubscriptionGateway,
  SubscriptionLeaseCapability,
  SubscriptionRecoveryCapability,
  SubscriptionRevocationReadback,
  SubscriptionUsage,
  WorkerHandle,
  WorkerJob,
  WorkerResult,
  WorkerStatus,
} from "../src/contracts";
import { JobStore } from "../src/job-store";
import type {
  CleanupProof,
  CleanupReadback,
  CommittedResultCapability,
  RuntimeSlotCapability,
  SelectionReadback,
} from "../src/job-store";
import {
  CellRuntime,
  type CellRuntimeDependencies,
  type CommandRunner,
  type CommandSpec,
  type DetailedCleanupProof,
  type RuntimeCleanupProof,
  storeCleanupProof,
} from "../src/openclaw/cell-runtime";
import {
  AttemptRuntimeIdentityRegistry,
  allocateDirectModelRuntimeIdentity,
  allocateRuntimeIdentity,
  runtimeIdentityBinding,
  type RuntimeIdentityBinding,
} from "../src/openclaw/runtime-identity";
import {
  EphemeralOpenClawAttemptFactory,
  OpenClawDiscoveryAdapter,
  type AttemptCellRuntime,
  type AttemptGatewayRunner,
  type OpenClawAttemptFactory,
  type OpenClawAttemptSession,
} from "../src/adapters/openclaw";
import type { GatewayRunHandle, GatewayRunInput } from "../src/openclaw/gateway-client";
import {
  DiscoverySupervisor,
  type SupervisorBroker,
  type SupervisorCleanupAuthority,
  type SupervisorClaimedAttempt,
  type SupervisorExpiredCleanupClaim,
  type SupervisorExpiredCleanupRecovery,
  type SupervisorFetchGateway,
  type SupervisorRuntimeBindReadback,
  type SupervisorStore,
} from "../src/supervisor";

const snapshot: DiscoverySourceSnapshot = {
  url: "https://example.com/",
  retrieved_at: "2026-09-01T10:00:00.000Z",
  http_status: 200,
  mime_type: "text/html",
  byte_length: 128,
  content_hash: "c".repeat(64),
  excerpt: "[UNTRUSTED WEBSITE EVIDENCE]\nExample Plumbing",
  crawl_order: 0,
  crawl_depth: 0,
};

const claimedJob: WorkerJob = {
  job_type: "company_discovery.v1",
  job_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
  attempt_number: 1,
  fence_generation: 7,
  normalized_origin: "https://example.com/",
  deadline_at: "2026-09-01T10:10:00.000Z",
  budget: {
    max_pages: 25,
    max_depth: 2,
    max_page_bytes: 1_048_576,
    max_job_bytes: 10_485_760,
    deadline_seconds: 600,
  },
  source_snapshots: [],
};

const boundJob: WorkerJob = { ...claimedJob, source_snapshots: [snapshot] };
const modelAccess = Object.freeze(Object.create(null)) as ModelAccessCapability;

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

const completeRuntimeProof: RuntimeCleanupProof = {
  gateway_exited: true,
  cell_removed: true,
  bridge_removed: true,
  config_removed: true,
  state_removed: true,
  workspace_removed: true,
  output_removed: true,
  network_removed: true,
  credential_material_removed: true,
  listener_closed: true,
  no_identity_process: true,
};
const completeRevocation = (generation: number): SubscriptionRevocationReadback =>
  Object.freeze({
    generation,
    subscription_lease_revoked: true,
    subscription_requests_drained: true,
    subscription_listener_closed: true,
    subscription_socket_absent: true,
  });
const completeDetailedProof: DetailedCleanupProof = storeCleanupProof(
  completeRuntimeProof,
  completeRevocation(7),
  true,
);
const completeDirectProof = {
  subscription_lease_revoked: true,
  subscription_requests_drained: true,
  subscription_listener_closed: true,
  subscription_socket_absent: true,
  identity_process_absent: true,
  late_result_rejected: true,
};
const completeDirectLocalProof = {
  runtime_kind: "direct_model_subscription" as const,
  identity_process_absent: true,
};

class RecordingRunner implements CommandRunner {
  readonly commands: CommandSpec[] = [];

  constructor(
    private readonly failLabels = new Set<string>(),
    private readonly absentInspectStdout = "",
  ) {}

  async run(command: CommandSpec): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.commands.push(command);
    if (this.failLabels.has(command.label)) {
      return { exitCode: 1, stdout: "", stderr: `forced ${command.label} failure` };
    }
    if (command.label.startsWith("inspect-")) {
      const stderr = command.label.includes("volume-keeper")
        ? "Error: No such object"
        : command.label.includes("volume")
        ? "Error: No such volume"
        : command.label.includes("network")
        ? "Error: network not found"
        : "Error: No such object";
      return { exitCode: 1, stdout: this.absentInspectStdout, stderr };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

async function identity(fill = 0x55, loopbackPort = 29_210) {
  const cellIndex = "sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4";
  const bridgeIndex = `sha256:${"b".repeat(64)}`;
  return allocateRuntimeIdentity({
    reserveLoopbackPort: async () => loopbackPort,
    randomBytes: () => Buffer.alloc(24, fill),
    image_evidence: {
      cell_image: {
        reference: `ghcr.io/openclaw/openclaw@${cellIndex}`,
        index_digest: cellIndex,
        platform: "linux/arm64",
        selected_manifest_digest: `sha256:${"c".repeat(64)}`,
        image_id: `sha256:${"d".repeat(64)}`,
        config_digest: `sha256:${"e".repeat(64)}`,
      },
      bridge_image: {
        reference: `ligou-discovery-bridge@${bridgeIndex}`,
        index_digest: bridgeIndex,
        platform: "linux/arm64",
        selected_manifest_digest: bridgeIndex,
        image_id: `sha256:${"f".repeat(64)}`,
        config_digest: `sha256:${"0".repeat(64)}`,
      },
    },
  });
}

function cellRuntime(dependencies: CellRuntimeDependencies): CellRuntime {
  return new CellRuntime(dependencies);
}

const completeSubscriptionUsage: SubscriptionUsage = Object.freeze({
  schema_version: "ligou.subscription_usage.v1",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  billing_basis: "chatgpt_subscription",
  marginal_api_charge_usd: 0,
  request_count: 1,
  active_requests: 0,
  input_bytes: 1_000,
  output_bytes: 2_000,
  input_tokens: 250,
  cached_input_tokens: 0,
  output_tokens: 500,
  total_tokens: 750,
  usage_complete: true,
  quota_state: "available",
  retry_after_seconds: null,
  cooldown_until: null,
  revoked: false,
});

function subscriptionGatewayFor(subscriptionSocketPath: string): SubscriptionGateway {
  const lease = Object.freeze(Object.create(null)) as SubscriptionLeaseCapability;
  const revocation = Object.freeze({
    generation: 1,
    subscription_lease_revoked: true as const,
    subscription_requests_drained: true as const,
    subscription_listener_closed: true as const,
    subscription_socket_absent: true as const,
  });
  return {
    async register() {
      return Object.freeze({
        lease,
        attempt_marker: "marker." + "a".repeat(43),
        subscription_socket_path: subscriptionSocketPath,
        session_id: "stage0_session_openclaw_test_1234",
        policy: Object.freeze({
          model: "gpt-5.6-sol" as const,
          deadline_at: claimedJob.deadline_at,
          max_requests: 4,
          max_input_bytes: 400_000 as const,
          max_output_bytes: 8_388_608 as const,
          max_response_bytes: 4_194_304 as const,
          concurrency: 1 as const,
          cache_retention: "none" as const,
        }),
      });
    },
    async forward() { return new Response("", { status: 500 }); },
    usage() { return completeSubscriptionUsage; },
    async revoke() { return revocation; },
    async recover() { return revocation; },
  };
}

describe("CellRuntime exhaustive cleanup", () => {
  test("proves every runtime resource was destroyed and maps to the exact Task 1 proof", async () => {
    const runner = new RecordingRunner();
    const runtime = cellRuntime({
      command_runner: runner,
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });

    const proof = await runtime.cleanup({ identity: await identity() });

    expect(proof).toEqual(completeRuntimeProof);
    expect(storeCleanupProof(proof, completeRevocation(1), true)).toEqual({
      gateway_exited: true,
      container_removed: true,
      bridge_removed: true,
      config_removed: true,
      state_removed: true,
      workspace_removed: true,
      output_removed: true,
      network_removed: true,
      credential_material_removed: true,
      subscription_lease_revoked: true,
      subscription_requests_drained: true,
      subscription_listener_closed: true,
      subscription_socket_absent: true,
      listener_closed: true,
      identity_process_absent: true,
      late_result_rejected: true,
    });
    expect(runner.commands.map((command) => command.label)).toEqual([
      "remove-bridge",
      "inspect-bridge-absence",
      "stop-cell",
      "remove-cell",
      "inspect-cell-absence",
      "remove-volume-keeper",
      "inspect-volume-keeper-absence",
      "remove-config-volume",
      "inspect-config-volume-absence",
      "remove-state-volume",
      "inspect-state-volume-absence",
      "remove-workspace-volume",
      "inspect-workspace-volume-absence",
      "remove-output-volume",
      "inspect-output-volume-absence",
      "remove-gateway-secret-volume",
      "inspect-gateway-secret-volume-absence",
      "remove-bridge-secret-volume",
      "inspect-bridge-secret-volume-absence",
      "remove-internal-network",
      "inspect-internal-network-absence",
      "remove-egress-network",
      "inspect-egress-network-absence",
    ]);
  });

  test("accepts Docker 29 exact empty-array inspect output only with not-found evidence", async () => {
    const runtime = cellRuntime({
      command_runner: new RecordingRunner(new Set(), "[]\n"),
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });

    expect(await runtime.cleanup({ identity: await identity() })).toEqual(completeRuntimeProof);
  });

  test("continues after a failure at every cleanup command and makes only the affected proof fail", async () => {
    const cases: ReadonlyArray<{
      label: string;
      field: keyof RuntimeCleanupProof;
    }> = [
      { label: "inspect-cell-absence", field: "gateway_exited" },
      { label: "inspect-cell-absence", field: "cell_removed" },
      { label: "inspect-bridge-absence", field: "bridge_removed" },
      { label: "inspect-volume-keeper-absence", field: "gateway_exited" },
      { label: "inspect-volume-keeper-absence", field: "cell_removed" },
      { label: "inspect-config-volume-absence", field: "config_removed" },
      { label: "inspect-state-volume-absence", field: "state_removed" },
      { label: "inspect-workspace-volume-absence", field: "workspace_removed" },
      { label: "inspect-output-volume-absence", field: "output_removed" },
      { label: "inspect-gateway-secret-volume-absence", field: "credential_material_removed" },
      { label: "inspect-bridge-secret-volume-absence", field: "credential_material_removed" },
      { label: "inspect-internal-network-absence", field: "network_removed" },
      { label: "inspect-egress-network-absence", field: "network_removed" },
    ];

    for (const fault of cases) {
      const runner = new RecordingRunner(new Set([fault.label]));
      const runtime = cellRuntime({
        command_runner: runner,
        listener_closed: async () => true,
        identity_process_absent: async () => true,
      });

      const proof = await runtime.cleanup({ identity: await identity() });

      expect(proof[fault.field]).toBe(false);
      expect(runner.commands).toHaveLength(23);
    }
  });

  test("listener and process-identity ambiguity each fail closed locally", async () => {
    const runtime = cellRuntime({
      command_runner: new RecordingRunner(),
      listener_closed: async () => false,
      identity_process_absent: async () => false,
    });

    const proof = await runtime.cleanup({ identity: await identity() });

    expect(proof.listener_closed).toBe(false);
    expect(proof.no_identity_process).toBe(false);
    expect(storeCleanupProof(proof, completeRevocation(1), true).listener_closed).toBe(false);
    expect(storeCleanupProof(proof, completeRevocation(1), true).late_result_rejected).toBe(true);
  });

  test("reads one bounded result only through the opaque output volume", async () => {
    const commands: CommandSpec[] = [];
    const runtime = cellRuntime({
      command_runner: {
        async run(command) {
          commands.push(command);
          return {
            exitCode: 0,
            stdout: command.label === "read-submitted-result" ? JSON.stringify(result) : "",
            stderr: "",
          };
        },
      },
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });
    const runtimeIdentity = await identity();

    expect(await runtime.readSubmittedResult({ identity: runtimeIdentity })).toEqual(result);
    expect(commands).toEqual([expect.objectContaining({
      label: "read-submitted-result",
      argv: expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        `type=volume,src=${runtimeIdentity.volume_names.output},dst=${runtimeIdentity.output_path},readonly`,
      ]),
      env: {},
    })]);
  });

  test("destroys an expired attempt from its persisted non-secret runtime binding", async () => {
    const runner = new RecordingRunner();
    const runtime = cellRuntime({
      command_runner: runner,
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });
    const runtimeIdentity = await identity();

    expect(await runtime.cleanupBoundRuntime(
      runtimeIdentityBinding(runtimeIdentity),
    )).toEqual(completeRuntimeProof);
    expect(runner.commands.find((command) => command.label === "remove-cell")?.argv)
      .toContain(runtimeIdentity.cell_container_name);
    expect(runner.commands.find((command) => command.label === "remove-output-volume")?.argv)
      .toContain(runtimeIdentity.volume_names.output);
  });

  test("propagates cancellation into an in-flight Docker command", async () => {
    let commandStarted!: () => void;
    const observedStart = new Promise<void>((resolve) => { commandStarted = resolve; });
    const runtime = cellRuntime({
      command_runner: {
        async run(_command, signal) {
          commandStarted();
          if (signal === undefined) throw new Error("missing command AbortSignal");
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("docker command cancelled")), { once: true });
          });
        },
      },
      listener_closed: async () => true,
      identity_process_absent: async () => true,
    });
    const controller = new AbortController();
    const starting = runtime.start([{
      label: "hung-docker-command",
      argv: ["docker", "network", "create", "attempt-network"],
      env: {},
    }], controller.signal);
    await observedStart;
    controller.abort();

    await expect(starting).rejects.toThrow("cancelled");
  });
});

describe("ephemeral OpenClaw attempt factory", () => {
  test("keeps all trusted identity and upstream credentials out of the cell prompt and command", async () => {
    const runtimeIdentity = await identity();
    let lifecyclePlan: readonly CommandSpec[] = [];
    const runtime: AttemptCellRuntime = {
      async start(plan) { lifecyclePlan = plan; },
      async readSubmittedResult() { return result; },
      async cleanup() { return completeRuntimeProof; },
    };
    let gatewayInput: GatewayRunInput | undefined;
    let gatewayClosed = false;
    const gatewayHandle = {
      run_id: "run-factory",
      connection: {
        hello: {} as any,
        async request() { return {}; },
        close() {},
      },
    } satisfies GatewayRunHandle;
    const gateway: AttemptGatewayRunner = {
      async run(input) {
        gatewayInput = input;
        return gatewayHandle;
      },
      async close(handle) {
        expect(handle).toBe(gatewayHandle);
        gatewayClosed = true;
      },
    };
    const factory = new EphemeralOpenClawAttemptFactory({
      runtime,
      gateway_client: gateway,
      upstream_model: "gpt-5.6-sol",
      resolve_identity: async () => runtimeIdentity,
      subscription_gateway: subscriptionGatewayFor(runtimeIdentity.subscription_socket_path),
      random_bytes: () => Buffer.alloc(32, 0x66),
    });

    const session = await factory.start(boundJob, modelAccess);
    expect(await session.result).toEqual(result);
    expect(gatewayClosed).toBe(true);
    expect(gatewayInput?.url).toBe(`ws://127.0.0.1:${runtimeIdentity.host_gateway_port}`);
    expect(gatewayInput?.prompt).toContain(snapshot.url);
    const cellCommand = lifecyclePlan.find((command) => command.label === "start-cell")!;
    const exposed = JSON.stringify({
      prompt: gatewayInput?.prompt,
      cell_argv: cellCommand.argv,
      cell_env: cellCommand.env,
    });
    for (const forbidden of [
      boundJob.job_id,
      boundJob.attempt_id,
      "claim_token",
      "supervisor-upstream-secret",
    ]) {
      expect(exposed).not.toContain(forbidden);
    }
    expect(cellCommand.argv.join(" ")).not.toMatch(/API_KEY|claim_token|fence_generation/i);
    expect(await session.cleanup()).toEqual(completeRuntimeProof);
  });

  test("surfaces Gateway/model and result-submission failures while preserving teardown", async () => {
    const runtimeIdentity = await identity();
    for (const failure of ["model_call_failed", "result_submission_missing"] as const) {
      let cleaned = false;
      const runtime: AttemptCellRuntime = {
        async start() {},
        async readSubmittedResult() {
          if (failure === "result_submission_missing") throw new Error(failure);
          return result;
        },
        async cleanup() {
          cleaned = true;
          return completeRuntimeProof;
        },
      };
      const gateway: AttemptGatewayRunner = {
        async run() {
          if (failure === "model_call_failed") throw new Error(failure);
          return {
            run_id: "run-failure",
            connection: {
              hello: {} as any,
              async request() { return {}; },
              close() {},
            },
          };
        },
        async close() {},
      };
      const factory = new EphemeralOpenClawAttemptFactory({
        runtime,
        gateway_client: gateway,
        upstream_model: "gpt-5.6-sol",
        resolve_identity: async () => runtimeIdentity,
        subscription_gateway: subscriptionGatewayFor(runtimeIdentity.subscription_socket_path),
        random_bytes: () => Buffer.alloc(32, 0x67),
      });
      const adapter = new OpenClawDiscoveryAdapter({ attempts: factory });

      const handle = await adapter.submit(boundJob, modelAccess);
      await expect(adapter.result(handle)).rejects.toThrow(failure);
      expect(await adapter.status(handle)).toEqual({ state: "failed" });
      expect(await adapter.retire(handle)).toEqual(completeRuntimeProof);
      expect(cleaned).toBe(true);
    }
  });
});

describe("OpenClaw adapter fencing", () => {
  test("rejects a result after retirement even when the external run resolves late", async () => {
    let settle!: (candidate: unknown) => void;
    const externalResult = new Promise<unknown>((resolve) => { settle = resolve; });
    const session: OpenClawAttemptSession = {
      result: externalResult,
      async cancel() {},
      async cleanup() { return completeRuntimeProof; },
      usage() { return completeSubscriptionUsage; },
    };
    const factory: OpenClawAttemptFactory = { async start() { return session; } };
    const adapter = new OpenClawDiscoveryAdapter({ attempts: factory });

    const handle = await adapter.submit(boundJob, modelAccess);
    const cleanup = await adapter.retire(handle);
    settle(result);

    expect(cleanup).toEqual(completeRuntimeProof);
    await expect(adapter.result(handle)).rejects.toThrow("retired");
    await expect(adapter.status(handle)).rejects.toThrow("retired");
  });

  test("rejects a mismatched fence and authority-bearing hostile result", async () => {
    const hostile = { ...result, approved: true };
    const adapter = new OpenClawDiscoveryAdapter({
      attempts: {
        async start() {
          return {
            result: Promise.resolve(hostile),
            async cancel() {},
            async cleanup() { return completeRuntimeProof; },
            usage() { return completeSubscriptionUsage; },
          };
        },
      },
    });
    const handle = await adapter.submit(boundJob, modelAccess);

    await expect(adapter.status({ ...handle, fence_generation: 8 })).rejects.toThrow("attempt handle");
    await expect(adapter.result(handle)).rejects.toThrow("exact keys");
    expect(await adapter.status(handle)).toEqual({ state: "failed" });
  });
});

const SLOT_ID = "44444444-4444-4444-8444-444444444444";
const claimSubscriptionRecovery = Object.freeze(Object.create(null)) as
  SubscriptionRecoveryCapability;
const terminalSubscriptionRecovery = Object.freeze(Object.create(null)) as
  SubscriptionRecoveryCapability;
const runtimeSlot: RuntimeSlotCapability = {
  job_id: claimedJob.job_id,
  attempt_id: claimedJob.attempt_id,
  runtime_slot_id: SLOT_ID,
};
const cleanupAuthority: SupervisorCleanupAuthority = {
  job_id: claimedJob.job_id,
  attempt_id: claimedJob.attempt_id,
  runtime_slot: runtimeSlot,
  fence_generation: 8,
  subscription_recovery: terminalSubscriptionRecovery,
};
const claimCleanupAuthority: SupervisorCleanupAuthority = {
  job_id: claimedJob.job_id,
  attempt_id: claimedJob.attempt_id,
  runtime_slot: runtimeSlot,
  fence_generation: 7,
  subscription_recovery: claimSubscriptionRecovery,
};
const claimedAttempt: SupervisorClaimedAttempt = {
  job: claimedJob,
  adapter_id: "openclaw",
  runtime_slot: runtimeSlot,
  job_version: 2,
  cleanup_authority: claimCleanupAuthority,
  model_access: modelAccess,
};
const directClaimedAttempt: SupervisorClaimedAttempt = {
  ...claimedAttempt,
  adapter_id: "direct_model",
};
const committedResult: CommittedResultCapability = {
  job_id: claimedJob.job_id,
  attempt_id: claimedJob.attempt_id,
  result_id: "33333333-3333-4333-8333-333333333333",
  job_version: 3,
  fence_generation: 7,
};

interface FakeStoreOptions {
  readonly commitError?: Error;
  readonly terminalizeError?: Error;
  readonly cleanupReadback?: CleanupReadback;
  readonly expiredCleanup?: SupervisorExpiredCleanupRecovery;
  readonly bindFailureCount?: number;
  readonly claimedAttempt?: SupervisorClaimedAttempt;
}

class FakeStore implements SupervisorStore {
  readonly calls: string[] = [];
  cleanupProof?: CleanupProof;
  cleanupAuthority?: SupervisorCleanupAuthority;
  quarantine?: {
    runtimeSlot: RuntimeSlotCapability;
    reason: string;
    proofHash: string;
  };
  runtimeBinding?: RuntimeIdentityBinding;
  lastRecoveryFence?: number;
  private remainingBindFailures: number;
  private readonly trustedCleanupAuthorities = new WeakSet<object>();
  private readonly recoveryAuthorities =
    new WeakMap<object, SupervisorCleanupAuthority>();

  constructor(private readonly options: FakeStoreOptions = {}) {
    this.remainingBindFailures = options.bindFailureCount ?? 0;
    this.trustedCleanupAuthorities.add(claimCleanupAuthority);
    this.trustedCleanupAuthorities.add(cleanupAuthority);
    this.recoveryAuthorities.set(
      claimCleanupAuthority.subscription_recovery,
      claimCleanupAuthority,
    );
    this.recoveryAuthorities.set(
      cleanupAuthority.subscription_recovery,
      cleanupAuthority,
    );
    if (options.expiredCleanup?.recovery_outcome === "cleanup_claimed") {
      this.trustedCleanupAuthorities.add(options.expiredCleanup.cleanup_authority);
      this.recoveryAuthorities.set(
        options.expiredCleanup.cleanup_authority.subscription_recovery,
        options.expiredCleanup.cleanup_authority,
      );
    }
  }

  async claimExpiredCleanup(
    workerId: string,
    leaseSeconds: number,
  ): Promise<SupervisorExpiredCleanupRecovery | null> {
    this.calls.push("claim-expired-cleanup");
    expect(workerId).toBe("openclaw-stage0-slot");
    expect(leaseSeconds).toBe(600);
    return this.options.expiredCleanup ?? null;
  }

  async claimAttempt(
    workerId: string,
    adapterId: DiscoveryAdapterId,
    leaseSeconds: number,
  ): Promise<SupervisorClaimedAttempt | null> {
    this.calls.push("claim");
    expect(workerId).toBe("openclaw-stage0-slot");
    expect(adapterId).toBe((this.options.claimedAttempt ?? claimedAttempt).adapter_id);
    expect(leaseSeconds).toBe(600);
    return this.options.claimedAttempt ?? claimedAttempt;
  }

  async bindRuntime(
    claim: SupervisorClaimedAttempt,
    binding: RuntimeIdentityBinding,
  ): Promise<SupervisorRuntimeBindReadback> {
    this.calls.push("bind-runtime");
    expect(claim).toBe(this.options.claimedAttempt ?? claimedAttempt);
    if (this.remainingBindFailures > 0) {
      this.remainingBindFailures -= 1;
      throw new Error("company_discovery_runtime_identity_conflict");
    }
    this.runtimeBinding = binding;
    return {
      attempt_id: claim.job.attempt_id,
      runtime_slot_id: claim.runtime_slot.runtime_slot_id,
      job_id: claim.job.job_id,
      job_version: claim.job_version,
      fence_generation: claim.job.fence_generation,
      runtime_identity: binding,
      runtime_identity_hash: "d".repeat(64),
    };
  }

  bindSourceSnapshots(job: WorkerJob, snapshots: readonly DiscoverySourceSnapshot[]): WorkerJob {
    this.calls.push("bind-evidence");
    expect(job).toBe((this.options.claimedAttempt ?? claimedAttempt).job);
    expect(snapshots).toEqual([snapshot]);
    return boundJob;
  }

  async commitResult(
    job: WorkerJob,
    candidate: WorkerResult,
  ): Promise<CommittedResultCapability> {
    this.calls.push("commit");
    expect(job).toBe(boundJob);
    expect(candidate).toEqual(result);
    if (this.options.commitError !== undefined) throw this.options.commitError;
    return committedResult;
  }

  async selectResult(committed: CommittedResultCapability): Promise<SelectionReadback> {
    this.calls.push("select");
    expect(committed).toBe(committedResult);
    return {
      job_id: committed.job_id,
      attempt_id: committed.attempt_id,
      result_id: committed.result_id,
      version: 4,
      fence_generation: 8,
    };
  }

  async terminalizeAttempt(
    claim: SupervisorClaimedAttempt,
    outcome: "failed" | "cancelled",
    reason: string,
  ): Promise<SupervisorCleanupAuthority> {
    this.calls.push(`terminalize-${outcome}-${reason}`);
    expect(claim).toBe(this.options.claimedAttempt ?? claimedAttempt);
    if (this.options.terminalizeError !== undefined) throw this.options.terminalizeError;
    return cleanupAuthority;
  }

  async recordCleanup(
    authority: SupervisorCleanupAuthority,
    proof: CleanupProof,
  ): Promise<CleanupReadback> {
    this.calls.push("record-cleanup");
    expect(this.trustedCleanupAuthorities.has(authority)).toBe(true);
    this.cleanupAuthority = authority;
    this.cleanupProof = proof;
    return this.options.cleanupReadback ?? {
      attempt_id: claimedJob.attempt_id,
      cleanup_state: "proved",
      slot_updated: true,
    };
  }

  async assertSubscriptionRecoveryCurrent(
    capability: SubscriptionRecoveryCapability,
  ) {
    this.calls.push("assert-subscription-recovery");
    const authority = this.recoveryAuthorities.get(capability);
    if (authority === undefined) throw new Error("store-issued recovery required");
    const runtimeIdentity = this.runtimeBinding ??
      (this.options.expiredCleanup?.recovery_outcome === "cleanup_claimed"
        ? this.options.expiredCleanup.runtime_identity
        : undefined);
    if (runtimeIdentity === undefined) throw new Error("runtime identity unavailable");
    this.lastRecoveryFence = authority.fence_generation;
    return Object.freeze({
      job_id: authority.job_id,
      attempt_id: authority.attempt_id,
      fence_generation: authority.fence_generation,
      subscription_socket_path: runtimeIdentity.subscription_socket_path,
      runtime_kind: runtimeIdentity.runtime_kind,
      late_result_rejected: true as const,
    });
  }

  async quarantineSlot(
    slot: RuntimeSlotCapability,
    reason: string,
    proofHash: string,
  ): Promise<void> {
    this.calls.push("quarantine");
    this.quarantine = { runtimeSlot: slot, reason, proofHash };
  }
}

function supervisorSubscriptionGateway(store: FakeStore): SubscriptionGateway {
  const base = subscriptionGatewayFor(
    `/run/ligou-discovery/${"f".repeat(48)}/subscription.sock`,
  );
  return {
    ...base,
    async recover() {
      if (store.lastRecoveryFence === undefined) {
        throw new Error("subscription recovery was not DB-authorized");
      }
      return completeRevocation(store.lastRecoveryFence);
    },
  };
}

class FakeBroker implements SupervisorBroker {
  readonly calls: string[] = [];
  modelAccess?: ModelAccessCapability;
  private state: WorkerStatus = { state: "succeeded" };

  async submit(
    adapterId: DiscoveryAdapterId,
    job: WorkerJob,
    capability: ModelAccessCapability,
  ): Promise<WorkerHandle> {
    this.calls.push("submit");
    this.modelAccess = capability;
    return {
      adapter_id: adapterId,
      job_type: job.job_type,
      job_id: job.job_id,
      attempt_id: job.attempt_id,
      fence_generation: job.fence_generation,
    };
  }

  async cancel(): Promise<void> {
    this.calls.push("cancel");
    this.state = { state: "cancelled" };
  }

  async status(): Promise<WorkerStatus> {
    this.calls.push("status");
    return this.state;
  }

  async result(): Promise<WorkerResult> {
    this.calls.push("result");
    return result;
  }
}

class FakeFetchGateway implements SupervisorFetchGateway {
  readonly calls: string[] = [];
  readonly context = Object.freeze({ opaque: true });

  createAttemptContext(): object {
    this.calls.push("create-context");
    return this.context;
  }

  async crawl(context: object, origin: string): Promise<readonly DiscoverySourceSnapshot[]> {
    this.calls.push("crawl");
    expect(context).toBe(this.context);
    expect(origin).toBe(claimedJob.normalized_origin);
    return [snapshot];
  }

  retireAttempt(context: object): void {
    this.calls.push("retire-context");
    expect(context).toBe(this.context);
  }
}

describe("DiscoverySupervisor attempt lifecycle", () => {
  test("runs DirectModel through a truthful UDS-only runtime and exact cleanup proof", async () => {
    const store = new FakeStore({ claimedAttempt: directClaimedAttempt });
    const broker = new FakeBroker();
    let allocatedAdapter: DiscoveryAdapterId | undefined;
    let retired = false;
    const directIdentity = await allocateDirectModelRuntimeIdentity({
      randomBytes: () => Buffer.alloc(24, 0x77),
    });
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker,
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "direct_model",
      allocate_runtime_identity: async (adapterId) => {
        allocatedAdapter = adapterId;
        return directIdentity;
      },
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => {
        retired = true;
        return {
          ...completeDirectLocalProof,
          revocation: completeRevocation(7),
        };
      },
      cleanup_bound_runtime: async () => {
        throw new Error("success path must retire the direct worker lease");
      },
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    expect(await supervisor.runOnce()).toMatchObject({ state: "selected" });
    expect(allocatedAdapter).toBe("direct_model");
    expect(retired).toBe(true);
    expect(store.runtimeBinding).toEqual({
      runtime_kind: "direct_model_subscription",
      subscription_socket_path: directIdentity.subscription_socket_path,
    });
    expect(store.cleanupProof).toEqual(completeDirectProof);
    expect(JSON.stringify(store.runtimeBinding)).not.toMatch(
      /container|image|network|loopback_port/,
    );
    expect(broker.modelAccess).toBe(modelAccess);
  });

  test("recovers a DirectModel bind-to-register crash through cleanup authority", async () => {
    const store = new FakeStore({ claimedAttempt: directClaimedAttempt });
    const directIdentity = await allocateDirectModelRuntimeIdentity({
      randomBytes: () => Buffer.alloc(24, 0x78),
    });
    class RegisterCrashBroker extends FakeBroker {
      override async submit(): Promise<WorkerHandle> {
        throw new Error("subscription_register_crash");
      }
    }
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker: new RegisterCrashBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "direct_model",
      allocate_runtime_identity: async () => directIdentity,
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => {
        throw new Error("no worker handle exists");
      },
      cleanup_bound_runtime: async (binding) => {
        expect(binding).toEqual({
          runtime_kind: "direct_model_subscription",
          subscription_socket_path: directIdentity.subscription_socket_path,
        });
        return completeDirectLocalProof;
      },
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    await expect(supervisor.runOnce()).rejects.toThrow("subscription_register_crash");
    expect(store.lastRecoveryFence).toBe(cleanupAuthority.fence_generation);
    expect(store.cleanupProof).toEqual(completeDirectProof);
  });

  test("claims, crawls, binds, runs, commits, selects, retires, and records proved cleanup", async () => {
    const store = new FakeStore();
    const broker = new FakeBroker();
    const fetchGateway = new FakeFetchGateway();
    const runtimeIdentities = new AttemptRuntimeIdentityRegistry();
    const runtimeIdentity = await identity();
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker,
      fetch_gateway: fetchGateway,
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => runtimeIdentity,
      runtime_identities: runtimeIdentities,
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async () => completeRuntimeProof,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    const outcome = await supervisor.runOnce();

    expect(outcome).toEqual({
      state: "selected",
      job_id: claimedJob.job_id,
      attempt_id: claimedJob.attempt_id,
      result_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(store.calls).toEqual([
      "claim-expired-cleanup",
      "claim",
      "bind-runtime",
      "bind-evidence",
      "commit",
      "select",
      "assert-subscription-recovery",
      "record-cleanup",
    ]);
    expect(fetchGateway.calls).toEqual(["create-context", "crawl", "retire-context"]);
    expect(broker.calls).toEqual(["submit", "status", "result"]);
    expect(broker.modelAccess).toBe(modelAccess);
    expect(store.cleanupProof).toEqual(completeDetailedProof);
    expect(store.cleanupAuthority).toMatchObject({
      attempt_id: claimedJob.attempt_id,
      runtime_slot: runtimeSlot,
      fence_generation: 7,
    });
    expect(store.runtimeBinding).toEqual(runtimeIdentityBinding(runtimeIdentity));
    expect(() => runtimeIdentities.resolve(boundJob)).toThrow("runtime identity");
  });

  test("terminalizes, retires, and cleans up before surfacing a failed result commit", async () => {
    const store = new FakeStore({ commitError: new Error("result_commit_failed") });
    const broker = new FakeBroker();
    const fetchGateway = new FakeFetchGateway();
    let workerRetired = false;
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker,
      fetch_gateway: fetchGateway,
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => identity(),
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => {
        workerRetired = true;
        return completeRuntimeProof;
      },
      cleanup_bound_runtime: async () => completeRuntimeProof,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    await expect(supervisor.runOnce()).rejects.toThrow("result_commit_failed");

    expect(workerRetired).toBe(true);
    expect(fetchGateway.calls).toContain("retire-context");
    expect(store.calls).not.toContain("select");
    expect(store.calls).toContain("terminalize-failed-result_commit_failed");
    expect(store.calls).toContain("record-cleanup");
    expect(store.cleanupAuthority).toMatchObject({
      fence_generation: 8,
      runtime_slot: runtimeSlot,
    });
  });

  test("reallocates opaque identity after a database reservation collision before creating resources", async () => {
    const store = new FakeStore({ bindFailureCount: 1 });
    const firstIdentity = await identity(0x61, 29_211);
    const secondIdentity = await identity(0x62, 29_212);
    const allocations = [firstIdentity, secondIdentity];
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker: new FakeBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => allocations.shift()!,
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async () => completeRuntimeProof,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    expect((await supervisor.runOnce()).state).toBe("selected");
    expect(allocations).toHaveLength(0);
    expect(store.calls.filter((call) => call === "bind-runtime")).toHaveLength(2);
    expect(store.runtimeBinding).toEqual(runtimeIdentityBinding(secondIdentity));
  });

  test("uses the original attempt cleanup authority after an external stale fence wins", async () => {
    const store = new FakeStore({
      commitError: new Error("company_discovery_stale_fence"),
      terminalizeError: new Error("company_discovery_attempt_not_current"),
    });
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker: new FakeBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => identity(),
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async () => completeRuntimeProof,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    await expect(supervisor.runOnce()).rejects.toThrow("stale_fence");
    expect(store.cleanupAuthority).toMatchObject({
      fence_generation: 7,
      runtime_slot: runtimeSlot,
    });
    expect(store.calls).toContain("terminalize-failed-result_commit_failed");
    expect(store.calls).toContain("record-cleanup");
  });

  test("terminalizes a deadline before any fetch or worker launch and cleans the bound identity", async () => {
    const store = new FakeStore();
    const fetchGateway = new FakeFetchGateway();
    const broker = new FakeBroker();
    let cleaned = false;
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker,
      fetch_gateway: fetchGateway,
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => identity(),
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async () => {
        cleaned = true;
        return completeRuntimeProof;
      },
      now: () => Date.parse(claimedJob.deadline_at),
    });

    await expect(supervisor.runOnce()).rejects.toThrow("deadline");
    expect(cleaned).toBe(true);
    expect(fetchGateway.calls).toEqual([]);
    expect(broker.calls).toEqual([]);
    expect(store.calls).toContain("terminalize-failed-deadline_exceeded");
    expect(store.cleanupAuthority).toBe(cleanupAuthority);
  });

  test("cancellation fences fetch and worker result before cleanup", async () => {
    let resolveStatus!: (status: WorkerStatus) => void;
    let statusStarted!: () => void;
    const observedStatusStart = new Promise<void>((resolve) => { statusStarted = resolve; });
    const pendingStatus = new Promise<WorkerStatus>((resolve) => { resolveStatus = resolve; });
    const broker = new FakeBroker();
    broker.status = async () => {
      broker.calls.push("status");
      statusStarted();
      return pendingStatus;
    };
    const store = new FakeStore();
    const fetchGateway = new FakeFetchGateway();
    const controller = new AbortController();
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker,
      fetch_gateway: fetchGateway,
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => identity(),
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async () => completeRuntimeProof,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    const run = supervisor.runOnce(controller.signal);
    await observedStatusStart;
    controller.abort();
    resolveStatus({ state: "cancelled" });

    await expect(run).rejects.toThrow("cancelled");
    expect(broker.calls).toContain("cancel");
    expect(fetchGateway.calls).toContain("retire-context");
    expect(store.calls).not.toContain("commit");
    expect(store.calls).toContain("terminalize-cancelled-supervisor_cancelled");
    expect(store.cleanupAuthority).toBe(cleanupAuthority);
  });

  test("ambiguous cleanup quarantines only the slot returned by the trusted claim", async () => {
    const unresolved = { ...completeRuntimeProof, listener_closed: false };
    const store = new FakeStore({
      cleanupReadback: {
        attempt_id: claimedJob.attempt_id,
        cleanup_state: "cleanup_unresolved",
        slot_updated: false,
      },
    });
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker: new FakeBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => identity(),
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => unresolved,
      cleanup_bound_runtime: async () => unresolved,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    await expect(supervisor.runOnce()).rejects.toThrow("cleanup unresolved");

    expect(store.quarantine).toEqual({
      runtimeSlot,
      reason: "cleanup_unresolved",
      proofHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("never promotes local teardown into subscription cleanup authority", async () => {
    const store = new FakeStore({
      cleanupReadback: {
        attempt_id: claimedJob.attempt_id,
        cleanup_state: "cleanup_unresolved",
        slot_updated: false,
      },
    });
    const gateway = supervisorSubscriptionGateway(store);
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker: new FakeBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => identity(),
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: {
        ...gateway,
        async recover() { throw new Error("central recovery ambiguous"); },
      },
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async () => completeRuntimeProof,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    await expect(supervisor.runOnce()).rejects.toThrow("cleanup unresolved");
    expect(store.cleanupProof).toMatchObject({
      gateway_exited: true,
      container_removed: true,
      subscription_lease_revoked: false,
      subscription_requests_drained: false,
      subscription_listener_closed: false,
      subscription_socket_absent: false,
      late_result_rejected: true,
    });
    expect(store.quarantine?.runtimeSlot).toBe(runtimeSlot);
  });

  test("runtime_not_bound recovery performs no runtime work and invalidates prior capabilities", async () => {
    const rpcCalls: string[] = [];
    const store = new JobStore({
      async rpc(name) {
        rpcCalls.push(name);
        if (name === "claim_company_discovery_attempt") {
          return {
            data: [{
              tenant_id: "55555555-5555-4555-8555-555555555555",
              credential_owner_id: "66666666-6666-4666-8666-666666666666",
              credential_generation: 1,
              subscription_account_hash: "9".repeat(64),
              job_id: claimedJob.job_id,
              attempt_id: claimedJob.attempt_id,
              attempt_number: 1,
              adapter_id: "openclaw",
              fence_generation: 7,
              claim_token: "private-preclaim-token",
              runtime_slot_id: SLOT_ID,
              job_version: 2,
              normalized_origin: claimedJob.normalized_origin,
              deadline_at: claimedJob.deadline_at,
              budget: claimedJob.budget,
            }],
            error: null,
          };
        }
        if (name === "claim_expired_company_discovery_cleanup") {
          return {
            data: [{
              job_id: claimedJob.job_id,
              attempt_id: claimedJob.attempt_id,
              adapter_id: "openclaw",
              runtime_slot_id: SLOT_ID,
              runtime_identity: {},
              fence_generation: 8,
              claim_token: null,
              job_version: 3,
              recovery_outcome: "runtime_not_bound",
            }],
            error: null,
          };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    });
    const stale = await store.claimAttempt("preclaimed-slot", "openclaw", 300);
    let allocated = false;
    let cleaned = false;
    let retired = false;
    const supervisor = new DiscoverySupervisor({
      worker_id: "runtime-not-bound-reaper",
      store,
      broker: new FakeBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => {
        allocated = true;
        return identity();
      },
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store as unknown as FakeStore),
      retire_worker: async () => {
        retired = true;
        return completeRuntimeProof;
      },
      cleanup_bound_runtime: async () => {
        cleaned = true;
        return completeRuntimeProof;
      },
    });

    expect(await supervisor.runOnce()).toEqual({
      state: "runtime_not_bound_recovered",
      attempt_id: claimedJob.attempt_id,
      runtime_slot_id: SLOT_ID,
    });
    expect({ allocated, cleaned, retired }).toEqual({
      allocated: false,
      cleaned: false,
      retired: false,
    });
    expect(rpcCalls).toEqual([
      "claim_company_discovery_attempt",
      "claim_expired_company_discovery_cleanup",
    ]);
    await expect(store.recordCleanup(stale!.cleanup_authority, completeDetailedProof))
      .rejects.toThrow("stale cleanup");
    await expect(store.quarantineSlot(
      stale!.runtime_slot,
      "cleanup_unresolved",
      "b".repeat(64),
    )).rejects.toThrow("stale runtime slot");
  });

  test("reclaims expired cleanup authority before claiming new work", async () => {
    const runtimeIdentity = await identity();
    const expired: SupervisorExpiredCleanupClaim = {
      recovery_outcome: "cleanup_claimed",
      job_id: claimedJob.job_id,
      attempt_id: claimedJob.attempt_id,
      adapter_id: "openclaw",
      runtime_slot: runtimeSlot,
      runtime_identity: runtimeIdentityBinding(runtimeIdentity),
      runtime_identity_hash: "d".repeat(64),
      fence_generation: 9,
      job_version: 4,
      cleanup_authority: {
        job_id: claimedJob.job_id,
        attempt_id: claimedJob.attempt_id,
        runtime_slot: runtimeSlot,
        fence_generation: 9,
        subscription_recovery: Object.freeze(Object.create(null)) as
          SubscriptionRecoveryCapability,
      },
    };
    const store = new FakeStore({ expiredCleanup: expired });
    let cleanedBinding: RuntimeIdentityBinding | undefined;
    let allocated = false;
    const supervisor = new DiscoverySupervisor({
      worker_id: "openclaw-stage0-slot",
      store,
      broker: new FakeBroker(),
      fetch_gateway: new FakeFetchGateway(),
      select_adapter: () => "openclaw",
      allocate_runtime_identity: async () => {
        allocated = true;
        return runtimeIdentity;
      },
      runtime_identities: new AttemptRuntimeIdentityRegistry(),
      subscription_gateway: supervisorSubscriptionGateway(store),
      retire_worker: async () => completeRuntimeProof,
      cleanup_bound_runtime: async (binding) => {
        cleanedBinding = binding;
        return completeRuntimeProof;
      },
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    expect(await supervisor.runOnce()).toEqual({
      state: "cleanup_recovered",
      attempt_id: claimedJob.attempt_id,
      runtime_slot_id: SLOT_ID,
    });
    expect(allocated).toBe(false);
    expect(cleanedBinding).toEqual(expired.runtime_identity);
    expect(store.calls).toEqual([
      "claim-expired-cleanup",
      "assert-subscription-recovery",
      "record-cleanup",
    ]);
    expect(store.cleanupAuthority).toMatchObject({
      fence_generation: 9,
      runtime_slot: runtimeSlot,
    });
  });
});
