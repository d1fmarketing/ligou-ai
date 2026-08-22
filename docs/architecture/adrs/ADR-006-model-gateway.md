# ADR-006: Model and Voice Gateway

- Status: **Proposed**
- Date: 2026-08-17

## Context

Provider-specific SDK events can fossilize transport semantics in domain state and make provider migration, audit, retention, and testing unsafe.

## Proposed decision

Define Ligou-owned `ModelGateway` and `VoiceAdapter` contracts with normalized inputs, events, tool requests, usage, latency, errors, finish reasons, and session controls.

Provider-specific types, objects, enums, and events cannot cross adapters or enter canonical AgentCore state. Raw provider payloads, when strictly necessary, live only in adapter-scoped telemetry with independent access and retention.

Normalized audit metadata may include provider, model, pinned version, request ID, latency, usage, and finish reason.

## Consequences

- Domain tests use provider-neutral fixtures.
- Migration requires adapter/eval work, not canonical data migration.
- Some provider-specific capabilities may require optional bounded capabilities rather than lowest-common-denominator leakage.
- Adapter maintenance is explicit operational work.

## Promotion criteria

Two implementations/test doubles must pass the same serialization, tool, error, stale-result, usage, and transcript contract suite.

## Rejected alternatives

- Persisting provider session/event objects.
- Exposing raw provider tool calls directly to business adapters.
- Treating an MCP server as the authorization boundary.
