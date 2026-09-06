import { createHash } from "node:crypto";
import type {
  DiscoveryAdapterId,
  DiscoverySourceSnapshot,
  ModelAccessCapability,
  SubscriptionGateway,
  SubscriptionRevocationReadback,
  WorkerHandle,
  WorkerJob,
  WorkerResult,
  WorkerStatus,
} from "./contracts";
import { WorkerExecutionError } from "./contracts";
import type {
  ClaimedAttempt,
  CleanupAuthority,
  CleanupProof,
  CleanupReadback,
  CommittedResultCapability,
  DirectModelCleanupProof,
  ExpiredCleanupClaim,
  ExpiredCleanupRecovery,
  JobStore,
  RuntimeBindReadback,
  RuntimeSlotCapability,
  SelectionReadback,
} from "./job-store";
import {
  storeCleanupProof,
  type LocalOpenClawCleanupProof,
} from "./openclaw/cell-runtime";
import {
  runtimeIdentityBinding,
  type AttemptRuntimeIdentity,
  type AttemptRuntimeIdentityRegistry,
  type RuntimeIdentity,
  type RuntimeIdentityBinding,
} from "./openclaw/runtime-identity";

export type SupervisorClaimedAttempt = ClaimedAttempt;
export type SupervisorRuntimeBindReadback = RuntimeBindReadback;
export type SupervisorCleanupAuthority = CleanupAuthority;
export type SupervisorExpiredCleanupClaim = ExpiredCleanupClaim;
export type SupervisorExpiredCleanupRecovery = ExpiredCleanupRecovery;

export interface SupervisorStore {
  claimExpiredCleanup(
    workerId: string,
    leaseSeconds: number,
  ): Promise<SupervisorExpiredCleanupRecovery | null>;
  claimAttempt(
    workerId: string,
    adapterId: DiscoveryAdapterId,
    leaseSeconds: number,
  ): Promise<SupervisorClaimedAttempt | null>;
  bindRuntime(
    claim: SupervisorClaimedAttempt,
    runtimeIdentity: RuntimeIdentityBinding,
  ): Promise<SupervisorRuntimeBindReadback>;
  bindSourceSnapshots(
    claimedJob: WorkerJob,
    snapshots: readonly DiscoverySourceSnapshot[],
  ): WorkerJob;
  commitResult(
    job: WorkerJob,
    candidate: WorkerResult,
  ): Promise<CommittedResultCapability>;
  selectResult(committed: CommittedResultCapability): Promise<SelectionReadback>;
  terminalizeAttempt(
    claim: SupervisorClaimedAttempt,
    outcome: "failed" | "cancelled",
    reason: string,
  ): Promise<SupervisorCleanupAuthority>;
  recordCleanup(
    authority: SupervisorCleanupAuthority,
    proof: CleanupProof,
  ): Promise<CleanupReadback>;
  assertSubscriptionRecoveryCurrent(
    capability: SupervisorCleanupAuthority["subscription_recovery"],
  ): Promise<{
    readonly job_id: string;
    readonly attempt_id: string;
    readonly fence_generation: number;
    readonly subscription_socket_path: string;
    readonly runtime_kind: "openclaw_cell" | "direct_model_subscription";
    readonly late_result_rejected: true;
  }>;
  quarantineSlot(
    runtimeSlot: RuntimeSlotCapability,
    reason: string,
    proofHash: string,
  ): Promise<void>;
}

type AssertTrue<T extends true> = T;
type ConcreteJobStoreMatchesSupervisor = AssertTrue<JobStore extends SupervisorStore ? true : false>;

export interface SupervisorBroker {
  submit(
    adapterId: DiscoveryAdapterId,
    job: WorkerJob,
    modelAccess: ModelAccessCapability,
  ): Promise<WorkerHandle>;
  cancel(handle: WorkerHandle): Promise<void>;
  status(handle: WorkerHandle): Promise<WorkerStatus>;
  result(handle: WorkerHandle): Promise<WorkerResult>;
}

export interface SupervisorFetchGateway {
  createAttemptContext(job: WorkerJob, signal?: AbortSignal): object;
  crawl(context: object, originUrl: string): Promise<readonly DiscoverySourceSnapshot[]>;
  retireAttempt(context: object): void;
}

export interface DiscoverySupervisorOptions {
  readonly worker_id: string;
  readonly store: SupervisorStore;
  readonly broker: SupervisorBroker;
  readonly fetch_gateway: SupervisorFetchGateway;
  readonly select_adapter: () => DiscoveryAdapterId;
  readonly allocate_runtime_identity: (
    adapterId: DiscoveryAdapterId,
  ) => Promise<AttemptRuntimeIdentity>;
  readonly runtime_identities: AttemptRuntimeIdentityRegistry;
  readonly subscription_gateway: SubscriptionGateway;
  readonly retire_worker: (
    handle: WorkerHandle,
  ) => Promise<LocalOpenClawCleanupProof | DirectModelRetirementReadback>;
  readonly cleanup_bound_runtime: (
    runtimeIdentity: RuntimeIdentityBinding,
  ) => Promise<LocalOpenClawCleanupProof | DirectModelLocalCleanupProof>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly lease_seconds?: number;
}

export interface DirectModelLocalCleanupProof {
  readonly runtime_kind: "direct_model_subscription";
  readonly identity_process_absent: boolean;
}

export interface DirectModelRetirementReadback extends DirectModelLocalCleanupProof {
  /** Retained for diagnostics only; DB proof always comes from recover(). */
  readonly revocation: SubscriptionRevocationReadback;
}

export type SupervisorRunOutcome =
  | { readonly state: "idle" }
  | {
      readonly state: "selected";
      readonly job_id: string;
      readonly attempt_id: string;
      readonly result_id: string;
    }
  | {
      readonly state: "cleanup_recovered";
      readonly attempt_id: string;
      readonly runtime_slot_id: string;
    }
  | {
      readonly state: "runtime_not_bound_recovered";
      readonly attempt_id: string;
      readonly runtime_slot_id: string;
    };

class SupervisorCancelledError extends Error {
  constructor() {
    super("company discovery attempt cancelled");
    this.name = "SupervisorCancelledError";
  }
}

class SupervisorDeadlineError extends Error {
  constructor() {
    super("company discovery attempt deadline exceeded");
    this.name = "SupervisorDeadlineError";
  }
}

function assertWorkerId(value: string): void {
  if (value.trim() === "" || value.length > 200) throw new Error("supervisor worker id is invalid");
}

function assertUuid(value: string, message: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(message);
  }
}

type SupervisorCleanupProof = CleanupProof;
type SupervisorLocalCleanupProof =
  | LocalOpenClawCleanupProof
  | DirectModelLocalCleanupProof
  | DirectModelRetirementReadback;

function cleanupHash(proof: SupervisorCleanupProof): string {
  return createHash("sha256").update(JSON.stringify(proof), "utf8").digest("hex");
}

function cleanupIsProved(proof: SupervisorCleanupProof): boolean {
  return Object.values(proof).every((value) => value === true);
}

function assertRuntimeBinding(
  claim: SupervisorClaimedAttempt,
  binding: RuntimeIdentityBinding,
  readback: SupervisorRuntimeBindReadback,
): void {
  if (readback.job_id !== claim.job.job_id || readback.attempt_id !== claim.job.attempt_id ||
      readback.runtime_slot_id !== claim.runtime_slot.runtime_slot_id ||
      readback.job_version !== claim.job_version ||
      readback.fence_generation !== claim.job.fence_generation ||
      !/^[0-9a-f]{64}$/.test(readback.runtime_identity_hash) ||
      JSON.stringify(readback.runtime_identity) !== JSON.stringify(binding)) {
    throw new Error("runtime binding readback mismatched trusted authority");
  }
}

function assertCleanupAuthority(
  authority: SupervisorCleanupAuthority,
  expected: {
    readonly job_id: string;
    readonly attempt_id: string;
    readonly runtime_slot: RuntimeSlotCapability;
    readonly fence_generation: number;
  },
): void {
  if (authority.job_id !== expected.job_id || authority.attempt_id !== expected.attempt_id ||
      authority.runtime_slot !== expected.runtime_slot ||
      authority.fence_generation !== expected.fence_generation) {
    throw new Error("cleanup authority mismatched trusted attempt readback");
  }
}

function assertRotatedCleanupAuthority(
  claim: SupervisorClaimedAttempt,
  authority: SupervisorCleanupAuthority,
): void {
  if (authority.job_id !== claim.job.job_id || authority.attempt_id !== claim.job.attempt_id ||
      authority.runtime_slot !== claim.runtime_slot ||
      !Number.isSafeInteger(authority.fence_generation) ||
      authority.fence_generation <= claim.job.fence_generation) {
    throw new Error("terminal cleanup authority did not rotate the exact attempt fence");
  }
}

function terminalReason(
  error: unknown,
  phase: string,
): { readonly outcome: "failed" | "cancelled"; readonly reason: string } {
  if (error instanceof SupervisorCancelledError) {
    return { outcome: "cancelled", reason: "supervisor_cancelled" };
  }
  if (error instanceof SupervisorDeadlineError) {
    return { outcome: "failed", reason: "deadline_exceeded" };
  }
  if (error instanceof WorkerExecutionError) {
    return { outcome: "failed", reason: error.code };
  }
  const reason = `${phase}_failed`;
  return {
    outcome: "failed",
    reason: /^[a-z][a-z0-9_]{0,99}$/.test(reason) ? reason : "worker_failed",
  };
}

function runtimeIdentityConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("company_discovery_runtime_identity_conflict");
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new SupervisorCancelledError();
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      cleanup();
      reject(new SupervisorCancelledError());
    };
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export class DiscoverySupervisor {
  readonly #options: DiscoverySupervisorOptions;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #leaseSeconds: number;

  constructor(options: DiscoverySupervisorOptions) {
    assertWorkerId(options.worker_id);
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#leaseSeconds = options.lease_seconds ?? 600;
    if (!Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 1 || this.#leaseSeconds > 600) {
      throw new Error("supervisor lease is invalid");
    }
  }

  async recoverExpiredCleanup(): Promise<SupervisorRunOutcome | null> {
    const expired = await this.#options.store.claimExpiredCleanup(
      this.#options.worker_id,
      this.#leaseSeconds,
    );
    if (expired?.recovery_outcome === "runtime_not_bound") {
      return Object.freeze({
        state: "runtime_not_bound_recovered",
        attempt_id: expired.attempt_id,
        runtime_slot_id: expired.runtime_slot_id,
      });
    }
    if (expired !== null) return this.#recoverClaimedExpiredCleanup(expired);
    return null;
  }

  async runOnce(
    signal?: AbortSignal,
    options: { readonly recover_expired_cleanup?: boolean } = {},
  ): Promise<SupervisorRunOutcome> {
    if (options.recover_expired_cleanup !== false) {
      const recovered = await this.recoverExpiredCleanup();
      if (recovered !== null) return recovered;
    }

    const adapterId = this.#options.select_adapter();
    let runtimeIdentity = await this.#options.allocate_runtime_identity(adapterId);
    const claimed = await this.#options.store.claimAttempt(
      this.#options.worker_id,
      adapterId,
      this.#leaseSeconds,
    );
    if (claimed === null) return Object.freeze({ state: "idle" });
    assertUuid(claimed.runtime_slot.runtime_slot_id, "claimed runtime slot id is invalid");
    if (claimed.adapter_id !== adapterId) throw new Error("claimed adapter differs from selected adapter");
    assertCleanupAuthority(claimed.cleanup_authority, {
      job_id: claimed.job.job_id,
      attempt_id: claimed.job.attempt_id,
      runtime_slot: claimed.runtime_slot,
      fence_generation: claimed.job.fence_generation,
    });

    let binding = runtimeIdentityBinding(runtimeIdentity);
    let runtimeBound = false;
    let fetchContext: object | undefined;
    let fetchRetired = false;
    let handle: WorkerHandle | undefined;
    let localProof: SupervisorLocalCleanupProof | undefined;
    let cleanupAuthority = claimed.cleanup_authority;
    let outcome: SupervisorRunOutcome | undefined;
    let primaryError: unknown;
    let phase = "runtime_bind";
    try {
      let bindReadback: SupervisorRuntimeBindReadback | undefined;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          bindReadback = await this.#options.store.bindRuntime(claimed, binding);
          break;
        } catch (error) {
          if (!runtimeIdentityConflict(error) || attempt === 3) throw error;
          runtimeIdentity = await this.#options.allocate_runtime_identity(adapterId);
          binding = runtimeIdentityBinding(runtimeIdentity);
        }
      }
      if (bindReadback === undefined) throw new Error("runtime identity bind produced no readback");
      assertRuntimeBinding(claimed, binding, bindReadback);
      runtimeBound = true;
      this.#options.runtime_identities.bind(claimed.job, runtimeIdentity);
      this.#assertLive(claimed.job, signal);

      phase = "fetch";
      fetchContext = this.#options.fetch_gateway.createAttemptContext(claimed.job, signal);
      const snapshots = await withAbort(
        this.#options.fetch_gateway.crawl(fetchContext, claimed.job.normalized_origin),
        signal,
      );
      this.#assertLive(claimed.job, signal);

      phase = "evidence_bind";
      const bound = this.#options.store.bindSourceSnapshots(claimed.job, snapshots);
      this.#options.runtime_identities.bind(bound, runtimeIdentity);

      phase = "adapter_submit";
      handle = await this.#options.broker.submit(
        adapterId,
        bound,
        claimed.model_access,
      );
      phase = "worker_wait";
      const status = await this.#waitForTerminal(claimed.job, handle, signal);
      if (status.state !== "succeeded") {
        if (status.state === "cancelled") throw new SupervisorCancelledError();
        // The adapter owns the precise, owner-safe terminal classification.
        // Reading result after a failed terminal cannot restart work; it only
        // rethrows the already-settled execution error.
        await this.#options.broker.result(handle);
        throw new Error(`company discovery worker ended ${status.state}`);
      }

      phase = "worker_result";
      const candidate = await withAbort(this.#options.broker.result(handle), signal);
      phase = "result_commit";
      const committed = await this.#options.store.commitResult(bound, candidate);
      phase = "result_select";
      const selection = await this.#options.store.selectResult(committed);
      if (selection.result_id !== committed.result_id) {
        throw new Error("selected result differs from committed result");
      }
      outcome = Object.freeze({
        state: "selected",
        job_id: claimed.job.job_id,
        attempt_id: claimed.job.attempt_id,
        result_id: committed.result_id,
      });
    } catch (error) {
      primaryError = error;
      if (fetchContext !== undefined && !fetchRetired) {
        this.#options.fetch_gateway.retireAttempt(fetchContext);
        fetchRetired = true;
      }
      if (handle !== undefined) {
        try {
          await this.#options.broker.cancel(handle);
        } catch {
          // The database fence and runtime teardown below remain authoritative.
        }
      }
      if (runtimeBound) {
        const terminal = terminalReason(error, phase);
        try {
          cleanupAuthority = await this.#options.store.terminalizeAttempt(
            claimed,
            terminal.outcome,
            terminal.reason,
          );
          assertRotatedCleanupAuthority(claimed, cleanupAuthority);
        } catch {
          // Owner cancellation or a concurrent fence can already have terminalized the attempt.
          // The original attempt authority remains eligible for that exact terminal attempt cleanup.
        }
      }
    } finally {
      if (fetchContext !== undefined && !fetchRetired) {
        this.#options.fetch_gateway.retireAttempt(fetchContext);
      }
      if (runtimeBound) {
        try {
          localProof = handle === undefined
            ? await this.#options.cleanup_bound_runtime(binding)
            : await this.#options.retire_worker(handle);
        } catch {
          localProof = undefined;
        }
        this.#options.runtime_identities.retire(claimed.job);
        const runtimeProof = await this.#authoritativeCleanupProof(
          binding.runtime_kind,
          cleanupAuthority,
          localProof,
        );
        try {
          await this.#recordCleanup(cleanupAuthority, runtimeProof);
        } catch (cleanupError) {
          if (primaryError === undefined) primaryError = cleanupError;
        }
      } else {
        const missingProof = this.#missingCleanupProof(binding.runtime_kind);
        try {
          await this.#quarantine(claimed.runtime_slot, "runtime_bind_failed", missingProof);
        } catch {
          // A failed bind leaves the claimed slot non-reusable; quarantine is best-effort escalation.
        }
      }
    }
    if (primaryError !== undefined) throw primaryError;
    if (outcome === undefined) throw new Error("company discovery attempt ended without outcome");
    return outcome;
  }

  async #recoverClaimedExpiredCleanup(
    claim: SupervisorExpiredCleanupClaim,
  ): Promise<SupervisorRunOutcome> {
    assertUuid(
      claim.runtime_slot.runtime_slot_id,
      "expired cleanup runtime slot id is invalid",
    );
    assertCleanupAuthority(claim.cleanup_authority, claim);
    const authority = claim.cleanup_authority;
    let localProof: SupervisorLocalCleanupProof | undefined;
    try {
      localProof = await this.#options.cleanup_bound_runtime(claim.runtime_identity);
    } catch {
      localProof = undefined;
    }
    const proof = await this.#authoritativeCleanupProof(
      claim.runtime_identity.runtime_kind,
      authority,
      localProof,
    );
    await this.#recordCleanup(authority, proof);
    return Object.freeze({
      state: "cleanup_recovered",
      attempt_id: claim.attempt_id,
      runtime_slot_id: claim.runtime_slot.runtime_slot_id,
    });
  }

  async #recordCleanup(
    authority: SupervisorCleanupAuthority,
    proof: SupervisorCleanupProof,
  ): Promise<void> {
    const readback = await this.#options.store.recordCleanup(authority, proof);
    if (!cleanupIsProved(proof) || readback.cleanup_state !== "proved" || !readback.slot_updated) {
      await this.#quarantine(authority.runtime_slot, "cleanup_unresolved", proof);
      throw new Error("runtime cleanup unresolved");
    }
  }

  async #authoritativeCleanupProof(
    runtimeKind: RuntimeIdentityBinding["runtime_kind"],
    authority: SupervisorCleanupAuthority,
    localProof?: SupervisorLocalCleanupProof,
  ): Promise<SupervisorCleanupProof> {
    let subscription: SubscriptionRevocationReadback | undefined;
    let lateResultRejected = false;
    try {
      const context = await this.#options.store.assertSubscriptionRecoveryCurrent(
        authority.subscription_recovery,
      );
      const contextMatches = context.job_id === authority.job_id &&
          context.attempt_id === authority.attempt_id &&
          context.fence_generation === authority.fence_generation &&
          context.runtime_kind === runtimeKind &&
          context.late_result_rejected === true;
      lateResultRejected = contextMatches;
      // Recovery consumes only the opaque capability and therefore remains
      // safe and necessary even if our independent comparison detects a bad
      // readback. A mismatch affects proof acceptance, not revocation effort.
      const recovered = await this.#options.subscription_gateway.recover(
        authority.subscription_recovery,
      );
      if (!contextMatches) {
        throw new Error("subscription recovery context mismatched cleanup authority");
      }
      if (recovered.generation !== authority.fence_generation ||
          recovered.subscription_lease_revoked !== true ||
          recovered.subscription_requests_drained !== true ||
          recovered.subscription_listener_closed !== true ||
          recovered.subscription_socket_absent !== true) {
        throw new Error("subscription recovery readback mismatched cleanup authority");
      }
      subscription = recovered;
    } catch {
      // Missing or ambiguous subscription evidence remains false below. Local
      // teardown cannot manufacture central lease or DB fencing authority.
    }

    if (runtimeKind === "direct_model_subscription") {
      const direct = localProof !== undefined && "runtime_kind" in localProof &&
          localProof.runtime_kind === "direct_model_subscription"
        ? localProof
        : undefined;
      return Object.freeze({
        subscription_lease_revoked: subscription?.subscription_lease_revoked === true,
        subscription_requests_drained: subscription?.subscription_requests_drained === true,
        subscription_listener_closed: subscription?.subscription_listener_closed === true,
        subscription_socket_absent: subscription?.subscription_socket_absent === true,
        identity_process_absent: direct?.identity_process_absent === true,
        late_result_rejected: lateResultRejected,
      }) satisfies DirectModelCleanupProof;
    }

    const openClaw = localProof !== undefined && "gateway_exited" in localProof
      ? localProof
      : this.#missingLocalOpenClawProof();
    if (subscription === undefined || !lateResultRejected) {
      return Object.freeze({
        gateway_exited: openClaw.gateway_exited,
        container_removed: openClaw.cell_removed,
        bridge_removed: openClaw.bridge_removed,
        config_removed: openClaw.config_removed,
        state_removed: openClaw.state_removed,
        workspace_removed: openClaw.workspace_removed,
        output_removed: openClaw.output_removed,
        network_removed: openClaw.network_removed,
        credential_material_removed: openClaw.credential_material_removed,
        subscription_lease_revoked: false,
        subscription_requests_drained: false,
        subscription_listener_closed: false,
        subscription_socket_absent: false,
        listener_closed: openClaw.listener_closed,
        identity_process_absent: openClaw.no_identity_process,
        late_result_rejected: lateResultRejected,
      });
    }
    return storeCleanupProof(openClaw, subscription, true);
  }

  async #quarantine(
    runtimeSlot: RuntimeSlotCapability,
    reason: string,
    proof: SupervisorCleanupProof,
  ): Promise<void> {
    await this.#options.store.quarantineSlot(runtimeSlot, reason, cleanupHash(proof));
  }

  #missingCleanupProof(
    runtimeKind: RuntimeIdentityBinding["runtime_kind"],
  ): SupervisorCleanupProof {
    if (runtimeKind === "direct_model_subscription") {
      return Object.freeze({
        subscription_lease_revoked: false,
        subscription_requests_drained: false,
        subscription_listener_closed: false,
        subscription_socket_absent: false,
        identity_process_absent: false,
        late_result_rejected: false,
      });
    }
    return Object.freeze({
      gateway_exited: false,
      container_removed: false,
      bridge_removed: false,
      config_removed: false,
      state_removed: false,
      workspace_removed: false,
      output_removed: false,
      network_removed: false,
      credential_material_removed: false,
      subscription_lease_revoked: false,
      subscription_requests_drained: false,
      subscription_listener_closed: false,
      subscription_socket_absent: false,
      listener_closed: false,
      identity_process_absent: false,
      late_result_rejected: false,
    });
  }

  #missingLocalOpenClawProof(): LocalOpenClawCleanupProof {
    return Object.freeze({
      gateway_exited: false,
      cell_removed: false,
      bridge_removed: false,
      config_removed: false,
      state_removed: false,
      workspace_removed: false,
      output_removed: false,
      network_removed: false,
      credential_material_removed: false,
      listener_closed: false,
      no_identity_process: false,
    });
  }

  #assertLive(job: WorkerJob, signal?: AbortSignal): void {
    if (signal?.aborted) throw new SupervisorCancelledError();
    if (this.#now() >= Date.parse(job.deadline_at)) throw new SupervisorDeadlineError();
  }

  async #waitForTerminal(
    job: WorkerJob,
    handle: WorkerHandle,
    signal?: AbortSignal,
  ): Promise<WorkerStatus> {
    for (;;) {
      this.#assertLive(job, signal);
      const status = await withAbort(this.#options.broker.status(handle), signal);
      if (status.state !== "running") return status;
      await withAbort(this.#sleep(50), signal);
    }
  }
}
