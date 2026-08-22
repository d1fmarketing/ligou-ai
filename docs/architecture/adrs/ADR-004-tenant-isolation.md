# ADR-004: Tenant Isolation Topology

- Status: **Proposed**
- Date: 2026-08-17

## Context

The pilot needs strong isolation without paying for a permanently dedicated stack per tenant. Logical isolation can be secure only when enforced independently of model prompts and ordinary query filters.

## Proposed decision

Use shared stateless AWS compute for the private pilot and a shared RDS PostgreSQL cluster/schema with mandatory `tenant_id`, `FORCE ROW LEVEL SECURITY`, tenant-scoped constraints, and non-owner runtime roles.

Keep a topology abstraction that permits later dedicated database, service, account, or region tiers without changing AgentSpace contracts.

## Isolation controls

- trusted Tenant Resolver at every ingress;
- transaction-local database tenant context;
- no runtime `BYPASSRLS`, superuser, or table owner;
- tenant-scoped object prefixes/keys and KMS policy as appropriate;
- per-tenant quotas, concurrency, and cost controls;
- explicit system-job roles rather than universal bypass;
- adversarial tests in CI and before deployment.

## Consequences

- Efficient pilot economics and simpler operations.
- A database/control-plane failure has multi-tenant blast radius; backup, access, and monitoring must reflect that.
- Physical topology remains available for higher-risk customers.

## Promotion criteria

Pass cross-tenant read/write/reference tests, connection-pool context tests, privileged-role review, backup/restore/export/deletion drill, and per-tenant overload test.

## Alternatives

- Database/schema/account per tenant on day one: stronger physical boundary, disproportionate pilot cost/operations.
- Application filters only: rejected.
- Shared global vector/memory store without RLS: rejected.
