# Voice onboarding repair — September 6 failed live test

Status: implementation and verification in progress. **Not ready for live acceptance.** The execution goal remains active; no production acceptance is claimed.

Current verification note: the first combined staged candidate (`5fdd8cc6…fe91`) was rejected by independent review for reproduced interruption/custody races. The corrective regressions now cover empty/failed/missing final ASR, playback receipts in flight, deferred recap speech, business-policy stop language, and known-call Stop/retry custody. The final context regression (new-question barge-in bound to the previous item) is fixed and independently approved: 68 runtime/coordinator tests pass. The complete voice runner passed 58 suite processes / 1,368 reported tests, dashboard 192, security 8, release/local-gate runner 32, and secret scan 829 tracked files. The source-bound territory acknowledgment passed 72 focused tests and 16 SQL/TS action comparisons. The audio harness now checks persisted source identity after successful completion; its completion/source-change self-test passed. The subsequent quoted-policy regression is also fixed and independently approved: bounded attributed quotations do not trigger the agent-offer guard; surrounding speech stays checked. Full database gate reached strict lint and rejected six new warnings; volatility/type declarations and an unused variable are corrected for its rerun. Frozen candidate `5f9836f0…` passed the full PostgreSQL 17.6 gate (82 migrations, strict lint with only its one existing warning, actual runtime/store/SQL territory progression, RLS, concurrency and upgrade checks), full voice runner and 193 dashboard tests. It was committed as `ceccb14827eb5ed7179736446ec314c72a9a11ff`; two packages had identical SHA `61ced215b22cc4ddbe28e17b5098035ee13c4e85af3a0d605df0c94771a337cb`. No new real-provider audio acceptance call has run.

## Authoritative baseline

- Source: `/Users/d1f/Desktop/Ligou.AI`, clean `main` at `b9caf66fb33af7b867641164fd8278f383b0a50c` before this work. Work continues on `codex/voice-onboarding-resilience`; the historical Discovery worktree is an ancestor and is preserved.
- Live EC2 readback: `8de9bc2c63bb17de04ac993257dded4dbfec9cf6-04976beee3b8997da991f7b0f74921adfbc830be28d76e43a31d29832d0e5255`, controller active since September 5 23:19:50 UTC, zero live sessions. This is the rollback target for the controller. The onboarding runtime matches the current source baseline.
- Edge `browser-session`: version 16, active; bundle `25a700a3bd6ae9a120ba504ff1f120140abcb0e9e406bfef987a3a2e4f49063a` (same bundle as the earlier v10 report).
- Production dashboard serves `index-DVyQjVc9.js` (SHA `3622abb30028d9329dd73a609bf5992a305fcda6ccaed421f82d7a117d5cc714`) and `index-B7mGzSuw.css`. Vercel readback: `dpl_3REbsrt7GggjMKyWDgPXwPz6dnov`, immutable `client-9bzvncyq6-d1fdmarketing-gmailcoms-projects.vercel.app`, Ready, created September 6 19:34:36 Pacific; retained as dashboard rollback.
- Database: 79 migrations, latest `20260907022111_browser_interview_expiry_receipts`. Website draft `46603c2c-c4d9-4d79-b35c-cd5b658388ab`, row version 1 / schema v2, hash `32dfe1a9341118b8e868650a1ed5c6bf70b7257728ca3637f374fda5e54ee4e0`; five source pages and 21 candidate facts remain. Discovery control is disabled and its EC2 supervisor is inactive.

## Exact new failure and evidence

- Browser request: `037a6686-348c-4d63-8e5e-94609e191607`.
- Application call: `c087e6c0-8394-47cf-8cfb-c704129a5e45`; stored start September 6 **19:42:20 Pacific** / September 7 02:42:20.025834 UTC. This is the call row time, not the Start click time.
- Provider: `rtc_u0_ELJbOatORo0spenS0ENAB`.
- Authenticated tenant: `6e915234-0cee-4d67-9eba-60c2c920dd15`, current name `D1f Marketing`; owner identity agrees between request and interview. Website fixture is the preserved Foghorn source; differing labels alone are not treated as an isolation defect.
- Interview: `9d231297-f3c6-4150-8ce9-187fa24e45de`, generation 2, durable revision 0/store version 2. Current question is territory; all 114 agenda items remain open.
- Owner utterance is durably recorded at 02:42:59.555212 UTC. Stored ASR says “novatos São Rafael e Petaluma” and preserves the explicit owner-approval condition. **No fact-batch/answer commit exists. No approval exists.**
- Terminal audio was played; provider hangup confirmed at 02:43:18.562148 UTC. Budget settled at 02:45:12.357514 UTC, 0.85 minutes / conservative USD 0.2125; provider usage remains unknown, not invented.
- The original exception was not logged. Recomputing the terminal action hash from the parsed persisted binding identifies the exact selected code `persist_agenda_failed`. The runtime then overwrites authenticated scope.requestId with its internal effect requestId. The store passes that wrong ID into the SQL ownership guard. The original integration test removed that field manually, bypassing the failing runtime boundary.
- The original 12.792-second MP3 matches its persisted audio hash. Independent local Whisper transcription finds “artificial” once, as does the original text. There is no original browser loopback recording to rule out a client playback anomaly; repetition is not reproduced in the saved asset.

Evidence directory: `output/voice-onboarding-20260906/`. Relevant files: `failed-attempt.json`, `failed-receipts.json`, `failed-journal.json`, `terminal-reason-proof.json`, `database-baseline.json`, `edge-baseline.json`, `original-opening.mp3`, `local-audio-review/original-opening.json`. Credentials and test auth are stored only in the existing private Ligou configuration directory.

## Causal changes and regression ledger

| Confirmed defect | Change | Evidence so far |
|---|---|---|
| Internal effect ID overwrites authenticated browser request ID | Preserve original scope at runtime/store call | Three wording variants fail with revision 0 before fix and pass with revision 1 afterward; real runtime/store/SQL integration replaces the prior manually adjusted test |
| Transient write failure immediately ends interview | Three-attempt / ten-second bounded recovery; exact-operation replay | Focused RED/GREEN runtime tests |
| Timeout after commit skips durable reconciliation | Read exact revision/digest/store version before replay | RED/GREEN: one commit, one durable read, one progression |
| Supabase HTTP 503 without SQL code loses retry classification | Preserve HTTP status and prioritize explicit security codes | Independent reviewer reproduction with real Supabase client, then RED/GREEN regression |
| Acknowledgment can be labeled an answer by interpreter | Application treats brief acknowledgment as clarification, not answer/approval | “Ah, entendi”, “Uhum”, “Tá bom” RED/GREEN |
| Signoff failure erases in-memory proof of a real approval | Preserve durable approval separately from teardown | RED/GREEN coordinator regression |
| Wall-clock movement can affect process deadlines | Monotonic runtime deadlines and redacted stage diagnostics | Wiring test now explicitly proves clock jump cannot end session |
| A polite trailing “combinado?” rejects a valid related territory answer | Preserve agreement tag semantics while retaining true-question/uncertain-scope rejection | Exact source fixture resolves both territory gaps; RED/GREEN, 32 applicability tests |
| Microphone closed during recap; interrupted/failed ASR can strand speech | Allow owner barge-in, durable interruption and bounded rendition receipts; no synthetic owner words for empty ASR | Browser/runtime/SQL regressions; final provider audio proof pending |
| Owner responds while played receipt is in flight | Track client playback boundary, finish durable receipt, then process the owner turn | Reproduced old fatal interruption, corrected runtime regression |
| Answer during the published next question binds to the previous question | Distinguish published current question from preparation gap; retain previous context only in the latter | RED/GREEN runtime cases, independent scoped approval |
| Summary IO completion speaks over the owner | Defer selected speech until pending owner input is processed; correction invalidates obsolete recap | Deterministic reducer regression |
| Generic stop grammar confuses ending business practices with interview pause | Require conversation/configuration object or an unqualified stop request | Three business-policy counterexamples RED/GREEN |
| Stop during opening loses known call ID; UI permits restart before teardown proof | Early call custody, known-call end tracking and proof-gated restart | Rendered Edge Beta regression with simulated transport |
| Natural present-tense approval is rejected | Extend anchored TS/SQL grammar while retaining owner/current-recap receipt gates | 89 parity cases, all 50 prior classifications preserved |
| Literal owner quotation in recap or territory confirmation triggers generic-offer blacklist | Preserve exact persisted speech binding; exempt only attributed confirmation quote from ordinary-utterance offer scan | Speech/browser/coordinator RED/GREEN; surrounding offers still rejected; independent approval |

The ASR watchdog attempts one matching-item retrieval after five seconds and fences a missing final transcription after ten seconds. An attached retrieved transcript is not promoted to a final owner answer or approval: the provider documentation does not establish that finality guarantee. Missing final ASR and a genuinely empty completed ASR have distinct evidence paths.

Controlled fixture preparation: existing test user `05495cf9-239d-4f9e-ac45-8d4f6b5e2cc9` authenticated without sending email. Its isolated tenant `49ef9a84-d0e1-4774-94a4-34538670c615` was created through the actual owner bootstrap, in `simulation_only`, generation 0, with unchanged default daily budget USD 15. The faithful source-copy SQL passed a rollback rehearsal and was applied to this isolated tenant: five source pages and 21 candidate facts. The preparation RPC awaits the tested migration release; no calls have been created. Original source readback remains unchanged at revision 0 with no approval. The original owner tenant, answers and website result remain unchanged. The local audio harness has 114 mapped items, 21 source candidates and 70 Brazilian Portuguese WAVs; offline Edge media smoke is not provider E2E.

Startup worker and browser UX changes are being integrated. Their focused tests are distinct from production or audio proof. A scoped independent recovery review found one Important issue (HTTP status loss); fixed, final review pending.

## Release execution update

- Dashboard staged and authenticated-byte-verified: `dpl_5S2K9u2TbgptUHAsshEVTcQDavq4`, `client-3pmm0kf0l-d1fdmarketing-gmailcoms-projects.vercel.app`, JS `index-BKQrt_KO.js`. Stable production alias still serves the prior bundle; no promotion yet.
- Production SQL push twice rolled back on the same parent/speech-table deadlock. Readback confirms 79 original migrations and no partial new RPC/table. The migration now takes final-strength locks parent first with a five-second lock wait. The actual PostgreSQL concurrency regression reproduced the old deadlock, completed both transactions with the new order, and proved a busy parent times out after five seconds before later DDL. Full database verification is rerunning before another push.
- Audio-harness cleanup observation now allows 180 seconds for actual provider/budget receipts, tested with a 100-second simulated reconciliation delay. It waits for an enabled rendered Start/resume control. Production call limits and budgets remain unchanged. Offline Edge media smoke passed; no new provider call has run.

## Outstanding work / completion gates

1. Complete corrective independent review and final source-frozen gates. The database gate reached its final worktree assertion on an earlier run, but was rejected because source changed during the run; no database PASS is claimed from it. The runner now preserves child stderr on EPIPE, and temporary QA profile changes are restored after each run.
2. Verify interruption/resume/amendment/dashboard truth through the full actual schema and real transport. Migrations `20260907033624` and `20260907042511` are not yet applied to production.
3. Complete full relevant unit, actual-schema, database/security/release and changed dashboard/Edge gates. Freeze and independently review the candidate.
4. Deploy changed surfaces through existing immutable release procedure; bind source/package/runtime/front-end identities and retain rollback.
5. Run genuine deployed browser-to-provider audio interviews with isolated fixture/credentials (normal; variations/corrections/off-scope; recoverable failure/resume). The current real browser/media harness is `scripts/voice-onboarding-audio-acceptance.mjs`; local `say` Brazilian Portuguese voices and a cached local Whisper model are available. Offline media verification passed; source-proof handling after completion is being corrected before execution. No real customers may be contacted.
6. Measure 10 warm / 5 cold starts, total click-to-rendered speech and actionable question, raw samples/percentiles/max/conditions; measure turn ASR and processing separately. Targets are unchanged. Historic logs do not supply original click-to-audio onset.
7. Verify cleanup, source preservation and prepared human attempt. Only then emit `LIGOU_VOICE_ONBOARDING_READY_FOR_LIVE_ACCEPTANCE` and wait for human input. A verified successful human test is still required for `LIGOU_VOICE_ONBOARDING_ACCEPTED_IN_PRODUCTION` and goal completion.
8. Verify the new source-bound territory acknowledgment through actual provider ASR and playback. Focused proof confirms both supplied transcript variants, retained restrictions, unchanged next-question selection and legacy stored-action compatibility. Migration `20260907062057` mirrors the TypeScript derivation.

No new Discovery run, provider replacement, paid text fallback, spending-cap increase, operating permission or owner approval has been introduced.
