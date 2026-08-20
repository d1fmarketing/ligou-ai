# Pilot hardening status

## Run 0 baseline (sanitized)

Recorded before this containment change:

- landing: 9/9;
- dashboard: 16/16;
- voice unit files: 61/61 only when each file ran in its own process;
- live booking integration: six tests skipped when live credentials are absent.

The former monolithic `bun test` was not a trustworthy gate: shared module registry/test seams and eager
environment configuration caused cross-suite failure. It is retained only as a diagnostic signal, not a
release command.

## Deterministic local commands

- `bun run secrets:scan` scans tracked repository files and prints only category, path, line, and a masked
  fingerprint on a finding.
- `cd voice-controller && npm run test:unit` runs every unit file in a fresh Bun process with synthetic
  configuration. It never inherits credential variables from the caller.
- `cd voice-controller && npm run test:integration` is deliberately separate. It skips without explicit
  live integration variables; it is not part of the secret-free unit gate.
- `bun run test:security` builds the landing and dashboard, then proves the shipped output contains none of
  the removed auto-login path markers.

## Authentication invariant

The dashboard accepts normal Supabase magic-link sign-in only. A URL fragment, browser storage, or a
build-time variable must never supply a password or cause a password sign-in.
