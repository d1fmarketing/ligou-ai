# ADR-012: Observability and Audit

- Status: **Proposed**
- Date: 2026-08-17

## Context

Voice sessions span carrier, model, tools, workflows, database, dashboard, and calendar. Debugging needs provider evidence, while privacy requires minimizing and separating raw payloads. Business authorization needs a stronger record than operational logs.

## Proposed decision

Use OpenTelemetry-compatible trace/metric/log instrumentation exported into AWS operations tooling. Maintain a separate canonical append-only audit/receipt ledger for security and business actions.

Persist only normalized provider/model/version/request ID/latency/usage/finish metadata in canonical state. Keep strictly necessary raw provider telemetry in an adapter-scoped store with separate access, redaction, and retention.

## Required correlations

`tenant_id`, `trace_id`, `conversation_id`, `case_id`, `proposal_id`, `action_intent_id`, `workflow_run_id`, and normalized provider request IDs, subject to access classification.

## Consequences

- Operational telemetry can expire without erasing required action proof.
- Tenant/support views must enforce authorization and redact other tenants.
- High-value audit events can be hash-chained or immutably exported.
- Telemetry volume and PII require explicit budgets and sampling rules.

## Promotion criteria

Pass trace-continuity, redaction, retention/deletion, privileged-access, audit-tamper, and cost tests on the vertical slice.

## Rejected alternatives

- Raw provider logs as the canonical audit.
- “No logs” as a privacy strategy.
- A single unrestricted observability index shared across all roles.
