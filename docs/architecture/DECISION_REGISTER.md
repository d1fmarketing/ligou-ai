# Decision Register

## Status vocabulary

- **Accepted**: an invariant or choice supported strongly enough to govern implementation.
- **Proposed**: preferred direction awaiting review or bounded validation.
- **Experimental**: must be compared in an executable spike before selection.
- **Blocked**: cannot be selected until missing external or internal evidence exists.
- **Deferred**: intentionally outside the first slice.
- **Rejected/Superseded**: considered and explicitly not selected.

Only ADR-001 and ADR-002 are immediately accepted. Vendor and topology choices cannot become accepted by appearing in a diagram.

| ADR | Decision | Status | Promotion condition |
|---|---|---|---|
| [ADR-001](adrs/ADR-001-canonical-agent-identity.md) | One canonical Ligou identity | **Accepted** | Product invariant; change requires explicit product decision. |
| [ADR-002](adrs/ADR-002-tenant-agent-space.md) | Persistent isolated `AgentSpace` per tenant, independent of process lifetime | **Accepted** | Product invariant; isolation acceptance criteria remain mandatory. |
| [ADR-003](adrs/ADR-003-agent-runtime.md) | Thin Ligou-owned TypeScript authority kernel; SDKs behind adapters | **Proposed** | Contract spike and operational review. |
| [ADR-004](adrs/ADR-004-tenant-isolation.md) | Shared AWS control plane plus PostgreSQL RLS for pilot; physical tiers later | **Proposed** | Database adversarial isolation and credential-role spike passes. |
| [ADR-005](adrs/ADR-005-realtime-voice-provider.md) | OpenAI Realtime first strategic candidate; provider selected by Ligou eval | **Experimental** | Voice quality, tool correctness, latency, interruption, failover, and cost gates pass. |
| — | GPT-Live-1 as a selectable provider | **Blocked** | Public stable API contract, data terms, capacity, pricing, and Ligou eval support selection. |
| [ADR-006](adrs/ADR-006-model-gateway.md) | Provider-independent ModelGateway and VoiceAdapter contracts | **Proposed** | Two adapters prove state and tool contracts contain no provider SDK types. |
| [ADR-007](adrs/ADR-007-data-isolation.md) | RDS PostgreSQL canonical data, RLS/default-deny, S3 for bounded artifacts | **Proposed** | Isolation, backup/restore, deletion/export, and RLS bypass tests pass. |
| [ADR-008](adrs/ADR-008-memory-system.md) | Versioned relational memory; embeddings derived and disposable | **Proposed** | Conflict, provenance, revocation, retention, and retrieval evals pass. |
| [ADR-009](adrs/ADR-009-action-gateway.md) | Deny-first deterministic Action Gateway with approval and receipts | **Proposed** | Calendar vertical slice proves idempotency, races, retry, and audit invariants. |
| [ADR-010](adrs/ADR-010-durable-workflows.md) | Durable workflow engine | **Experimental** | DBOS vs Step Functions spike selects the smallest survivor; Hatchet/Temporal only if needed. |
| [ADR-011](adrs/ADR-011-telephony-provider.md) | Twilio or Telnyx inbound SIP | **Experimental** | Identical inbound/transfer/failure/portability/cost test selects provider. |
| [ADR-012](adrs/ADR-012-observability-and-audit.md) | OpenTelemetry plus normalized, tenant-bound audit | **Proposed** | Redaction, access, retention, trace continuity, and tamper tests pass. |
| — | Pilot escalation behavior `ASYNC_CASE` | **Proposed** | Vertical slice passes; policy abstraction retains future `LIVE_TRANSFER`, `CALLBACK`, `DENY`. |
| — | Standard user OAuth as intended Google Calendar owner | **Proposed** | OAuth refresh/revocation and tenant mapping spike passes. |
| — | Domain-wide delegation in pilot | **Rejected/Superseded** | Reconsider only through a separate blocking security/blast-radius decision. |
| — | Outbound customer calls/campaigns in first slice | **Deferred** | Requires separate product, consent, compliance, abuse, and carrier work. |
| — | Audio recording by default | **Rejected/Superseded** | Reconsider only with explicit legal/product basis and consent design. |
| — | Raw transcript retention: 30 days | **Proposed** | Legal/privacy approval and deletion verification. |
| — | OpenClaw or Hermes as canonical multi-tenant runtime | **Rejected/Superseded** | Current evidence fails direct-fit gates; patterns may be evaluated in containment. |

## Decision discipline

Every status change must include:

1. the dated evidence or spike result;
2. hard-gate outcome;
3. alternatives compared;
4. known failure modes and rollback path;
5. owner and review date;
6. an ADR update in the same change.

No verbal provider preference, benchmark headline, or list-price advantage is sufficient to promote a decision.
