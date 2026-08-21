# Ligou V0.1 — local verification status

This branch is implemented and locally contract-tested. It is **not deployed, not live-verified, and not
production-ready**. Historical live experiments are not release evidence for this tree.

## Verified locally

- Landing and dashboard unit/build contracts run with synthetic configuration.
- Voice-controller unit files run in isolated Bun processes with synthetic credentials.
- Hermes accepts only server-built structured context and one closed action code. Tenant routing comes from
  server-owned state plus the locked registry; the post-call free-form learning channel is disabled.
- Calendar runtime reads only encrypted tenant connector rows. There is no plaintext process-environment
  refresh-token or managed-calendar fallback.
- OAuth, connector conversion, booking authority, receipts, budgets, privacy, HMAC cutover, backup, restore,
  release, rollback, and concurrency are covered by local contract/behavior tests.
- All 44 repository migrations apply exactly once to a real disposable PostgreSQL 17.6 database in the
  dedicated `ligou-rc1` Colima profile. The gate also rehearses the 13-file legacy sequence through `0014`
  before applying timestamp migrations and the guarded connector conversion.
- Real pgTAP catalog assertions, nine concurrency/retention tests, nine authenticated two-tenant RLS/BOLA assertions, and all six Task 3/4 booking integration tests
  through the local REST API, the voice-controller budget-deferral integration, controller startup/health,
  and a migration no-op replay pass locally.
- The dedicated profile disables Colima's automatic port forwarder. A gate-owned SSH process binds only
  `127.0.0.1:54321` and `127.0.0.1:54322`; the exact local stack, forwards, and profile are stopped after proof.
- Edge Functions type-check with pinned Deno/import-map/lock data and no production environment.
- Secret scan checks current tracked regular files and emits masked findings only.

## Not verified

- No linked, staging, or production migration history was read; production state around missing local
  migration `0008` remains an external reconciliation gate.
- The connector converter was exercised only with synthetic rows and a synthetic key in disposable local Postgres.
- No Google Calendar, OpenAI, Twilio, AWS, EC2, SSM, Vercel, or production Supabase action was performed.
- Docker restore, Linux `flock`, systemd restart, and replacement-storage rollback remain external gates.
- The approved Hermes digest was not pulled or executed.

## Supported local commands

```text
bun run check
bun run test:security
bun run test:hermes-config
bun run test:backup-restore
bun run test:deploy-release
bun run test:edge-functions
node scripts/local-db-gate.mjs
cd dashboard && npm test && npm run build
cd voice-controller && bun scripts/run-unit-tests.mjs
```

The database gate manages only its dedicated `ligou-rc1` Colima profile and leaves the default profile/context
untouched. Passing these commands proves local implementation and isolated integration only. It does not prove
deployment, linked Supabase history, or live provider behavior.
