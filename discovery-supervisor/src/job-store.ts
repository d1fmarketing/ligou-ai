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

export interface RuntimeSlotCapability {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly runtime_slot_id: string;
}

export interface CleanupAuthority {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly runtime_slot: RuntimeSlotCapability;
  readonly fence_generation: number;
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
  readonly runtime_slot: RuntimeSlotCapability;
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
  readonly recovery_outcome: "cleanup_claimed";
  readonly job_id: string;
  readonly attempt_id: string;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot: RuntimeSlotCapability;
  readonly runtime_identity: RuntimeIdentityBinding;
  readonly runtime_identity_hash: string;
  readonly fence_generation: number;
  readonly job_version: number;
  readonly cleanup_authority: CleanupAuthority;
}

export interface RuntimeNotBoundRecovery {
  readonly recovery_outcome: "runtime_not_bound";
  readonly job_id: string;
  readonly attempt_id: string;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot_id: string;
  readonly fence_generation: number;
  readonly job_version: number;
}

export type ExpiredCleanupRecovery = ExpiredCleanupClaim | RuntimeNotBoundRecovery;

export interface CommittedResultCapability {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly result_id: string;
  readonly job_version: number;
  readonly fence_generation: number;
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
  "recovery_outcome",
] as const;
const COMMIT_KEYS = [
  "job_id",
  "attempt_id",
  "result_id",
  "job_version",
  "fence_generation",
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

function runtimeSlotCapability(
  jobId: string,
  attemptId: string,
  runtimeSlotId: string,
): RuntimeSlotCapability {
  return Object.freeze({
    job_id: jobId,
    attempt_id: attemptId,
    runtime_slot_id: runtimeSlotId,
  });
}

function cleanupAuthority(
  jobId: string,
  attemptId: string,
  runtimeSlot: RuntimeSlotCapability,
  fenceGeneration: number,
): CleanupAuthority {
  return Object.freeze({
    job_id: jobId,
    attempt_id: attemptId,
    runtime_slot: runtimeSlot,
    fence_generation: fenceGeneration,
  });
}

interface ParsedClaimReadback {
  readonly job: WorkerJob;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot_id: string;
  readonly job_version: number;
  readonly claim_token: string;
}

function parseClaimReadback(
  value: unknown,
  requestedAdapter: DiscoveryAdapterId,
): ParsedClaimReadback | null {
  const row = oneRow(value, "claim readback");
  if (row === null) return null;
  exactKeys(row, CLAIM_KEYS, "claim readback");
  if (!isDiscoveryAdapterId(row.adapter_id) || row.adapter_id !== requestedAdapter) {
    throw new ContractValidationError("claim readback: adapter mismatch");
  }
  const runtimeSlotId = uuid(row.runtime_slot_id, "claim readback.runtime_slot_id");
  const claimToken = nonemptyString(row.claim_token, "claim readback.claim_token");
  return {
    job: parseWorkerJob({
      job_type: "company_discovery.v1",
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      attempt_number: row.attempt_number,
      fence_generation: row.fence_generation,
      normalized_origin: row.normalized_origin,
      deadline_at: row.deadline_at,
      budget: row.budget,
      source_snapshots: [],
    }, { allowEmptyEvidence: true }),
    adapter_id: row.adapter_id,
    runtime_slot_id: runtimeSlotId,
    job_version: positiveInteger(row.job_version, "claim readback.job_version"),
    claim_token: claimToken,
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
      parsed.runtime_slot_id !== claim.runtime_slot.runtime_slot_id ||
      parsed.job_version !== claim.job_version ||
      parsed.fence_generation !== claim.job.fence_generation ||
      JSON.stringify(parsed.runtime_identity) !== JSON.stringify(expectedIdentity) ||
      parsed.runtime_identity_hash !== jsonbHash(expectedIdentity)) {
    throw new ContractValidationError("runtime bind readback: mismatched trusted authority or hash");
  }
  return Object.freeze(parsed);
}

interface ParsedTerminalReadback {
  readonly authority: TerminalCleanupAuthority;
  readonly claim_token: string;
}

function parseTerminalReadback(
  value: unknown,
  claim: ClaimedAttempt,
  outcome: "failed" | "cancelled",
  binding: RuntimeBindReadback,
  previousClaimToken: string,
): ParsedTerminalReadback {
  const row = plainRecord(value, "terminal readback");
  exactKeys(row, TERMINAL_KEYS, "terminal readback");
  const jobId = uuid(row.job_id, "terminal readback.job_id");
  const attemptId = uuid(row.attempt_id, "terminal readback.attempt_id");
  const runtimeSlotId = uuid(row.runtime_slot_id, "terminal readback.runtime_slot_id");
  const version = positiveInteger(row.job_version, "terminal readback.job_version");
  const fence = positiveInteger(row.fence_generation, "terminal readback.fence_generation");
  const token = nonemptyString(row.claim_token, "terminal readback.claim_token");
  if (jobId !== claim.job.job_id || attemptId !== claim.job.attempt_id ||
      runtimeSlotId !== claim.runtime_slot.runtime_slot_id || version !== claim.job_version + 1 ||
      fence !== claim.job.fence_generation + 1 || token === previousClaimToken ||
      row.status !== outcome || row.cleanup_state !== "pending") {
    throw new ContractValidationError("terminal readback: mismatched rotated authority");
  }
  return {
    authority: Object.freeze({
      ...cleanupAuthority(jobId, attemptId, claim.runtime_slot, fence),
      job_version: version,
      runtime_identity: binding.runtime_identity,
      runtime_identity_hash: binding.runtime_identity_hash,
      status: outcome,
      cleanup_state: "pending",
    }),
    claim_token: token,
  };
}

interface ParsedExpiredCleanupClaim {
  readonly recovery_outcome: "cleanup_claimed";
  readonly job_id: string;
  readonly attempt_id: string;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot_id: string;
  readonly runtime_identity: RuntimeIdentityBinding;
  readonly runtime_identity_hash: string;
  readonly fence_generation: number;
  readonly claim_token: string;
  readonly job_version: number;
}

type ParsedExpiredCleanupRecovery = ParsedExpiredCleanupClaim | RuntimeNotBoundRecovery;

function parseExpiredCleanupReadback(value: unknown): ParsedExpiredCleanupRecovery | null {
  const row = oneRow(value, "expired cleanup readback");
  if (row === null) return null;
  exactKeys(row, EXPIRED_CLEANUP_KEYS, "expired cleanup readback");
  if (!isDiscoveryAdapterId(row.adapter_id)) {
    throw new ContractValidationError("expired cleanup readback: invalid adapter");
  }
  const base = {
    job_id: uuid(row.job_id, "expired cleanup readback.job_id"),
    attempt_id: uuid(row.attempt_id, "expired cleanup readback.attempt_id"),
    adapter_id: row.adapter_id,
    runtime_slot_id: uuid(row.runtime_slot_id, "expired cleanup readback.runtime_slot_id"),
    fence_generation: positiveInteger(
      row.fence_generation,
      "expired cleanup readback.fence_generation",
    ),
    job_version: positiveInteger(row.job_version, "expired cleanup readback.job_version"),
  };
  if (row.recovery_outcome === "runtime_not_bound") {
    const identity = plainRecord(
      row.runtime_identity,
      "expired cleanup readback.runtime_identity",
    );
    exactKeys(identity, [], "expired cleanup readback.runtime_identity");
    if (row.claim_token !== null) {
      throw new ContractValidationError(
        "expired cleanup readback: runtime_not_bound must not return a claim token",
      );
    }
    return Object.freeze({ ...base, recovery_outcome: "runtime_not_bound" });
  }
  if (row.recovery_outcome !== "cleanup_claimed") {
    throw new ContractValidationError("expired cleanup readback: invalid recovery outcome");
  }
  const identity = parseRuntimeIdentity(
    row.runtime_identity,
    "expired cleanup readback.runtime_identity",
  );
  return {
    ...base,
    recovery_outcome: "cleanup_claimed",
    runtime_identity: identity,
    runtime_identity_hash: jsonbHash(identity),
    claim_token: nonemptyString(row.claim_token, "expired cleanup readback.claim_token"),
  };
}

function committedResultReadback(
  value: unknown,
  job: WorkerJob,
  claimedVersion: number,
): CommittedResultCapability {
  const candidate = plainRecord(value, "commit readback");
  exactKeys(candidate, COMMIT_KEYS, "commit readback");
  const parsed: CommittedResultCapability = {
    job_id: uuid(candidate.job_id, "commit readback.job_id"),
    attempt_id: uuid(candidate.attempt_id, "commit readback.attempt_id"),
    result_id: uuid(candidate.result_id, "commit readback.result_id"),
    job_version: positiveInteger(candidate.job_version, "commit readback.job_version"),
    fence_generation: positiveInteger(
      candidate.fence_generation,
      "commit readback.fence_generation",
    ),
  };
  if (parsed.job_id !== job.job_id || parsed.attempt_id !== job.attempt_id ||
      parsed.job_version !== claimedVersion + 1 ||
      parsed.fence_generation !== job.fence_generation) {
    throw new ContractValidationError("commit readback: mismatched trusted identity or version");
  }
  return Object.freeze(parsed);
}

function selectionReadback(
  value: unknown,
  committed: CommittedResultCapability,
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
  if (parsed.job_id !== committed.job_id || parsed.attempt_id !== committed.attempt_id ||
      parsed.result_id !== committed.result_id ||
      parsed.version !== committed.job_version + 1 ||
      parsed.fence_generation !== committed.fence_generation + 1) {
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
  readonly #claimSecrets = new WeakMap<object, string>();
  readonly #activeClaimByAttempt = new Map<string, ClaimedAttempt>();
  readonly #runtimeBindings = new WeakMap<object, RuntimeBindReadback>();
  readonly #trustedRuntimeSlots = new WeakSet<object>();
  readonly #activeRuntimeSlots = new WeakSet<object>();
  readonly #activeRuntimeSlotByAttempt = new Map<string, RuntimeSlotCapability>();
  readonly #trustedCleanupAuthorities = new WeakSet<object>();
  readonly #activeCleanupByAttempt = new Map<string, CleanupAuthority>();
  readonly #cleanupSecrets = new WeakMap<object, string>();
  readonly #trustedCommittedResults = new WeakSet<object>();
  readonly #activeCommittedResults = new WeakSet<object>();
  readonly #activeCommittedByAttempt = new Map<string, CommittedResultCapability>();

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
    this.invalidateAttemptCapabilities(parsed.job.attempt_id);
    const runtimeSlot = runtimeSlotCapability(
      parsed.job.job_id,
      parsed.job.attempt_id,
      parsed.runtime_slot_id,
    );
    const authority = cleanupAuthority(
      parsed.job.job_id,
      parsed.job.attempt_id,
      runtimeSlot,
      parsed.job.fence_generation,
    );
    const claim: ClaimedAttempt = Object.freeze({
      job: parsed.job,
      adapter_id: parsed.adapter_id,
      runtime_slot: runtimeSlot,
      job_version: parsed.job_version,
      cleanup_authority: authority,
    });
    this.#trustedJobs.add(claim.job);
    this.#claimForJob.set(claim.job, claim);
    this.#trustedClaims.add(claim);
    this.#activeClaims.add(claim);
    this.#claimSecrets.set(claim, parsed.claim_token);
    this.#activeClaimByAttempt.set(claim.job.attempt_id, claim);
    this.trustRuntimeSlot(runtimeSlot);
    this.trustCleanupAuthority(authority, parsed.claim_token);
    return claim;
  }

  async bindRuntime(
    claim: ClaimedAttempt,
    runtimeIdentityValue: RuntimeIdentityBinding,
  ): Promise<RuntimeBindReadback> {
    this.assertActiveClaim(claim);
    const claimToken = this.claimToken(claim);
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
        p_claim_token: claimToken,
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

  async commitResult(
    job: WorkerJob,
    candidate: WorkerResult,
  ): Promise<CommittedResultCapability> {
    const trustedJob = this.trustedJob(job);
    const result = parseWorkerResult(candidate);
    if (JSON.stringify(result.source_snapshots) !== JSON.stringify(trustedJob.source_snapshots)) {
      throw new ContractValidationError("result evidence must equal trusted fetched evidence");
    }
    const claim = this.#claimForJob.get(job)!;
    if (!this.#runtimeBindings.has(claim)) {
      throw new ContractValidationError("runtime identity must be bound before result commit");
    }
    const claimToken = this.claimToken(claim);
    const data = await rpcOrThrow(this.client, "commit_company_discovery_result", {
      p_attempt_id: trustedJob.attempt_id,
      p_fence_generation: trustedJob.fence_generation,
      p_claim_token: claimToken,
      p_result: result,
      p_result_hash: jsonbHash(result),
    });
    const committed = committedResultReadback(data, trustedJob, claim.job_version);
    this.deactivateClaim(claim);
    const previous = this.#activeCommittedByAttempt.get(committed.attempt_id);
    if (previous !== undefined) this.#activeCommittedResults.delete(previous);
    this.#trustedCommittedResults.add(committed);
    this.#activeCommittedResults.add(committed);
    this.#activeCommittedByAttempt.set(committed.attempt_id, committed);
    return committed;
  }

  async selectResult(committed: CommittedResultCapability): Promise<SelectionReadback> {
    this.assertActiveCommittedResult(committed);
    const data = await rpcOrThrow(this.client, "select_company_discovery_result", {
      p_job_id: committed.job_id,
      p_attempt_id: committed.attempt_id,
      p_expected_version: committed.job_version,
    });
    const selected = selectionReadback(data, committed);
    this.#activeCommittedResults.delete(committed);
    if (this.#activeCommittedByAttempt.get(committed.attempt_id) === committed) {
      this.#activeCommittedByAttempt.delete(committed.attempt_id);
    }
    return selected;
  }

  async terminalizeAttempt(
    claim: ClaimedAttempt,
    outcome: "failed" | "cancelled",
    reason: string,
  ): Promise<TerminalCleanupAuthority> {
    this.assertActiveClaim(claim);
    const claimToken = this.claimToken(claim);
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
        p_claim_token: claimToken,
        p_outcome: outcome,
        p_reason: reason,
      },
    ), claim, outcome, binding, claimToken);
    this.deactivateClaim(claim);
    this.trustCleanupAuthority(authority.authority, authority.claim_token);
    return authority.authority;
  }

  async claimExpiredCleanup(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ExpiredCleanupRecovery | null> {
    assertWorkerIdAndLease(workerId, leaseSeconds, "expired cleanup claim");
    const parsed = parseExpiredCleanupReadback(await rpcOrThrow(
      this.client,
      "claim_expired_company_discovery_cleanup",
      { p_worker_id: workerId, p_lease_seconds: leaseSeconds },
    ));
    if (parsed === null) return null;
    this.invalidateAttemptCapabilities(parsed.attempt_id);
    if (parsed.recovery_outcome === "runtime_not_bound") return parsed;
    const runtimeSlot = runtimeSlotCapability(
      parsed.job_id,
      parsed.attempt_id,
      parsed.runtime_slot_id,
    );
    const authority = cleanupAuthority(
      parsed.job_id,
      parsed.attempt_id,
      runtimeSlot,
      parsed.fence_generation,
    );
    const claim: ExpiredCleanupClaim = Object.freeze({
      recovery_outcome: "cleanup_claimed",
      job_id: parsed.job_id,
      attempt_id: parsed.attempt_id,
      adapter_id: parsed.adapter_id,
      runtime_slot: runtimeSlot,
      runtime_identity: parsed.runtime_identity,
      runtime_identity_hash: parsed.runtime_identity_hash,
      fence_generation: parsed.fence_generation,
      job_version: parsed.job_version,
      cleanup_authority: authority,
    });
    this.trustRuntimeSlot(runtimeSlot);
    this.trustCleanupAuthority(authority, parsed.claim_token);
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
    const claimToken = this.#cleanupSecrets.get(authority);
    if (claimToken === undefined) {
      throw new ContractValidationError("cleanup authority secret unavailable");
    }
    const data = await rpcOrThrow(this.client, "record_company_discovery_cleanup", {
      p_attempt_id: authority.attempt_id,
      p_fence_generation: authority.fence_generation,
      p_claim_token: claimToken,
      p_proof: parseCleanupProof(proof),
    });
    const readback = cleanupReadback(data, authority.attempt_id);
    this.#activeCleanupByAttempt.delete(authority.attempt_id);
    if (readback.cleanup_state === "proved" && readback.slot_updated) {
      this.deactivateRuntimeSlot(authority.runtime_slot);
    }
    return readback;
  }

  async quarantineSlot(
    runtimeSlot: RuntimeSlotCapability,
    reason: string,
    proofHash: string,
  ): Promise<void> {
    if (!this.#trustedRuntimeSlots.has(runtimeSlot)) {
      throw new ContractValidationError("trusted runtime slot capability object required");
    }
    if (!this.#activeRuntimeSlots.has(runtimeSlot) ||
        this.#activeRuntimeSlotByAttempt.get(runtimeSlot.attempt_id) !== runtimeSlot) {
      throw new ContractValidationError("stale runtime slot capability object");
    }
    if (reason.trim() === "" || !HASH_PATTERN.test(proofHash)) {
      throw new ContractValidationError("quarantine: invalid slot, reason, or proof hash");
    }
    const data = await rpcOrThrow(this.client, "quarantine_company_discovery_slot", {
      p_slot_id: runtimeSlot.runtime_slot_id,
      p_reason: reason,
      p_proof_hash: proofHash,
    });
    if (data !== null) throw new ContractValidationError("quarantine readback: expected null");
    this.deactivateRuntimeSlot(runtimeSlot);
  }

  private trustCleanupAuthority(authority: CleanupAuthority, claimToken: string): void {
    this.#trustedCleanupAuthorities.add(authority);
    this.#activeCleanupByAttempt.set(authority.attempt_id, authority);
    this.#cleanupSecrets.set(authority, claimToken);
  }

  private trustRuntimeSlot(runtimeSlot: RuntimeSlotCapability): void {
    const previous = this.#activeRuntimeSlotByAttempt.get(runtimeSlot.attempt_id);
    if (previous !== undefined) this.#activeRuntimeSlots.delete(previous);
    this.#trustedRuntimeSlots.add(runtimeSlot);
    this.#activeRuntimeSlots.add(runtimeSlot);
    this.#activeRuntimeSlotByAttempt.set(runtimeSlot.attempt_id, runtimeSlot);
  }

  private deactivateRuntimeSlot(runtimeSlot: RuntimeSlotCapability): void {
    this.#activeRuntimeSlots.delete(runtimeSlot);
    if (this.#activeRuntimeSlotByAttempt.get(runtimeSlot.attempt_id) === runtimeSlot) {
      this.#activeRuntimeSlotByAttempt.delete(runtimeSlot.attempt_id);
    }
  }

  private claimToken(claim: ClaimedAttempt): string {
    const claimToken = this.#claimSecrets.get(claim);
    if (claimToken === undefined) {
      throw new ContractValidationError("claimed attempt secret unavailable");
    }
    return claimToken;
  }

  private deactivateClaim(claim: ClaimedAttempt): void {
    this.#activeClaims.delete(claim);
    if (this.#activeClaimByAttempt.get(claim.job.attempt_id) === claim) {
      this.#activeClaimByAttempt.delete(claim.job.attempt_id);
    }
  }

  private assertActiveCommittedResult(committed: CommittedResultCapability): void {
    if (!this.#trustedCommittedResults.has(committed)) {
      throw new ContractValidationError("trusted committed result capability object required");
    }
    if (!this.#activeCommittedResults.has(committed) ||
        this.#activeCommittedByAttempt.get(committed.attempt_id) !== committed) {
      throw new ContractValidationError("stale committed result capability object");
    }
  }

  private invalidateAttemptCapabilities(attemptId: string): void {
    const claim = this.#activeClaimByAttempt.get(attemptId);
    if (claim !== undefined) this.deactivateClaim(claim);
    const cleanup = this.#activeCleanupByAttempt.get(attemptId);
    if (cleanup !== undefined) this.#activeCleanupByAttempt.delete(attemptId);
    const runtimeSlot = this.#activeRuntimeSlotByAttempt.get(attemptId);
    if (runtimeSlot !== undefined) this.deactivateRuntimeSlot(runtimeSlot);
    const committed = this.#activeCommittedByAttempt.get(attemptId);
    if (committed !== undefined) {
      this.#activeCommittedResults.delete(committed);
      this.#activeCommittedByAttempt.delete(attemptId);
    }
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
