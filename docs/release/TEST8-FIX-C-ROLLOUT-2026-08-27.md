# Test 8 Fix C — final rollout evidence

## Verdict

`TEST8_FIX_DEPLOYED_READY_FOR_TEST9`

This is deployment evidence, not Test 9 evidence. No Test 9 call was started.

## Source

- Worktree: `/Users/d1f/.codex/worktrees/ligou-v0.2-browser-pilot/Ligou.AI`
- Branch: `codex/v0.2-browser-pilot`
- Fix-C starting runtime: `d32b85c46f3e478ef78ed8d6c5e1cb1d012907f6`
- Deployed runtime commit: `38e75ecad698004609a58b7860f396f332dfc980`
- Deployed runtime tree: `b57eec3fc9a9e6686f7f9c28ce2d9cd35f400b6e`
- Runtime worktree was clean before packaging and deployment.

Fix-C commits:

1. `153acf44abac0e5f84b7e0ab8d8593db78a97810` — lifecycle liveness and final spoken authority;
2. `e54dbde2439479e691220520d3c9484e4814015c` — reachable coverage and owner-owned locality;
3. `73b1d381aca098d639becb4cf89d76a09216f2e1` — transcript-first approval correlation;
4. `690a8a76e15f185a7a1309e5856a065659b1a601` — concurrent caller turns bound by speech order;
5. `38e75ecad698004609a58b7860f396f332dfc980` — `turn_detected` barge-in custody.

## Fix C

Implemented and proven:

- sent-but-unacknowledged `response.create` blocks rather than duplicating application speech;
- greeting, summary and signoff allow only one terminally correlated retry;
- final signoff requires the exact application-owned transcript plus audio, terminal response and playback stop;
- caller transcription is approval authority; model tool arguments are not;
- approval works for transcript-first, response-first, out-of-order transcription, concurrent pending turns and `turn_detected` barge-in;
- indeterminate fact/follow-up/approval mutations reconcile receipt-first once on the same socket, then block;
- directed follow-up cap is 256 in TypeScript and the final SQL boundary;
- Concord CA/NH requires owner regional evidence after the exact durable follow-up;
- unknown/nonunique locality never becomes operational;
- the real PostgREST coverage query includes receipt `detail` required for follow-up proof.

Independent final review on the deployed runtime: `0 Critical / 0 Important / 0 Minor — READY`.

## Final local gates

- Full voice-controller: exit 0; final focused sideband `67/67`, `540` assertions.
- Coordinator `64/64`; settlement `28/28`; simulation `12/12`.
- Coverage `54/54`; materialization `13/13`; store `40/40`; migration contracts `75/75`.
- Dashboard `79/79`; Vite 6,287 modules; Sites `6/6`.
- Landing/runtime `11/11`; security containment `8/8`.
- Hermes configuration `19/19`; backup/restore `33/33`.
- Deploy/rollback contract `21/21`.
- Secret scan: 445 tracked files, clean.
- Full-range `git diff --check`: clean.
- Disposable DB on the final runtime: 58 migrations, 29 SQL assertions, 16 concurrency tests, 28 upgrade tests, 6 application integrations, 1 onboarding integration, 2 budget tests, 1 startup test, 34 authenticated RLS checks, no-op migration replay, unchanged tracked tree and destroyed stack.
- Baseline-only exception: Edge aggregate check still reports the unchanged out-of-range `TS7006` in `supabase/scripts/migrate-connector-tokens.ts:32`; bridge and final `browser-session` files passed direct frozen checks and deployed successfully.

## Immutable packages

### Rollback bridge

- Commit: `5a64eedd47793e39ccc64231670fb5af4801f0fc`
- Tree: `0450b50e83c232d63c6d0b87703c18cac24e0e79`
- Artifact SHA-256: `4f6fb23286c1ed22fc5d2380226d122d19d9f79b1759889a1ea5b66d6524d2ab`
- Size: 169,828 bytes
- Payload files: 131
- Release ID: `5a64eedd47793e39ccc64231670fb5af4801f0fc-4f6fb23286c1ed22fc5d2380226d122d19d9f79b1759889a1ea5b66d6524d2ab`
- Two packages were byte-identical; manifest creation and verification passed.

### Final candidate

- Commit: `38e75ecad698004609a58b7860f396f332dfc980`
- Tree: `b57eec3fc9a9e6686f7f9c28ce2d9cd35f400b6e`
- Artifact SHA-256: `2361170968ad2dbb5a429127a36e8327ce00ca7dd997526ae9edc20ea578b28f`
- Size: 261,284 bytes
- Payload files: 138
- Release ID: `38e75ecad698004609a58b7860f396f332dfc980-2361170968ad2dbb5a429127a36e8327ce00ca7dd997526ae9edc20ea578b28f`
- Two packages were byte-identical; signed manifest creation and verification passed.

## Bridge and rollback

- Bridge review: `0 Critical / 0 Important / 0 Minor — GO`.
- Bridge Edge `browser-session` v5 rejected authenticated onboarding with HTTP 503 before insertion; marker query returned zero rows.
- Bridge EC2 release activated and returned `onboarding_acceptance=disabled_rollback_bridge` with zero live sessions.
- Bridge remained healthy on the new schema after migrations.
- Final deploy used the bridge as its immediate automatic rollback target.
- Bridge release directory remains present on the host after final activation.

## Database

Preflight found exactly these four pending migrations:

1. `20260825203104_onboarding_coverage_receipts.sql`
2. `20260826025305_service_role_receipts_select.sql`
3. `20260826135855_onboarding_transition_safety.sql`
4. `20260826161435_onboarding_v2_reconciliation.sql`

They were applied in that order without `migration repair`. Final linked history is 58/58 and dry-run is empty. Error-level linked lint returned no findings.

Pre-change backup:

- private directory: `/Users/d1f/.config/ligou/test8-prechange-38e75ec.bbJhbX`
- schema SHA-256: `d367fc793e323a392186e5b182e26ec6b4ee0d75c6539e9365e1bdd225aebfca`
- data SHA-256: `cf5b9a68988dafd63a1241c8218f6c90a4ec0c432a9acddfdce973abbfe151e3`
- 31 schema tables and 31 matching COPY blocks/terminators; both files mode 0600.

The six pre-change data digests for tenants, rules, approval cases, powers, bookings and connector accounts were unchanged after migrations. Public base tables moved from 31 to 33 only because the locality registry and alias tables were added.

Final authority checks:

- registry: 14 localities, 4 aliases;
- registry tables: RLS + FORCE RLS;
- service role: SELECT only, zero mutation grants;
- owner-evidence resolver: no direct service-role execute;
- answer RPC: service-role execute preserved.

## EC2 deployment

- Previous live release: `6f65667b428fa0f3f7e3df31534746e120553b10-74798f163c4e25b60537fc85969936a0b03ed9af167c8f9eae474d4ba53cd1b5`.
- Bridge activated at `2026-08-27T05:53:30Z`.
- Final candidate activated at `2026-08-27T05:59:32Z`.
- `/opt/ligou/current` and `/opt/ligou/app` resolve to the final release ID.
- `ligou-controller` is active on the new process/start timestamp.
- Controller health: `ok=true`, `openai=true`, `live_sessions=0`.
- Release health: controller, Supabase and Hermes all `ready`.
- Final deploy receipt: `activated`, with exact commit and release ID.

## Edge and dashboard

- Final `browser-session`: version 6, ACTIVE, import map enabled, `verify_jwt=false` preserved.
- Final composite Edge identity: `28ca1ef41f4386b08221d36cbf8ab31cb11f340ad04304dfd398ad1847974b59`.
- One local site build and one Vercel prebuilt output were produced.
- Vercel prebuilt output SHA-256: `6268d19ef274f30381d46c5db5a79dc6e397031ee64f167004136bf86379a2df`.
- Preview: `dpl_6j3Eqs5T4Nf3X97voEsPAoR7KXWy`, READY.
- Production: `dpl_GLSXGyPHPQx4xhin27icQtHY4Dy9`, READY, promoted from the prebuilt output without a local rebuild.
- Production alias: `https://client-nine-taupe-24.vercel.app`.
- Production root HTML, dashboard HTML, dashboard JS/CSS and landing JS hashes exactly matched the local build.

## Final live state

- Active calls: 0
- Active onboarding calls: 0
- Active budget reservations: 0
- Pending/processing browser requests: 0
- Terminal calls with unresolved active/pending provider termination: 0
- Live voice sessions on EC2: 0

## Deferred backlog

- Historical service removal/tombstones remain deferred until after Test 9. This is safe for the Test-8 tenant because it is `simulation_only`, has zero effective service-price rules and its legacy suggestions are non-operational under the new approval guard.
- The unchanged connector-token `TS7006` baseline remains a separate harness/tooling cleanup.

## Handoff

The system is deployed and idle. Stop here. RJ owns the next action: start one fresh human Portuguese Test 9 call.
