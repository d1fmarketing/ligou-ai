# Task 2 — credential containment and deterministic baseline

## Result

The production-capable dashboard bypass was removed. The vulnerable path accepted a password from a `#k=`
fragment, persisted it in session storage, and called password sign-in when a build variable supplied an
e-mail. The landing forwarded the same fragment to the dashboard. The invariant is now: only the normal
Supabase magic-link flow may authenticate; no URL fragment, browser storage, or build variable can provide a
password or cause password sign-in. The generated production site proves the retired markers are absent and
the magic-link method remains present.

## Narrow patch strategy

1. Delete the fragment/password branch and landing redirect; leave the existing `signInWithOtp` submit flow
   unchanged.
2. Add a build-output regression test, rather than source-only greps, covering landing plus emitted dashboard
   bundles.
3. Add a dependency-free Node scanner for tracked Git files. It detects dotenv-style named secret assignments
   and several provider credential shapes. Findings contain only category, repository path, line, and a short
   SHA-256 fingerprint; values are never printed.
4. Run each voice unit file in a separate Bun process with a synthetic-only environment. Keep the booking
   integration command separate so it remains skipped without deliberate live configuration.
5. Remove embedded operational identifiers from the deploy/backup/restore/build defaults and current runbooks;
   make them explicit environment configuration instead.

## TDD record

### RED

- `bun run site:build && node --test tests/security-containment.test.mjs`
  failed as expected: the generated `dist/client/index.html` still contained `#k=`.
- `node --test tests/secret-scanner.test.mjs`
  failed as expected because the scanner module did not yet exist.
- `bun test test/unit-runner.test.ts` in `voice-controller`
  failed as expected because the isolated runner module/export did not yet exist.
- The first synthetic runner execution exposed one missing synthetic configuration input:
  `missing env SUPABASE_PUBLISHABLE_KEY`. A runner regression assertion was added first; it failed until the
  synthetic value was included.
- The first full site build after landing removal correctly exposed the pinned runtime-manifest mismatch for
  `index.html`; the manifest was updated to the newly verified file hash.

### GREEN

- `bun run test:security`: 3/3 passed after building the landing and dashboard.
- `cd voice-controller && npm run test:unit`: 63/63 passed in six isolated processes.
- `cd voice-controller && npm run test:integration`: 0 passed, 6 skipped, 0 failed without live credentials.
- `bun run secrets:scan`: clean; 266 tracked files scanned, no finding values emitted.

## Files changed

- Authentication/production proof: `dashboard/src/auth/Login.jsx`, `index.html`,
  `tests/security-containment.test.mjs`, `docs/CLAUDE-V9-RUNTIME.sha256`.
- Deterministic voice baseline: `voice-controller/package.json`,
  `voice-controller/scripts/run-unit-tests.mjs`, `voice-controller/test/unit-runner.test.ts`.
- Secret containment: `scripts/scan-secrets.mjs`, `tests/secret-scanner.test.mjs`, `package.json`,
  `hermes-cell/.env.example`, `docs/SECURITY-CONTAINMENT.md`.
- Sanitized runbooks/configuration: `infra/deploy.sh`, `infra/backup.sh`, `infra/restore.sh`,
  `scripts/build-site.mjs`, `docs/DEPLOY-DASHBOARD.md`, `docs/HANDOFF-2026-08-20.md`,
  `docs/RUNBOOK-CREDENCIAIS.md`, `docs/PILOT-HARDENING-STATUS.md`.

## Verification

- `npm test` in `dashboard`: 11 dashboard tests + 5 Sites tests passed; production build passed.
- `bun run test:security`: root check passed (10 landing assertions), runtime checkpoint passed,
  dashboard production build passed, and the three containment/scanner tests passed.
- `cd voice-controller && npm run test:unit`: 63 passed, 0 failed; each selected file ran as its own Bun
  process with synthetic configuration only.
- `cd voice-controller && npm run test:integration`: 6 skipped, 0 failed with no live credentials.
- `bun run secrets:scan` after staging: clean, 266 tracked files scanned.
- `bash -n infra/deploy.sh infra/backup.sh infra/restore.sh` and `git diff --cached --check`: passed.

No deploy, migration, push, live-service action, or reference deletion was performed.

## Self-review and concerns

The patch is contained to credential paths, local test isolation, scanner/configuration, and related docs. The
normal Supabase magic-link path remains in the shipping bundle; the password path, fragment handling, and
storage key do not. The scanner is deliberately lightweight, so it is not an entropy scanner or Git-history
rewriter; it only scans current tracked repository content and relies on its narrow patterns. A credential
incident still requires the operator rotation checklist and provider-side verification. The known monolithic
voice-test registry/environment collision is documented as diagnostic-only rather than treated as a release
gate.
