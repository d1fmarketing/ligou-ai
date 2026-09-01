import {
  ContractValidationError,
  deepFreeze,
  parseWorkerJob,
  type DiscoveryAdapterId,
  type WorkerJob,
} from "../src/contracts";
import {
  canonicalJson,
  loadBenchmarkCase,
  scoreBenchmarkResult,
  sha256,
  type BenchmarkCaseArtifact,
  type BenchmarkQualityScore,
} from "./score";

export interface BenchmarkAdapterIdentity {
  readonly adapter_id: DiscoveryAdapterId;
  readonly adapter_version: string;
  readonly runtime_version: string;
  readonly model_access: "hermes_openai_codex_subscription";
  readonly subscription_gateway_id: string;
  readonly model_snapshot: string;
  readonly prompt_version: string;
  readonly tool_schema_version: string;
}

export type MeasurementSource =
  | "ligou_host_sampler"
  | "ligou_discovery_fetch_gateway"
  | "ligou_subscription_gateway"
  | "ligou_supervisor"
  | "ligou_release_allocation";

export interface UnknownMeasurement {
  readonly status: "unknown";
  readonly reason: string;
}

export interface ObservedMeasurement<T> {
  readonly status: "observed";
  readonly value: T;
  readonly source: MeasurementSource;
  readonly observed_at: string;
}

export type Measurement<T> = UnknownMeasurement | ObservedMeasurement<T>;

export interface BenchmarkHostMeasurements {
  readonly cpu_milliseconds: Measurement<number>;
  readonly peak_rss_bytes: Measurement<number>;
  readonly peak_storage_bytes: Measurement<number>;
}

export interface BenchmarkCrawlMeasurements {
  readonly completed: Measurement<boolean>;
  readonly pages_served: Measurement<number>;
  readonly blocked_request_count: Measurement<number>;
  readonly duplicate_request_count: Measurement<number>;
}

export interface BenchmarkSubscriptionMeasurements {
  readonly request_count: Measurement<number>;
  readonly input_tokens: Measurement<number>;
  readonly output_tokens: Measurement<number>;
  readonly cached_input_tokens: Measurement<number>;
  readonly quota_units_consumed: Measurement<number>;
  readonly quota_units_remaining: Measurement<number>;
  readonly marginal_api_charge_usd_micros: Measurement<number>;
  readonly shared_fixed_cost_allocation_usd_micros: Measurement<number>;
}

export interface BenchmarkSaturationMeasurements {
  readonly requested_parallelism: number;
  readonly observed_peak_parallelism: Measurement<number>;
  readonly queue_delay_milliseconds: Measurement<number>;
  readonly capacity_rejections: Measurement<number>;
}

export type RawCleanupMeasurement =
  | {
      readonly state: "not_required";
      readonly reason: string;
    }
  | {
      readonly state: "unknown";
      readonly reason: string;
    }
  | {
      readonly state: "observed";
      readonly source: "ligou_supervisor";
      readonly observed_at: string;
      readonly raw_receipt_json: string;
    };

export type BenchmarkCleanupMeasurement =
  | Extract<RawCleanupMeasurement, { readonly state: "not_required" | "unknown" }>
  | {
      readonly state: "observed";
      readonly source: "ligou_supervisor";
      readonly observed_at: string;
      readonly raw_receipt_json: string;
      readonly receipt_sha256: string;
      readonly proved: boolean;
    };

export interface RawBenchmarkMeasurements {
  readonly host: BenchmarkHostMeasurements;
  readonly crawl: BenchmarkCrawlMeasurements;
  readonly subscription: BenchmarkSubscriptionMeasurements;
  readonly saturation: BenchmarkSaturationMeasurements;
  readonly cleanup: RawCleanupMeasurement;
}

export interface BenchmarkMeasurements
  extends Omit<RawBenchmarkMeasurements, "cleanup"> {
  readonly cleanup: BenchmarkCleanupMeasurement;
}

export interface BenchmarkExecutionRequest {
  readonly schema_version: "company_discovery.benchmark_execution_request.v1";
  readonly run_id: string;
  readonly parallelism: number;
  readonly case_id: string;
  readonly corpus_sha256: string;
  readonly adapter_identity: BenchmarkAdapterIdentity;
  readonly source_snapshots_sha256: string;
  readonly job_input_json: string;
  readonly job_input_sha256: string;
  readonly job: WorkerJob;
}

export interface BenchmarkExecutionReceipt {
  readonly schema_version: "company_discovery.benchmark_execution_receipt.v1";
  readonly adapter_id: DiscoveryAdapterId;
  readonly job_input_sha256: string;
  readonly source_snapshots_sha256: string;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "deadline_exceeded";
  readonly failure_code: string | null;
  readonly raw_result_json: string | null;
  readonly measurements: RawBenchmarkMeasurements;
}

export interface BenchmarkSchedule {
  readonly run_id: string;
  readonly parallelism: number;
}

export interface BenchmarkJobAllocation
  extends Omit<WorkerJob, "job_type" | "normalized_origin" | "source_snapshots"> {}

export interface BenchmarkRunOptions {
  readonly schema_version: "company_discovery.benchmark_run.v1";
  readonly run_started_at: string;
  readonly corpus: readonly BenchmarkCaseArtifact[];
  readonly adapter_identities: readonly BenchmarkAdapterIdentity[];
  readonly schedules: readonly BenchmarkSchedule[];
  readonly allocate_job: (
    input: {
      readonly case_id: string;
      readonly adapter_id: DiscoveryAdapterId;
      readonly run_id: string;
      readonly parallelism: number;
    },
  ) => BenchmarkJobAllocation | Promise<BenchmarkJobAllocation>;
  /**
   * This is the Ligou-owned execution boundary. Adapter output cannot supply
   * benchmark telemetry; the supervisor, host sampler, Fetch Gateway, and
   * subscription gateway assemble the receipt outside the worker.
   */
  readonly execute_attempt: (
    request: BenchmarkExecutionRequest,
  ) => Promise<BenchmarkExecutionReceipt>;
  readonly monotonic_now_milliseconds: () => number;
}

export interface BenchmarkAttemptReport {
  readonly run_id: string;
  readonly parallelism: number;
  readonly case_id: string;
  readonly corpus_sha256: string;
  readonly adapter_identity: BenchmarkAdapterIdentity;
  readonly source_snapshots_sha256: string;
  readonly job_input_json: string;
  readonly job_input_sha256: string;
  readonly execution_outcome: BenchmarkExecutionReceipt["outcome"];
  readonly failure_code: string | null;
  readonly raw_result_json: string | null;
  readonly raw_result_sha256: string | null;
  readonly result_validation: "valid" | "invalid" | "not_available";
  readonly validation_error: string | null;
  readonly quality: BenchmarkQualityScore | null;
  readonly latency_milliseconds: number;
  readonly measurements: BenchmarkMeasurements;
}

export interface BenchmarkReport {
  readonly schema_version: "company_discovery.benchmark_report.v1";
  readonly run_started_at: string;
  readonly comparison_invariant: {
    readonly model_access: "hermes_openai_codex_subscription";
    readonly subscription_gateway_id: string;
    readonly model_snapshot: string;
  };
  readonly corpus_manifest: readonly {
    readonly case_id: string;
    readonly source_name: string;
    readonly corpus_sha256: string;
    readonly source_snapshots_sha256: string;
  }[];
  readonly schedules: readonly BenchmarkSchedule[];
  readonly attempts: readonly BenchmarkAttemptReport[];
}

const IDENTITY_KEYS = [
  "adapter_id",
  "adapter_version",
  "runtime_version",
  "model_access",
  "subscription_gateway_id",
  "model_snapshot",
  "prompt_version",
  "tool_schema_version",
] as const;
const RECEIPT_KEYS = [
  "schema_version",
  "adapter_id",
  "job_input_sha256",
  "source_snapshots_sha256",
  "outcome",
  "failure_code",
  "raw_result_json",
  "measurements",
] as const;
const MEASUREMENT_KEYS = ["host", "crawl", "subscription", "saturation", "cleanup"] as const;
const HOST_KEYS = ["cpu_milliseconds", "peak_rss_bytes", "peak_storage_bytes"] as const;
const CRAWL_KEYS = ["completed", "pages_served", "blocked_request_count", "duplicate_request_count"] as const;
const SUBSCRIPTION_KEYS = [
  "request_count",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "quota_units_consumed",
  "quota_units_remaining",
  "marginal_api_charge_usd_micros",
  "shared_fixed_cost_allocation_usd_micros",
] as const;
const SATURATION_KEYS = [
  "requested_parallelism",
  "observed_peak_parallelism",
  "queue_delay_milliseconds",
  "capacity_rejections",
] as const;
const CLEANUP_KEYS = [
  "gateway_exited",
  "cell_removed",
  "bridge_removed",
  "config_removed",
  "state_removed",
  "workspace_removed",
  "output_removed",
  "network_removed",
  "credential_revoked",
  "listener_closed",
  "no_identity_process",
  "late_result_rejected",
] as const;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:@/+_-]{0,255}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function failure(path: string, message: string): never {
  throw new ContractValidationError(`${path}: ${message}`);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failure(path, "expected plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failure(path, "expected plain object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    failure(path, `expected exact keys ${keys.join(",")}`);
  }
}

function boundedString(value: unknown, path: string, maximum = 2_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    failure(path, `expected non-empty string up to ${maximum} characters`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 256);
  if (!IDENTIFIER_PATTERN.test(parsed)) failure(path, "invalid identifier");
  return parsed;
}

function timestamp(value: unknown, path: string): string {
  const parsed = boundedString(value, path, 32);
  if (!UTC_TIMESTAMP_PATTERN.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    failure(path, "strict UTC timestamp required");
  }
  return parsed;
}

function safeInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    failure(path, `expected integer between 0 and ${maximum}`);
  }
  return value as number;
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) failure(path, "invalid SHA-256");
  return value;
}

function parseIdentity(value: unknown, path: string): BenchmarkAdapterIdentity {
  const candidate = plainRecord(value, path);
  exactKeys(candidate, IDENTITY_KEYS, path);
  if (candidate.adapter_id !== "direct_model" && candidate.adapter_id !== "openclaw") {
    failure(`${path}.adapter_id`, "invalid adapter");
  }
  if (candidate.model_access !== "hermes_openai_codex_subscription") {
    failure(`${path}.model_access`, "Hermes openai-codex subscription access required");
  }
  return deepFreeze({
    adapter_id: candidate.adapter_id,
    adapter_version: identifier(candidate.adapter_version, `${path}.adapter_version`),
    runtime_version: identifier(candidate.runtime_version, `${path}.runtime_version`),
    model_access: "hermes_openai_codex_subscription",
    subscription_gateway_id: identifier(
      candidate.subscription_gateway_id,
      `${path}.subscription_gateway_id`,
    ),
    model_snapshot: identifier(candidate.model_snapshot, `${path}.model_snapshot`),
    prompt_version: identifier(candidate.prompt_version, `${path}.prompt_version`),
    tool_schema_version: identifier(
      candidate.tool_schema_version,
      `${path}.tool_schema_version`,
    ),
  });
}

function parseIdentities(values: readonly BenchmarkAdapterIdentity[]): readonly BenchmarkAdapterIdentity[] {
  if (!Array.isArray(values) || values.length !== 2) {
    failure("adapter_identities", "exactly direct_model and openclaw required");
  }
  const parsed = values.map((identity, index) => parseIdentity(identity, `adapter_identities[${index}]`));
  if (new Set(parsed.map((identity) => identity.adapter_id)).size !== 2) {
    failure("adapter_identities", "exactly direct_model and openclaw required");
  }
  if (new Set(parsed.map((identity) =>
    `${identity.subscription_gateway_id}:${identity.model_snapshot}`
  )).size !== 1) {
    failure("adapter_identities", "both adapters must use the same subscription gateway and model snapshot");
  }
  return deepFreeze(parsed);
}

function parseSchedules(values: readonly BenchmarkSchedule[]): readonly BenchmarkSchedule[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 8) {
    failure("schedules", "expected 1..8 schedules");
  }
  const seen = new Set<string>();
  const parsed = values.map((value, index) => {
    const candidate = plainRecord(value, `schedules[${index}]`);
    exactKeys(candidate, ["run_id", "parallelism"], `schedules[${index}]`);
    const runId = identifier(candidate.run_id, `schedules[${index}].run_id`);
    if (seen.has(runId)) failure(`schedules[${index}].run_id`, "duplicate run id");
    seen.add(runId);
    return deepFreeze({
      run_id: runId,
      parallelism: safeInteger(candidate.parallelism, `schedules[${index}].parallelism`, 8),
    });
  });
  if (parsed.some((schedule) => schedule.parallelism < 1)) {
    failure("schedules.parallelism", "parallelism must be at least one");
  }
  return deepFreeze(parsed);
}

function parseMeasurement<T extends number | boolean>(
  value: unknown,
  path: string,
  expectedSource: MeasurementSource,
  valueKind: "number" | "boolean",
): Measurement<T> {
  const candidate = plainRecord(value, path);
  if (candidate.status === "unknown") {
    exactKeys(candidate, ["status", "reason"], path);
    return deepFreeze({ status: "unknown", reason: boundedString(candidate.reason, `${path}.reason`) });
  }
  if (candidate.status !== "observed") failure(`${path}.status`, "observed or unknown required");
  exactKeys(candidate, ["status", "value", "source", "observed_at"], path);
  if (candidate.source !== expectedSource) failure(`${path}.source`, `${expectedSource} required`);
  let parsedValue: number | boolean;
  if (valueKind === "number") {
    parsedValue = safeInteger(candidate.value, `${path}.value`);
  } else if (typeof candidate.value === "boolean") {
    parsedValue = candidate.value;
  } else {
    failure(`${path}.value`, "boolean required");
  }
  return deepFreeze({
    status: "observed",
    value: parsedValue as T,
    source: expectedSource,
    observed_at: timestamp(candidate.observed_at, `${path}.observed_at`),
  });
}

function parseCleanup(
  value: unknown,
  adapterId: DiscoveryAdapterId,
): BenchmarkCleanupMeasurement {
  const candidate = plainRecord(value, "measurements.cleanup");
  if (candidate.state === "not_required") {
    exactKeys(candidate, ["state", "reason"], "measurements.cleanup");
    if (adapterId !== "direct_model") {
      failure("measurements.cleanup", "OpenClaw cleanup cannot be not_required");
    }
    return deepFreeze({
      state: "not_required",
      reason: boundedString(candidate.reason, "measurements.cleanup.reason"),
    });
  }
  if (candidate.state === "unknown") {
    exactKeys(candidate, ["state", "reason"], "measurements.cleanup");
    return deepFreeze({
      state: "unknown",
      reason: boundedString(candidate.reason, "measurements.cleanup.reason"),
    });
  }
  if (candidate.state !== "observed") {
    failure("measurements.cleanup.state", "observed, unknown, or not_required required");
  }
  exactKeys(
    candidate,
    ["state", "source", "observed_at", "raw_receipt_json"],
    "measurements.cleanup",
  );
  if (candidate.source !== "ligou_supervisor") {
    failure("measurements.cleanup.source", "ligou_supervisor required");
  }
  const rawReceipt = boundedString(
    candidate.raw_receipt_json,
    "measurements.cleanup.raw_receipt_json",
    65_536,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawReceipt);
  } catch {
    failure("measurements.cleanup.raw_receipt_json", "invalid JSON");
  }
  const proof = plainRecord(decoded, "measurements.cleanup.receipt");
  exactKeys(proof, CLEANUP_KEYS, "measurements.cleanup.receipt");
  for (const key of CLEANUP_KEYS) {
    if (typeof proof[key] !== "boolean") {
      failure(`measurements.cleanup.receipt.${key}`, "boolean required");
    }
  }
  return deepFreeze({
    state: "observed",
    source: "ligou_supervisor",
    observed_at: timestamp(candidate.observed_at, "measurements.cleanup.observed_at"),
    raw_receipt_json: rawReceipt,
    receipt_sha256: sha256(rawReceipt),
    proved: CLEANUP_KEYS.every((key) => proof[key] === true),
  });
}

function parseMeasurements(
  value: unknown,
  adapterId: DiscoveryAdapterId,
  parallelism: number,
): BenchmarkMeasurements {
  const candidate = plainRecord(value, "measurements");
  exactKeys(candidate, MEASUREMENT_KEYS, "measurements");
  const host = plainRecord(candidate.host, "measurements.host");
  exactKeys(host, HOST_KEYS, "measurements.host");
  const crawl = plainRecord(candidate.crawl, "measurements.crawl");
  exactKeys(crawl, CRAWL_KEYS, "measurements.crawl");
  const subscription = plainRecord(candidate.subscription, "measurements.subscription");
  exactKeys(subscription, SUBSCRIPTION_KEYS, "measurements.subscription");
  const saturation = plainRecord(candidate.saturation, "measurements.saturation");
  exactKeys(saturation, SATURATION_KEYS, "measurements.saturation");
  const requestedParallelism = safeInteger(
    saturation.requested_parallelism,
    "measurements.saturation.requested_parallelism",
    8,
  );
  if (requestedParallelism !== parallelism) {
    failure("measurements.saturation.requested_parallelism", "does not match benchmark schedule");
  }

  const marginalCharge = parseMeasurement<number>(
    subscription.marginal_api_charge_usd_micros,
    "measurements.subscription.marginal_api_charge_usd_micros",
    "ligou_subscription_gateway",
    "number",
  );
  if (marginalCharge.status === "observed" && marginalCharge.value !== 0) {
    failure(
      "measurements.subscription.marginal_api_charge_usd_micros",
      "marginal API charge must be zero for the subscription gateway",
    );
  }

  const parsed: BenchmarkMeasurements = {
    host: {
      cpu_milliseconds: parseMeasurement<number>(
        host.cpu_milliseconds,
        "measurements.host.cpu_milliseconds",
        "ligou_host_sampler",
        "number",
      ),
      peak_rss_bytes: parseMeasurement<number>(
        host.peak_rss_bytes,
        "measurements.host.peak_rss_bytes",
        "ligou_host_sampler",
        "number",
      ),
      peak_storage_bytes: parseMeasurement<number>(
        host.peak_storage_bytes,
        "measurements.host.peak_storage_bytes",
        "ligou_host_sampler",
        "number",
      ),
    },
    crawl: {
      completed: parseMeasurement<boolean>(
        crawl.completed,
        "measurements.crawl.completed",
        "ligou_discovery_fetch_gateway",
        "boolean",
      ),
      pages_served: parseMeasurement<number>(
        crawl.pages_served,
        "measurements.crawl.pages_served",
        "ligou_discovery_fetch_gateway",
        "number",
      ),
      blocked_request_count: parseMeasurement<number>(
        crawl.blocked_request_count,
        "measurements.crawl.blocked_request_count",
        "ligou_discovery_fetch_gateway",
        "number",
      ),
      duplicate_request_count: parseMeasurement<number>(
        crawl.duplicate_request_count,
        "measurements.crawl.duplicate_request_count",
        "ligou_discovery_fetch_gateway",
        "number",
      ),
    },
    subscription: {
      request_count: parseMeasurement<number>(
        subscription.request_count,
        "measurements.subscription.request_count",
        "ligou_subscription_gateway",
        "number",
      ),
      input_tokens: parseMeasurement<number>(
        subscription.input_tokens,
        "measurements.subscription.input_tokens",
        "ligou_subscription_gateway",
        "number",
      ),
      output_tokens: parseMeasurement<number>(
        subscription.output_tokens,
        "measurements.subscription.output_tokens",
        "ligou_subscription_gateway",
        "number",
      ),
      cached_input_tokens: parseMeasurement<number>(
        subscription.cached_input_tokens,
        "measurements.subscription.cached_input_tokens",
        "ligou_subscription_gateway",
        "number",
      ),
      quota_units_consumed: parseMeasurement<number>(
        subscription.quota_units_consumed,
        "measurements.subscription.quota_units_consumed",
        "ligou_subscription_gateway",
        "number",
      ),
      quota_units_remaining: parseMeasurement<number>(
        subscription.quota_units_remaining,
        "measurements.subscription.quota_units_remaining",
        "ligou_subscription_gateway",
        "number",
      ),
      marginal_api_charge_usd_micros: marginalCharge,
      shared_fixed_cost_allocation_usd_micros: parseMeasurement<number>(
        subscription.shared_fixed_cost_allocation_usd_micros,
        "measurements.subscription.shared_fixed_cost_allocation_usd_micros",
        "ligou_release_allocation",
        "number",
      ),
    },
    saturation: {
      requested_parallelism: requestedParallelism,
      observed_peak_parallelism: parseMeasurement<number>(
        saturation.observed_peak_parallelism,
        "measurements.saturation.observed_peak_parallelism",
        "ligou_supervisor",
        "number",
      ),
      queue_delay_milliseconds: parseMeasurement<number>(
        saturation.queue_delay_milliseconds,
        "measurements.saturation.queue_delay_milliseconds",
        "ligou_supervisor",
        "number",
      ),
      capacity_rejections: parseMeasurement<number>(
        saturation.capacity_rejections,
        "measurements.saturation.capacity_rejections",
        "ligou_supervisor",
        "number",
      ),
    },
    cleanup: parseCleanup(candidate.cleanup, adapterId),
  };
  if (parsed.saturation.observed_peak_parallelism.status === "observed" &&
      parsed.saturation.observed_peak_parallelism.value > parallelism) {
    failure("measurements.saturation.observed_peak_parallelism", "exceeds bounded schedule");
  }
  return deepFreeze(parsed);
}

function parseReceipt(
  value: unknown,
  request: BenchmarkExecutionRequest,
): {
  readonly receipt: BenchmarkExecutionReceipt;
  readonly measurements: BenchmarkMeasurements;
} {
  const candidate = plainRecord(value, "execution_receipt");
  exactKeys(candidate, RECEIPT_KEYS, "execution_receipt");
  if (candidate.schema_version !== "company_discovery.benchmark_execution_receipt.v1") {
    failure("execution_receipt.schema_version", "invalid receipt schema");
  }
  if (candidate.adapter_id !== request.adapter_identity.adapter_id) {
    failure("execution_receipt.adapter_id", "adapter identity mismatch");
  }
  if (candidate.job_input_sha256 !== request.job_input_sha256 ||
      candidate.source_snapshots_sha256 !== request.source_snapshots_sha256) {
    failure("execution_receipt", "input hash mismatch");
  }
  const outcomes = new Set(["succeeded", "failed", "cancelled", "deadline_exceeded"]);
  if (!outcomes.has(candidate.outcome as string)) {
    failure("execution_receipt.outcome", "invalid outcome");
  }
  const outcome = candidate.outcome as BenchmarkExecutionReceipt["outcome"];
  let failureCode: string | null;
  let rawResultJson: string | null;
  if (outcome === "succeeded") {
    if (candidate.failure_code !== null) {
      failure("execution_receipt.failure_code", "successful receipt must use null");
    }
    failureCode = null;
    rawResultJson = boundedString(candidate.raw_result_json, "execution_receipt.raw_result_json", 10_485_760);
  } else {
    failureCode = identifier(candidate.failure_code, "execution_receipt.failure_code");
    if (candidate.raw_result_json !== null) {
      failure("execution_receipt.raw_result_json", "failed receipt must use null");
    }
    rawResultJson = null;
  }
  const measurements = parseMeasurements(
    candidate.measurements,
    request.adapter_identity.adapter_id,
    request.parallelism,
  );
  return deepFreeze({
    receipt: {
      schema_version: "company_discovery.benchmark_execution_receipt.v1",
      adapter_id: request.adapter_identity.adapter_id,
      job_input_sha256: hash(candidate.job_input_sha256, "execution_receipt.job_input_sha256"),
      source_snapshots_sha256: hash(
        candidate.source_snapshots_sha256,
        "execution_receipt.source_snapshots_sha256",
      ),
      outcome,
      failure_code: failureCode,
      raw_result_json: rawResultJson,
      measurements: candidate.measurements as unknown as RawBenchmarkMeasurements,
    },
    measurements,
  });
}

function validatedCorpus(values: readonly BenchmarkCaseArtifact[]): readonly BenchmarkCaseArtifact[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    failure("corpus", "expected 1..100 artifacts");
  }
  const parsed = values.map((artifact, index) => {
    const reloaded = loadBenchmarkCase(
      artifact.raw_corpus_json,
      artifact.source_name,
    );
    if (reloaded.corpus_sha256 !== artifact.corpus_sha256 ||
        canonicalJson(reloaded.case) !== canonicalJson(artifact.case)) {
      failure(`corpus[${index}]`, "artifact does not match raw corpus bytes");
    }
    return reloaded;
  });
  if (new Set(parsed.map((artifact) => artifact.case.case_id)).size !== parsed.length) {
    failure("corpus", "duplicate case id");
  }
  return deepFreeze(parsed);
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function latency(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    failure("monotonic_clock", "finite nondecreasing milliseconds required");
  }
  return safeInteger(Math.round(end - start), "latency_milliseconds");
}

function validationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

async function runAttempt(
  options: BenchmarkRunOptions,
  artifact: BenchmarkCaseArtifact,
  identity: BenchmarkAdapterIdentity,
  schedule: BenchmarkSchedule,
): Promise<BenchmarkAttemptReport> {
  const allocation = await options.allocate_job({
    case_id: artifact.case.case_id,
    adapter_id: identity.adapter_id,
    run_id: schedule.run_id,
    parallelism: schedule.parallelism,
  });
  const job = parseWorkerJob({
    ...allocation,
    job_type: "company_discovery.v1",
    normalized_origin: artifact.case.normalized_origin,
    source_snapshots: artifact.case.source_snapshots,
  });
  const sourceSnapshotsJson = canonicalJson({
    schema_version: "company_discovery.evidence.v1",
    source_snapshots: artifact.case.source_snapshots,
  });
  const sourceSnapshotsSha256 = sha256(sourceSnapshotsJson);
  const jobInputJson = canonicalJson(job);
  const jobInputSha256 = sha256(jobInputJson);
  const request: BenchmarkExecutionRequest = deepFreeze({
    schema_version: "company_discovery.benchmark_execution_request.v1",
    run_id: schedule.run_id,
    parallelism: schedule.parallelism,
    case_id: artifact.case.case_id,
    corpus_sha256: artifact.corpus_sha256,
    adapter_identity: identity,
    source_snapshots_sha256: sourceSnapshotsSha256,
    job_input_json: jobInputJson,
    job_input_sha256: jobInputSha256,
    job,
  });
  const started = options.monotonic_now_milliseconds();
  const parsedReceipt = parseReceipt(await options.execute_attempt(request), request);
  const ended = options.monotonic_now_milliseconds();
  const rawResultJson = parsedReceipt.receipt.raw_result_json;
  let resultValidation: BenchmarkAttemptReport["result_validation"] = "not_available";
  let resultError: string | null = null;
  let quality: BenchmarkQualityScore | null = null;
  let rawResultSha256: string | null = null;
  if (rawResultJson !== null) {
    rawResultSha256 = sha256(rawResultJson);
    try {
      quality = scoreBenchmarkResult(artifact.case, JSON.parse(rawResultJson));
      resultValidation = "valid";
    } catch (error) {
      resultValidation = "invalid";
      resultError = validationError(error);
    }
  }
  return deepFreeze({
    run_id: schedule.run_id,
    parallelism: schedule.parallelism,
    case_id: artifact.case.case_id,
    corpus_sha256: artifact.corpus_sha256,
    adapter_identity: identity,
    source_snapshots_sha256: sourceSnapshotsSha256,
    job_input_json: jobInputJson,
    job_input_sha256: jobInputSha256,
    execution_outcome: parsedReceipt.receipt.outcome,
    failure_code: parsedReceipt.receipt.failure_code,
    raw_result_json: rawResultJson,
    raw_result_sha256: rawResultSha256,
    result_validation: resultValidation,
    validation_error: resultError,
    quality,
    latency_milliseconds: latency(started, ended),
    measurements: parsedReceipt.measurements,
  });
}

export async function runBenchmark(options: BenchmarkRunOptions): Promise<BenchmarkReport> {
  if (options.schema_version !== "company_discovery.benchmark_run.v1") {
    failure("schema_version", "company_discovery.benchmark_run.v1 required");
  }
  const runStartedAt = timestamp(options.run_started_at, "run_started_at");
  const corpus = validatedCorpus(options.corpus);
  const identities = parseIdentities(options.adapter_identities);
  const schedules = parseSchedules(options.schedules);
  const attempts: BenchmarkAttemptReport[] = [];
  for (const schedule of schedules) {
    const tasks = corpus.flatMap((artifact) => identities.map((identity) => ({ artifact, identity })));
    const scheduleAttempts = await boundedMap(
      tasks,
      schedule.parallelism,
      ({ artifact, identity }) => runAttempt(options, artifact, identity, schedule),
    );
    attempts.push(...scheduleAttempts);
  }
  const firstIdentity = identities[0]!;
  return deepFreeze({
    schema_version: "company_discovery.benchmark_report.v1",
    run_started_at: runStartedAt,
    comparison_invariant: {
      model_access: "hermes_openai_codex_subscription",
      subscription_gateway_id: firstIdentity.subscription_gateway_id,
      model_snapshot: firstIdentity.model_snapshot,
    },
    corpus_manifest: corpus.map((artifact) => ({
      case_id: artifact.case.case_id,
      source_name: artifact.source_name,
      corpus_sha256: artifact.corpus_sha256,
      source_snapshots_sha256: sha256(canonicalJson({
        schema_version: "company_discovery.evidence.v1",
        source_snapshots: artifact.case.source_snapshots,
      })),
    })),
    schedules,
    attempts,
  });
}
