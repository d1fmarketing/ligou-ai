# Gated Implementation Plan

Status: **future plan only**. Execution requires a separate explicit authorization after architecture review. This document does not authorize production code, dependencies, AWS resources, credentials, carrier numbers, customer data, deployment, push, or pull request.

## Phase 0 — Architecture review

Deliverables:

- review this package and resolve contradictions;
- approve/modify Accepted invariants;
- assign owners to blocking questions and spikes;
- approve synthetic-data policy, evaluation thresholds, and experiment budget;
- confirm no production implementation has started.

Exit gate: signed architecture-review decision and bounded spike authorization.

## Phase 1 — Disposable evidence harnesses

Potential work, only after authorization:

- repository/module skeleton for contracts and tests;
- synthetic tenant/call/calendar fixtures;
- real PostgreSQL RLS adversarial harness;
- fake provider adapters and forbidden-type serialization tests;
- voice evaluation runner and deterministic action oracles;
- disposable sandbox calendar/carrier/provider experiments.

Exit gate: S1–S6 reports update ADR statuses. Experimental choices cannot enter a vertical slice without passing their applicable hard gates.

## Phase 2 — Smallest development vertical slice

Potential modules:

```text
packages/contracts           normalized domain/adapter schemas
services/agent-core          tenant, case, policy, approval, memory authority
services/dashboard-api       authenticated owner commands
services/voice-edge          ephemeral inbound session adapter
services/action-worker       durable Action Gateway execution
adapters/openai-realtime     first voice candidate
adapters/telephony-*         selected carrier adapter
adapters/google-calendar     protected server-side calendar mapping
infra/                       reviewed IaC only after explicit AWS authorization
tests/evals                  isolation, contracts, voice, failure, load
```

This layout is illustrative, not permission to create it now.

Required first-slice behavior:

1. onboard one synthetic/pilot tenant and intended calendar owner;
2. bind one inbound phone number server-side;
3. answer one English customer call;
4. create an out-of-policy proposal and `ASYNC_CASE`;
5. notify owner with a dashboard deep link;
6. authenticate owner and approve that exact proposal once;
7. execute one idempotent durable Google Calendar action;
8. commit normalized receipt, case resolution, memory version, and audit;
9. show Portuguese owner status in dashboard;
10. prove restart/retry/correction/cross-tenant failure behavior.

Exit gate: S7 passes with synthetic data and production-equivalent security roles.

## Phase 3 — Hardening and operational readiness

Potential work:

- threat-model test closure;
- secrets/IAM/network/egress/container hardening;
- retention/export/deletion/restore workflows;
- OTel/CloudWatch SLOs, cost, audit, and security alerts;
- tenant and global quotas/kill switches;
- incident, provider outage, OAuth revocation, and unknown-action runbooks;
- accessibility/security review of approval dashboard;
- measured cost/capacity model.

Exit gate: S8 dossier, no Critical/High unresolved launch blockers, residual-risk acceptance, and separately approved pilot runbook.

## Phase 4 — Private pilot authorization

This is a governance decision, not an automatic engineering milestone. Before a real tenant:

- identity/authorization and legal retention are approved;
- standard user OAuth owner path is proven;
- voice/carrier/workflow candidates are promoted through ADRs;
- all pre-production threat-model blockers pass;
- support/incident/capacity/economic owners accept the pilot;
- customer scope, disclosure, consent, and rollback are documented;
- AWS/IaC change set receives separate explicit approval.

If DWD becomes necessary, its spike must pass before tenant one. If any hard gate fails, the result is NO-GO or redesign—not an undocumented exception.

## Phase 5 — Second tenant and scale

Only after pilot evidence:

- repeat cross-tenant/offboarding/overload tests;
- decide whether logical isolation is adequate for the next risk tier;
- derive capacity from actual busy-hour distributions;
- test provider/carrier portability and restore;
- automate onboarding without widening authority;
- consider physical isolation tiers and additional connectors.

Outbound customer calling, campaigns, DWD, audio recording, additional connector domains, and live approval modes remain separate product/security decisions.

## Change control

Every implementation change must identify:

- governing ADR and evidence;
- tenant/security/data impact;
- tests and rollback;
- provider/model/library pin;
- migration/export implications;
- whether it changes a decision status.

No prototype branch, local demo, successful API call, or deployed static page is production proof.

ARCHITECTURE READY FOR REVIEW - NO PRODUCTION IMPLEMENTATION HAS STARTED
