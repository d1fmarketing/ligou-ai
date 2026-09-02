# Evidence Register

Status: architecture evidence snapshot

Repository baseline: `d1fmarketing/ligou-ai@161e8e84cbc3c675869e7018f1bf2a3b11cbae99`

Observed: 2026-08-17

Rule: evidence supports a decision; it does not silently turn a candidate into an accepted dependency.

## Confidence scale

- **Confirmed**: primary documentation, repository inspection, or a read-only command directly supports the claim.
- **Inferred**: the evidence supports a design direction, but a Ligou-specific test is still required.
- **Unknown**: no adequate public or local evidence exists; the question becomes a spike or blocker.

## Product and repository evidence

| ID | Claim | Evidence | Confidence | Architectural consequence |
|---|---|---|---|---|
| E-001 | The canonical Ligou identity and one persistent, isolated `AgentSpace` per company are product invariants. | Approved architecture brief and product direction in [`../source/LIGOU-PRODUCT-BRIEF-WORKING.md`](../source/LIGOU-PRODUCT-BRIEF-WORKING.md). | Confirmed | ADR-001 and ADR-002 may be accepted before vendor spikes. |
| E-002 | The current default branch is a static landing page, not a backend or voice product. | Repository inspection at the pinned baseline: no backend, database schema, auth service, telephony integration, voice runtime, or infrastructure code. | Confirmed | Existing frontend cannot be cited as proof of runtime readiness. |
| E-003 | The dashboard branch is a prototype with useful domain vocabulary but no security authority. | `codex/ligou-dashboard@278457f`: local state, no production auth/API/telephony. It models point approval, policy creation, adjustment, rejection, edit, and revocation. | Confirmed | Reuse language and UX semantics; do not reuse local state as the authorization boundary. |
| E-004 | The first slice is inbound customer calls in English plus owner onboarding/configuration/dashboard in Portuguese. | Explicitly approved scope. Outbound consumer calling and campaigns are excluded. | Confirmed | Telephony spikes test inbound only; no outbound campaign subsystem is designed. |
| E-005 | The dashboard is the sole authoritative approval surface for the pilot. | Explicitly approved invariant. SMS, WhatsApp, and email are notifications/deep links only. | Confirmed | No approval-by-reply or model-declared approval is permitted. |

## OpenAI and voice evidence

| ID | Claim | Evidence | Confidence | Architectural consequence |
|---|---|---|---|---|
| E-010 | `gpt-realtime-2.1` is a current public speech-to-speech API model with function calling and configurable reasoning. | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1). | Confirmed | It is the strategic first candidate, not an accepted provider. |
| E-011 | Realtime sessions have a 60-minute maximum. | [OpenAI Realtime conversation lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations#session-lifecycle-events). | Confirmed | VoiceEdge needs a maximum-call policy and a continuity/termination path. |
| E-012 | OpenAI Realtime supports SIP through a trunk provider and server-side controls for private business logic. | [Realtime SIP](https://developers.openai.com/api/docs/guides/realtime-sip) and [server controls](https://developers.openai.com/api/docs/guides/realtime-server-controls). | Confirmed | The model never receives private credentials; business tools execute through Ligou sideband services. |
| E-013 | Realtime MCP and function tools have different execution boundaries; narrow allowed tools and approvals are recommended. | [Realtime MCP and tools](https://developers.openai.com/api/docs/guides/realtime-mcp). | Confirmed | Ligou exposes a small app-owned tool surface; MCP is an adapter, not an authority plane. |
| E-014 | Realtime cost grows with accumulated conversation context; audio token conversion and actual usage are observable. | [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs). | Confirmed | Cost must be measured from provider usage events, not inferred only from wall-clock minutes. |
| E-015 | GPT-Live-1 is distinct from GPT-Realtime-2.1, and a stable public API contract suitable for selection is not established by the reviewed sources. | [Introducing GPT-Live](https://openai.com/index/introducing-gpt-live/) describes API availability as a future/registration path; the public API catalog currently documents Realtime separately. | Confirmed for distinction; Unknown for selectable contract | GPT-Live-1 remains a horizon candidate with status `Blocked`, never an assumed drop-in upgrade. |
| E-016 | Gemini 3.1 Flash Live is Preview and lacks asynchronous function calling. | [Gemini 3.1 Flash Live model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview). | Confirmed | It remains a comparison candidate; slow tools require explicit latency testing. |
| E-017 | Nova 2 Sonic supports asynchronous tools but has an eight-minute connection lifecycle and does not automatically cancel stale tool results. | [Nova 2 Sonic model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-sonic.html), [async tools](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-async-tools.html), and [getting started](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-getting-started.html). | Confirmed | Request IDs, freshness checks, idempotency, and session renewal belong outside the model. |
| E-018 | Deepgram Flux is multilingual STT/turn detection, not a complete voice agent. | [Flux language prompting](https://developers.deepgram.com/docs/flux/language-prompting) and [Flux state](https://developers.deepgram.com/docs/flux/state). | Confirmed | It may provide an advisory transcript; disagreement is not a calibrated confidence score. |
| E-019 | xAI Speech-to-Speech offers tools and inbound SIP, but its public default concurrency is small. | [xAI speech-to-speech model](https://docs.x.ai/developers/models/speech-to-speech) and [SIP](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip). | Confirmed | It is a useful portability comparator, not a capacity assumption. |

## Authority, calendar, data, and workflow evidence

| ID | Claim | Evidence | Confidence | Architectural consequence |
|---|---|---|---|---|
| E-020 | A secondary Google Calendar has one data owner; authenticating directly as a service account makes it the owner. | [Google Calendar calendars and events](https://developers.google.com/workspace/calendar/api/concepts/events-calendars). | Confirmed | Tenant one authenticates as the intended Workspace owner through standard user OAuth with offline access. |
| E-021 | Domain-wide delegation permits a service account to impersonate Workspace users within granted scopes. | [Google service accounts and domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account). | Confirmed | DWD is excluded from the pilot unless a blocking blast-radius spike passes first. |
| E-022 | PostgreSQL row-level security defaults to deny when enabled without a policy, but owners and `BYPASSRLS` roles can bypass it. | [PostgreSQL row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). | Confirmed | Runtime roles must not own tables or have `BYPASSRLS`; use `FORCE ROW LEVEL SECURITY` and adversarial isolation tests. |
| E-023 | Step Functions Standard is durable and auditable with exactly-once workflow execution semantics, but external side effects still need idempotency. | [Choosing Step Functions workflow type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html). | Confirmed | It is an AWS-native comparator in the durable-workflow spike, not an automatic winner. |
| E-024 | Fargate tasks have isolated compute environments, while containers inside one task share its boundary. | [AWS Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html). | Confirmed | A per-call VoiceEdge task can be isolated without an always-on process per tenant; task isolation alone does not prove tenant data isolation. |

## Telephony evidence

| ID | Claim | Evidence | Confidence | Architectural consequence |
|---|---|---|---|---|
| E-030 | Twilio and Telnyx both expose programmable SIP foundations and signed/secured webhook mechanisms. | [Twilio SIP pricing](https://www.twilio.com/en-us/sip-trunking/pricing/us), [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [Telnyx SIP pricing](https://telnyx.com/pricing/elastic-sip), and [Telnyx SIP setup](https://developers.telnyx.com/docs/voice/sip-trunking/get-started). | Confirmed | Both remain experimental until identical Ligou call-path tests pass. |
| E-031 | List-price differences are smaller than the uncertainty from carrier extras, transfers, support, failure rates, and voice-model usage. | Provider price pages plus the cost sensitivity model in [`COST_AND_CAPACITY.md`](COST_AND_CAPACITY.md). | Inferred | A price table cannot select the carrier. |

## Reuse evidence

Repository revisions and licenses below were inspected on 2026-08-17. They are a reproducibility aid, not a promise that later revisions remain suitable.

| ID | Repository | Revision / license | Finding |
|---|---|---|---|
| E-040 | [`openai/openai-node`](https://github.com/openai/openai-node) | `a88c2ca…`, Apache-2.0 | Strong transport client candidate behind ModelGateway/VoiceAdapter. |
| E-041 | [`openai/openai-agents-js`](https://github.com/openai/openai-agents-js) | `823c14a…`, MIT | Useful orchestration/trace/tool primitives; must not become canonical state or policy authority. |
| E-042 | [`openclaw/openclaw`](https://github.com/openclaw/openclaw) | `44b41d5…`, MIT | Built as a personal, single-operator gateway. Fails direct multi-tenant-core gate without containment and redesign. |
| E-043 | [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) | `c9ce66e…`, MIT | Personal/self-improving agent patterns conflict with controlled tenant policy unless constrained. |
| E-044 | [`temporalio/temporal`](https://github.com/temporalio/temporal) | `2c35877…`, MIT | Mature durable workflow option, operationally heavy for the first slice. |
| E-045 | [`dbos-inc/dbos-transact-ts`](https://github.com/dbos-inc/dbos-transact-ts) | `5350968…`, MIT | Small TypeScript/Postgres durable-workflow candidate. |
| E-046 | [`hatchet-dev/hatchet`](https://github.com/hatchet-dev/hatchet) | `ca5a1e2…`, MIT | Capable Postgres-backed orchestration with UI; larger operational surface than DBOS. |
| E-047 | [`livekit/agents`](https://github.com/livekit/agents) | `f34ad64…`, Apache-2.0 | Useful media/agent adapter patterns if direct SIP paths prove insufficient. |
| E-048 | [`pipecat-ai/pipecat`](https://github.com/pipecat-ai/pipecat) | `4cb548f…`, BSD-2-Clause | Broad voice-pipeline framework; useful comparator, but a larger framework commitment. |
| E-049 | [`promptfoo/promptfoo`](https://github.com/promptfoo/promptfoo) | `33cc8bc…`, MIT | Good evaluation harness candidate for prompts, policies, red-team cases, and provider regression. |
| E-050 | [`open-telemetry/opentelemetry-js`](https://github.com/open-telemetry/opentelemetry-js) | `8f10377…`, Apache-2.0 | Appropriate vendor-neutral telemetry primitive. |
| E-051 | [`drizzle-team/drizzle-orm`](https://github.com/drizzle-team/drizzle-orm) | `b786252…`, Apache-2.0 | TypeScript/Postgres schema candidate; RLS remains database-enforced, not ORM-enforced. |
| E-052 | [`pgvector/pgvector`](https://github.com/pgvector/pgvector) | `36c26ba…`, PostgreSQL | Suitable derived semantic index; never the canonical memory ledger. |
| E-053 | [`openai/openai-realtime-agents`](https://github.com/openai/openai-realtime-agents) | `94c9e9116b581052655cff7b756cc5e02771cda1`, MIT | Official demonstration of Agents SDK, supervisor, and handoff patterns; useful spike fixture, not an authority/runtime blueprint. |
| E-054 | [`openai/openai-realtime-console`](https://github.com/openai/openai-realtime-console) | `ab8b8f5852b47ec1b9ef73bf566851d0eeafddbb`, MIT | Useful WebRTC event/session debugger; browser console architecture is not the inbound SIP production path. |
| E-055 | [`openai/openai-realtime-twilio-demo`](https://github.com/openai/openai-realtime-twilio-demo) | `4e9f754f6349fd6ecb82c2f35e66691268cdf11d`, MIT | Useful Twilio media-bridge teaching code, but its README explicitly mocks function execution; it is not Action Gateway proof. |
| E-056 | [`openai/realtime-voice-component`](https://github.com/openai/realtime-voice-component) | `332285bf41f321353b63ad6d79ac2cab0059a13a`, Apache-2.0 | App-owned narrow browser voice-tool patterns; its README identifies it as a reference implementation, not a production-ready UI kit. |
| E-057 | [`better-auth/better-auth`](https://github.com/better-auth/better-auth) | `c3688ba88edff12dfcb1ced007e332711509ac29`, MIT | Mature authentication candidate with organization/member/access-control plugin code and tests; still requires Ligou authorization/session security spike. |

## Read-only AWS account observation

| ID | Observation | Confidence | Consequence |
|---|---|---|---|
| E-060 | `aws sts get-caller-identity` authenticated the configured target AWS account and IAM principal; the configured region is `us-east-1`. Identifiers and credential values are intentionally omitted from this package. | Confirmed | AWS feasibility is grounded in the actual target account, while credentials and unnecessary account identifiers remain out of architecture artifacts. |
| E-061 | On 2026-08-17, `us-east-1` returned no ECS clusters and no RDS DB instances. Existing CloudFormation and ECR assets belong to other systems, including Shellhouse and Investo. | Confirmed snapshot | Ligou is not deployed. Existing bootstrap patterns may be reviewed, but resources and trust boundaries must not be shared by assumption. |
| E-062 | Several existing ECR repositories enable scan-on-push, while some bootstrap/specialized repositories do not. | Confirmed snapshot | A Ligou repository must explicitly enable immutable tagging and scanning; account defaults cannot be assumed. |

## Evidence gaps that block stronger decisions

- No Ligou PT-BR/English voice evaluation set or recorded results exist.
- No measured provider latency under real calendar/action tools exists.
- No carrier number-porting, transfer, webhook replay, or failover test exists.
- No legal retention decision for summaries, decisions, receipts, or audit exists.
- No tenant isolation test has run against a real database.
- No workload distribution, support cost, or real gross-margin data exists.
- No public GPT-Live-1 API contract has been accepted into the evidence set.

These gaps are converted into explicit work in [`SPIKE_PLAN.md`](SPIKE_PLAN.md) and [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md).
