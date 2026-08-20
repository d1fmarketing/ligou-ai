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

## Run 3 superseding Hermes invariant

The Run 2 notes below describe historical defenses around a now-retired interface; they do not authorize its
return. Live Hermes is no longer given a model-authored question, freeform context, transcript excerpt, caller
instruction, contact/address field, or private pricing state, and no natural-language Hermes response returns
to Realtime. The only live contract is `consult_ligou_brain(topic enum, service_id)`: the server rebuilds a
small trusted context, Hermes returns one exact JSON action code, and the server maps that code to fixed
guidance. Invalid JSON, prose, extra fields, unknown actions, digits, and monetary output are unavailable.
Reasoning uses `openai-codex` OAuth in its own model-auth volume; cognitive backup excludes that volume.

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

## Run 2 Task 4 — authoritative offers, calendar receipts, and customer truth

Implemented locally on `codex/ligou-v0.1`; no migration was applied, no provider was called, and no deployment
was performed.

- Public quotes and appointment slots now carry cryptographically random opaque IDs. The database stores only
  SHA-256 token hashes and binds each offer to tenant, call, service, exact normalized interval, local display,
  public quote, geography, expiry, consumption state, referenced rule/power, and policy epoch. Proposal is one
  service-role transaction; model-authored times, geography, service, and prices are ignored.
- `evaluate_offer` is the only negotiation path. It evaluates the offered public price against private current
  policy and returns only `accept`, `counter`, or `needs_owner` with a new server-bound public quote. A missing
  private policy fails closed; close still rechecks the private policy and the Task 3 grant/rule/epoch snapshot.
- Final write preparation invokes Task 3's authority validator and acquires a tenant/time-range exclusion. The
  worker then rechecks free/busy immediately before the provider boundary. A newly busy or unreadable interval
  causes zero writes; deterministic concurrent-worker tests permit at most one write.
- `CalendarPort` now separates `write`, read-only `reconcile`, and `busy`. Unknown intents claim in reconciliation
  mode, provider lookup failure never reaches POST, and definitive absence remains unknown/manual-review rather
  than authorizing another write.
- Google and fake adapters use one canonical expected payload and exact validator covering account/calendar
  mapping, summary, commitment description, start, end, confirmed status, private idempotency/tenant/booking
  keys, and expected payload hash. New and reused events use the same proof rule; receipts are unique per intent.
- Customer outcome language is channel-neutral and centralized. Active Realtime prompts, tool snapshots/results,
  booking responses, Hermes live-call context, and the executable landing demo contain no absent SMS promise or
  private pricing floor. The byte-pinned historical Claude export remains unchanged.

Local verification: 164 isolated voice unit tests passed; both controller entry points bundled; root `bun run
check` passed with 11 frontend tests, secret scan, and the 52-file runtime manifest; dashboard tests/build passed
(16 tests). Six credentialed booking integration tests were parsed and intentionally skipped in a clean
environment. Real PostgreSQL exclusion/transaction execution and live Google behavior remain unproved because
this workspace has no local PostgreSQL/Docker gate and live credentials/provider calls were prohibited.

## Run 2 Task 4 corrective review round

Two Critical and five Important review findings were corrected with two additional forward migrations; the
three original Task 4 migrations remain byte-unchanged.

- Delivery attempts are append-safe and carry unique attempt keys. One separate accepted-receipt authority map
  controls confirmation. `record_booking_delivery` atomically verifies exact expected/readback proof, inserts or
  reuses the canonical accepted receipt, commits the slot lease, succeeds the intent, confirms the booking, and
  emits the notification. Any database error leaves the booking unconfirmed.
- Worker claims now carry unique claim tokens/versions. A fenced `begin_provider_write` transition can happen
  once and irreversibly switches the intent to reconciliation-only before `CalendarPort.write`. Reclaimed
  running intents never write again, even when the prior worker lease expired.
- Provider input is reconstructed from locked booking state. A trigger and the fenced begin transition reject
  corrupt intent payloads; the internal exclusion must match the same booking interval.
- `close_deal` is call-scoped and reports confirmed only through `get_booking_confirmation`, which joins the
  booking, canonical accepted mapping, and exact accepted receipt.
- Connector lookup error is distinct from confirmed absence. Managed-calendar fallback requires explicit
  `GOOGLE_MANAGED_CALENDAR_FALLBACK=enabled`. Duplicate `ligouKey` matches are manual conflicts for write and
  reconciliation.
- Historical only: Run 2 sanitized a freeform Hermes question/context. Run 3 removed that interface entirely;
  do not restore it from this note.
- Existing pre-authority accepted receipt history is preserved and quarantined. It cannot become confirmation
  authority automatically; explicit manual policy is required.

Corrective local verification: 192 isolated voice tests, 33 migration contracts, both controller bundles, root
11-test/check/secret/runtime-manifest gate, and dashboard 16-test/build gate passed. Six credentialed integration
tests still skip in a clean environment. The Docker CLI exists, but its daemon/local PostgreSQL is unavailable;
real transaction/exclusion execution and live Google remain blocked and unclaimed.

## Run 2 Task 4 corrective review round 2

Migration ruling: migrations `0014` and earlier are treated as applied/immutable. Task 4 migrations were verified
unapplied everywhere; therefore `20260820175153_booking_delivery_authority.sql` was corrected in place so its own
transaction boundary is safe. The redundant, also-unapplied `20260820180408_booking_receipt_preflight.sql` was
removed from the final migration sequence.

- `begin_provider_write` now requires a `held` lease and compares tenant/start/end with `IS DISTINCT FROM`, using
  canonical `coalesce(slot_end, slot_start)`.
- All pre-write defer/fail/release operations use `transition_claimed_intent(intent, claim_token, ...)`. A stale
  worker cannot release the slot or overwrite a newer claim. Direct service-role execution of the old unfenced
  prepare/release/validator paths is revoked.
- Connector state is queried even without OAuth client environment variables. Lookup error, inactive row,
  missing token, or incomplete OAuth configuration is unknown and never falls back. Only confirmed row absence,
  explicit fallback enablement, and complete global configuration may use the managed calendar. Malformed event
  list/pagination bodies are unknown with zero POST.
- Historical only: Run 2 filtered digits from freeform question/context. Run 3 removed question/context/advice
  inputs and outputs entirely in favor of the closed action-code contract above.
- The final receipt-authority migration quarantines every legacy accepted booking receipt before confirmation
  authority is defined, never auto-maps legacy proof, preserves all audit rows, removes booking-ID uniqueness from
  the accepted mapping, and checks quarantine in the first confirmation function. No quarantine-resolution
  mechanism exists yet; resolution requires a future explicit forward policy.

Round-2 local verification: 205 isolated voice tests, 34 migration contracts, both controller bundles, root
11-test/check/secret/runtime-manifest gate, and dashboard 16-test/build gate passed. Six credentialed integration
tests remain intentionally skipped. Real PostgreSQL apply/concurrency and live Google verification remain blocked.

## Run 2 Task 4 corrective review round 3

- `transition_claimed_intent` now rejects stored or input NULL claim tokens before mutation. The claim-token-
  fenced status transition must affect exactly one row before a held slot lease is deleted; a stale/NULL worker
  cannot change status or release the lease.
- Calendar connector authority is no longer cached. Every Google write, reconciliation, and free/busy operation
  performs a current connector-table lookup, so revocation, inactivation, row change, or database failure takes
  effect on the next operation. Fake calendar requires explicit `CALENDAR_PROVIDER=fake`; production defaults to
  current Google connector resolution. A present empty pagination token is malformed/unknown.
- Historical only: Run 2 classified freeform pricing/negotiation wording. Run 3 no longer permits any freeform
  question, context, or model advice; only strict action codes can cross the boundary.

Round-3 local verification: 233 isolated voice tests, 34 migration contracts, both controller bundles, root
11-test/check/secret/runtime-manifest gate, and dashboard 16-test/build gate passed. Six credentialed integration
tests remain intentionally skipped. Real PostgreSQL and Google gates remain blocked and unclaimed.
