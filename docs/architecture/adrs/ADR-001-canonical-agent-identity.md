# ADR-001: Canonical Agent Identity

- Status: **Accepted**
- Date: 2026-08-17

## Context

Ligou must feel like one enduring operational agent even as voice models, carriers, prompts, compute processes, and adapters change. Equating identity with a model session or framework instance would fragment memory, audit, and customer trust.

## Decision

Ligou has one canonical product identity. Provider/model/runtime sessions are temporary execution components and never become separate authoritative agents.

The identity is represented by Ligou-owned tenant/AgentSpace state, versioned policy/memory, cases, tasks, receipts, and audit.

## Consequences

- Provider migration does not require identity migration.
- Model/provider identifiers remain normalized execution metadata.
- A session can be recreated from canonical state after failure.
- Copy, voice, and behavior may evolve, but policy/memory provenance remains continuous.
- Framework-native “agent state” may be cached or adapted but cannot be canonical.

## Rejected alternatives

- One identity per provider/model.
- Treat a running OpenClaw/Hermes/SDK agent instance as the product identity.
- Store continuity only in provider conversation/session history.

## Evidence

Approved product invariant E-001 and provider-lifecycle evidence in [`../EVIDENCE_REGISTER.md`](../EVIDENCE_REGISTER.md).
