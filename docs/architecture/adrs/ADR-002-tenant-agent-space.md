# ADR-002: Persistent Tenant AgentSpace

- Status: **Accepted**
- Date: 2026-08-17

## Context

Each company needs “its Ligou”: isolated memory, rules, cases, integrations, and history. That persistence must not force an always-on operating-system process or server per company.

## Decision

Each tenant owns exactly one persistent, isolated `AgentSpace` in the initial product. AgentSpace is a logical/domain boundary independent of process and voice-session lifetime.

## Consequences

- Shared stateless compute can serve many tenants while data remains isolated.
- Per-call VoiceEdge sessions may be ephemeral and autoscaled.
- Tenant suspension pauses capabilities without destroying identity/history.
- Physical isolation can be offered later without changing the domain contract.
- Every canonical record and derived artifact must be tenant-bound.

## Rejected alternatives

- One always-on server/process solely to represent each company.
- A shared undifferentiated agent memory with prompt-level tenant labels.
- New agent identity for every call.

## Acceptance constraints

Although the product invariant is accepted, implementation cannot ship until real-database isolation, export/deletion, and cross-tenant adversarial tests pass.
