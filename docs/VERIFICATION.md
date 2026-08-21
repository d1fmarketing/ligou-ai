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
- Edge Functions type-check with pinned Deno/import-map/lock data and no production environment.
- Secret scan checks current tracked regular files and emits masked findings only.

## Not verified

- Migrations were not applied to a real isolated PostgreSQL/Supabase database.
- The connector converter was not run against a database.
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
cd dashboard && npm test && npm run build
cd voice-controller && bun scripts/run-unit-tests.mjs
```

Passing these commands proves local implementation contracts only. It does not prove deployment or live
provider behavior.
