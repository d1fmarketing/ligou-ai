# ADR-010: Durable Workflows

- Status: **Experimental**
- Date: 2026-08-17

## Context

Calendar actions and approval continuations must survive process failure and support retries, timeouts, cancellation, reconciliation, and audit. Adopting multiple orchestrators would create unnecessary complexity.

## Experiment decision

Compare DBOS Transact TS and AWS Step Functions Standard on one scheduling workflow. Promote the smallest candidate that passes semantic and operational gates. Consider Hatchet only if both lack needed worker/operator behavior; consider Temporal when product complexity demonstrably warrants its operating model.

## Required semantics

- durable enqueue and state;
- exactly-once business effect through idempotency/reconciliation;
- waiting/timer/cancellation/freshness support;
- visible attempt/history and tenant/trace correlation;
- deploy/version compatibility;
- local and CI testability;
- bounded payload/PII exposure;
- export/migration path.

## Consequences

- No engine is selected in the architecture package.
- Workflow code/state stays behind an engine-neutral domain record.
- External action idempotency remains mandatory even if an engine advertises exactly-once workflow execution.

## Rejected alternatives

- In-memory promises/background timers.
- Redis-only queue without durable domain record.
- Simultaneously operating DBOS, Step Functions, Hatchet, and Temporal.
