import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  applyCoverageFact,
  createCoverage,
  evaluateCoverage,
  type CoverageField,
  type CoverageSnapshot,
} from "../src/onboarding-coverage.ts";
import { materializeCoverage } from "../src/onboarding-materialization.ts";
import { createOnboardingStore } from "../src/onboarding-store.ts";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

type QueryError = { code?: string; message: string };
type ReceiptRow = {
  id: string;
  readback: Record<string, unknown>;
  detail?: Record<string, unknown>;
};
type RuleRow = {
  id: string;
  rule_group_id: string;
  version: number;
  structured: Record<string, unknown>;
  created_at: string;
};

function emptySnapshot(revision = 0) {
  return {
    tenantId: TENANT_ID,
    callId: CALL_ID,
    revision,
    services: [],
    cells: {},
    followUps: 0,
    followUpGroups: {},
    summaryInvalidated: false,
  };
}

function receipt(
  overrides: Partial<Record<string, unknown>> = {},
): ReceiptRow {
  const snapshot = emptySnapshot(1);
  return {
    id: "44444444-4444-4444-8444-444444444444",
    readback: {
      schema_version: 1,
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      revision: 1,
      complete: true,
      snapshot,
      progress: { missingRequired: [], ambiguous: [] },
      selected_rule_ids: ["55555555-5555-4555-8555-555555555555"],
      next_action: { type: "prepare_summary" },
      snapshot_digest: "a".repeat(64),
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
      ...overrides,
    },
  };
}

class SupabaseBoundaryFake {
  receiptRows: ReceiptRow[] = [];
  receiptReadSequences: ReceiptRow[][] = [];
  receiptSetReads = 0;
  eventReceiptRows = new Map<string, ReceiptRow>();
  receiptError: QueryError | null = null;
  ruleRows: RuleRow[] = [];
  ruleError: QueryError | null = null;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  rpcResult: { data: unknown; error: QueryError | null } = {
    data: null,
    error: null,
  };
  rpcResults: Array<{ data: unknown; error: QueryError | null }> = [];
  rpcNeverResolves = false;
  rpcCommitReceipt: ReceiptRow | null = null;
  rpcAbortSignals: AbortSignal[] = [];
  receiptNeverResolves = false;
  ignoreRuleInFilter = false;

  client() {
    const boundary = this;
    return {
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        let selected = "";
        let limitValue: number | undefined;
        const query: any = {
          select(columns: string) {
            selected = columns;
            return query;
          },
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return query;
          },
          in(column: string, values: unknown[]) {
            filters.push([`${column}:in`, values]);
            return query;
          },
          order() {
            return query;
          },
          limit(value: number) {
            limitValue = value;
            return query;
          },
          maybeSingle() {
            if (table !== "receipts") {
              return Promise.resolve({
                data: null,
                error: { message: `unexpected maybeSingle ${table}` },
              });
            }
            if (boundary.receiptNeverResolves) return new Promise(() => {});
            const eventKey = filters.find(
              ([column]) => column === "external_id",
            )?.[1];
            return Promise.resolve({
              data:
                (typeof eventKey === "string"
                  ? boundary.eventReceiptRows.get(eventKey)
                  : boundary.receiptRows[0]) ?? null,
              error: boundary.receiptError,
            });
          },
          then(resolve: (result: unknown) => unknown) {
            if (table === "receipts") {
              if (boundary.receiptNeverResolves) return new Promise(() => {});
              const rows = boundary.receiptReadSequences.length > 0
                ? boundary.receiptReadSequences[
                    Math.min(
                      boundary.receiptSetReads,
                      boundary.receiptReadSequences.length - 1,
                    )
                  ]!
                : boundary.receiptRows;
              boundary.receiptSetReads += 1;
              return Promise.resolve({
                data: rows.slice(0, limitValue),
                error: boundary.receiptError,
              }).then(resolve);
            }
            if (table !== "rules") {
              return Promise.resolve({
                data: null,
                error: { message: `unexpected query ${table}` },
              }).then(resolve);
            }
            expect(selected).toBe(
              "id,rule_group_id,version,structured,created_at",
            );
            expect(filters).toContainEqual(["tenant_id", TENANT_ID]);
            expect(filters).toContainEqual(["related_call_id", CALL_ID]);
            expect(filters).toContainEqual(["origem", "onboarding"]);
            const requestedIds = filters.find(
              ([column]) => column === "id:in",
            )?.[1];
            const rows =
              Array.isArray(requestedIds) && !boundary.ignoreRuleInFilter
                ? boundary.ruleRows.filter((row) =>
                    requestedIds.includes(row.id)
                  )
                : boundary.ruleRows;
            return Promise.resolve({
              data: rows,
              error: boundary.ruleError,
            }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string, args: Record<string, unknown>) {
        boundary.rpcCalls.push({ name, args });
        if (boundary.rpcCommitReceipt) {
          const eventKey = String(args.p_event_key ?? "");
          boundary.eventReceiptRows.set(eventKey, boundary.rpcCommitReceipt);
        }
        let signal: AbortSignal | undefined;
        const result = boundary.rpcResults.length > 0
          ? boundary.rpcResults.shift()!
          : boundary.rpcResult;
        const operation: any = {
          abortSignal(nextSignal: AbortSignal) {
            signal = nextSignal;
            boundary.rpcAbortSignals.push(nextSignal);
            return operation;
          },
          then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
            if (boundary.rpcNeverResolves)
              return new Promise(() => {}).then(resolve, reject);
            if (signal?.aborted)
              return Promise.reject(new Error("aborted")).then(resolve, reject);
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return operation;
      },
    };
  }
}

function ownerCapability() {
  return {
    actor: "CALLER" as const,
    tenantSlug: "ligou-test",
    tenantId: TENANT_ID,
    callId: CALL_ID,
    ownerUserId: OWNER_ID,
    sessionType: "onboarding" as const,
    jti: "test-jti",
    expiresAt: Date.now() + 60_000,
    allowedTools: [
      "get_business_info",
      "record_interview_answer",
      "approve_onboarding_summary",
      "end_session",
    ],
    authEpoch: 1,
    policyEpoch: 1,
    simulation: true,
  };
}

const AREA_FACT = {
  topic: "area",
  field: "area.coverage",
  disposition: "answered",
  rule_text: "Serve Anaheim and Irvine.",
  structured: { value: ["Anaheim", "Irvine"] },
  owner_words: "Atendemos Anaheim e Irvine.",
};

const UNIVERSAL_FIELDS: CoverageField[] = [
  "business.customer_types", "business.excluded_work",
  "business.languages_tone", "area.coverage", "area.out_of_area_policy",
  "area.travel_fee", "schedule.business_hours", "schedule.same_day_lead_time",
  "schedule.capacity_buffer", "schedule.reschedule_cancel", "schedule.holidays",
  "emergency.types", "emergency.safety_escalation", "emergency.after_hours",
  "emergency.fee_authority", "policy.payment_estimate",
  "policy.warranty_materials", "policy.access_cancellation",
  "policy.complaints_returns", "authority.quote_price",
  "authority.negotiate_floor", "authority.read_calendar", "authority.book",
  "authority.reschedule_cancel", "authority.charge_fee",
  "authority.emergency", "authority.out_of_area",
];

function completeV2Snapshot(): CoverageSnapshot {
  let snapshot = createCoverage({ tenantId: TENANT_ID, callId: CALL_ID });
  snapshot = applyCoverageFact(snapshot, {
    field: "service.catalog_closure",
    disposition: "answered",
    value: true,
    ownerWords: "Não há outros serviços.",
  });
  for (const field of UNIVERSAL_FIELDS)
    snapshot = applyCoverageFact(snapshot, {
      field,
      disposition: "owner_review_required",
      value: null,
      ownerWords: "Preciso revisar isso depois.",
    });
  expect(evaluateCoverage(snapshot).readyForReview).toBe(true);
  return snapshot;
}

describe("recordOnboardingAnswer", () => {
  test("sends the exact first-revision RPC shape with controller-derived hashes and pure-engine coverage", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.rpcResult = {
      data: {
        status: "recorded",
        rule_id: "rule-authoritative",
        rule_group_id: "group-authoritative",
        coverage_receipt_id: "receipt-authoritative",
        revision: 41,
        snapshot_digest: "b".repeat(64),
        complete: false,
        missing: [{ field: "service.catalog_closure" }],
        ambiguous: [],
        next_action: {
          type: "ask",
          field: "service.catalog_closure",
          question_pt: "Há mais algum serviço?",
        },
        coverage: { snapshot: emptySnapshot(41) },
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 10,
      timeoutMs: 100,
    });

    const result = await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-call-7",
      AREA_FACT,
    );

    expect(result).toMatchObject({
      ok: true,
      status: "recorded",
      ruleId: "rule-authoritative",
      coverageReceiptId: "receipt-authoritative",
      revision: 41,
      digest: "b".repeat(64),
    });
    expect(fake.rpcCalls).toHaveLength(1);
    const [{ name, args }] = fake.rpcCalls;
    expect(name).toBe("record_onboarding_answer");
    expect(Object.keys(args).sort()).toEqual([
      "p_answer_hash",
      "p_call",
      "p_coverage",
      "p_event_key",
      "p_expected_revision",
      "p_fact",
      "p_owner",
      "p_provider_tool_call_id",
      "p_rule_group_id",
      "p_tenant",
    ]);
    expect(args).toMatchObject({
      p_tenant: TENANT_ID,
      p_call: CALL_ID,
      p_owner: OWNER_ID,
      p_provider_tool_call_id: "provider-call-7",
      p_event_key:
        "a40d8aa6433a3670a0ed179cd1a279c79369fc5c3d62722406095c747fd70fca",
      p_answer_hash:
        "80a3fab6a38ce442e5372ee37aa0aa7f4384723f42b72305730ecf766908a4a0",
      p_expected_revision: 0,
      p_rule_group_id: null,
      p_fact: AREA_FACT,
    });
    expect(args.p_coverage).toMatchObject({
      schema_version: 2,
      transition_kind: "answer",
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      revision: 1,
      complete: false,
      selected_rule_ids: [],
      current_answer_hashes: {
        "area.coverage":
          "80a3fab6a38ce442e5372ee37aa0aa7f4384723f42b72305730ecf766908a4a0",
      },
      summary_projection: null,
      summary_hash: null,
      snapshot: {
        tenantId: TENANT_ID,
        callId: CALL_ID,
        revision: 1,
        services: [],
        cells: {
          "area.coverage": {
            state: "answered",
            attempts: 1,
            value: ["Anaheim", "Irvine"],
          },
        },
      },
      progress: {
        ambiguous: [],
      },
      next_action: {
        type: "ask",
        field: "service.catalog_closure",
      },
      authority: {
        rules_approved: false,
        powers_granted: false,
        operational_mode_changed: false,
      },
    });
    expect((args.p_coverage as any).materializations).toContainEqual(
      expect.objectContaining({
        key: "domain:area",
        category: "area",
        scope: "localizacao",
        state: "incomplete",
        review_ready: false,
        structured: expect.objectContaining({
          schema: "ligou.rule.area.v2",
          materialization_key: "domain:area",
          materialization_eligible: false,
        }),
      }),
    );
  });

  test("removes the affected composite from selected IDs without accepting caller-authored group authority", async () => {
    const fake = new SupabaseBoundaryFake();
    const prior = receipt({
      complete: false,
      snapshot: {
        ...emptySnapshot(1),
        cells: {
          "area.coverage": {
            state: "answered",
            attempts: 1,
            value: ["Anaheim"],
          },
        },
      },
      progress: {
        missingRequired: [{ field: "service.catalog_closure" }],
        ambiguous: [],
      },
      selected_rule_ids: ["latest"],
    });
    fake.receiptRows = [prior];
    fake.ruleRows = [
      {
        id: "oldest",
        rule_group_id: "wrong-old-group",
        version: 1,
        structured: {
          coverage_field: "area.coverage",
          coverage_subject: null,
          materialization_key: "domain:area",
        },
        created_at: "2026-08-25T01:00:00.000Z",
      },
      {
        id: "latest",
        rule_group_id: "correct-latest-group",
        version: 2,
        structured: {
          coverage_field: "area.coverage",
          coverage_subject: null,
          materialization_key: "domain:area",
        },
        created_at: "2026-08-25T02:00:00.000Z",
      },
      {
        id: "other-field",
        rule_group_id: "wrong-other-group",
        version: 9,
        structured: {
          coverage_field: "area.travel_fee",
          coverage_subject: null,
        },
        created_at: "2026-08-25T03:00:00.000Z",
      },
    ];
    fake.rpcResult = {
      data: {
        status: "recorded",
        rule_id: "corrected-rule",
        rule_group_id: "correct-latest-group",
        coverage_receipt_id: "corrected-receipt",
        revision: 2,
        snapshot_digest: "c".repeat(64),
        complete: false,
        missing: [],
        ambiguous: [],
        next_action: { type: "ask", field: "service.catalog_closure" },
        coverage: {},
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 20,
      timeoutMs: 100,
    });

    await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-correction",
      { ...AREA_FACT, structured: { value: ["Anaheim", "Irvine"] } },
    );

    expect(fake.rpcCalls[0]?.args).toMatchObject({
      p_expected_revision: 1,
      p_rule_group_id: null,
      p_coverage: {
        schema_version: 2,
        revision: 2,
        selected_rule_ids: [],
      },
    });
  });

  test("rebases the first V2 answer after a V1 receipt without retaining raw facts or selected rule IDs", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptRows = [receipt({
      revision: 7,
      complete: true,
      snapshot: {
        ...emptySnapshot(7),
        cells: {
          "business.languages_tone": {
            state: "answered",
            attempts: 1,
            value: "legacy raw model fact",
          },
        },
      },
      selected_rule_ids: ["raw-v1-rule"],
      snapshot_digest: "7".repeat(64),
    })];
    fake.rpcResult = {
      data: {
        status: "recorded",
        rule_id: null,
        rule_group_id: null,
        coverage_receipt_id: "v2-rebased-receipt",
        revision: 8,
        snapshot_digest: "8".repeat(64),
        complete: false,
        missing: [{ field: "service.catalog_closure" }],
        ambiguous: [],
        next_action: {
          type: "ask",
          field: "service.catalog_closure",
          question_pt: "Quais serviços sua empresa oferece?",
        },
        coverage: {},
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 20,
      timeoutMs: 100,
    });

    expect(await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-v1-to-v2",
      AREA_FACT,
    )).toMatchObject({ ok: true, revision: 8 });
    expect(fake.rpcCalls[0]?.args).toMatchObject({
      p_expected_revision: 7,
      p_rule_group_id: null,
      p_coverage: {
        schema_version: 2,
        revision: 8,
        selected_rule_ids: [],
        snapshot: {
          revision: 8,
          cells: {
            "area.coverage": {
              state: "answered",
              value: ["Anaheim", "Irvine"],
            },
          },
        },
      },
    });
    expect((fake.rpcCalls[0]!.args.p_coverage as any).snapshot.cells)
      .not.toHaveProperty("business.languages_tone");
    expect(JSON.stringify(fake.rpcCalls[0]!.args.p_coverage))
      .not.toContain("raw-v1-rule");
  });

  test("selects the numeric maximum coverage revision even when its created_at is earlier", async () => {
    const fake = new SupabaseBoundaryFake();
    const revisionOne = receipt({
      revision: 1,
      snapshot: emptySnapshot(1),
      complete: false,
      selected_rule_ids: [],
      snapshot_digest: "1".repeat(64),
    });
    const revisionTwo: ReceiptRow = {
      id: "44444444-4444-4444-8444-444444444446",
      readback: {
        ...revisionOne.readback,
        revision: 2,
        snapshot: emptySnapshot(2),
        snapshot_digest: "2".repeat(64),
      },
    };
    // The stale row is first, exactly as a created_at DESC query can return it
    // when revision N+1 committed with an earlier caller-supplied timestamp.
    fake.receiptRows = [revisionOne, revisionTwo];
    fake.ruleRows = [];
    fake.rpcResult = {
      data: {
        status: "recorded",
        rule_id: "r-3",
        rule_group_id: "g-3",
        coverage_receipt_id: "coverage-3",
        revision: 3,
        snapshot_digest: "3".repeat(64),
        complete: false,
        missing: [],
        ambiguous: [],
        next_action: { type: "ask", field: "service.catalog_closure" },
        coverage: {},
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 25,
      timeoutMs: 100,
    });

    await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-after-stale-order",
      AREA_FACT,
    );

    expect(fake.rpcCalls[0]?.args).toMatchObject({
      p_expected_revision: 2,
      p_coverage: { revision: 3, snapshot: { revision: 3 } },
    });
  });

  test("persists the full JSON-safe snapshot without dropping flags or sorting service discovery order", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptRows = [
      receipt({
        schema_version: 2,
        transition_kind: "answer",
        complete: false,
        selected_rule_ids: [],
        current_answer_hashes: {},
        materializations: [],
        summary_projection: null,
        summary_hash: null,
        snapshot: {
          ...emptySnapshot(1),
          services: ["z_service", "a_service"],
          currentSubject: "z_service",
          summaryInvalidated: true,
          catalogOverflow: {
            services: ["overflow_z", "overflow_a"],
            safeRestriction: "Owner review only.",
            ownerWords: "Revisar depois.",
          },
        },
      }),
    ];
    fake.ruleRows = [];
    fake.rpcResult = {
      data: {
        status: "recorded",
        rule_id: "round-trip-rule",
        rule_group_id: "round-trip-group",
        coverage_receipt_id: "round-trip-receipt",
        revision: 2,
        snapshot_digest: "4".repeat(64),
        complete: false,
        missing: [],
        ambiguous: [],
        next_action: { type: "ask", field: "service.catalog_closure" },
        coverage: {},
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 27,
      timeoutMs: 100,
    });

    await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-full-snapshot",
      AREA_FACT,
    );

    const snapshot = (fake.rpcCalls[0]?.args.p_coverage as any).snapshot;
    expect(snapshot.services).toEqual(["z_service", "a_service"]);
    expect(snapshot.summaryInvalidated).toBe(true);
    expect(snapshot.currentSubject).toBe("z_service");
    expect(snapshot.catalogOverflow).toEqual({
      services: ["overflow_z", "overflow_a"],
      safeRestriction: "Owner review only.",
      ownerWords: "Revisar depois.",
    });
  });

  test("returns an exact durable replay without synthesizing receipt identity", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.eventReceiptRows.set(
      "9959612c6aff4a97ca3683917b08240bb7c4f99069d8cbfd95674f9665edc891",
      {
        id: "durable-receipt",
        detail: { fact: AREA_FACT },
        readback: {
          tenant_id: TENANT_ID,
          call_id: CALL_ID,
          status: "recorded",
          rule_id: "durable-rule",
          rule_group_id: "durable-group",
          revision: 7,
          snapshot_digest: "d".repeat(64),
          complete: true,
          progress: { missingRequired: [], ambiguous: [] },
          next_action: { type: "prepare_summary" },
          snapshot: emptySnapshot(7),
          selected_rule_ids: ["durable-rule"],
        },
      },
    );
    fake.rpcResult = {
      data: {
        status: "reused",
        rule_id: "durable-rule",
        rule_group_id: "durable-group",
        coverage_receipt_id: "durable-receipt",
        revision: 7,
        snapshot_digest: "d".repeat(64),
        complete: true,
        missing: [],
        ambiguous: [],
        next_action: { type: "prepare_summary" },
        coverage: { server: "authoritative" },
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 30,
      timeoutMs: 100,
    });

    const result = await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-replay",
      AREA_FACT,
    );

    expect(result).toEqual({
      ok: true,
      status: "reused",
      ruleId: "durable-rule",
      ruleGroupId: "durable-group",
      coverageReceiptId: "durable-receipt",
      revision: 7,
      digest: "d".repeat(64),
      complete: true,
      missing: [],
      ambiguous: [],
      nextAction: {
        type: "prepare_summary",
        snapshot_receipt_id: "durable-receipt",
        snapshot_hash: "d".repeat(64),
      },
      coverage: {
        tenant_id: TENANT_ID,
        call_id: CALL_ID,
        status: "recorded",
        rule_id: "durable-rule",
        rule_group_id: "durable-group",
        revision: 7,
        snapshot_digest: "d".repeat(64),
        complete: true,
        progress: { missingRequired: [], ambiguous: [] },
        next_action: { type: "prepare_summary" },
        snapshot: emptySnapshot(7),
        selected_rule_ids: ["durable-rule"],
      },
      durationMs: 0,
    });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  test("fails closed before querying when the owner/session binding or fact is invalid", async () => {
    const fake = new SupabaseBoundaryFake();
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 40,
      timeoutMs: 100,
    });
    const unbound = { ...ownerCapability(), ownerUserId: undefined };

    expect(
      await store.recordOnboardingAnswer(
        unbound,
        "provider-unbound",
        AREA_FACT,
      ),
    ).toMatchObject({ ok: false, code: "not_owner_bound" });
    expect(
      await store.recordOnboardingAnswer(
        ownerCapability(),
        "provider-invalid",
        {
          ...AREA_FACT,
          field: "service.price_target",
          subject: undefined,
        },
      ),
    ).toMatchObject({ ok: false, code: "invalid_fact" });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  test("rejects every subject on non-service fields before any receipt or RPC boundary", async () => {
    const fake = new SupabaseBoundaryFake();
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 10,
      timeoutMs: 100,
    });

    expect(await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-global-subject",
      { ...AREA_FACT, subject: "global-copy" },
    )).toEqual({
      ok: false,
      code: "invalid_fact",
      safeDetail: "onboarding fact is invalid",
      durationMs: 0,
    });
    expect(fake.receiptSetReads).toBe(0);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  test("rejects legacy bundled fields before one provider event can mutate multiple coverage keys", async () => {
    const fake = new SupabaseBoundaryFake();
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 10,
      timeoutMs: 100,
    });
    expect(await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-bundled-fields",
      {
        ...AREA_FACT,
        structured: {
          value: {
            fields: {
              "area.coverage": ["Irvine"],
              "area.out_of_area_policy": "owner_review",
            },
          },
        },
      },
    )).toMatchObject({ ok: false, code: "invalid_fact" });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  test("reconciles a committed answer after client timeout without a second rule or orphaned revision", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.rpcNeverResolves = true;
    fake.rpcCommitReceipt = {
      id: "late-commit-receipt",
      detail: {
        fact: AREA_FACT,
        answer_hash:
          "8185a9352a4e9250a7de1b622aabd5eadf8b2231d1561978a42f34afe38b3a36",
        provider_tool_call_id: "provider-late-commit",
      },
      readback: {
        ...receipt({ selected_rule_ids: [] }).readback,
        rule_id: "late-rule",
        rule_group_id: "late-group",
        revision: 1,
        complete: false,
        snapshot: {
          ...emptySnapshot(1),
          cells: {
            "area.coverage": {
              state: "answered",
              attempts: 1,
              value: ["Anaheim", "Irvine"],
            },
          },
        },
        progress: {
          missingRequired: [{ field: "service.catalog_closure" }],
          ambiguous: [],
        },
        next_action: {
          type: "ask",
          field: "service.catalog_closure",
          question_pt: "Quais serviços sua empresa oferece?",
        },
        snapshot_digest: "d".repeat(64),
      },
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: (() => {
        let value = 0;
        return () => value++;
      })(),
      timeoutMs: 5,
    });

    const result = await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-late-commit",
      AREA_FACT,
    );

    expect(result).toMatchObject({
      ok: true,
      status: "reused",
      ruleId: "late-rule",
      ruleGroupId: "late-group",
      coverageReceiptId: "late-commit-receipt",
      revision: 1,
      digest: "d".repeat(64),
    });
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcAbortSignals).toHaveLength(1);
    expect(fake.rpcAbortSignals[0]?.aborted).toBe(true);
  });

  test("treats a fetch transport error as ambiguous and reconciles its exact committed event", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.rpcResults = [{
      data: null,
      error: { message: "TypeError: fetch failed" },
    }];
    fake.rpcCommitReceipt = {
      id: "transport-commit-receipt",
      detail: {
        fact: AREA_FACT,
        provider_tool_call_id: "provider-transport-commit",
      },
      readback: {
        ...receipt({ selected_rule_ids: [] }).readback,
        rule_id: "transport-rule",
        rule_group_id: "transport-group",
        revision: 1,
        complete: false,
        progress: {
          missingRequired: [{ field: "service.catalog_closure" }],
          ambiguous: [],
        },
        next_action: {
          type: "ask",
          field: "service.catalog_closure",
          question_pt: "Quais serviços sua empresa oferece?",
        },
        snapshot_digest: "f".repeat(64),
      },
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 50,
      timeoutMs: 100,
    });

    expect(await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-transport-commit",
      AREA_FACT,
    )).toMatchObject({
      ok: true,
      status: "reused",
      coverageReceiptId: "transport-commit-receipt",
      ruleId: "transport-rule",
      revision: 1,
      digest: "f".repeat(64),
    });
    expect(fake.rpcCalls).toHaveLength(1);
  });

  test("two ambiguous mutation attempts stay indeterminate instead of becoming a definitive block", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.rpcResults = [
      { data: null, error: { message: "fetch failed" } },
      { data: null, error: { message: "network socket closed" } },
    ];
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 60,
      timeoutMs: 100,
    });

    expect(await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-double-ambiguous",
      AREA_FACT,
    )).toEqual({
      ok: false,
      code: "indeterminate",
      safeDetail: "onboarding answer persistence is indeterminate",
      durationMs: 0,
    });
    expect(fake.rpcCalls).toHaveLength(2);
  });

  test("a transient preflight receipt timeout is indeterminate and never invokes a new mutation", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptNeverResolves = true;
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 70,
      timeoutMs: 5,
    });
    expect(await store.recordOnboardingAnswer(
      ownerCapability(),
      "provider-preflight-timeout",
      AREA_FACT,
    )).toMatchObject({
      ok: false,
      code: "indeterminate",
      safeDetail: "onboarding answer persistence is indeterminate",
    });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  test("does not forward capability secrets, transcripts, or model-supplied authority fields", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.rpcResult = {
      data: {
        status: "recorded",
        rule_id: "r",
        rule_group_id: "g",
        coverage_receipt_id: "c",
        revision: 1,
        snapshot_digest: "e".repeat(64),
        complete: false,
        missing: [],
        ambiguous: [],
        next_action: { type: "ask", field: "service.catalog_closure" },
        coverage: {},
      },
      error: null,
    };
    const cap = {
      ...ownerCapability(),
      serviceRoleSecret: "DO-NOT-FORWARD-SECRET",
      fullTranscript: "DO-NOT-FORWARD-TRANSCRIPT",
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 50,
      timeoutMs: 100,
    });

    await store.recordOnboardingAnswer(cap, "provider-sanitized", {
      ...AREA_FACT,
      event_key: "model-authored-event-key",
      snapshot_digest: "model-authored-digest",
      full_transcript: "model-authored-transcript",
    });

    const serialized = JSON.stringify(fake.rpcCalls[0]);
    expect(serialized).not.toContain("DO-NOT-FORWARD-SECRET");
    expect(serialized).not.toContain("DO-NOT-FORWARD-TRANSCRIPT");
    expect(serialized).not.toContain("model-authored-event-key");
    expect(serialized).not.toContain("model-authored-digest");
    expect(serialized).not.toContain("model-authored-transcript");
  });
});

describe("recordOnboardingFollowup", () => {
  test("persists the exact selected question as a counter-only revision before it can be spoken", async () => {
    const fake = new SupabaseBoundaryFake();
    const prior = receipt({
      complete: false,
      selected_rule_ids: [],
      snapshot: emptySnapshot(1),
      progress: {
        missingRequired: [{ field: "area.coverage" }],
        ambiguous: [],
      },
      next_action: {
        type: "ask",
        field: "area.coverage",
        question_pt: "Quais cidades vocês atendem?",
      },
    });
    fake.receiptRows = [prior];
    fake.rpcResult = {
      data: {
        status: "recorded",
        coverage_receipt_id: "followup-receipt-2",
        revision: 2,
        snapshot_digest: "e".repeat(64),
        complete: false,
        missing: [{ field: "area.coverage" }],
        ambiguous: [],
        next_action: prior.readback.next_action,
        coverage: {},
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 30,
      timeoutMs: 100,
    });

    const result = await store.recordOnboardingFollowup(
      ownerCapability(),
      {
        revision: 1,
        digest: "a".repeat(64),
        field: "area.coverage",
        questionPt: "Quais cidades vocês atendem?",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "recorded",
      coverageReceiptId: "followup-receipt-2",
      revision: 2,
      digest: "e".repeat(64),
    });
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]).toMatchObject({
      name: "record_onboarding_followup",
      args: {
        p_tenant: TENANT_ID,
        p_call: CALL_ID,
        p_owner: OWNER_ID,
        p_expected_revision: 1,
        p_field: "area.coverage",
        p_subject: null,
        p_coverage: {
          schema_version: 2,
          revision: 2,
          selected_rule_ids: [],
          snapshot: {
            revision: 2,
            followUps: 1,
            followUpGroups: { "area.coverage": 1 },
          },
        },
      },
    });
  });

  test("follow-up preflight timeout remains indeterminate for reattach retry", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptNeverResolves = true;
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 30,
      timeoutMs: 5,
    });
    expect(await store.recordOnboardingFollowup(ownerCapability(), {
      revision: 1,
      digest: "a".repeat(64),
      field: "area.coverage",
      questionPt: "Quais cidades vocês atendem?",
    })).toMatchObject({
      ok: false,
      code: "indeterminate",
      safeDetail: "onboarding follow-up persistence is indeterminate",
    });
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

describe("loadOnboardingSnapshot", () => {
  test("loads a complete immutable receipt with only its selected rules and canonical anchors", async () => {
    const fake = new SupabaseBoundaryFake();
    const complete = receipt({
      snapshot: {
        ...emptySnapshot(1),
        cells: {
          "area.coverage": {
            state: "answered",
            attempts: 1,
            value: ["Anaheim", "Irvine"],
          },
        },
      },
    });
    fake.receiptRows = [complete];
    fake.ruleRows = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        rule_group_id: "group-1",
        version: 1,
        structured: {
          coverage_field: "area.coverage",
          coverage_subject: null,
        },
        created_at: "2026-08-25T01:00:00.000Z",
      },
      {
        id: "not-selected",
        rule_group_id: "group-2",
        version: 1,
        structured: {
          coverage_field: "area.travel_fee",
          coverage_subject: null,
        },
        created_at: "2026-08-25T02:00:00.000Z",
      },
    ];
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 100,
      timeoutMs: 100,
    });

    const result = await store.loadOnboardingSnapshot(ownerCapability());

    expect(result).toMatchObject({
      ok: true,
      receiptId: complete.id,
      revision: 1,
      digest: "a".repeat(64),
      requiredAnchors: ["Área: Anaheim, Irvine"],
      rules: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          ruleGroupId: "group-1",
          version: 1,
        },
      ],
    });
  });

  test("recomputes the complete V2 summary and exact selected materialization hashes before returning it", async () => {
    const snapshot = completeV2Snapshot();
    const progress = evaluateCoverage(snapshot);
    const materialized = materializeCoverage(snapshot, progress);
    expect(materialized.summary).not.toBeNull();
    const selected = materialized.rules.filter((rule) => rule.reviewReady);
    const row: ReceiptRow = {
      id: "77777777-7777-4777-8777-777777777777",
      readback: {
        schema_version: 2,
        transition_kind: "answer",
        tenant_id: TENANT_ID,
        call_id: CALL_ID,
        revision: snapshot.revision,
        complete: true,
        snapshot,
        progress,
        selected_rule_ids: selected.map((_rule, index) => `v2-rule-${index}`),
        next_action: { type: "prepare_summary" },
        current_answer_hashes: {},
        materializations: materialized.rules,
        summary_projection: materialized.summary,
        summary_hash: materialized.summary!.summaryHash,
        snapshot_digest: "7".repeat(64),
        authority: {
          rules_approved: false,
          powers_granted: false,
          operational_mode_changed: false,
        },
      },
    };
    const fake = new SupabaseBoundaryFake();
    fake.receiptRows = [row];
    fake.ruleRows = selected.map((rule, index) => ({
      id: `v2-rule-${index}`,
      rule_group_id: `v2-group-${index}`,
      version: 1,
      structured: rule.structured,
      created_at: `2026-08-25T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 200,
      timeoutMs: 100,
    });

    const result = await store.loadOnboardingSnapshot(ownerCapability());
    expect(result).toMatchObject({
      ok: true,
      receiptId: row.id,
      revision: snapshot.revision,
      digest: "7".repeat(64),
      summary: {
        schemaVersion: 2,
        summaryHash: materialized.summary!.summaryHash,
      },
      requiredAnchors: materialized.summary!.anchors,
    });
    expect(result.ok && result.summary.entries.map((entry) => entry.key).sort())
      .toEqual(materialized.summary!.entries.map((entry) => entry.key).sort());
    expect(result.ok && result.requiredAnchors).toContain(
      "Idioma e tom: Não executar nem confirmar idioma e tom autonomamente; encaminhar a decisão ao dono.",
    );

    const tampered = structuredClone(row);
    (tampered.readback.summary_projection as any).entries.pop();
    const changedFake = new SupabaseBoundaryFake();
    changedFake.receiptRows = [tampered];
    changedFake.ruleRows = fake.ruleRows;
    const changedStore = createOnboardingStore({
      client: changedFake.client() as any,
      now: () => 201,
      timeoutMs: 100,
    });
    expect(await changedStore.loadOnboardingSnapshot(ownerCapability())).toEqual({
      ok: false,
      code: "changed",
      safeDetail: "coverage snapshot changed",
      durationMs: 0,
    });
  });

  test("returns changed when a newer revision appears while selected rules are resolving", async () => {
    const fake = new SupabaseBoundaryFake();
    const revisionOne = receipt({
      selected_rule_ids: ["selected-r1"],
      snapshot_digest: "5".repeat(64),
    });
    const revisionTwo: ReceiptRow = {
      id: "44444444-4444-4444-8444-444444444447",
      readback: {
        ...revisionOne.readback,
        revision: 2,
        snapshot: emptySnapshot(2),
        selected_rule_ids: ["selected-r2"],
        snapshot_digest: "6".repeat(64),
      },
    };
    fake.receiptRows = [revisionOne];
    fake.receiptReadSequences = [[revisionOne], [revisionOne, revisionTwo]];
    fake.ruleRows = [
      {
        id: "selected-r1",
        rule_group_id: "group-r1",
        version: 1,
        structured: {},
        created_at: "2026-08-25T01:00:00.000Z",
      },
    ];
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 110,
      timeoutMs: 100,
    });

    expect(await store.loadOnboardingSnapshot(ownerCapability())).toEqual({
      ok: false,
      code: "changed",
      safeDetail: "coverage snapshot changed",
      durationMs: 0,
    });
  });

  test("fails closed on a saturated receipt bound or duplicate revision", async () => {
    for (const rows of [
      Array.from({ length: 512 }, (_, index) => ({
        id: `receipt-${index + 1}`,
        readback: {
          ...receipt().readback,
          revision: index + 1,
          snapshot: emptySnapshot(index + 1),
          selected_rule_ids: [],
          snapshot_digest: (index % 16).toString(16).repeat(64),
        },
      })),
      [
        receipt({ selected_rule_ids: [] }),
        {
          ...receipt({ selected_rule_ids: [] }),
          id: "duplicate-revision-receipt",
        },
      ],
    ]) {
      const fake = new SupabaseBoundaryFake();
      fake.receiptRows = rows;
      fake.ruleRows = [];
      const store = createOnboardingStore({
        client: fake.client() as any,
        now: () => 120,
        timeoutMs: 100,
      });
      expect(await store.loadOnboardingSnapshot(ownerCapability())).toEqual({
        ok: false,
        code: "changed",
        safeDetail: "coverage snapshot changed",
        durationMs: 0,
      });
    }
  });

  test("requires the selected rule response to match the exact unique requested ID set", async () => {
    const cases: Array<{
      selected: string[];
      returned: RuleRow[];
      ignoreFilter?: boolean;
    }> = [
      {
        selected: ["selected-1", "selected-2"],
        returned: [
          {
            id: "selected-1",
            rule_group_id: "group-1",
            version: 1,
            structured: {},
            created_at: "2026-08-25T01:00:00.000Z",
          },
        ],
      },
      {
        selected: ["selected-1"],
        returned: [
          {
            id: "selected-1",
            rule_group_id: "group-1",
            version: 1,
            structured: {},
            created_at: "2026-08-25T01:00:00.000Z",
          },
          {
            id: "selected-1",
            rule_group_id: "group-1",
            version: 1,
            structured: {},
            created_at: "2026-08-25T01:00:00.000Z",
          },
        ],
      },
      {
        selected: ["selected-1"],
        returned: [
          {
            id: "selected-1",
            rule_group_id: "group-1",
            version: 1,
            structured: {},
            created_at: "2026-08-25T01:00:00.000Z",
          },
          {
            id: "unexpected",
            rule_group_id: "group-x",
            version: 1,
            structured: {},
            created_at: "2026-08-25T01:00:00.000Z",
          },
        ],
        ignoreFilter: true,
      },
    ];
    for (const scenario of cases) {
      const fake = new SupabaseBoundaryFake();
      fake.receiptRows = [
        receipt({ selected_rule_ids: scenario.selected }),
      ];
      fake.ruleRows = scenario.returned;
      fake.ignoreRuleInFilter = scenario.ignoreFilter === true;
      const store = createOnboardingStore({
        client: fake.client() as any,
        now: () => 130,
        timeoutMs: 100,
      });

      expect(await store.loadOnboardingSnapshot(ownerCapability())).toEqual({
        ok: false,
        code: "changed",
        safeDetail: "coverage snapshot changed",
        durationMs: 0,
      });
    }
  });

  test("preserves timeout, query, empty, incomplete, and changed as distinct safe failures", async () => {
    const timeoutFake = new SupabaseBoundaryFake();
    timeoutFake.receiptNeverResolves = true;
    const timed = createOnboardingStore({
      client: timeoutFake.client() as any,
      now: (() => {
        let value = 100;
        return () => (value += 7);
      })(),
      timeoutMs: 5,
    });
    expect(await timed.loadOnboardingSnapshot(ownerCapability())).toEqual({
      ok: false,
      code: "timeout",
      safeDetail: "coverage snapshot query timed out",
      durationMs: 7,
    });

    const queryFake = new SupabaseBoundaryFake();
    queryFake.receiptError = {
      message: "database error including DO-NOT-LEAK-SECRET",
    };
    const queried = createOnboardingStore({
      client: queryFake.client() as any,
      now: () => 200,
      timeoutMs: 100,
    });
    expect(await queried.loadOnboardingSnapshot(ownerCapability())).toEqual({
      ok: false,
      code: "query_error",
      safeDetail: "coverage snapshot query failed",
      durationMs: 0,
    });

    const emptyFake = new SupabaseBoundaryFake();
    const empty = createOnboardingStore({
      client: emptyFake.client() as any,
      now: () => 300,
      timeoutMs: 100,
    });
    expect(await empty.loadOnboardingSnapshot(ownerCapability())).toEqual({
      ok: false,
      code: "empty",
      safeDetail: "coverage snapshot is empty",
      durationMs: 0,
    });

    const incompleteFake = new SupabaseBoundaryFake();
    incompleteFake.receiptRows = [
      receipt({
        complete: false,
        progress: {
          missingRequired: [{ field: "authority.book" }],
          ambiguous: [],
        },
      }),
    ];
    const incomplete = createOnboardingStore({
      client: incompleteFake.client() as any,
      now: () => 400,
      timeoutMs: 100,
    });
    expect(
      await incomplete.loadOnboardingSnapshot(ownerCapability()),
    ).toEqual({
      ok: false,
      code: "coverage_incomplete",
      safeDetail: "coverage snapshot is incomplete",
      durationMs: 0,
    });

    const changedFake = new SupabaseBoundaryFake();
    changedFake.receiptRows = [
      receipt({ snapshot: emptySnapshot(2), revision: 1 }),
    ];
    const changed = createOnboardingStore({
      client: changedFake.client() as any,
      now: () => 500,
      timeoutMs: 100,
    });
    expect(await changed.loadOnboardingSnapshot(ownerCapability())).toEqual({
      ok: false,
      code: "changed",
      safeDetail: "coverage snapshot changed",
      durationMs: 0,
    });
  });
});

describe("recordOnboardingVoiceApproval", () => {
  test("binds approval to the latest complete revision and maps an exact durable replay", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptRows = [receipt()];
    fake.ruleRows = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        rule_group_id: "group-1",
        version: 1,
        structured: {
          coverage_field: "area.coverage",
          coverage_subject: null,
        },
        created_at: "2026-08-25T01:00:00.000Z",
      },
    ];
    fake.rpcResult = {
      data: {
        status: "reused",
        approval_receipt_id: "approval-authoritative",
        coverage_receipt_id: "coverage-authoritative",
        revision: 8,
        snapshot_digest: "f".repeat(64),
      },
      error: null,
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 600,
      timeoutMs: 100,
    });

    const result = await store.recordOnboardingVoiceApproval(
      ownerCapability(),
      "provider-approval-2",
      "Aprovado, está tudo correto.",
    );

    expect(fake.rpcCalls).toEqual([
      {
        name: "record_onboarding_voice_approval",
        args: {
          p_tenant: TENANT_ID,
          p_call: CALL_ID,
          p_owner: OWNER_ID,
          p_provider_tool_call_id: "provider-approval-2",
          p_event_key:
            "15147a9ba5aa2da36b809777902917bf284fa0cf0406a78e7d4f36ab5d23035c",
          p_expected_revision: 1,
          p_expected_digest: "a".repeat(64),
          p_owner_words: "Aprovado, está tudo correto.",
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      status: "reused",
      approvalReceiptId: "approval-authoritative",
      coverageReceiptId: "coverage-authoritative",
      revision: 8,
      digest: "f".repeat(64),
      durationMs: 0,
    });
  });

  test("maps optimistic revision and incomplete RPC errors without leaking database detail", async () => {
    for (const [error, code] of [
      [
        { code: "40001", message: "onboarding_snapshot_changed secret" },
        "changed",
      ],
      [
        { code: "22023", message: "onboarding_coverage_incomplete secret" },
        "coverage_incomplete",
      ],
    ] as const) {
      const fake = new SupabaseBoundaryFake();
      fake.receiptRows = [receipt()];
      fake.ruleRows = [
        {
          id: "55555555-5555-4555-8555-555555555555",
          rule_group_id: "group-1",
          version: 1,
          structured: {},
          created_at: "2026-08-25T01:00:00.000Z",
        },
      ];
      fake.rpcResult = { data: null, error };
      const store = createOnboardingStore({
        client: fake.client() as any,
        now: () => 700,
        timeoutMs: 100,
      });
      const result = await store.recordOnboardingVoiceApproval(
        ownerCapability(),
        `provider-${code}`,
        "Aprovado.",
      );
      expect(result).toMatchObject({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("reconciles an approval receipt committed after the response times out", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptRows = [receipt({ selected_rule_ids: [] })];
    fake.rpcNeverResolves = true;
    fake.rpcCommitReceipt = {
      id: "late-approval-receipt",
      detail: {
        owner_words: "Aprovado.",
        provider_tool_call_id: "approval-late",
      },
      readback: {
        schema_version: 1,
        call_id: CALL_ID,
        snapshot_receipt_id: receipt().id,
        snapshot_revision: 1,
        snapshot_digest: "a".repeat(64),
        authority: {
          rules_approved: false,
          powers_granted: false,
          operational_mode_changed: false,
        },
      },
    };
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: (() => {
        let value = 0;
        return () => value++;
      })(),
      timeoutMs: 5,
    });

    expect(await store.recordOnboardingVoiceApproval(
      ownerCapability(),
      "approval-late",
      "Aprovado.",
    )).toMatchObject({
      ok: true,
      status: "reused",
      approvalReceiptId: "late-approval-receipt",
      coverageReceiptId: receipt().id,
      revision: 1,
      digest: "a".repeat(64),
    });
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcAbortSignals[0]?.aborted).toBe(true);
  });

  test("approval preflight timeout remains indeterminate for reattach retry", async () => {
    const fake = new SupabaseBoundaryFake();
    fake.receiptNeverResolves = true;
    const store = createOnboardingStore({
      client: fake.client() as any,
      now: () => 10,
      timeoutMs: 5,
    });
    expect(await store.recordOnboardingVoiceApproval(
      ownerCapability(),
      "approval-preflight-timeout",
      "Aprovado.",
    )).toMatchObject({
      ok: false,
      code: "indeterminate",
      safeDetail: "onboarding approval persistence is indeterminate",
    });
    expect(fake.rpcCalls).toHaveLength(0);
  });
});

test("test hash fixtures are fixed literals rather than values produced by the store", () => {
  expect(
    createHash("sha256")
      .update(
        `ligou.v0_2.onboarding_answer:v1:${TENANT_ID}:${CALL_ID}:provider-call-7`,
      )
      .digest("hex"),
  ).toBe("a40d8aa6433a3670a0ed179cd1a279c79369fc5c3d62722406095c747fd70fca");
  expect(
    createHash("sha256")
      .update(
        `ligou.v0_2.onboarding_voice_approval:v1:${TENANT_ID}:${CALL_ID}:provider-approval-2`,
      )
      .digest("hex"),
  ).toBe("15147a9ba5aa2da36b809777902917bf284fa0cf0406a78e7d4f36ab5d23035c");
});
