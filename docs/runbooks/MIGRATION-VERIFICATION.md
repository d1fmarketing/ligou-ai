# Migration verification runbook

## Scope and truth boundary

This runbook verifies the Ligou V0.1 RC database history against a disposable local Supabase/Postgres stack. It does not authenticate to, inspect, repair, or mutate a linked Supabase project. A passing local gate is evidence for isolated integration only; it is not staging or production proof.

The committed project is imperative: `supabase/migrations/*.sql` is the ordered source, and `supabase/config.toml` has an empty `schema_paths` list. The local project ID is exactly `ligou-v0-1-rc1`. The gate rejects every other project identity and every non-loopback database URL.

## Pinned prerequisites

- Bun `1.2.13` (`packageManager` remains pinned)
- Node `22.22.3`
- Deno `2.9.4`
- Supabase CLI `2.115.0`, installed as the exact root dev dependency and invoked only as `bunx supabase`
- PostgreSQL client `psql`
- Colima with the dedicated `ligou-rc1` profile; the default profile/context is never used by the gate

The pinned local image reported PostgreSQL `17.6` (`public.ecr.aws/supabase/postgres:17.6.1.159`). No repository `.env` file is needed or loaded by the gate. It rejects inherited `DOCKER_HOST`, starts or validates the dedicated profile with `autoActivate: false` and `portForwarder: none`, verifies its context/socket realpath, and mounts only this RC worktree. A test-owned SSH process provides the only host listeners, exactly `127.0.0.1:54321` and `127.0.0.1:54322`.

## CI-ready commands

Run from the repository root on the verified macOS/Colima host. The single gate command owns the dedicated profile lifecycle:

```sh
bun install --frozen-lockfile
bunx supabase --help
bunx supabase --version
node --test tests/local-db-gate.test.mjs
node scripts/local-db-gate.mjs
git diff --check
git status --short
```

`node scripts/local-db-gate.mjs` starts the local API stack only through the verified dedicated Docker socket and owned loopback forwards. Before every reset, migration operation, or stop, it rechecks status plus the exact DB container name, image, labels, workdir, port, volume, health, SSH PID, and host listeners. It never falls back to `DATABASE_URL`, a linked project, a cached Supabase token, or a repository environment file.

The only destructive database operation in the gate is `bunx supabase db reset --local --no-seed`, against the exact disposable project ID. The upgrade rehearsal also uses explicit `--local` commands in a temporary project workdir that points to the same disposable container.

## What the deterministic gate proves

The verified local run on 2026-08-20 produced:

- `37` repository migrations applied in numeric version order and present exactly once in `supabase_migrations.schema_migrations`;
- the intentional local filename jump from `0007` to `0009` preserved;
- `pgcrypto` and `btree_gist` installed, with `2` `CREATE EXTENSION` statements and no explicit extension version clauses;
- `24` real pgTAP catalog assertions passing before and after the upgrade rehearsal;
- `7` real concurrency/transaction cases passing;
- `11` upgrade-rehearsal checks passing;
- all `6` Task 3/4 booking integration tests passing through local PostgREST;
- `1` real service-role budget deferral test and `1` voice-controller startup/health smoke passing;
- pinned `migration up --local` proving an unchanged history/no-op;
- database lint with `0` errors and `2` legacy warnings;
- advisors with `0` errors, `0` warnings, and `53` informational findings;
- no tracked-worktree mutation during the command.

The pgTAP suite checks real catalog state: RLS plus FORCE RLS on public tables, empty `search_path` on SECURITY DEFINER functions, explicit function/table ACL sets, an invoker-security `effective_rules` view, inaccessible connector tables for `anon` and `authenticated`, removed booking RPC execution denial, valid booking/OAuth/hash constraints and triggers, and the final absence of the plaintext connector column.

The concurrency suite uses independent `psql` sessions and exercises database locks/RPCs for:

1. parallel budget reservation at the tenant cap;
2. overlapping booking slot exclusion;
3. stale versus current worker claim fencing;
4. duplicate accepted delivery plus duplicate reconciliation;
5. OAuth state double-consume;
6. concurrent policy/power epoch invalidation;
7. rollback at the accepted booking-delivery boundary.

The upgrade rehearsal does not substitute a fresh reset. It exposes only the immutable legacy files through `0014`, resets locally, seeds synthetic legacy connector and receipt rows, and then exposes timestamp migrations in stages. Before the final plaintext-drop invariant, it proves:

- a conversion failure leaves the original plaintext row unchanged;
- dry-run reports one eligible row and changes nothing;
- apply encrypts and verifies the row, clears plaintext, and leaves status `reconnect_required` rather than authorizing it;
- a repeated apply is idempotent with zero eligible rows;
- later migrations finish and the legacy accepted receipt is quarantined without deletion.

## Lint and advisor disposition

The two lint warnings are legacy PL/pgSQL hygiene findings, not execution errors:

- `public.decide_case`: unused variable `v_tenant`;
- `public.claim_budget_reconciliation`: unused parameter `p_worker`.

They were not “fixed” by rewriting applied migrations. A later reviewed forward migration may remove the unused variable and give the compatibility parameter an explicit validation/audit use.

The `53` advisor items are informational:

- `32` unindexed foreign keys;
- `11` unused indexes in the fresh local database;
- `10` RLS-enabled internal tables with intentionally no owner policy.

The policyless internal tables are `booking_accepted_receipts`, `booking_quotes`, `booking_receipt_conflicts`, `booking_slot_leases`, `browser_session_requests`, `connector_accounts`, `fake_calendar_events`, `oauth_states`, `phone_events`, and `slot_offers`. They have FORCE RLS and no direct `anon`/`authenticated` grants. Required service operations are granted explicitly. Do not add permissive policies merely to silence an informational advisor.

The performance information is a later workload gate: collect staging query plans and production-like cardinalities before adding foreign-key indexes, and collect representative index statistics before removing any index. A fresh local database cannot supply that evidence.

## Migration `0008` reconciliation

Current observed facts:

- no `supabase/migrations/0008*.sql` path exists in the working tree;
- `git log --all --format= --name-only -- supabase/migrations` contains no `supabase/migrations/0008*` path;
- `git rev-list --objects --all` contains no `supabase/migrations/0008*` object path;
- local fresh and upgrade histories both move from `0007` to `0009` and match the repository exactly;
- linked/staging/production migration history is unknown because authentication and remote access were expressly forbidden for this run.

When separate read-only production authority is granted, run exactly:

```sh
bunx supabase --help
bunx supabase migration list --linked
```

Capture the read-only output and compare it with the committed filenames. Do not run `migration repair`.

| Observed linked state | Meaning | Safe next action |
|---|---|---|
| `0008` absent; later versions match | The linked history preserves the same gap as Git | Record the read-only evidence; do not repair the gap |
| `0008` present; later versions match | Git is missing an applied historical artifact | Stop release progression; recover the exact original SQL and hash from an authoritative archive, then review a provenance-only restoration plan |
| `0008` absent; later versions differ | History/schema drift is present but its cause is unknown | Stop; take read-only history and schema evidence, then design a new forward-only reconciliation migration |
| `0008` present with other missing/reordered versions | Migration history has broader divergence | Stop; perform a separate forensic reconciliation before any write |
| Linked history cannot be read | The external gate remains unresolved | Keep the verdict local-only and request explicit read-only access |

`migration repair` rewrites migration-history state without proving schema equivalence. It must not be used to invent, erase, or mark `0008` in production. Any future repair proposal requires a separate reviewed plan containing the exact linked history, schema diff, original migration artifact or proof of absence, rollback/forward-fix analysis, and explicit production mutation authority.

## Non-claims

This evidence does not prove the current state of production or staging migrations. It also does not prove a deployed Edge Function, Google Calendar behavior, EC2 release/rollback, replacement-volume backup restore, or any provider integration. Those remain separate external gates.
