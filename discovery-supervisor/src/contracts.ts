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

export interface CandidateFactV1 {
  readonly claim_class: ClaimClass;
  readonly claim_type: string;
  readonly normalized_value: unknown;
  readonly evidence_refs: readonly number[];
  readonly contradictions: readonly string[];
  readonly uncertainty: readonly string[];
}

export interface CandidateFactV2 extends CandidateFactV1 {
  readonly confidence: "high" | "medium" | "low";
  readonly contradiction_status: "none" | "possible" | "confirmed";
  readonly missing_fields: readonly string[];
  readonly ambiguous_fields: readonly string[];
  readonly claim_schema_version: "company_discovery.claim.v2";
}

export type CandidateFact = CandidateFactV1 | CandidateFactV2;

export interface WorkerResult {
  readonly schema_version: "company_discovery.result.v1" | "company_discovery.result.v2";
  readonly source_snapshots: readonly DiscoverySourceSnapshot[];
  readonly candidate_facts: readonly CandidateFact[];
  readonly missing_questions: readonly string[];
  readonly contradictions: readonly string[];
  readonly uncertainty: readonly string[];
}

declare const modelAccessCapabilityBrand: unique symbol;
declare const subscriptionLeaseCapabilityBrand: unique symbol;
declare const subscriptionRecoveryCapabilityBrand: unique symbol;
declare const subscriptionRequestReservationBrand: unique symbol;

export interface ModelAccessCapability {
  readonly [modelAccessCapabilityBrand]: "ligou-model-access";
}

export interface ModelAccessExpectation {
  readonly adapter_id: DiscoveryAdapterId;
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
  readonly runtime_slot_id?: string;
}

export interface ModelAccessContext extends ModelAccessExpectation {
  readonly runtime_slot_id: string;
  readonly tenant_id: string;
  readonly credential_owner_id: string;
  readonly credential_generation: number;
  readonly expected_account_hash: string;
  readonly deadline_at: string;
  readonly source_snapshot_count: number;
  readonly subscription_socket_path: string;
  readonly runtime_identity_hash: string;
  readonly provider: "openai-codex";
  readonly auth_kind: "chatgpt_subscription_oauth";
  readonly model: "gpt-5.6-sol";
}

export interface ModelAccessAuthority {
  assertModelAccessCurrent(
    capability: ModelAccessCapability,
    expected?: ModelAccessExpectation,
  ): Promise<Readonly<ModelAccessContext>>;
  assertSubscriptionRecoveryCurrent(
    capability: SubscriptionRecoveryCapability,
  ): Promise<Readonly<SubscriptionRecoveryContext>>;
  reserveSubscriptionRequest(
    capability: ModelAccessCapability,
    prospective: SubscriptionRequestProspective,
  ): Promise<Readonly<SubscriptionReservationReadback>>;
  settleSubscriptionRequest(
    reservation: SubscriptionRequestReservationCapability,
    settlement: SubscriptionRequestSettlement,
  ): Promise<Readonly<SubscriptionSettlementReadback>>;
}

export interface SubscriptionRequestReservationCapability {
  readonly [subscriptionRequestReservationBrand]: "ligou-subscription-request";
}

export interface SubscriptionRequestProspective {
  readonly input_bytes: number;
  readonly output_bytes: number;
  readonly lease_seconds: number;
}

export interface SubscriptionReservationReadback {
  readonly reservation: SubscriptionRequestReservationCapability;
  readonly request_number: number;
  readonly lease_until: string;
  readonly quota_state: "available";
  /** Tenant totals in the credential owner's current durable window. */
  readonly current_requests: number;
  readonly current_input_bytes: number;
  readonly current_output_bytes: number;
  readonly max_requests: 28;
  readonly max_input_bytes: 400_000;
  readonly max_output_bytes: 8_388_608;
  /** Credential-owner totals across every tenant in the same durable window. */
  readonly owner_current_requests: number;
  readonly owner_current_input_bytes: number;
  readonly owner_current_output_bytes: number;
  readonly owner_max_requests: 140;
  readonly owner_max_input_bytes: 2_000_000;
  readonly owner_max_output_bytes: 40_000_000;
  readonly max_concurrency: 1;
}

export interface SubscriptionRequestSettlement {
  readonly input_bytes: number;
  readonly output_bytes: number;
  readonly observed_input_tokens: number | null;
  readonly observed_output_tokens: number | null;
  readonly usage_complete: boolean;
  readonly quota_state: "available" | "cooldown" | "unknown";
  readonly retry_after_seconds: number | null;
}

export interface SubscriptionSettlementReadback {
  readonly settled: true;
  readonly quota_state: "available" | "cooldown" | "unknown";
  readonly cooldown_until: string | null;
  /** Tenant totals in the credential owner's current durable window. */
  readonly current_requests: number;
  readonly current_input_bytes: number;
  readonly current_output_bytes: number;
  readonly max_requests: 28;
  readonly max_input_bytes: 400_000;
  readonly max_output_bytes: 8_388_608;
  /** Credential-owner totals across every tenant in the same durable window. */
  readonly owner_current_requests: number;
  readonly owner_current_input_bytes: number;
  readonly owner_current_output_bytes: number;
  readonly owner_max_requests: 140;
  readonly owner_max_input_bytes: 2_000_000;
  readonly owner_max_output_bytes: 40_000_000;
  readonly max_concurrency: 1;
}

export interface SubscriptionRecoveryCapability {
  readonly [subscriptionRecoveryCapabilityBrand]: "ligou-subscription-recovery";
}

export interface SubscriptionRecoveryContext {
  readonly job_id: string;
  readonly attempt_id: string;
  readonly fence_generation: number;
  readonly subscription_socket_path: string;
  readonly runtime_kind: "openclaw_cell" | "direct_model_subscription";
  readonly late_result_rejected: true;
}

export interface SubscriptionPolicy {
  readonly model: "gpt-5.6-sol";
  readonly deadline_at: string;
  readonly max_requests: number;
  readonly max_input_bytes: 400_000;
  readonly max_output_bytes: 8_388_608;
  readonly max_response_bytes: 4_194_304;
  readonly concurrency: 1;
  readonly cache_retention: "none";
}

export interface SubscriptionLeaseCapability {
  readonly [subscriptionLeaseCapabilityBrand]: "ligou-subscription-lease";
}

export interface RegisteredSubscriptionLease {
  readonly lease: SubscriptionLeaseCapability;
  readonly attempt_marker: string;
  readonly subscription_socket_path: string;
  readonly session_id: string;
  readonly policy: Readonly<SubscriptionPolicy>;
}

export interface SubscriptionUsage {
  readonly schema_version: "ligou.subscription_usage.v1";
  readonly provider: "openai-codex";
  readonly model: "gpt-5.6-sol";
  readonly billing_basis: "chatgpt_subscription";
  readonly marginal_api_charge_usd: 0;
  readonly request_count: number;
  readonly active_requests: number;
  readonly input_bytes: number;
  readonly output_bytes: number;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly usage_complete: boolean;
  readonly quota_state: "available" | "cooldown" | "unknown";
  readonly retry_after_seconds: number | null;
  readonly cooldown_until: string | null;
  readonly revoked: boolean;
}

export interface SubscriptionRevocationReadback {
  readonly generation: number;
  readonly subscription_lease_revoked: true;
  readonly subscription_requests_drained: true;
  readonly subscription_listener_closed: true;
  readonly subscription_socket_absent: true;
}

export interface SubscriptionGateway {
  register(modelAccess: ModelAccessCapability): Promise<RegisteredSubscriptionLease>;
  forward(
    lease: SubscriptionLeaseCapability,
    request: Request,
    signal?: AbortSignal,
  ): Promise<Response>;
  usage(lease: SubscriptionLeaseCapability): Readonly<SubscriptionUsage>;
  revoke(lease: SubscriptionLeaseCapability): Promise<SubscriptionRevocationReadback>;
  recover(
    authority: SubscriptionRecoveryCapability,
  ): Promise<SubscriptionRevocationReadback>;
}

export interface WorkerAdapter {
  supports(jobType: WorkerJobType): boolean;
  submit(job: WorkerJob, modelAccess: ModelAccessCapability): Promise<WorkerHandle>;
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

export type WorkerExecutionFailureCode =
  | "direct_model_provider_error"
  | "direct_model_stream_incomplete"
  | "direct_model_stream_truncated"
  | "direct_model_protocol_invalid"
  | "direct_model_deadline_exceeded"
  | "direct_model_schema_invalid";

export class WorkerExecutionError extends Error {
  readonly code: WorkerExecutionFailureCode;

  constructor(code: WorkerExecutionFailureCode, message: string) {
    super(message);
    this.name = "WorkerExecutionError";
    this.code = code;
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

const FACT_V2_KEYS = [
  "claim_class",
  "claim_type",
  "normalized_value",
  "evidence_refs",
  "confidence",
  "contradiction_status",
  "contradictions",
  "missing_fields",
  "ambiguous_fields",
  "uncertainty",
  "claim_schema_version",
] as const;

const JOB_KEYS = [
  "job_type",
  "job_id",
  "attempt_id",
  "attempt_number",
  "fence_generation",
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const DEADLINE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const SERVICE_TYPE_PATTERN = /^[a-z0-9][a-z0-9_]{0,199}$/;

function fail(path: string, message: string): never {
  throw new ContractValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "expected plain object");
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

function isStrictIsoTimestamp(value: string): boolean {
  const match = DEADLINE_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]! && !Number.isNaN(Date.parse(value));
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

function parseSnapshot(value: unknown, index: number): DiscoverySourceSnapshot {
  const path = `source_snapshots[${index}]`;
  const candidate = record(value, path);
  exactKeys(candidate, SNAPSHOT_KEYS, path);
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
  options: { allowEmpty?: boolean; budget?: DiscoveryBudget } = {},
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
  if (options.budget !== undefined) {
    if (snapshots.length > options.budget.max_pages) {
      fail("job.budget.max_pages", "evidence exceeds job budget");
    }
    if (snapshots.some((snapshot) => snapshot.crawl_depth > options.budget!.max_depth)) {
      fail("job.budget.max_depth", "evidence exceeds job budget");
    }
    if (snapshots.some((snapshot) => snapshot.byte_length > options.budget!.max_page_bytes)) {
      fail("job.budget.max_page_bytes", "evidence exceeds job budget");
    }
    if (declaredBytes > options.budget.max_job_bytes) {
      fail("job.budget.max_job_bytes", "evidence exceeds job budget");
    }
  }
  return deepFreeze(snapshots);
}

function parseServiceValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const service = record(value, path);
  const keys = [
    "service_type",
    "service_names",
    "public_price",
    "duration_minutes",
  ] as const;
  exactKeys(service, keys, path);
  const serviceType = boundedString(service.service_type, `${path}.service_type`, 1, 200);
  if (!SERVICE_TYPE_PATTERN.test(serviceType)) fail(`${path}.service_type`, "invalid service type");
  const serviceNames = parseStringArray(service.service_names, `${path}.service_names`, 20, 200);
  if (serviceNames.length === 0) fail(`${path}.service_names`, "at least one name required");
  let publicPrice: Readonly<Record<string, unknown>> | null = null;
  if (service.public_price !== null) {
    const price = record(service.public_price, `${path}.public_price`);
    exactKeys(price, ["amount", "currency", "qualifier"], `${path}.public_price`);
    const amount = boundedString(price.amount, `${path}.public_price.amount`, 4, 12);
    if (!/^(0|[1-9][0-9]{0,8})[.][0-9]{2}$/.test(amount)) {
      fail(`${path}.public_price.amount`, "expected non-exponent decimal string");
    }
    const currency = boundedString(price.currency, `${path}.public_price.currency`, 3, 3);
    if (!/^[A-Z]{3}$/.test(currency)) fail(`${path}.public_price.currency`, "invalid currency");
    if (price.qualifier !== "exact" && price.qualifier !== "starting_at") {
      fail(`${path}.public_price.qualifier`, "invalid public price qualifier");
    }
    publicPrice = deepFreeze({ amount, currency, qualifier: price.qualifier });
  }
  const durationMinutes = service.duration_minutes === null
    ? null
    : integer(service.duration_minutes, `${path}.duration_minutes`, 1, 10_080);
  return deepFreeze({
    service_type: serviceType,
    service_names: serviceNames,
    public_price: publicPrice,
    duration_minutes: durationMinutes,
  });
}

function parseNormalizedValue(
  claimClass: ClaimClass,
  claimType: string,
  value: unknown,
  path: string,
): unknown {
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

function nullableServiceType(value: unknown, path: string): string | null {
  if (value === null) return null;
  const serviceType = boundedString(value, path, 1, 200);
  if (!SERVICE_TYPE_PATTERN.test(serviceType)) fail(path, "invalid service type");
  return serviceType;
}

function nullableBoundedString(
  value: unknown,
  path: string,
  maximum: number,
): string | null {
  return value === null ? null : boundedString(value, path, 1, maximum);
}

function parseTerritoryEntry(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  const entry = record(value, path);
  exactKeys(entry, ["kind", "name", "region_state", "country_code"], path);
  if (!["city", "county", "region_state", "postal_code", "marketing_region"].includes(
    String(entry.kind),
  )) fail(`${path}.kind`, "invalid territory kind");
  const countryCode = nullableBoundedString(entry.country_code, `${path}.country_code`, 2);
  if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
    fail(`${path}.country_code`, "invalid country code");
  }
  return deepFreeze({
    kind: entry.kind,
    name: boundedString(entry.name, `${path}.name`, 1, 200),
    region_state: nullableBoundedString(entry.region_state, `${path}.region_state`, 100),
    country_code: countryCode,
  });
}

function parseTerritoryEntries(value: unknown, path: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > 50) fail(path, "expected at most 50 areas");
  const entries = value.map((entry, index) => parseTerritoryEntry(entry, `${path}[${index}]`));
  if (new Set(entries.map((entry) => JSON.stringify(entry))).size !== entries.length) {
    fail(path, "duplicate territory area");
  }
  return deepFreeze(entries);
}

function parseTerritoryValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const territory = record(value, path);
  exactKeys(
    territory,
    ["service_type", "included_areas", "excluded_areas", "radius"],
    path,
  );
  const included = parseTerritoryEntries(territory.included_areas, `${path}.included_areas`);
  const excluded = parseTerritoryEntries(territory.excluded_areas, `${path}.excluded_areas`);
  if (included.length === 0 && excluded.length === 0 && territory.radius === null) {
    fail(path, "territory needs explicit included, excluded, or radius evidence");
  }
  let radius: Readonly<Record<string, unknown>> | null = null;
  if (territory.radius !== null) {
    const candidate = record(territory.radius, `${path}.radius`);
    exactKeys(candidate, ["distance", "unit", "center"], `${path}.radius`);
    const distance = boundedString(candidate.distance, `${path}.radius.distance`, 1, 12);
    if (!/^(?:0[.][0-9]*[1-9]|[1-9][0-9]{0,6}(?:[.][0-9]{1,3})?)$/.test(distance)) {
      fail(`${path}.radius.distance`, "positive decimal string required");
    }
    if (candidate.unit !== "miles" && candidate.unit !== "kilometers") {
      fail(`${path}.radius.unit`, "invalid radius unit");
    }
    radius = deepFreeze({
      distance,
      unit: candidate.unit,
      center: nullableBoundedString(candidate.center, `${path}.radius.center`, 200),
    });
  }
  return deepFreeze({
    service_type: nullableServiceType(territory.service_type, `${path}.service_type`),
    included_areas: included,
    excluded_areas: excluded,
    radius,
  });
}

const WEEKDAYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);

function parseWeekdays(value: unknown, path: string, allowEmpty: boolean): readonly string[] {
  const days = parseStringArray(value, path, 7, 3);
  if ((!allowEmpty && days.length === 0) || days.some((day) => !WEEKDAYS.has(day)) ||
      new Set(days).size !== days.length) {
    fail(path, "invalid unique weekdays");
  }
  return deepFreeze(days);
}

function parseHoursValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const hours = record(value, path);
  exactKeys(hours, [
    "timezone", "ordinary_intervals", "closed_days", "ordinary_24_7",
    "emergency_24_7", "after_hours", "holiday_policy",
  ], path);
  if (!Array.isArray(hours.ordinary_intervals) || hours.ordinary_intervals.length > 14) {
    fail(`${path}.ordinary_intervals`, "expected at most 14 intervals");
  }
  const intervals = hours.ordinary_intervals.map((value, index) => {
    const intervalPath = `${path}.ordinary_intervals[${index}]`;
    const interval = record(value, intervalPath);
    exactKeys(interval, ["days", "opens", "closes"], intervalPath);
    const opens = boundedString(interval.opens, `${intervalPath}.opens`, 5, 5);
    const closes = boundedString(interval.closes, `${intervalPath}.closes`, 5, 5);
    if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(opens) ||
        !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(closes) || opens === closes) {
      fail(intervalPath, "invalid ordinary interval");
    }
    return deepFreeze({
      days: parseWeekdays(interval.days, `${intervalPath}.days`, false),
      opens,
      closes,
    });
  });
  const closedDays = parseWeekdays(hours.closed_days, `${path}.closed_days`, true);
  const intervalDays = new Set(intervals.flatMap((interval) => interval.days as string[]));
  if (closedDays.some((day) => intervalDays.has(day))) {
    fail(`${path}.closed_days`, "closed day also has ordinary hours");
  }
  if (typeof hours.ordinary_24_7 !== "boolean" || typeof hours.emergency_24_7 !== "boolean") {
    fail(path, "24/7 flags must be boolean");
  }
  if (hours.ordinary_24_7 && (intervals.length !== 0 || closedDays.length !== 0)) {
    fail(`${path}.ordinary_24_7`, "ordinary 24/7 conflicts with intervals or closed days");
  }
  if (!["not_stated", "unavailable", "available", "emergency_only"].includes(
    String(hours.after_hours),
  )) fail(`${path}.after_hours`, "invalid after-hours value");
  if (hours.emergency_24_7 && !["available", "emergency_only"].includes(String(hours.after_hours))) {
    fail(`${path}.emergency_24_7`, "emergency 24/7 conflicts with after-hours value");
  }
  const timezone = nullableBoundedString(hours.timezone, `${path}.timezone`, 100);
  if (timezone !== null && timezone !== "UTC" && !/^[A-Za-z_]+\/[A-Za-z0-9_+.-]+$/.test(timezone)) {
    fail(`${path}.timezone`, "invalid explicit timezone");
  }
  return deepFreeze({
    timezone,
    ordinary_intervals: deepFreeze(intervals),
    closed_days: closedDays,
    ordinary_24_7: hours.ordinary_24_7,
    emergency_24_7: hours.emergency_24_7,
    after_hours: hours.after_hours,
    holiday_policy: nullableBoundedString(hours.holiday_policy, `${path}.holiday_policy`, 2_000),
  });
}

function parseGuaranteeValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const guarantee = record(value, path);
  exactKeys(
    guarantee,
    ["guarantee_kind", "service_type", "coverage", "duration", "conditions", "exclusions"],
    path,
  );
  if (!["company_guarantee", "manufacturer_warranty", "satisfaction_statement", "case_by_case"].includes(
    String(guarantee.guarantee_kind),
  )) fail(`${path}.guarantee_kind`, "invalid guarantee kind");
  const coverage = parseStringArray(guarantee.coverage, `${path}.coverage`, 5, 20);
  const allowedCoverage = new Set(["labor", "parts", "product", "service", "satisfaction"]);
  if (coverage.length === 0 || coverage.some((item) => !allowedCoverage.has(item)) ||
      new Set(coverage).size !== coverage.length) fail(`${path}.coverage`, "invalid guarantee coverage");
  let duration: Readonly<Record<string, unknown>> | null = null;
  if (guarantee.duration !== null) {
    const candidate = record(guarantee.duration, `${path}.duration`);
    exactKeys(candidate, ["amount", "unit"], `${path}.duration`);
    if (candidate.unit !== "days" && candidate.unit !== "months" && candidate.unit !== "years") {
      fail(`${path}.duration.unit`, "invalid duration unit");
    }
    duration = deepFreeze({
      amount: integer(candidate.amount, `${path}.duration.amount`, 1, 10_000),
      unit: candidate.unit,
    });
  }
  if ((guarantee.guarantee_kind === "satisfaction_statement" ||
       guarantee.guarantee_kind === "case_by_case") && duration !== null) {
    fail(`${path}.duration`, "vague guarantee cannot invent a duration");
  }
  return deepFreeze({
    guarantee_kind: guarantee.guarantee_kind,
    service_type: nullableServiceType(guarantee.service_type, `${path}.service_type`),
    coverage: deepFreeze(coverage),
    duration,
    conditions: deepFreeze(parseStringArray(guarantee.conditions, `${path}.conditions`, 20, 1_000)),
    exclusions: deepFreeze(parseStringArray(guarantee.exclusions, `${path}.exclusions`, 20, 1_000)),
  });
}

function parseBookingRestrictionValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const restriction = record(value, path);
  exactKeys(
    restriction,
    ["restriction_type", "service_type", "rule", "notice_minutes", "public_fee", "conditions"],
    path,
  );
  const restrictionTypes = new Set([
    "same_day", "advance_notice", "weekend", "sunday", "emergency_only", "access",
    "deposit", "cancellation", "no_show_fee", "visit_fee", "customer_presence",
    "service_specific",
  ]);
  if (!restrictionTypes.has(String(restriction.restriction_type))) {
    fail(`${path}.restriction_type`, "invalid booking restriction type");
  }
  if (!["allowed", "not_allowed", "required", "conditional", "fee_applies", "emergency_only"].includes(
    String(restriction.rule),
  )) fail(`${path}.rule`, "invalid booking restriction rule");
  const publicFee = restriction.public_fee === null
    ? null
    : parsePublicPriceV2(restriction.public_fee, `${path}.public_fee`);
  const conditions = parseStringArray(restriction.conditions, `${path}.conditions`, 20, 1_000);
  if (conditions.length === 0) fail(`${path}.conditions`, "explicit condition required");
  return deepFreeze({
    restriction_type: restriction.restriction_type,
    service_type: nullableServiceType(restriction.service_type, `${path}.service_type`),
    rule: restriction.rule,
    notice_minutes: restriction.notice_minutes === null
      ? null
      : integer(restriction.notice_minutes, `${path}.notice_minutes`, 1, 525_600),
    public_fee: publicFee,
    conditions: deepFreeze(conditions),
  });
}

function parsePublicPriceV2(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const price = record(value, path);
  exactKeys(price, ["amount", "currency", "qualifier", "condition"], path);
  const qualifiers = new Set([
    "fixed", "starting_at", "estimate", "promotional", "conditional", "unknown",
  ]);
  if (!qualifiers.has(String(price.qualifier))) fail(`${path}.qualifier`, "invalid public price qualifier");
  const amount = price.amount === null
    ? null
    : boundedString(price.amount, `${path}.amount`, 4, 12);
  if (amount !== null && !/^(0|[1-9][0-9]{0,8})[.][0-9]{2}$/.test(amount)) {
    fail(`${path}.amount`, "expected non-exponent decimal string");
  }
  const currency = price.currency === null
    ? null
    : boundedString(price.currency, `${path}.currency`, 3, 3);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    fail(`${path}.currency`, "invalid currency");
  }
  if ((amount === null) !== (currency === null)) fail(path, "amount and currency must appear together");
  if (["fixed", "starting_at", "conditional"].includes(String(price.qualifier)) && amount === null) {
    fail(path, "priced qualifier requires public amount");
  }
  if (price.qualifier === "unknown" && amount !== null) fail(path, "unknown price cannot carry an amount");
  const condition = nullableBoundedString(price.condition, `${path}.condition`, 1_000);
  if (price.qualifier === "conditional" && condition === null) {
    fail(`${path}.condition`, "conditional public price requires its condition");
  }
  return deepFreeze({ amount, currency, qualifier: price.qualifier, condition });
}

function parseServiceValueV2(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const service = record(value, path);
  exactKeys(service, ["service_type", "service_names", "public_price", "duration_minutes"], path);
  const serviceType = nullableServiceType(service.service_type, `${path}.service_type`);
  if (serviceType === null) fail(`${path}.service_type`, "service type required");
  const names = parseStringArray(service.service_names, `${path}.service_names`, 20, 200);
  if (names.length === 0 || new Set(names).size !== names.length) {
    fail(`${path}.service_names`, "unique service names required");
  }
  return deepFreeze({
    service_type: serviceType,
    service_names: deepFreeze(names),
    public_price: service.public_price === null
      ? null
      : parsePublicPriceV2(service.public_price, `${path}.public_price`),
    duration_minutes: service.duration_minutes === null
      ? null
      : integer(service.duration_minutes, `${path}.duration_minutes`, 1, 10_080),
  });
}

function parseNormalizedValueV2(
  claimClass: ClaimClass,
  claimType: string,
  value: unknown,
  path: string,
): unknown {
  byteLength(value, path, 65_536);
  if (claimClass === "descriptive") {
    const types = new Set([
      "business_name", "business_description", "public_phone", "public_email",
      "public_address", "public_website",
    ]);
    if (!types.has(claimType)) fail(path, "unsupported descriptive claim type");
    return boundedString(value, path, 1, 2_000);
  }
  if (claimClass === "safety_critical") {
    if (claimType !== "emergency") fail(path, "unsupported safety-critical claim type");
    const emergency = record(value, path);
    exactKeys(emergency, ["guidance"], path);
    return deepFreeze({ guidance: boundedString(emergency.guidance, `${path}.guidance`, 1, 2_000) });
  }
  if (claimType === "service") return parseServiceValueV2(value, path);
  if (claimType === "service_territory") return parseTerritoryValue(value, path);
  if (claimType === "business_hours") return parseHoursValue(value, path);
  if (claimType === "guarantee") return parseGuaranteeValue(value, path);
  if (claimType === "booking_restriction") return parseBookingRestrictionValue(value, path);
  fail(path, "unsupported Stage 0B claim type");
}

function parseFact(
  value: unknown,
  index: number,
  snapshotCount: number,
  schemaVersion: WorkerResult["schema_version"],
): CandidateFact {
  const path = `candidate_facts[${index}]`;
  const fact = record(value, path);
  exactKeys(fact, schemaVersion === "company_discovery.result.v2" ? FACT_V2_KEYS : FACT_KEYS, path);
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
  const common = {
    claim_class: claimClass,
    claim_type: claimType,
    normalized_value: schemaVersion === "company_discovery.result.v2"
      ? parseNormalizedValueV2(claimClass, claimType, fact.normalized_value, `${path}.normalized_value`)
      : parseNormalizedValue(claimClass, claimType, fact.normalized_value, `${path}.normalized_value`),
    evidence_refs: deepFreeze(evidenceRefs),
    contradictions: deepFreeze(contradictions),
    uncertainty: deepFreeze(parseStringArray(fact.uncertainty, `${path}.uncertainty`, 20, 1_000)),
  };
  if (schemaVersion === "company_discovery.result.v1") return common;
  if (fact.confidence !== "high" && fact.confidence !== "medium" && fact.confidence !== "low") {
    fail(`${path}.confidence`, "invalid confidence");
  }
  if (fact.contradiction_status !== "none" && fact.contradiction_status !== "possible" &&
      fact.contradiction_status !== "confirmed") {
    fail(`${path}.contradiction_status`, "invalid contradiction status");
  }
  if ((fact.contradiction_status === "none") !== (contradictions.length === 0)) {
    fail(`${path}.contradiction_status`, "contradiction status does not match evidence");
  }
  if (fact.claim_schema_version !== "company_discovery.claim.v2") {
    fail(`${path}.claim_schema_version`, "company_discovery.claim.v2 required");
  }
  const missingFields = parseStringArray(fact.missing_fields, `${path}.missing_fields`, 50, 200);
  const ambiguousFields = parseStringArray(
    fact.ambiguous_fields,
    `${path}.ambiguous_fields`,
    50,
    200,
  );
  const normalized = common.normalized_value as Record<string, unknown>;
  if (claimType === "service_territory") {
    for (const collection of ["included_areas", "excluded_areas"] as const) {
      for (const [index, area] of (normalized[collection] as readonly Record<string, unknown>[]).entries()) {
        if (area.kind === "city" && area.region_state === null &&
            !ambiguousFields.includes(`${collection}[${index}].region_state`)) {
          fail(`${path}.ambiguous_fields`, "ambiguous city region must remain explicit");
        }
      }
    }
  }
  if (claimType === "business_hours") {
    for (const [field, absent] of [
      ["timezone", normalized.timezone === null],
      ["holiday_policy", normalized.holiday_policy === null],
      ["after_hours", normalized.after_hours === "not_stated"],
    ] as const) {
      if (absent && !missingFields.includes(field)) {
        fail(`${path}.missing_fields`, `${field} must remain missing`);
      }
    }
  }
  return {
    ...common,
    confidence: fact.confidence,
    contradiction_status: fact.contradiction_status,
    missing_fields: deepFreeze(missingFields),
    ambiguous_fields: deepFreeze(ambiguousFields),
    claim_schema_version: "company_discovery.claim.v2",
  };
}

export function parseWorkerResult(value: unknown): WorkerResult {
  const candidate = record(value, "result");
  exactKeys(candidate, RESULT_KEYS, "result");
  if (candidate.schema_version !== "company_discovery.result.v1" &&
      candidate.schema_version !== "company_discovery.result.v2") {
    fail("result.schema_version", "supported company discovery result required");
  }
  const snapshots = parseSourceSnapshots(candidate.source_snapshots);
  if (!Array.isArray(candidate.candidate_facts) || candidate.candidate_facts.length > 100) {
    fail("candidate_facts", "expected at most 100 items");
  }
  const schemaVersion = candidate.schema_version;
  const facts = candidate.candidate_facts.map((fact, index) =>
    parseFact(fact, index, snapshots.length, schemaVersion)
  );
  const missingQuestions = parseStringArray(candidate.missing_questions, "missing_questions", 50, 1_000);
  if (schemaVersion === "company_discovery.result.v2" && facts.length === 0 && missingQuestions.length === 0) {
    fail("missing_questions", "empty discovery must preserve owner questions");
  }
  const result: WorkerResult = {
    schema_version: schemaVersion,
    source_snapshots: snapshots,
    candidate_facts: deepFreeze(facts),
    missing_questions: deepFreeze(missingQuestions),
    contradictions: deepFreeze(parseStringArray(candidate.contradictions, "contradictions", 50, 2_000)),
    uncertainty: deepFreeze(parseStringArray(candidate.uncertainty, "uncertainty", 50, 1_000)),
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
  const normalizedOrigin = boundedString(candidate.normalized_origin, "job.normalized_origin", 9, 2_048);
  let origin: URL;
  try {
    origin = new URL(normalizedOrigin);
  } catch {
    fail("job.normalized_origin", "invalid URL");
  }
  if (origin.protocol !== "https:") fail("job.normalized_origin", "HTTPS required");
  const deadlineAt = typeof candidate.deadline_at === "string"
    ? candidate.deadline_at
    : fail("job.deadline_at", "invalid ISO-8601 timestamp");
  if (deadlineAt.length > 32 || !isStrictIsoTimestamp(deadlineAt)) {
    fail("job.deadline_at", "invalid ISO-8601 timestamp");
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
    normalized_origin: normalizedOrigin,
    deadline_at: deadlineAt,
    budget: deepFreeze(parsedBudget),
    source_snapshots: parseSourceSnapshots(candidate.source_snapshots, {
      allowEmpty: options.allowEmptyEvidence,
      budget: parsedBudget,
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
