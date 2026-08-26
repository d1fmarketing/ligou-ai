import { createHash } from "node:crypto";
import {
  applyCoverageFact,
  buildSummaryAnchors,
  coverageKey,
  createCoverage,
  evaluateCoverage,
  isCoverageField,
  isServiceCoverageField,
  normalizeCoverageSubject,
  recordDirectedFollowUp,
  type CoverageDisposition,
  type CoverageFact,
  type CoverageField,
  type CoverageProgress,
  type CoverageRef,
  type CoverageSnapshot,
} from "./onboarding-coverage.ts";
import {
  materializeCoverage,
  type CoverageSummaryProjectionV2,
  type MaterializedRuleV2,
} from "./onboarding-materialization.ts";
import type { Capability } from "./tools.ts";

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_COVERAGE_RECEIPTS = 512;
const TOPICS = new Set([
  "servicos",
  "area",
  "precos",
  "agenda",
  "emergencia",
  "outro",
]);
const DISPOSITIONS = new Set<CoverageDisposition>([
  "answered",
  "not_applicable",
  "owner_review_required",
]);
const FALSE_AUTHORITY = {
  rules_approved: false,
  powers_granted: false,
  operational_mode_changed: false,
} as const;

type BoundaryError = { code?: string; message?: string };
type BoundaryResult<T> = { data: T | null; error: BoundaryError | null };
type SupabaseBoundary = {
  from(table: string): any;
  rpc(name: string, args: Record<string, unknown>): any;
};

export interface OnboardingAnswerArgs extends Record<string, unknown> {
  topic: string;
  field: string;
  subject?: string;
  disposition: string;
  rule_text: string;
  structured?: Record<string, unknown>;
  owner_words: string;
}

export interface RuleSnapshot {
  id: string;
  ruleGroupId: string;
  version: number;
  structured: Record<string, unknown>;
}

export type StoreFailureCode =
  | "timeout"
  | "query_error"
  | "empty"
  | "coverage_incomplete"
  | "changed"
  | "not_owner_bound"
  | "invalid_fact"
  | "indeterminate";

export interface StoreFailure {
  ok: false;
  code: StoreFailureCode;
  safeDetail: string;
  durationMs: number;
}

export interface RecordedCoverageSuccess {
  ok: true;
  status: "recorded" | "reused";
  ruleId: string;
  ruleGroupId: string;
  coverageReceiptId: string;
  revision: number;
  digest: string;
  complete: boolean;
  missing: CoverageRef[];
  ambiguous: CoverageRef[];
  nextAction: Record<string, unknown>;
  coverage: Record<string, unknown>;
  durationMs: number;
}
export type RecordedCoverage = RecordedCoverageSuccess | StoreFailure;

export interface VoiceApprovalSuccess {
  ok: true;
  status: "recorded" | "reused";
  approvalReceiptId: string;
  coverageReceiptId: string;
  revision: number;
  digest: string;
  durationMs: number;
}
export type VoiceApproval = VoiceApprovalSuccess | StoreFailure;

export interface OnboardingFollowupInput {
  revision: number;
  digest: string;
  field: CoverageField;
  subject?: string;
  questionPt: string;
}

export interface FollowupSuccess {
  ok: true;
  status: "recorded" | "reused";
  coverageReceiptId: string;
  revision: number;
  digest: string;
  complete: boolean;
  missing: CoverageRef[];
  ambiguous: CoverageRef[];
  nextAction: Record<string, unknown>;
  coverage: Record<string, unknown>;
  durationMs: number;
}
export type RecordedFollowup = FollowupSuccess | StoreFailure;

export type SnapshotResult =
  | {
      ok: true;
      receiptId: string;
      revision: number;
      digest: string;
      coverage: CoverageSnapshot;
      rules: RuleSnapshot[];
      summary?: CoverageSummaryProjectionV2;
      requiredAnchors: string[];
      durationMs: number;
    }
  | {
      ok: false;
      code:
        | "timeout"
        | "query_error"
        | "empty"
        | "coverage_incomplete"
        | "changed";
      safeDetail: string;
      durationMs: number;
    };

type SnapshotFailureCode =
  | "timeout"
  | "query_error"
  | "empty"
  | "coverage_incomplete"
  | "changed";

export interface OnboardingStore {
  recordOnboardingAnswer(
    cap: Capability,
    providerToolCallId: string,
    args: OnboardingAnswerArgs,
  ): Promise<RecordedCoverage>;
  recordOnboardingFollowup(
    cap: Capability,
    input: OnboardingFollowupInput,
  ): Promise<RecordedFollowup>;
  loadOnboardingSnapshot(cap: Capability): Promise<SnapshotResult>;
  recordOnboardingVoiceApproval(
    cap: Capability,
    providerToolCallId: string,
    ownerWords: string,
  ): Promise<VoiceApproval>;
}

interface StoreDependencies {
  client: SupabaseBoundary;
  now?: () => number;
  timeoutMs?: number;
}

interface CoverageReceiptRow {
  id: string;
  readback: Record<string, unknown>;
  detail?: Record<string, unknown>;
}

interface RuleRow {
  id: string;
  rule_group_id: string;
  version: number;
  structured: Record<string, unknown> | null;
  created_at: string;
}

class BoundaryTimeout extends Error {}

function ambiguousBoundaryFailure(error: unknown): boolean {
  if (error instanceof BoundaryTimeout) return true;
  const boundary = error && typeof error === "object"
    ? error as BoundaryError
    : {};
  if (boundary.code) return false;
  return /fetch|network|timeout|timed out|abort|econn|socket/i.test(
    String(boundary.message ?? error ?? ""),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function elapsed(now: () => number, started: number): number {
  return Math.max(0, now() - started);
}

function failure(
  code: StoreFailureCode,
  safeDetail: string,
  now: () => number,
  started: number,
): StoreFailure {
  return { ok: false, code, safeDetail, durationMs: elapsed(now, started) };
}

function snapshotFailure(
  code: SnapshotFailureCode,
  safeDetail: string,
  now: () => number,
  started: number,
): SnapshotResult {
  return {
    ok: false,
    code,
    safeDetail,
    durationMs: elapsed(now, started),
  };
}

function mapBoundaryFailure(
  error: BoundaryError,
  operation: "answer" | "approval",
  now: () => number,
  started: number,
): StoreFailure {
  const message = String(error.message ?? "").toLowerCase();
  if (error.code === "40001" || message.includes("changed"))
    return failure(
      "changed",
      `onboarding ${operation} snapshot changed`,
      now,
      started,
    );
  if (message.includes("coverage_incomplete"))
    return failure(
      "coverage_incomplete",
      "coverage snapshot is incomplete",
      now,
      started,
    );
  if (error.code === "P0002" || message.includes("coverage_missing"))
    return failure(
      "empty",
      "coverage snapshot is empty",
      now,
      started,
    );
  if (error.code === "42501" || message.includes("not_owner_bound"))
    return failure(
      "not_owner_bound",
      "onboarding owner binding is unavailable",
      now,
      started,
    );
  return failure(
    "query_error",
    `onboarding ${operation} persistence failed`,
    now,
    started,
  );
}

function boundOwner(cap: Capability): boolean {
  return (
    cap.sessionType === "onboarding" &&
    typeof cap.ownerUserId === "string" &&
    cap.ownerUserId.trim().length > 0
  );
}

function cleanFact(
  args: OnboardingAnswerArgs,
): Record<string, unknown> | null {
  const topic = typeof args.topic === "string" ? args.topic : "";
  const field = typeof args.field === "string" ? args.field : "";
  const disposition =
    typeof args.disposition === "string" ? args.disposition : "";
  const ruleText = typeof args.rule_text === "string" ? args.rule_text : "";
  const ownerWords =
    typeof args.owner_words === "string" ? args.owner_words : "";
  if (
    !TOPICS.has(topic) ||
    !isCoverageField(field) ||
    !DISPOSITIONS.has(disposition as CoverageDisposition) ||
    !ruleText.trim() ||
    ruleText.length > 4_000 ||
    !ownerWords.trim() ||
    ownerWords.length > 1_000
  )
    return null;
  if (
    args.structured !== undefined &&
    (!args.structured ||
      typeof args.structured !== "object" ||
      Array.isArray(args.structured))
  )
    return null;
  if (
    args.structured &&
    (
      Object.prototype.hasOwnProperty.call(args.structured, "fields") ||
      (
        args.structured.value &&
        typeof args.structured.value === "object" &&
        !Array.isArray(args.structured.value) &&
        Object.prototype.hasOwnProperty.call(
          args.structured.value as Record<string, unknown>,
          "fields",
        )
      )
    )
  ) return null;
  let normalizedSubject: string | undefined;
  try {
    coverageKey(
      field as CoverageField,
      args.subject === undefined ? undefined : String(args.subject),
    );
    normalizedSubject = isServiceCoverageField(field as CoverageField)
      ? normalizeCoverageSubject(String(args.subject))
      : undefined;
  } catch {
    return null;
  }
  const fact: Record<string, unknown> = {
    topic,
    field,
    disposition,
    rule_text: ruleText,
    owner_words: ownerWords,
  };
  if (normalizedSubject) fact.subject = normalizedSubject;
  if (args.structured !== undefined)
    fact.structured = canonicalValue(args.structured);
  return fact;
}

function coverageValue(
  field: string,
  disposition: CoverageDisposition,
  structured: Record<string, unknown> | undefined,
  ruleText: string,
): unknown {
  if (disposition !== "answered") return null;
  if (!structured) return ruleText;
  if (Object.prototype.hasOwnProperty.call(structured, "value"))
    return structured.value;
  const leaf = field.slice(field.indexOf(".") + 1);
  if (Object.prototype.hasOwnProperty.call(structured, leaf))
    return structured[leaf];
  return structured;
}

function hydrateSnapshot(
  raw: unknown,
  cap: Capability,
): CoverageSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const snapshot = raw as Record<string, unknown>;
  if (
    snapshot.tenantId !== cap.tenantId ||
    snapshot.callId !== cap.callId ||
    !Number.isInteger(snapshot.revision) ||
    !Array.isArray(snapshot.services) ||
    !snapshot.cells ||
    typeof snapshot.cells !== "object" ||
    Array.isArray(snapshot.cells) ||
    !Number.isInteger(snapshot.followUps) ||
    !snapshot.followUpGroups ||
    typeof snapshot.followUpGroups !== "object" ||
    Array.isArray(snapshot.followUpGroups)
  )
    return null;
  return {
    ...(snapshot as unknown as CoverageSnapshot),
    summaryInvalidated: snapshot.summaryInvalidated === true,
  };
}

function parseReceipt(
  row: CoverageReceiptRow | null,
  cap: Capability,
):
  | {
      row: CoverageReceiptRow;
      revision: number;
      digest: string;
      complete: boolean;
      snapshot: CoverageSnapshot;
      selectedRuleIds: string[];
      schemaVersion: 1 | 2;
      currentAnswerHashes: Record<string, string>;
      summary: CoverageSummaryProjectionV2 | null;
    }
  | null {
  if (!row?.readback || typeof row.readback !== "object") return null;
  const readback = row.readback;
  const schemaVersion = Number(readback.schema_version);
  const revision = Number(readback.revision);
  const digest = String(readback.snapshot_digest ?? "");
  const snapshot = hydrateSnapshot(readback.snapshot, cap);
  const selectedRuleIds = Array.isArray(readback.selected_rule_ids)
    ? readback.selected_rule_ids
    : null;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    !snapshot ||
    snapshot.revision !== revision ||
    readback.tenant_id !== cap.tenantId ||
    readback.call_id !== cap.callId ||
    typeof readback.complete !== "boolean" ||
    !selectedRuleIds ||
    selectedRuleIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    ) ||
    new Set(selectedRuleIds).size !== selectedRuleIds.length
  )
    return null;
  if (schemaVersion !== 1 && schemaVersion !== 2) return null;
  let summary: CoverageSummaryProjectionV2 | null = null;
  const parsedCurrentHashes = currentAnswerHashes(readback);
  if (schemaVersion === 2) {
    if (
      !readback.current_answer_hashes ||
      typeof readback.current_answer_hashes !== "object" ||
      Array.isArray(readback.current_answer_hashes) ||
      Object.keys(readback.current_answer_hashes as Record<string, unknown>)
        .length !== Object.keys(parsedCurrentHashes).length
    ) return null;
    const progress = evaluateCoverage(snapshot);
    const expected = materializeCoverage(snapshot, progress).summary;
    const stored = readback.summary_projection ?? null;
    if (canonicalJson(stored) !== canonicalJson(expected)) return null;
    if (
      readback.complete === true &&
      (
        !expected ||
        readback.summary_hash !== expected.summaryHash ||
        progress.readyForReview !== true
      )
    ) return null;
    if (readback.complete === false && readback.summary_hash !== null)
      return null;
    summary = expected;
  }
  return {
    row,
    revision,
    digest,
    complete: readback.complete,
    snapshot,
    selectedRuleIds: selectedRuleIds as string[],
    schemaVersion,
    currentAnswerHashes: parsedCurrentHashes,
    summary,
  };
}

function latestCoverageReceipt(
  rows: CoverageReceiptRow[],
  cap: Capability,
):
  | { kind: "ok"; receipt: NonNullable<ReturnType<typeof parseReceipt>> }
  | { kind: "empty" | "changed" } {
  if (rows.length === 0) return { kind: "empty" };
  if (rows.length >= MAX_COVERAGE_RECEIPTS) return { kind: "changed" };
  const revisions = new Set<number>();
  let latestRow: CoverageReceiptRow | null = null;
  let latestRevision = -1;
  for (const row of rows) {
    const revision = Number(row?.readback?.revision);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revisions.has(revision)
    )
      return { kind: "changed" };
    revisions.add(revision);
    if (revision > latestRevision) {
      latestRevision = revision;
      latestRow = row;
    }
  }
  const parsed = parseReceipt(latestRow, cap);
  return parsed
    ? { kind: "ok", receipt: parsed }
    : { kind: "changed" };
}

function jsonSafeSnapshot(snapshot: CoverageSnapshot): CoverageSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as CoverageSnapshot;
}

function nextAction(progress: CoverageProgress): Record<string, unknown> {
  if (progress.readyForReview) return { type: "prepare_summary" };
  const ref = progress.nextQuestion;
  if (!ref)
    return {
      type: "blocked",
      reason: "follow_up_exhausted",
    };
  return {
    type: "ask",
    field: ref.field,
    ...(ref.subject ? { subject: ref.subject } : {}),
    question_pt:
      "questionPt" in ref
        ? String(ref.questionPt)
        : "A cobertura ainda precisa desta informação.",
  };
}

function materializationKeyFor(
  field: CoverageField,
  subject?: string,
): string | null {
  if (isServiceCoverageField(field))
    return `service:${normalizeCoverageSubject(subject!)}`;
  if (field === "service.catalog_closure") return null;
  if (field.startsWith("business.")) return "domain:business";
  if (field.startsWith("area.")) return "domain:area";
  if (field.startsWith("schedule.")) return "domain:schedule";
  if (field.startsWith("emergency.")) return "domain:emergency";
  if (field.startsWith("policy.")) return "domain:policy";
  if (field.startsWith("authority.")) return "domain:authority";
  return null;
}

function materializationProjection(rule: MaterializedRuleV2) {
  return {
    key: rule.key,
    category: rule.category,
    scope: rule.scope,
    state: rule.state,
    review_ready: rule.reviewReady,
    text: rule.text,
    structured: canonicalValue(rule.structured),
    source_refs: [...rule.sourceRefs],
    materialization_hash: rule.materializationHash,
  };
}

function semanticCell(cell: unknown): unknown {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return cell;
  const { attempts: _attempts, ...semantic } = cell as Record<string, unknown>;
  return canonicalValue(semantic);
}

function answerHashFor(
  snapshot: CoverageSnapshot,
  field: CoverageField,
  subject?: string,
): string {
  const key = coverageKey(field, subject);
  return sha256(canonicalJson({
    coverage_key: key,
    cell: semanticCell(snapshot.cells[key]),
  }));
}

function currentAnswerHashes(
  readback: Record<string, unknown> | undefined,
): Record<string, string> {
  const value = readback?.current_answer_hashes;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, hash]) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
      .map(([key, hash]) => [key, String(hash)]),
  );
}

function coverageProjectionV2({
  cap,
  snapshot,
  progress,
  selectedRuleIds,
  currentHashes,
  transitionKind,
  priorNextAction,
}: {
  cap: Capability;
  snapshot: CoverageSnapshot;
  progress: CoverageProgress;
  selectedRuleIds: string[];
  currentHashes: Record<string, string>;
  transitionKind: "answer" | "directed_followup";
  priorNextAction?: Record<string, unknown>;
}) {
  const materialized = materializeCoverage(snapshot, progress);
  return {
    schema_version: 2,
    transition_kind: transitionKind,
    tenant_id: cap.tenantId,
    call_id: cap.callId,
    revision: snapshot.revision,
    complete: progress.readyForReview,
    snapshot: jsonSafeSnapshot(snapshot),
    progress: canonicalValue(progress),
    selected_rule_ids: [...selectedRuleIds],
    next_action: priorNextAction ?? nextAction(progress),
    current_answer_hashes: canonicalValue(currentHashes),
    materializations: materialized.rules.map(materializationProjection),
    summary_projection: materialized.summary
      ? canonicalValue(materialized.summary)
      : null,
    summary_hash: materialized.summary?.summaryHash ?? null,
    authority: FALSE_AUTHORITY,
  };
}

function authoritativeNextAction(
  value: unknown,
  receiptId: string,
  digest: string,
): Record<string, unknown> {
  const action = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  return action.type === "prepare_summary"
    ? {
        ...action,
        snapshot_receipt_id: receiptId,
        snapshot_hash: digest,
      }
    : action;
}

function toRuleSnapshots(
  rows: RuleRow[],
  selectedRuleIds: string[],
): RuleSnapshot[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return selectedRuleIds.flatMap((id) => {
    const row = byId.get(id);
    return row
      ? [
          {
            id: row.id,
            ruleGroupId: row.rule_group_id,
            version: row.version,
            structured: row.structured ?? {},
          },
        ]
      : [];
  });
}

function exactSelectedRuleSet(
  rows: RuleRow[],
  selectedRuleIds: string[],
): boolean {
  if (rows.length !== selectedRuleIds.length) return false;
  const returnedIds = rows.map((row) => row.id);
  if (new Set(returnedIds).size !== returnedIds.length) return false;
  const requested = new Set(selectedRuleIds);
  return returnedIds.every((id) => requested.has(id));
}

function exactSelectedMaterializations(
  rows: RuleRow[],
  selectedRuleIds: string[],
  expectedRules: MaterializedRuleV2[],
): boolean {
  if (!exactSelectedRuleSet(rows, selectedRuleIds)) return false;
  const expected = new Map(
    expectedRules
      .filter((rule) => rule.reviewReady)
      .map((rule) => [rule.key, rule.materializationHash]),
  );
  if (rows.length !== expected.size) return false;
  const seen = new Set<string>();
  for (const row of rows) {
    const key = String(row.structured?.materialization_key ?? "");
    const hash = String(row.structured?.materialization_hash ?? "");
    if (
      !key || seen.has(key) || expected.get(key) !== hash ||
      row.structured?.materialization_eligible !== true ||
      row.structured?.review_ready !== true
    ) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}

function latestMatchingGroup(
  rows: RuleRow[],
  field: string,
  subject: string | undefined,
): string | null {
  const expectedSubject = subject ?? null;
  const matches = rows.filter(
    (row) =>
      row.structured?.coverage_field === field &&
      (row.structured?.coverage_subject ?? null) === expectedSubject,
  );
  matches.sort(
    (left, right) =>
      right.version - left.version ||
      right.created_at.localeCompare(left.created_at) ||
      right.id.localeCompare(left.id),
  );
  return matches[0]?.rule_group_id ?? null;
}

export function createOnboardingStore(
  dependencies: StoreDependencies,
): OnboardingStore {
  const client = dependencies.client;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("onboarding_store_timeout_invalid");

  const bounded = async <T>(
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve(operation(controller.signal)),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new BoundaryTimeout("onboarding_store_timeout"));
          }, timeoutMs);
          (timer as any).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const abortable = <T>(query: any, signal: AbortSignal): PromiseLike<T> =>
    typeof query?.abortSignal === "function"
      ? query.abortSignal(signal)
      : query;

  const coverageReceipts = async (
    cap: Capability,
    signal: AbortSignal,
  ): Promise<BoundaryResult<CoverageReceiptRow[]>> =>
    await abortable<BoundaryResult<CoverageReceiptRow[]>>(client
      .from("receipts")
      .select("id,readback")
      .eq("tenant_id", cap.tenantId)
      .eq("call_id", cap.callId)
      .eq("kind", "onboarding_coverage")
      .limit(MAX_COVERAGE_RECEIPTS), signal);

  const receiptForEvent = async (
    cap: Capability,
    eventKey: string,
    signal: AbortSignal,
  ): Promise<BoundaryResult<CoverageReceiptRow>> =>
    await abortable<BoundaryResult<CoverageReceiptRow>>(client
      .from("receipts")
      .select("id,readback,detail")
      .eq("tenant_id", cap.tenantId)
      .eq("call_id", cap.callId)
      .in("kind", ["onboarding_coverage", "onboarding_event_alias"])
      .eq("external_id", eventKey)
      .limit(1)
      .maybeSingle(), signal);

  const approvalReceiptForEvent = async (
    cap: Capability,
    eventKey: string,
    signal: AbortSignal,
  ): Promise<BoundaryResult<CoverageReceiptRow>> =>
    await abortable<BoundaryResult<CoverageReceiptRow>>(client
      .from("receipts")
      .select("id,readback,detail")
      .eq("tenant_id", cap.tenantId)
      .eq("call_id", cap.callId)
      .eq("kind", "onboarding_voice_approval")
      .eq("external_id", eventKey)
      .limit(1)
      .maybeSingle(), signal);

  const rulesForCall = async (
    cap: Capability,
    signal: AbortSignal,
  ): Promise<BoundaryResult<RuleRow[]>> =>
    await abortable<BoundaryResult<RuleRow[]>>(client
      .from("rules")
      .select("id,rule_group_id,version,structured,created_at")
      .eq("tenant_id", cap.tenantId)
      .eq("related_call_id", cap.callId)
      .eq("origem", "onboarding")
      .order("created_at", { ascending: false }), signal);

  const selectedRulesForReceipt = async (
    cap: Capability,
    selectedRuleIds: string[],
    signal: AbortSignal,
  ): Promise<BoundaryResult<RuleRow[]>> => {
    if (selectedRuleIds.length === 0) return { data: [], error: null };
    return await abortable<BoundaryResult<RuleRow[]>>(client
      .from("rules")
      .select("id,rule_group_id,version,structured,created_at")
      .eq("tenant_id", cap.tenantId)
      .eq("related_call_id", cap.callId)
      .eq("origem", "onboarding")
      .in("id", selectedRuleIds), signal);
  };

  type ReconciledMutation<T> =
    | { kind: "rpc"; result: BoundaryResult<unknown> }
    | { kind: "receipt"; value: T }
    | { kind: "mismatch" }
    | { kind: "indeterminate" };

  const mutation = async <T>({
    name,
    args,
    lookup,
    receiptValue,
  }: {
    name: string;
    args: Record<string, unknown>;
    lookup: (signal: AbortSignal) => Promise<BoundaryResult<CoverageReceiptRow>>;
    receiptValue: (row: CoverageReceiptRow) => T | null;
  }): Promise<ReconciledMutation<T>> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let ambiguous = false;
      try {
        const result = await bounded((signal) =>
          abortable<BoundaryResult<unknown>>(client.rpc(name, args), signal)
        );
        ambiguous = Boolean(
          result.error && ambiguousBoundaryFailure(result.error)
        );
        if (!ambiguous) return { kind: "rpc", result };
      } catch {
        ambiguous = true;
      }
      if (ambiguous) {
        try {
          const found = await bounded(lookup);
          if (found.error) {
            if (attempt === 1) return { kind: "indeterminate" };
            continue;
          }
          if (found.data) {
            const value = receiptValue(found.data);
            return value === null
              ? { kind: "mismatch" }
              : { kind: "receipt", value };
          }
        } catch {
          if (attempt === 1) return { kind: "indeterminate" };
        }
      }
    }
    return { kind: "indeterminate" };
  };

  const recordedFromReceipt = (
    row: CoverageReceiptRow,
    persistedFact: Record<string, unknown>,
    providerToolCallId: string,
    started: number,
  ): RecordedCoverageSuccess | null => {
    if (
      !row.detail ||
      canonicalJson(row.detail.fact) !== canonicalJson(persistedFact) ||
      (
        row.detail.provider_tool_call_id !== undefined &&
        row.detail.provider_tool_call_id !== providerToolCallId
      )
    ) return null;
    const readback = row.readback;
    const revision = Number(readback.revision);
    const digest = String(readback.snapshot_digest ?? "");
    const progress = readback.progress && typeof readback.progress === "object"
      ? readback.progress as Record<string, unknown>
      : {};
    if (
      !Number.isSafeInteger(revision) || revision < 1 ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) return null;
    return {
      ok: true,
      status: "reused",
      ruleId: String(readback.rule_id ?? ""),
      ruleGroupId: String(readback.rule_group_id ?? ""),
      coverageReceiptId: String(
        row.detail.target_receipt_id ??
          readback.alias_target_receipt_id ??
          row.id,
      ),
      revision,
      digest,
      complete: readback.complete === true,
      missing: Array.isArray(progress.missingRequired)
        ? progress.missingRequired as CoverageRef[]
        : [],
      ambiguous: Array.isArray(progress.ambiguous)
        ? progress.ambiguous as CoverageRef[]
        : [],
      nextAction: authoritativeNextAction(
        readback.next_action,
        String(
          row.detail.target_receipt_id ??
            readback.alias_target_receipt_id ??
            row.id,
        ),
        digest,
      ),
      coverage: readback,
      durationMs: elapsed(now, started),
    };
  };

  const approvalFromReceipt = (
    row: CoverageReceiptRow,
    providerToolCallId: string,
    ownerWords: string,
    started: number,
  ): VoiceApprovalSuccess | null => {
    const detail = row.detail ?? {};
    const readback = row.readback;
    if (
      detail.provider_tool_call_id !== providerToolCallId ||
      detail.owner_words !== ownerWords ||
      !/^[0-9a-f-]{36}$/.test(String(readback.snapshot_receipt_id ?? "")) ||
      !Number.isSafeInteger(Number(readback.snapshot_revision)) ||
      !/^[0-9a-f]{64}$/.test(String(readback.snapshot_digest ?? ""))
    ) return null;
    return {
      ok: true,
      status: "reused",
      approvalReceiptId: row.id,
      coverageReceiptId: String(readback.snapshot_receipt_id),
      revision: Number(readback.snapshot_revision),
      digest: String(readback.snapshot_digest),
      durationMs: elapsed(now, started),
    };
  };

  const loadOnboardingSnapshot = async (
    cap: Capability,
  ): Promise<SnapshotResult> => {
    const started = now();
    if (!boundOwner(cap))
      return snapshotFailure(
        "query_error",
        "coverage snapshot owner binding unavailable",
        now,
        started,
      );
    try {
      const receiptResult = await bounded((signal) => coverageReceipts(cap, signal));
      if (receiptResult.error)
        return snapshotFailure(
          "query_error",
          "coverage snapshot query failed",
          now,
          started,
        );
      if (!Array.isArray(receiptResult.data))
        return snapshotFailure(
          "query_error",
          "coverage snapshot query failed",
          now,
          started,
        );
      const latest = latestCoverageReceipt(receiptResult.data, cap);
      if (latest.kind === "empty")
        return snapshotFailure(
          "empty",
          "coverage snapshot is empty",
          now,
          started,
        );
      if (latest.kind === "changed")
        return snapshotFailure(
          "changed",
          "coverage snapshot changed",
          now,
          started,
        );
      const parsed = latest.receipt;
      if (!parsed.complete)
        return snapshotFailure(
          "coverage_incomplete",
          "coverage snapshot is incomplete",
          now,
          started,
        );
      const rulesResult = await bounded((signal) =>
        selectedRulesForReceipt(cap, parsed.selectedRuleIds, signal)
      );
      if (rulesResult.error || !Array.isArray(rulesResult.data))
        return snapshotFailure(
          "query_error",
          "coverage rules query failed",
          now,
          started,
        );
      const materialized = materializeCoverage(
        parsed.snapshot,
        evaluateCoverage(parsed.snapshot),
      );
      if (
        parsed.schemaVersion === 2
          ? !exactSelectedMaterializations(
              rulesResult.data,
              parsed.selectedRuleIds,
              materialized.rules,
            )
          : !exactSelectedRuleSet(rulesResult.data, parsed.selectedRuleIds)
      )
        return snapshotFailure(
          "changed",
          "coverage snapshot changed",
          now,
          started,
        );
      const recheckResult = await bounded((signal) => coverageReceipts(cap, signal));
      if (recheckResult.error || !Array.isArray(recheckResult.data))
        return snapshotFailure(
          "query_error",
          "coverage snapshot query failed",
          now,
          started,
        );
      const rechecked = latestCoverageReceipt(recheckResult.data, cap);
      if (
        rechecked.kind !== "ok" ||
        rechecked.receipt.row.id !== parsed.row.id ||
        rechecked.receipt.revision !== parsed.revision ||
        rechecked.receipt.digest !== parsed.digest
      )
        return snapshotFailure(
          "changed",
          "coverage snapshot changed",
          now,
          started,
        );
      return {
        ok: true,
        receiptId: parsed.row.id,
        revision: parsed.revision,
        digest: parsed.digest,
        coverage: parsed.snapshot,
        rules: toRuleSnapshots(rulesResult.data, parsed.selectedRuleIds),
        ...(parsed.summary ? { summary: parsed.summary } : {}),
        requiredAnchors: parsed.summary?.anchors ??
          buildSummaryAnchors(parsed.snapshot),
        durationMs: elapsed(now, started),
      };
    } catch (error) {
      return error instanceof BoundaryTimeout
        ? snapshotFailure(
            "timeout",
            "coverage snapshot query timed out",
            now,
            started,
          )
        : snapshotFailure(
            "query_error",
            "coverage snapshot query failed",
            now,
            started,
          );
    }
  };

  const recordOnboardingAnswer = async (
    cap: Capability,
    providerToolCallId: string,
    args: OnboardingAnswerArgs,
  ): Promise<RecordedCoverage> => {
    const started = now();
    if (!boundOwner(cap))
      return failure(
        "not_owner_bound",
        "onboarding owner binding is unavailable",
        now,
        started,
      );
    if (
      typeof providerToolCallId !== "string" ||
      !providerToolCallId.trim() ||
      providerToolCallId.length > 255
    )
      return failure(
        "invalid_fact",
        "provider tool call id is invalid",
        now,
        started,
      );
    const persistedFact = cleanFact(args);
    if (!persistedFact)
      return failure(
        "invalid_fact",
        "onboarding fact is invalid",
        now,
        started,
      );
    const eventKey = sha256(
      `ligou.v0_2.onboarding_answer:v1:${cap.tenantId}:${cap.callId}:${providerToolCallId}`,
    );
    try {
      const eventResult = await bounded((signal) =>
        receiptForEvent(cap, eventKey, signal)
      );
      if (eventResult.error)
        return failure(
          ambiguousBoundaryFailure(eventResult.error)
            ? "indeterminate"
            : "query_error",
          ambiguousBoundaryFailure(eventResult.error)
            ? "onboarding answer persistence is indeterminate"
            : "onboarding replay query failed",
          now,
          started,
        );
      const replay = eventResult.data
        ? recordedFromReceipt(
            eventResult.data,
            persistedFact,
            providerToolCallId,
            started,
          )
        : null;
      if (replay) return replay;
      const receiptResult = await bounded((signal) => coverageReceipts(cap, signal));
      if (receiptResult.error)
        return failure(
          ambiguousBoundaryFailure(receiptResult.error)
            ? "indeterminate"
            : "query_error",
          ambiguousBoundaryFailure(receiptResult.error)
            ? "onboarding answer persistence is indeterminate"
            : "coverage snapshot query failed",
          now,
          started,
        );
      if (!Array.isArray(receiptResult.data))
        return failure(
          "query_error",
          "coverage snapshot query failed",
          now,
          started,
        );
      const latest = latestCoverageReceipt(receiptResult.data, cap);
      if (latest.kind === "changed")
        return failure(
          "changed",
          "coverage snapshot changed",
          now,
          started,
        );
      const parsed = latest.kind === "ok" ? latest.receipt : null;
      const base = parsed?.schemaVersion === 2
        ? parsed.snapshot
        : {
            ...createCoverage({ tenantId: cap.tenantId, callId: cap.callId }),
            revision: parsed?.revision ?? 0,
          };
      const coverageFact: CoverageFact = {
        field: persistedFact.field as CoverageField,
        ...(persistedFact.subject
          ? { subject: String(persistedFact.subject) }
          : {}),
        disposition: persistedFact.disposition as CoverageDisposition,
        value: coverageValue(
          String(persistedFact.field),
          persistedFact.disposition as CoverageDisposition,
          persistedFact.structured as Record<string, unknown> | undefined,
          String(persistedFact.rule_text),
        ),
        ruleText: String(persistedFact.rule_text),
        ownerWords: String(persistedFact.owner_words),
      };
      const next = applyCoverageFact(base, coverageFact);
      if (next.revision !== base.revision + 1)
        return failure(
          "invalid_fact",
          "onboarding fact is invalid",
          now,
          started,
        );
      const progress = evaluateCoverage(next);
      const affectedKey = materializationKeyFor(
        persistedFact.field as CoverageField,
        persistedFact.subject ? String(persistedFact.subject) : undefined,
      );
      let priorRuleRows: RuleRow[] = [];
      if (parsed?.schemaVersion === 2) {
        const rulesResult = await bounded((signal) => rulesForCall(cap, signal));
        if (rulesResult.error || !Array.isArray(rulesResult.data))
          return failure(
            rulesResult.error && ambiguousBoundaryFailure(rulesResult.error)
              ? "indeterminate"
              : "query_error",
            rulesResult.error && ambiguousBoundaryFailure(rulesResult.error)
              ? "onboarding answer persistence is indeterminate"
              : "onboarding correction query failed",
            now,
            started,
          );
        priorRuleRows = rulesResult.data;
      }
      const selectedRuleIds = (
        parsed?.schemaVersion === 2 ? parsed.selectedRuleIds : []
      ).filter((id) => {
        if (!affectedKey) return true;
        const row = priorRuleRows.find((candidate) => candidate.id === id);
        return row?.structured?.materialization_key !== affectedKey;
      });
      const answerHash = answerHashFor(
        next,
        persistedFact.field as CoverageField,
        persistedFact.subject ? String(persistedFact.subject) : undefined,
      );
      const currentHashes = {
        ...(parsed?.schemaVersion === 2 ? parsed.currentAnswerHashes : {}),
        [coverageKey(
          persistedFact.field as CoverageField,
          persistedFact.subject ? String(persistedFact.subject) : undefined,
        )]: answerHash,
      };
      const coverageProjection = coverageProjectionV2({
        cap,
        snapshot: next,
        progress,
        selectedRuleIds,
        currentHashes,
        transitionKind: "answer",
      });
      const rpcArgs = {
        p_tenant: cap.tenantId,
        p_call: cap.callId,
        p_owner: cap.ownerUserId!,
        p_provider_tool_call_id: providerToolCallId,
        p_event_key: eventKey,
        p_answer_hash: answerHash,
        p_expected_revision: base.revision,
        p_fact: persistedFact,
        p_rule_group_id: null,
        p_coverage: coverageProjection,
      };
      const mutationResult = await mutation({
        name: "record_onboarding_answer",
        args: rpcArgs,
        lookup: (signal) => receiptForEvent(cap, eventKey, signal),
        receiptValue: (row) =>
          recordedFromReceipt(row, persistedFact, providerToolCallId, started),
      });
      if (mutationResult.kind === "receipt") return mutationResult.value;
      if (mutationResult.kind === "mismatch")
        return failure(
          "changed",
          "onboarding answer event payload changed",
          now,
          started,
        );
      if (mutationResult.kind === "indeterminate")
        return failure(
          "indeterminate",
          "onboarding answer persistence is indeterminate",
          now,
          started,
        );
      const rpcResult = mutationResult.result;
      if (rpcResult.error)
        return mapBoundaryFailure(rpcResult.error, "answer", now, started);
      if (!rpcResult.data || typeof rpcResult.data !== "object")
        return failure(
          "query_error",
          "onboarding answer persistence returned no receipt",
          now,
          started,
        );
      const data = rpcResult.data as Record<string, unknown>;
      return {
        ok: true,
        status: data.status === "reused" ? "reused" : "recorded",
        ruleId: String(data.rule_id ?? ""),
        ruleGroupId: String(data.rule_group_id ?? ""),
        coverageReceiptId: String(data.coverage_receipt_id ?? ""),
        revision: Number(data.revision),
        digest: String(data.snapshot_digest ?? ""),
        complete: data.complete === true,
        missing: Array.isArray(data.missing)
          ? (data.missing as CoverageRef[])
          : [],
        ambiguous: Array.isArray(data.ambiguous)
          ? (data.ambiguous as CoverageRef[])
          : [],
        nextAction: authoritativeNextAction(
          data.next_action,
          String(data.coverage_receipt_id ?? ""),
          String(data.snapshot_digest ?? ""),
        ),
        coverage:
          data.coverage && typeof data.coverage === "object"
            ? (data.coverage as Record<string, unknown>)
            : {},
        durationMs: elapsed(now, started),
      };
    } catch (error) {
      return ambiguousBoundaryFailure(error)
        ? failure(
            "indeterminate",
            "onboarding answer persistence is indeterminate",
            now,
            started,
          )
        : failure(
            "query_error",
            "onboarding answer persistence failed",
            now,
            started,
          );
    }
  };

  const recordOnboardingFollowup = async (
    cap: Capability,
    input: OnboardingFollowupInput,
  ): Promise<RecordedFollowup> => {
    const started = now();
    if (!boundOwner(cap))
      return failure(
        "not_owner_bound",
        "onboarding owner binding is unavailable",
        now,
        started,
      );
    let key: string;
    try {
      key = coverageKey(input.field, input.subject);
    } catch {
      return failure(
        "invalid_fact",
        "onboarding follow-up identity is invalid",
        now,
        started,
      );
    }
    if (
      !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      !/^[0-9a-f]{64}$/.test(input.digest) ||
      typeof input.questionPt !== "string" || !input.questionPt.trim()
    )
      return failure(
        "invalid_fact",
        "onboarding follow-up identity is invalid",
        now,
        started,
      );
    try {
      const receiptResult = await bounded((signal) => coverageReceipts(cap, signal));
      if (receiptResult.error || !Array.isArray(receiptResult.data))
        return failure(
          receiptResult.error && ambiguousBoundaryFailure(receiptResult.error)
            ? "indeterminate"
            : "query_error",
          receiptResult.error && ambiguousBoundaryFailure(receiptResult.error)
            ? "onboarding follow-up persistence is indeterminate"
            : "coverage snapshot query failed",
          now,
          started,
        );
      const latest = latestCoverageReceipt(receiptResult.data, cap);
      if (latest.kind === "empty")
        return failure("empty", "coverage snapshot is empty", now, started);
      if (latest.kind === "changed")
        return failure("changed", "coverage snapshot changed", now, started);
      const parsed = latest.receipt;
      if (
        parsed.revision !== input.revision || parsed.digest !== input.digest
      )
        return failure("changed", "coverage snapshot changed", now, started);
      if (parsed.complete)
        return failure(
          "coverage_incomplete",
          "complete coverage cannot select a follow-up",
          now,
          started,
        );
      const priorAction = parsed.row.readback.next_action;
      if (
        !priorAction || typeof priorAction !== "object" ||
        (priorAction as Record<string, unknown>).type !== "ask" ||
        (priorAction as Record<string, unknown>).field !== input.field ||
        String((priorAction as Record<string, unknown>).subject ?? "") !==
          String(input.subject ?? "") ||
        String((priorAction as Record<string, unknown>).question_pt ?? "") !==
          input.questionPt
      )
        return failure(
          "changed",
          "onboarding follow-up no longer matches the current question",
          now,
          started,
        );
      const next = recordDirectedFollowUp(parsed.snapshot, {
        field: input.field,
        ...(input.subject ? { subject: input.subject } : {}),
      });
      if (next === parsed.snapshot)
        return failure(
          "coverage_incomplete",
          "onboarding follow-up limit is exhausted",
          now,
          started,
        );
      const progress = evaluateCoverage(next);
      const coverageProjection = coverageProjectionV2({
        cap,
        snapshot: next,
        progress,
        selectedRuleIds: parsed.selectedRuleIds,
        currentHashes: parsed.currentAnswerHashes,
        transitionKind: "directed_followup",
        priorNextAction: priorAction as Record<string, unknown>,
      });
      coverageProjection.progress = canonicalValue(parsed.row.readback.progress);
      coverageProjection.complete = parsed.complete;
      coverageProjection.materializations = canonicalValue(
        parsed.row.readback.materializations ?? [],
      ) as ReturnType<typeof materializationProjection>[];
      coverageProjection.summary_projection = canonicalValue(
        parsed.row.readback.summary_projection ?? null,
      );
      coverageProjection.summary_hash = parsed.row.readback.summary_hash ?? null;
      const eventKey = sha256(
        `ligou.v0_2.onboarding_followup:v1:${cap.tenantId}:${cap.callId}:${input.revision}:${input.field}:${input.subject ?? ""}`,
      );
      const rpcArgs = {
        p_tenant: cap.tenantId,
        p_call: cap.callId,
        p_owner: cap.ownerUserId!,
        p_event_key: eventKey,
        p_expected_revision: input.revision,
        p_field: input.field,
        p_subject: input.subject ?? null,
        p_coverage: coverageProjection,
      };
      const fromReceipt = (row: CoverageReceiptRow): FollowupSuccess | null => {
        const readback = row.readback;
        const detail = row.detail ?? {};
        if (
          detail.transition_kind !== "directed_followup" ||
          detail.source_revision !== input.revision ||
          detail.field !== input.field ||
          String(detail.subject ?? "") !== String(input.subject ?? "")
        ) return null;
        const revision = Number(readback.revision);
        const digest = String(readback.snapshot_digest ?? "");
        const storedProgress = readback.progress &&
            typeof readback.progress === "object"
          ? readback.progress as Record<string, unknown>
          : {};
        if (!Number.isSafeInteger(revision) || !/^[0-9a-f]{64}$/.test(digest))
          return null;
        return {
          ok: true,
          status: "reused",
          coverageReceiptId: row.id,
          revision,
          digest,
          complete: readback.complete === true,
          missing: Array.isArray(storedProgress.missingRequired)
            ? storedProgress.missingRequired as CoverageRef[]
            : [],
          ambiguous: Array.isArray(storedProgress.ambiguous)
            ? storedProgress.ambiguous as CoverageRef[]
            : [],
          nextAction: authoritativeNextAction(
            readback.next_action,
            row.id,
            digest,
          ),
          coverage: readback,
          durationMs: elapsed(now, started),
        };
      };
      const mutationResult = await mutation({
        name: "record_onboarding_followup",
        args: rpcArgs,
        lookup: (signal) => receiptForEvent(cap, eventKey, signal),
        receiptValue: fromReceipt,
      });
      if (mutationResult.kind === "receipt") return mutationResult.value;
      if (mutationResult.kind === "mismatch")
        return failure(
          "changed",
          "onboarding follow-up event payload changed",
          now,
          started,
        );
      if (mutationResult.kind === "indeterminate")
        return failure(
          "indeterminate",
          "onboarding follow-up persistence is indeterminate",
          now,
          started,
        );
      const rpcResult = mutationResult.result;
      if (rpcResult.error)
        return mapBoundaryFailure(rpcResult.error, "answer", now, started);
      if (!rpcResult.data || typeof rpcResult.data !== "object")
        return failure(
          "query_error",
          "onboarding follow-up persistence returned no receipt",
          now,
          started,
        );
      const data = rpcResult.data as Record<string, unknown>;
      return {
        ok: true,
        status: data.status === "reused" ? "reused" : "recorded",
        coverageReceiptId: String(data.coverage_receipt_id ?? ""),
        revision: Number(data.revision),
        digest: String(data.snapshot_digest ?? ""),
        complete: data.complete === true,
        missing: Array.isArray(data.missing) ? data.missing as CoverageRef[] : [],
        ambiguous: Array.isArray(data.ambiguous)
          ? data.ambiguous as CoverageRef[]
          : [],
        nextAction: authoritativeNextAction(
          data.next_action,
          String(data.coverage_receipt_id ?? ""),
          String(data.snapshot_digest ?? ""),
        ),
        coverage: data.coverage && typeof data.coverage === "object"
          ? data.coverage as Record<string, unknown>
          : {},
        durationMs: elapsed(now, started),
      };
    } catch (error) {
      return ambiguousBoundaryFailure(error)
        ? failure(
            "indeterminate",
            "onboarding follow-up persistence is indeterminate",
            now,
            started,
          )
        : failure(
            "query_error",
            "onboarding follow-up persistence failed",
            now,
            started,
          );
    }
  };

  const recordOnboardingVoiceApproval = async (
    cap: Capability,
    providerToolCallId: string,
    ownerWords: string,
  ): Promise<VoiceApproval> => {
    const started = now();
    if (!boundOwner(cap))
      return failure(
        "not_owner_bound",
        "onboarding owner binding is unavailable",
        now,
        started,
      );
    if (
      typeof providerToolCallId !== "string" ||
      !providerToolCallId.trim() ||
      providerToolCallId.length > 255 ||
      typeof ownerWords !== "string" ||
      !ownerWords.trim() ||
      ownerWords.length > 1_000
    )
      return failure(
        "invalid_fact",
        "onboarding approval is invalid",
        now,
        started,
      );
    try {
      const receiptResult = await bounded((signal) => coverageReceipts(cap, signal));
      if (receiptResult.error)
        return failure(
          ambiguousBoundaryFailure(receiptResult.error)
            ? "indeterminate"
            : "query_error",
          ambiguousBoundaryFailure(receiptResult.error)
            ? "onboarding approval persistence is indeterminate"
            : "coverage snapshot query failed",
          now,
          started,
        );
      if (!Array.isArray(receiptResult.data))
        return failure(
          "query_error",
          "coverage snapshot query failed",
          now,
          started,
        );
      const latest = latestCoverageReceipt(receiptResult.data, cap);
      if (latest.kind === "empty")
        return failure(
          "empty",
          "coverage snapshot is empty",
          now,
          started,
        );
      if (latest.kind === "changed")
        return failure(
          "changed",
          "coverage snapshot changed",
          now,
          started,
        );
      const parsed = latest.receipt;
      if (!parsed.complete)
        return failure(
          "coverage_incomplete",
          "coverage snapshot is incomplete",
          now,
          started,
        );
      const eventKey = sha256(
        `ligou.v0_2.onboarding_voice_approval:v1:${cap.tenantId}:${cap.callId}:${providerToolCallId}`,
      );
      const rpcArgs = {
        p_tenant: cap.tenantId,
        p_call: cap.callId,
        p_owner: cap.ownerUserId!,
        p_provider_tool_call_id: providerToolCallId,
        p_event_key: eventKey,
        p_expected_revision: parsed.revision,
        p_expected_digest: parsed.digest,
        p_owner_words: ownerWords,
      };
      const mutationResult = await mutation({
        name: "record_onboarding_voice_approval",
        args: rpcArgs,
        lookup: (signal) => approvalReceiptForEvent(cap, eventKey, signal),
        receiptValue: (row) =>
          approvalFromReceipt(row, providerToolCallId, ownerWords, started),
      });
      if (mutationResult.kind === "receipt") return mutationResult.value;
      if (mutationResult.kind === "mismatch")
        return failure(
          "changed",
          "onboarding approval event payload changed",
          now,
          started,
        );
      if (mutationResult.kind === "indeterminate")
        return failure(
          "indeterminate",
          "onboarding approval persistence is indeterminate",
          now,
          started,
        );
      const rpcResult = mutationResult.result;
      if (rpcResult.error)
        return mapBoundaryFailure(rpcResult.error, "approval", now, started);
      if (!rpcResult.data || typeof rpcResult.data !== "object")
        return failure(
          "query_error",
          "onboarding approval persistence returned no receipt",
          now,
          started,
        );
      const data = rpcResult.data as Record<string, unknown>;
      return {
        ok: true,
        status: data.status === "reused" ? "reused" : "recorded",
        approvalReceiptId: String(data.approval_receipt_id ?? ""),
        coverageReceiptId: String(data.coverage_receipt_id ?? ""),
        revision: Number(data.revision),
        digest: String(data.snapshot_digest ?? ""),
        durationMs: elapsed(now, started),
      };
    } catch (error) {
      return ambiguousBoundaryFailure(error)
        ? failure(
            "indeterminate",
            "onboarding approval persistence is indeterminate",
            now,
            started,
          )
        : failure(
            "query_error",
            "onboarding approval persistence failed",
            now,
            started,
          );
    }
  };

  return {
    recordOnboardingAnswer,
    recordOnboardingFollowup,
    loadOnboardingSnapshot,
    recordOnboardingVoiceApproval,
  };
}

async function defaultStore(): Promise<OnboardingStore> {
  const { supa } = await import("./rules.ts");
  return createOnboardingStore({ client: supa() as unknown as SupabaseBoundary });
}

export async function recordOnboardingAnswer(
  cap: Capability,
  providerToolCallId: string,
  args: OnboardingAnswerArgs,
): Promise<RecordedCoverage> {
  return await (await defaultStore()).recordOnboardingAnswer(
    cap,
    providerToolCallId,
    args,
  );
}

export async function loadOnboardingSnapshot(
  cap: Capability,
): Promise<SnapshotResult> {
  return await (await defaultStore()).loadOnboardingSnapshot(cap);
}

export async function recordOnboardingFollowup(
  cap: Capability,
  input: OnboardingFollowupInput,
): Promise<RecordedFollowup> {
  return await (await defaultStore()).recordOnboardingFollowup(cap, input);
}

export async function recordOnboardingVoiceApproval(
  cap: Capability,
  providerToolCallId: string,
  ownerWords: string,
): Promise<VoiceApproval> {
  return await (await defaultStore()).recordOnboardingVoiceApproval(
    cap,
    providerToolCallId,
    ownerWords,
  );
}
