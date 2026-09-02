# ADR-007: Canonical Data and Isolation

- Status: **Proposed**
- Date: 2026-08-17

## Context

Cases, approvals, policies, memory, tasks, receipts, and audit need relational transactions, tenant isolation, versioning, export, and recovery. Audio/transcripts and raw telemetry have different access/retention needs.

## Proposed decision

Use RDS PostgreSQL as the canonical store, with RLS/default-deny and non-owner runtime roles. Use S3 only for bounded encrypted artifacts such as retained transcripts or adapter telemetry. Use pgvector as a derived tenant-bound index, not a source of truth.

## Consequences

- Relational invariants and action/approval transactions remain central.
- Object data has separate retention/access controls.
- Embeddings are disposable and rebuilt from active canonical memory.
- AWS region/topology and RDS sizing remain spike outcomes.

## Promotion criteria

- real-database RLS and pool-context attacks fail closed;
- point-in-time restore and tenant export/deletion are demonstrated;
- backup and object lifecycle meet approved retention;
- application/migration credentials are separated;
- cost and availability meet the pilot envelope.

## Rejected alternatives

- Supabase as a runtime dependency for the first architecture.
- Redis/localStorage/vector storage as canonical memory or approval state.
- One shared unpartitioned transcript/log bucket without tenant policy.
