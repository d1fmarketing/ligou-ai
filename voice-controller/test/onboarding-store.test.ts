import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
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
  eventReceiptRows = new Map<string, ReceiptRow>();
  receiptError: QueryError | null = null;
  ruleRows: RuleRow[] = [];
  ruleError: QueryError | null = null;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  rpcResult: { data: unknown; error: QueryError | null } = {
    data: null,
    error: null,
  };
  receiptNeverResolves = false;

  client() {
    const boundary = this;
    return {
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        let selected = "";
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
          limit() {
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
            return Promise.resolve({
              data: boundary.ruleRows,
              error: boundary.ruleError,
            }).then(resolve);
          },
        };
        return query;
      },
      rpc(name: string, args: Record<string, unknown>) {
        boundary.rpcCalls.push({ name, args });
        return Promise.resolve(boundary.rpcResult);
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
        "8185a9352a4e9250a7de1b622aabd5eadf8b2231d1561978a42f34afe38b3a36",
      p_expected_revision: 0,
      p_rule_group_id: null,
      p_fact: AREA_FACT,
    });
    expect(args.p_coverage).toMatchObject({
      schema_version: 1,
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      revision: 1,
      complete: false,
      selected_rule_ids: [],
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
  });

  test("derives a correction group from the latest same-call onboarding rule metadata", async () => {
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
      p_rule_group_id: "correct-latest-group",
      p_coverage: {
        revision: 2,
        selected_rule_ids: [],
      },
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
