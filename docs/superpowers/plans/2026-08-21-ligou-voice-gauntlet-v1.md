# Ligou Voice Gauntlet v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, provider-neutral, exactly-50-scenario voice benchmark laboratory that reaches Stage 0 without paid API calls.

**Architecture:** Benchmark-only TypeScript modules consume immutable hashes and behavioral contracts from the verified RC1. JSON scenarios, committed synthetic audio, normalized JSONL traces, deterministic scorers, injected provider transports and a fail-closed paid budget gate form independent layers joined by the suite runner.

**Tech Stack:** Bun 1.2.13, TypeScript, Node built-ins, Bun test, JSON/JSONL/CSV/Markdown, macOS `say`/`afconvert` for committed synthetic source audio only.

**Spec:** `docs/superpowers/specs/2026-08-21-ligou-voice-gauntlet-v1-design.md`

## Global Constraints

- Base is exactly `f5e81a4ed234779864072f257a60ceadf1cf453d`; production RC1 files remain unchanged unless a task explicitly names one.
- No deploy, push, merge, tag, production credential, customer data, real tenant, production phone number or live infrastructure mutation.
- No project `.env` read and no production credential fallback.
- No paid provider network call unless `BENCHMARK_PAID_RUN_AUTHORIZED=1` and `BENCHMARK_MAX_SPEND_USD` is a finite positive decimal.
- Benchmark at most five exact candidate configurations; research uses current official provider sources only.
- Exactly 50 scenarios with category counts A=10, B=8, C=10, D=12, E=6, F=4.
- Synthetic audio is labeled synthetic and is not represented as real human accent calibration.
- Hard disqualifications override composite scores; unknown usage means unknown cost.
- Fake-provider results never populate the paid leaderboard or model decision.
- Any production-code change requires focused tests and independent review.

---

### Task 1: Official provider qualification and candidate registry

**Files:**
- Create: `benchmark/PROVIDER-COMPATIBILITY.md`
- Create: `benchmark/config/candidates.json`
- Create: `benchmark/tests/provider-registry.test.ts`
- Create: `benchmark/README.md`

**Interfaces:**
- Produces: candidate records with `id`, `provider`, `model`, `pinning`, `voice`, `api_version`, `transport`, capability booleans, pricing snapshot, credential names, qualification and official URLs.
- Consumed by: Tasks 6 and 7.

- [ ] **Step 1: Write the failing registry test**

Create `benchmark/tests/provider-registry.test.ts` with literal checks that the registry has 1–5 unique candidates, exact configuration identity, official HTTPS references, a `2026-08-21` evidence date, explicit qualification, credential names only, and every `QUALIFIED` candidate satisfies all ten qualification predicates from the spec.

- [ ] **Step 2: Verify RED**

Run: `bun test benchmark/tests/provider-registry.test.ts`

Expected: FAIL because `benchmark/config/candidates.json` does not exist.

- [ ] **Step 3: Research official sources and write the registry**

Research no more than five exact configurations using provider-owned documentation and pricing pages. Record every required compatibility field and classify each configuration `QUALIFIED`, `CONDITIONALLY_QUALIFIED`, `INCOMPATIBLE` or `NOT_VERIFIABLE`. Do not infer capability from marketing prose when the API reference does not establish it.

- [ ] **Step 4: Write compatibility and benchmark overview docs**

`PROVIDER-COMPATIBILITY.md` cites the official source beside each claim and explains qualification failures. `README.md` states Stage 0, paid-gate rules, synthetic-audio limitations and the expected no-spend verdict.

- [ ] **Step 5: Verify GREEN and commit**

Run: `bun test benchmark/tests/provider-registry.test.ts && node scripts/scan-secrets.mjs && git diff --check`

Commit: `docs: qualify voice gauntlet candidates`

### Task 2: Benchmark contracts, identity, synthetic state and paid gate

**Files:**
- Create: `benchmark/config/suite.json`
- Create: `benchmark/fixtures/tenant.json`
- Create: `benchmark/fixtures/calendar.json`
- Create: `benchmark/fixtures/outcomes.json`
- Create: `benchmark/runner/canonical.ts`
- Create: `benchmark/runner/schemas.ts`
- Create: `benchmark/runner/identity.ts`
- Create: `benchmark/runner/trace.ts`
- Create: `benchmark/runner/state.ts`
- Create: `benchmark/runner/authorization.ts`
- Create: `benchmark/providers/contract.ts`
- Create: `benchmark/tests/contracts.test.ts`
- Create: `benchmark/tests/state-reset.test.ts`
- Create: `benchmark/tests/authorization.test.ts`

**Interfaces:**
- Produces: `validateScenario`, `validateTraceEvent`, `buildRunIdentity`, `TraceWriter`, `createScenarioState`, `authorizePaidRun`, and provider adapter/session interfaces from the spec.
- Consumed by: Tasks 3–7.

- [ ] **Step 1: Write failing contract tests**

Use hand-written valid and invalid literals. Prove exact-key validation, stable canonical hashes, missing run identity rejection, secret-key redaction, append-only monotonic trace offsets and invalid candidate configuration rejection.

- [ ] **Step 2: Write failing reset and authorization tests**

Mutate a returned state deeply and assert the next reset equals the literal tenant/calendar/outcome fixtures. Prove the paid gate rejects missing flag, missing cap, zero, negative, exponent, `NaN`, `Infinity`, inherited credential fallback and repository dotenv sentinel; prove a finite decimal cap returns an immutable authorization object.

- [ ] **Step 3: Verify RED**

Run: `bun test benchmark/tests/contracts.test.ts benchmark/tests/state-reset.test.ts benchmark/tests/authorization.test.ts`

Expected: FAIL with missing benchmark modules.

- [ ] **Step 4: Implement minimal contracts and fixtures**

Use fixed synthetic UUIDs, synthetic contacts and plumbing rules. Canonical JSON sorts object keys recursively. `TraceWriter` accepts a caller-supplied monotonic clock for tests and rejects decreasing offsets. Authorization reads only the two gate variables plus candidate-declared credential names from an explicitly passed environment object.

- [ ] **Step 5: Verify GREEN and commit**

Run: `bun test benchmark/tests/contracts.test.ts benchmark/tests/state-reset.test.ts benchmark/tests/authorization.test.ts`

Commit: `feat: add gauntlet contracts and paid gate`

### Task 3: Exactly 50 scenarios and human-calibration scripts

**Files:**
- Create: `benchmark/scenarios/generate-scenarios.mjs`
- Create: `benchmark/scenarios/manifest.json`
- Create: `benchmark/scenarios/manifests/*.json` (exactly 50)
- Create: `benchmark/human-calibration/*.md` (exactly 10)
- Create: `benchmark/tests/scenarios.test.ts`
- Create: `benchmark/tests/human-calibration.test.ts`

**Interfaces:**
- Consumes: `validateScenario`, suite and synthetic fixture IDs from Task 2.
- Produces: 50 validated scenario manifests and clip specifications consumed by Tasks 4–7.

- [ ] **Step 1: Write failing scenario tests**

Embed the literal ordered 50-ID list in the test. Assert exact category counts, every required scenario field, independent state references, at least one caller turn, clip ID per turn, expected receipt/ledger/summary states, hard-failure definitions and all named cases from categories A–F.

- [ ] **Step 2: Write failing human-calibration tests**

Assert exactly ten Markdown scripts with stable IDs covering the ten required calibration subjects, an explicit `RECORDING STATUS: NOT RECORDED`, recording instructions and no audio file claims.

- [ ] **Step 3: Verify RED**

Run: `bun test benchmark/tests/scenarios.test.ts benchmark/tests/human-calibration.test.ts`

Expected: FAIL because scenario and calibration files are absent.

- [ ] **Step 4: Implement the static scenario generator and commit outputs**

The generator contains 50 explicit definitions, not combinatorial filler. Each definition names exact expected entities, tool sequence, business outcome, forbidden promises/state changes, receipt, ledger, Portuguese facts, success and critical failure. Run it once to materialize the committed JSON files and top-level hash manifest.

- [ ] **Step 5: Add ten calibration scripts**

Create scripts for Brazilian-accented English, native American English, fast speech, elderly caller, address spelling, numbers, interruption, emergency stress, speakerphone and noisy vehicle. Do not create recordings.

- [ ] **Step 6: Verify GREEN and commit**

Run: `bun benchmark/scenarios/generate-scenarios.mjs --check && bun test benchmark/tests/scenarios.test.ts benchmark/tests/human-calibration.test.ts`

Commit: `feat: add fifty canonical voice scenarios`

### Task 4: Deterministic synthetic audio fixture system

**Files:**
- Create: `benchmark/audio/generate-audio.mjs`
- Create: `benchmark/audio/wav.ts`
- Create: `benchmark/audio/transform.ts`
- Create: `benchmark/audio/manifest.json`
- Create: `benchmark/audio/sources/*`
- Create: `benchmark/audio/generated/*`
- Create: `benchmark/tests/audio.test.ts`

**Interfaces:**
- Consumes: scenario caller turns and clip IDs from Task 3.
- Produces: PCM WAV clip files and audio manifest consumed by Task 6 identity/runner.

- [ ] **Step 1: Write failing WAV and transform tests**

Build a hand-checked 16-bit mono PCM fixture in memory. Assert parse/write roundtrip and literal sample outputs for gain, clipping, silence, seeded noise, echo, dropout, syllable mask, overlap, volume spike and deterministic low-bitrate simulation.

- [ ] **Step 2: Write failing manifest test**

Assert every scenario clip ID resolves to one committed synthetic WAV; hashes, sample rate, channels, duration, source hash, transformation parameters, engine metadata and `synthetic: true` are exact. Rehash every file from disk.

- [ ] **Step 3: Verify RED**

Run: `bun test benchmark/tests/audio.test.ts`

Expected: FAIL because audio modules and manifest are absent.

- [ ] **Step 4: Implement deterministic WAV transforms**

Use no external DSP dependency. Seeded pseudo-randomness uses a documented 32-bit generator. Transform order is explicit and recorded. Reject malformed WAVs, clipping overflow, unsupported formats and non-finite parameters.

- [ ] **Step 5: Generate and commit synthetic speech clips**

Use `/usr/bin/say` and `/usr/bin/afconvert` only for source generation. Normalize to the format required by selected adapters, apply deterministic transformations, and label the engine/voice/OS metadata. Generation must refuse if an output path escapes `benchmark/audio/`.

- [ ] **Step 6: Verify GREEN and commit**

Run: `bun benchmark/audio/generate-audio.mjs --check && bun test benchmark/tests/audio.test.ts`

Commit: `feat: add deterministic synthetic call audio`

### Task 5: Deterministic scorers and disqualifications

**Files:**
- Create: `benchmark/SCORING.md`
- Create: `benchmark/scorers/transcription.ts`
- Create: `benchmark/scorers/interruption.ts`
- Create: `benchmark/scorers/authority.ts`
- Create: `benchmark/scorers/booking.ts`
- Create: `benchmark/scorers/summary.ts`
- Create: `benchmark/scorers/cost.ts`
- Create: `benchmark/scorers/aggregate.ts`
- Create: `benchmark/tests/scorers.test.ts`
- Create: `benchmark/tests/scorer-mutations.test.ts`

**Interfaces:**
- Consumes: scenario expectations and normalized trace/result records.
- Produces: per-scenario score, supporting metrics, hard-disqualification list and candidate aggregate consumed by Task 7.

- [ ] **Step 1: Write failing scorer tests**

Use hand-derived transcript/entity, interruption, booking receipt, summary-fact and cost fixtures. Assert WER, precision/recall, exact entity rates, p50/p95, duplicate rates, exact read-back, honest unknown, fact recall/false facts and unknown cost behavior.

- [ ] **Step 2: Write mutation tests for every hard disqualification**

Starting from a literal safe result, mutate one field for each of the ten disqualifiers. Assert every mutation disqualifies regardless of a perfect numerical score. Mutate accepted receipt, tenant, price floor exposure, emergency response, SMS promise, human claim, power, duplicate write and abandoned accepted provider call.

- [ ] **Step 3: Verify RED**

Run: `bun test benchmark/tests/scorers.test.ts benchmark/tests/scorer-mutations.test.ts`

Expected: FAIL because scorer modules are absent.

- [ ] **Step 4: Implement the six official score categories**

Use the fixed 20/15/20/30/10/5 weights. Missing evidence scores only the affected evidence-backed metric as unknown/fail according to the spec; it is never estimated. Aggregate outputs preserve raw numerator/denominator values.

- [ ] **Step 5: Implement hard-disqualification precedence and document formulas**

`aggregateCandidate` returns `recommendation_eligible: false` whenever any unmitigated hard disqualification exists, even when composite score is 100.

- [ ] **Step 6: Verify GREEN and commit**

Run: `bun test benchmark/tests/scorers.test.ts benchmark/tests/scorer-mutations.test.ts`

Commit: `feat: add deterministic gauntlet scorers`

### Task 6: Provider adapters, fake provider and suite runner

**Files:**
- Create/modify: `benchmark/providers/*.ts`
- Create: `benchmark/runner/run-scenario.ts`
- Create: `benchmark/runner/run-suite.ts`
- Create: `benchmark/runner/cli.ts`
- Create: `benchmark/tests/adapter-contract.test.ts`
- Create: `benchmark/tests/fake-provider-e2e.test.ts`
- Create: `benchmark/tests/runner-faults.test.ts`
- Create: `benchmark/tests/trace-determinism.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: candidate registry, contracts, scenarios, audio, state reset and scorers from Tasks 1–5.
- Produces: Stage 0 run result, raw/normalized traces, partial-result recovery and paid smoke/full/variance commands consumed by Task 7.

- [ ] **Step 1: Write failing adapter contract tests**

For fake and every selected paid adapter, inject a scripted transport. Prove create, instructions, tool schemas, audio stream, timestamped interruption, transcript/tool events, tool results, usage, resolved model ID, termination, cleanup and secret-free raw evidence.

- [ ] **Step 2: Write failing runner/fault tests**

Assert state reset before every scenario; exact scenario order; tool timeout, rate limit, sideband loss and termination fault injection; one cleanup on success/failure/abort; partial trace preservation; budget reservation before session; stop-before-cap; missing usage stop; no credential fallback and no dotenv sentinel.

- [ ] **Step 3: Write failing fake-provider end-to-end and trace determinism tests**

Run all 50 scenarios twice with fixed clocks/IDs. Assert 50 complete results, identical normalized traces/reports, complete identities and no paid leaderboard rows. Fake traces must exercise every normalized event type and all fault paths.

- [ ] **Step 4: Verify RED**

Run: `bun test benchmark/tests/adapter-contract.test.ts benchmark/tests/runner-faults.test.ts benchmark/tests/fake-provider-e2e.test.ts benchmark/tests/trace-determinism.test.ts`

Expected: FAIL because adapters and runner are absent.

- [ ] **Step 5: Implement adapters and runner**

Keep provider protocol details inside `benchmark/providers/`. Paid adapters require an authorization object before transport creation. Runner writes through `TraceWriter`, never directly to production state, and always calls `terminate` then `cleanup` on abort when a session exists.

- [ ] **Step 6: Add package scripts**

Add `benchmark:test`, `benchmark:validate`, `benchmark:stage0`, `benchmark:smoke`, `benchmark:full` and `benchmark:variance`. No script loads `.env`.

- [ ] **Step 7: Verify GREEN and commit**

Run: `bun test benchmark/tests/adapter-contract.test.ts benchmark/tests/runner-faults.test.ts benchmark/tests/fake-provider-e2e.test.ts benchmark/tests/trace-determinism.test.ts && bun run benchmark:stage0`

Commit: `feat: add voice gauntlet adapters and runner`

### Task 7: Deterministic reports, paid plan and Stage 0 acceptance

**Files:**
- Create: every report required under `benchmark/reports/`
- Create: `benchmark/runner/reports.ts`
- Create: `benchmark/tests/reports.test.ts`
- Create: `benchmark/tests/stage0.test.ts`
- Create: `benchmark/traces/README.md`
- Modify: `benchmark/README.md`

**Interfaces:**
- Consumes: candidate registry and runner/scorer outputs.
- Produces: deterministic no-paid report set, paid smoke plan and Stage 0 verdict.

- [ ] **Step 1: Write failing report tests**

Assert the exact required filenames, stable bytes across two generations, `NO_PAID_PROVIDER RESULTS YET` in every pre-paid result artifact, zero fake leaderboard rows, no fake model decision, complete raw-trace index schema and no secrets/absolute local paths.

- [ ] **Step 2: Write failing Stage 0 acceptance test**

Invoke the CLI from a clean environment containing a hostile dotenv sentinel. Assert exactly 50 manifests, all audio hashes, reset proof, scorer mutation proof, adapter contract, fake E2E, deterministic trace/report, authorization/abort cleanup and secret scan. Assert final stdout is exactly `READY_FOR_PAID_BENCHMARK` after the structured summary.

- [ ] **Step 3: Verify RED**

Run: `bun test benchmark/tests/reports.test.ts benchmark/tests/stage0.test.ts`

Expected: FAIL because reports and Stage 0 orchestration are absent.

- [ ] **Step 4: Implement deterministic reports**

Generate the twelve required reports. `PAID-RUN-PLAN.md` derives 10 smoke scenarios per selected candidate, official-price estimate, 25% contingency rounded to cents, maximum concurrency 1, credential names, cleanup rules and exact command. If official pricing cannot bound a candidate, exclude it from paid smoke and explain why.

- [ ] **Step 5: Finish documentation and run Stage 0**

Document regeneration, schema versions, synthetic audio limitations, human calibration incomplete status, trace retention and paid gate. Do not include provider result claims.

- [ ] **Step 6: Verify GREEN and commit**

Run: `bun test benchmark/tests/reports.test.ts benchmark/tests/stage0.test.ts && bun run benchmark:test && bun run benchmark:stage0 && node scripts/scan-secrets.mjs && git diff --check`

Commit: `feat: complete voice gauntlet stage zero`

## Final branch verification

- [ ] Run `bun run benchmark:test`.
- [ ] Run `bun run benchmark:validate` and prove exactly 50 scenarios.
- [ ] Run `bun run benchmark:stage0` without paid authorization and require `READY_FOR_PAID_BENCHMARK`.
- [ ] Run scenario schema, adapter contract, scorer mutation, deterministic trace/report, budget gate and abort cleanup tests individually for recorded counts.
- [ ] Run `bun run check` and `cd voice-controller && npm test` only if shared production files changed; always run secret scan and `git diff --check`.
- [ ] Dispatch an independent whole-branch reviewer. Fix every Critical and Important finding and re-review.
- [ ] Leave `codex/v0.2-voice-gauntlet` clean. Do not push, merge, tag, deploy or execute a paid provider call.

