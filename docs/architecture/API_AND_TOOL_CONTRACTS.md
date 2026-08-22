# API and Tool Contracts

Status: **Proposed**. These are provider-independent architecture contracts, not generated production interfaces.

## Contract principles

- Tenant context is transport metadata created by trusted Ligou code, never a model argument.
- Tools accept business capabilities, not raw provider resources or credentials.
- All inputs are schema-validated and semantically validated.
- Read and propose tools may be synchronous; side effects cross the Action Gateway.
- Every mutable request has a caller-generated or server-issued idempotency key.
- Provider-specific SDK objects/events stop at adapters.
- Errors are typed and safe to speak; internal details remain in protected telemetry.

## Trusted context envelope

```ts
type TenantContext = {
  tenantId: string;
  agentSpaceId: string;
  channelBindingId: string;
  actor: { type: "CALLER" | "TENANT_MEMBER" | "SYSTEM"; id: string };
  traceId: string;
  issuedAt: string;
  expiresAt: string;
  policySetVersion: number;
};
```

This object is injected by the server and is not included in tool JSON schemas shown to a model.

## Normalized provider metadata

Canonical audit may persist:

```ts
type ProviderAuditMetadata = {
  provider: string;
  model?: string;
  pinnedVersion?: string;
  providerRequestId?: string;
  latencyMs?: number;
  usage?: { inputUnits?: number; cachedInputUnits?: number; outputUnits?: number };
  finishReason?: "COMPLETED" | "INTERRUPTED" | "TIMEOUT" | "ERROR" | "UNKNOWN";
};
```

It may not persist SDK event classes, enums, transport frames, credentials, or raw provider payloads. Strictly necessary raw payloads stay in adapter telemetry with separate access and retention.

## Voice-to-AgentCore tools

### `get_business_availability`

Read-only. Returns normalized candidate windows without exposing `calendar_id`.

```json
{
  "service_type": "hvac_diagnostic",
  "date_range": { "start": "2026-08-18", "end": "2026-08-20" },
  "timezone": "America/Los_Angeles"
}
```

Response includes opaque `slot_token` values signed/bound to tenant, mapping version, query constraints, and expiry.

### `propose_schedule`

Creates a proposal/case; it does not create a calendar event.

```json
{
  "slot_token": "opaque-expiring-token",
  "service_type": "hvac_diagnostic",
  "customer": {
    "name": "string",
    "phone": "E.164",
    "address": "normalized string"
  },
  "notes": "bounded string",
  "caller_confirmed": true
}
```

Possible normalized results:

- `ALLOWED_AND_QUEUED`
- `PENDING_APPROVAL`
- `DENIED_BY_POLICY`
- `NEEDS_CLARIFICATION`
- `STALE_SLOT`
- `TEMPORARILY_UNAVAILABLE`

The voice agent must use result-specific wording and may never promise completion for a pending/unknown outcome.

### `get_case_status`

Read-only and scoped to a server-issued opaque case reference. It returns a safe public status, not internal approval/user data.

## Dashboard commands

### `POST /v1/cases/{caseId}/decisions`

Authenticated tenant-member command:

```json
{
  "expected_case_version": 4,
  "proposal_version": 2,
  "decision": "APPROVE_ONCE",
  "reason": "Owner confirmed after-hours visit",
  "idempotency_key": "uuid"
}
```

The server derives tenant/member, verifies proposal hash and role, applies optimistic concurrency, creates the point approval, and enqueues the action atomically or through an outbox.

### `POST /v1/policies`

Separate, stronger-confirmation command:

```json
{
  "source_case_id": "opaque-id",
  "expected_proposal_version": 2,
  "effect": "ALLOW",
  "conditions": {
    "service_type": ["hvac_diagnostic"],
    "max_value_usd": 750,
    "time_window": "after_hours"
  },
  "expires_at": "2026-09-17T00:00:00Z",
  "confirmation_nonce": "short-lived-server-nonce",
  "idempotency_key": "uuid"
}
```

Creating a permanent/scoped policy is never an accidental side effect of approving one case.

### `POST /v1/memory/{memoryId}/versions`

Creates an edited/superseding/revoking version with expected version, reason, provenance, and idempotency. Deleting UI text does not erase audit history.

## Action Gateway contract

```ts
type ActionRequest = {
  actionType: "GOOGLE_CALENDAR_CREATE_EVENT";
  proposalId: string;
  proposalVersion: number;
  approvalId?: string;
  policyDecisionId: string;
  resourceCapability: "PRIMARY_SCHEDULING_CALENDAR";
  normalizedInput: {
    start: string;
    end: string;
    timezone: string;
    summary: string;
    description: string;
    attendeeContact?: string;
  };
  idempotencyKey: string;
  freshnessDeadline: string;
};
```

Execution order:

1. validate trusted context and request schema;
2. lock/read exact proposal version;
3. re-evaluate policy or validate exact point approval;
4. resolve `resourceCapability` through the authenticated tenant mapping;
5. claim idempotency key with canonical request hash;
6. create durable task/outbox record;
7. execute adapter with timeout/cancellation/freshness token;
8. normalize and verify provider result;
9. commit receipt and final state;
10. reconcile `UNKNOWN` outcomes before any retry that could duplicate a side effect.

## Google Calendar adapter

Internal only:

```ts
interface CalendarAdapter {
  getAvailability(input: ResolvedAvailabilityRequest): Promise<NormalizedAvailability>;
  createEvent(input: ResolvedCreateEventRequest): Promise<NormalizedCalendarReceipt>;
  reconcileEvent(input: ReconcileRequest): Promise<NormalizedCalendarReceipt | null>;
}
```

`ResolvedCreateEventRequest` is constructed inside the Action Gateway and contains the protected resource ID. It is never serializable into a model tool call or returned to VoiceEdge.

## Escalation policy

```ts
type EscalationMode = "ASYNC_CASE" | "LIVE_TRANSFER" | "CALLBACK" | "DENY";
```

The pilot configuration permits only `ASYNC_CASE`. Unsupported modes fail deployment/config validation rather than silently approximating behavior.

## Error taxonomy

| Code | Retry? | Caller-safe behavior |
|---|---:|---|
| `INVALID_INPUT` | No | Ask for a specific correction. |
| `UNAUTHORIZED` | No | Do not disclose protected state. |
| `POLICY_DENIED` | No | Explain the permitted next step. |
| `APPROVAL_REQUIRED` | No automatic mutation | Create async case and avoid promise of completion. |
| `STALE_VERSION` | Re-read | State changed; refresh before deciding. |
| `STALE_TOOL_RESULT` | No | Discard and re-evaluate. |
| `DUPLICATE_REQUEST` | Return original result | Use existing receipt/status. |
| `PROVIDER_TIMEOUT` | Reconcile first | Say status is not yet confirmed. |
| `PROVIDER_REJECTED` | Policy-specific | Do not retry blindly. |
| `TEMPORARY_UNAVAILABLE` | Bounded retry | Offer async/callback-safe path. |
| `UNKNOWN_OUTCOME` | Reconcile only | Never claim success or issue an unguarded duplicate. |

## Webhook contract

Carrier and provider webhooks require:

- provider signature validation using exact documented canonicalization;
- timestamp tolerance and nonce/event-ID replay protection;
- body size/content-type/schema limits;
- server-side lookup from called number/trunk/session mapping;
- rejection of payload tenant identifiers;
- idempotent event ingestion;
- rapid acknowledgment with durable asynchronous processing;
- normalized audit event and protected raw telemetry retention.

## Contract tests

Every adapter must pass the same suite for:

- valid/invalid schema and semantic boundaries;
- cross-tenant identifier substitution;
- duplicate idempotency key with same and different payload;
- timeout before/after provider commit;
- late/stale tool result;
- cancellation and caller correction;
- provider error normalization;
- removal of SDK-specific types through serialization checks;
- normalized metadata and PII-redaction rules.
