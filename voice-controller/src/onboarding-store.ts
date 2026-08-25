import { createHash } from "node:crypto";
import {
  applyCoverageFact,
  buildSummaryAnchors,
  createCoverage,
  evaluateCoverage,
  type CoverageDisposition,
  type CoverageFact,
  type CoverageField,
  type CoverageProgress,
  type CoverageRef,
  type CoverageSnapshot,
} from "./onboarding-coverage.ts";
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
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BoundaryResult<unknown>>;
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
  | "invalid_fact";

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

export type SnapshotResult =
  | {
      ok: true;
      receiptId: string;
      revision: number;
      digest: string;
      coverage: CoverageSnapshot;
      rules: RuleSnapshot[];
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

function normalizeSubject(subject: string): string {
  return subject
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
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
  const normalizedSubject =
    typeof args.subject === "string" ? normalizeSubject(args.subject) : "";
  if (args.subject !== undefined && !normalizedSubject) return null;
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
    }
  | null {
  if (!row?.readback || typeof row.readback !== "object") return null;
  const readback = row.readback;
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
  return {
    row,
    revision,
    digest,
    complete: readback.complete,
    snapshot,
    selectedRuleIds: selectedRuleIds as string[],
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
  const ref =
    progress.nextQuestion ??
    progress.ambiguous[0] ??
    progress.missingRequired[0] ??
    ({ field: "service.catalog_closure" } as CoverageRef);
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

  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new BoundaryTimeout("onboarding_store_timeout")),
            timeoutMs,
          );
          (timer as any).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const coverageReceipts = async (
    cap: Capability,
  ): Promise<BoundaryResult<CoverageReceiptRow[]>> =>
    await client
      .from("receipts")
      .select("id,readback")
      .eq("tenant_id", cap.tenantId)
      .eq("call_id", cap.callId)
      .eq("kind", "onboarding_coverage")
      .limit(MAX_COVERAGE_RECEIPTS);

  const receiptForEvent = async (
    cap: Capability,
    eventKey: string,
  ): Promise<BoundaryResult<CoverageReceiptRow>> =>
    await client
      .from("receipts")
      .select("id,readback,detail")
      .eq("tenant_id", cap.tenantId)
      .eq("call_id", cap.callId)
      .eq("kind", "onboarding_coverage")
      .eq("external_id", eventKey)
      .limit(1)
      .maybeSingle();

  const rulesForCall = async (
    cap: Capability,
  ): Promise<BoundaryResult<RuleRow[]>> =>
    await client
      .from("rules")
      .select("id,rule_group_id,version,structured,created_at")
      .eq("tenant_id", cap.tenantId)
      .eq("related_call_id", cap.callId)
      .eq("origem", "onboarding")
      .order("created_at", { ascending: false });

  const selectedRulesForReceipt = async (
    cap: Capability,
    selectedRuleIds: string[],
  ): Promise<BoundaryResult<RuleRow[]>> => {
    if (selectedRuleIds.length === 0) return { data: [], error: null };
    return await client
      .from("rules")
      .select("id,rule_group_id,version,structured,created_at")
      .eq("tenant_id", cap.tenantId)
      .eq("related_call_id", cap.callId)
      .eq("origem", "onboarding")
      .in("id", selectedRuleIds);
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
      const receiptResult = await bounded(() => coverageReceipts(cap));
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
      const rulesResult = await bounded(() =>
        selectedRulesForReceipt(cap, parsed.selectedRuleIds)
      );
      if (rulesResult.error || !Array.isArray(rulesResult.data))
        return snapshotFailure(
          "query_error",
          "coverage rules query failed",
          now,
          started,
        );
      if (!exactSelectedRuleSet(rulesResult.data, parsed.selectedRuleIds))
        return snapshotFailure(
          "changed",
          "coverage snapshot changed",
          now,
          started,
        );
      const recheckResult = await bounded(() => coverageReceipts(cap));
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
        requiredAnchors: buildSummaryAnchors(parsed.snapshot),
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
      const eventResult = await bounded(() =>
        receiptForEvent(cap, eventKey)
      );
      if (eventResult.error)
        return failure(
          "query_error",
          "onboarding replay query failed",
          now,
          started,
        );
      const replay = eventResult.data;
      if (
        replay &&
        replay.detail &&
        canonicalJson(replay.detail.fact) === canonicalJson(persistedFact)
      ) {
        const readback = replay.readback;
        const digest = String(readback.snapshot_digest ?? "");
        const progress =
          readback.progress && typeof readback.progress === "object"
            ? (readback.progress as Record<string, unknown>)
            : {};
        return {
          ok: true,
          status: "reused",
          ruleId: String(readback.rule_id ?? ""),
          ruleGroupId: String(readback.rule_group_id ?? ""),
          coverageReceiptId: replay.id,
          revision: Number(readback.revision),
          digest,
          complete: readback.complete === true,
          missing: Array.isArray(progress.missingRequired)
            ? (progress.missingRequired as CoverageRef[])
            : [],
          ambiguous: Array.isArray(progress.ambiguous)
            ? (progress.ambiguous as CoverageRef[])
            : [],
          nextAction: authoritativeNextAction(
            readback.next_action,
            replay.id,
            digest,
          ),
          coverage: readback,
          durationMs: elapsed(now, started),
        };
      }
      const receiptResult = await bounded(() => coverageReceipts(cap));
      if (receiptResult.error)
        return failure(
          "query_error",
          "coverage snapshot query failed",
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
      const base = parsed?.snapshot ??
        createCoverage({ tenantId: cap.tenantId, callId: cap.callId });
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
      let correctionGroup: string | null = null;
      let priorRuleRows: RuleRow[] = [];
      if (parsed) {
        const rulesResult = await bounded(() => rulesForCall(cap));
        if (rulesResult.error || !Array.isArray(rulesResult.data))
          return failure(
            "query_error",
            "onboarding correction query failed",
            now,
            started,
          );
        priorRuleRows = rulesResult.data;
        correctionGroup = latestMatchingGroup(
          priorRuleRows,
          String(persistedFact.field),
          persistedFact.subject ? String(persistedFact.subject) : undefined,
        );
      }
      const fullSnapshot = jsonSafeSnapshot(next);
      const coverageProjection = {
        schema_version: 1,
        tenant_id: cap.tenantId,
        call_id: cap.callId,
        revision: next.revision,
        complete: progress.readyForReview,
        snapshot: fullSnapshot,
        progress: canonicalValue(progress),
        selected_rule_ids: correctionGroup
          ? (parsed?.selectedRuleIds ?? []).filter((id) => {
              const row = priorRuleRows.find((candidate) => candidate.id === id);
              return row?.rule_group_id !== correctionGroup;
            })
          : (parsed?.selectedRuleIds ?? []),
        next_action: nextAction(progress),
        authority: FALSE_AUTHORITY,
      };
      const answerHash = sha256(canonicalJson(persistedFact));
      const rpcResult = await bounded(() =>
        client.rpc("record_onboarding_answer", {
          p_tenant: cap.tenantId,
          p_call: cap.callId,
          p_owner: cap.ownerUserId!,
          p_provider_tool_call_id: providerToolCallId,
          p_event_key: eventKey,
          p_answer_hash: answerHash,
          p_expected_revision: base.revision,
          p_fact: persistedFact,
          p_rule_group_id: correctionGroup,
          p_coverage: coverageProjection,
        }),
      );
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
      return error instanceof BoundaryTimeout
        ? failure(
            "timeout",
            "onboarding answer persistence timed out",
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
      const receiptResult = await bounded(() => coverageReceipts(cap));
      if (receiptResult.error)
        return failure(
          "query_error",
          "coverage snapshot query failed",
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
      const rpcResult = await bounded(() =>
        client.rpc("record_onboarding_voice_approval", {
          p_tenant: cap.tenantId,
          p_call: cap.callId,
          p_owner: cap.ownerUserId!,
          p_provider_tool_call_id: providerToolCallId,
          p_event_key: eventKey,
          p_expected_revision: parsed.revision,
          p_expected_digest: parsed.digest,
          p_owner_words: ownerWords,
        }),
      );
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
      return error instanceof BoundaryTimeout
        ? failure(
            "timeout",
            "onboarding approval persistence timed out",
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
