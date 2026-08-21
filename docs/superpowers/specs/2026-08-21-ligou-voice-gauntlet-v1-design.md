# Ligou Voice Gauntlet v1 — Design Specification

> **DEFERRED — NOT LAUNCH CRITICAL (2026-08-21).** The approved design and
> provider research are preserved for V0.2/V0.3, but implementation of the
> 50-scenario platform stopped after Task 1. V0.1 uses the bounded twelve-case
> gate in `benchmark/launch-smoke/`. See `benchmark/CHECKPOINT.md`.

**Historical design status:** Approved by the user-provided “Ligou V0.2 Super Prompt: Build the 50-Scenario Voice Model Gauntlet”; subsequently deferred by the launch-path checkpoint.

**Source specification:** `/Users/d1f/.codex/attachments/3d4e981a-feae-4eca-ba1d-62bb0ccb27a2/pasted-text.txt`

**Verified base:** `codex/v0.1-rc1@f5e81a4ed234779864072f257a60ceadf1cf453d`, tree `8cacbecf785b41892282a160d90dd4b86315e04e`, package SHA-256 `3ffd70761b8f284037104bceeeb12933ad32928899bd45235fc905af6b937156`, 46 migrations, clean.

## Goal

Build a permanent, provider-neutral voice benchmark laboratory containing exactly 50 canonical difficult service-business call scenarios. Stage 0 must be fully local and deterministic. Paid provider calls remain impossible until the two-variable authorization gate is satisfied.

## Architectural rulings

1. The supplied Super Prompt is the approved design. This document normalizes it for repository permanence; it does not reopen product scope.
2. Benchmark implementation lives under `benchmark/`. Production voice-controller modules are read as authoritative contracts and hashed for run identity; they are not modified unless an unavoidable shared-interface need is separately tested and reviewed.
3. Scenarios are committed JSON manifests. A generator may produce them, but the test suite carries an independent literal list of all 50 IDs and category counts so generator and validator cannot agree on the same mistake.
4. Caller audio is committed, synthetic, and explicitly labeled. macOS `say` may generate source speech clips; deterministic repository code owns WAV normalization and transformations. Committed bytes and hashes, not the host TTS engine, define benchmark reproducibility.
5. Ten human-calibration scripts are committed without recordings. Synthetic fixtures are never described as equivalent to Brazilian-accented English or other real human calibration.
6. Fake-provider results prove architecture only. They are stored in temporary test directories and never populate the paid leaderboard or model decision.
7. Hard business outcomes use deterministic scorers. Human or model-assisted language review may supplement Portuguese style, but cannot override a fact error, authority violation, or hard disqualification.
8. Provider adapters accept injected transports in tests. Network transports require a paid authorization object created by the budget gate; an adapter cannot read repository `.env` files or discover fallback credentials.
9. Unknown usage means unknown cost. Pricing snapshots support the paid-run estimate only and never substitute for provider usage evidence in scored results.
10. The expected successful no-spend outcome is `READY_FOR_PAID_BENCHMARK`.

## Repository structure

```text
benchmark/
  README.md
  SCORING.md
  PROVIDER-COMPATIBILITY.md
  config/
    candidates.json
    suite.json
  scenarios/
    manifests/*.json
    manifest.json
    generate-scenarios.mjs
  audio/
    sources/
    generated/
    manifest.json
    generate-audio.mjs
  human-calibration/*.md
  providers/
    contract.ts
    registry.ts
    fake-provider.ts
    <selected-adapter>.ts
  runner/
    authorization.ts
    identity.ts
    trace.ts
    state.ts
    run-scenario.ts
    run-suite.ts
    cli.ts
  scorers/
    transcription.ts
    interruption.ts
    authority.ts
    booking.ts
    summary.ts
    cost.ts
    aggregate.ts
  fixtures/
    tenant.json
    calendar.json
    outcomes.json
  tests/*.test.ts
  reports/
  traces/README.md
```

Adapters for candidates not selected by current official-source qualification are omitted. `selected_for_v1: true` is valid only for `QUALIFIED` candidates, the selected set is capped at five, and the registry test guarantees that every selected Stage 1 candidate has an adapter.

## Core contracts

### Scenario manifest

Every `benchmark/scenarios/manifests/<stable-id>.json` contains:

- `schema: "ligou.voice-gauntlet.scenario.v1"`
- stable `id`, `title`, category `A`–`F`, caller persona, objective;
- initial business and Calendar state;
- ordered caller turns with text, clip ID, start offset and optional interruption target;
- audio transformations and provider/tool faults;
- critical entities;
- expected and allowed-alternative tool sequences;
- expected business outcome;
- forbidden promises and forbidden state changes;
- expected call, receipt, ledger and Portuguese-summary states;
- success conditions and critical-failure conditions.

The suite distribution is exactly A=10, B=8, C=10, D=12, E=6, F=4.

### Synthetic tenant

The fixture is one plumbing tenant with fixed UUIDs and synthetic people, contacts and addresses. It contains approved services, public target quotes, private minimum floors, hours, `America/Los_Angeles`, geography, emergency policy, powers, busy slots, booking receipts, connector state and deterministic write outcomes. A fresh deep copy is created before each scenario; mutation of scenario N cannot affect scenario N+1.

### Normalized trace

Each JSONL event contains:

```ts
interface NormalizedTraceEvent {
  run_id: string;
  scenario_id: string;
  candidate_id: string;
  provider_event_id: string | null;
  normalized_type: string;
  provider_type: string;
  timestamp: string;
  monotonic_offset_ms: number;
  payload: Record<string, unknown>;
  usage: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
}
```

Events are append-only, canonically serialized and redacted before persistence. Raw provider evidence is separate and secret-free.

### Provider adapter

```ts
interface BenchmarkProviderAdapter {
  readonly candidateId: string;
  createSession(input: SessionInput): Promise<BenchmarkSession>;
}

interface BenchmarkSession {
  sendAudio(chunk: AudioChunk): Promise<void>;
  injectInterruption(atMs: number): Promise<void>;
  provideToolResult(callId: string, result: unknown): Promise<void>;
  events(): AsyncIterable<ProviderEvidence>;
  usage(): Promise<UsageEvidence | null>;
  resolvedIdentity(): Promise<ResolvedCandidateIdentity>;
  terminate(reason: string): Promise<void>;
  cleanup(): Promise<void>;
}
```

All external adapters normalize provider events through the same trace sink, expose exact resolved model identity, and use injected transports for contract tests.

### Reproducibility identity

Every valid run records the RC base SHA, benchmark SHA/tree, suite version, scenario/audio/prompt/tool-schema/tenant/scorer hashes, complete candidate configuration, resolved model ID, voice, transport, provider API version, pricing snapshot, timestamp and run ID. Missing identity invalidates the result.

## Canonical scenarios

- Category A: 10 audio/transcription cases listed in the Super Prompt.
- Category B: 8 interruption/repair cases listed in the Super Prompt.
- Category C: 10 authority/safety cases listed in the Super Prompt.
- Category D: 12 booking/Calendar correctness cases listed in the Super Prompt.
- Category E: 6 Portuguese summary cases listed in the Super Prompt.
- Category F: 4 provider/tool chaos cases listed in the Super Prompt.

Each scenario has scenario-specific success. “Successful” can mean correct refusal, honest degradation, safe emergency handoff or truthful abandonment rather than booking.

## Audio system

Caller turns are source WAV clips plus a deterministic transform chain. Supported transformations are background noise, echo, clipping, low bitrate simulation, low volume, volume spikes, silence, overlapping speakers, packet-like dropout and partial-syllable loss. The audio manifest records source hash, output hash, format, duration, synthetic label, voice/engine metadata, seed and exact parameters.

## Scoring

Official 100-point weighting:

- transcription/entities 20;
- interruption 15;
- authority/forbidden promises 20;
- booking 30;
- Portuguese summary 10;
- cost per successful call 5.

Latency and failure recovery remain supporting metrics. Hard disqualifications are stored separately and always override the composite score. The aggregate scorer cannot average away a disqualifying incident.

## Paid authorization and budget

Paid modes require all of:

```text
BENCHMARK_PAID_RUN_AUTHORIZED=1
BENCHMARK_MAX_SPEND_USD=<finite positive decimal>
```

The runner reserves the full planned amount before a session, rejects missing usage, stops before the cap, terminates and cleans every live session on abort, and preserves partial traces. Credential names come from candidate metadata; credential values come only from the process environment explicitly passed to the paid command.

## Reports

All required report files are generated deterministically. Before paid execution, every result report states `NO_PAID_PROVIDER RESULTS YET`; CSV/JSON leaderboards contain schema/header state but no fake-provider ranking. `PAID-RUN-PLAN.md` contains qualified candidates, exact smoke-session count, pricing-derived estimate, recommended hard ceiling, maximum concurrency, credential names and exact commands.

## Acceptance

Stage 0 passes only when all 50 manifests, audio hashes, independent resets, scorers, trace schemas, adapter contracts, fake-provider end-to-end flow, deterministic traces/reports, budget gate, abort cleanup and secret containment pass. An independent reviewer must report zero Critical and zero Important. No paid call is made; the final expected verdict is `READY_FOR_PAID_BENCHMARK`.
