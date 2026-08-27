# Ligou V0.2 Onboarding Coverage and Finalization Design

**Date:** 2026-08-25
**Source baseline:** `codex/v0.2-browser-pilot@6f65667b428fa0f3f7e3df31534746e120553b10`
**User source:** Test 8 E2E report in `/Users/d1f/.codex/attachments/db697083-dd50-459f-9dee-5df44e615d9f/pasted-text.txt`
**Status:** approved behavior, implementation pending

## 1. Problem statement

Test 8 proved that speech recognition and semantic extraction work. The current failure is application orchestration:

1. The interview is considered complete after five prompt-owned topic labels, irrespective of unresolved operational gaps.
2. `pendingRecapAfterRecords` is armed after every recorded fact.
3. Three recap watchdog attempts can be consumed after the first topic.
4. Snapshot query error, timeout, and empty results all collapse to `null`, yet the application still requests speech.
5. A 200-character response can count as a recap without factual validation or audio proof.
6. The third `end_session` is accepted even when no recap occurred.
7. No owner approval is persisted.
8. Hangup follows a timer, not proof that final audio finished playing.
9. Tool execution is marked consumed before its output is durably delivered, so reconnect can lose the continuation.
10. The dashboard equates transport closure with successful interview completion.

The post-deploy call `7f58ee06-6a13-4d45-a2d5-c60244dc92a3` is the canonical regression fixture. Its three recap pushes fired after the initial price facts with `snapshot:0`; remaining topics were collected later; two closes were refused and the third closed without summary or approval.

## 2. Goals

1. Make onboarding completion coverage-driven, not topic-count-driven.
2. Ask only relevant missing or ambiguous follow-ups.
3. Permit explicit `not_applicable` and `owner_review_required` answers so onboarding cannot become infinite.
4. Persist each answer and an immutable coverage revision atomically.
5. Generate one summary intent only after complete, non-empty, digest-bound coverage.
6. Validate summary content and voice/audio lifecycle before requesting approval.
7. Persist explicit owner acknowledgement against the exact snapshot digest.
8. Keep every rule `sugerido`; voice acknowledgement must not activate rules, grant powers, change epochs, create bookings, or change operational mode.
9. Speak one short final signoff and request provider termination only after final playback completion.
10. Make tool execution/output/continuation reconnect-safe and idempotent.
11. Surface interrupted/blocked/complete states truthfully in the dashboard.
12. Produce traceable lifecycle telemetry without logging secrets or unnecessary PII.

## 3. Non-goals

- Do not change model (`gpt-realtime-2.1`), voice (`ash`), provider, WebRTC transport, Calendar, Hermes, Twilio, billing, or customer-call behavior.
- Do not migrate onboarding to STT → text → TTS in this correction.
- Do not auto-approve suggested rules from voice.
- Do not grant operational powers from onboarding acknowledgement.
- Do not add more recap timers, fallback greetings, prompt prohibition lists, or timeout-based hangup guesses.
- Do not redesign the dashboard.
- Do not restart M1, M3, infrastructure reconciliation, or voice-gauntlet benchmarking.

## 4. Approaches considered

### A. Prompt-only expansion — rejected

Add more required questions, stronger “must summarize” language, and more forbidden bridge phrases.

Why rejected: Tests 1–8 already show the model understands the content. The application can still spend recap attempts early and close without proof. Prompt text cannot create durable coverage, approval, idempotency, or playback gates.

### B. In-memory coordinator only — rejected

Move topic flags and close guards into `SessionLedger`, but keep direct rule inserts and best-effort snapshot reads.

Why rejected: it remains non-atomic, loses evidence on reconnect/process failure, cannot bind approval to a durable revision, and cannot safely replay a tool result whose DB insert succeeded before socket loss.

### C. Durable coverage receipts + single lifecycle coordinator — selected

Use the existing append-only `public.receipts` ledger for coverage revisions and owner voice acknowledgement. Replace direct onboarding rule inserts with an idempotent transaction that writes the suggested rule and coverage receipt together. Make a single application reducer own coverage, summary, approval, signoff and termination. `sideband.ts` becomes an event/transport adapter.

This is the smallest approach that closes the confirmed production failure without introducing another authority system.

## 5. Architectural components

### 5.1 `onboarding-coverage.ts` — pure coverage model

Responsibilities:

- validate fact shape;
- normalize field IDs and service subjects;
- merge a new fact into a snapshot;
- compute required, conditional, answered, missing, ambiguous, not-applicable, and owner-review fields;
- choose the next highest-value follow-up deterministically;
- build summary anchors and canonical structured summary data;
- produce a stable canonical digest input.

It does not access Supabase, Realtime, WebRTC, timers, or the prompt.

### 5.2 `onboarding-store.ts` — Supabase boundary

Responsibilities:

- call `record_onboarding_answer` with a controller-derived idempotency key;
- load the latest immutable coverage receipt;
- call `record_onboarding_voice_approval` after coordinator validation;
- return discriminated errors (`query_error`, `timeout`, `empty`, `coverage_incomplete`, `changed`, `not_owner_bound`);
- never collapse an error to `null`.

### 5.3 `onboarding-coordinator.ts` — single lifecycle reducer

Responsibilities:

- own the onboarding phase and revision;
- own response intents for greeting, next question, summary, final signoff, and hangup;
- own tool receipt/outbox state;
- gate all transitions by explicit evidence;
- correlate Realtime response, transcript, audio-generation, playback, tool, snapshot, approval, and termination events;
- emit structured telemetry.

The model chooses natural wording within the current phase. It does not decide phase completion or hangup.

### 5.4 `sideband.ts` — transport adapter

Responsibilities after refactor:

- receive OpenAI events;
- execute controller commands;
- pass typed events into the coordinator;
- send coordinator-produced frames;
- attach/reattach the active socket generation;
- persist/finalize the existing call and budget ledger.

It must not independently schedule recap, accept close, infer approval, or start hangup.

### 5.5 Dashboard voice lifecycle

The browser continues to own local microphone/WebRTC teardown only. It renders durable outcomes:

- `complete`: acknowledgement receipt exists and provider termination is confirmed;
- `finalizing`: approval exists, but final playback/termination is not yet confirmed;
- `interrupted`: transport closed without durable completion;
- `blocked`: snapshot/coverage/invariant failure;
- `live` / `connecting`.

Transport close alone is never labeled “Entrevista encerrada” as a successful outcome.

## 6. Lifecycle

```text
GREETING
  ↓
COLLECTING
  ↓
COVERAGE_CHECK
  ├─ missing/ambiguous → FOLLOW_UP → COLLECTING
  ├─ not_applicable / owner_review_required → record safe disposition → COVERAGE_CHECK
  └─ complete → SNAPSHOT_PREPARING
                     ↓
                SUMMARY_SPEAKING
                     ↓
             AWAITING_OWNER_APPROVAL
              ├─ correction → COLLECTING (new revision)
              └─ explicit approval → APPROVAL_PERSISTING
                                           ↓
                                 FINAL_SIGNOFF_SPEAKING
                                           ↓
                                   READY_TO_TERMINATE
                                           ↓
                                  PROVIDER_TERMINATING
                                           ↓
                                         CLOSED
```

`BLOCKED` is a safe state reachable from snapshot, persistence, invariant, or delivery failures. It cannot transition to closing. Recovery must re-establish the missing proof and re-enter the last proven phase.

### Required transition evidence

| Transition | Required evidence |
|---|---|
| `COLLECTING → SNAPSHOT_PREPARING` | complete typed coverage; all tool executions persisted; all function outputs acknowledged; current response terminal |
| `SNAPSHOT_PREPARING → SUMMARY_SPEAKING` | latest coverage receipt non-empty; complete; stable revision/digest; all rule IDs readable |
| `SUMMARY_SPEAKING → AWAITING_OWNER_APPROVAL` | exact response ID; factual anchor validation; `response.output_audio.done`; `response.done`; `output_audio_buffer.stopped` |
| `AWAITING_OWNER_APPROVAL → APPROVAL_PERSISTING` | fresh owner transcript after summary playback; explicit assent; approval tool/event once |
| `APPROVAL_PERSISTING → FINAL_SIGNOFF_SPEAKING` | immutable voice-approval receipt bound to the same coverage receipt/digest |
| `FINAL_SIGNOFF_SPEAKING → READY_TO_TERMINATE` | signoff response ID; audio generated; response done; output buffer stopped |
| `READY_TO_TERMINATE → PROVIDER_TERMINATING` | deterministic hangup key derived from approval receipt ID |
| `PROVIDER_TERMINATING → CLOSED` | existing durable provider termination receipt confirmed and call terminal write completed |

No refusal count or timeout can bypass these gates.

## 7. Coverage model

### 7.1 Field state

```ts
type CoverageDisposition =
  | "answered"
  | "not_applicable"
  | "owner_review_required";

interface CoverageFact {
  field: CoverageField;
  subject?: string; // normalized service_type for per-service fields
  disposition: CoverageDisposition;
  value: unknown;
  ruleText?: string;
  ownerWords: string;
}

interface CoverageFieldState {
  status: "missing" | "answered" | "ambiguous" | "not_applicable" | "owner_review_required";
  revision: number;
  value?: unknown;
  sourceRuleIds: string[];
}
```

`owner_review_required` is considered safely covered only when it creates a conservative suggested rule that prevents autonomous action and routes the decision to the owner. It is not equivalent to invented data.

### 7.2 Universal required domains

The initial coverage contract requires these domains to be answered or explicitly given a safe disposition:

#### Business

- `business.customer_types` — residential, commercial, or both;
- `business.excluded_work` — work the company explicitly does not perform, or explicit none;
- `business.languages_tone` — owner-facing presentation/language/tone when different from tenant defaults.

#### Area

- `area.coverage` — cities/regions/ZIP/radius;
- `area.out_of_area_policy` — reject, owner review, or travel-fee rule;
- `area.travel_fee` — amount/rule or explicit not applicable.

#### Schedule

- `schedule.business_hours` — days and hours, including Sunday;
- `schedule.same_day_lead_time` — same-day and minimum-notice policy;
- `schedule.capacity_buffer` — capacity/buffer or owner review;
- `schedule.reschedule_cancel` — reschedule, cancellation, no-show/access policy;
- `schedule.holidays` — rule or explicit owner review.

#### Emergencies

- `emergency.types` — covered emergency types;
- `emergency.safety_escalation` — 911/utility/refusal/owner escalation instructions;
- `emergency.after_hours` — after-hours eligibility;
- `emergency.fee_authority` — callout fee versus service price and who may confirm it.

#### Commercial policies

- `policy.payment_estimate` — accepted payment, deposit/estimate/extra-work authority or owner review;
- `policy.warranty_materials` — warranty, customer-provided parts/materials;
- `policy.access_cancellation` — access, visit fee, cancellation/no-show;
- `policy.complaints_returns` — return/rework/complaint escalation or owner review.

#### Ligou authority

- `authority.quote_price`;
- `authority.negotiate_floor`;
- `authority.read_calendar`;
- `authority.book`;
- `authority.reschedule_cancel`;
- `authority.charge_fee`;
- `authority.emergency`;
- `authority.out_of_area`.

### 7.3 Per-service required fields

For every discovered `service_type`:

- `service.name_synonyms`;
- `service.price_mode` — fixed, starting-at, estimate, or owner review;
- `service.price_target` when applicable;
- `service.negotiation` — numeric floor, non-negotiable, or owner review;
- `service.duration`;
- `service.inclusions_exclusions`;
- `service.materials_parts`;
- `service.warranty`;
- `service.emergency_eligibility`;
- `service.escalation` — when not to quote or when owner approval is required.

Conditional fields are required only when triggered. Example: a fixed diagnostic price does not require a negotiable floor if explicitly marked non-negotiable; a service with no materials can mark materials `not_applicable`.

### 7.4 Next-question selection

1. Resolve an ambiguity in the current subject before opening a new domain.
2. Complete the current service before asking about the next service.
3. Prefer safety/authority gaps over convenience gaps.
4. Ask one question per turn.
5. Never ask a field already answered for the current revision.
6. When one owner response answers multiple fields, record each fact and skip those follow-ups.
7. When the owner says “não sei”, record `owner_review_required`, persist the conservative restriction, and continue.
8. When the owner says “não se aplica”, record `not_applicable` and continue.
9. Ask a maximum of two directed follow-ups for the same unresolved group and 256 directed follow-ups in the whole interview. Twenty services expose at most 228 active refs, so this permits one question per ref plus 28 clarifications; 228 answer receipts plus 256 question receipts total 484, below the store's 512-receipt scan bound.
10. Accept at most twenty discovered services in one run; a larger catalog becomes `owner_review_required` and is completed later in Memória.
11. Exhausting a follow-up limit never marks the field answered. The owner must explicitly defer it to `owner_review_required`, or the lifecycle remains `BLOCKED`/incomplete.

Question wording is selected from deterministic Portuguese templates, with field/subject/value context. The Realtime model may make the sentence natural but must not substitute a different field.

## 8. Tool contract

### `record_interview_answer`

Extend the existing schema:

```ts
{
  topic: "servicos" | "area" | "precos" | "agenda" | "emergencia" | "outro";
  field: CoverageField;
  subject?: string;
  disposition: "answered" | "not_applicable" | "owner_review_required";
  rule_text: string;
  structured?: Record<string, unknown>;
  owner_words: string;
}
```

The controller supplies the OpenAI tool `call_id` to persistence. The model cannot supply the idempotency key.

The result returns:

```ts
{
  status: "recorded" | "reused";
  rule_id: string;
  coverage_receipt_id: string;
  revision: number;
  complete: boolean;
  missing: CoverageFieldRef[];
  ambiguous: CoverageFieldRef[];
  next_action:
    | { type: "ask"; field: CoverageField; subject?: string; question_pt: string }
    | { type: "prepare_summary"; snapshot_receipt_id: string; snapshot_hash: string };
}
```

The coordinator, not each individual tool callback, selects one continuation after the whole tool batch is acknowledged.

### `approve_onboarding_summary`

New onboarding-only tool:

```ts
{
  owner_words: string;
}
```

The model calls it only after an explicit approval utterance. The coordinator additionally verifies:

- phase is `AWAITING_OWNER_APPROVAL`;
- the caller transcript occurred after summary playback completion;
- the utterance is explicit assent, not thanks/farewell/ambiguity;
- current snapshot revision/digest still match.

The model supplies neither snapshot ID nor digest.

### `end_session`

Remove it from onboarding authority. It may remain in the global schema for backward compatibility, but every onboarding invocation returns `application_owned_close` and cannot change lifecycle state. The application requests hangup after final signoff playback proof.

## 9. Persistence design

### 9.1 Reuse `public.receipts`

Add receipt kinds:

- `onboarding_coverage`;
- `onboarding_voice_approval`.

No new table is required. Existing receipts are tenant-scoped, FORCE-RLS, append-only, and owner-readable.

Every onboarding receipt must assert:

```json
{
  "authority": {
    "rules_approved": false,
    "powers_granted": false,
    "operational_mode_changed": false
  }
}
```

### 9.2 `record_onboarding_answer` RPC

Service-role-only, `SECURITY DEFINER`, `search_path=''`.

It must:

1. Verify the role claim is `service_role`.
2. Verify the exact call/tenant is an active, authenticated-owner-bound browser onboarding request in `simulation_only`.
3. Acquire the shared call-scoped advisory transaction lock.
4. Verify the controller-generated SHA-256 event key.
5. Return the previous result for exact replay; reject same key/different payload.
6. Deduplicate the same semantic answer hash under a new tool ID.
7. Validate the field/disposition/structured shape.
8. Insert one suggested rule and one complete coverage revision atomically.
9. Return the rule, receipt, revision, missing/ambiguous fields and snapshot digest.

The coverage receipt `readback` carries the complete small projection for that revision: field states, per-service states, selected latest rule IDs, deterministic next action, limits/attempt counters and the false-authority declaration. This is the durable state used after reattach; the application never reconstructs completion from five category counts.

The direct `rules.insert()` in `runTool` is removed.

### 9.3 `record_onboarding_voice_approval` RPC

Service-role-only, same owner/session proof and same call lock.

It must:

1. Select the latest coverage receipt itself.
2. Require complete coverage and the expected current digest.
3. Return the existing receipt for duplicate approval.
4. Append one `onboarding_voice_approval` receipt containing bounded owner words, owner ID, snapshot receipt ID/revision/hash, and the false-authority declaration.
5. Leave every rule `sugerido` and all authority/operational tables unchanged.

### 9.4 Indexes and constraints

- unique controller event key per tenant/kind;
- unique coverage revision per tenant/call;
- unique answer hash per tenant/call;
- unique voice approval per snapshot receipt;
- unique latest coverage revision per tenant/call/revision;
- unique semantic answer hash per tenant/call so the same fact under a different provider tool ID does not duplicate a rule;
- accepted onboarding receipt shape constraint;
- existing append-only trigger retained;
- existing owner-select RLS retained;
- RPC execute granted only to service_role;
- no anon/authenticated execution grant.

The project uses imperative migrations. Create one new forward-only migration using `supabase migration new`; never edit an applied migration or use migration repair.

Corrections reuse the same `rule_group_id` and append a new suggested version. Only the latest suggested version in a group may be approved by `decide_rule`; a corrected-away suggestion must fail closed. Explicit removal appends a rejected latest version so stale text cannot remain reviewable.

## 10. Snapshot and summary

### 10.1 Snapshot result

```ts
type SnapshotResult =
  | {
      ok: true;
      receiptId: string;
      revision: number;
      digest: string;
      rules: RuleSnapshot[];
      coverage: CoverageSnapshot;
      summary: CanonicalSummaryData;
      requiredAnchors: string[];
    }
  | {
      ok: false;
      code: "timeout" | "query_error" | "empty" | "coverage_incomplete" | "changed";
      safeDetail: string;
    };
```

An error enters `BLOCKED`. It emits telemetry and requests neither summary nor close. The query error code and duration are preserved; secrets and rule text are not logged.

### 10.2 Summary response

The coordinator injects canonical summary data from the receipt and requests exactly one response with intent key:

```text
summary:<snapshot_digest>
```

The instruction starts directly with the facts, asks whether everything is correct, and contains no bridge phrase. A natural response is accepted only if its transcript:

- contains all required numeric/location/schedule/safety anchors;
- contains no banned process-narration pattern;
- asks for explicit confirmation;
- belongs to the exact summary response ID and snapshot digest.

Long text alone is never proof. Text-only output never satisfies a voice summary.

### 10.3 Audio/playback proof

For WebRTC, consume:

- `response.output_audio.done` — audio generation complete;
- `response.done` — model response terminal;
- `output_audio_buffer.stopped` — server-managed WebRTC output playback complete.

The OpenAI Realtime API documents that WebRTC/SIP use a server-managed output buffer; no local grace timeout substitutes for this event.

## 11. Approval and correction behavior

- After valid summary playback, phase becomes `AWAITING_OWNER_APPROVAL`.
- “Aprovado”, “está correto”, or equivalent explicit assent can call `approve_onboarding_summary`.
- Thanks, farewell, silence, or ambiguous language do not count.
- A correction calls `record_interview_answer`, creates a new coverage revision, invalidates the old summary/approval candidate, and returns to `COLLECTING`.
- Voice acknowledgement attests that the owner confirmed the recap. It does not activate suggestions.
- Dashboard Memory remains the only path that turns each suggestion into effective policy via `decide_rule`.

## 12. Final signoff and termination

After the approval receipt:

1. request one response with `final-signoff:<approval_receipt_id>`;
2. speak one short Portuguese sentence confirming that the acknowledgement was saved and that rules remain for review in Memória;
3. observe transcript/audio done/response done/output buffer stopped;
4. request provider termination once with `hangup:<approval_receipt_id>`;
5. reuse the existing durable at-most-once provider termination and budget settlement machinery;
6. mark `CLOSED` only after provider confirmation and terminal call persistence.

No ordinary response is legal after `APPROVAL_PERSISTING` except the keyed final signoff.

## 13. Reconnect-safe tool outbox

```ts
interface ToolReceipt {
  toolCallId: string;
  argsHash: string;
  state: "running" | "executed" | "output_pending" | "output_acked";
  resultHash?: string;
  output?: string;
  outputItemId?: string;
}
```

- Persist execution result before socket delivery.
- Send output with deterministic item ID.
- Mark acknowledged only after `conversation.item.created`/equivalent acknowledgement.
- On reattach, resend `output_pending`; never rerun `executed`.
- Continuation is eligible only when every output in the batch is acknowledged.
- Stale socket callbacks cannot mutate the current generation.

## 14. Prompt changes

Prompt changes are supporting constraints, not the control plane:

1. Remove the universal English literal “let me check that”.
2. Permit a bridge phrase only for an actually slow operation, in the active language.
3. Onboarding persistence is silent.
4. Remove the fixed “five topics means done” instruction.
5. Instruct the model to follow `next_action.question_pt` returned by the application and never invent its own completion decision.
6. Summary and closing wording come only from the current coordinator phase.
7. Preserve the correct AI-agent identity and single speak-first greeting.

## 15. Telemetry

Every event includes:

- call ID prefix;
- socket generation;
- lifecycle revision;
- phase;
- response ID/intent key when applicable;
- tool call ID when applicable;
- snapshot digest prefix when applicable;
- elapsed milliseconds;
- sanitized outcome/error.

Required events:

```text
onboarding.coverage.started
onboarding.coverage.changed
onboarding.field.answered
onboarding.field.missing
onboarding.field.ambiguous
onboarding.followup.selected
onboarding.snapshot.prepare_started
onboarding.snapshot.ready
onboarding.snapshot.blocked
voice.tool.admitted
voice.tool.executed
voice.tool.output_sent
voice.tool.output_acked
voice.tool.output_retry
voice.response.intent_queued
voice.response.intent_sent
voice.response.acknowledged
voice.response.terminal
onboarding.summary.validated
onboarding.summary.invalid
onboarding.summary.audio_done
onboarding.summary.playback_done
onboarding.approval.captured
onboarding.approval.persisted
onboarding.approval.rejected
onboarding.final_audio.done
onboarding.final_audio.playback_done
closing.provider_requested
closing.provider_confirmed
onboarding.closed
invariant.violation
```

## 16. Dashboard behavior

- Fix the setup/end race: after `startVoiceSession` resolves, do not set `live` if `endedRef` or `cancelledRef` is true.
- Preserve the current transcript and suggestion UI.
- On remote close, fetch/read the durable call outcome before labeling success.
- Show `Entrevista interrompida` when transport closes without acknowledgement + confirmed termination.
- Show `Finalizando…` between approval persistence and provider confirmation.
- Show `Entrevista concluída` only with durable proof.
- If onboarding voice acknowledgement is displayed, label it separately from operational approval cases:

```text
Cobertura confirmada por voz · revisão N
Regras ainda aguardando aprovação na Memória
```

## 17. Error handling

- Snapshot timeout/query error/empty: `BLOCKED`, no summary, no close.
- Coverage incomplete: return one next question.
- Tool DB success + output send failure: retain `output_pending` and resend after reattach.
- Digest mismatch: reject approval, reload latest snapshot, return to summary preparation.
- Summary content invalid: remain open and emit `summary.invalid`; no automatic duplicate summary for the same revision.
- Summary/final audio interrupted: do not credit completion; return to the last proven phase.
- Provider termination unknown: use existing reconciliation path; dashboard remains finalizing/unknown, not complete.
- Any event after `CLOSED`: no-op plus invariant telemetry.

## 18. Test strategy

### Layer A — pure coverage and reducer

- field/disposition validation;
- service conditional requirements;
- multiple facts in one answer;
- no repeated questions;
- `not_applicable` and `owner_review_required` safe completion;
- corrections create a new revision;
- authority and safety gaps outrank optional gaps;
- complete coverage alone enables snapshot preparation.

### Layer B — Test 8 event replay

Replay the real cadence:

1. greeting;
2. three price facts in one response;
3. ordinary confirmation/next-question turns lasting beyond the old 1.2-second watchdog;
4. area, schedule, emergency, policies and authority facts;
5. coverage complete;
6. one snapshot;
7. one summary;
8. explicit approval;
9. one final signoff;
10. playback stop;
11. one provider termination.

Assert zero summary intents before coverage completion and exactly one afterward.

### Layer C — persistence and security

- exact replay returns same rule/receipt/revision;
- same event key/different payload fails;
- semantic duplicate answer dedupes;
- concurrent facts serialize revisions;
- approval incomplete/digest mismatch fails;
- concurrent approval creates one receipt;
- cross-tenant/wrong owner/non-onboarding/terminal/live tenant fail;
- anon/authenticated cannot execute internal RPCs;
- owner can read own receipts only;
- voice approval leaves effective rules, powers, epochs, bookings, action intents and operational mode unchanged;
- reset preserves historical onboarding receipts.

### Layer D — Realtime lifecycle fixtures

- summary text missing one required anchor fails;
- text-only output cannot satisfy voice proof;
- response done without audio/playback cannot enable approval;
- first through hundredth premature `end_session` cannot close;
- reconnect mid-tool resends one output and inserts one rule;
- reconnect mid-summary/signoff cannot close without playback proof;
- interruption invalidates the affected audio proof;
- final playback stop enables exactly one hangup.

### Layer E — dashboard

- setup/end race;
- peer close before durable completion → interrupted;
- approval persisted but provider pending → finalizing;
- approval + confirmed termination → complete;
- manual hangup remains user-ended, not successful onboarding.

### Layer F — live acceptance

Only after A–E, full suites, independent review and immutable deployment:

- one clean human Test 9;
- then AI-to-AI stress;
- Memory audit/activation;
- four customer simulations;
- final M2 verdict.

## 19. Acceptance invariants

```text
No summary before coverage complete.
No summary with empty/failed snapshot.
One summary intent per snapshot digest.
No approval before valid spoken summary playback completed.
No final signoff before immutable approval acknowledgement.
No hangup before final signoff playback completed.
No bounded bypass around any invariant.
No voice activation of rules or powers.
No successful dashboard label without durable completion proof.
No duplicate rule or continuation after tool replay/reconnect.
```

## 20. Rollout boundary

1. TDD RED against `6f65667`, including the `7f58ee06` cadence.
2. Minimal GREEN implementation.
3. Focused and full voice/dashboard/security/database/release gates.
4. Independent review to 0 Critical / 0 Important.
5. Immutable artifact and SSM deploy.
6. Verify EC2 release/health, Supabase migration/function identity, public dashboard artifact, and no migration drift.
7. Stop before any live voice run and report exact readiness for Test 9.
