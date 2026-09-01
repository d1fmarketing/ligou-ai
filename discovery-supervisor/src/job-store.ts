import { createHash } from "node:crypto";
import {
  ContractValidationError,
  parseSourceSnapshots,
  parseWorkerJob,
  parseWorkerResult,
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

export interface CleanupProof {
  readonly gateway_exited: boolean;
  readonly container_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_revoked: boolean;
  readonly listener_closed: boolean;
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
  "fence_generation",
  "claim_token",
  "normalized_origin",
  "deadline_at",
  "budget",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function parseClaimReadback(value: unknown): WorkerJob | null {
  if (!Array.isArray(value)) {
    throw new ContractValidationError("claim readback: expected array");
  }
  if (value.length === 0) return null;
  if (value.length !== 1) {
    throw new ContractValidationError("claim readback: expected one row");
  }
  const row = plainRecord(value[0], "claim readback");
  exactKeys(row, CLAIM_KEYS, "claim readback");
  return parseWorkerJob({
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
  }, { allowEmptyEvidence: true });
}

function postgresJsonbText(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new ContractValidationError("result hash: only safe integers are canonical");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(", ")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) =>
    Buffer.byteLength(left) - Buffer.byteLength(right) ||
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${postgresJsonbText(record[key])}`).join(", ")}}`;
}

function resultHash(result: WorkerResult): string {
  return createHash("sha256").update(postgresJsonbText(result), "utf8").digest("hex");
}

function assertPositiveVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContractValidationError("expected_version: expected positive integer");
  }
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

function cleanupReadback(value: unknown, job: WorkerJob): CleanupReadback {
  const candidate = plainRecord(value, "cleanup readback");
  const keys = ["attempt_id", "cleanup_state", "slot_updated"] as const;
  exactKeys(candidate, keys, "cleanup readback");
  const attemptId = uuid(candidate.attempt_id, "cleanup readback.attempt_id");
  if (attemptId !== job.attempt_id ||
      (candidate.cleanup_state !== "proved" && candidate.cleanup_state !== "cleanup_unresolved") ||
      typeof candidate.slot_updated !== "boolean") {
    throw new ContractValidationError("cleanup readback: invalid identity, state, or slot result");
  }
  return Object.freeze({
    attempt_id: attemptId,
    cleanup_state: candidate.cleanup_state,
    slot_updated: candidate.slot_updated,
  });
}

function cleanupProof(value: CleanupProof): CleanupProof {
  const expected = [
    "gateway_exited",
    "container_removed",
    "state_removed",
    "workspace_removed",
    "output_removed",
    "network_removed",
    "credential_revoked",
    "listener_closed",
    "late_result_rejected",
  ];
  const candidate = plainRecord(value, "cleanup proof");
  if (Object.keys(candidate).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(candidate, key) || typeof candidate[key] !== "boolean")) {
    throw new ContractValidationError("cleanup proof: exact boolean fields required");
  }
  return { ...value };
}

export class JobStore {
  readonly #trustedJobs = new WeakSet<object>();

  constructor(private readonly client: ServiceRpcClient) {}

  async claimAttempt(workerId: string, leaseSeconds: number): Promise<WorkerJob | null> {
    if (workerId.trim() === "" || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600) {
      throw new ContractValidationError("claim: invalid worker or lease");
    }
    const job = parseClaimReadback(await rpcOrThrow(this.client, "claim_company_discovery_attempt", {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    }));
    if (job !== null) this.#trustedJobs.add(job);
    return job;
  }

  bindSourceSnapshots(
    claimedJob: WorkerJob,
    snapshots: readonly DiscoverySourceSnapshot[],
  ): WorkerJob {
    this.assertTrusted(claimedJob);
    const trusted = parseWorkerJob(claimedJob, { allowEmptyEvidence: true });
    const bound = parseWorkerJob({ ...trusted, source_snapshots: parseSourceSnapshots(snapshots) });
    this.#trustedJobs.add(bound);
    return bound;
  }

  async commitResult(job: WorkerJob, candidate: WorkerResult): Promise<string> {
    const trustedJob = this.trustedJob(job);
    const result = parseWorkerResult(candidate);
    if (JSON.stringify(result.source_snapshots) !== JSON.stringify(trustedJob.source_snapshots)) {
      throw new ContractValidationError("result evidence must equal trusted fetched evidence");
    }
    const data = await rpcOrThrow(this.client, "commit_company_discovery_result", {
      p_attempt_id: trustedJob.attempt_id,
      p_fence_generation: trustedJob.fence_generation,
      p_claim_token: trustedJob.claim_token,
      p_result: result,
      p_result_hash: resultHash(result),
    });
    return uuid(data, "commit readback");
  }

  async selectResult(job: WorkerJob, expectedVersion: number): Promise<SelectionReadback> {
    const trustedJob = this.trustedJob(job);
    assertPositiveVersion(expectedVersion);
    const data = await rpcOrThrow(this.client, "select_company_discovery_result", {
      p_job_id: trustedJob.job_id,
      p_attempt_id: trustedJob.attempt_id,
      p_expected_version: expectedVersion,
    });
    return selectionReadback(data, trustedJob, expectedVersion);
  }

  async recordCleanup(job: WorkerJob, proof: CleanupProof): Promise<CleanupReadback> {
    const trustedJob = this.trustedJob(job, true);
    const data = await rpcOrThrow(this.client, "record_company_discovery_cleanup", {
      p_attempt_id: trustedJob.attempt_id,
      p_fence_generation: trustedJob.fence_generation,
      p_claim_token: trustedJob.claim_token,
      p_proof: cleanupProof(proof),
    });
    return cleanupReadback(data, trustedJob);
  }

  async quarantineSlot(slotId: string, reason: string, proofHash: string): Promise<void> {
    if (slotId.trim() === "" || reason.trim() === "" || !/^[0-9a-f]{64}$/.test(proofHash)) {
      throw new ContractValidationError("quarantine: invalid slot, reason, or proof hash");
    }
    const data = await rpcOrThrow(this.client, "quarantine_company_discovery_slot", {
      p_slot_id: slotId,
      p_reason: reason,
      p_proof_hash: proofHash,
    });
    if (data !== null) throw new ContractValidationError("quarantine readback: expected null");
  }

  private assertTrusted(job: WorkerJob): void {
    if (!this.#trustedJobs.has(job)) {
      throw new ContractValidationError("job identity must come from trusted claim readback");
    }
  }

  private trustedJob(job: WorkerJob, allowEmptyEvidence = false): WorkerJob {
    this.assertTrusted(job);
    return parseWorkerJob(job, { allowEmptyEvidence });
  }
}
