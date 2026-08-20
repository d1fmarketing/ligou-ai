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

## Review fix round — deterministic proof and scanner hardening

### Original issues and outcome

1. The production proof previously read `dist/client` regardless of the build output selection and only read
   selected files. It now uses the test-owned `dist/security-containment` tree, writes a deliberately stale
   forbidden text marker before build, relies on the build's output cleanup, and recursively scans every
   emitted non-binary text asset. The marker is absent after rebuild; the original stale/wrong-tree issue no
   longer reproduces.
2. `voice-controller`'s default `test` command now delegates to `test:unit`; the old monolithic `bun test`
   discovery is available only as `test:diagnostic`. Booking integration remains the separately named
   `test:integration` command and skips without live configuration.
3. Unit children now run via the current Bun executable from a newly created empty `/tmp` cwd, with absolute
   test paths and a fixed synthetic environment. The runner does not read or copy its invoker environment.
   A real Bun regression probe starts the runner from a directory containing a dotenv sentinel and proves the
   sentinel is absent in the child process.
4. The scanner uses `lstat` and scans only regular tracked files, skipping symlinks before reading any target.
5. Scanner coverage now includes credential-bearing database URLs, YAML/JSON client and service fields,
   common GitHub and Supabase token/JWT shapes, and PEM private-key material. Every tracked `.env.example` is
   validated for blank-only assignments; root, dashboard, and voice examples were added with names only.
   Scanner enforcement is part of `bun run check`.

The normal Supabase `signInWithOtp` magic-link behavior remains in the generated production output. The
removed URL-fragment/password path remains absent from the recursively inspected build.

### RED evidence

```text
$ LIGOU_SITE_OUTPUT_DIR=security-containment node --test tests/security-containment.test.mjs
not ok ... ENOENT: scandir '.../dist/security-containment'

$ node --test tests/secret-scanner.test.mjs
SyntaxError: ... does not provide an export named 'validateEnvExamples'

$ cd voice-controller && bun test test/unit-runner.test.ts
fail: expected fixed synthetic PATH, received inherited PATH
fail: expected absolute Bun child paths, received relative paths
fail: dotenv probe marker was absent because --file was not supported

$ node --test tests/secret-scanner.test.mjs
fail: no finding was emitted for config.json structured secrets
```

### GREEN evidence

```text
$ node --test tests/secret-scanner.test.mjs
# pass 5 / fail 0

$ cd voice-controller && bun test test/unit-runner.test.ts
# pass 3 / fail 0
# dotenv sentinel stays out

$ bun run test:security
Site build ready: .../dist/security-containment
# tests 6 / pass 6 / fail 0
stale-output marker removed

$ bun run secrets:scan
Secret scan clean: 271 tracked files scanned.
```

### Fix-round self-review and remaining limitation

The output proof is now tied to the exact build invocation and exercises cleanup with a stale forbidden asset.
The dotenv probe is behavioral: it invokes Bun from a cwd containing a local dotenv candidate and asserts the
actual child process cannot see its sentinel. Scanner findings remain masked. The scanner intentionally still
does not perform full entropy analysis or rewrite Git history; it scans current tracked regular files only.

### Final verification after staging

```text
$ bun run secrets:scan
Secret scan clean: 271 tracked files scanned.

$ bun run test:security
Site build ready: .../dist/security-containment
# tests 6 / pass 6 / fail 0 / skipped 0

$ cd dashboard && npm test
# dashboard tests 11 / pass 11
# Sites tests 5 / pass 5

$ cd voice-controller && npm test
# isolated unit tests 63 / pass 63 / fail 0

$ cd voice-controller && npm run test:unit
# isolated unit tests 63 / pass 63 / fail 0

$ cd voice-controller && npm run test:integration
# pass 0 / skip 6 / fail 0

$ bun run check
# landing tests 10 / pass 10; secret scan clean; runtime checkpoint passed

$ bun run site:build
Site build ready: .../dist/client

$ bash -n infra/deploy.sh infra/backup.sh infra/restore.sh
$ git diff --cached --check
# both exited 0
```
