# Onboarding resume recovery — September 6, 2026 (Pacific)

The live onboarding button returned `interview_resume_source_not_settled`. Its previous interview was unfinished, with an ended call and settled budget, but provider termination remained `external_evidence_required` after a hangup timeout. There were no active calls. The old successful provider answer and its termination attempt were durably recorded on September 4 UTC.

## Recovery design

`browser_interview_expiry_receipts` is a private, service-only, append-only-by-grant record. `reconcile_browser_interview_expiry` accepts a fresh authenticated sideband 404 only when the exact call/tenant/owner/generation/provider/attempt identities match, the provider answer exists, the call is terminal, budget is settled, and the supported model has exceeded its maximum lifetime after the recorded termination-attempt timestamp.

The timestamp is deliberately not `browser_session_requests.handled_at`: that is written before provider creation. [OpenAI documents a maximum Realtime session lifetime of 60 minutes](https://developers.openai.com/api/docs/guides/realtime-conversations). Expiry evidence is distinct from a confirmed hangup. The original provider state, call record, budget, interview and owner progress are not rewritten.

Only `website_interview_prior_settled` accepts this alternate evidence. Existing scope, generation, competing-call and lineage checks remain in the actual resolver and attachment paths. Final completion still requires its existing confirmation proofs; expiry does not fabricate billing or completion receipts.

The dashboard maps the two unsettled-interview error codes to Portuguese guidance instead of exposing raw SQL identifiers. Recovery remains an operator-mediated evidence check; no repeat hangup, automatic memory reset, new paid session or external communication is introduced.

## Verification

- Focused PostgreSQL suite: valid recovery, exact replay, conflicting replay, twelve invalid qualification/receipt cases, private grants, owner/generation scope, and unchanged call/budget/interview records. Repeat with `node scripts/test-browser-interview-expiry.mjs`; requires PostgreSQL tools (`LIGOU_PG_BIN` can override the local installation path).
- Full isolated database gate: all 79 migrations and existing schema/RLS/application checks pass. QA stack destroyed and original dedicated VM configuration restored. The existing lint warning and informational advisors remain; no new warning/error advisor.
- 172 dashboard tests, including the new friendly-error regression; 90 landing checks and six hosting tests passed.
- Independent review found no blocking issue after replacing the unsafe pre-create timestamp with the termination-attempt anchor.
- Live original-host read-only WebSocket upgrade check returned exact 404 `call_id_not_found` / `invalid_request_error` for the old provider session. An SSM command receipt identifies that observation without exposing credentials.
- Migration applied and expiry receipt recorded. Live helper reports resume permitted; source draft remains valid.
- The real `resolve_prepared_website_source` and `attach_website_interview` paths were tested in a transaction that rolled back. The test also rejected a competing active call and wrong prior-call lineage. No synthetic call/request/receipt survived rollback.
- Before/after fingerprints of the actual interview, call and budget match; no active call was left behind.

The existing interview is ready for the owner to retry. A new human voice conversation is not claimed by these tests.

## Release and operations

Runtime source commit: `55b68d4`. Vercel candidate: https://client-9bzvncyq6-d1fdmarketing-gmailcoms-projects.vercel.app. Stable production URL: https://client-nine-taupe-24.vercel.app. Previous deployment: https://client-2gx05b0hr-d1fdmarketing-gmailcoms-projects.vercel.app.

Migration: `20260907022111_browser_interview_expiry_receipts.sql`. Backend controller and Edge code do not need redeployment: the existing RPC path reads the updated SQL helper. Frontend release changes only error presentation.

For future recovery, first verify the exact owner-bound terminal call, successful provider answer, settled budget and source lineage. Obtain a fresh authenticated read-only provider response and preserve its receipt. Invoke the service-only reconciliation RPC only if all checks qualify. Never mark termination confirmed, erase the interview, release a budget hold, or repeat a provider hangup merely to bypass the guard. `supabase/tests/browser-interview-resume-rollback.sql` verifies a selected existing interview under rollback; it requires the operator to set `ligou.recovery_test_interview` explicitly.

Sanitized receipts and test logs: `output/resume-recovery/` in the recovery worktree. Private provider command/probe source and fingerprints are preserved in the existing private Ligou configuration directory. No secret values are tracked.
