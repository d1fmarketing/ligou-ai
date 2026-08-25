# Ligou V0.2 Onboarding Coverage and Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace prompt-owned five-topic completion and timer-based closing with durable coverage, summary, approval, playback and termination gates that make the Test 8 regression impossible.

**Architecture:** A pure TypeScript coverage engine produces deterministic missing fields, follow-ups and summary anchors. Service-role-only Supabase RPCs atomically append suggested rules and immutable coverage/voice-approval receipts. One onboarding coordinator reducer owns response intents and lifecycle; `sideband.ts` becomes its Realtime transport adapter, and the dashboard renders durable completion truth.

**Tech Stack:** Bun 1.2.13, TypeScript, OpenAI Realtime WebRTC/sideband events, Supabase Postgres/PostgREST, pgTAP, React/Vite, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-25-onboarding-coverage-finalization-design.md`

## Global Constraints

- Baseline is `codex/v0.2-browser-pilot@9ff9f2f`; preserve all prior local commits.
- Keep model `gpt-realtime-2.1`, voice `ash`, WebRTC, current sideband, existing provider-termination machinery and `simulation_only` boundary.
- Reuse the existing `/ligou/OPENAI_API_KEY` SecureString; do not create, rotate, print or copy credentials.
- Every production change follows RED → GREEN; record the exact failure before implementation.
- Never edit an applied migration, use migration repair, `git add -A`, stash, reset, clean, amend or rewrite history.
- Voice acknowledgement never activates rules, grants powers, changes epochs, writes provider data, changes tenant status/mode, or mutates bookings/action intents.
- Only dashboard `decide_rule(...,'aprovado')` can activate an onboarding suggestion.
- No prompt-only completion, recap timers, refusal-count bypass, arbitrary close grace or text-length-only recap proof.
- Snapshot errors fail closed and retain a sanitized reason.
- No live voice test until deterministic layers, full suites, review and immutable deployment all pass.

---

### Task 1: Pure deterministic coverage engine

**Files:**
- Create: `voice-controller/src/onboarding-coverage.ts`
- Create: `voice-controller/test/onboarding-coverage.test.ts`
- Modify: `voice-controller/scripts/run-unit-tests.mjs:9-38`
- Modify: `voice-controller/test/unit-runner.test.ts`

**Interfaces:**
- Produces `CoverageField`, `CoverageDisposition`, `CoverageFact`, `CoverageSnapshot`, `CoverageProgress`, `createCoverage`, `applyCoverageFact`, `evaluateCoverage`, `canonicalCoverage`, and `buildSummaryAnchors`.
- Consumed by Tasks 2–5.

- [ ] **Step 1: Write RED tests for initial coverage and false five-topic completion**

Add literal assertions showing a fresh state is incomplete and five generic records do not satisfy required fields:

```ts
const fresh = createCoverage({ tenantId: "tenant-1", callId: "call-1" });
expect(evaluateCoverage(fresh).readyForReview).toBe(false);
expect(evaluateCoverage(fresh).missingRequired).toContainEqual({ field: "business.customer_types" });

let generic = fresh;
for (let index = 0; index < 5; index += 1) {
  generic = applyCoverageFact(generic, {
    field: "policy.access_cancellation",
    disposition: "answered",
    value: { note: `generic-${index}` },
    ownerWords: `genérico ${index}`,
  });
}
expect(evaluateCoverage(generic).readyForReview).toBe(false);
```

- [ ] **Step 2: Run RED and confirm missing module/behavior**

Run:

```bash
cd voice-controller
bun test "$PWD/test/onboarding-coverage.test.ts"
```

Expected: FAIL because `onboarding-coverage.ts` does not exist.

- [ ] **Step 3: Add RED cases for service validation and deterministic next questions**

Cover:

- one service without catalog closure;
- missing duration for one of two services;
- free target `0` accepted, negative/string/NaN ambiguous;
- floor greater than public price ambiguous;
- non-negotiable/not-applicable minimum accepted conservatively;
- required field cannot be skipped;
- explicit `owner_review_required` creates a safe covered disposition;
- insertion order produces the same next field/question;
- one owner answer can satisfy multiple fields;
- max two attempts per group and twelve global follow-ups never mark fields answered;
- adding a service after catalog closure reopens closure;
- correction increments revision and invalidates prior summary readiness;
- maximum twenty services.

- [ ] **Step 4: Implement the minimal field registry and pure reducer**

Use discriminated cells:

```ts
export type CoverageCell =
  | { state: "missing"; attempts: number }
  | { state: "answered"; attempts: number; value: unknown }
  | { state: "ambiguous"; attempts: number; reason: string }
  | { state: "not_applicable"; attempts: number }
  | { state: "owner_review_required"; attempts: number; safeRestriction: string };
```

Validate each field with a registry of literal field IDs and validators. Keep the reducer deterministic: no clock reads inside reducer, no random IDs, no DB calls.

- [ ] **Step 5: Implement deterministic follow-up selection and canonical snapshot**

Order:

```text
ambiguity in current subject
→ service catalog closure
→ each service required fields by ordinal
→ safety and authority
→ area and schedule
→ commercial policy
→ optional/conditional fields
```

Return one `questionPt` from a literal template. Canonical serialization sorts fields and services, excludes timestamps and produces literal `requiredAnchors`.

- [ ] **Step 6: Run focused GREEN and mutation checks**

Run:

```bash
cd voice-controller
bun test "$PWD/test/onboarding-coverage.test.ts"
```

Then mentally/check by temporary local edits that wrong field order, accepting negative price, or treating required skip as complete fails at least one test.

- [ ] **Step 7: Wire the new test into the canonical serial runner and verify inclusion**

Add `test/onboarding-coverage.test.ts` to `unitTestFiles` and extend `unit-runner.test.ts` so the canonical-runner contract proves the new file is executed once in isolation.

- [ ] **Step 8: Commit Task 1**

```bash
git add voice-controller/src/onboarding-coverage.ts voice-controller/test/onboarding-coverage.test.ts voice-controller/scripts/run-unit-tests.mjs voice-controller/test/unit-runner.test.ts
git commit -m "feat: add deterministic onboarding coverage engine"
```

---

### Task 2: Atomic coverage and voice-approval receipts

**Files:**
- Create via `supabase migration new onboarding_coverage_receipts`: the CLI-generated `supabase/migrations/*_onboarding_coverage_receipts.sql`
- Modify: `voice-controller/test/migrations.test.ts`
- Modify: `supabase/tests/database/00_schema_security.sql`
- Modify: `supabase/tests/local-db-rls.mjs`
- Modify: `supabase/tests/local-db-concurrency.mjs`
- Modify: `supabase/tests/local-db-upgrade-rehearsal.mjs`

**Interfaces:**
- Produces service-role-only RPCs `record_onboarding_answer(...) returns jsonb` and `record_onboarding_voice_approval(...) returns jsonb`.
- Adds receipt kinds `onboarding_coverage` and `onboarding_voice_approval`.
- Consumed by Task 3.

- [ ] **Step 1: Write RED migration-contract tests before creating the migration**

In `migrations.test.ts`, assert that forward SQL contains:

```text
onboarding_coverage
onboarding_voice_approval
record_onboarding_answer
record_onboarding_voice_approval
set search_path = ''
grant execute ... to service_role
revoke ... from public, anon, authenticated
```

Assert there is no `decide_rule`, `grant_power`, tenant status/mode update, booking or action-intent mutation inside the approval function body.

- [ ] **Step 2: Run RED**

```bash
cd voice-controller
bun scripts/run-unit-tests.mjs --file "$PWD/test/migrations.test.ts"
```

Expected: FAIL because the forward migration/RPCs do not exist.

- [ ] **Step 3: Create the migration using the repository workflow**

```bash
supabase migration new onboarding_coverage_receipts
```

Use the exact path printed by the CLI for all remaining Task 2 edits and commit it.

- [ ] **Step 4: Implement receipt constraints and indexes**

Retain all existing receipt kinds and add the two onboarding kinds. Add:

```sql
create unique index receipts_onboarding_event_key_unique
  on public.receipts (tenant_id, kind, external_id)
  where kind in ('onboarding_coverage','onboarding_voice_approval');

create unique index receipts_onboarding_coverage_revision_unique
  on public.receipts (tenant_id, call_id, ((readback ->> 'revision')::integer))
  where kind = 'onboarding_coverage';

create unique index receipts_onboarding_answer_hash_unique
  on public.receipts (tenant_id, call_id, (detail ->> 'answer_hash'))
  where kind = 'onboarding_coverage';

create unique index receipts_onboarding_approval_snapshot_unique
  on public.receipts (tenant_id, call_id, (readback ->> 'snapshot_receipt_id'))
  where kind = 'onboarding_voice_approval';
```

Add a shape constraint requiring schema version 1, call ID, accepted outcome, SHA-256 payload hash and false-authority declaration.

- [ ] **Step 5: Implement `record_onboarding_answer` atomically**

The function must:

1. require `current_setting('request.jwt.claim.role', true) = 'service_role'`;
2. validate the controller SHA-256 event key;
3. join call → tenant → ready onboarding browser request → owner;
4. require active call and `simulation_only`;
5. acquire `pg_advisory_xact_lock(hashtextextended('ligou.v0_2.onboarding:' || tenant || ':' || call,0))`;
6. replay exact event key, reject key/payload mismatch;
7. dedupe semantic answer hash;
8. insert one `sugerido` rule and one complete coverage receipt in the same transaction;
9. return the durable rule/receipt/revision/digest/progress.

- [ ] **Step 6: Implement `record_onboarding_voice_approval` atomically**

It selects the latest coverage receipt itself, requires complete coverage, binds approval to that receipt/digest, records bounded owner words and false authority, reuses duplicates, and leaves all suggestions untouched.

- [ ] **Step 7: Extend pgTAP and local DB RED tests**

Add exact assertions for:

- service role can execute exactly the two new RPCs in addition to the current allowlist;
- anon/authenticated cannot execute them;
- owner reads only own receipts through existing RLS;
- same event replay is reused;
- key mismatch fails;
- semantic duplicate dedupes;
- concurrent answers serialize revisions;
- incomplete/digest-mismatched approval fails;
- concurrent approval creates one receipt;
- cross-tenant, wrong owner-bound request, non-onboarding, terminal and live-tenant calls fail;
- effective rules, powers, epochs, bookings, intents and tenant mode remain unchanged.

- [ ] **Step 8: Run focused DB/migration gates GREEN**

```bash
cd voice-controller
bun scripts/run-unit-tests.mjs --file "$PWD/test/migrations.test.ts"
cd ..
bun run db:gate:local
```

Expected: all migration, pgTAP, RLS, concurrency and rehearsal checks pass with the new exact counts.

- [ ] **Step 9: Commit Task 2**

Stage only the generated migration and exact test files:

```bash
git add supabase/migrations/*_onboarding_coverage_receipts.sql voice-controller/test/migrations.test.ts supabase/tests/database/00_schema_security.sql supabase/tests/local-db-rls.mjs supabase/tests/local-db-concurrency.mjs supabase/tests/local-db-upgrade-rehearsal.mjs
git commit -m "feat: persist onboarding coverage and voice acknowledgement"
```

---

### Task 3: Onboarding store and idempotent tool boundary

**Files:**
- Create: `voice-controller/src/onboarding-store.ts`
- Create: `voice-controller/test/onboarding-store.test.ts`
- Modify: `voice-controller/src/tools.ts:12-48,158-179,195-214,423-455`
- Modify: `voice-controller/test/tools.test.ts`
- Modify: `voice-controller/scripts/run-unit-tests.mjs`
- Modify: `voice-controller/src/server.ts:29-115`
- Modify: `voice-controller/test/session-tenancy.test.ts`
- Modify: `voice-controller/test/accept-call-edge.test.ts`

**Interfaces:**
- `recordOnboardingAnswer(cap, providerToolCallId, args): Promise<RecordedCoverage>`
- `loadOnboardingSnapshot(cap): Promise<SnapshotResult>`
- `recordOnboardingVoiceApproval(cap, providerToolCallId, ownerWords): Promise<VoiceApproval>`
- Capability gains `ownerUserId?: string` and `sessionType`.

- [ ] **Step 1: Write RED store tests**

Test complete RPC input shape, controller-generated event key, discriminated errors, exact replay, and that no plaintext secret or full transcript is passed.

- [ ] **Step 2: Run RED**

```bash
cd voice-controller
bun test "$PWD/test/onboarding-store.test.ts"
```

- [ ] **Step 3: Implement store with injectable Supabase boundary and time source**

Hash event scope from tenant ID, call ID, provider tool call ID and canonical fact. Return errors as:

```ts
type SnapshotResult =
  | { ok: true; receiptId: string; revision: number; digest: string; coverage: CoverageSnapshot; rules: RuleSnapshot[]; requiredAnchors: string[] }
  | { ok: false; code: "timeout" | "query_error" | "empty" | "coverage_incomplete" | "changed"; safeDetail: string; durationMs: number };
```

- [ ] **Step 4: Extend onboarding tool schemas**

Require `field`, `disposition`, `rule_text`, and `owner_words`; support `subject` and `structured`. Add `approve_onboarding_summary { owner_words }`. Keep `end_session` visible only for compatibility but return `application_owned_close` in onboarding.

- [ ] **Step 5: Replace direct rule insert**

Route `record_interview_answer` through `recordOnboardingAnswer`. Never allow the model to supply the idempotency key or snapshot digest.

- [ ] **Step 6: Bind authenticated owner principal**

Pass `userId` into onboarding capability at `startSession`; keep customer/phone capability behavior unchanged. Filter the OpenAI tool schemas by session type so onboarding sees only business info, record fact and approval tools.

- [ ] **Step 7: Run focused GREEN and canonical tool/security tests**

```bash
cd voice-controller
bun test "$PWD/test/onboarding-store.test.ts" "$PWD/test/tools.test.ts" "$PWD/test/session-tenancy.test.ts"
```

- [ ] **Step 8: Commit Task 3**

```bash
git add voice-controller/src/onboarding-store.ts voice-controller/src/tools.ts voice-controller/src/server.ts voice-controller/test/onboarding-store.test.ts voice-controller/test/tools.test.ts voice-controller/test/session-tenancy.test.ts voice-controller/scripts/run-unit-tests.mjs
git commit -m "feat: make onboarding facts idempotent and owner bound"
```

---

### Task 4: Single onboarding lifecycle coordinator

**Files:**
- Create: `voice-controller/src/onboarding-coordinator.ts`
- Create: `voice-controller/test/onboarding-coordinator.test.ts`
- Modify: `voice-controller/src/response-coordinator.ts`
- Modify: `voice-controller/scripts/run-unit-tests.mjs`

**Interfaces:**
- `createOnboardingLifecycle(callId): OnboardingLifecycle`
- `reduceOnboarding(lifecycle, event): { lifecycle; commands: OnboardingCommand[] }`
- `OnboardingCommand` covers persist fact, resend output, ask follow-up, prepare summary, request response, persist approval, request signoff, request hangup and block.

- [ ] **Step 1: Write RED reducer tests for forbidden transitions**

Assert:

- no summary before complete coverage;
- snapshot timeout/error/empty → blocked and zero response intent;
- no approval before valid summary transcript + audio done + response done + playback stopped;
- no signoff before persisted approval;
- no hangup before signoff playback stopped;
- any `end_session` attempt in any preterminal phase is refused without bypass;
- events after closed are no-op plus invariant command.

- [ ] **Step 2: Write the realistic `7f58ee06` RED replay**

Replay three initial price tools, three old-watchdog intervals/short promise responses, area, schedule, emergency and general policy. Assert:

```ts
expect(commandsBeforeCoverage.filter(isSummaryIntent)).toHaveLength(0);
expect(commandsAfterCoverage.filter(isSummaryIntent)).toHaveLength(1);
```

- [ ] **Step 3: Run RED**

```bash
cd voice-controller
bun test "$PWD/test/onboarding-coordinator.test.ts"
```

- [ ] **Step 4: Implement reducer and stable intent keys**

Use:

```text
greeting:<call>
tool-batch:<provider-response-id>:<batch-hash>
summary:<snapshot-digest>
final-signoff:<approval-receipt-id>
hangup:<approval-receipt-id>
```

No timers decide phase completion.

- [ ] **Step 5: Implement factual summary validation**

Accumulate transcript only for the exact summary response ID. Require every literal anchor, an approval question, no process narration, audio done, response done and playback stopped. Text-only response is insufficient.

- [ ] **Step 6: Implement approval/correction semantics**

A correction invalidates the old summary revision and returns to collecting. Only a fresh post-playback explicit assent can produce `persistApproval`. Ambiguous thanks/farewell do not.

- [ ] **Step 7: Implement tool outbox state**

Track `running → executed → output_pending → output_acked`. A replayed provider tool ID with the same args reuses output; mismatched args block. Reattach resends pending output and never reruns DB execution.

- [ ] **Step 8: Run focused GREEN**

```bash
cd voice-controller
bun test "$PWD/test/onboarding-coordinator.test.ts"
```

- [ ] **Step 9: Commit Task 4**

```bash
git add voice-controller/src/onboarding-coordinator.ts voice-controller/src/response-coordinator.ts voice-controller/test/onboarding-coordinator.test.ts voice-controller/scripts/run-unit-tests.mjs
git commit -m "feat: govern onboarding with one lifecycle reducer"
```

---

### Task 5: Refactor sideband into the lifecycle adapter

**Files:**
- Modify: `voice-controller/src/sideband.ts`
- Modify: `voice-controller/test/sideband-continuation.test.ts`
- Modify: `voice-controller/test/sideband-settlement.test.ts`
- Modify: `voice-controller/test/simulation-flow.test.ts`
- Modify: `docs/release/V0.2-VOICE-RESPONSE-OWNERSHIP.md`

**Interfaces:**
- Consumes lifecycle reducer/store commands from Tasks 3–4.
- Preserves existing provider termination and budget finalization interfaces.

- [ ] **Step 1: Reverse unsafe existing tests to RED**

Replace:

- “best-effort third close succeeds” with “first through hundredth premature close never succeeds”;
- “farewell reconnect auto-closes after grace” with “reconnect cannot close before proven final playback”;
- character-count recap proof with factual/audio proof.

- [ ] **Step 2: Add RED event-correlation tests**

Cover `response.created`, `conversation.item.created`, `response.output_audio_transcript.done`, `response.output_audio.done`, `response.done`, `output_audio_buffer.stopped`, speech interruption, `session.ended`, provider error and stale socket generation.

- [ ] **Step 3: Run focused RED**

```bash
cd voice-controller
bun scripts/run-unit-tests.mjs --file "$PWD/test/sideband-continuation.test.ts"
```

- [ ] **Step 4: Remove recap watchdog and close grace ownership**

Delete `pendingRecapAfterRecords`, `recapPushes`, `recapRefusals`, `recapPushTimer`, character-credit recap and `maybeScheduleAgentEnd`. Route every onboarding decision through coordinator commands.

- [ ] **Step 5: Execute response intents with metadata and correlation**

Associate each `response.created` ID with the pending intent key. Consume `response.output_audio.done` and `output_audio_buffer.stopped`; never infer playback from `response.done`.

- [ ] **Step 6: Execute durable output resend/ack**

Use deterministic conversation item IDs and mark output acknowledged only on the provider acknowledgement event. Reattach drains `output_pending` before requesting continuation.

- [ ] **Step 7: Trigger existing provider termination only from `requestHangup`**

The reducer emits this only after approval-bound signoff playback. Keep at-most-once provider termination, settlement and reconciliation unchanged.

- [ ] **Step 8: Add complete safe telemetry**

Emit the spec event names with call prefix, socket generation, lifecycle revision, phase, response/intent/tool/snapshot IDs and latency. Snapshot errors log code/duration, not contents/secrets.

- [ ] **Step 9: Run focused and full voice GREEN**

```bash
cd voice-controller
bun scripts/run-unit-tests.mjs --file "$PWD/test/sideband-continuation.test.ts"
npm test
```

Expected: every serial file passes, including new coverage/store/coordinator suites.

- [ ] **Step 10: Commit Task 5**

```bash
git add voice-controller/src/sideband.ts voice-controller/test/sideband-continuation.test.ts voice-controller/test/sideband-settlement.test.ts voice-controller/test/simulation-flow.test.ts docs/release/V0.2-VOICE-RESPONSE-OWNERSHIP.md
git commit -m "fix: require coverage approval and playback before hangup"
```

---

### Task 6: Remove prompt contradictions and bind model wording to application state

**Files:**
- Modify: `voice-controller/src/instructions.ts:14-28,89-106`
- Modify: `voice-controller/test/tools.test.ts`

**Interfaces:**
- Consumes `next_action.question_pt` and summary/signoff commands from coordinator.

- [ ] **Step 1: Write RED behavior assertions**

Build onboarding instructions and assert:

- no literal `let me check that`;
- no fixed “five topics then done” completion rule;
- persistence is silent;
- completion comes only from application `next_action`;
- correct AI-agent greeting remains;
- summary starts with facts and asks explicit approval;
- model cannot invoke `end_session` as authority.

- [ ] **Step 2: Run RED**

```bash
cd voice-controller
bun test "$PWD/test/tools.test.ts"
```

- [ ] **Step 3: Make minimal prompt changes**

Replace global English bridge instruction with active-language, actually-slow-operation guidance. Replace topic-count text with application-driven next action and lifecycle wording. Do not add a long prohibition list.

- [ ] **Step 4: Run GREEN and full voice suite**

```bash
cd voice-controller
bun test "$PWD/test/tools.test.ts"
npm test
```

- [ ] **Step 5: Commit Task 6**

```bash
git add voice-controller/src/instructions.ts voice-controller/test/tools.test.ts
git commit -m "fix: make onboarding wording follow durable coverage"
```

---

### Task 7: Truthful dashboard completion states

**Files:**
- Modify: `dashboard/src/voice/session.js`
- Modify: `dashboard/src/voice/VoicePanel.jsx`
- Create: `dashboard/tests/voice-session.test.mjs`
- Modify: `dashboard/package.json`

**Interfaces:**
- Session end callback returns `{ reason, callId }`.
- VoicePanel resolves durable call/receipt outcome through the existing Supabase client before success copy.

- [ ] **Step 1: Write RED tests for setup/end race and outcome mapping**

Assert:

- `onEnd` during setup prevents later `setStatus("live")`;
- peer close without approval/confirmed termination maps to interrupted;
- approval receipt with provider pending maps to finalizing;
- approval receipt + confirmed termination maps to complete;
- manual hangup never maps to successful onboarding.

- [ ] **Step 2: Wire test into canonical dashboard suite and run RED**

```bash
cd dashboard
npm run test:dashboard
```

- [ ] **Step 3: Implement minimal lifecycle/result mapping**

Check `endedRef` alongside `cancelledRef` after `startVoiceSession` resolves. Preserve existing UI composition; add only the three truthful result strings and durable read.

- [ ] **Step 4: Run dashboard GREEN, build and Sites tests**

```bash
cd dashboard
npm test
```

- [ ] **Step 5: Commit Task 7**

```bash
git add dashboard/src/voice/session.js dashboard/src/voice/VoicePanel.jsx dashboard/tests/voice-session.test.mjs dashboard/package.json
git commit -m "fix: show durable onboarding completion truth"
```

---

### Task 8: Full verification, review, release evidence and deployment

**Files:**
- Create: `docs/release/V0.2-M2-ONBOARDING-FINALIZATION.md`
- Modify: `docs/release/V0.2-VOICE-RESPONSE-OWNERSHIP.md`

**Interfaces:**
- No new runtime interface; this task proves the integrated story.

- [ ] **Step 1: Run serial verification from a clean tracked tree**

```bash
git diff --check
cd voice-controller && npm test
cd .. && PATH="/tmp/ligou-m1-toolchain:/opt/homebrew/bin:/usr/bin:/bin" bun run test:security
cd dashboard && npm test
cd .. && bun run secrets:scan
bun run db:gate:local
```

Record exact counts and exit codes. Do not pipe commands in a way that masks failures.

- [ ] **Step 2: Run deterministic packaging/release gates**

```bash
bun run test:deploy-release
release_commit=$(git rev-parse HEAD)
artifact_path="/tmp/ligou-release-${release_commit}.tar.gz"
node infra/package-release.mjs --root "$PWD" --output "$artifact_path" --commit "$release_commit"
shasum -a 256 "$artifact_path"
tar -tzf "$artifact_path" > "/tmp/ligou-release-${release_commit}.entries"
```

The deploy-release suite verifies manifest binding; the direct package run proves the exact current commit packages independently. Inspect the entry list for forbidden secret/model-auth/test paths before deployment.

- [ ] **Step 3: Independent review**

Review the complete `6f65667..HEAD` corrective range for:

- coverage bypass;
- infinite interview;
- stale/different snapshot approval;
- voice approval activating authority;
- missing RLS/grants/search path;
- tool replay/output loss;
- summary without factual/audio/playback proof;
- close before signoff playback;
- reconnect/stale socket;
- dashboard false success;
- secret/log leakage.

Fix every Critical/Important finding with a new RED test and repeat review to 0/0.

- [ ] **Step 4: Write release evidence document**

Include source identities, migration, coverage contract, Test 8 replay, every test count, review findings/fixes, no-authority proof, package hash and exact remaining live gate.

- [ ] **Step 5: Commit the evidence document**

```bash
git add docs/release/V0.2-M2-ONBOARDING-FINALIZATION.md docs/release/V0.2-VOICE-RESPONSE-OWNERSHIP.md
git commit -m "docs: record deterministic onboarding finalization evidence"
```

- [ ] **Step 6: Controlled remote rollout**

Only after local gates/review:

1. verify remote migration history still equals local;
2. create the required pre-change database backup per existing runbook;
3. apply only the new forward migration;
4. verify RLS/grants/RPC signatures and no authority changes;
5. deploy the immutable EC2 artifact through `infra/deploy.sh`;
6. verify `/opt/ligou/current`, release-health and deploy receipt;
7. build one exact dashboard artifact, validate preview, then promote that same artifact;
8. verify Edge identity is unchanged unless source actually changed;
9. verify production source/dashboard/DB/EC2 identities agree.

- [ ] **Step 7: Stop before live Test 9**

Return the exact clean-state checklist and evidence-capture plan. Do not execute a live voice run without RJ initiating the acceptance session.
