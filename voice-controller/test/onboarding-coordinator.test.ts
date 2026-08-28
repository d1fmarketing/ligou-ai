import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyCoverageFact,
  canonicalizeLocalityInput,
  createCoverage,
  type CoverageFact,
  type CoverageField,
  type CoverageSnapshot,
} from "../src/onboarding-coverage.ts";
import {
  createOnboardingLifecycle,
  hashOnboardingToolArgs,
  onboardingOutputRequestEventId,
  reduceOnboarding,
  type OnboardingCommand,
  type OnboardingEvent,
  type OnboardingLifecycle,
} from "../src/onboarding-coordinator.ts";
import { requestResponse } from "../src/response-coordinator.ts";

const callId = "7f58ee06-6a13-4d45-a2d5-c60244dc92a3";
const businessName = "Rocha Plumbing";
const budgetPauseSentence =
  "Estamos chegando ao limite desta sessão. Suas informações foram salvas e podemos continuar imediatamente.";

function step(
  lifecycle: OnboardingLifecycle,
  event: OnboardingEvent,
): { lifecycle: OnboardingLifecycle; commands: OnboardingCommand[] } {
  return reduceOnboarding(lifecycle, event);
}

function providerOutputItemId(toolCallId: string): string {
  return `tlo-${createHash("sha256")
    .update(`tool-output\0${toolCallId}`, "utf8")
    .digest("hex")
    .slice(0, 28)}`;
}

function outputSentEvent(
  lifecycle: OnboardingLifecycle,
  toolCallId: string,
  socketGeneration: number,
  elapsedMs: number,
  delivery: "create" | "retrieve" = "create",
): OnboardingEvent {
  const receipt = lifecycle.toolOutbox[toolCallId];
  if (!receipt) throw new Error(`missing tool receipt ${toolCallId}`);
  return {
    type: "tool.output_sent",
    toolCallId,
    socketGeneration,
    elapsedMs,
    delivery,
    eventId: onboardingOutputRequestEventId(
      lifecycle,
      receipt,
      delivery,
    ),
  };
}

function startCollecting(): OnboardingLifecycle {
  let lifecycle = createOnboardingLifecycle(callId, businessName);
  ({ lifecycle } = step(lifecycle, {
    type: "socket.attached",
    socketGeneration: 1,
    elapsedMs: 0,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey: `greeting:${callId}`,
    socketGeneration: 1,
    elapsedMs: 1,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.created",
    responseId: "response-greeting",
    intentKey: `greeting:${callId}`,
    socketGeneration: 1,
    elapsedMs: 2,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.transcript.done",
    responseId: "response-greeting",
    transcript:
      "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
    socketGeneration: 1,
    elapsedMs: 3,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.output_audio.done",
    responseId: "response-greeting",
    socketGeneration: 1,
    elapsedMs: 4,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.done",
    responseId: "response-greeting",
    socketGeneration: 1,
    elapsedMs: 5,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "output_audio_buffer.stopped",
    responseId: "response-greeting",
    socketGeneration: 1,
    elapsedMs: 6,
  }));
  expect(lifecycle.phase).toBe("collecting");
  return lifecycle;
}

const universalFields: CoverageField[] = [
  "business.customer_types",
  "business.excluded_work",
  "business.languages_tone",
  "area.coverage",
  "area.out_of_area_policy",
  "area.travel_fee",
  "schedule.business_hours",
  "schedule.same_day_lead_time",
  "schedule.capacity_buffer",
  "schedule.reschedule_cancel",
  "schedule.holidays",
  "emergency.types",
  "emergency.safety_escalation",
  "emergency.after_hours",
  "emergency.fee_authority",
  "policy.payment_estimate",
  "policy.warranty_materials",
  "policy.access_cancellation",
  "policy.complaints_returns",
  "authority.quote_price",
  "authority.negotiate_floor",
  "authority.read_calendar",
  "authority.book",
  "authority.reschedule_cancel",
  "authority.charge_fee",
  "authority.emergency",
  "authority.out_of_area",
];

function completeCoverage(revision = 41): CoverageSnapshot {
  let snapshot = createCoverage({ tenantId: "tenant-1", callId });
  snapshot = applyCoverageFact(snapshot, {
    field: "service.catalog_closure",
    disposition: "answered",
    value: true,
    ownerWords: "esses são todos os serviços",
  });
  for (const field of universalFields) {
    const values: Partial<Record<CoverageField, unknown>> = {
      "business.customer_types": ["residencial"],
      "area.coverage": { localities: [canonicalizeLocalityInput({
        display_name: "Irvine", country_code: "US", region_code: "CA",
      })!] },
      "schedule.business_hours": {
        days: ["mon", "tue", "wed", "thu", "fri"],
        hours: { opens: "08:00", closes: "18:00" },
      },
      "emergency.types": ["vazamento"],
      "emergency.safety_escalation": "ligar 911 em risco imediato",
    };
    const fact: CoverageFact = values[field] !== undefined
      ? {
          field,
          disposition: "answered",
          value: values[field],
          ownerWords: "resposta explícita do dono",
        }
      : {
          field,
          disposition: "owner_review_required",
          value: null,
          ownerWords: "preciso revisar depois",
        };
    snapshot = applyCoverageFact(snapshot, fact);
  }
  return { ...snapshot, revision };
}

function coverageReady(lifecycle = startCollecting()) {
  return step(lifecycle, {
    type: "coverage.changed",
    revision: 41,
    digest: "digest-41",
    complete: true,
    missing: [],
    ambiguous: [],
    elapsedMs: 40,
  });
}

function snapshotReady(lifecycle = coverageReady().lifecycle) {
  return step(lifecycle, {
    type: "snapshot.loaded",
    result: {
      ok: true,
      receiptId: "coverage-receipt-41",
      revision: 41,
      digest: "digest-41",
      coverage: completeCoverage(),
      rules: [
        {
          id: "rule-1",
          ruleGroupId: "rule-group-1",
          version: 1,
          structured: { coverage_field: "area.coverage" },
        },
      ],
      requiredAnchors: [
        "Área: Irvine",
        "Horário: segunda a sexta, 08:00 às 18:00",
        "Segurança: ligar 911 em risco imediato",
      ],
      durationMs: 12,
    },
    elapsedMs: 52,
  });
}

function beginSummary(lifecycle = snapshotReady().lifecycle) {
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey: "summary:digest-41",
    socketGeneration: 1,
    elapsedMs: 53,
  }));
  return step(lifecycle, {
    type: "response.created",
    responseId: "response-summary-41",
    intentKey: "summary:digest-41",
    socketGeneration: 1,
    elapsedMs: 54,
  }).lifecycle;
}

function beginSummaryWithAnchors(requiredAnchors: string[]) {
  let lifecycle = coverageReady().lifecycle;
  ({ lifecycle } = step(lifecycle, {
    type: "snapshot.loaded",
    result: {
      ok: true,
      receiptId: "coverage-receipt-41",
      revision: 41,
      digest: "digest-41",
      coverage: completeCoverage(),
      rules: [
        {
          id: "rule-anchor",
          ruleGroupId: "rule-group-anchor",
          version: 1,
          structured: { coverage_field: "area.coverage" },
        },
      ],
      requiredAnchors,
      durationMs: 12,
    },
    elapsedMs: 52,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey: "summary:digest-41",
    socketGeneration: 1,
    elapsedMs: 53,
  }));
  return step(lifecycle, {
    type: "response.created",
    responseId: "response-summary-41",
    intentKey: "summary:digest-41",
    socketGeneration: 1,
    elapsedMs: 54,
  }).lifecycle;
}

function proveSummaryTranscript(
  lifecycle: OnboardingLifecycle,
  transcript: string,
): OnboardingLifecycle {
  for (const event of [
    {
      type: "response.transcript.done",
      responseId: "response-summary-41",
      transcript,
      socketGeneration: 1,
      elapsedMs: 60,
    },
    {
      type: "response.output_audio.done",
      responseId: "response-summary-41",
      socketGeneration: 1,
      elapsedMs: 61,
    },
    {
      type: "response.done",
      responseId: "response-summary-41",
      socketGeneration: 1,
      elapsedMs: 62,
    },
    {
      type: "output_audio_buffer.stopped",
      responseId: "response-summary-41",
      socketGeneration: 1,
      elapsedMs: 63,
    },
  ] as OnboardingEvent[])
    ({ lifecycle } = step(lifecycle, event));
  return lifecycle;
}

function authoritativeSnapshot(revision: number, digest: string) {
  return {
    ok: true as const,
    receiptId: `coverage-receipt-${revision}`,
    revision,
    digest,
    coverage: completeCoverage(revision),
    rules: [
      {
        id: `rule-${revision}`,
        ruleGroupId: "rule-group-area",
        version: revision,
        structured: { coverage_field: "area.coverage" },
      },
    ],
    requiredAnchors: [
      "Área: Irvine",
      "Horário: segunda a sexta, 08:00 às 18:00",
      "Segurança: ligar 911 em risco imediato",
    ],
    durationMs: 12,
  };
}

function validSummaryTranscript() {
  return [
    "Área: Irvine.",
    "Horário: segunda a sexta, 08:00 às 18:00.",
    "Segurança: ligar 911 em risco imediato.",
    "Você confirma que tudo está correto?",
  ].join(" ");
}

function finishSummary(lifecycle = beginSummary()) {
  const events: OnboardingEvent[] = [
    {
      type: "response.transcript.done",
      responseId: "response-summary-41",
      transcript: validSummaryTranscript(),
      socketGeneration: 1,
      elapsedMs: 60,
    },
    {
      type: "response.output_audio.done",
      responseId: "response-summary-41",
      socketGeneration: 1,
      elapsedMs: 61,
    },
    {
      type: "response.done",
      responseId: "response-summary-41",
      socketGeneration: 1,
      elapsedMs: 62,
    },
    {
      type: "output_audio_buffer.stopped",
      responseId: "response-summary-41",
      socketGeneration: 1,
      elapsedMs: 63,
    },
  ];
  for (const event of events) ({ lifecycle } = step(lifecycle, event));
  expect(lifecycle.phase).toBe("awaiting_owner_approval");
  return lifecycle;
}

function explicitApproval(lifecycle = finishSummary()) {
  ({ lifecycle } = step(lifecycle, {
    type: "caller.speech_started",
    turnId: "owner-turn-approval",
    socketGeneration: 1,
    elapsedMs: 70,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "caller.transcript.completed",
    turnId: "owner-turn-approval",
    transcript: "Aprovado, está tudo correto.",
    socketGeneration: 1,
    elapsedMs: 71,
  }));
  return lifecycle;
}

function approvalPersisting(lifecycle = explicitApproval()) {
  return step(lifecycle, {
    type: "tool.called",
    toolCallId: "approval-tool-1",
    name: "approve_onboarding_summary",
    args: { owner_words: "Aprovado, está tudo correto." },
    providerResponseId: "response-approval-tool",
    batchHash: "approval-batch-hash",
    callerTurnId: "owner-turn-approval",
    socketGeneration: 1,
    elapsedMs: 72,
  });
}

function signoffSpeaking(lifecycle = approvalPersisting().lifecycle) {
  ({ lifecycle } = step(lifecycle, {
    type: "approval.persisted",
    toolCallId: "approval-tool-1",
    approvalReceiptId: "approval-receipt-1",
    coverageReceiptId: "coverage-receipt-41",
    revision: 41,
    digest: "digest-41",
    output: JSON.stringify({ status: "recorded" }),
    resultHash: "approval-result-hash",
    elapsedMs: 74,
  }));
  ({ lifecycle } = step(
    lifecycle,
    outputSentEvent(lifecycle, "approval-tool-1", 1, 75),
  ));
  ({ lifecycle } = step(lifecycle, {
    type: "tool.batch_closed",
    providerResponseId: "response-approval-tool",
    batchHash: "approval-batch-hash",
    toolCallIds: ["approval-tool-1"],
    elapsedMs: 75,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.done",
    responseId: "response-approval-tool",
    socketGeneration: 1,
    elapsedMs: 75,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "tool.output_acked",
    toolCallId: "approval-tool-1",
    outputItemId: providerOutputItemId("approval-tool-1"),
    socketGeneration: 1,
    elapsedMs: 76,
  }));
  expect(lifecycle.phase).toBe("final_signoff_speaking");
  return lifecycle;
}

function commandTypes(commands: OnboardingCommand[]) {
  return commands.map((command) => command.type);
}

function budgetPauseQueued() {
  let lifecycle = startCollecting();
  lifecycle.activeResponseId = "response-before-budget-pause";
  const observed = step(lifecycle, {
    type: "budget.soft_limit_reached",
    responseId: "response-before-budget-pause",
    costUsd: 6.5,
    softLimitUsd: 6.5,
    hardLimitUsd: 7.5,
    socketGeneration: 1,
    elapsedMs: 432_000,
  } as OnboardingEvent);
  expect(observed.commands.filter((command) => command.type === "request_response"))
    .toHaveLength(0);
  const duplicate = step(observed.lifecycle, {
    type: "budget.soft_limit_reached",
    responseId: "response-before-budget-pause",
    costUsd: 6.5,
    softLimitUsd: 6.5,
    hardLimitUsd: 7.5,
    socketGeneration: 1,
    elapsedMs: 432_001,
  } as OnboardingEvent);
  expect((duplicate.lifecycle as any).budgetPause)
    .toEqual((observed.lifecycle as any).budgetPause);
  expect(duplicate.commands.some((command) =>
    command.type === "request_response" ||
    command.type === "request_budget_hangup"
  )).toBe(false);
  const terminal = step(duplicate.lifecycle, {
    type: "response.done",
    responseId: "response-before-budget-pause",
    socketGeneration: 1,
    elapsedMs: 432_002,
  });
  expect(terminal.lifecycle.phase).toBe("budget_pause_speaking" as any);
  expect(terminal.commands.filter((command) =>
    command.type === "request_response" &&
    command.intentKey === `budget-pause:${callId}`
  )).toEqual([
    expect.objectContaining({
      type: "request_response",
      purpose: "budget_pause",
      instructions: `Diga exatamente uma vez: "${budgetPauseSentence}"`,
    }),
  ]);
  return terminal.lifecycle;
}

function providerTerminatingLifecycle() {
  let lifecycle = signoffSpeaking();
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey: "final-signoff:approval-receipt-1",
    socketGeneration: 1,
    elapsedMs: 77,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.created",
    responseId: "response-signoff-late",
    intentKey: "final-signoff:approval-receipt-1",
    socketGeneration: 1,
    elapsedMs: 78,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.transcript.done",
    responseId: "response-signoff-late",
    transcript:
      "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.",
    socketGeneration: 1,
    elapsedMs: 79,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.output_audio.done",
    responseId: "response-signoff-late",
    socketGeneration: 1,
    elapsedMs: 80,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.done",
    responseId: "response-signoff-late",
    socketGeneration: 1,
    elapsedMs: 81,
  }));
  const playback = step(lifecycle, {
    type: "output_audio_buffer.stopped",
    responseId: "response-signoff-late",
    socketGeneration: 1,
    elapsedMs: 82,
  });
  lifecycle = playback.lifecycle;
  expect(playback.commands.filter((command) => command.type === "request_hangup"))
    .toHaveLength(1);
  ({ lifecycle } = step(lifecycle, {
    type: "provider.termination_requested",
    intentKey: "hangup:approval-receipt-1",
    elapsedMs: 83,
  }));
  expect(lifecycle.phase).toBe("provider_terminating");
  return lifecycle;
}

type AuthoritySpeechKind = "greeting" | "summary" | "signoff";

function beginAuthoritySpeech(kind: AuthoritySpeechKind): {
  lifecycle: OnboardingLifecycle;
  responseId: string;
  intentKey: string;
  retryKey: string;
} {
  if (kind === "greeting") {
    let lifecycle = createOnboardingLifecycle(callId, businessName);
    const intentKey = `greeting:${callId}`;
    ({ lifecycle } = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 1,
      elapsedMs: 0,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 1,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.created",
      responseId: "response-greeting-interrupted",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 2,
    }));
    return {
      lifecycle,
      responseId: "response-greeting-interrupted",
      intentKey,
      retryKey: `${intentKey}:retry:1`,
    };
  }
  if (kind === "summary") {
    const lifecycle = beginSummary();
    return {
      lifecycle,
      responseId: "response-summary-41",
      intentKey: "summary:digest-41",
      retryKey: "summary:digest-41:retry:1",
    };
  }
  let lifecycle = signoffSpeaking();
  const intentKey = "final-signoff:approval-receipt-1";
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey,
    socketGeneration: 1,
    elapsedMs: 77,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.created",
    responseId: "response-signoff-interrupted",
    intentKey,
    socketGeneration: 1,
    elapsedMs: 78,
  }));
  return {
    lifecycle,
    responseId: "response-signoff-interrupted",
    intentKey,
    retryKey: `${intentKey}:retry:1`,
  };
}

function authorityProof(
  lifecycle: OnboardingLifecycle,
  kind: AuthoritySpeechKind,
) {
  return kind === "greeting"
    ? lifecycle.greeting
    : kind === "summary"
      ? lifecycle.summary
      : lifecycle.signoff;
}

function summaryCommands(commands: OnboardingCommand[]) {
  return commands.filter(
    (command) =>
      command.type === "request_response" &&
      command.intentKey.startsWith("summary:"),
  );
}

describe("onboarding lifecycle forbidden transitions", () => {
  test("one truthful budget pause requires exact transcript, generated audio, terminal response, and playback before hangup", () => {
    let lifecycle = budgetPauseQueued();
    const intentKey = `budget-pause:${callId}`;
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 432_003,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.created",
      responseId: "response-budget-pause",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 432_004,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.transcript.done",
      responseId: "response-budget-pause",
      transcript: budgetPauseSentence,
      socketGeneration: 1,
      elapsedMs: 432_005,
    }));
    for (const event of [
      {
        type: "response.output_audio.done",
        responseId: "response-budget-pause",
        socketGeneration: 1,
        elapsedMs: 432_006,
      },
      {
        type: "response.done",
        responseId: "response-budget-pause",
        socketGeneration: 1,
        elapsedMs: 432_007,
      },
    ] as OnboardingEvent[]) {
      const result = step(lifecycle, event);
      lifecycle = result.lifecycle;
      expect(result.commands.some((command) =>
        command.type === "request_budget_hangup"
      )).toBe(false);
    }

    const playback = step(lifecycle, {
      type: "output_audio_buffer.stopped",
      responseId: "response-budget-pause",
      socketGeneration: 1,
      elapsedMs: 432_008,
    });
    expect(playback.lifecycle.phase).toBe("budget_pause_ready_to_terminate" as any);
    expect(playback.commands.filter((command) =>
      command.type === "request_budget_hangup"
    )).toEqual([
      expect.objectContaining({
        type: "request_budget_hangup",
        intentKey: `budget-hangup:${callId}`,
        costUsd: 6.5,
      }),
    ]);

    const duplicatePlayback = step(playback.lifecycle, {
      type: "output_audio_buffer.stopped",
      responseId: "response-budget-pause",
      socketGeneration: 1,
      elapsedMs: 432_009,
    });
    expect(duplicatePlayback.commands.some((command) =>
      command.type === "request_budget_hangup"
    )).toBe(false);
  });

  test("budget pause barge-in retries once while a lost response ACK blocks without duplicate speech or fake hangup", () => {
    let lifecycle = budgetPauseQueued();
    const intentKey = `budget-pause:${callId}`;
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 1,
    }));
    const lostAck = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 2,
      elapsedMs: 2,
    });
    expect(lostAck.lifecycle.phase).toBe("blocked");
    expect(lostAck.commands).toContainEqual(expect.objectContaining({
      type: "block",
      code: "response_intent_ack_indeterminate",
    }));
    expect(lostAck.commands.some((command) =>
      command.type === "request_response" ||
      command.type === "request_budget_hangup"
    )).toBe(false);

    lifecycle = budgetPauseQueued();
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 3,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.created",
      responseId: "response-budget-pause-interrupted",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 4,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.audio_interrupted",
      responseId: "response-budget-pause-interrupted",
      socketGeneration: 1,
      elapsedMs: 5,
    }));
    const terminal = step(lifecycle, {
      type: "response.done",
      responseId: "response-budget-pause-interrupted",
      socketGeneration: 1,
      elapsedMs: 6,
    });
    expect(terminal.commands.filter((command) =>
      command.type === "request_response" &&
      command.intentKey === `budget-pause:${callId}:retry:1`
    )).toHaveLength(1);
    expect(terminal.commands.some((command) =>
      command.type === "request_budget_hangup"
    )).toBe(false);
  });

  test("queues one stable greeting and emits complete coverage-start telemetry", () => {
    const created = createOnboardingLifecycle(callId, businessName);
    expect(created.coverage.nextQuestion).toEqual({
      field: "service.catalog_closure",
      questionPt: "Quais serviços sua empresa oferece?",
    });
    const attached = step(created, {
      type: "socket.attached",
      socketGeneration: 1,
      elapsedMs: 8,
    });
    expect(
      attached.commands.filter((command) =>
        command.type === "request_response"
      ),
    ).toEqual([
      {
        type: "request_response",
        purpose: "greeting",
        intentKey: `greeting:${callId}`,
        instructions:
          "Diga exatamente uma vez e sem alteração a saudação de identidade brasileira definida na sessão. " +
          'Em seguida, pergunte exatamente: "Quais serviços sua empresa oferece?"',
      },
    ]);
    expect(attached.commands).toContainEqual({
      type: "telemetry",
      name: "onboarding.coverage.started",
      callIdPrefix: "7f58ee06",
      socketGeneration: 1,
      lifecycleRevision: 1,
      phase: "greeting",
      elapsedMs: 8,
      outcome: "coverage_revision_0",
    });
    const reattached = step(attached.lifecycle, {
      type: "socket.attached",
      socketGeneration: 2,
      elapsedMs: 9,
    });
    expect(
      reattached.commands.filter(
        (command) => command.type === "request_response",
      ),
    ).toHaveLength(0);
    expect(
      reattached.commands.filter(
        (command) =>
          command.type === "telemetry" &&
          command.name === "onboarding.coverage.started",
      ),
    ).toHaveLength(0);
  });

  test("complete greeting trace reaches collecting and cannot duplicate on reattach", () => {
    let lifecycle = createOnboardingLifecycle(callId, businessName);
    ({ lifecycle } = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 1,
      elapsedMs: 0,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey: `greeting:${callId}`,
      socketGeneration: 1,
      elapsedMs: 1,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.created",
      responseId: "response-greeting",
      intentKey: `greeting:${callId}`,
      socketGeneration: 1,
      elapsedMs: 2,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.transcript.done",
      responseId: "response-greeting",
      transcript:
        "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
      socketGeneration: 1,
      elapsedMs: 3,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.output_audio.done",
      responseId: "response-greeting",
      socketGeneration: 1,
      elapsedMs: 4,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.done",
      responseId: "response-greeting",
      socketGeneration: 1,
      elapsedMs: 5,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "output_audio_buffer.stopped",
      responseId: "response-greeting",
      socketGeneration: 1,
      elapsedMs: 6,
    }));

    expect(lifecycle.phase).toBe("collecting");
    expect(lifecycle.responseIntents[`greeting:${callId}`]).toMatchObject({
      purpose: "greeting",
      state: "terminal",
      responseId: "response-greeting",
    });
    expect(lifecycle.coverage.nextQuestion?.questionPt).toBe(
      "Quais serviços sua empresa oferece?",
    );

    const reattached = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 2,
      elapsedMs: 6,
    });
    expect(
      reattached.commands.filter((command) =>
        command.type === "request_response"
      ),
    ).toHaveLength(0);
  });

  test("a prior-generation sent intent without response acknowledgement blocks reattach for every application speech purpose", () => {
    for (const [purpose, intentKey, phase] of [
      ["greeting", `greeting:${callId}`, "greeting"],
      ["summary", "summary:digest-sent", "summary_speaking"],
      ["final_signoff", "final-signoff:approval-sent", "final_signoff_speaking"],
      ["tool_continuation", "tool-batch:response-sent:batch-sent", "collecting"],
      ["recovery", "recovery:owner_turn_completed_without_tool:sent", "follow_up"],
    ] as const) {
      let lifecycle = createOnboardingLifecycle(callId, businessName);
      ({ lifecycle } = step(lifecycle, {
        type: "socket.attached",
        socketGeneration: 1,
        elapsedMs: 0,
      }));
      lifecycle.phase = phase;
      if (!lifecycle.responseIntents[intentKey])
        lifecycle.responseIntents[intentKey] = {
          intentKey,
          purpose,
          state: "queued",
        };
      ({ lifecycle } = step(lifecycle, {
        type: "response.intent_sent",
        intentKey,
        socketGeneration: 1,
        elapsedMs: 1,
      }));
      expect(lifecycle.responseIntents[intentKey]).toMatchObject({
        state: "sent",
        sentSocketGeneration: 1,
      });

      const reattached = step(lifecycle, {
        type: "socket.attached",
        socketGeneration: 2,
        elapsedMs: 2,
      });

      expect(reattached.lifecycle.phase).toBe("blocked");
      expect(reattached.commands.filter((command) => command.type === "block"))
        .toEqual([
          expect.objectContaining({
            type: "block",
            code: "response_intent_ack_indeterminate",
          }),
        ]);
      expect(reattached.commands.some((command) =>
        command.type === "request_response"
      )).toBe(false);
    }
  });

  test("an acknowledged sent intent may reattach, but a second response identity for the same intent blocks", () => {
    let lifecycle = startCollecting();
    const intentKey = "summary:digest-response-identity";
    lifecycle.phase = "summary_speaking";
    lifecycle.responseIntents[intentKey] = {
      intentKey,
      purpose: "summary",
      state: "queued",
    };
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 1,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.created",
      responseId: "response-summary-first",
      intentKey,
      socketGeneration: 1,
      elapsedMs: 2,
    }));
    const reattached = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 2,
      elapsedMs: 3,
    });
    expect(reattached.lifecycle.phase).not.toBe("blocked");

    const duplicate = step(reattached.lifecycle, {
      type: "response.created",
      responseId: "response-summary-second",
      intentKey,
      socketGeneration: 2,
      elapsedMs: 4,
    });
    expect(duplicate.lifecycle.phase).toBe("blocked");
    expect(duplicate.commands).toContainEqual(expect.objectContaining({
      type: "block",
      code: "response_intent_response_mismatch",
    }));
  });

  test("greeting proof fails closed for missing, duplicated, foreign, text-only, or interrupted evidence", () => {
    const exact =
      "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?";
    const cases: Array<{
      name: string;
      transcript?: string;
      transcriptDelta?: string;
      transcriptResponseId?: string;
      audioDone?: boolean;
      playbackStopped?: boolean;
      interrupted?: boolean;
    }> = [
      {
        name: "missing question",
        transcript:
          "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing.",
        audioDone: true,
        playbackStopped: true,
      },
      {
        name: "duplicated greeting",
        transcript: `${exact} ${exact}`,
        audioDone: true,
        playbackStopped: true,
      },
      {
        name: "question before greeting",
        transcript:
          "Quais serviços sua empresa oferece? Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing.",
        audioDone: true,
        playbackStopped: true,
      },
      {
        name: "foreign transcript",
        transcript: exact,
        transcriptResponseId: "response-other",
        audioDone: true,
        playbackStopped: true,
      },
      { name: "text only", transcript: exact, playbackStopped: true },
      {
        name: "nonterminal transcript delta",
        transcriptDelta: exact,
        audioDone: true,
        playbackStopped: true,
      },
      { name: "audio without playback", transcript: exact, audioDone: true },
      {
        name: "interrupted",
        transcript: exact,
        audioDone: true,
        playbackStopped: true,
        interrupted: true,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      let lifecycle = createOnboardingLifecycle(`${callId}-${index}`, businessName);
      const intentKey = `greeting:${lifecycle.callId}`;
      ({ lifecycle } = step(lifecycle, {
        type: "socket.attached",
        socketGeneration: 1,
        elapsedMs: 0,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.intent_sent",
        intentKey,
        socketGeneration: 1,
        elapsedMs: 1,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.created",
        responseId: "response-greeting",
        intentKey,
        socketGeneration: 1,
        elapsedMs: 2,
      }));
      if (testCase.transcript)
        ({ lifecycle } = step(lifecycle, {
          type: "response.transcript.done",
          responseId: testCase.transcriptResponseId ?? "response-greeting",
          transcript: testCase.transcript,
          socketGeneration: 1,
          elapsedMs: 3,
        }));
      if (testCase.transcriptDelta)
        ({ lifecycle } = step(lifecycle, {
          type: "response.transcript.delta",
          responseId: "response-greeting",
          delta: testCase.transcriptDelta,
          socketGeneration: 1,
          elapsedMs: 3,
        }));
      if (testCase.audioDone)
        ({ lifecycle } = step(lifecycle, {
          type: "response.output_audio.done",
          responseId: "response-greeting",
          socketGeneration: 1,
          elapsedMs: 4,
        }));
      if (testCase.interrupted)
        ({ lifecycle } = step(lifecycle, {
          type: "response.audio_interrupted",
          responseId: "response-greeting",
          socketGeneration: 1,
          elapsedMs: 5,
        }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.done",
        responseId: "response-greeting",
        socketGeneration: 1,
        elapsedMs: 6,
      }));
      if (testCase.playbackStopped)
        ({ lifecycle } = step(lifecycle, {
          type: "output_audio_buffer.stopped",
          responseId: "response-greeting",
          socketGeneration: 1,
          elapsedMs: 7,
        }));

      expect(lifecycle.phase, testCase.name).toBe("greeting");
    }
  });

  test("greeting proof rejects a wrong business identity or extra prose inside the keyed opening", () => {
    for (const transcript of [
      "Oi! Aqui é o Ligou, agente de inteligência artificial da Empresa Errada. Quais serviços sua empresa oferece?",
      "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing e vou explicar o processo. Quais serviços sua empresa oferece?",
    ]) {
      let lifecycle = createOnboardingLifecycle(callId, businessName);
      const intentKey = `greeting:${callId}`;
      for (const event of [
        {
          type: "socket.attached" as const,
          socketGeneration: 1,
          elapsedMs: 0,
        },
        {
          type: "response.intent_sent" as const,
          intentKey,
          socketGeneration: 1,
          elapsedMs: 1,
        },
        {
          type: "response.created" as const,
          responseId: "response-greeting-identity",
          intentKey,
          socketGeneration: 1,
          elapsedMs: 2,
        },
        {
          type: "response.transcript.done" as const,
          responseId: "response-greeting-identity",
          transcript,
          socketGeneration: 1,
          elapsedMs: 3,
        },
        {
          type: "response.output_audio.done" as const,
          responseId: "response-greeting-identity",
          socketGeneration: 1,
          elapsedMs: 4,
        },
        {
          type: "response.done" as const,
          responseId: "response-greeting-identity",
          socketGeneration: 1,
          elapsedMs: 5,
        },
        {
          type: "output_audio_buffer.stopped" as const,
          responseId: "response-greeting-identity",
          socketGeneration: 1,
          elapsedMs: 6,
        },
      ]) ({ lifecycle } = step(lifecycle, event));
      expect(lifecycle.phase).toBe("greeting");
    }
  });

  test("caller speech after response.done but before greeting playback stop invalidates the opening proof", () => {
    let lifecycle = createOnboardingLifecycle(callId, businessName);
    const intentKey = `greeting:${callId}`;
    for (const event of [
      {
        type: "socket.attached" as const,
        socketGeneration: 1,
        elapsedMs: 0,
      },
      {
        type: "response.intent_sent" as const,
        intentKey,
        socketGeneration: 1,
        elapsedMs: 1,
      },
      {
        type: "response.created" as const,
        responseId: "response-greeting",
        intentKey,
        socketGeneration: 1,
        elapsedMs: 2,
      },
      {
        type: "response.transcript.done" as const,
        responseId: "response-greeting",
        transcript:
          "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?",
        socketGeneration: 1,
        elapsedMs: 3,
      },
      {
        type: "response.output_audio.done" as const,
        responseId: "response-greeting",
        socketGeneration: 1,
        elapsedMs: 4,
      },
      {
        type: "response.done" as const,
        responseId: "response-greeting",
        socketGeneration: 1,
        elapsedMs: 5,
      },
      {
        type: "response.audio_interrupted" as const,
        responseId: "response-greeting",
        socketGeneration: 1,
        elapsedMs: 6,
      },
      {
        type: "caller.speech_started" as const,
        turnId: "caller-barge-in",
        socketGeneration: 1,
        elapsedMs: 7,
      },
      {
        type: "output_audio_buffer.stopped" as const,
        responseId: "response-greeting",
        socketGeneration: 1,
        elapsedMs: 8,
      },
    ]) ({ lifecycle } = step(lifecycle, event));

    expect(lifecycle.phase).toBe("greeting");
    expect(lifecycle.responseIntents[`greeting:${callId}:retry:1`])
      .toMatchObject({ state: "queued" });
  });

  test("cannot admit an onboarding fact before the keyed greeting proof", () => {
    let lifecycle = createOnboardingLifecycle(callId, businessName);
    ({ lifecycle } = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 1,
      elapsedMs: 0,
    }));
    const attempted = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-before-greeting",
      name: "record_interview_answer",
      args: {
        topic: "area",
        field: "area.coverage",
        disposition: "answered",
        rule_text: "Atende Irvine.",
        structured: {
          value: {
            localities: [{
              display_name: "Irvine",
              country_code: "US",
              region_code: "CA",
            }],
          },
        },
        owner_words: "Atendemos Irvine.",
      },
      providerResponseId: "response-before-greeting",
      batchHash: "batch-before-greeting",
      socketGeneration: 1,
      elapsedMs: 1,
    });

    expect(attempted.lifecycle.phase).toBe("blocked");
    expect(attempted.lifecycle.toolOutbox).toEqual({});
    expect(attempted.commands.some((command) => command.type === "persist_fact"))
      .toBe(false);
  });

  test("does not prepare or request a summary before typed coverage is complete", () => {
    const { lifecycle, commands } = step(startCollecting(), {
      type: "coverage.changed",
      revision: 4,
      digest: "digest-4",
      complete: false,
      missing: [{ field: "area.coverage" }],
      ambiguous: [],
      answered: [{ field: "business.customer_types" }],
      nextQuestion: {
        field: "area.coverage",
        questionPt: "Quais cidades vocês atendem?",
      },
      elapsedMs: 10,
    });

    expect(lifecycle.phase).toBe("collecting");
    expect(commandTypes(commands)).not.toContain("prepare_summary");
    expect(summaryCommands(commands)).toHaveLength(0);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "telemetry",
        name: "onboarding.field.answered",
        outcome: "business.customer_types",
      }),
    );

    const premature = step(lifecycle, {
      type: "snapshot.loaded",
      result: {
        ok: true,
        receiptId: "premature",
        revision: 4,
        digest: "digest-4",
        coverage: createCoverage({ tenantId: "tenant-1", callId }),
        rules: [],
        requiredAnchors: [],
        durationMs: 1,
      },
      elapsedMs: 11,
    });
    expect(premature.lifecycle.phase).toBe("blocked");
    expect(summaryCommands(premature.commands)).toHaveLength(0);
  });

  for (const code of [
    "timeout",
    "query_error",
    "empty",
    "coverage_incomplete",
    "changed",
  ] as const) {
    test(`blocks a ${code} snapshot with zero response intent`, () => {
      const ready = coverageReady();
      expect(commandTypes(ready.commands)).toContain("prepare_summary");
      const failed = step(ready.lifecycle, {
        type: "snapshot.loaded",
        result: {
          ok: false,
          code,
          safeDetail: `safe ${code}`,
          durationMs: 99,
        },
        elapsedMs: 140,
      });
      expect(failed.lifecycle.phase).toBe("blocked");
      expect(failed.commands.some((command) => command.type === "block")).toBe(
        true,
      );
      expect(
        failed.commands.some((command) => command.type === "request_response"),
      ).toBe(false);
      expect(
        failed.commands.find(
          (command) =>
            command.type === "telemetry" &&
            command.name === "onboarding.snapshot.blocked",
        ),
      ).toMatchObject({ errorCode: code, elapsedMs: 99 });
    });
  }

  test("requires transcript anchors, confirmation, audio done, response done, and playback stopped", () => {
    const starting = beginSummary();
    const proofs: OnboardingEvent[] = [
      {
        type: "response.transcript.done",
        responseId: "response-summary-41",
        transcript: validSummaryTranscript(),
        socketGeneration: 1,
        elapsedMs: 60,
      },
      {
        type: "response.output_audio.done",
        responseId: "response-summary-41",
        socketGeneration: 1,
        elapsedMs: 61,
      },
      {
        type: "response.done",
        responseId: "response-summary-41",
        socketGeneration: 1,
        elapsedMs: 62,
      },
      {
        type: "output_audio_buffer.stopped",
        responseId: "response-summary-41",
        socketGeneration: 1,
        elapsedMs: 63,
      },
    ];

    for (let omitted = 0; omitted < proofs.length; omitted += 1) {
      let lifecycle = starting;
      for (const [index, proof] of proofs.entries()) {
        if (index !== omitted) ({ lifecycle } = step(lifecycle, proof));
      }
      expect(lifecycle.phase).toBe("summary_speaking");
    }

    let wrongResponse = starting;
    ({ lifecycle: wrongResponse } = step(wrongResponse, {
      type: "response.transcript.done",
      responseId: "response-other",
      transcript: validSummaryTranscript(),
      socketGeneration: 1,
      elapsedMs: 59,
    }));
    expect(wrongResponse.summary?.transcript).toBe("");
  });

  test("rejects a text-only, anchor-missing, non-question, or process-narrated summary", () => {
    const invalidTranscripts = [
      "Área: Irvine. Horário: segunda a sexta, 08:00 às 18:00. Você confirma?",
      "Área: Irvine. Horário: segunda a sexta, 08:00 às 18:00. Segurança: ligar 911 em risco imediato.",
      `Deixe-me verificar. ${validSummaryTranscript()}`,
    ];
    for (const transcript of invalidTranscripts) {
      let lifecycle = beginSummary();
      for (const event of [
        {
          type: "response.transcript.done",
          responseId: "response-summary-41",
          transcript,
          socketGeneration: 1,
          elapsedMs: 60,
        },
        {
          type: "response.output_audio.done",
          responseId: "response-summary-41",
          socketGeneration: 1,
          elapsedMs: 61,
        },
        {
          type: "response.done",
          responseId: "response-summary-41",
          socketGeneration: 1,
          elapsedMs: 62,
        },
        {
          type: "output_audio_buffer.stopped",
          responseId: "response-summary-41",
          socketGeneration: 1,
          elapsedMs: 63,
        },
      ] as OnboardingEvent[]) ({ lifecycle } = step(lifecycle, event));
      expect(lifecycle.phase).toBe("summary_speaking");
      expect(lifecycle.summary?.validated).toBe(false);
    }
  });

  test("accepts approval only from a fresh post-playback caller turn and rejects thanks or farewell", () => {
    let lifecycle = finishSummary();
    ({ lifecycle } = step(lifecycle, {
      type: "caller.transcript.completed",
      turnId: "not-fresh",
      transcript: "Aprovado",
      socketGeneration: 1,
      elapsedMs: 65,
    }));
    expect(lifecycle.approvalCandidate).toBeUndefined();

    ({ lifecycle } = step(lifecycle, {
      type: "caller.speech_started",
      turnId: "ambiguous-turn",
      socketGeneration: 1,
      elapsedMs: 66,
    }));
    const ambiguous = step(lifecycle, {
      type: "caller.transcript.completed",
      turnId: "ambiguous-turn",
      transcript: "Obrigado, tchau.",
      socketGeneration: 1,
      elapsedMs: 67,
    });
    expect(ambiguous.lifecycle.phase).toBe("awaiting_owner_approval");
    expect(ambiguous.lifecycle.approvalCandidate).toBeUndefined();

    const tool = step(ambiguous.lifecycle, {
      type: "tool.called",
      toolCallId: "approval-without-proof",
      name: "approve_onboarding_summary",
      args: { owner_words: "Obrigado, tchau." },
      providerResponseId: "response-approval",
      batchHash: "approval-batch",
      socketGeneration: 1,
      elapsedMs: 68,
    });
    expect(commandTypes(tool.commands)).not.toContain("persist_approval");
  });

  test("an approval tool correlated to a fresh turn waits for transcription and persists the exact transcript authority", () => {
    for (const [modelWords, transcript] of [
      ["Aprovado", "Aprovado."],
      ["Confirmo", "Está tudo correto!"],
    ] as const) {
      let lifecycle = finishSummary();
      ({ lifecycle } = step(lifecycle, {
        type: "caller.speech_started",
        turnId: "turn-approval-race",
        socketGeneration: 1,
        elapsedMs: 70,
      }));
      const tool = step(lifecycle, {
        type: "tool.called",
        toolCallId: "approval-tool-race",
        name: "approve_onboarding_summary",
        args: { owner_words: modelWords },
        providerResponseId: "response-approval-race",
        batchHash: "approval-race-batch",
        callerTurnId: "turn-approval-race",
        socketGeneration: 1,
        elapsedMs: 71,
      });
      lifecycle = tool.lifecycle;
      expect(lifecycle.toolOutbox["approval-tool-race"]).toMatchObject({
        state: "running",
        approvalTurnId: "turn-approval-race",
      });
      expect(tool.commands.some((command) =>
        command.type === "persist_approval" ||
        command.type === "resend_output"
      )).toBe(false);

      const transcribed = step(lifecycle, {
        type: "caller.transcript.completed",
        turnId: "turn-approval-race",
        transcript,
        socketGeneration: 1,
        elapsedMs: 72,
      });
      expect(transcribed.lifecycle.phase).toBe("approval_persisting");
      expect(transcribed.commands.filter((command) =>
        command.type === "persist_approval"
      )).toEqual([
        expect.objectContaining({
          toolCallId: "approval-tool-race",
          ownerWords: transcript,
        }),
      ]);
    }
  });

  test("correction or ambiguity after a pending approval tool rejects deterministically without persistence", () => {
    for (const [transcript, expectedPhase] of [
      ["Não, está errado.", "collecting"],
      ["Obrigado.", "awaiting_owner_approval"],
    ] as const) {
      let lifecycle = finishSummary();
      ({ lifecycle } = step(lifecycle, {
        type: "caller.speech_started",
        turnId: "turn-approval-rejected",
        socketGeneration: 1,
        elapsedMs: 70,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "tool.called",
        toolCallId: "approval-tool-rejected",
        name: "approve_onboarding_summary",
        args: { owner_words: "Aprovado" },
        providerResponseId: "response-approval-rejected",
        batchHash: "approval-rejected-batch",
        callerTurnId: "turn-approval-rejected",
        socketGeneration: 1,
        elapsedMs: 71,
      }));
      const transcribed = step(lifecycle, {
        type: "caller.transcript.completed",
        turnId: "turn-approval-rejected",
        transcript,
        socketGeneration: 1,
        elapsedMs: 72,
      });
      expect(transcribed.lifecycle.phase).toBe(expectedPhase);
      expect(transcribed.commands.some((command) =>
        command.type === "persist_approval"
      )).toBe(false);
      expect(transcribed.lifecycle.toolOutbox["approval-tool-rejected"])
        .toMatchObject({ state: "executed" });
      expect(transcribed.commands).toContainEqual(expect.objectContaining({
        type: "resend_output",
        toolCallId: "approval-tool-rejected",
      }));
    }
  });

  test("two approval tools for one turn or an uncorrelated approval tool fail closed", () => {
    let lifecycle = finishSummary();
    ({ lifecycle } = step(lifecycle, {
      type: "caller.speech_started",
      turnId: "turn-approval-unique",
      socketGeneration: 1,
      elapsedMs: 70,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.called",
      toolCallId: "approval-tool-first",
      name: "approve_onboarding_summary",
      args: { owner_words: "Aprovado" },
      providerResponseId: "response-approval-unique",
      batchHash: "approval-unique-batch",
      callerTurnId: "turn-approval-unique",
      socketGeneration: 1,
      elapsedMs: 71,
    }));
    const duplicate = step(lifecycle, {
      type: "tool.called",
      toolCallId: "approval-tool-second",
      name: "approve_onboarding_summary",
      args: { owner_words: "Confirmo" },
      providerResponseId: "response-approval-unique",
      batchHash: "approval-unique-batch",
      callerTurnId: "turn-approval-unique",
      socketGeneration: 1,
      elapsedMs: 72,
    });
    expect(duplicate.lifecycle.phase).toBe("blocked");
    expect(duplicate.lifecycle.toolOutbox["approval-tool-second"])
      .toBeUndefined();

    lifecycle = finishSummary();
    const uncorrelated = step(lifecycle, {
      type: "tool.called",
      toolCallId: "approval-tool-uncorrelated",
      name: "approve_onboarding_summary",
      args: { owner_words: "Aprovado" },
      providerResponseId: "response-approval-uncorrelated",
      batchHash: "approval-uncorrelated-batch",
      socketGeneration: 1,
      elapsedMs: 73,
    });
    expect(uncorrelated.lifecycle.phase).toBe("blocked");
    expect(uncorrelated.lifecycle.toolOutbox["approval-tool-uncorrelated"])
      .toBeUndefined();
  });

  test("a correction invalidates the old summary revision and returns to collecting", () => {
    let lifecycle = finishSummary();
    ({ lifecycle } = step(lifecycle, {
      type: "caller.speech_started",
      turnId: "correction-turn",
      socketGeneration: 1,
      elapsedMs: 70,
    }));
    const corrected = step(lifecycle, {
      type: "caller.transcript.completed",
      turnId: "correction-turn",
      transcript: "Não está correto: o horário fecha às 17:00.",
      socketGeneration: 1,
      elapsedMs: 71,
    });
    expect(corrected.lifecycle.phase).toBe("collecting");
    expect(corrected.lifecycle.summary).toBeUndefined();
    expect(corrected.lifecycle.coverage.complete).toBe(false);
    expect(corrected.lifecycle.invalidatedSummaryRevision).toBe(41);
    expect(commandTypes(corrected.commands)).not.toContain("persist_approval");
  });

  test("treats explicit negative assent as a correction and never reuses an old caller turn", () => {
    let lifecycle = finishSummary();
    ({ lifecycle } = step(lifecycle, {
      type: "caller.speech_started",
      turnId: "negative-turn",
      socketGeneration: 1,
      elapsedMs: 70,
    }));
    const negative = step(lifecycle, {
      type: "caller.transcript.completed",
      turnId: "negative-turn",
      transcript: "Não aprovado, o horário está incorreto.",
      socketGeneration: 1,
      elapsedMs: 71,
    });
    expect(negative.lifecycle.phase).toBe("collecting");
    expect(negative.lifecycle.approvalCandidate).toBeUndefined();
    expect(negative.lifecycle.freshCallerTurnIds).toEqual([]);
  });

  test("does not request a signoff before a matching immutable approval receipt", () => {
    const persisting = approvalPersisting();
    expect(persisting.lifecycle.phase).toBe("approval_persisting");
    expect(commandTypes(persisting.commands)).toContain("persist_approval");
    expect(commandTypes(persisting.commands)).not.toContain("request_signoff");

    const mismatched = step(persisting.lifecycle, {
      type: "approval.persisted",
      toolCallId: "approval-tool-1",
      approvalReceiptId: "approval-receipt-wrong",
      coverageReceiptId: "coverage-receipt-41",
      revision: 40,
      digest: "digest-40",
      output: "{}",
      resultHash: "wrong-result",
      elapsedMs: 73,
    });
    expect(mismatched.lifecycle.phase).toBe("blocked");
    expect(commandTypes(mismatched.commands)).not.toContain("request_signoff");
  });

  test("requests one approval-bound signoff only after approval persistence and output acknowledgement", () => {
    let lifecycle = approvalPersisting().lifecycle;
    let result = step(lifecycle, {
      type: "approval.persisted",
      toolCallId: "approval-tool-1",
      approvalReceiptId: "approval-receipt-1",
      coverageReceiptId: "coverage-receipt-41",
      revision: 41,
      digest: "digest-41",
      output: JSON.stringify({ status: "recorded" }),
      resultHash: "approval-result-hash",
      elapsedMs: 74,
    });
    lifecycle = result.lifecycle;
    expect(commandTypes(result.commands)).toEqual(
      expect.arrayContaining(["resend_output", "telemetry"]),
    );
    expect(commandTypes(result.commands)).not.toContain("request_signoff");

    ({ lifecycle } = step(
      lifecycle,
      outputSentEvent(lifecycle, "approval-tool-1", 1, 75),
    ));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.batch_closed",
      providerResponseId: "response-approval-tool",
      batchHash: "approval-batch-hash",
      toolCallIds: ["approval-tool-1"],
      elapsedMs: 75,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.done",
      responseId: "response-approval-tool",
      socketGeneration: 1,
      elapsedMs: 75,
    }));
    result = step(lifecycle, {
      type: "tool.output_acked",
      toolCallId: "approval-tool-1",
      outputItemId: providerOutputItemId("approval-tool-1"),
      socketGeneration: 1,
      elapsedMs: 76,
    });
    expect(result.lifecycle.phase).toBe("final_signoff_speaking");
    expect(result.commands.filter((command) => command.type === "request_signoff"))
      .toHaveLength(1);
    expect(result.commands).toContainEqual(expect.objectContaining({
      type: "request_signoff",
      instructions:
        'Diga exatamente: "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória."',
    }));
    expect(
      result.commands.filter(
        (command) =>
          command.type === "request_response" &&
          command.intentKey === "final-signoff:approval-receipt-1",
      ),
    ).toHaveLength(1);
  });

  test("requests one hangup only after exact signoff transcript, audio, terminal response, and playback stop", () => {
    let lifecycle = signoffSpeaking();
    ({ lifecycle } = step(lifecycle, {
      type: "response.intent_sent",
      intentKey: "final-signoff:approval-receipt-1",
      socketGeneration: 1,
      elapsedMs: 77,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.created",
      responseId: "response-signoff",
      intentKey: "final-signoff:approval-receipt-1",
      socketGeneration: 1,
      elapsedMs: 78,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.transcript.done",
      responseId: "response-signoff",
      transcript:
        "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.",
      socketGeneration: 1,
      elapsedMs: 79,
    }));
    for (const event of [
      {
        type: "response.output_audio.done",
        responseId: "response-signoff",
        socketGeneration: 1,
        elapsedMs: 80,
      },
      {
        type: "response.done",
        responseId: "response-signoff",
        socketGeneration: 1,
        elapsedMs: 81,
      },
    ] as OnboardingEvent[]) {
      const result = step(lifecycle, event);
      lifecycle = result.lifecycle;
      expect(commandTypes(result.commands)).not.toContain("request_hangup");
    }
    const stopped = step(lifecycle, {
      type: "output_audio_buffer.stopped",
      responseId: "response-signoff",
      socketGeneration: 1,
      elapsedMs: 82,
    });
    expect(stopped.lifecycle.phase).toBe("ready_to_terminate");
    expect(
      stopped.commands.filter(
        (command) =>
          command.type === "request_hangup" &&
          command.intentKey === "hangup:approval-receipt-1",
      ),
    ).toHaveLength(1);
  });

  test("missing, empty, foreign, extra, or wrong final signoff transcript blocks with zero hangup", () => {
    const exact =
      "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.";
    const cases: Array<{
      name: string;
      transcript?: string;
      transcriptResponseId?: string;
    }> = [
      { name: "missing" },
      { name: "empty", transcript: "" },
      {
        name: "foreign",
        transcript: exact,
        transcriptResponseId: "response-signoff-foreign",
      },
      { name: "extra", transcript: `${exact} Obrigado.` },
      { name: "wrong", transcript: "Tudo certo, até logo." },
    ];
    for (const testCase of cases) {
      let lifecycle = signoffSpeaking();
      ({ lifecycle } = step(lifecycle, {
        type: "response.intent_sent",
        intentKey: "final-signoff:approval-receipt-1",
        socketGeneration: 1,
        elapsedMs: 77,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.created",
        responseId: "response-signoff-content",
        intentKey: "final-signoff:approval-receipt-1",
        socketGeneration: 1,
        elapsedMs: 78,
      }));
      if (testCase.transcript !== undefined)
        ({ lifecycle } = step(lifecycle, {
          type: "response.transcript.done",
          responseId: testCase.transcriptResponseId ??
            "response-signoff-content",
          transcript: testCase.transcript,
          socketGeneration: 1,
          elapsedMs: 79,
        }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.output_audio.done",
        responseId: "response-signoff-content",
        socketGeneration: 1,
        elapsedMs: 80,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.done",
        responseId: "response-signoff-content",
        socketGeneration: 1,
        elapsedMs: 81,
      }));
      const playback = step(lifecycle, {
        type: "output_audio_buffer.stopped",
        responseId: "response-signoff-content",
        socketGeneration: 1,
        elapsedMs: 82,
      });

      expect(playback.lifecycle.phase, testCase.name).toBe("blocked");
      expect(playback.commands.some((command) =>
        command.type === "request_hangup"
      ), testCase.name).toBe(false);
      expect(playback.commands).toContainEqual(expect.objectContaining({
        type: "block",
        code: "signoff_content_invalid",
      }));
    }
  });

  test("reattach before an interrupted authority response is terminal blocks for greeting, summary, and signoff", () => {
    for (const kind of ["greeting", "summary", "signoff"] as const) {
      const started = beginAuthoritySpeech(kind);
      const interrupted = step(started.lifecycle, {
        type: "response.audio_interrupted",
        responseId: started.responseId,
        socketGeneration: 1,
        elapsedMs: 90,
      });
      expect(interrupted.commands.some((command) =>
        command.type === "request_response"
      ), kind).toBe(false);
      const reattached = step(interrupted.lifecycle, {
        type: "socket.attached",
        socketGeneration: 2,
        elapsedMs: 91,
      });
      expect(reattached.lifecycle.phase, kind).toBe("blocked");
      expect(reattached.commands).toContainEqual(expect.objectContaining({
        type: "block",
        code: "authority_speech_terminal_indeterminate",
      }));
      expect(reattached.commands.some((command) =>
        command.type === "request_response"
      ), kind).toBe(false);
    }
  });

  test("an interrupted authority response queues one correlated retry only after terminal and a second interruption blocks", () => {
    for (const kind of ["greeting", "summary", "signoff"] as const) {
      const started = beginAuthoritySpeech(kind);
      let result = step(started.lifecycle, {
        type: "response.audio_interrupted",
        responseId: started.responseId,
        socketGeneration: 1,
        elapsedMs: 90,
      });
      expect(result.commands.some((command) =>
        command.type === "request_response"
      ), kind).toBe(false);
      result = step(result.lifecycle, {
        type: "response.done",
        responseId: started.responseId,
        socketGeneration: 1,
        elapsedMs: 91,
      });
      expect(result.commands.filter((command) =>
        command.type === "request_response" &&
        command.intentKey === started.retryKey
      ), kind).toHaveLength(1);
      expect(authorityProof(result.lifecycle, kind)).toMatchObject({
        attempt: 1,
        interrupted: false,
      });
      expect(authorityProof(result.lifecycle, kind)?.responseId).toBeUndefined();
      expect(result.commands.some((command) =>
        command.type === "persist_approval" ||
        command.type === "request_hangup"
      ), kind).toBe(false);

      let retryLifecycle = result.lifecycle;
      ({ lifecycle: retryLifecycle } = step(retryLifecycle, {
        type: "response.intent_sent",
        intentKey: started.retryKey,
        socketGeneration: 1,
        elapsedMs: 92,
      }));
      ({ lifecycle: retryLifecycle } = step(retryLifecycle, {
        type: "response.created",
        responseId: `response-${kind}-retry`,
        intentKey: started.retryKey,
        socketGeneration: 1,
        elapsedMs: 93,
      }));
      const secondInterruption = step(retryLifecycle, {
        type: "response.audio_interrupted",
        responseId: `response-${kind}-retry`,
        socketGeneration: 1,
        elapsedMs: 94,
      });
      expect(secondInterruption.lifecycle.phase, kind).toBe("blocked");
      expect(secondInterruption.commands).toContainEqual(expect.objectContaining({
        type: "block",
        code: "authority_speech_retry_exhausted",
      }));
      expect(secondInterruption.commands.some((command) =>
        command.type === "request_response" ||
        command.type === "request_hangup"
      ), kind).toBe(false);
    }
  });

  test("the single authority retry ignores old response events and can complete without duplicating approval or hangup", () => {
    for (const kind of ["greeting", "summary", "signoff"] as const) {
      const started = beginAuthoritySpeech(kind);
      let lifecycle = step(started.lifecycle, {
        type: "response.audio_interrupted",
        responseId: started.responseId,
        socketGeneration: 1,
        elapsedMs: 90,
      }).lifecycle;
      ({ lifecycle } = step(lifecycle, {
        type: "response.done",
        responseId: started.responseId,
        socketGeneration: 1,
        elapsedMs: 91,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "response.intent_sent",
        intentKey: started.retryKey,
        socketGeneration: 1,
        elapsedMs: 92,
      }));
      const retryResponseId = `response-${kind}-retry-success`;
      ({ lifecycle } = step(lifecycle, {
        type: "response.created",
        responseId: retryResponseId,
        intentKey: started.retryKey,
        socketGeneration: 1,
        elapsedMs: 93,
      }));

      const afterLateOld = step(lifecycle, {
        type: "output_audio_buffer.stopped",
        responseId: started.responseId,
        socketGeneration: 1,
        elapsedMs: 94,
      });
      lifecycle = afterLateOld.lifecycle;
      expect(authorityProof(lifecycle, kind)?.responseId).toBe(retryResponseId);
      expect(afterLateOld.commands.some((command) =>
        command.type === "request_hangup"
      ), kind).toBe(false);

      const transcript = kind === "greeting"
        ? "Oi! Aqui é o Ligou, agente de inteligência artificial da Rocha Plumbing. Quais serviços sua empresa oferece?"
        : kind === "summary"
          ? validSummaryTranscript()
          : "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.";
      const completionEvents: OnboardingEvent[] = [
        {
          type: "response.transcript.done",
          responseId: retryResponseId,
          transcript,
          socketGeneration: 1,
          elapsedMs: 95,
        },
        {
          type: "response.output_audio.done",
          responseId: retryResponseId,
          socketGeneration: 1,
          elapsedMs: 96,
        },
        {
          type: "response.done",
          responseId: retryResponseId,
          socketGeneration: 1,
          elapsedMs: 97,
        },
        {
          type: "output_audio_buffer.stopped",
          responseId: retryResponseId,
          socketGeneration: 1,
          elapsedMs: 98,
        },
      ];
      const completionCommands: OnboardingCommand[] = [];
      for (const event of completionEvents) {
        const completed = step(lifecycle, event);
        lifecycle = completed.lifecycle;
        completionCommands.push(...completed.commands);
      }
      expect(lifecycle.phase, kind).toBe(
        kind === "greeting"
          ? "collecting"
          : kind === "summary"
            ? "awaiting_owner_approval"
            : "ready_to_terminate",
      );
      expect(completionCommands.filter((command) =>
        command.type === "request_hangup"
      ), kind).toHaveLength(kind === "signoff" ? 1 : 0);
      expect(completionCommands.some((command) =>
        command.type === "persist_approval"
      ), kind).toBe(false);
    }
  });

  test("refuses every end_session attempt in every preterminal phase without a count bypass", () => {
    const phases: OnboardingLifecycle["phase"][] = [
      "greeting",
      "collecting",
      "coverage_check",
      "follow_up",
      "snapshot_preparing",
      "summary_speaking",
      "awaiting_owner_approval",
      "approval_persisting",
      "final_signoff_speaking",
      "ready_to_terminate",
      "provider_terminating",
      "blocked",
    ];
    for (const phase of phases) {
      const lifecycle = { ...createOnboardingLifecycle(callId, businessName), phase };
      const refused = step(lifecycle, {
        type: "tool.called",
        toolCallId: `end-${phase}`,
        name: "end_session",
        args: {},
        providerResponseId: "response-end",
        batchHash: "end-batch",
        socketGeneration: 0,
        elapsedMs: 1,
      });
      expect(refused.lifecycle.phase).toBe(phase);
      if (phase === "blocked") {
        expect(refused.lifecycle).toBe(lifecycle);
        expect(commandTypes(refused.commands)).not.toContain("refuse_end_session");
        expect(refused.lifecycle.toolOutbox[`end-${phase}`]).toBeUndefined();
      } else {
        expect(commandTypes(refused.commands)).toContain("refuse_end_session");
      }
      expect(commandTypes(refused.commands)).not.toContain("request_hangup");
    }

    let lifecycle = startCollecting();
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const refused = step(lifecycle, {
        type: "tool.called",
        toolCallId: `end-${attempt}`,
        name: "end_session",
        args: { attempt },
        providerResponseId: "response-end-many",
        batchHash: "end-many-batch",
        socketGeneration: 1,
        elapsedMs: attempt,
      });
      lifecycle = refused.lifecycle;
      expect(commandTypes(refused.commands)).not.toContain("request_hangup");
    }
    expect(lifecycle.phase).toBe("collecting");
  });

  test("treats every event after closed as a state no-op plus invariant telemetry", () => {
    const closed = {
      ...createOnboardingLifecycle(callId, businessName),
      phase: "closed" as const,
      providerTerminationConfirmed: true,
    };
    const result = step(closed, {
      type: "response.done",
      responseId: "response-after-close",
      socketGeneration: 0,
      elapsedMs: 10_000,
    });
    expect(result.lifecycle).toEqual(closed);
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        type: "telemetry",
        name: "invariant.violation",
        outcome: "event_after_closed",
      }),
    );
  });
});

describe("reconnect-safe onboarding tool outbox", () => {
  const factArgs = {
    topic: "precos",
    field: "service.price_target",
    subject: "limpeza_de_ralo",
    disposition: "answered",
    rule_text: "Preço sugerido: 120.",
    structured: { value: 120 },
    owner_words: "cento e vinte",
  };

  test("moves running to executed to output_pending to output_acked and resends without rerunning", () => {
    let lifecycle = startCollecting();
    let result = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-price-1",
      name: "record_interview_answer",
      args: factArgs,
      providerResponseId: "response-price",
      batchHash: "price-batch-hash",
      socketGeneration: 1,
      elapsedMs: 10,
    });
    lifecycle = result.lifecycle;
    expect(lifecycle.toolOutbox["tool-price-1"]?.state).toBe("running");
    expect(commandTypes(result.commands)).toContain("persist_fact");

    result = step(lifecycle, {
      type: "tool.executed",
      toolCallId: "tool-price-1",
      output: JSON.stringify({ status: "recorded" }),
      resultHash: "result-hash-1",
      elapsedMs: 11,
    });
    lifecycle = result.lifecycle;
    expect(lifecycle.toolOutbox["tool-price-1"]?.state).toBe("executed");
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        type: "resend_output",
        toolCallId: "tool-price-1",
        outputItemId: lifecycle.toolOutbox["tool-price-1"]?.outputItemId,
        replay: false,
        delivery: "create",
      }),
    );

    ({ lifecycle } = step(
      lifecycle,
      outputSentEvent(lifecycle, "tool-price-1", 1, 12),
    ));
    expect(lifecycle.toolOutbox["tool-price-1"]?.state).toBe("output_pending");

    result = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 2,
      elapsedMs: 13,
    });
    lifecycle = result.lifecycle;
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        type: "resend_output",
        toolCallId: "tool-price-1",
        replay: true,
        delivery: "retrieve",
      }),
    );
    expect(commandTypes(result.commands)).not.toContain("persist_fact");

    result = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-price-1",
      name: "record_interview_answer",
      args: { ...factArgs },
      providerResponseId: "response-price",
      batchHash: "price-batch-hash",
      socketGeneration: 2,
      elapsedMs: 14,
    });
    lifecycle = result.lifecycle;
    expect(commandTypes(result.commands)).not.toContain("persist_fact");
    expect(result.commands).toContainEqual(
      expect.objectContaining({ type: "resend_output", replay: true }),
    );

    result = step(lifecycle, {
      type: "tool.output_acked",
      toolCallId: "tool-price-1",
      outputItemId: providerOutputItemId("tool-price-1"),
      socketGeneration: 2,
      elapsedMs: 15,
    });
    lifecycle = result.lifecycle;
    expect(lifecycle.toolOutbox["tool-price-1"]?.state).toBe("output_acked");
    const exactReplay = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-price-1",
      name: "record_interview_answer",
      args: { ...factArgs },
      providerResponseId: "response-price",
      batchHash: "price-batch-hash",
      socketGeneration: 2,
      elapsedMs: 16,
    });
    expect(commandTypes(exactReplay.commands)).not.toContain("persist_fact");
    expect(commandTypes(exactReplay.commands)).not.toContain("resend_output");
  });

  test("blocks a replayed provider tool ID when canonical args differ", () => {
    let lifecycle = startCollecting();
    ({ lifecycle } = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-price-1",
      name: "record_interview_answer",
      args: factArgs,
      providerResponseId: "response-price",
      batchHash: "price-batch-hash",
      socketGeneration: 1,
      elapsedMs: 10,
    }));
    const mismatch = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-price-1",
      name: "record_interview_answer",
      args: { ...factArgs, structured: { value: 90 } },
      providerResponseId: "response-price",
      batchHash: "price-batch-hash",
      socketGeneration: 1,
      elapsedMs: 11,
    });
    expect(mismatch.lifecycle.phase).toBe("blocked");
    expect(mismatch.commands).toContainEqual(
      expect.objectContaining({
        type: "block",
        code: "tool_args_mismatch",
        toolCallId: "tool-price-1",
      }),
    );
  });

  test("does not acknowledge an executed output before the adapter reports it sent", () => {
    let lifecycle = startCollecting();
    ({ lifecycle } = step(lifecycle, {
      type: "tool.called",
      toolCallId: "tool-strict-transition",
      name: "record_interview_answer",
      args: factArgs,
      providerResponseId: "response-strict-transition",
      batchHash: "strict-transition-hash",
      socketGeneration: 1,
      elapsedMs: 10,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.executed",
      toolCallId: "tool-strict-transition",
      output: "{}",
      resultHash: "strict-result",
      elapsedMs: 11,
    }));
    const prematureAck = step(lifecycle, {
      type: "tool.output_acked",
      toolCallId: "tool-strict-transition",
      outputItemId: providerOutputItemId("tool-strict-transition"),
      socketGeneration: 1,
      elapsedMs: 12,
    });
    expect(prematureAck.lifecycle.phase).toBe("blocked");
    expect(prematureAck.lifecycle.toolOutbox["tool-strict-transition"]?.state)
      .toBe("executed");
  });

  test("waits for every batch output acknowledgement and emits one stable continuation", () => {
    let lifecycle = startCollecting();
    for (const id of ["tool-1", "tool-2", "tool-3"]) {
      ({ lifecycle } = step(lifecycle, {
        type: "tool.called",
        toolCallId: id,
        name: "record_interview_answer",
        args: { ...factArgs, owner_words: id },
        providerResponseId: "response-three-prices",
        batchHash: "three-price-hash",
        socketGeneration: 1,
        elapsedMs: 10,
      }));
      ({ lifecycle } = step(lifecycle, {
        type: "tool.executed",
        toolCallId: id,
        output: JSON.stringify({ id }),
        resultHash: `result-${id}`,
        elapsedMs: 11,
      }));
      ({ lifecycle } = step(
        lifecycle,
        outputSentEvent(lifecycle, id, 1, 12),
      ));
    }
    ({ lifecycle } = step(lifecycle, {
      type: "tool.batch_closed",
      providerResponseId: "response-three-prices",
      batchHash: "three-price-hash",
      toolCallIds: ["tool-1", "tool-2", "tool-3"],
      elapsedMs: 13,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "coverage.changed",
      revision: 3,
      digest: "digest-3",
      complete: false,
      missing: [{ field: "area.coverage" }],
      ambiguous: [],
      nextQuestion: {
        field: "area.coverage",
        questionPt: "Quais cidades vocês atendem?",
      },
      elapsedMs: 14,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "response.done",
      responseId: "response-three-prices",
      socketGeneration: 1,
      elapsedMs: 15,
    }));
    for (const id of ["tool-1", "tool-2"]) {
      const partial = step(lifecycle, {
        type: "tool.output_acked",
        toolCallId: id,
        outputItemId: providerOutputItemId(id),
        socketGeneration: 1,
        elapsedMs: 16,
      });
      lifecycle = partial.lifecycle;
      expect(
        partial.commands.some((command) => command.type === "request_response"),
      ).toBe(false);
    }
    const complete = step(lifecycle, {
      type: "tool.output_acked",
      toolCallId: "tool-3",
      outputItemId: providerOutputItemId("tool-3"),
      socketGeneration: 1,
      elapsedMs: 17,
    });
    expect(
      complete.commands.filter((command) => command.type === "persist_followup"),
    ).toHaveLength(1);
    const persisted = step(complete.lifecycle, {
      type: "followup.persisted",
      sourceRevision: 3,
      revision: 4,
      digest: "digest-4-followup",
      field: "area.coverage",
      questionPt: "Quais cidades vocês atendem?",
      intentKey: "tool-batch:response-three-prices:three-price-hash",
      elapsedMs: 18,
    });
    expect(
      persisted.commands.filter(
        (command) =>
          command.type === "request_response" &&
          command.intentKey ===
            "tool-batch:response-three-prices:three-price-hash",
      ),
    ).toHaveLength(1);
  });
});

describe("canonical 7f58ee06 cadence", () => {
  test("emits zero summaries through price watchdog cadence and exactly one after complete snapshot", () => {
    let lifecycle = startCollecting();
    const beforeCoverage: OnboardingCommand[] = [];

    for (const [index, name] of ["desentupimento", "consulta", "emergência"].entries()) {
      const id = `price-${index + 1}`;
      let result = step(lifecycle, {
        type: "tool.called",
        toolCallId: id,
        name: "record_interview_answer",
        args: {
          topic: "precos",
          field: "service.price_target",
          subject: name,
          disposition: "answered",
          rule_text: `Preço sugerido para ${name}`,
          structured: { value: 100 + index * 20 },
          owner_words: `${100 + index * 20}`,
        },
        providerResponseId: "response-prices",
        batchHash: "three-prices",
        socketGeneration: 1,
        elapsedMs: 10 + index,
      });
      lifecycle = result.lifecycle;
      beforeCoverage.push(...result.commands);
      result = step(lifecycle, {
        type: "tool.executed",
        toolCallId: id,
        output: JSON.stringify({ status: "recorded" }),
        resultHash: `result-${id}`,
        elapsedMs: 20 + index,
      });
      lifecycle = result.lifecycle;
      beforeCoverage.push(...result.commands);
      ({ lifecycle } = step(
        lifecycle,
        outputSentEvent(lifecycle, id, 1, 30 + index),
      ));
      ({ lifecycle } = step(lifecycle, {
        type: "tool.output_acked",
        toolCallId: id,
        outputItemId: providerOutputItemId(id),
        socketGeneration: 1,
        elapsedMs: 40 + index,
      }));
    }
    ({ lifecycle } = step(lifecycle, {
      type: "tool.batch_closed",
      providerResponseId: "response-prices",
      batchHash: "three-prices",
      toolCallIds: ["price-1", "price-2", "price-3"],
      elapsedMs: 44,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "coverage.changed",
      revision: 3,
      digest: "digest-prices",
      complete: false,
      missing: [{ field: "area.coverage" }],
      ambiguous: [],
      nextQuestion: {
        field: "area.coverage",
        questionPt: "Quais cidades vocês atendem?",
      },
      elapsedMs: 45,
    }));
    const parentTerminal = step(lifecycle, {
      type: "response.done",
      responseId: "response-prices",
      socketGeneration: 1,
      elapsedMs: 46,
    });
    lifecycle = parentTerminal.lifecycle;
    beforeCoverage.push(...parentTerminal.commands);
    expect(
      parentTerminal.commands.filter((command) =>
        command.type === "persist_followup"
      ),
    ).toHaveLength(1);
    const durableFollowup = step(lifecycle, {
      type: "followup.persisted",
      sourceRevision: 3,
      revision: 4,
      digest: "digest-prices-followup",
      field: "area.coverage",
      questionPt: "Quais cidades vocês atendem?",
      intentKey: "tool-batch:response-prices:three-prices",
      elapsedMs: 47,
    });
    lifecycle = durableFollowup.lifecycle;
    beforeCoverage.push(...durableFollowup.commands);

    for (let interval = 1; interval <= 3; interval += 1) {
      let result = step(lifecycle, {
        type: "timer.elapsed",
        name: "legacy_recap_watchdog",
        elapsedMs: 1_200 * interval,
      });
      lifecycle = result.lifecycle;
      beforeCoverage.push(...result.commands);
      result = step(lifecycle, {
        type: "response.created",
        responseId: `short-promise-${interval}`,
        socketGeneration: 1,
        elapsedMs: 1_200 * interval + 1,
      });
      lifecycle = result.lifecycle;
      beforeCoverage.push(...result.commands);
      result = step(lifecycle, {
        type: "response.done",
        responseId: `short-promise-${interval}`,
        socketGeneration: 1,
        elapsedMs: 1_200 * interval + 2,
      });
      lifecycle = result.lifecycle;
      beforeCoverage.push(...result.commands);
    }

    for (const [revision, missing] of [
      [12, "schedule.business_hours"],
      [20, "emergency.safety_escalation"],
      [31, "policy.payment_estimate"],
    ] as const) {
      const result = step(lifecycle, {
        type: "coverage.changed",
        revision,
        digest: `digest-${revision}`,
        complete: false,
        missing: [{ field: missing }],
        ambiguous: [],
        elapsedMs: 5_000 + revision,
      });
      lifecycle = result.lifecycle;
      beforeCoverage.push(...result.commands);
    }

    expect(summaryCommands(beforeCoverage)).toHaveLength(0);
    expect(
      beforeCoverage.filter((command) => command.type === "prepare_summary"),
    ).toHaveLength(0);

    const complete = step(lifecycle, {
      type: "coverage.changed",
      revision: 41,
      digest: "digest-41",
      complete: true,
      missing: [],
      ambiguous: [],
      elapsedMs: 6_000,
    });
    expect(commandTypes(complete.commands)).toContain("prepare_summary");
    const afterSnapshot = snapshotReady(complete.lifecycle);
    expect(summaryCommands(afterSnapshot.commands)).toHaveLength(1);
    const duplicateSnapshot = snapshotReady(afterSnapshot.lifecycle);
    expect(summaryCommands(duplicateSnapshot.commands)).toHaveLength(0);
  });
});

describe("Task 4 review fixes", () => {
  const factArgs = {
    topic: "precos",
    field: "service.price_target",
    subject: "consulta",
    disposition: "answered",
    rule_text: "Preço sugerido: 120.",
    structured: { value: 120 },
    owner_words: "cento e vinte",
  };

  function admittedAndAckedTool() {
    let lifecycle = startCollecting();
    ({ lifecycle } = step(lifecycle, {
      type: "tool.called",
      toolCallId: "fact-review-1",
      name: "record_interview_answer",
      args: factArgs,
      providerResponseId: "response-review-fact",
      batchHash: "review-fact-batch",
      socketGeneration: 1,
      elapsedMs: 10,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.executed",
      toolCallId: "fact-review-1",
      output: "{}",
      resultHash: "review-result",
      elapsedMs: 11,
    }));
    ({ lifecycle } = step(
      lifecycle,
      outputSentEvent(lifecycle, "fact-review-1", 1, 12),
    ));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.output_acked",
      toolCallId: "fact-review-1",
      outputItemId: providerOutputItemId("fact-review-1"),
      socketGeneration: 1,
      elapsedMs: 13,
    }));
    return lifecycle;
  }

  test("complete coverage waits when an admitted call has no closed batch", () => {
    const completed = step(admittedAndAckedTool(), {
      type: "coverage.changed",
      revision: 41,
      digest: "digest-41",
      complete: true,
      missing: [],
      ambiguous: [],
      elapsedMs: 14,
    });
    expect(completed.lifecycle.phase).toBe("coverage_check");
    expect(commandTypes(completed.commands)).not.toContain("prepare_summary");
    expect(summaryCommands(completed.commands)).toHaveLength(0);
  });

  test("complete coverage waits through reattach until the closed batch parent response is terminal", () => {
    let lifecycle = admittedAndAckedTool();
    ({ lifecycle } = step(lifecycle, {
      type: "tool.batch_closed",
      providerResponseId: "response-review-fact",
      batchHash: "review-fact-batch",
      toolCallIds: ["fact-review-1"],
      elapsedMs: 14,
    }));
    let result = step(lifecycle, {
      type: "coverage.changed",
      revision: 41,
      digest: "digest-41",
      complete: true,
      missing: [],
      ambiguous: [],
      elapsedMs: 15,
    });
    lifecycle = result.lifecycle;
    expect(commandTypes(result.commands)).not.toContain("prepare_summary");

    result = step(lifecycle, {
      type: "socket.attached",
      socketGeneration: 2,
      elapsedMs: 16,
    });
    lifecycle = result.lifecycle;
    expect(commandTypes(result.commands)).not.toContain("prepare_summary");
    expect(lifecycle.phase).toBe("coverage_check");

    result = step(lifecycle, {
      type: "response.done",
      responseId: "response-review-fact",
      socketGeneration: 2,
      elapsedMs: 17,
    });
    expect(
      result.commands.filter(
        (command) =>
          command.type === "prepare_summary" &&
          command.revision === 41 &&
          command.digest === "digest-41",
      ),
    ).toHaveLength(1);
  });

  test("general Portuguese negation beats assent", () => {
    const negativeMatrix = [
      "Não confirmo esse resumo.",
      "Não está tudo correto.",
      "Isso não está tudo correto.",
      "não, confirmo",
      "Nunca confirmo esse resumo.",
      "Eu não posso confirmar.",
      "Jamais aprovo isso.",
      "Tampouco confirmo esse resumo.",
      "De jeito nenhum aprovo isso.",
    ];
    for (const [index, transcript] of negativeMatrix.entries()) {
      let lifecycle = finishSummary();
      const turnId = `negated-confirmation-${index}`;
      ({ lifecycle } = step(lifecycle, {
        type: "caller.speech_started",
        turnId,
        socketGeneration: 1,
        elapsedMs: 70,
      }));
      const negated = step(lifecycle, {
        type: "caller.transcript.completed",
        turnId,
        transcript,
        socketGeneration: 1,
        elapsedMs: 71,
      });
      expect(negated.lifecycle.phase).toBe("collecting");
      expect(negated.lifecycle.approvalCandidate).toBeUndefined();
    }

    const assentMatrix = [
      "Aprovado.",
      "Está tudo correto.",
      "Não tenho correções. Está tudo correto.",
    ];
    for (const [index, transcript] of assentMatrix.entries()) {
      let lifecycle = finishSummary();
      const turnId = `valid-confirmation-${index}`;
      ({ lifecycle } = step(lifecycle, {
        type: "caller.speech_started",
        turnId,
        socketGeneration: 1,
        elapsedMs: 72,
      }));
      const approved = step(lifecycle, {
        type: "caller.transcript.completed",
        turnId,
        transcript,
        socketGeneration: 1,
        elapsedMs: 73,
      });
      expect(approved.lifecycle.phase).toBe("awaiting_owner_approval");
      expect(approved.lifecycle.approvalCandidate).toMatchObject({
        turnId,
        ownerWords: transcript,
      });
    }
  });

  test("utterance-level refusal always overrides an assent phrase or earlier affirmative question", () => {
    const refusalMatrix = [
      "Está tudo correto? Não.",
      "Tudo certo? Jamais.",
      "De forma alguma aprovo esse resumo.",
      "De modo algum confirmo",
      "ESTÁ TUDO CORRETO?!   nÃo...",
      "tUdO CeRtO ?! JAMAIS!",
      "De   FORMA, alguma: APROVO esse resumo.",
      "de MODO ALGUM — CONFIRMO",
      "Em hipótese alguma aprovo esse resumo.",
      "De maneira alguma confirmo.",
      "De jeito algum aprovo.",
      "Negativo. Está tudo correto?",
      "Discordo; confirmo não.",
    ];
    for (const [index, transcript] of refusalMatrix.entries()) {
      let lifecycle = finishSummary();
      const turnId = `utterance-refusal-${index}`;
      ({ lifecycle } = step(lifecycle, {
        type: "caller.speech_started",
        turnId,
        socketGeneration: 1,
        elapsedMs: 70,
      }));
      const refused = step(lifecycle, {
        type: "caller.transcript.completed",
        turnId,
        transcript,
        socketGeneration: 1,
        elapsedMs: 71,
      });
      lifecycle = refused.lifecycle;
      expect(lifecycle.approvalCandidate).toBeUndefined();
      expect(lifecycle.consumedCallerTurnIds).toContain(turnId);
      expect(lifecycle.freshCallerTurnIds).not.toContain(turnId);

      const tool = step(lifecycle, {
        type: "tool.called",
        toolCallId: `refused-approval-tool-${index}`,
        name: "approve_onboarding_summary",
        args: { owner_words: transcript },
        providerResponseId: `response-refused-approval-${index}`,
        batchHash: `refused-approval-batch-${index}`,
        socketGeneration: 1,
        elapsedMs: 72,
      });
      expect(commandTypes(tool.commands)).not.toContain("persist_approval");
    }

    const validMatrix = [
      "Está tudo correto.",
      "Tudo certo.",
      "Confirmo.",
      "Aprovado.",
      "NÃO TENHO CORREÇÕES!!! Está tudo CORRETO.",
    ];
    for (const [index, transcript] of validMatrix.entries()) {
      let lifecycle = finishSummary();
      const turnId = `utterance-valid-${index}`;
      ({ lifecycle } = step(lifecycle, {
        type: "caller.speech_started",
        turnId,
        socketGeneration: 1,
        elapsedMs: 73,
      }));
      const approved = step(lifecycle, {
        type: "caller.transcript.completed",
        turnId,
        transcript,
        socketGeneration: 1,
        elapsedMs: 74,
      });
      expect(approved.lifecycle.approvalCandidate).toMatchObject({
        turnId,
        ownerWords: transcript,
      });
      expect(approved.lifecycle.consumedCallerTurnIds).toContain(turnId);
    }
  });

  test("a caller turn ID is consumed by its first completed transcript", () => {
    let lifecycle = finishSummary();
    ({ lifecycle } = step(lifecycle, {
      type: "caller.speech_started",
      turnId: "replayed-owner-turn",
      socketGeneration: 1,
      elapsedMs: 70,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "caller.transcript.completed",
      turnId: "replayed-owner-turn",
      transcript: "Obrigado.",
      socketGeneration: 1,
      elapsedMs: 71,
    }));
    const replay = step(lifecycle, {
      type: "caller.transcript.completed",
      turnId: "replayed-owner-turn",
      transcript: "Aprovado, está tudo correto.",
      socketGeneration: 1,
      elapsedMs: 72,
    });
    expect(replay.lifecycle.phase).toBe("awaiting_owner_approval");
    expect(replay.lifecycle.approvalCandidate).toBeUndefined();
    expect(replay.commands).toContainEqual(
      expect.objectContaining({
        type: "telemetry",
        name: "onboarding.approval.rejected",
        outcome: "not_fresh_after_summary_playback",
      }),
    );
  });

  test("matches factual anchors by normalized token boundaries", () => {
    const anchors = ["Preço público: 120", "Área: São José"];
    const numericSubstring = proveSummaryTranscript(
      beginSummaryWithAnchors(anchors),
      "Preço público: 1200. Área: São José. Você confirma que está correto?",
    );
    expect(numericSubstring.phase).toBe("summary_speaking");
    expect(numericSubstring.summary?.validated).toBe(false);

    const locationSubstring = proveSummaryTranscript(
      beginSummaryWithAnchors(anchors),
      "Preço público: 120. Área: São Joséville. Você confirma que está correto?",
    );
    expect(locationSubstring.phase).toBe("summary_speaking");
    expect(locationSubstring.summary?.validated).toBe(false);

    const punctuationAccentCaseVariant = proveSummaryTranscript(
      beginSummaryWithAnchors(anchors),
      "PRECO PUBLICO — 120! AREA / SAO JOSE. Voce confirma que esta correto?",
    );
    expect(punctuationAccentCaseVariant.phase).toBe(
      "awaiting_owner_approval",
    );
    expect(punctuationAccentCaseVariant.summary?.validated).toBe(true);
  });

  test("requires each subject-qualified service anchor even when values are identical", () => {
    const lifecycle = proveSummaryTranscript(
      beginSummaryWithAnchors([
        "Preço público (drain cleaning): 149",
        "Preço público (sewer cleaning): 149",
      ]),
      "Preço público (drain cleaning): 149. Você confirma que está correto?",
    );
    expect(lifecycle.summary?.validated).toBe(false);
    expect(lifecycle.phase).toBe("summary_speaking");
  });

  test("approval changed refreshes and prepares only the correlated latest snapshot", () => {
    let lifecycle = approvalPersisting().lifecycle;
    let result = step(lifecycle, {
      type: "approval.persistence_failed",
      toolCallId: "approval-tool-1",
      code: "changed",
      safeDetail: "coverage snapshot changed",
      elapsedMs: 73,
    });
    lifecycle = result.lifecycle;
    expect(commandTypes(result.commands)).not.toContain("prepare_summary");
    expect(lifecycle.toolOutbox["approval-tool-1"]?.state).toBe("executed");
    expect(result.commands).toContainEqual(
      expect.objectContaining({
        type: "resend_output",
        toolCallId: "approval-tool-1",
        outputItemId: lifecycle.toolOutbox["approval-tool-1"]?.outputItemId,
        replay: false,
      }),
    );
    const refresh = result.commands.find(
      (command) => (command as { type: string }).type === "refresh_snapshot",
    ) as unknown as { type: "refresh_snapshot"; requestId: string } | undefined;
    expect(refresh?.requestId).toBeString();

    ({ lifecycle } = step(
      lifecycle,
      outputSentEvent(lifecycle, "approval-tool-1", 1, 75),
    ));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.output_acked",
      toolCallId: "approval-tool-1",
      outputItemId: providerOutputItemId("approval-tool-1"),
      socketGeneration: 1,
      elapsedMs: 76,
    }));
    ({ lifecycle } = step(lifecycle, {
      type: "tool.batch_closed",
      providerResponseId: "response-approval-tool",
      batchHash: "approval-batch-hash",
      toolCallIds: ["approval-tool-1"],
      elapsedMs: 77,
    }));
    result = step(lifecycle, {
      type: "response.done",
      responseId: "response-approval-tool",
      socketGeneration: 1,
      elapsedMs: 78,
    });
    lifecycle = result.lifecycle;
    expect(
      result.commands.some(
        (command) =>
          command.type === "prepare_summary" && command.digest === "digest-41",
      ),
    ).toBe(false);

    const beforeStale = lifecycle;
    result = step(lifecycle, {
      type: "snapshot.refresh_loaded",
      requestId: "stale-refresh-request",
      result: authoritativeSnapshot(42, "digest-42"),
      elapsedMs: 79,
    } as OnboardingEvent);
    expect(result.lifecycle).toBe(beforeStale);
    expect(commandTypes(result.commands)).not.toContain("prepare_summary");

    result = step(lifecycle, {
      type: "snapshot.refresh_loaded",
      requestId: refresh!.requestId,
      result: authoritativeSnapshot(42, "digest-42"),
      elapsedMs: 80,
    } as OnboardingEvent);
    lifecycle = result.lifecycle;
    expect(lifecycle.coverage).toMatchObject({
      revision: 42,
      digest: "digest-42",
      complete: true,
    });
    expect(
      result.commands.filter(
        (command) =>
          command.type === "prepare_summary" &&
          command.revision === 42 &&
          command.digest === "digest-42",
      ),
    ).toHaveLength(1);
    expect(
      result.commands.some(
        (command) =>
          command.type === "prepare_summary" && command.digest === "digest-41",
      ),
    ).toBe(false);

    const current = step(lifecycle, {
      type: "snapshot.loaded",
      result: authoritativeSnapshot(42, "digest-42"),
      elapsedMs: 81,
    });
    expect(current.lifecycle.phase).toBe("summary_speaking");
    expect(
      current.commands.filter(
        (command) =>
          command.type === "request_response" &&
          command.intentKey === "summary:digest-42",
      ),
    ).toHaveLength(1);
  });

  test("duplicate approval changed is state-identical while the same refresh is active", () => {
    const failure = {
      type: "approval.persistence_failed" as const,
      toolCallId: "approval-tool-1",
      code: "changed" as const,
      safeDetail: "coverage snapshot changed",
      elapsedMs: 73,
    };
    const first = step(approvalPersisting().lifecycle, failure);
    expect(first.lifecycle.snapshotRefresh).toBeDefined();
    const duplicate = step(first.lifecycle, failure);
    expect(duplicate.lifecycle).toBe(first.lifecycle);
    expect(duplicate.commands).toEqual([]);
    expect(duplicate.lifecycle.phase).toBe("snapshot_preparing");
  });

  test("coverage revision 43 cancels refresh 41 so replayed result 42 cannot overwrite it", () => {
    const changed = step(approvalPersisting().lifecycle, {
      type: "approval.persistence_failed",
      toolCallId: "approval-tool-1",
      code: "changed",
      safeDetail: "coverage snapshot changed",
      elapsedMs: 73,
    });
    const requestId = changed.lifecycle.snapshotRefresh!.requestId;
    const advanced = step(changed.lifecycle, {
      type: "coverage.changed",
      revision: 43,
      digest: "digest-43",
      complete: true,
      missing: [],
      ambiguous: [],
      elapsedMs: 74,
    });
    expect(advanced.lifecycle.coverage).toMatchObject({
      revision: 43,
      digest: "digest-43",
      complete: true,
    });
    expect(advanced.lifecycle.snapshotRefresh).toBeUndefined();

    const stale = step(advanced.lifecycle, {
      type: "snapshot.refresh_loaded",
      requestId,
      result: authoritativeSnapshot(42, "digest-42"),
      elapsedMs: 75,
    });
    expect(stale.lifecycle).toBe(advanced.lifecycle);
    expect(stale.lifecycle.coverage).toMatchObject({
      revision: 43,
      digest: "digest-43",
    });
    expect(commandTypes(stale.commands)).not.toContain("prepare_summary");
    expect(stale.commands).toContainEqual(
      expect.objectContaining({
        type: "telemetry",
        name: "invariant.violation",
        outcome: "stale_snapshot_refresh_result",
      }),
    );
  });

  test("correlated refresh must be newer than current lifecycle coverage as well as rejected coverage", () => {
    const changed = step(approvalPersisting().lifecycle, {
      type: "approval.persistence_failed",
      toolCallId: "approval-tool-1",
      code: "changed",
      safeDetail: "coverage snapshot changed",
      elapsedMs: 73,
    });
    const concurrent = structuredClone(changed.lifecycle);
    concurrent.coverage = {
      revision: 42,
      digest: "digest-42-current",
      complete: true,
      missing: [],
      ambiguous: [],
    };
    const notNewer = step(concurrent, {
      type: "snapshot.refresh_loaded",
      requestId: concurrent.snapshotRefresh!.requestId,
      result: authoritativeSnapshot(42, "digest-42-result"),
      elapsedMs: 74,
    });
    expect(notNewer.lifecycle.phase).toBe("blocked");
    expect(notNewer.lifecycle.coverage).toMatchObject({
      revision: 42,
      digest: "digest-42-current",
    });
    expect(notNewer.commands).toContainEqual(
      expect.objectContaining({
        type: "block",
        code: "snapshot_refresh_not_newer",
      }),
    );
  });

  test("advisory timer returns the exact lifecycle object with no revision or command", () => {
    const lifecycle = approvalPersisting().lifecycle;
    const before = JSON.stringify(lifecycle);
    const result = step(lifecycle, {
      type: "timer.elapsed",
      name: "legacy_recap_watchdog",
      elapsedMs: 1200,
    });
    expect(result.lifecycle).toBe(lifecycle);
    expect(JSON.stringify(result.lifecycle)).toBe(before);
    expect(result.lifecycle.lifecycleRevision).toBe(
      lifecycle.lifecycleRevision,
    );
    expect(result.commands).toEqual([]);
  });

  test("post-closed timer preserves exact state and emits only sanitized invariant telemetry", () => {
    const lifecycle = {
      ...createOnboardingLifecycle(callId, businessName),
      phase: "closed" as const,
      lifecycleRevision: 88,
      socketGeneration: 4,
      providerTerminationConfirmed: true,
    };
    const before = JSON.stringify(lifecycle);
    const result = step(lifecycle, {
      type: "timer.elapsed",
      name: "secret-looking-timer-name",
      elapsedMs: 9000,
    });
    expect(result.lifecycle).toBe(lifecycle);
    expect(JSON.stringify(result.lifecycle)).toBe(before);
    expect(result.commands).toEqual([
      {
        type: "telemetry",
        name: "invariant.violation",
        callIdPrefix: "7f58ee06",
        socketGeneration: 4,
        lifecycleRevision: 88,
        phase: "closed",
        elapsedMs: 9000,
        outcome: "event_after_closed",
      },
    ]);
    expect(JSON.stringify(result.commands)).not.toContain(
      "secret-looking-timer-name",
    );
  });
});

test("response coordinator sends keyed metadata and retries an unsent key without duplication", () => {
  const frames: string[] = [];
  const ledger = { callId, status: "active", phase: "summary_speaking" };
  const request = {
    intentKey: "summary:digest-41",
    purpose: "summary" as const,
    instructions: "Resuma os fatos e peça confirmação explícita.",
    snapshotDigest: "digest-41",
  };
  expect(requestResponse(ledger, { send: (frame) => frames.push(frame) }, request))
    .toBe(true);
  expect(JSON.parse(frames[0]!)).toEqual({
    type: "response.create",
    response: {
      instructions: request.instructions,
      metadata: {
        intent_key: "summary:digest-41",
        purpose: "summary",
        snapshot_digest: "digest-41",
      },
    },
  });
  ledger.responseActive = false;
  expect(requestResponse(ledger, { send: (frame) => frames.push(frame) }, request))
    .toBe(false);
  expect(frames).toHaveLength(1);

  const retryLedger = { callId, status: "active", phase: "collecting" };
  expect(
    requestResponse(
      retryLedger,
      { send: () => { throw new Error("socket closed"); } },
      { intentKey: "tool-batch:response-1:hash-1", purpose: "tool_continuation" },
    ),
  ).toBe(false);
  expect(
    requestResponse(
      retryLedger,
      { send: (frame) => frames.push(frame) },
      { intentKey: "tool-batch:response-1:hash-1", purpose: "tool_continuation" },
    ),
  ).toBe(true);
});

test("a failed admitted tool execution queues one truthful recovery with sanitized identity", () => {
  let lifecycle = startCollecting();
  ({ lifecycle } = step(lifecycle, {
    type: "tool.called",
    socketGeneration: 1,
    toolCallId: "tool-failed-1",
    name: "record_interview_answer",
    args: {
      topic: "area",
      field: "area.coverage",
      disposition: "answered",
      rule_text: "Atende Irvine.",
      owner_words: "Atendemos Irvine.",
    },
    providerResponseId: "response-failed-1",
    batchHash: "batch-failed-1",
    elapsedMs: 1,
  }));

  const failed = step(lifecycle, {
    type: "tool.execution_failed",
    toolCallId: "tool-failed-1",
    code: "query_error",
    safeDetail: "onboarding answer could not be persisted",
    elapsedMs: 9,
  } as OnboardingEvent);

  expect(failed.lifecycle.phase).toBe("collecting");
  expect(failed.lifecycle.toolOutbox["tool-failed-1"]?.state).toBe("executed");
  expect(failed.commands).toContainEqual(expect.objectContaining({
    type: "telemetry",
    name: "invariant.violation",
    outcome: "query_error",
    toolCallId: "tool-failed-1",
  }));
  expect(failed.commands).toContainEqual(expect.objectContaining({
    type: "resend_output",
    toolCallId: "tool-failed-1",
  }));
  expect(failed.commands.some((command) => command.type === "request_response"))
    .toBe(false);
  expect(failed.commands.some((command) => command.type === "block")).toBe(false);
  expect(JSON.stringify(failed.commands)).not.toContain("Atendemos Irvine");

  const sent = step(
    failed.lifecycle,
    outputSentEvent(failed.lifecycle, "tool-failed-1", 1, 10),
  );
  const closed = step(sent.lifecycle, {
    type: "tool.batch_closed",
    providerResponseId: "response-failed-1",
    batchHash: "batch-failed-1",
    toolCallIds: ["tool-failed-1"],
    elapsedMs: 11,
  });
  const terminal = step(closed.lifecycle, {
    type: "response.done",
    responseId: "response-failed-1",
    socketGeneration: 1,
    elapsedMs: 12,
  });
  const acked = step(terminal.lifecycle, {
    type: "tool.output_acked",
    toolCallId: "tool-failed-1",
    outputItemId: providerOutputItemId("tool-failed-1"),
    socketGeneration: 1,
    elapsedMs: 13,
  });
  expect(acked.lifecycle.phase).toBe("follow_up");
  expect(acked.commands).toContainEqual(expect.objectContaining({
    type: "request_response",
    purpose: "recovery",
    intentKey: "recovery:tool_persistence_failed:tool-failed-1",
  }));
});

test("failed persistence waits for every sibling output acknowledgement before recovery", () => {
  let lifecycle = startCollecting();
  for (const [index, toolCallId] of ["tool-failed-sibling", "tool-ok-sibling"].entries())
    ({ lifecycle } = step(lifecycle, {
      type: "tool.called",
      socketGeneration: 1,
      toolCallId,
      name: "record_interview_answer",
      args: {
        topic: "servicos",
        field: "service.name_synonyms",
        subject: index === 0 ? "desentupimento" : "diagnostico_hidraulico",
        disposition: "answered",
        rule_text: "Serviço informado.",
        structured: { value: [index === 0 ? "desentupimento" : "diagnóstico hidráulico"] },
        owner_words: "Desentupimento e diagnóstico hidráulico.",
      },
      providerResponseId: "response-sibling-failure",
      batchHash: "batch-sibling-failure",
      elapsedMs: index + 1,
    }));
  ({ lifecycle } = step(lifecycle, {
    type: "tool.execution_failed",
    toolCallId: "tool-failed-sibling",
    code: "query_error",
    safeDetail: "onboarding answer could not be persisted",
    elapsedMs: 3,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "tool.executed",
    toolCallId: "tool-ok-sibling",
    output: '{"status":"recorded"}',
    resultHash: "result-ok-sibling",
    elapsedMs: 4,
  }));
  ({ lifecycle } = step(
    lifecycle,
    outputSentEvent(lifecycle, "tool-failed-sibling", 1, 5),
  ));
  ({ lifecycle } = step(
    lifecycle,
    outputSentEvent(lifecycle, "tool-ok-sibling", 1, 6),
  ));
  ({ lifecycle } = step(lifecycle, {
    type: "tool.batch_closed",
    providerResponseId: "response-sibling-failure",
    batchHash: "batch-sibling-failure",
    toolCallIds: ["tool-failed-sibling", "tool-ok-sibling"],
    elapsedMs: 7,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.done",
    responseId: "response-sibling-failure",
    socketGeneration: 1,
    elapsedMs: 8,
  }));

  const firstAck = step(lifecycle, {
    type: "tool.output_acked",
    toolCallId: "tool-failed-sibling",
    outputItemId: providerOutputItemId("tool-failed-sibling"),
    socketGeneration: 1,
    elapsedMs: 9,
  });
  expect(firstAck.commands.some((command) => command.type === "request_response"))
    .toBe(false);
  const secondAck = step(firstAck.lifecycle, {
    type: "tool.output_acked",
    toolCallId: "tool-ok-sibling",
    outputItemId: providerOutputItemId("tool-ok-sibling"),
    socketGeneration: 1,
    elapsedMs: 10,
  });
  expect(secondAck.commands.filter((command) =>
    command.type === "request_response" && command.purpose === "recovery"
  )).toHaveLength(1);
  expect(secondAck.lifecycle.toolBatches[
    "response-sibling-failure:batch-sibling-failure"
  ]?.continuationRequested).toBe(true);
});

test("owner-turn recovery invariant is deduplicated by its causal key", () => {
  const lifecycle = startCollecting();
  const event = {
    type: "recovery.required",
    reason: "owner_turn_completed_without_tool",
    recoveryKey: "response-owner-no-tool",
    responseId: "response-owner-no-tool",
    socketGeneration: 1,
    elapsedMs: 8,
  } as unknown as OnboardingEvent;
  const first = step(lifecycle, event);
  const recovery = first.commands.filter(
    (command) => command.type === "request_response",
  );

  expect(first.lifecycle.phase).toBe("follow_up");
  expect(first.commands).toContainEqual(expect.objectContaining({
    type: "telemetry",
    name: "invariant.violation",
    outcome: "owner_turn_completed_without_tool",
    responseId: "response-owner-no-tool",
  }));
  expect(recovery).toHaveLength(1);
  expect(recovery[0]).toMatchObject({
    type: "request_response",
    intentKey:
      "recovery:owner_turn_completed_without_tool:response-owner-no-tool",
    purpose: "recovery",
  });
  expect((recovery[0] as { instructions?: string }).instructions)
    .toContain("Não consegui confirmar");
  expect((recovery[0] as { instructions?: string }).instructions)
    .toContain("repita");

  const replay = step(first.lifecycle, event);
  expect(replay.lifecycle.phase).toBe("follow_up");
  expect(replay.commands.some((command) => command.type === "request_response"))
    .toBe(false);
});

test("metadata-less owner response during greeting emits invariant only and preserves its queued retry", () => {
  let lifecycle = createOnboardingLifecycle(callId, businessName);
  ({ lifecycle } = step(lifecycle, {
    type: "socket.attached",
    socketGeneration: 1,
    elapsedMs: 0,
  }));
  lifecycle.responseIntents[`greeting:${callId}`]!.state = "terminal";
  const retryKey = `greeting:${callId}:retry:1`;
  lifecycle.responseIntents[retryKey] = {
    intentKey: retryKey,
    purpose: "greeting",
    state: "queued",
  };

  const result = step(lifecycle, {
    type: "recovery.required",
    reason: "owner_turn_completed_without_tool",
    recoveryKey: "response-opening-crosstalk",
    responseId: "response-opening-crosstalk",
    socketGeneration: 1,
    elapsedMs: 4,
  });

  expect(result.lifecycle.phase).toBe("greeting");
  expect(result.lifecycle.responseIntents[retryKey]).toMatchObject({
    state: "queued",
    purpose: "greeting",
  });
  expect(result.commands).toContainEqual(expect.objectContaining({
    type: "telemetry",
    name: "invariant.violation",
    outcome: "owner_turn_completed_without_tool",
    responseId: "response-opening-crosstalk",
  }));
  expect(result.commands.some((command) => command.type === "block")).toBe(false);
  expect(result.commands.some((command) => command.type === "request_response"))
    .toBe(false);
});

test("a sanitized adapter invariant enters blocked through the reducer", () => {
  const lifecycle = startCollecting();
  const failed = step(lifecycle, {
    type: "adapter.invariant_failed",
    code: "tool_args_mismatch",
    safeDetail: "provider tool replay changed its payload",
    elapsedMs: 2,
  } as OnboardingEvent);
  expect(failed.lifecycle.phase).toBe("blocked");
  expect(failed.commands).toContainEqual({
    type: "block",
    code: "tool_args_mismatch",
    safeDetail: "provider tool replay changed its payload",
    recoverable: true,
  });
});

test("lifecycle telemetry precedes the side effect command it describes", () => {
  const attached = step(createOnboardingLifecycle(callId, businessName), {
    type: "socket.attached",
    socketGeneration: 1,
    elapsedMs: 0,
  });
  const greetingQueued = attached.commands.findIndex(
    (command) => command.type === "telemetry" &&
      command.name === "voice.response.intent_queued",
  );
  const greetingRequest = attached.commands.findIndex(
    (command) => command.type === "request_response",
  );
  expect(greetingQueued).toBeLessThan(greetingRequest);

  const coverage = coverageReady();
  const prepareStarted = coverage.commands.findIndex(
    (command) => command.type === "telemetry" &&
      command.name === "onboarding.snapshot.prepare_started",
  );
  const prepare = coverage.commands.findIndex(
    (command) => command.type === "prepare_summary",
  );
  expect(prepareStarted).toBeLessThan(prepare);

  let lifecycle = signoffSpeaking();
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey: "final-signoff:approval-receipt-1",
    socketGeneration: 1,
    elapsedMs: 77,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.created",
    responseId: "response-signoff-1",
    intentKey: "final-signoff:approval-receipt-1",
    socketGeneration: 1,
    elapsedMs: 78,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.transcript.done",
    responseId: "response-signoff-1",
    transcript:
      "A confirmação por voz foi salva e as regras sugeridas continuam aguardando revisão na Memória.",
    socketGeneration: 1,
    elapsedMs: 79,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.output_audio.done",
    responseId: "response-signoff-1",
    socketGeneration: 1,
    elapsedMs: 80,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.done",
    responseId: "response-signoff-1",
    socketGeneration: 1,
    elapsedMs: 81,
  }));
  const playback = step(lifecycle, {
    type: "output_audio_buffer.stopped",
    responseId: "response-signoff-1",
    socketGeneration: 1,
    elapsedMs: 82,
  });
  const closingTelemetry = playback.commands.findIndex(
    (command) => command.type === "telemetry" &&
      command.name === "closing.provider_requested",
  );
  const hangup = playback.commands.findIndex(
    (command) => command.type === "request_hangup",
  );
  expect(closingTelemetry).toBeLessThan(hangup);
});

test("late repeated signoff proof is state-identical after provider termination starts", () => {
  const lifecycle = providerTerminatingLifecycle();
  const repeated: OnboardingEvent[] = [
    {
      type: "response.output_audio.done",
      responseId: "response-signoff-late",
      socketGeneration: 1,
      elapsedMs: 90,
    },
    {
      type: "response.done",
      responseId: "response-signoff-late",
      socketGeneration: 1,
      elapsedMs: 91,
    },
    {
      type: "output_audio_buffer.stopped",
      responseId: "response-signoff-late",
      socketGeneration: 1,
      elapsedMs: 92,
    },
  ];
  for (const event of repeated) {
    const result = step(lifecycle, event);
    expect(result.lifecycle).toBe(lifecycle);
    expect(result.commands).toEqual([]);
    expect(result.lifecycle.requestedHangupKeys)
      .toEqual(["hangup:approval-receipt-1"]);
  }
  const closed = step(lifecycle, {
    type: "provider.termination_confirmed",
    intentKey: "hangup:approval-receipt-1",
    terminalPersisted: true,
    elapsedMs: 93,
  });
  expect(closed.lifecycle.phase).toBe("closed");
  expect(closed.lifecycle.providerTerminationConfirmed).toBe(true);
});

test("reducer maps fail closed at deterministic capacity without discarding replay identities", () => {
  const toolLifecycle = startCollecting();
  toolLifecycle.toolOutbox = Object.fromEntries(
    Array.from({ length: 512 }, (_, index) => [
      `existing-tool-${index}`,
      {
        toolCallId: `existing-tool-${index}`,
        toolName: "end_session",
        argsHash: `args-${index}`,
        state: "output_acked" as const,
        providerResponseId: `response-${index}`,
        batchHash: `batch-${index}`,
        outputItemId: providerOutputItemId(`existing-tool-${index}`),
        socketGeneration: 1,
      },
    ]),
  );
  const toolOverflow = step(toolLifecycle, {
    type: "tool.called",
    toolCallId: "overflow-tool",
    name: "end_session",
    args: {},
    providerResponseId: "overflow-response",
    batchHash: "overflow-batch",
    socketGeneration: 1,
    elapsedMs: 1,
  });
  expect(toolOverflow.lifecycle.phase).toBe("blocked");
  expect(Object.keys(toolOverflow.lifecycle.toolOutbox)).toHaveLength(512);
  expect(toolOverflow.lifecycle.toolOutbox["overflow-tool"]).toBeUndefined();

  const batchLifecycle = startCollecting();
  batchLifecycle.toolOutbox["new-batch-tool"] = {
    toolCallId: "new-batch-tool",
    toolName: "end_session",
    argsHash: hashOnboardingToolArgs({}),
    state: "output_pending",
    providerResponseId: "new-batch-response",
    batchHash: "new-batch-hash",
    output: "{}",
    resultHash: "result",
    outputItemId: providerOutputItemId("new-batch-tool"),
    socketGeneration: 1,
  };
  batchLifecycle.toolBatches = Object.fromEntries(
    Array.from({ length: 512 }, (_, index) => [
      `response-${index}:batch-${index}`,
      {
        providerResponseId: `response-${index}`,
        batchHash: `batch-${index}`,
        toolCallIds: [`tool-${index}`],
        closed: true,
        continuationRequested: true,
      },
    ]),
  );
  const batchOverflow = step(batchLifecycle, {
    type: "tool.batch_closed",
    providerResponseId: "new-batch-response",
    batchHash: "new-batch-hash",
    toolCallIds: ["new-batch-tool"],
    elapsedMs: 2,
  });
  expect(batchOverflow.lifecycle.phase).toBe("blocked");
  expect(Object.keys(batchOverflow.lifecycle.toolBatches)).toHaveLength(512);

  const intentLifecycle = createOnboardingLifecycle(callId, businessName);
  intentLifecycle.responseIntents = Object.fromEntries(
    Array.from({ length: 512 }, (_, index) => [
      `existing-intent-${index}`,
      {
        intentKey: `existing-intent-${index}`,
        purpose: "tool_continuation" as const,
        state: "terminal" as const,
        responseId: `response-intent-${index}`,
      },
    ]),
  );
  const intentOverflow = step(intentLifecycle, {
    type: "socket.attached",
    socketGeneration: 1,
    elapsedMs: 3,
  });
  expect(intentOverflow.lifecycle.phase).toBe("blocked");
  expect(Object.keys(intentOverflow.lifecycle.responseIntents)).toHaveLength(512);
  expect(intentOverflow.commands.some((command) => command.type === "request_response"))
    .toBe(false);
});

test("blocked is absorbing while terminal and output acknowledgements remain bookkeeping-only", () => {
  const blocked = createOnboardingLifecycle(callId, businessName);
  blocked.phase = "blocked";
  blocked.socketGeneration = 1;
  blocked.coverage = {
    revision: 1,
    digest: "blocked-digest",
    complete: true,
    missing: [],
    ambiguous: [],
  };
  blocked.toolOutbox["blocked-tool"] = {
    toolCallId: "blocked-tool",
    toolName: "end_session",
    argsHash: hashOnboardingToolArgs({}),
    state: "output_pending",
    providerResponseId: "blocked-response",
    batchHash: "blocked-batch",
    output: "{}",
    resultHash: "blocked-result",
    outputItemId: providerOutputItemId("blocked-tool"),
    socketGeneration: 1,
  };
  const advancingEvents: OnboardingEvent[] = [
    {
      type: "response.transcript.done",
      responseId: "blocked-response",
      transcript: "Área: Irvine. Você confirma?",
      socketGeneration: 1,
      elapsedMs: 1,
    },
    {
      type: "response.output_audio.done",
      responseId: "blocked-response",
      socketGeneration: 1,
      elapsedMs: 2,
    },
    {
      type: "output_audio_buffer.stopped",
      responseId: "blocked-response",
      socketGeneration: 1,
      elapsedMs: 3,
    },
    {
      type: "coverage.changed",
      revision: 2,
      digest: "new-blocked-digest",
      complete: true,
      missing: [],
      ambiguous: [],
      elapsedMs: 4,
    },
    {
      type: "snapshot.loaded",
      result: authoritativeSnapshot(2, "new-blocked-digest"),
      elapsedMs: 5,
    },
    {
      type: "tool.batch_closed",
      providerResponseId: "blocked-response",
      batchHash: "blocked-batch",
      toolCallIds: ["blocked-tool"],
      elapsedMs: 6,
    },
  ];
  const forbidden = new Set([
    "prepare_summary", "request_response", "request_signoff",
    "request_hangup", "persist_fact", "persist_approval", "execute_tool",
  ]);
  for (const event of advancingEvents) {
    const result = step(blocked, event);
    expect(result.lifecycle).toBe(blocked);
    expect(result.lifecycle.phase).toBe("blocked");
    expect(result.commands.some((command) => forbidden.has(command.type)))
      .toBe(false);
  }

  const terminal = step(blocked, {
    type: "response.done",
    responseId: "blocked-response",
    socketGeneration: 1,
    elapsedMs: 7,
  });
  expect(terminal.lifecycle.phase).toBe("blocked");
  expect(terminal.lifecycle.terminalResponseIds).toContain("blocked-response");
  expect(terminal.commands.some((command) => forbidden.has(command.type)))
    .toBe(false);

  const acknowledged = step(blocked, {
    type: "tool.output_acked",
    toolCallId: "blocked-tool",
    outputItemId: providerOutputItemId("blocked-tool"),
    socketGeneration: 1,
    elapsedMs: 8,
  });
  expect(acknowledged.lifecycle.phase).toBe("blocked");
  expect(acknowledged.lifecycle.toolOutbox["blocked-tool"]?.state)
    .toBe("output_acked");
  expect(acknowledged.commands.some((command) => forbidden.has(command.type)))
    .toBe(false);
});

test("coverage change invalidates queued or sent old summary intent and ignores its late provider evidence", () => {
  for (const state of ["queued", "sent"] as const) {
    let lifecycle = snapshotReady().lifecycle;
    lifecycle.responseIntents["summary:digest-41"]!.state = state;
    const changed = step(lifecycle, {
      type: "coverage.changed",
      revision: 42,
      digest: "digest-42",
      complete: false,
      missing: [{ field: "area.coverage" }],
      ambiguous: [],
      elapsedMs: 60,
    });
    lifecycle = changed.lifecycle;
    expect(lifecycle.phase).toBe("collecting");
    expect(lifecycle.summary).toBeUndefined();
    expect(lifecycle.responseIntents["summary:digest-41"]?.state)
      .toBe("terminal");

    const lateCreated = step(lifecycle, {
      type: "response.created",
      responseId: `late-old-summary-${state}`,
      intentKey: "summary:digest-41",
      socketGeneration: 1,
      elapsedMs: 61,
    });
    expect(lateCreated.lifecycle).toBe(lifecycle);
    expect(lateCreated.lifecycle.activeResponseId).toBeUndefined();
    expect(lateCreated.lifecycle.responseIntents["summary:digest-41"]?.state)
      .toBe("terminal");
    expect(lateCreated.commands.some((command) =>
      command.type === "request_response" || command.type === "request_hangup"
    )).toBe(false);
  }
});

test("terminal response registry prunes only unreferenced identities and blocks when every identity is live", () => {
  const pruneable = startCollecting();
  pruneable.terminalResponseIds = Array.from(
    { length: 512 }, (_, index) => `terminal-${index}`,
  );
  const pruned = step(pruneable, {
    type: "response.done",
    responseId: "terminal-new",
    socketGeneration: 1,
    elapsedMs: 1,
  });
  expect(pruned.lifecycle.phase).toBe("collecting");
  expect(pruned.lifecycle.terminalResponseIds).toHaveLength(512);
  expect(pruned.lifecycle.terminalResponseIds).not.toContain("terminal-0");
  expect(pruned.lifecycle.terminalResponseIds).toContain("terminal-new");

  const protectedLifecycle = startCollecting();
  protectedLifecycle.coverage = {
    revision: 4,
    digest: "protected-digest",
    complete: true,
    missing: [],
    ambiguous: [],
  };
  protectedLifecycle.terminalResponseIds = Array.from(
    { length: 512 }, (_, index) => `protected-${index}`,
  );
  protectedLifecycle.toolBatches = Object.fromEntries(
    protectedLifecycle.terminalResponseIds.map((responseId, index) => [
      `${responseId}:batch-${index}`,
      {
        providerResponseId: responseId,
        batchHash: `batch-${index}`,
        toolCallIds: [],
        closed: true,
        continuationRequested: false,
      },
    ]),
  );
  const overflow = step(protectedLifecycle, {
    type: "response.done",
    responseId: "protected-overflow",
    socketGeneration: 1,
    elapsedMs: 2,
  });
  expect(overflow.lifecycle.phase).toBe("blocked");
  expect(overflow.lifecycle.terminalResponseIds).toHaveLength(512);
  expect(overflow.lifecycle.terminalResponseIds)
    .not.toContain("protected-overflow");
  expect(overflow.commands.some((command) => command.type === "prepare_summary"))
    .toBe(false);
});

test("blocked attach and durable tool completion preserve bookkeeping without response authority", () => {
  const attachedLifecycle = createOnboardingLifecycle(callId, businessName);
  attachedLifecycle.phase = "blocked";
  attachedLifecycle.socketGeneration = 1;
  attachedLifecycle.toolOutbox["blocked-pending"] = {
    toolCallId: "blocked-pending",
    toolName: "end_session",
    argsHash: hashOnboardingToolArgs({}),
    state: "output_pending",
    providerResponseId: "blocked-response",
    batchHash: "blocked-batch",
    output: "{\"status\":\"application_owned_close\"}",
    resultHash: "blocked-result",
    outputItemId: providerOutputItemId("blocked-pending"),
    socketGeneration: 1,
  };
  const attached = step(attachedLifecycle, {
    type: "socket.attached",
    socketGeneration: 2,
    elapsedMs: 1,
  });
  expect(attached.lifecycle.phase).toBe("blocked");
  expect(attached.lifecycle.socketGeneration).toBe(2);
  expect(attached.commands.filter((command) => command.type === "resend_output"))
    .toEqual([
      expect.objectContaining({
        type: "resend_output",
        toolCallId: "blocked-pending",
        outputItemId: providerOutputItemId("blocked-pending"),
        replay: true,
        socketGeneration: 2,
      }),
    ]);
  expect(attached.commands.some((command) => command.type === "request_response"))
    .toBe(false);

  const executionLifecycle = createOnboardingLifecycle(callId, businessName);
  executionLifecycle.phase = "blocked";
  executionLifecycle.socketGeneration = 2;
  executionLifecycle.toolOutbox["blocked-running"] = {
    toolCallId: "blocked-running",
    toolName: "record_interview_answer",
    argsHash: hashOnboardingToolArgs({ field: "area.coverage" }),
    state: "running",
    providerResponseId: "blocked-running-response",
    batchHash: "blocked-running-batch",
    outputItemId: providerOutputItemId("blocked-running"),
    socketGeneration: 1,
  };
  const executed = step(executionLifecycle, {
    type: "tool.executed",
    toolCallId: "blocked-running",
    output: "{\"status\":\"recorded\"}",
    resultHash: "blocked-running-result",
    elapsedMs: 2,
  });
  expect(executed.lifecycle.phase).toBe("blocked");
  expect(executed.lifecycle.toolOutbox["blocked-running"]?.state)
    .toBe("executed");
  expect(executed.commands.filter((command) => command.type === "resend_output"))
    .toHaveLength(1);
  expect(executed.commands.some((command) =>
    command.type === "prepare_summary" || command.type === "request_response"
  )).toBe(false);
});

test("blocked correlated duplicate create still retrieves the exact pending output as bookkeeping", () => {
  const lifecycle = createOnboardingLifecycle(callId, businessName);
  lifecycle.phase = "blocked";
  lifecycle.socketGeneration = 1;
  lifecycle.toolOutbox["blocked-duplicate"] = {
    toolCallId: "blocked-duplicate",
    toolName: "end_session",
    argsHash: hashOnboardingToolArgs({}),
    state: "output_pending",
    providerResponseId: "blocked-duplicate-response",
    batchHash: "blocked-duplicate-batch",
    output: "{\"status\":\"application_owned_close\"}",
    resultHash: "blocked-duplicate-result",
    outputItemId: providerOutputItemId("blocked-duplicate"),
    socketGeneration: 1,
  };
  const createEventId = onboardingOutputRequestEventId(
    lifecycle,
    lifecycle.toolOutbox["blocked-duplicate"]!,
    "create",
  );
  lifecycle.toolOutbox["blocked-duplicate"]!.outputRequest = {
    delivery: "create",
    eventId: createEventId,
    socketGeneration: 1,
  };

  const duplicate = step(lifecycle, {
    type: "tool.output_create_duplicate",
    toolCallId: "blocked-duplicate",
    eventId: createEventId,
    socketGeneration: 1,
    elapsedMs: 1,
  });

  expect(duplicate.lifecycle.phase).toBe("blocked");
  expect(duplicate.commands).toContainEqual(expect.objectContaining({
    type: "resend_output",
    toolCallId: "blocked-duplicate",
    outputItemId: providerOutputItemId("blocked-duplicate"),
    delivery: "retrieve",
    replay: true,
  }));
});

test("blocked exact post-hangup durable confirmation may close; mismatch remains blocked", () => {
  const lifecycle = createOnboardingLifecycle(callId, businessName);
  lifecycle.phase = "blocked";
  lifecycle.approval = {
    toolCallId: "approval-tool-blocked",
    approvalReceiptId: "approval-receipt-blocked",
    coverageReceiptId: "coverage-receipt-blocked",
    revision: 7,
    digest: "blocked-digest",
  };
  lifecycle.requestedHangupKeys = ["hangup:approval-receipt-blocked"];

  const mismatch = step(lifecycle, {
    type: "provider.termination_confirmed",
    intentKey: "hangup:wrong",
    terminalPersisted: true,
    elapsedMs: 1,
  });
  expect(mismatch.lifecycle).toBe(lifecycle);
  expect(mismatch.lifecycle.phase).toBe("blocked");

  const closed = step(lifecycle, {
    type: "provider.termination_confirmed",
    intentKey: "hangup:approval-receipt-blocked",
    terminalPersisted: true,
    elapsedMs: 2,
  });
  expect(closed.lifecycle.phase).toBe("closed");
  expect(closed.lifecycle.providerTerminationConfirmed).toBe(true);
  expect(closed.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "telemetry", name: "closing.provider_confirmed" }),
    expect.objectContaining({ type: "telemetry", name: "onboarding.closed" }),
  ]));
});

test("provider function output item IDs are opaque, stable, and bounded for a real 21-character call_id", () => {
  const toolCallId = "call_0123456789abcdef";
  expect(toolCallId).toHaveLength(21);
  let lifecycle = startCollecting();
  ({ lifecycle } = step(lifecycle, {
    type: "tool.called",
    socketGeneration: 1,
    toolCallId,
    name: "end_session",
    args: {},
    providerResponseId: "resp-real-provider-id",
    batchHash: "batch-real-provider-id",
    elapsedMs: 0,
  }));
  const outputItemId = lifecycle.toolOutbox[toolCallId]?.outputItemId;
  expect(outputItemId).toBe("tlo-f04070b5629817764d00825d4e17");
  expect(outputItemId).toHaveLength(32);
  expect(outputItemId).not.toContain(toolCallId);
});

test("coverage correction invalidates queued or sent old signoff and corrected approval can produce signoff B", () => {
  let corrected!: OnboardingLifecycle;
  for (const state of ["queued", "sent"] as const) {
    const lifecycle = createOnboardingLifecycle(callId, businessName);
    lifecycle.phase = "final_signoff_speaking";
    lifecycle.socketGeneration = 1;
    lifecycle.coverage = {
      revision: 1,
      digest: "digest-A",
      complete: true,
      missing: [],
      ambiguous: [],
    };
    lifecycle.approval = {
      toolCallId: "approval-tool-A",
      approvalReceiptId: "approval-A",
      coverageReceiptId: "coverage-A",
      revision: 1,
      digest: "digest-A",
    };
    lifecycle.signoff = {
      approvalReceiptId: "approval-A",
      responseId: "response-signoff-A",
      audioDone: false,
      responseDone: false,
      playbackStopped: false,
      interrupted: false,
    };
    lifecycle.responseIntents["final-signoff:approval-A"] = {
      intentKey: "final-signoff:approval-A",
      purpose: "final_signoff",
      state,
      ...(state === "sent" ? { responseId: "response-signoff-A" } : {}),
    };
    if (state === "sent")
      lifecycle.activeResponseId = "response-signoff-A";

    const changed = step(lifecycle, {
      type: "coverage.changed",
      revision: 2,
      digest: "digest-B",
      complete: true,
      missing: [],
      ambiguous: [],
      elapsedMs: 1,
    });
    expect(changed.lifecycle.approval).toBeUndefined();
    expect(changed.lifecycle.signoff).toBeUndefined();
    expect(changed.lifecycle.activeResponseId).toBeUndefined();
    expect(changed.lifecycle.responseIntents["final-signoff:approval-A"]?.state)
      .toBe("terminal");
    const late = step(changed.lifecycle, {
      type: "response.created",
      responseId: "late-response-signoff-A",
      intentKey: "final-signoff:approval-A",
      socketGeneration: 1,
      elapsedMs: 2,
    });
    expect(late.lifecycle).toBe(changed.lifecycle);
    expect(late.lifecycle.activeResponseId).toBeUndefined();
    expect(late.commands.some((command) => command.type === "request_hangup"))
      .toBe(false);
    if (state === "queued") corrected = changed.lifecycle;
  }

  let result = step(corrected, {
    type: "snapshot.loaded",
    result: authoritativeSnapshot(2, "digest-B"),
    elapsedMs: 3,
  });
  let lifecycle = result.lifecycle;
  expect(lifecycle.phase).toBe("summary_speaking");
  expect(result.commands.some((command) =>
    command.type === "request_response" && command.intentKey === "summary:digest-B"
  )).toBe(true);
  ({ lifecycle } = step(lifecycle, {
    type: "response.intent_sent",
    intentKey: "summary:digest-B",
    socketGeneration: 1,
    elapsedMs: 4,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.created",
    responseId: "response-summary-B",
    intentKey: "summary:digest-B",
    socketGeneration: 1,
    elapsedMs: 5,
  }));
  for (const event of [
    {
      type: "response.transcript.done",
      responseId: "response-summary-B",
      transcript: validSummaryTranscript(),
      socketGeneration: 1,
      elapsedMs: 6,
    },
    {
      type: "response.output_audio.done",
      responseId: "response-summary-B",
      socketGeneration: 1,
      elapsedMs: 7,
    },
    {
      type: "response.done",
      responseId: "response-summary-B",
      socketGeneration: 1,
      elapsedMs: 8,
    },
    {
      type: "output_audio_buffer.stopped",
      responseId: "response-summary-B",
      socketGeneration: 1,
      elapsedMs: 9,
    },
  ] as OnboardingEvent[])
    ({ lifecycle } = step(lifecycle, event));
  expect(lifecycle.phase).toBe("awaiting_owner_approval");
  ({ lifecycle } = step(lifecycle, {
    type: "caller.speech_started",
    turnId: "owner-B",
    socketGeneration: 1,
    elapsedMs: 10,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "caller.transcript.completed",
    turnId: "owner-B",
    transcript: "Aprovado, está tudo correto.",
    socketGeneration: 1,
    elapsedMs: 11,
  }));
  result = step(lifecycle, {
    type: "tool.called",
    toolCallId: "approval-tool-B",
    name: "approve_onboarding_summary",
    args: { owner_words: "Aprovado, está tudo correto." },
    providerResponseId: "response-approval-B",
    batchHash: "batch-approval-B",
    callerTurnId: "owner-B",
    socketGeneration: 1,
    elapsedMs: 12,
  });
  lifecycle = result.lifecycle;
  expect(result.commands.some((command) => command.type === "persist_approval"))
    .toBe(true);
  ({ lifecycle } = step(lifecycle, {
    type: "approval.persisted",
    toolCallId: "approval-tool-B",
    approvalReceiptId: "approval-B",
    coverageReceiptId: "coverage-receipt-2",
    revision: 2,
    digest: "digest-B",
    output: "{\"status\":\"recorded\"}",
    resultHash: "approval-result-B",
    elapsedMs: 13,
  }));
  ({ lifecycle } = step(
    lifecycle,
    outputSentEvent(lifecycle, "approval-tool-B", 1, 14),
  ));
  ({ lifecycle } = step(lifecycle, {
    type: "tool.batch_closed",
    providerResponseId: "response-approval-B",
    batchHash: "batch-approval-B",
    toolCallIds: ["approval-tool-B"],
    elapsedMs: 15,
  }));
  ({ lifecycle } = step(lifecycle, {
    type: "response.done",
    responseId: "response-approval-B",
    socketGeneration: 1,
    elapsedMs: 16,
  }));
  result = step(lifecycle, {
    type: "tool.output_acked",
    toolCallId: "approval-tool-B",
    outputItemId: providerOutputItemId("approval-tool-B"),
    socketGeneration: 1,
    elapsedMs: 17,
  });
  expect(result.lifecycle.phase).toBe("final_signoff_speaking");
  expect(result.commands.some((command) =>
    command.type === "request_response" &&
    command.intentKey === "final-signoff:approval-B"
  )).toBe(true);
});

describe("durable directed follow-up ownership", () => {
  function collectingWithReadyAnswerBatch(): OnboardingLifecycle {
    const lifecycle = startCollecting();
    lifecycle.toolOutbox["answer-followup"] = {
      toolCallId: "answer-followup",
      toolName: "record_interview_answer",
      argsHash: "args-followup",
      state: "output_acked",
      providerResponseId: "response-followup",
      batchHash: "batch-followup",
      outputItemId: providerOutputItemId("answer-followup"),
      socketGeneration: 1,
    };
    lifecycle.toolBatches["response-followup:batch-followup"] = {
      providerResponseId: "response-followup",
      batchHash: "batch-followup",
      toolCallIds: ["answer-followup"],
      closed: true,
      continuationRequested: false,
    };
    lifecycle.terminalResponseIds.push("response-followup");
    return lifecycle;
  }

  test("persists the selected question before speaking so repeated ambiguity cannot leave counters at zero", () => {
    const changed = step(collectingWithReadyAnswerBatch(), {
      type: "coverage.changed",
      revision: 1,
      digest: "followup-digest-1",
      complete: false,
      missing: [{ field: "area.coverage" }],
      ambiguous: [],
      nextQuestion: {
        field: "area.coverage",
        questionPt: "Quais cidades vocês atendem?",
      },
      elapsedMs: 1,
    });

    expect(changed.commands).toContainEqual({
      type: "persist_followup",
      revision: 1,
      digest: "followup-digest-1",
      field: "area.coverage",
      questionPt: "Quais cidades vocês atendem?",
      intentKey: "tool-batch:response-followup:batch-followup",
    });
    expect(changed.commands.some((command) => command.type === "ask_follow_up"))
      .toBe(false);
    expect(changed.commands.some((command) => command.type === "request_response"))
      .toBe(false);

    const persisted = step(changed.lifecycle, {
      type: "followup.persisted",
      sourceRevision: 1,
      revision: 2,
      digest: "followup-digest-2",
      field: "area.coverage",
      questionPt: "Quais cidades vocês atendem?",
      intentKey: "tool-batch:response-followup:batch-followup",
      elapsedMs: 2,
    } as any);
    expect(persisted.lifecycle.coverage).toMatchObject({
      revision: 2,
      digest: "followup-digest-2",
      complete: false,
    });
    expect(persisted.commands).toContainEqual({
      type: "ask_follow_up",
      field: "area.coverage",
      questionPt: "Quais cidades vocês atendem?",
      intentKey: "tool-batch:response-followup:batch-followup",
    });
    expect(persisted.commands).toContainEqual({
      type: "request_response",
      intentKey: "tool-batch:response-followup:batch-followup",
      purpose: "tool_continuation",
      instructions: "Quais cidades vocês atendem?",
    });
  });

  test("incomplete exhausted coverage blocks explicitly and emits no instructionless continuation", () => {
    const exhausted = step(collectingWithReadyAnswerBatch(), {
      type: "coverage.changed",
      revision: 12,
      digest: "followup-exhausted",
      complete: false,
      missing: [{ field: "policy.payment_estimate" }],
      ambiguous: [],
      elapsedMs: 12,
    });

    expect(exhausted.lifecycle.phase).toBe("blocked");
    expect(exhausted.commands).toContainEqual(expect.objectContaining({
      type: "block",
      code: "follow_up_exhausted",
    }));
    expect(exhausted.commands.some((command) => command.type === "request_response"))
      .toBe(false);
  });
});
