import { createHash, randomUUID } from "node:crypto";
import {
  ContractValidationError,
  isDiscoveryAdapterId,
  parseSourceSnapshots,
  parseWorkerJob,
  parseWorkerResult,
  type DiscoveryAdapterId,
  type DiscoverySourceSnapshot,
  type ModelAccessAuthority,
  type ModelAccessCapability,
  type ModelAccessContext,
  type ModelAccessExpectation,
  type SubscriptionRecoveryCapability,
  type SubscriptionRecoveryContext,
  type SubscriptionRequestProspective,
  type SubscriptionRequestReservationCapability,
  type SubscriptionRequestSettlement,
  type SubscriptionReservationReadback,
  type SubscriptionSettlementReadback,
  type SubscriptionCredentialOwnerBinding,
  type SubscriptionQuotaRecoveryAuthority,
  type SubscriptionQuotaRecoveryCapability,
  type SubscriptionQuotaRecoveryClaim,
  type SubscriptionQuotaRecoveryClaimResult,
  type SubscriptionQuotaRecoveryObservation,
  type SubscriptionQuotaRecoveryReadback,
  type SubscriptionQuotaRecoverySettlement,
  type SubscriptionQuotaRecoveryTerminalReason,
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

export interface OpenClawRuntimeIdentityBinding {
  readonly runtime_kind: "openclaw_cell";
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
  readonly cell_image: RuntimeImageEvidence;
  readonly bridge_image: RuntimeImageEvidence;
  readonly subscription_socket_path: string;
}

export interface DirectModelRuntimeIdentityBinding {
  readonly runtime_kind: "direct_model_subscription";
  readonly subscription_socket_path: string;
}

export type RuntimeIdentityBinding =
  | OpenClawRuntimeIdentityBinding
  | DirectModelRuntimeIdentityBinding;

export interface RuntimeImageEvidence {
  readonly reference: string;
  readonly index_digest: string;
  readonly platform: "linux/arm64" | "linux/amd64";
  readonly selected_manifest_digest: string;
  readonly image_id: string;
  readonly config_digest: string;
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
  readonly subscription_recovery: SubscriptionRecoveryCapability;
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
  readonly model_access: ModelAccessCapability;
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

export interface OpenClawCleanupProof {
  readonly gateway_exited: boolean;
  readonly container_removed: boolean;
  readonly bridge_removed: boolean;
  readonly config_removed: boolean;
  readonly state_removed: boolean;
  readonly workspace_removed: boolean;
  readonly output_removed: boolean;
  readonly network_removed: boolean;
  readonly credential_material_removed: boolean;
  readonly subscription_lease_revoked: boolean;
  readonly subscription_requests_drained: boolean;
  readonly subscription_listener_closed: boolean;
  readonly subscription_socket_absent: boolean;
  readonly listener_closed: boolean;
  readonly identity_process_absent: boolean;
  readonly late_result_rejected: boolean;
}

export interface DirectModelCleanupProof {
  readonly subscription_lease_revoked: boolean;
  readonly subscription_requests_drained: boolean;
  readonly subscription_listener_closed: boolean;
  readonly subscription_socket_absent: boolean;
  readonly identity_process_absent: boolean;
  readonly late_result_rejected: boolean;
}

export type CleanupProof = OpenClawCleanupProof | DirectModelCleanupProof;

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
  "tenant_id",
  "credential_owner_id",
  "credential_generation",
  "subscription_account_hash",
] as const;
const RUNTIME_IDENTITY_KEYS = [
  "runtime_kind",
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
  "cell_image",
  "bridge_image",
  "subscription_socket_path",
] as const;
const DIRECT_RUNTIME_IDENTITY_KEYS = [
  "runtime_kind",
  "subscription_socket_path",
] as const;
const RUNTIME_NAME_KEYS = [
  "cell_container_name", "bridge_container_name", "internal_network_name",
  "egress_network_name", "config_volume_name", "state_volume_name",
  "workspace_volume_name", "output_volume_name", "gateway_secret_volume_name",
  "bridge_secret_volume_name", "profile_name",
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
  "credential_material_removed",
  "subscription_lease_revoked",
  "subscription_requests_drained",
  "subscription_listener_closed",
  "subscription_socket_absent",
  "listener_closed",
  "identity_process_absent",
  "late_result_rejected",
] as const;
const DIRECT_CLEANUP_PROOF_KEYS = [
  "subscription_lease_revoked",
  "subscription_requests_drained",
  "subscription_listener_closed",
  "subscription_socket_absent",
  "identity_process_absent",
  "late_result_rejected",
] as const;
const MODEL_ACCESS_READBACK_KEYS = [
  "tenant_id",
  "job_id",
  "attempt_id",
  "fence_generation",
  "runtime_slot_id",
  "adapter_id",
  "deadline_at",
  "subscription_socket_path",
  "runtime_identity_hash",
  "credential_owner_id",
  "expected_account_hash",
  "credential_generation",
  "provider",
  "auth_kind",
  "model",
] as const;
const SUBSCRIPTION_RECOVERY_READBACK_KEYS = [
  "job_id",
  "attempt_id",
  "fence_generation",
  "subscription_socket_path",
  "runtime_kind",
  "late_result_rejected",
] as const;
const SUBSCRIPTION_RESERVATION_READBACK_KEYS = [
  "reservation_id", "reservation_token", "request_number", "lease_until",
  "quota_state", "current_requests", "current_input_bytes",
  "current_output_bytes", "max_requests", "max_input_bytes",
  "max_output_bytes", "owner_current_requests", "owner_current_input_bytes",
  "owner_current_output_bytes", "owner_max_requests", "owner_max_input_bytes",
  "owner_max_output_bytes", "max_concurrency",
] as const;
const SUBSCRIPTION_SETTLEMENT_READBACK_KEYS = [
  "settled", "quota_state", "cooldown_until", "current_requests",
  "current_input_bytes", "current_output_bytes", "max_requests",
  "max_input_bytes", "max_output_bytes", "owner_current_requests",
  "owner_current_input_bytes", "owner_current_output_bytes",
  "owner_max_requests", "owner_max_input_bytes", "owner_max_output_bytes",
  "max_concurrency",
] as const;
const SUBSCRIPTION_QUOTA_RECOVERY_CLAIM_KEYS = [
  "probe_id", "recovery_generation", "claim_token", "lease_until",
  "deadline_at", "credential_owner_id", "credential_generation",
  "expected_account_hash", "provider", "auth_kind", "model",
] as const;
const SUBSCRIPTION_QUOTA_RECOVERY_OBSERVATION_KEYS = [
  "request_sha256", "response_sha256", "request_bytes", "response_bytes",
  "input_tokens", "output_tokens", "total_tokens", "usage_complete",
  "terminal_complete",
] as const;
const SUBSCRIPTION_QUOTA_RECOVERY_READBACK_KEYS = [
  "probe_id", "recovery_generation", "status", "quota_state",
  "next_probe_at", "governor_recovered",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REFERENCE_PATTERN =
  /^[a-z0-9][a-z0-9._:/-]{0,310}@sha256:[0-9a-f]{64}$/;
const SUBSCRIPTION_SOCKET_PATTERN = /^\/run\/ligou-discovery\/[0-9a-f]{48}\/subscription[.]sock$/;
const OPENCLAW_CELL_IMAGE =
  "ghcr.io/openclaw/openclaw@sha256:e7849cb6c1ef1ead39ab4be7d85edb2df89611f486e283284c7cf35ce39a20d4";
const RUNTIME_IMAGE_KEYS = [
  "reference", "index_digest", "platform", "selected_manifest_digest",
  "image_id", "config_digest",
] as const;

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

function nonnegativeInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractValidationError(`${message}: nonnegative integer required`);
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

function parseRuntimeImageEvidence(
  value: unknown,
  kind: "cell" | "bridge",
  message: string,
): RuntimeImageEvidence {
  const candidate = plainRecord(value, message);
  exactKeys(candidate, RUNTIME_IMAGE_KEYS, message);
  const reference = nonemptyString(candidate.reference, `${message}.reference`, 384);
  const indexDigest = nonemptyString(candidate.index_digest, `${message}.index_digest`, 71);
  const selectedManifest = nonemptyString(
    candidate.selected_manifest_digest,
    `${message}.selected_manifest_digest`,
    71,
  );
  const imageId = nonemptyString(candidate.image_id, `${message}.image_id`, 71);
  const configDigest = nonemptyString(candidate.config_digest, `${message}.config_digest`, 71);
  if (!DIGEST_PATTERN.test(indexDigest) || !DIGEST_PATTERN.test(selectedManifest) ||
      !DIGEST_PATTERN.test(imageId) || !DIGEST_PATTERN.test(configDigest) ||
      (candidate.platform !== "linux/arm64" && candidate.platform !== "linux/amd64") ||
      !IMAGE_REFERENCE_PATTERN.test(reference) ||
      reference.slice(reference.lastIndexOf("@") + 1) !== indexDigest ||
      (kind === "cell" && reference !== OPENCLAW_CELL_IMAGE)) {
    throw new ContractValidationError(`${message}: invalid runtime image evidence`);
  }
  return Object.freeze({
    reference,
    index_digest: indexDigest,
    platform: candidate.platform,
    selected_manifest_digest: selectedManifest,
    image_id: imageId,
    config_digest: configDigest,
  } as RuntimeImageEvidence);
}

function parseRuntimeIdentity(value: unknown, message: string): RuntimeIdentityBinding {
  const candidate = plainRecord(value, message);
  const socketPath = nonemptyString(
    candidate.subscription_socket_path,
    `${message}.subscription_socket_path`,
    128,
  );
  if (!SUBSCRIPTION_SOCKET_PATTERN.test(socketPath)) {
    throw new ContractValidationError(`${message}.subscription_socket_path: invalid path`);
  }
  if (candidate.runtime_kind === "direct_model_subscription") {
    exactKeys(candidate, DIRECT_RUNTIME_IDENTITY_KEYS, message);
    return Object.freeze({
      runtime_kind: "direct_model_subscription",
      subscription_socket_path: socketPath,
    });
  }
  if (candidate.runtime_kind !== "openclaw_cell") {
    throw new ContractValidationError(`${message}.runtime_kind: invalid kind`);
  }
  exactKeys(candidate, RUNTIME_IDENTITY_KEYS, message);
  const parsed: Record<string, unknown> = {};
  parsed.runtime_kind = "openclaw_cell";
  for (const key of RUNTIME_NAME_KEYS) {
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
  parsed.cell_image = parseRuntimeImageEvidence(candidate.cell_image, "cell", `${message}.cell_image`);
  parsed.bridge_image = parseRuntimeImageEvidence(
    candidate.bridge_image,
    "bridge",
    `${message}.bridge_image`,
  );
  parsed.subscription_socket_path = socketPath;
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
  subscriptionRecovery: SubscriptionRecoveryCapability,
): CleanupAuthority {
  return Object.freeze({
    job_id: jobId,
    attempt_id: attemptId,
    runtime_slot: runtimeSlot,
    fence_generation: fenceGeneration,
    subscription_recovery: subscriptionRecovery,
  });
}

interface ParsedClaimReadback {
  readonly job: WorkerJob;
  readonly adapter_id: DiscoveryAdapterId;
  readonly runtime_slot_id: string;
  readonly job_version: number;
  readonly claim_token: string;
  readonly tenant_id: string;
  readonly credential_owner_id: string;
  readonly credential_generation: number;
  readonly subscription_account_hash: string;
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
    tenant_id: uuid(row.tenant_id, "claim readback.tenant_id"),
    credential_owner_id: uuid(
      row.credential_owner_id,
      "claim readback.credential_owner_id",
    ),
    credential_generation: positiveInteger(
      row.credential_generation,
      "claim readback.credential_generation",
    ),
    subscription_account_hash: hash(
      row.subscription_account_hash,
      "claim readback.subscription_account_hash",
    ),
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
  subscriptionRecovery: SubscriptionRecoveryCapability,
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
      ...cleanupAuthority(
        jobId,
        attemptId,
        claim.runtime_slot,
        fence,
        subscriptionRecovery,
      ),
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

function parseCleanupProof(
  value: CleanupProof,
  adapterId: DiscoveryAdapterId,
): CleanupProof {
  const candidate = plainRecord(value, "cleanup proof");
  const keys = adapterId === "openclaw"
    ? CLEANUP_PROOF_KEYS
    : DIRECT_CLEANUP_PROOF_KEYS;
  exactKeys(candidate, keys, "cleanup proof");
  if (keys.some((key) => typeof candidate[key] !== "boolean")) {
    throw new ContractValidationError("cleanup proof: exact boolean fields required");
  }
  return Object.freeze({ ...candidate }) as unknown as CleanupProof;
}

interface ModelAccessState {
  readonly tenant_id: string;
  readonly credential_owner_id: string;
  readonly credential_generation: number;
  readonly expected_account_hash: string;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
  readonly runtime_slot_id: string;
  readonly adapter_id: DiscoveryAdapterId;
  readonly deadline_at: string;
  readonly source_snapshot_count: number;
  readonly subscription_socket_path?: string;
  readonly runtime_identity_hash?: string;
}

function opaqueModelAccessCapability(): ModelAccessCapability {
  return Object.freeze(Object.create(null)) as ModelAccessCapability;
}

function opaqueSubscriptionRecoveryCapability(): SubscriptionRecoveryCapability {
  return Object.freeze(Object.create(null)) as SubscriptionRecoveryCapability;
}

interface SubscriptionRecoveryState {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
  readonly subscription_socket_path?: string;
  readonly runtime_kind?: RuntimeIdentityBinding["runtime_kind"];
}

function parseSubscriptionRecoveryReadback(
  value: unknown,
  state: SubscriptionRecoveryState,
): Readonly<SubscriptionRecoveryContext> {
  const row = plainRecord(value, "subscription recovery readback");
  exactKeys(row, SUBSCRIPTION_RECOVERY_READBACK_KEYS, "subscription recovery readback");
  if (state.subscription_socket_path === undefined || state.runtime_kind === undefined) {
    throw new ContractValidationError("subscription recovery runtime identity is not bound");
  }
  const runtimeKind = row.runtime_kind;
  if (runtimeKind !== "openclaw_cell" && runtimeKind !== "direct_model_subscription") {
    throw new ContractValidationError("subscription recovery readback: invalid runtime kind");
  }
  if (row.late_result_rejected !== true) {
    throw new ContractValidationError("subscription recovery readback: late result not rejected");
  }
  const parsed = Object.freeze({
    job_id: uuid(row.job_id, "subscription recovery readback.job_id"),
    attempt_id: uuid(row.attempt_id, "subscription recovery readback.attempt_id"),
    fence_generation: positiveInteger(
      row.fence_generation,
      "subscription recovery readback.fence_generation",
    ),
    subscription_socket_path: nonemptyString(
      row.subscription_socket_path,
      "subscription recovery readback.subscription_socket_path",
      128,
    ),
    runtime_kind: runtimeKind,
    late_result_rejected: true as const,
  });
  if (parsed.job_id !== state.job_id || parsed.attempt_id !== state.attempt_id ||
      parsed.fence_generation !== state.fence_generation ||
      parsed.subscription_socket_path !== state.subscription_socket_path ||
      parsed.runtime_kind !== state.runtime_kind) {
    throw new ContractValidationError("subscription recovery readback mismatched authority");
  }
  return parsed;
}

interface SubscriptionQuotaRecoveryState {
  readonly probe_id: string;
  readonly recovery_generation: number;
  readonly claim_token: string;
  readonly credential_owner_id: string;
  readonly credential_generation: number;
  readonly expected_account_hash: string;
}

function opaqueSubscriptionQuotaRecoveryCapability(): SubscriptionQuotaRecoveryCapability {
  return Object.freeze(Object.create(null)) as SubscriptionQuotaRecoveryCapability;
}

function parseSubscriptionQuotaRecoveryClaim(
  value: unknown,
  owner: SubscriptionCredentialOwnerBinding,
  capability: SubscriptionQuotaRecoveryCapability,
):
  | { readonly blocked: Readonly<{ state: "blocked" }> }
  | { readonly claim: SubscriptionQuotaRecoveryClaim; readonly claim_token: string }
  | null {
  if (value === null) return null;
  const row = plainRecord(value, "subscription quota recovery claim");
  if (Object.keys(row).length === 1 && row.state === "blocked") {
    return Object.freeze({ blocked: Object.freeze({ state: "blocked" as const }) });
  }
  exactKeys(row, SUBSCRIPTION_QUOTA_RECOVERY_CLAIM_KEYS, "subscription quota recovery claim");
  if (row.provider !== "openai-codex" ||
      row.auth_kind !== "chatgpt_subscription_oauth" || row.model !== "gpt-5.6-sol") {
    throw new ContractValidationError("subscription quota recovery claim: fixed identity required");
  }
  const leaseUntil = nonemptyString(
    row.lease_until,
    "subscription quota recovery claim.lease_until",
    64,
  );
  const deadlineAt = nonemptyString(
    row.deadline_at,
    "subscription quota recovery claim.deadline_at",
    64,
  );
  if (!Number.isFinite(Date.parse(leaseUntil)) ||
      Date.parse(deadlineAt) !== Date.parse(leaseUntil)) {
    throw new ContractValidationError("subscription quota recovery claim: invalid deadline");
  }
  const claimToken = nonemptyString(
    row.claim_token,
    "subscription quota recovery claim token",
    64,
  );
  if (!/^[0-9a-f]{64}$/.test(claimToken)) {
    throw new ContractValidationError("subscription quota recovery claim token: invalid format");
  }
  const claim = Object.freeze({
    capability,
    probe_id: uuid(row.probe_id, "subscription quota recovery probe id"),
    recovery_generation: positiveInteger(
      row.recovery_generation,
      "subscription quota recovery generation",
    ),
    lease_until: leaseUntil,
    deadline_at: deadlineAt,
    credential_owner_id: uuid(
      row.credential_owner_id,
      "subscription quota recovery credential owner",
    ),
    credential_generation: positiveInteger(
      row.credential_generation,
      "subscription quota recovery credential generation",
    ),
    expected_account_hash: hash(
      row.expected_account_hash,
      "subscription quota recovery account hash",
    ),
    provider: "openai-codex" as const,
    auth_kind: "chatgpt_subscription_oauth" as const,
    model: "gpt-5.6-sol" as const,
  });
  if (claim.credential_owner_id !== owner.credential_owner_id ||
      claim.credential_generation !== owner.credential_generation ||
      claim.expected_account_hash !== owner.account_id_sha256) {
    throw new ContractValidationError("subscription quota recovery claim mismatched owner");
  }
  return Object.freeze({ claim, claim_token: claimToken });
}

function parseSubscriptionQuotaRecoveryObservation(
  value: unknown,
): Readonly<SubscriptionQuotaRecoveryObservation> {
  const row = plainRecord(value, "subscription quota recovery observation");
  exactKeys(
    row,
    SUBSCRIPTION_QUOTA_RECOVERY_OBSERVATION_KEYS,
    "subscription quota recovery observation",
  );
  const optionalHash = (candidate: unknown, name: string) => candidate === null
    ? null
    : hash(candidate, name);
  const optionalCount = (candidate: unknown, name: string) => candidate === null
    ? null
    : nonnegativeInteger(candidate, name);
  const parsed = Object.freeze({
    request_sha256: optionalHash(row.request_sha256, "quota recovery request hash"),
    response_sha256: optionalHash(row.response_sha256, "quota recovery response hash"),
    request_bytes: nonnegativeInteger(row.request_bytes, "quota recovery request bytes"),
    response_bytes: nonnegativeInteger(row.response_bytes, "quota recovery response bytes"),
    input_tokens: optionalCount(row.input_tokens, "quota recovery input tokens"),
    output_tokens: optionalCount(row.output_tokens, "quota recovery output tokens"),
    total_tokens: optionalCount(row.total_tokens, "quota recovery total tokens"),
    usage_complete: row.usage_complete,
    terminal_complete: row.terminal_complete,
  });
  if (parsed.request_bytes > 4_096 || parsed.response_bytes > 32_768 ||
      typeof parsed.usage_complete !== "boolean" ||
      typeof parsed.terminal_complete !== "boolean" ||
      [parsed.input_tokens, parsed.output_tokens, parsed.total_tokens].some(
        (count) => count !== null && count > 1_000_000,
      )) {
    throw new ContractValidationError("subscription quota recovery observation invalid");
  }
  return parsed as Readonly<SubscriptionQuotaRecoveryObservation>;
}

function parseSubscriptionQuotaRecoveryReadback(
  value: unknown,
  state: SubscriptionQuotaRecoveryState,
): Readonly<SubscriptionQuotaRecoveryReadback> {
  const row = plainRecord(value, "subscription quota recovery readback");
  exactKeys(row, SUBSCRIPTION_QUOTA_RECOVERY_READBACK_KEYS, "subscription quota recovery readback");
  if ((row.status !== "succeeded" && row.status !== "ambiguous") ||
      (row.quota_state !== "available" && row.quota_state !== "unknown") ||
      typeof row.governor_recovered !== "boolean" ||
      (row.status === "succeeded") !== row.governor_recovered ||
      (row.status === "succeeded") !== (row.quota_state === "available") ||
      (row.status === "succeeded") !== (row.next_probe_at === null) ||
      (row.next_probe_at !== null &&
        (typeof row.next_probe_at !== "string" || !Number.isFinite(Date.parse(row.next_probe_at))))) {
    throw new ContractValidationError("subscription quota recovery readback invalid");
  }
  const parsed = Object.freeze({
    probe_id: uuid(row.probe_id, "subscription quota recovery readback.probe_id"),
    recovery_generation: positiveInteger(
      row.recovery_generation,
      "subscription quota recovery readback.generation",
    ),
    status: row.status,
    quota_state: row.quota_state,
    next_probe_at: row.next_probe_at as string | null,
    governor_recovered: row.governor_recovered,
  }) as Readonly<SubscriptionQuotaRecoveryReadback>;
  if (parsed.probe_id !== state.probe_id ||
      parsed.recovery_generation !== state.recovery_generation) {
    throw new ContractValidationError("subscription quota recovery readback mismatched authority");
  }
  return parsed;
}

interface SubscriptionReservationState {
  readonly reservation_id: string;
  readonly reservation_token: string;
  readonly claim_token: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
  readonly prospective_input_bytes: number;
  readonly prospective_output_bytes: number;
}

function opaqueSubscriptionReservation(): SubscriptionRequestReservationCapability {
  return Object.freeze(Object.create(null)) as SubscriptionRequestReservationCapability;
}

function parseSubscriptionReservationReadback(
  value: unknown,
  prospective: SubscriptionRequestProspective,
  deadlineAt: string,
): {
  readonly safe: Omit<SubscriptionReservationReadback, "reservation">;
  readonly reservation_id: string;
  readonly reservation_token: string;
} {
  const row = plainRecord(value, "subscription reservation readback");
  exactKeys(row, SUBSCRIPTION_RESERVATION_READBACK_KEYS, "subscription reservation readback");
  if (row.quota_state !== "available" || row.max_requests !== 28 ||
      row.max_input_bytes !== 400_000 || row.max_output_bytes !== 8_388_608 ||
      row.owner_max_requests !== 140 || row.owner_max_input_bytes !== 2_000_000 ||
      row.owner_max_output_bytes !== 40_000_000 ||
      row.max_concurrency !== 1) {
    throw new ContractValidationError("subscription reservation readback: invalid limits");
  }
  const leaseUntil = nonemptyString(row.lease_until, "subscription reservation lease", 64);
  if (Number.isNaN(Date.parse(leaseUntil)) ||
      Date.parse(leaseUntil) > Date.parse(deadlineAt)) {
    throw new ContractValidationError("subscription reservation readback: invalid lease");
  }
  const safe = Object.freeze({
    request_number: positiveInteger(row.request_number, "subscription request number"),
    lease_until: leaseUntil,
    quota_state: "available" as const,
    current_requests: positiveInteger(row.current_requests, "subscription current requests"),
    current_input_bytes: positiveInteger(
      row.current_input_bytes,
      "subscription current input bytes",
    ),
    current_output_bytes: positiveInteger(
      row.current_output_bytes,
      "subscription current output bytes",
    ),
    max_requests: 28 as const,
    max_input_bytes: 400_000 as const,
    max_output_bytes: 8_388_608 as const,
    owner_current_requests: positiveInteger(
      row.owner_current_requests,
      "subscription owner current requests",
    ),
    owner_current_input_bytes: positiveInteger(
      row.owner_current_input_bytes,
      "subscription owner current input bytes",
    ),
    owner_current_output_bytes: positiveInteger(
      row.owner_current_output_bytes,
      "subscription owner current output bytes",
    ),
    owner_max_requests: 140 as const,
    owner_max_input_bytes: 2_000_000 as const,
    owner_max_output_bytes: 40_000_000 as const,
    max_concurrency: 1 as const,
  });
  if (safe.current_requests > safe.max_requests ||
      safe.request_number !== safe.current_requests ||
      safe.current_input_bytes > safe.max_input_bytes ||
      safe.current_output_bytes > safe.max_output_bytes ||
      safe.owner_current_requests > safe.owner_max_requests ||
      safe.owner_current_input_bytes > safe.owner_max_input_bytes ||
      safe.owner_current_output_bytes > safe.owner_max_output_bytes ||
      safe.owner_current_requests < safe.current_requests ||
      safe.owner_current_input_bytes < safe.current_input_bytes ||
      safe.owner_current_output_bytes < safe.current_output_bytes ||
      safe.current_input_bytes < prospective.input_bytes ||
      safe.current_output_bytes < prospective.output_bytes ||
      safe.owner_current_input_bytes < prospective.input_bytes ||
      safe.owner_current_output_bytes < prospective.output_bytes) {
    throw new ContractValidationError("subscription reservation readback: counters invalid");
  }
  return {
    safe,
    reservation_id: uuid(row.reservation_id, "subscription reservation id"),
    reservation_token: (() => {
      const token = nonemptyString(
        row.reservation_token,
        "subscription reservation token",
        64,
      );
      if (!/^[0-9a-f]{64}$/.test(token)) {
        throw new ContractValidationError("subscription reservation token: invalid format");
      }
      return token;
    })(),
  };
}

function parseSubscriptionSettlementReadback(
  value: unknown,
): Readonly<SubscriptionSettlementReadback> {
  const row = plainRecord(value, "subscription settlement readback");
  exactKeys(row, SUBSCRIPTION_SETTLEMENT_READBACK_KEYS, "subscription settlement readback");
  if (row.settled !== true ||
      (row.quota_state !== "available" && row.quota_state !== "cooldown" &&
       row.quota_state !== "unknown") ||
      ((row.quota_state === "cooldown") !== (row.cooldown_until !== null)) ||
      (row.cooldown_until !== null &&
       (typeof row.cooldown_until !== "string" || Number.isNaN(Date.parse(row.cooldown_until))))) {
    throw new ContractValidationError("subscription settlement readback: invalid state");
  }
  if (row.max_requests !== 28 || row.max_input_bytes !== 400_000 ||
      row.max_output_bytes !== 8_388_608 || row.owner_max_requests !== 140 ||
      row.owner_max_input_bytes !== 2_000_000 ||
      row.owner_max_output_bytes !== 40_000_000 || row.max_concurrency !== 1) {
    throw new ContractValidationError("subscription settlement readback: invalid limits");
  }
  const parsed = Object.freeze({
    settled: true,
    quota_state: row.quota_state,
    cooldown_until: row.cooldown_until as string | null,
    current_requests: nonnegativeInteger(row.current_requests, "subscription current requests"),
    current_input_bytes: nonnegativeInteger(
      row.current_input_bytes,
      "subscription current input bytes",
    ),
    current_output_bytes: nonnegativeInteger(
      row.current_output_bytes,
      "subscription current output bytes",
    ),
    max_requests: 28 as const,
    max_input_bytes: 400_000 as const,
    max_output_bytes: 8_388_608 as const,
    owner_current_requests: nonnegativeInteger(
      row.owner_current_requests,
      "subscription owner current requests",
    ),
    owner_current_input_bytes: nonnegativeInteger(
      row.owner_current_input_bytes,
      "subscription owner current input bytes",
    ),
    owner_current_output_bytes: nonnegativeInteger(
      row.owner_current_output_bytes,
      "subscription owner current output bytes",
    ),
    owner_max_requests: 140 as const,
    owner_max_input_bytes: 2_000_000 as const,
    owner_max_output_bytes: 40_000_000 as const,
    max_concurrency: 1 as const,
  });
  if (parsed.current_requests > parsed.max_requests ||
      parsed.current_input_bytes > parsed.max_input_bytes ||
      parsed.current_output_bytes > parsed.max_output_bytes ||
      parsed.owner_current_requests > parsed.owner_max_requests ||
      parsed.owner_current_input_bytes > parsed.owner_max_input_bytes ||
      parsed.owner_current_output_bytes > parsed.owner_max_output_bytes ||
      parsed.owner_current_requests < parsed.current_requests ||
      parsed.owner_current_input_bytes < parsed.current_input_bytes ||
      parsed.owner_current_output_bytes < parsed.current_output_bytes) {
    throw new ContractValidationError("subscription settlement readback: counters invalid");
  }
  return parsed;
}

function expectationMatches(
  state: ModelAccessState,
  expected: ModelAccessExpectation,
): boolean {
  return state.adapter_id === expected.adapter_id && state.job_id === expected.job_id &&
    state.attempt_id === expected.attempt_id &&
    state.fence_generation === expected.fence_generation &&
    (expected.runtime_slot_id === undefined ||
      state.runtime_slot_id === expected.runtime_slot_id);
}

function parseModelAccessReadback(
  value: unknown,
  state: ModelAccessState,
): Readonly<ModelAccessContext> {
  const row = plainRecord(value, "model access readback");
  exactKeys(row, MODEL_ACCESS_READBACK_KEYS, "model access readback");
  if (state.subscription_socket_path === undefined || state.runtime_identity_hash === undefined) {
    throw new ContractValidationError("model access runtime identity is not bound");
  }
  const adapter = row.adapter_id;
  if (!isDiscoveryAdapterId(adapter) || row.provider !== "openai-codex" ||
      row.auth_kind !== "chatgpt_subscription_oauth" || row.model !== "gpt-5.6-sol") {
    throw new ContractValidationError("model access readback: fixed subscription identity required");
  }
  const parsed = Object.freeze({
    tenant_id: uuid(row.tenant_id, "model access readback.tenant_id"),
    credential_owner_id: uuid(
      row.credential_owner_id,
      "model access readback.credential_owner_id",
    ),
    credential_generation: positiveInteger(
      row.credential_generation,
      "model access readback.credential_generation",
    ),
    expected_account_hash: hash(
      row.expected_account_hash,
      "model access readback.expected_account_hash",
    ),
    job_id: uuid(row.job_id, "model access readback.job_id"),
    attempt_id: uuid(row.attempt_id, "model access readback.attempt_id"),
    fence_generation: positiveInteger(
      row.fence_generation,
      "model access readback.fence_generation",
    ),
    runtime_slot_id: uuid(row.runtime_slot_id, "model access readback.runtime_slot_id"),
    adapter_id: adapter,
    deadline_at: nonemptyString(row.deadline_at, "model access readback.deadline_at", 64),
    source_snapshot_count: state.source_snapshot_count,
    subscription_socket_path: nonemptyString(
      row.subscription_socket_path,
      "model access readback.subscription_socket_path",
      128,
    ),
    runtime_identity_hash: hash(
      row.runtime_identity_hash,
      "model access readback.runtime_identity_hash",
    ),
    provider: "openai-codex" as const,
    auth_kind: "chatgpt_subscription_oauth" as const,
    model: "gpt-5.6-sol" as const,
  });
  if (parsed.tenant_id !== state.tenant_id ||
      parsed.credential_owner_id !== state.credential_owner_id ||
      parsed.credential_generation !== state.credential_generation ||
      parsed.expected_account_hash !== state.expected_account_hash ||
      !expectationMatches(state, parsed) ||
      Date.parse(parsed.deadline_at) !== Date.parse(state.deadline_at) ||
      parsed.subscription_socket_path !== state.subscription_socket_path ||
      parsed.runtime_identity_hash !== state.runtime_identity_hash) {
    throw new ContractValidationError("model access readback mismatched private authority");
  }
  return parsed;
}

function assertWorkerIdAndLease(workerId: string, leaseSeconds: number, message: string): void {
  if (workerId.trim() === "" || workerId.length > 200 ||
      !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 600) {
    throw new ContractValidationError(`${message}: invalid worker or lease`);
  }
}

export class JobStore implements ModelAccessAuthority, SubscriptionQuotaRecoveryAuthority {
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
  readonly #cleanupAdapters = new WeakMap<object, DiscoveryAdapterId>();
  readonly #trustedCommittedResults = new WeakSet<object>();
  readonly #activeCommittedResults = new WeakSet<object>();
  readonly #activeCommittedByAttempt = new Map<string, CommittedResultCapability>();
  readonly #modelAccessStates = new WeakMap<object, ModelAccessState>();
  readonly #trustedModelAccess = new WeakSet<object>();
  readonly #activeModelAccess = new WeakSet<object>();
  readonly #activeModelAccessByAttempt = new Map<string, ModelAccessCapability>();
  readonly #trustedSubscriptionRecovery = new WeakSet<object>();
  readonly #activeSubscriptionRecovery = new WeakSet<object>();
  readonly #subscriptionRecoveryStates = new WeakMap<object, SubscriptionRecoveryState>();
  readonly #cleanupForSubscriptionRecovery = new WeakMap<object, CleanupAuthority>();
  readonly #trustedSubscriptionReservations = new WeakSet<object>();
  readonly #activeSubscriptionReservations = new WeakSet<object>();
  readonly #subscriptionReservationStates =
    new WeakMap<object, SubscriptionReservationState>();
  readonly #trustedSubscriptionQuotaRecovery = new WeakSet<object>();
  readonly #activeSubscriptionQuotaRecovery = new WeakSet<object>();
  readonly #subscriptionQuotaRecoveryStates =
    new WeakMap<object, SubscriptionQuotaRecoveryState>();

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
    const subscriptionRecovery = opaqueSubscriptionRecoveryCapability();
    const authority = cleanupAuthority(
      parsed.job.job_id,
      parsed.job.attempt_id,
      runtimeSlot,
      parsed.job.fence_generation,
      subscriptionRecovery,
    );
    const modelAccess = opaqueModelAccessCapability();
    const claim: ClaimedAttempt = Object.freeze({
      job: parsed.job,
      adapter_id: parsed.adapter_id,
      runtime_slot: runtimeSlot,
      job_version: parsed.job_version,
      cleanup_authority: authority,
      model_access: modelAccess,
    });
    this.#trustedJobs.add(claim.job);
    this.#claimForJob.set(claim.job, claim);
    this.#trustedClaims.add(claim);
    this.#activeClaims.add(claim);
    this.#claimSecrets.set(claim, parsed.claim_token);
    this.#activeClaimByAttempt.set(claim.job.attempt_id, claim);
    this.#trustedModelAccess.add(modelAccess);
    this.#activeModelAccess.add(modelAccess);
    this.#activeModelAccessByAttempt.set(claim.job.attempt_id, modelAccess);
    this.#modelAccessStates.set(modelAccess, Object.freeze({
      tenant_id: parsed.tenant_id,
      credential_owner_id: parsed.credential_owner_id,
      credential_generation: parsed.credential_generation,
      expected_account_hash: parsed.subscription_account_hash,
      job_id: parsed.job.job_id,
      attempt_id: parsed.job.attempt_id,
      fence_generation: parsed.job.fence_generation,
      runtime_slot_id: parsed.runtime_slot_id,
      adapter_id: parsed.adapter_id,
      deadline_at: parsed.job.deadline_at,
      source_snapshot_count: 0,
    }));
    this.trustRuntimeSlot(runtimeSlot);
    this.trustCleanupAuthority(authority, parsed.claim_token, parsed.adapter_id);
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
    if ((claim.adapter_id === "openclaw" && identity.runtime_kind !== "openclaw_cell") ||
        (claim.adapter_id === "direct_model" &&
          identity.runtime_kind !== "direct_model_subscription")) {
      throw new ContractValidationError("runtime identity kind does not match claimed adapter");
    }
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
    const modelState = this.#modelAccessStates.get(claim.model_access);
    if (modelState === undefined || !this.#activeModelAccess.has(claim.model_access)) {
      throw new ContractValidationError("active model access capability unavailable");
    }
    this.#modelAccessStates.set(claim.model_access, Object.freeze({
      ...modelState,
      subscription_socket_path: readback.runtime_identity.subscription_socket_path,
      runtime_identity_hash: readback.runtime_identity_hash,
    }));
    const recoveryState = this.#subscriptionRecoveryStates.get(
      claim.cleanup_authority.subscription_recovery,
    );
    if (recoveryState === undefined) {
      throw new ContractValidationError("subscription recovery private state unavailable");
    }
    this.#subscriptionRecoveryStates.set(
      claim.cleanup_authority.subscription_recovery,
      Object.freeze({
        ...recoveryState,
        subscription_socket_path: readback.runtime_identity.subscription_socket_path,
        runtime_kind: readback.runtime_identity.runtime_kind,
      }),
    );
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
    const modelState = this.#modelAccessStates.get(claim.model_access);
    if (modelState === undefined || !this.#activeModelAccess.has(claim.model_access)) {
      throw new ContractValidationError("active model access capability unavailable");
    }
    this.#modelAccessStates.set(claim.model_access, Object.freeze({
      ...modelState,
      source_snapshot_count: bound.source_snapshots.length,
    }));
    return bound;
  }

  async assertModelAccessCurrent(
    capability: ModelAccessCapability,
    expected?: ModelAccessExpectation,
  ): Promise<Readonly<ModelAccessContext>> {
    if (!this.#trustedModelAccess.has(capability)) {
      throw new ContractValidationError("store-issued model access capability required");
    }
    if (!this.#activeModelAccess.has(capability)) {
      throw new ContractValidationError("inactive model access capability");
    }
    const state = this.#modelAccessStates.get(capability);
    if (state === undefined) {
      this.deactivateModelAccess(capability);
      throw new ContractValidationError("model access private state unavailable");
    }
    if (expected !== undefined && !expectationMatches(state, expected)) {
      throw new ContractValidationError("model access expectation mismatch");
    }
    const claim = this.#activeClaimByAttempt.get(state.attempt_id);
    if (claim === undefined || claim.model_access !== capability) {
      this.deactivateModelAccess(capability);
      throw new ContractValidationError("inactive model access capability");
    }
    const claimToken = this.#claimSecrets.get(claim);
    if (claimToken === undefined) {
      this.deactivateModelAccess(capability);
      throw new ContractValidationError("model access claim secret unavailable");
    }
    try {
      return parseModelAccessReadback(await rpcOrThrow(
        this.client,
        "read_company_discovery_model_access",
        {
          p_attempt_id: state.attempt_id,
          p_fence_generation: state.fence_generation,
          p_claim_token: claimToken,
          p_credential_generation: state.credential_generation,
        },
      ), state);
    } catch (error) {
      this.deactivateModelAccess(capability);
      throw error;
    }
  }

  async assertSubscriptionRecoveryCurrent(
    capability: SubscriptionRecoveryCapability,
  ): Promise<Readonly<SubscriptionRecoveryContext>> {
    if (!this.#trustedSubscriptionRecovery.has(capability)) {
      throw new ContractValidationError("store-issued subscription recovery required");
    }
    if (!this.#activeSubscriptionRecovery.has(capability)) {
      throw new ContractValidationError("inactive subscription recovery capability");
    }
    const state = this.#subscriptionRecoveryStates.get(capability);
    const authority = this.#cleanupForSubscriptionRecovery.get(capability);
    if (state === undefined || authority === undefined ||
        this.#activeCleanupByAttempt.get(state.attempt_id) !== authority) {
      this.deactivateSubscriptionRecovery(capability);
      throw new ContractValidationError("inactive subscription recovery capability");
    }
    const token = this.#cleanupSecrets.get(authority);
    if (token === undefined) {
      this.deactivateSubscriptionRecovery(capability);
      throw new ContractValidationError("subscription recovery secret unavailable");
    }
    try {
      return parseSubscriptionRecoveryReadback(await rpcOrThrow(
        this.client,
        "read_company_discovery_subscription_recovery",
        {
          p_attempt_id: state.attempt_id,
          p_fence_generation: state.fence_generation,
          p_claim_token: token,
        },
      ), state);
    } catch (error) {
      this.deactivateSubscriptionRecovery(capability);
      throw error;
    }
  }

  async claimSubscriptionQuotaRecovery(
    ownerValue: SubscriptionCredentialOwnerBinding,
    workerId: string,
    leaseSeconds: number,
  ): Promise<Readonly<SubscriptionQuotaRecoveryClaimResult> | null> {
    const ownerRecord = plainRecord(ownerValue, "subscription quota recovery owner");
    exactKeys(ownerRecord, [
      "credential_owner_id", "credential_generation", "account_id_sha256",
    ], "subscription quota recovery owner");
    const owner = Object.freeze({
      credential_owner_id: uuid(
        ownerRecord.credential_owner_id,
        "subscription quota recovery owner id",
      ),
      credential_generation: positiveInteger(
        ownerRecord.credential_generation,
        "subscription quota recovery owner generation",
      ),
      account_id_sha256: hash(
        ownerRecord.account_id_sha256,
        "subscription quota recovery owner account hash",
      ),
    });
    assertWorkerIdAndLease(workerId, leaseSeconds, "subscription quota recovery claim");
    if (leaseSeconds < 15 || leaseSeconds > 120) {
      throw new ContractValidationError("subscription quota recovery claim: invalid lease");
    }
    const capability = opaqueSubscriptionQuotaRecoveryCapability();
    const parsed = parseSubscriptionQuotaRecoveryClaim(await rpcOrThrow(
      this.client,
      "claim_company_discovery_subscription_quota_recovery",
      {
        p_worker_id: workerId,
        p_credential_owner: owner.credential_owner_id,
        p_credential_generation: owner.credential_generation,
        p_expected_account_hash: owner.account_id_sha256,
        p_lease_seconds: leaseSeconds,
      },
    ), owner, capability);
    if (parsed === null) return null;
    if ("blocked" in parsed) return parsed.blocked;
    const state = Object.freeze({
      probe_id: parsed.claim.probe_id,
      recovery_generation: parsed.claim.recovery_generation,
      claim_token: parsed.claim_token,
      credential_owner_id: parsed.claim.credential_owner_id,
      credential_generation: parsed.claim.credential_generation,
      expected_account_hash: parsed.claim.expected_account_hash,
    });
    this.#trustedSubscriptionQuotaRecovery.add(capability);
    this.#activeSubscriptionQuotaRecovery.add(capability);
    this.#subscriptionQuotaRecoveryStates.set(capability, state);
    return parsed.claim;
  }

  async settleSubscriptionQuotaRecovery(
    capability: SubscriptionQuotaRecoveryCapability,
    settlementValue: SubscriptionQuotaRecoverySettlement,
  ): Promise<Readonly<SubscriptionQuotaRecoveryReadback>> {
    if (!this.#trustedSubscriptionQuotaRecovery.has(capability) ||
        !this.#activeSubscriptionQuotaRecovery.has(capability)) {
      throw new ContractValidationError(
        "active store-issued subscription quota recovery required",
      );
    }
    const state = this.#subscriptionQuotaRecoveryStates.get(capability);
    if (state === undefined) {
      this.#activeSubscriptionQuotaRecovery.delete(capability);
      throw new ContractValidationError("subscription quota recovery private state unavailable");
    }
    const settlement = plainRecord(
      settlementValue,
      "subscription quota recovery settlement",
    );
    exactKeys(
      settlement,
      ["outcome", "terminal_reason", "observation"],
      "subscription quota recovery settlement",
    );
    const reasons = new Set<SubscriptionQuotaRecoveryTerminalReason>([
      "probe_succeeded", "probe_grant_failed", "probe_provider_failed",
      "probe_usage_ambiguous", "probe_context_changed", "probe_lease_expired",
    ]);
    if ((settlement.outcome !== "available" && settlement.outcome !== "unknown") ||
        !reasons.has(settlement.terminal_reason as SubscriptionQuotaRecoveryTerminalReason)) {
      throw new ContractValidationError("subscription quota recovery settlement invalid");
    }
    const observation = parseSubscriptionQuotaRecoveryObservation(settlement.observation);
    if (settlement.outcome === "available" && (
      settlement.terminal_reason !== "probe_succeeded" ||
      !observation.usage_complete || !observation.terminal_complete ||
      observation.request_sha256 === null || observation.response_sha256 === null ||
      observation.input_tokens === null || observation.output_tokens === null ||
      observation.total_tokens !== observation.input_tokens + observation.output_tokens
    )) {
      throw new ContractValidationError("subscription quota recovery success unproved");
    }
    const readback = parseSubscriptionQuotaRecoveryReadback(await rpcOrThrow(
      this.client,
      "settle_company_discovery_subscription_quota_recovery",
      {
        p_probe_id: state.probe_id,
        p_recovery_generation: state.recovery_generation,
        p_claim_token: state.claim_token,
        p_outcome: settlement.outcome,
        p_terminal_reason: settlement.terminal_reason,
        p_observation: observation,
      },
    ), state);
    this.#activeSubscriptionQuotaRecovery.delete(capability);
    return readback;
  }

  async reserveSubscriptionRequest(
    capability: ModelAccessCapability,
    prospectiveValue: SubscriptionRequestProspective,
  ): Promise<Readonly<SubscriptionReservationReadback>> {
    // The object-identity check intentionally happens before parsing caller data
    // or touching PostgreSQL. A clone or cross-store capability gets no oracle.
    if (!this.#trustedModelAccess.has(capability) ||
        !this.#activeModelAccess.has(capability)) {
      throw new ContractValidationError("active store-issued model access capability required");
    }
    const prospectiveRecord = plainRecord(
      prospectiveValue,
      "subscription request prospective",
    );
    exactKeys(
      prospectiveRecord,
      ["input_bytes", "output_bytes", "lease_seconds"],
      "subscription request prospective",
    );
    const prospective = Object.freeze({
      input_bytes: positiveInteger(
        prospectiveRecord.input_bytes,
        "subscription prospective input bytes",
      ),
      output_bytes: positiveInteger(
        prospectiveRecord.output_bytes,
        "subscription prospective output bytes",
      ),
      lease_seconds: positiveInteger(
        prospectiveRecord.lease_seconds,
        "subscription prospective lease seconds",
      ),
    });
    if (prospective.input_bytes > 400_000 || prospective.output_bytes > 4_194_304 ||
        prospective.lease_seconds > 600) {
      throw new ContractValidationError("subscription request prospective exceeds release caps");
    }
    const context = await this.assertModelAccessCurrent(capability);
    const state = this.#modelAccessStates.get(capability);
    const claim = state === undefined
      ? undefined
      : this.#activeClaimByAttempt.get(state.attempt_id);
    if (state === undefined || claim === undefined || claim.model_access !== capability) {
      throw new ContractValidationError("active model access private state unavailable");
    }
    const claimToken = this.#claimSecrets.get(claim);
    if (claimToken === undefined) {
      throw new ContractValidationError("model access claim secret unavailable");
    }
    const parsed = parseSubscriptionReservationReadback(await rpcOrThrow(
      this.client,
      "reserve_company_discovery_subscription_request",
      {
        p_attempt_id: context.attempt_id,
        p_fence_generation: context.fence_generation,
        p_claim_token: claimToken,
        p_credential_generation: context.credential_generation,
        p_request_key: randomUUID(),
        p_input_bytes: prospective.input_bytes,
        p_output_bytes: prospective.output_bytes,
        p_lease_seconds: prospective.lease_seconds,
      },
    ), prospective, context.deadline_at);
    const reservation = opaqueSubscriptionReservation();
    this.#trustedSubscriptionReservations.add(reservation);
    this.#activeSubscriptionReservations.add(reservation);
    this.#subscriptionReservationStates.set(reservation, Object.freeze({
      reservation_id: parsed.reservation_id,
      reservation_token: parsed.reservation_token,
      claim_token: claimToken,
      attempt_id: context.attempt_id,
      fence_generation: context.fence_generation,
      prospective_input_bytes: prospective.input_bytes,
      prospective_output_bytes: prospective.output_bytes,
    }));
    return Object.freeze({ reservation, ...parsed.safe });
  }

  async settleSubscriptionRequest(
    reservation: SubscriptionRequestReservationCapability,
    settlementValue: SubscriptionRequestSettlement,
  ): Promise<Readonly<SubscriptionSettlementReadback>> {
    // Settlement stays usable after attempt cancellation so an in-flight
    // request can release its durable reservation. Only this store's live
    // reservation object can reach the RPC.
    if (!this.#trustedSubscriptionReservations.has(reservation) ||
        !this.#activeSubscriptionReservations.has(reservation)) {
      throw new ContractValidationError(
        "active store-issued subscription reservation required",
      );
    }
    const state = this.#subscriptionReservationStates.get(reservation);
    if (state === undefined) {
      throw new ContractValidationError("subscription reservation private state unavailable");
    }
    const row = plainRecord(settlementValue, "subscription request settlement");
    exactKeys(row, [
      "input_bytes", "output_bytes", "observed_input_tokens",
      "observed_output_tokens", "usage_complete", "quota_state",
      "retry_after_seconds",
    ], "subscription request settlement");
    const inputBytes = nonnegativeInteger(
      row.input_bytes,
      "subscription settlement input bytes",
    );
    const outputBytes = nonnegativeInteger(
      row.output_bytes,
      "subscription settlement output bytes",
    );
    const observedInputTokens = row.observed_input_tokens === null
      ? null
      : nonnegativeInteger(
        row.observed_input_tokens,
        "subscription settlement observed input tokens",
      );
    const observedOutputTokens = row.observed_output_tokens === null
      ? null
      : nonnegativeInteger(
        row.observed_output_tokens,
        "subscription settlement observed output tokens",
      );
    if (inputBytes > state.prospective_input_bytes ||
        outputBytes > state.prospective_output_bytes ||
        typeof row.usage_complete !== "boolean" ||
        (row.usage_complete &&
          (observedInputTokens === null || observedOutputTokens === null)) ||
        (row.quota_state !== "available" && row.quota_state !== "cooldown" &&
          row.quota_state !== "unknown") ||
        (row.quota_state === "cooldown" &&
          (!Number.isSafeInteger(row.retry_after_seconds) ||
            (row.retry_after_seconds as number) < 1 ||
            (row.retry_after_seconds as number) > 3_600)) ||
        (row.quota_state !== "cooldown" && row.retry_after_seconds !== null)) {
      throw new ContractValidationError("subscription request settlement invalid");
    }
    const parsed = parseSubscriptionSettlementReadback(await rpcOrThrow(
      this.client,
      "settle_company_discovery_subscription_request",
      {
        p_attempt_id: state.attempt_id,
        p_fence_generation: state.fence_generation,
        p_claim_token: state.claim_token,
        p_reservation_id: state.reservation_id,
        p_reservation_token: state.reservation_token,
        p_input_bytes: inputBytes,
        p_output_bytes: outputBytes,
        p_observed_input_tokens: observedInputTokens,
        p_observed_output_tokens: observedOutputTokens,
        p_usage_complete: row.usage_complete,
        p_quota_state: row.quota_state,
        p_retry_after_seconds: row.retry_after_seconds,
      },
    ));
    this.#activeSubscriptionReservations.delete(reservation);
    return parsed;
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
    if (result.schema_version === "company_discovery.result.v2" &&
        claim.adapter_id !== "direct_model") {
      throw new ContractValidationError("Stage 0B result requires DirectModel authority");
    }
    if (!this.#runtimeBindings.has(claim)) {
      throw new ContractValidationError("runtime identity must be bound before result commit");
    }
    const claimToken = this.claimToken(claim);
    const commitRpc = result.schema_version === "company_discovery.result.v2"
      ? "commit_company_discovery_result_v2"
      : "commit_company_discovery_result";
    const data = await rpcOrThrow(this.client, commitRpc, {
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
    const subscriptionRecovery = opaqueSubscriptionRecoveryCapability();
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
    ), claim, outcome, binding, claimToken, subscriptionRecovery);
    this.deactivateClaim(claim);
    this.trustCleanupAuthority(
      authority.authority,
      authority.claim_token,
      claim.adapter_id,
      binding.runtime_identity,
    );
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
    const subscriptionRecovery = opaqueSubscriptionRecoveryCapability();
    const authority = cleanupAuthority(
      parsed.job_id,
      parsed.attempt_id,
      runtimeSlot,
      parsed.fence_generation,
      subscriptionRecovery,
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
    this.trustCleanupAuthority(
      authority,
      parsed.claim_token,
      parsed.adapter_id,
      parsed.runtime_identity,
    );
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
    const cleanupAdapter = this.#cleanupAdapters.get(authority);
    if (cleanupAdapter === undefined) {
      throw new ContractValidationError("cleanup authority adapter unavailable");
    }
    const data = await rpcOrThrow(this.client, "record_company_discovery_cleanup", {
      p_attempt_id: authority.attempt_id,
      p_fence_generation: authority.fence_generation,
      p_claim_token: claimToken,
      p_proof: parseCleanupProof(proof, cleanupAdapter),
    });
    const readback = cleanupReadback(data, authority.attempt_id);
    this.#activeCleanupByAttempt.delete(authority.attempt_id);
    this.deactivateSubscriptionRecovery(authority.subscription_recovery);
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

  private trustCleanupAuthority(
    authority: CleanupAuthority,
    claimToken: string,
    adapterId: DiscoveryAdapterId,
    runtimeIdentity?: RuntimeIdentityBinding,
  ): void {
    const previous = this.#activeCleanupByAttempt.get(authority.attempt_id);
    if (previous !== undefined) {
      this.#activeSubscriptionRecovery.delete(previous.subscription_recovery);
    }
    this.#trustedCleanupAuthorities.add(authority);
    this.#activeCleanupByAttempt.set(authority.attempt_id, authority);
    this.#cleanupSecrets.set(authority, claimToken);
    this.#cleanupAdapters.set(authority, adapterId);
    this.#trustedSubscriptionRecovery.add(authority.subscription_recovery);
    this.#activeSubscriptionRecovery.add(authority.subscription_recovery);
    this.#cleanupForSubscriptionRecovery.set(
      authority.subscription_recovery,
      authority,
    );
    this.#subscriptionRecoveryStates.set(
      authority.subscription_recovery,
      Object.freeze({
        job_id: authority.job_id,
        attempt_id: authority.attempt_id,
        fence_generation: authority.fence_generation,
        subscription_socket_path: runtimeIdentity?.subscription_socket_path,
        runtime_kind: runtimeIdentity?.runtime_kind,
      }),
    );
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
    this.deactivateModelAccess(claim.model_access);
    if (this.#activeClaimByAttempt.get(claim.job.attempt_id) === claim) {
      this.#activeClaimByAttempt.delete(claim.job.attempt_id);
    }
  }

  private deactivateModelAccess(capability: ModelAccessCapability): void {
    this.#activeModelAccess.delete(capability);
    const state = this.#modelAccessStates.get(capability);
    if (state !== undefined &&
        this.#activeModelAccessByAttempt.get(state.attempt_id) === capability) {
      this.#activeModelAccessByAttempt.delete(state.attempt_id);
    }
  }

  private deactivateSubscriptionRecovery(
    capability: SubscriptionRecoveryCapability,
  ): void {
    this.#activeSubscriptionRecovery.delete(capability);
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
    const modelAccess = this.#activeModelAccessByAttempt.get(attemptId);
    if (modelAccess !== undefined) this.deactivateModelAccess(modelAccess);
    const cleanup = this.#activeCleanupByAttempt.get(attemptId);
    if (cleanup !== undefined) {
      this.#activeCleanupByAttempt.delete(attemptId);
      this.deactivateSubscriptionRecovery(cleanup.subscription_recovery);
    }
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
