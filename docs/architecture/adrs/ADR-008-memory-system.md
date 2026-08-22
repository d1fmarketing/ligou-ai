# ADR-008: Memory System

- Status: **Proposed**
- Date: 2026-08-17

## Context

Ligou must remember company-specific facts and outcomes without turning untrusted conversation into permanent policy or allowing semantic similarity to become authorization.

## Proposed decision

Store typed, versioned relational memory with provenance, authority, sensitivity, effective/expiry time, and status. Separate ordinary facts/preferences/procedures from policies. Let models propose memory; require dashboard confirmation according to authority. Use pgvector only as a derived retrieval index.

## Consequences

- Correction/revocation append versions and invalidate derived indexes.
- Retrieval includes tenant, purpose, status, authority, provenance, and version filtering.
- Raw transcripts remain evidence artifacts with shorter retention, not memory by default.
- Policy evaluation is deterministic and outranks remembered preference.

## Promotion criteria

Pass provenance/conflict/revocation/deletion/prompt-injection tests and a Ligou retrieval-quality evaluation.

## Rejected alternatives

- Store every transcript indefinitely as memory.
- Let the model autonomously create permanent policy.
- Use a global vector search as the first tenant filter.
