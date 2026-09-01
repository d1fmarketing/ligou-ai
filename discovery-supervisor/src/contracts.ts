import { Buffer } from "node:buffer";

export type WorkerJobType = "company_discovery.v1";
export type DiscoveryAdapterId = "openclaw" | "direct_model";
export type ClaimClass = "descriptive" | "operational" | "safety_critical";

export interface DiscoverySourceSnapshot {
  readonly url: string;
  readonly retrieved_at: string;
  readonly http_status: number;
  readonly mime_type: "text/html";
  readonly byte_length: number;
  readonly content_hash: string;
  readonly excerpt: string;
  readonly crawl_order: number;
  readonly crawl_depth: number;
}

export interface DiscoveryBudget {
  readonly max_pages: number;
  readonly max_depth: number;
  readonly max_page_bytes: number;
  readonly max_job_bytes: number;
  readonly deadline_seconds: number;
}

export interface WorkerJob {
  readonly job_type: WorkerJobType;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly attempt_number: number;
  readonly fence_generation: number;
  readonly claim_token: string;
  readonly normalized_origin: string;
  readonly deadline_at: string;
  readonly budget: DiscoveryBudget;
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
}

export interface WorkerHandle {
  readonly adapter_id: DiscoveryAdapterId;
  readonly job_type: WorkerJobType;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
}

export type WorkerState = "running" | "succeeded" | "cancelled" | "failed";

export interface WorkerStatus {
  readonly state: WorkerState;
}

export interface CandidateFact {
  readonly claim_class: ClaimClass;
  readonly claim_type: string;
  readonly normalized_value: unknown;
  readonly evidence_refs: readonly number[];
  readonly contradictions: readonly string[];
  readonly uncertainty: Readonly<Record<string, unknown>>;
}

export interface WorkerResult {
  readonly schema_version: "company_discovery.result.v1";
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
  readonly candidate_facts: readonly CandidateFact[];
  readonly missing_questions: readonly string[];
  readonly contradictions: readonly string[];
  readonly uncertainty: Readonly<Record<string, unknown>>;
}

export interface WorkerAdapter {
  supports(jobType: WorkerJobType): boolean;
  submit(job: WorkerJob): Promise<WorkerHandle>;
  cancel(handle: WorkerHandle): Promise<void>;
  status(handle: WorkerHandle): Promise<WorkerStatus>;
  result(handle: WorkerHandle): Promise<WorkerResult>;
}

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

const RESULT_KEYS = [
  "schema_version",
  "source_snapshots",
  "candidate_facts",
  "missing_questions",
  "contradictions",
  "uncertainty",
] as const;

const SNAPSHOT_KEYS = [
  "url",
  "retrieved_at",
  "http_status",
  "mime_type",
  "byte_length",
  "content_hash",
  "excerpt",
  "crawl_order",
  "crawl_depth",
] as const;

const FACT_KEYS = [
  "claim_class",
  "claim_type",
  "normalized_value",
  "evidence_refs",
  "contradictions",
  "uncertainty",
] as const;

const JOB_KEYS = [
  "job_type",
  "job_id",
  "attempt_id",
  "attempt_number",
  "fence_generation",
  "claim_token",
  "normalized_origin",
  "deadline_at",
  "budget",
  "source_snapshots",
] as const;

const BUDGET_KEYS = [
  "max_pages",
  "max_depth",
  "max_page_bytes",
  "max_job_bytes",
  "deadline_seconds",
] as const;

const HANDLE_KEYS = [
  "adapter_id",
  "job_type",
  "job_id",
  "attempt_id",
  "fence_generation",
] as const;

const FORBIDDEN_KEYS = new Set([
  "tenant_id",
  "tenantid",
  "canonical_id",
  "canonicalid",
  "policy_group",
  "approval",
  "approved",
  "approved_by",
  "approved_at",
  "status",
  "effective",
  "active",
  "enabled",
  "policy_hash",
  "action_completion",
  "action_completed",
  "actioncompletion",
  "rule_id",
  "rule_group_id",
  "power",
  "powers",
  "capability",
  "grant",
  "authority",
  "materialization_key",
  "materialization_eligible",
  "review_ready",
  "operational_state",
  "source_kind",
  "source_call_id",
  "source_job_id",
  "source_result_id",
  "source_claim_id",
  "source_decision_id",
  "coverage_revision",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SERVICE_TYPE_PATTERN = /^[a-z0-9][a-z0-9_]{0,199}$/;

function fail(path: string, message: string): never {
  throw new ContractValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    fail(path, `expected exact keys ${expected.join(",")}`);
  }
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `expected integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    fail(path, `expected string length ${minimum}..${maximum}`);
  }
  return value;
}

function byteLength(value: unknown, path: string, maximum: number): void {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    fail(path, "must be JSON serializable");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximum) {
    fail(path, `exceeds ${maximum} bytes`);
  }
}

function forbiddenKeyName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}

function assertJsonAndNoForbiddenKeys(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "number must be finite");
    return;
  }
  if (typeof value !== "object") fail(path, "must be JSON data");
  if (seen.has(value as object)) fail(path, "must not be cyclic");
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonAndNoForbiddenKeys(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(forbiddenKeyName(key))) {
        fail(`${path}.${key}`, "forbidden authority or identity field");
      }
      assertJsonAndNoForbiddenKeys(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value as object);
}

function parseStringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail(path, `expected at most ${maximumItems} items`);
  }
  return value.map((item, index) => boundedString(item, `${path}[${index}]`, 1, maximumLength));
}

function parseUncertainty(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const parsed = record(value, path);
  assertJsonAndNoForbiddenKeys(parsed, path);
  byteLength(parsed, path, 4_096);
  return deepFreeze(structuredClone(parsed));
}

function parseSnapshot(value: unknown, index: number): DiscoverySourceSnapshot {
  const path = `source_snapshots[${index}]`;
  const candidate = record(value, path);
  exactKeys(candidate, SNAPSHOT_KEYS, path);
  assertJsonAndNoForbiddenKeys(candidate, path);

  const url = boundedString(candidate.url, `${path}.url`, 9, 2_048);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail(`${path}.url`, "invalid URL");
  }
  if (parsedUrl.protocol !== "https:") fail(`${path}.url`, "HTTPS required");
  const retrievedAt = boundedString(candidate.retrieved_at, `${path}.retrieved_at`, 20, 32);
  if (!UTC_TIMESTAMP_PATTERN.test(retrievedAt) || Number.isNaN(Date.parse(retrievedAt))) {
    fail(`${path}.retrieved_at`, "invalid UTC timestamp");
  }
  const mimeType = candidate.mime_type;
  if (mimeType !== "text/html") fail(`${path}.mime_type`, "text/html required");
  const contentHash = boundedString(candidate.content_hash, `${path}.content_hash`, 64, 64);
  if (!HASH_PATTERN.test(contentHash)) fail(`${path}.content_hash`, "invalid SHA-256");
  const excerpt = typeof candidate.excerpt === "string"
    ? candidate.excerpt
    : fail(`${path}.excerpt`, "expected string");
  byteLength(excerpt, `${path}.excerpt`, 16_384);

  return {
    url,
    retrieved_at: retrievedAt,
    http_status: integer(candidate.http_status, `${path}.http_status`, 100, 599),
    mime_type: mimeType,
    byte_length: integer(candidate.byte_length, `${path}.byte_length`, 0, 1_048_576),
    content_hash: contentHash,
    excerpt,
    crawl_order: integer(candidate.crawl_order, `${path}.crawl_order`, 0, 24),
    crawl_depth: integer(candidate.crawl_depth, `${path}.crawl_depth`, 0, 2),
  };
}

export function parseSourceSnapshots(
  value: unknown,
  options: { allowEmpty?: boolean } = {},
): readonly DiscoverySourceSnapshot[] {
  if (!Array.isArray(value)) fail("source_snapshots", "expected array");
  const minimum = options.allowEmpty ? 0 : 1;
  if (value.length < minimum || value.length > 25) {
    fail("source_snapshots", `expected ${minimum}..25 items`);
  }
  const snapshots = value.map(parseSnapshot);
  snapshots.forEach((snapshot, index) => {
    if (snapshot.crawl_order !== index) {
      fail(`source_snapshots[${index}].crawl_order`, `expected ${index}`);
    }
  });
  const declaredBytes = snapshots.reduce((total, snapshot) => total + snapshot.byte_length, 0);
  if (declaredBytes > 10_485_760) fail("source_snapshots", "declared bytes exceed job limit");
  return deepFreeze(snapshots);
}

function parseServiceValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const service = record(value, path);
  const keys = [
    "service_type",
    "service_names",
    "price_mode",
    "negotiation_mode",
    "price_target",
    "price_min",
    "duration_min",
  ] as const;
  exactKeys(service, keys, path);
  assertJsonAndNoForbiddenKeys(service, path);
  const serviceType = boundedString(service.service_type, `${path}.service_type`, 1, 200);
  if (!SERVICE_TYPE_PATTERN.test(serviceType)) fail(`${path}.service_type`, "invalid service type");
  const serviceNames = parseStringArray(service.service_names, `${path}.service_names`, 20, 200);
  if (serviceNames.length === 0) fail(`${path}.service_names`, "at least one name required");
  if (service.price_mode !== "fixed" && service.price_mode !== "starting_at") {
    fail(`${path}.price_mode`, "invalid price mode");
  }
  if (service.negotiation_mode !== "negotiable" && service.negotiation_mode !== "non_negotiable") {
    fail(`${path}.negotiation_mode`, "invalid negotiation mode");
  }
  for (const key of ["price_target", "price_min", "duration_min"] as const) {
    if (typeof service[key] !== "number" || !Number.isFinite(service[key])) {
      fail(`${path}.${key}`, "expected finite number");
    }
  }
  const priceTarget = service.price_target as number;
  const priceMin = service.price_min as number;
  const durationMin = service.duration_min as number;
  if (priceTarget < 0 || priceMin < 0 || priceMin > priceTarget || durationMin <= 0) {
    fail(path, "invalid price or duration bounds");
  }
  if (service.negotiation_mode === "non_negotiable" && priceMin !== priceTarget) {
    fail(path, "non-negotiable price must have equal minimum and target");
  }
  return deepFreeze({
    service_type: serviceType,
    service_names: serviceNames,
    price_mode: service.price_mode,
    negotiation_mode: service.negotiation_mode,
    price_target: priceTarget,
    price_min: priceMin,
    duration_min: durationMin,
  });
}

function parseNormalizedValue(
  claimClass: ClaimClass,
  claimType: string,
  value: unknown,
  path: string,
): unknown {
  assertJsonAndNoForbiddenKeys(value, path);
  byteLength(value, path, 65_536);
  if (claimClass === "descriptive") {
    const types = new Set([
      "business_name",
      "business_description",
      "public_phone",
      "public_email",
      "public_address",
      "public_website",
    ]);
    if (!types.has(claimType)) fail(path, "unsupported descriptive claim type");
    return boundedString(value, path, 1, 2_000);
  }
  if (claimClass === "operational") {
    if (claimType !== "service") fail(path, "unsupported operational claim type");
    return parseServiceValue(value, path);
  }
  if (claimType !== "emergency") fail(path, "unsupported safety-critical claim type");
  const emergency = record(value, path);
  exactKeys(emergency, ["guidance"], path);
  return deepFreeze({ guidance: boundedString(emergency.guidance, `${path}.guidance`, 1, 2_000) });
}

function parseFact(value: unknown, index: number, snapshotCount: number): CandidateFact {
  const path = `candidate_facts[${index}]`;
  const fact = record(value, path);
  exactKeys(fact, FACT_KEYS, path);
  assertJsonAndNoForbiddenKeys(fact, path);
  if (fact.claim_class === "owner_private") fail(`${path}.claim_class`, "owner_private facts forbidden");
  if (fact.claim_class !== "descriptive" &&
      fact.claim_class !== "operational" &&
      fact.claim_class !== "safety_critical") {
    fail(`${path}.claim_class`, "invalid claim class");
  }
  const claimClass = fact.claim_class as ClaimClass;
  const claimType = boundedString(fact.claim_type, `${path}.claim_type`, 1, 200);
  if (!Array.isArray(fact.evidence_refs) || fact.evidence_refs.length < 1 || fact.evidence_refs.length > 25) {
    fail(`${path}.evidence_refs`, "expected 1..25 evidence references");
  }
  const evidenceRefs = fact.evidence_refs.map((reference, referenceIndex) =>
    integer(reference, `${path}.evidence_refs[${referenceIndex}]`, 0, snapshotCount - 1)
  );
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    fail(`${path}.evidence_refs`, "duplicate evidence reference");
  }
  const contradictions = parseStringArray(fact.contradictions, `${path}.contradictions`, 20, 2_000);
  return {
    claim_class: claimClass,
    claim_type: claimType,
    normalized_value: parseNormalizedValue(
      claimClass,
      claimType,
      fact.normalized_value,
      `${path}.normalized_value`,
    ),
    evidence_refs: deepFreeze(evidenceRefs),
    contradictions: deepFreeze(contradictions),
    uncertainty: parseUncertainty(fact.uncertainty, `${path}.uncertainty`),
  };
}

export function parseWorkerResult(value: unknown): WorkerResult {
  const candidate = record(value, "result");
  exactKeys(candidate, RESULT_KEYS, "result");
  assertJsonAndNoForbiddenKeys(candidate, "result");
  if (candidate.schema_version !== "company_discovery.result.v1") {
    fail("result.schema_version", "company_discovery.result.v1 required");
  }
  const snapshots = parseSourceSnapshots(candidate.source_snapshots);
  if (!Array.isArray(candidate.candidate_facts) || candidate.candidate_facts.length > 100) {
    fail("candidate_facts", "expected at most 100 items");
  }
  const facts = candidate.candidate_facts.map((fact, index) => parseFact(fact, index, snapshots.length));
  const result: WorkerResult = {
    schema_version: "company_discovery.result.v1",
    source_snapshots: snapshots,
    candidate_facts: deepFreeze(facts),
    missing_questions: deepFreeze(parseStringArray(candidate.missing_questions, "missing_questions", 50, 1_000)),
    contradictions: deepFreeze(parseStringArray(candidate.contradictions, "contradictions", 50, 2_000)),
    uncertainty: parseUncertainty(candidate.uncertainty, "uncertainty"),
  };
  byteLength(result, "result", 10_485_760);
  return deepFreeze(result);
}

export function parseWorkerJob(
  value: unknown,
  options: { allowEmptyEvidence?: boolean } = {},
): WorkerJob {
  const candidate = record(value, "job");
  exactKeys(candidate, JOB_KEYS, "job");
  if (candidate.job_type !== "company_discovery.v1") {
    fail("job.job_type", "company_discovery.v1 required");
  }
  for (const key of ["job_id", "attempt_id"] as const) {
    if (typeof candidate[key] !== "string" || !UUID_PATTERN.test(candidate[key])) {
      fail(`job.${key}`, "invalid UUID");
    }
  }
  const claimToken = boundedString(candidate.claim_token, "job.claim_token", 1, 512);
  const normalizedOrigin = boundedString(candidate.normalized_origin, "job.normalized_origin", 9, 2_048);
  let origin: URL;
  try {
    origin = new URL(normalizedOrigin);
  } catch {
    fail("job.normalized_origin", "invalid URL");
  }
  if (origin.protocol !== "https:") fail("job.normalized_origin", "HTTPS required");
  const deadlineAt = boundedString(candidate.deadline_at, "job.deadline_at", 20, 32);
  if (!UTC_TIMESTAMP_PATTERN.test(deadlineAt) || Number.isNaN(Date.parse(deadlineAt))) {
    fail("job.deadline_at", "invalid UTC timestamp");
  }
  const budget = record(candidate.budget, "job.budget");
  exactKeys(budget, BUDGET_KEYS, "job.budget");
  const parsedBudget: DiscoveryBudget = {
    max_pages: integer(budget.max_pages, "job.budget.max_pages", 1, 25),
    max_depth: integer(budget.max_depth, "job.budget.max_depth", 0, 2),
    max_page_bytes: integer(budget.max_page_bytes, "job.budget.max_page_bytes", 1, 1_048_576),
    max_job_bytes: integer(budget.max_job_bytes, "job.budget.max_job_bytes", 1, 10_485_760),
    deadline_seconds: integer(budget.deadline_seconds, "job.budget.deadline_seconds", 1, 600),
  };
  return deepFreeze({
    job_type: "company_discovery.v1",
    job_id: candidate.job_id as string,
    attempt_id: candidate.attempt_id as string,
    attempt_number: integer(candidate.attempt_number, "job.attempt_number", 1, Number.MAX_SAFE_INTEGER),
    fence_generation: integer(candidate.fence_generation, "job.fence_generation", 1, Number.MAX_SAFE_INTEGER),
    claim_token: claimToken,
    normalized_origin: normalizedOrigin,
    deadline_at: deadlineAt,
    budget: deepFreeze(parsedBudget),
    source_snapshots: parseSourceSnapshots(candidate.source_snapshots, {
      allowEmpty: options.allowEmptyEvidence,
    }),
  });
}

export function parseWorkerHandle(value: unknown): WorkerHandle {
  const candidate = record(value, "handle");
  exactKeys(candidate, HANDLE_KEYS, "handle");
  if (candidate.adapter_id !== "openclaw" && candidate.adapter_id !== "direct_model") {
    fail("handle.adapter_id", "invalid adapter");
  }
  if (candidate.job_type !== "company_discovery.v1") {
    fail("handle.job_type", "company_discovery.v1 required");
  }
  for (const key of ["job_id", "attempt_id"] as const) {
    if (typeof candidate[key] !== "string" || !UUID_PATTERN.test(candidate[key])) {
      fail(`handle.${key}`, "invalid UUID");
    }
  }
  return deepFreeze({
    adapter_id: candidate.adapter_id,
    job_type: "company_discovery.v1",
    job_id: candidate.job_id as string,
    attempt_id: candidate.attempt_id as string,
    fence_generation: integer(candidate.fence_generation, "handle.fence_generation", 1, Number.MAX_SAFE_INTEGER),
  });
}

export function parseWorkerStatus(value: unknown): WorkerStatus {
  const candidate = record(value, "status");
  exactKeys(candidate, ["state"], "status");
  if (candidate.state !== "running" && candidate.state !== "succeeded" &&
      candidate.state !== "cancelled" && candidate.state !== "failed") {
    fail("status.state", "invalid worker state");
  }
  return deepFreeze({ state: candidate.state });
}

export function isDiscoveryAdapterId(value: unknown): value is DiscoveryAdapterId {
  return value === "openclaw" || value === "direct_model";
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
