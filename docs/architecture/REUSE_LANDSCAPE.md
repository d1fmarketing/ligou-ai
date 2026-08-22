# Reuse Landscape

## Verdict

Do not build a voice/agent stack from raw primitives, and do not adopt a personal-agent framework as the Ligou core. The smallest defensible body is a **Ligou-owned authority kernel** surrounded by replaceable open-source and provider adapters.

The authority kernel is deliberately narrow: tenant context, cases, policies, approvals, idempotency, durable tasks, receipts, audit, and canonical memory. Everything else is a replaceable component.

## Hard gates

A candidate is eliminated before weighted scoring when it fails any applicable gate:

1. compatible license and attributable provenance;
2. server-derived tenant binding with adversarial isolation tests;
3. deterministic idempotency and retry semantics for external actions;
4. exportable canonical data and provider-independent contracts;
5. auditable approval, policy, action, and receipt history;
6. bounded tool surface with no host-wide execution by default;
7. active maintenance and a reproducible pinned revision.

## Candidate matrix

| Layer | Candidate | Reuse | Gate result | Decision posture |
|---|---|---|---|---|
| OpenAI transport | `openai-node` | API transport, typed request/response handling | Passes license/provenance; adapter boundary still required | **Preferred candidate** |
| Agent SDK | `openai-agents-js` | Tool schemas, tracing, handoffs, Realtime integration | Passes as library; cannot own canonical state or authorization | **Contained candidate** |
| OpenAI examples | Realtime Agents / Console / Twilio demo | Supervisor/handoff, event debugger, and media-bridge teaching patterns | MIT references; demos do not prove production security, tools, or telephony | **Spike inputs, not runtime dependencies** |
| OpenAI browser voice | `realtime-voice-component` | Narrow app-owned UI tool/controller patterns | Apache-2.0 reference; explicitly not production-ready, not an inbound phone stack | **Future dashboard/demo reference** |
| Personal agent | OpenClaw | Gateway/tool/sandbox patterns | Direct adoption fails single-operator and host-tool assumptions | **Reference / contained spike only** |
| Personal agent | Hermes Agent | Memory/skill and gateway patterns | Autonomous self-improvement conflicts with governed tenant policy | **Reference only unless constrained spike proves fit** |
| Voice pipeline | LiveKit Agents | Media transport and agent adapter patterns | Passes license; adds media infrastructure and operational surface | **Fallback comparator** |
| Voice pipeline | Pipecat | Broad provider-neutral pipeline and frame processors | Passes license; large framework commitment for initial direct-SIP path | **Fallback comparator** |
| Durable workflows | DBOS Transact TS | Postgres-backed durable functions/queues in TypeScript | Promising smallest operational body; semantics need spike | **Primary spike candidate** |
| Durable workflows | AWS Step Functions Standard | Managed durable orchestration and execution history | Strong AWS fit; state/payload/cost/developer ergonomics need spike | **Primary comparator** |
| Durable workflows | Hatchet | Postgres-backed worker orchestration and UI | Capable, but another service/control plane | **Escalation candidate** |
| Durable workflows | Temporal | Mature workflows, timers, signals, replay | Strongest maturity, heaviest initial operating burden | **Deferred unless simpler candidates fail** |
| Database | RDS PostgreSQL | Canonical relational store, RLS, transactions | Strong fit; RLS role discipline and recovery must be proven | **Proposed** |
| Authentication | Better Auth organization plugin | Login/session plus organization/member/access-control primitives | MIT and tested; Ligou must still own tenant authorization and harden deployment | **Spike candidate alongside Cognito/OIDC** |
| TypeScript DB layer | Drizzle ORM | Schema/migrations/query layer | Useful, but ORM filters never substitute for RLS | **Proposed candidate** |
| Semantic retrieval | pgvector | Derived embeddings/indexes in Postgres | Passes when index is disposable and tenant-bound | **Proposed candidate** |
| Evaluation | Promptfoo | Provider/prompt/tool-policy regression and red-team cases | Passes; needs Ligou-owned fixtures and deterministic oracles | **Proposed** |
| Telemetry | OpenTelemetry JS | Vendor-neutral traces, metrics, logs | Passes; PII redaction/tenant tagging required | **Proposed** |

Pinned revisions and source evidence are recorded in [`EVIDENCE_REGISTER.md`](EVIDENCE_REGISTER.md).

## Internal reuse

### Buzz

`d1fmarketing/buzz@bd2fdf4…` contains relevant patterns:

- bind tenant/community from a trusted request boundary before processing events;
- reject client-supplied tenant overrides;
- make PostgreSQL authoritative and Redis/fanout ephemeral;
- use signed event envelopes, idempotent inserts, and tamper-evident audit chaining.

Reuse requires extracting and independently testing a primitive. The Buzz protocol, product model, and deployment topology are not Ligou architecture.

### Dashboard prototype

The dashboard branch supplies domain vocabulary and interaction semantics:

- approve once;
- turn an exception into a scoped or temporary rule;
- adjust a proposal;
- reject without mutating memory;
- edit/revoke a versioned rule and show a receipt.

Its local-storage implementation is expressly rejected as a security or persistence foundation.

### Shellhouse and WordFlux

Shellhouse CloudFormation/ECR assets demonstrate account bootstrap and deployment experience. WordFlux contains possible ledger, queue, and circuit-breaker ideas. Neither has been accepted as reusable Ligou runtime code. Missing/unclear licensing, domain coupling, tests, and security review prevent direct copying.

## Build versus reuse boundary

### Build as Ligou-owned code

- tenant resolution and `TenantContext` propagation;
- canonical case/policy/approval/task/receipt/audit schemas;
- authorization and deterministic policy evaluation;
- Action Gateway and calendar mapping enforcement;
- normalized Model/Voice/Telephony adapter contracts;
- transcript-to-memory proposal pipeline;
- tenant isolation and business-invariant test suites.

### Reuse as libraries/services

- OpenAI SDK transport and optional Agents SDK orchestration;
- official OpenAI Realtime examples as disposable fixtures/debugging references;
- an established OIDC/authentication library or managed identity service rather than custom passwords/sessions;
- PostgreSQL/RLS, pgvector, and a TypeScript query/migration layer;
- one durable workflow engine after the spike;
- OpenTelemetry and CloudWatch export;
- provider SIP/voice APIs behind adapters;
- Promptfoo plus ordinary unit/integration/load tests.

## Explicit skip list

- No OpenClaw or Hermes monolith as the multi-tenant authority core.
- No provider event object persisted as AgentCore state.
- No MCP server as the authorization boundary.
- No vector database as the source of truth.
- No Redis-only memory, approvals, queues, or receipts.
- No direct model access to Google OAuth tokens or raw calendar IDs.
- No simultaneous adoption of DBOS, Hatchet, Temporal, and Step Functions.
- No separate always-on compute process merely to represent each tenant identity.

## Selection sequence

1. Accept product invariants and normalized contracts.
2. Implement executable spike fixtures, not production paths.
3. Run hard gates.
4. Compare survivors on failure behavior, portability, cost, and operator burden.
5. Promote a candidate in its ADR with the evidence attached.

This sequence prevents “reuse” from becoming hidden architectural ownership by a framework.
