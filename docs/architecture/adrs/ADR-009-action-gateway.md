# ADR-009: Deterministic Action Gateway

- Status: **Proposed**
- Date: 2026-08-17

## Context

Voice models are probabilistic and provider tools may be duplicated, delayed, stale, malformed, or falsely narrated as successful. Calendar actions require exact tenant/resource binding and replay safety.

## Proposed decision

All external mutations cross one deny-first Action Gateway. It validates trusted context, locks the exact proposal version, evaluates current policy/point approval, resolves protected resources server-side, claims idempotency, dispatches durable execution, reconciles unknown outcomes, and commits a normalized receipt.

For Google Calendar, the backend resolves Google’s returned `calendar_id` exclusively from the authenticated tenant-to-calendar mapping. Models never provide, choose, or receive raw calendar IDs.

## Pilot approval behavior

Out-of-policy work creates an `ASYNC_CASE`; the caller is not held waiting for approval. `EscalationPolicy` preserves future `LIVE_TRANSFER`, `CALLBACK`, and `DENY` modes, but only `ASYNC_CASE` is enabled initially.

## Consequences

- Provider tool calling becomes proposal transport, not authority.
- Every success statement can be tied to a receipt.
- Unknown outcomes require reconciliation, which adds state/operational complexity.
- Point approval and reusable policy remain separate commands.

## Promotion criteria

The calendar vertical-slice spike must pass stale approval, double click, queue replay, timeout-before/after-commit, wrong calendar, revoked OAuth, and audit/receipt tests.
