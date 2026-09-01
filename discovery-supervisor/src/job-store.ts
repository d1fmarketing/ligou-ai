import { createHash } from "node:crypto";
import {
  ContractValidationError,
  isDiscoveryAdapterId,
  parseSourceSnapshots,
  parseWorkerJob,
  parseWorkerResult,
  type DiscoveryAdapterId,
  type DiscoverySourceSnapshot,
  type WorkerJob,
  type WorkerResult,
} from "./contracts";

interface RpcResponse {
  readonly data: unknown;
  readonly error: unknown;
}

export interface ServiceRpcClient {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResponse>;
}

export interface RuntimeIdentityBinding {
  readonly cell_container_name: string;
  readonly bridge_container_name: string;
  readonly internal_network_name: string;
  readonly egress_network_name: string;
  readonly config_volume_name: string;
  readonly state_volume_name: string;
  readonly workspace_volume_name: string;
  readonly output_volume_name: string;
  readonly gateway_secret_volume_name: string;
  readonly bridge_secret_volume_name: string;
  readonly profile_name: string;
  readonly loopback_port: number;
}

export interface CleanupAuthority {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly runtime_slot_id: string;
  readonly fence_generation: number;
  readonly claim_token: string;
}

export interface TerminalCleanupAuthority extends CleanupAuthority {
  readonly job_version: number;
  readonly runtime_identity: RuntimeIdentityBinding;
  readonly runtime_identity_hash: string;
  readonly status: "failed" | "cancelled";
  readonly cleanup_state: "pending";
}

export interface ClaimedAttempt {
  readonly job: WorkerJob;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot_id: string;
  readonly job_version: number;
  readonly cleanup_authority: CleanupAuthority;
}

export interface RuntimeBindReadback {
  readonly attempt_id: string;
  readonly runtime_slot_id: string;
  readonly job_id: string;
  readonly job_version: number;
  readonly fence_generation: number;
  readonly runtime_identity: RuntimeIdentityBinding;
  readonly runtime_identity_hash: string;
}

export interface ExpiredCleanupClaim {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot_id: string;
  readonly runtime_identity: RuntimeIdentityBinding;
  readonly runtime_identity_hash: string;
  readonly fence_generation: number;
  readonly claim_token: string;
  readonly job_version: number;
  readonly cleanup_authority: CleanupAuthority;
}

export interface CleanupProof {
  readonly gateway_exited: boolean;
  readonly container_removed: boolean;
  readonly bridge_removed: boolean;
  readonly config_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_revoked: boolean;
  readonly listener_closed: boolean;
  readonly identity_process_absent: boolean;
  readonly late_result_rejected: boolean;
}

export interface SelectionReadback {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly result_id: string;
  readonly version: number;
  readonly fence_generation: number;
}

export interface CleanupReadback {
  readonly attempt_id: string;
  readonly cleanup_state: "proved" | "cleanup_unresolved";
  readonly slot_updated: boolean;
}

const CLAIM_KEYS = [
  "job_id",
  "attempt_id",
  "attempt_number",
  "adapter_id",
  "fence_generation",
  "claim_token",
  "runtime_slot_id",
  "job_version",
  "normalized_origin",
  "deadline_at",
  "budget",
] as const;
const RUNTIME_IDENTITY_KEYS = [
  "cell_container_name",
  "bridge_container_name",
  "internal_network_name",
  "egress_network_name",
  "config_volume_name",
  "state_volume_name",
  "workspace_volume_name",
  "output_volume_name",
  "gateway_secret_volume_name",
  "bridge_secret_volume_name",
  "profile_name",
  "loopback_port",
] as const;
const RUNTIME_BIND_KEYS = [
  "attempt_id",
  "runtime_slot_id",
  "job_id",
  "job_version",
  "fence_generation",
  "runtime_identity",
  "runtime_identity_hash",
] as const;
const TERMINAL_KEYS = [
  "job_id",
  "attempt_id",
  "runtime_slot_id",
  "job_version",
  "fence_generation",
  "claim_token",
  "status",
  "cleanup_state",
] as const;
const EXPIRED_CLEANUP_KEYS = [
  "job_id",
  "attempt_id",
  "adapter_id",
  "runtime_slot_id",
  "runtime_identity",
  "fence_generation",
  "claim_token",
  "job_version",
] as const;
const CLEANUP_PROOF_KEYS = [
  "gateway_exited",
  "container_removed",
  "bridge_removed",
  "config_removed",
  "state_removed",
  "workspace_removed",
  "output_removed",
  "network_removed",
  "credential_revoked",
  "listener_closed",
  "identity_process_absent",
  "late_result_rejected",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(`${message}: expected plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContractValidationError(`${message}: expected plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  message: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new ContractValidationError(`${message}: unexpected fields`);
  }
}

function positiveInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ContractValidationError(`${message}: positive integer required`);
  }
  return value as number;
}

function uuid(value: unknown, message: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ContractValidationError(`${message}: UUID required`);
  }
  return value;
}

function hash(value: unknown, message: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new ContractValidationError(`${message}: SHA-256 required`);
  }
  return value;
}

function nonemptyString(value: unknown, message: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ContractValidationError(`${message}: bounded string required`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

async function rpcOrThrow(
  client: ServiceRpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await client.rpc(name, args);
  if (response.error !== null && response.error !== undefined) {
    throw new Error(`${name}: ${errorMessage(response.error)}`);
  }
  return response.data;
}

function oneRow(value: unknown, message: string): Record<string, unknown> | null {
  if (!Array.isArray(value)) throw new ContractValidationError(`${message}: expected array`);
  if (value.length === 0) return null;
  if (value.length !== 1) throw new ContractValidationError(`${message}: expected one row`);
  return plainRecord(value[0], message);
}

function postgresJsonbText(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new ContractValidationError("jsonb hash: only safe integers are canonical");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(", ")}]`;
  const record = plainRecord(value, "jsonb hash");
  const keys = Object.keys(record).sort((left, right) =>
    Buffer.byteLength(left) - Buffer.byteLength(right) ||
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${postgresJsonbText(record[key])}`).join(", ")}}`;
}

function jsonbHash(value: unknown): string {
  return createHash("sha256").update(postgresJsonbText(value), "utf8").digest("hex");
}

function parseRuntimeIdentity(value: unknown, message: string): RuntimeIdentityBinding {
  const candidate = plainRecord(value, message);
  exactKeys(candidate, RUNTIME_IDENTITY_KEYS, message);
  const parsed: Record<string, string | number> = {};
  for (const key of RUNTIME_IDENTITY_KEYS.slice(0, -1)) {
    const name = nonemptyString(candidate[key], `${message}.${key}`, 128);
    if (!RUNTIME_NAME_PATTERN.test(name) || name.includes("..") ||
        (key === "profile_name" && name.toLowerCase() === "default")) {
      throw new ContractValidationError(`${message}.${key}: invalid runtime name`);
    }
    parsed[key] = name;
  }
  const loopbackPort = positiveInteger(candidate.loopback_port, `${message}.loopback_port`);
  if (loopbackPort < 1_024 || loopbackPort > 65_535) {
    throw new ContractValidationError(`${message}.loopback_port: invalid loopback port`);
  }
  parsed.loopback_port = loopbackPort;
  return Object.freeze(parsed as unknown as RuntimeIdentityBinding);
}

function cleanupAuthority(
  jobId: string,
  attemptId: string,
  runtimeSlotId: string,
  fenceGeneration: number,
  claimToken: string,
): CleanupAuthority {
  return Object.freeze({
    job_id: jobId,
    attempt_id: attemptId,
    runtime_slot_id: runtimeSlotId,
    fence_generation: fenceGeneration,
    claim_token: claimToken,
  });
}

function parseClaimReadback(
  value: unknown,
  requestedAdapter: DiscoveryAdapterId,
): Omit<ClaimedAttempt, "cleanup_authority"> | null {
  const row = oneRow(value, "claim readback");
  if (row === null) return null;
  exactKeys(row, CLAIM_KEYS, "claim readback");
  if (!isDiscoveryAdapterId(row.adapter_id) || row.adapter_id !== requestedAdapter) {
    throw new ContractValidationError("claim readback: adapter mismatch");
  }
  const runtimeSlotId = uuid(row.runtime_slot_id, "claim readback.runtime_slot_id");
  return {
    job: parseWorkerJob({
      job_type: "company_discovery.v1",
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      attempt_number: row.attempt_number,
      fence_generation: row.fence_generation,
      claim_token: row.claim_token,
      normalized_origin: row.normalized_origin,
      deadline_at: row.deadline_at,
      budget: row.budget,
      source_snapshots: [],
    }, { allowEmptyEvidence: true }),
    adapter_id: row.adapter_id,
    runtime_slot_id: runtimeSlotId,
    job_version: positiveInteger(row.job_version, "claim readback.job_version"),
  };
}

function parseRuntimeBindReadback(
  value: unknown,
  claim: ClaimedAttempt,
  expectedIdentity: RuntimeIdentityBinding,
): RuntimeBindReadback {
  const row = plainRecord(value, "runtime bind readback");
  exactKeys(row, RUNTIME_BIND_KEYS, "runtime bind readback");
  const identity = parseRuntimeIdentity(row.runtime_identity, "runtime bind readback.runtime_identity");
  const parsed: RuntimeBindReadback = {
    attempt_id: uuid(row.attempt_id, "runtime bind readback.attempt_id"),
    runtime_slot_id: uuid(row.runtime_slot_id, "runtime bind readback.runtime_slot_id"),
    job_id: uuid(row.job_id, "runtime bind readback.job_id"),
    job_version: positiveInteger(row.job_version, "runtime bind readback.job_version"),
    fence_generation: positiveInteger(
      row.fence_generation,
      "runtime bind readback.fence_generation",
    ),
    runtime_identity: identity,
    runtime_identity_hash: hash(
      row.runtime_identity_hash,
      "runtime bind readback.runtime_identity_hash",
    ),
  };
  if (parsed.job_id !== claim.job.job_id || parsed.attempt_id !== claim.job.attempt_id ||
      parsed.runtime_slot_id !== claim.runtime_slot_id ||
      parsed.job_version !== claim.job_version ||
      parsed.fence_generation !== claim.job.fence_generation ||
      JSON.stringify(parsed.runtime_identity) !== JSON.stringify(expectedIdentity) ||
      parsed.runtime_identity_hash !== jsonbHash(expectedIdentity)) {
    throw new ContractValidationError("runtime bind readback: mismatched trusted authority or hash");
  }
  return Object.freeze(parsed);
}

function parseTerminalReadback(
  value: unknown,
  claim: ClaimedAttempt,
  outcome: "failed" | "cancelled",
  binding: RuntimeBindReadback,
): TerminalCleanupAuthority {
  const row = plainRecord(value, "terminal readback");
  exactKeys(row, TERMINAL_KEYS, "terminal readback");
  const jobId = uuid(row.job_id, "terminal readback.job_id");
  const attemptId = uuid(row.attempt_id, "terminal readback.attempt_id");
  const runtimeSlotId = uuid(row.runtime_slot_id, "terminal readback.runtime_slot_id");
  const version = positiveInteger(row.job_version, "terminal readback.job_version");
  const fence = positiveInteger(row.fence_generation, "terminal readback.fence_generation");
  const token = nonemptyString(row.claim_token, "terminal readback.claim_token");
  if (jobId !== claim.job.job_id || attemptId !== claim.job.attempt_id ||
      runtimeSlotId !== claim.runtime_slot_id || version !== claim.job_version + 1 ||
      fence !== claim.job.fence_generation + 1 || token === claim.job.claim_token ||
      row.status !== outcome || row.cleanup_state !== "pending") {
    throw new ContractValidationError("terminal readback: mismatched rotated authority");
  }
  return Object.freeze({
    ...cleanupAuthority(jobId, attemptId, runtimeSlotId, fence, token),
    job_version: version,
    runtime_identity: binding.runtime_identity,
    runtime_identity_hash: binding.runtime_identity_hash,
    status: outcome,
    cleanup_state: "pending",
  });
}

function parseExpiredCleanupReadback(value: unknown): Omit<ExpiredCleanupClaim, "cleanup_authority"> | null {
  const row = oneRow(value, "expired cleanup readback");
  if (row === null) return null;
  exactKeys(row, EXPIRED_CLEANUP_KEYS, "expired cleanup readback");
  if (!isDiscoveryAdapterId(row.adapter_id)) {
    throw new ContractValidationError("expired cleanup readback: invalid adapter");
  }
  const identity = parseRuntimeIdentity(
    row.runtime_identity,
    "expired cleanup readback.runtime_identity",
  );
  return {
    job_id: uuid(row.job_id, "expired cleanup readback.job_id"),
    attempt_id: uuid(row.attempt_id, "expired cleanup readback.attempt_id"),
    adapter_id: row.adapter_id,
    runtime_slot_id: uuid(row.runtime_slot_id, "expired cleanup readback.runtime_slot_id"),
    runtime_identity: identity,
    runtime_identity_hash: jsonbHash(identity),
    fence_generation: positiveInteger(
      row.fence_generation,
      "expired cleanup readback.fence_generation",
    ),
    claim_token: nonemptyString(row.claim_token, "expired cleanup readback.claim_token"),
    job_version: positiveInteger(row.job_version, "expired cleanup readback.job_version"),
  };
}

function selectionReadback(
  value: unknown,
  job: WorkerJob,
  expectedVersion: number,
): SelectionReadback {
  const candidate = plainRecord(value, "selection readback");
  const keys = ["job_id", "attempt_id", "result_id", "version", "fence_generation"] as const;
  exactKeys(candidate, keys, "selection readback");
  const parsed: SelectionReadback = {
    job_id: uuid(candidate.job_id, "selection readback.job_id"),
    attempt_id: uuid(candidate.attempt_id, "selection readback.attempt_id"),
    result_id: uuid(candidate.result_id, "selection readback.result_id"),
    version: positiveInteger(candidate.version, "selection readback.version"),
    fence_generation: positiveInteger(
      candidate.fence_generation,
      "selection readback.fence_generation",
    ),
  };
  if (parsed.job_id !== job.job_id || parsed.attempt_id !== job.attempt_id ||
      parsed.version !== expectedVersion + 1 ||
      parsed.fence_generation !== job.fence_generation + 1) {
    throw new ContractValidationError("selection readback: mismatched trusted identity or version");
  }
  return Object.freeze(parsed);
}

function cleanupReadback(value: unknown, attemptId: string): CleanupReadback {
  const candidate = plainRecord(value, "cleanup readback");
  const keys = ["attempt_id", "cleanup_state", "slot_updated"] as const;
  exactKeys(candidate, keys, "cleanup readback");
  const readbackAttempt = uuid(candidate.attempt_id, "cleanup readback.attempt_id");
  if (readbackAttempt !== attemptId ||
      (candidate.cleanup_state !== "proved" && candidate.cleanup_state !== "cleanup_unresolved") ||
      typeof candidate.slot_updated !== "boolean") {
    throw new ContractValidationError("cleanup readback: invalid identity, state, or slot result");
  }
  return Object.freeze({
    attempt_id: readbackAttempt,
    cleanup_state: candidate.cleanup_state,
    slot_updated: candidate.slot_updated,
  });
}

function parseCleanupProof(value: CleanupProof): CleanupProof {
  const candidate = plainRecord(value, "cleanup proof");
  exactKeys(candidate, CLEANUP_PROOF_KEYS, "cleanup proof");
  if (CLEANUP_PROOF_KEYS.some((key) => typeof candidate[key] !== "boolean")) {
    throw new ContractValidationError("cleanup proof: exact boolean fields required");
  }
  return Object.freeze({ ...value });
}

function assertWorkerIdAndLease(workerId: string, leaseSeconds: number, message: string): void {
  if (workerId.trim() === "" || workerId.length > 200 ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600) {
    throw new ContractValidationError(`${message}: invalid worker or lease`);
  }
}

export class JobStore {
  readonly #trustedJobs = new WeakSet<object>();
  readonly #claimForJob = new WeakMap<object, ClaimedAttempt>();
  readonly #trustedClaims = new WeakSet<object>();
  readonly #activeClaims = new WeakSet<object>();
  readonly #runtimeBindings = new WeakMap<object, RuntimeBindReadback>();
  readonly #trustedCleanupAuthorities = new WeakSet<object>();
  readonly #activeCleanupByAttempt = new Map<string, CleanupAuthority>();

  constructor(private readonly client: ServiceRpcClient) {}

  async claimAttempt(
    workerId: string,
    adapterId: DiscoveryAdapterId,
    leaseSeconds: number,
  ): Promise<ClaimedAttempt | null> {
    assertWorkerIdAndLease(workerId, leaseSeconds, "claim");
    if (!isDiscoveryAdapterId(adapterId)) {
      throw new ContractValidationError("claim: invalid adapter");
    }
    const parsed = parseClaimReadback(await rpcOrThrow(
      this.client,
      "claim_company_discovery_attempt",
      {
        p_worker_id: workerId,
        p_adapter_id: adapterId,
        p_lease_seconds: leaseSeconds,
      },
    ), adapterId);
    if (parsed === null) return null;
    const authority = cleanupAuthority(
      parsed.job.job_id,
      parsed.job.attempt_id,
      parsed.runtime_slot_id,
      parsed.job.fence_generation,
      parsed.job.claim_token,
    );
    const claim: ClaimedAttempt = Object.freeze({ ...parsed, cleanup_authority: authority });
    this.#trustedJobs.add(claim.job);
    this.#claimForJob.set(claim.job, claim);
    this.#trustedClaims.add(claim);
    this.#activeClaims.add(claim);
    this.trustCleanupAuthority(authority);
    return claim;
  }

  async bindRuntime(
    claim: ClaimedAttempt,
    runtimeIdentityValue: RuntimeIdentityBinding,
  ): Promise<RuntimeBindReadback> {
    this.assertActiveClaim(claim);
    if (this.#runtimeBindings.has(claim)) {
      throw new ContractValidationError("runtime identity already bound for claim");
    }
    const identity = parseRuntimeIdentity(runtimeIdentityValue, "runtime identity");
    const readback = parseRuntimeBindReadback(await rpcOrThrow(
      this.client,
      "bind_company_discovery_runtime",
      {
        p_attempt_id: claim.job.attempt_id,
        p_fence_generation: claim.job.fence_generation,
        p_claim_token: claim.job.claim_token,
        p_runtime_identity: identity,
      },
    ), claim, identity);
    this.#runtimeBindings.set(claim, readback);
    return readback;
  }

  bindSourceSnapshots(
    claimedJob: WorkerJob,
    snapshots: readonly DiscoverySourceSnapshot[],
  ): WorkerJob {
    const trusted = this.trustedJob(claimedJob, true);
    const bound = parseWorkerJob({ ...trusted, source_snapshots: parseSourceSnapshots(snapshots) });
    const claim = this.#claimForJob.get(claimedJob)!;
    this.#trustedJobs.add(bound);
    this.#claimForJob.set(bound, claim);
    return bound;
  }

  async commitResult(job: WorkerJob, candidate: WorkerResult): Promise<string> {
    const trustedJob = this.trustedJob(job);
    const result = parseWorkerResult(candidate);
    if (JSON.stringify(result.source_snapshots) !== JSON.stringify(trustedJob.source_snapshots)) {
      throw new ContractValidationError("result evidence must equal trusted fetched evidence");
    }
    const claim = this.#claimForJob.get(job)!;
    if (!this.#runtimeBindings.has(claim)) {
      throw new ContractValidationError("runtime identity must be bound before result commit");
    }
    const data = await rpcOrThrow(this.client, "commit_company_discovery_result", {
      p_attempt_id: trustedJob.attempt_id,
      p_fence_generation: trustedJob.fence_generation,
      p_claim_token: trustedJob.claim_token,
      p_result: result,
      p_result_hash: jsonbHash(result),
    });
    return uuid(data, "commit readback");
  }

  async selectResult(job: WorkerJob, expectedVersion: number): Promise<SelectionReadback> {
    const trustedJob = this.trustedJob(job);
    const claim = this.#claimForJob.get(job)!;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        expectedVersion !== claim.job_version) {
      throw new ContractValidationError("expected_version: stale claim version");
    }
    const data = await rpcOrThrow(this.client, "select_company_discovery_result", {
      p_job_id: trustedJob.job_id,
      p_attempt_id: trustedJob.attempt_id,
      p_expected_version: expectedVersion,
    });
    return selectionReadback(data, trustedJob, expectedVersion);
  }

  async terminalizeAttempt(
    claim: ClaimedAttempt,
    outcome: "failed" | "cancelled",
    reason: string,
  ): Promise<TerminalCleanupAuthority> {
    this.assertActiveClaim(claim);
    const binding = this.#runtimeBindings.get(claim);
    if (binding === undefined) {
      throw new ContractValidationError("runtime identity must be bound before terminalization");
    }
    if ((outcome !== "failed" && outcome !== "cancelled") ||
        !/^[a-z][a-z0-9_]{0,99}$/.test(reason)) {
      throw new ContractValidationError("terminal outcome or reason invalid");
    }
    const authority = parseTerminalReadback(await rpcOrThrow(
      this.client,
      "terminalize_company_discovery_attempt",
      {
        p_attempt_id: claim.job.attempt_id,
        p_fence_generation: claim.job.fence_generation,
        p_claim_token: claim.job.claim_token,
        p_outcome: outcome,
        p_reason: reason,
      },
    ), claim, outcome, binding);
    this.#activeClaims.delete(claim);
    this.trustCleanupAuthority(authority);
    return authority;
  }

  async claimExpiredCleanup(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ExpiredCleanupClaim | null> {
    assertWorkerIdAndLease(workerId, leaseSeconds, "expired cleanup claim");
    const parsed = parseExpiredCleanupReadback(await rpcOrThrow(
      this.client,
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: workerId, p_lease_seconds: leaseSeconds },
    ));
    if (parsed === null) return null;
    const authority = cleanupAuthority(
      parsed.job_id,
      parsed.attempt_id,
      parsed.runtime_slot_id,
      parsed.fence_generation,
      parsed.claim_token,
    );
    const claim: ExpiredCleanupClaim = Object.freeze({
      ...parsed,
      cleanup_authority: authority,
    });
    this.trustCleanupAuthority(authority);
    return claim;
  }

  async recordCleanup(
    authority: CleanupAuthority,
    proof: CleanupProof,
  ): Promise<CleanupReadback> {
    if (!this.#trustedCleanupAuthorities.has(authority)) {
      throw new ContractValidationError("trusted cleanup authority object required");
    }
    if (this.#activeCleanupByAttempt.get(authority.attempt_id) !== authority) {
      throw new ContractValidationError("stale cleanup authority object");
    }
    const data = await rpcOrThrow(this.client, "record_company_discovery_cleanup", {
      p_attempt_id: authority.attempt_id,
      p_fence_generation: authority.fence_generation,
      p_claim_token: authority.claim_token,
      p_proof: parseCleanupProof(proof),
    });
    const readback = cleanupReadback(data, authority.attempt_id);
    this.#activeCleanupByAttempt.delete(authority.attempt_id);
    return readback;
  }

  async quarantineSlot(slotId: string, reason: string, proofHash: string): Promise<void> {
    if (!UUID_PATTERN.test(slotId) || reason.trim() === "" || !HASH_PATTERN.test(proofHash)) {
      throw new ContractValidationError("quarantine: invalid slot, reason, or proof hash");
    }
    const data = await rpcOrThrow(this.client, "quarantine_company_discovery_slot", {
      p_slot_id: slotId,
      p_reason: reason,
      p_proof_hash: proofHash,
    });
    if (data !== null) throw new ContractValidationError("quarantine readback: expected null");
  }

  private trustCleanupAuthority(authority: CleanupAuthority): void {
    this.#trustedCleanupAuthorities.add(authority);
    this.#activeCleanupByAttempt.set(authority.attempt_id, authority);
  }

  private assertActiveClaim(claim: ClaimedAttempt): void {
    if (!this.#trustedClaims.has(claim)) {
      throw new ContractValidationError("trusted claimed attempt object required");
    }
    if (!this.#activeClaims.has(claim)) {
      throw new ContractValidationError("stale claimed attempt object");
    }
  }

  private trustedJob(job: WorkerJob, allowEmptyEvidence = false): WorkerJob {
    if (!this.#trustedJobs.has(job)) {
      throw new ContractValidationError("job identity must come from trusted claim readback");
    }
    const claim = this.#claimForJob.get(job);
    if (claim === undefined || !this.#activeClaims.has(claim)) {
      throw new ContractValidationError("stale job authority");
    }
    return parseWorkerJob(job, { allowEmptyEvidence });
  }
}
