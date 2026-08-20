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

- `bun run secrets:scan` scans tracked regular repository files and prints only category, path, line, and a
  masked fingerprint on a finding. It skips symlinks and validates every tracked `.env.example` has blank
  values only; `bun run check` enforces this scanner automatically.
- `cd voice-controller && npm test` delegates to `test:unit`, which runs every unit file in a fresh Bun
  process from an empty temporary cwd with synthetic configuration only. It does not inherit caller
  credentials or a caller dotenv file. `test:diagnostic` retains the old monolithic discovery explicitly.
- `cd voice-controller && npm run test:integration` is deliberately separate. It skips without explicit
  live integration variables; it is not part of the secret-free unit gate.
- `bun run test:security` rebuilds the test-owned `dist/security-containment` output, recursively inspects
  every emitted text asset, and proves it contains none of the removed auto-login path markers.

## Authentication invariant

The dashboard accepts normal Supabase magic-link sign-in only. A URL fragment, browser storage, or a
build-time variable must never supply a password or cause a password sign-in.

## Run 1 Task 3 — ownership, effective authority, and budget settlement

Implemented locally on `codex/ligou-v0.1`; no migration was applied and no deployment was performed.

- Session bootstrap no longer assigns the first authenticated user as tenant owner. Browser `/claim`, browser
  `/session`, the public `browser-session` Edge Function, and inbound phone startup all fail before call/budget
  creation when the tenant has not been explicitly provisioned. The only owner write is the row-locked,
  service-role-only `provision_tenant_owner` RPC.
- `effective_rules` exposes only the deterministic latest version per `(tenant_id, rule_group_id)` when that
  latest row is `aprovado`. Tenant `policy_epoch` and `auth_epoch` are re-read on every tool boundary; cached
  rules survive only while both epochs match.
- `PowerConditions` is one exported fail-closed contract. Appointment instant, normalized city/geography,
  channel, purpose, prior consent, monetary limit, expiry, and every matching grant are evaluated. Booking
  proposals persist the authority context and commitment rechecks it.
- `budget_reservations` separates active holds from settled actual cost. Reservation and settlement RPCs are
  service-role-only, use the tenant-local day, serialize on the tenant row, backfill legacy holds, and append one
  reservation release plus one usage event idempotently. Browser and phone startup errors and all sideband
  terminal outcomes settle through the same RPC. Runtime estimates come from `EST_COST_PER_SESSION`.

Local verification: 97 isolated voice unit tests passed, the controller entry points bundled successfully, and
`deno check --node-modules-dir=none supabase/functions/browser-session/index.ts` passed. SQL migration contract
tests and a deterministic concurrency fixture passed, but true PostgreSQL execution/locking remains blocked:
this workspace has no Docker server, `psql`, `initdb`, or safe live Supabase credential. That is a Task 6 gate,
not live proof.

## Run 1 Task 3 corrective review round

The Important/Minor review findings were corrected locally with forward migrations only; the three earlier Task
3 migrations remain unchanged.

- Booking enqueue is now an atomic service-role RPC that locks the tenant and verifies expected auth/policy
  epochs plus the exact current power and effective rule. Claim rejects stale queued authority, and the worker
  revalidates the same references immediately before `calendar.book()`.
- Communication conditions are evaluated per grant in one loop, including body limit, frequency lookup, prior
  consent, quiet-hours window, geography, channel, and purpose. Unknown nested keys and lookup failures deny;
  one restrictive grant cannot mask another valid grant.
- Provider termination has durable call state. Accepted/potential calls require a positively confirmed OpenAI
  `/hangup` or `/reject` before zero-cost settlement. Transport-unknown termination keeps the reservation active.
- Terminal call fields are persisted before settlement. A leased worker reconciliation path discovers active
  reservations on terminal calls, retries provider termination when needed, and retries idempotent settlement.
- Reattach exhaustion and terminal OpenAI errors map to `error`; a corrective migration fixes legacy error/killed
  outcomes. The replacement reservation function samples `clock_timestamp()` after acquiring the tenant lock.
- Shared tenant ownership logic moved under `supabase/functions/_shared`, so Edge deployment does not depend on a
  repository-root import.

Corrective local verification: 117 isolated voice unit tests, 14 migration contracts, controller bundle, Edge
Function Deno check, root security test, and root `bun run check` passed. Real PostgreSQL execution and live
concurrency remain blocked to Task 6 and are not claimed.
