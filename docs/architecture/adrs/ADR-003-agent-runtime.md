# ADR-003: Agent Runtime

- Status: **Proposed**
- Date: 2026-08-17

## Context

OpenAI SDKs, OpenClaw, Hermes, LiveKit, Pipecat, and other frameworks provide useful pieces. None is evidence that it should own Ligou’s tenant identity, authorization, policy, or durable state.

## Proposed decision

Build a thin Ligou-owned TypeScript/Node authority kernel. Use `openai-node` for transport and consider `openai-agents-js` for contained tool/orchestration/trace primitives behind adapters.

OpenClaw and Hermes may inform patterns or run in a containment spike, but neither becomes the canonical multi-tenant runtime under current evidence.

## Required boundaries

- no provider/framework object in canonical state;
- no host-wide tool execution;
- Ligou-owned tool schemas and authorization;
- exportable relational state;
- replaceable voice/model/workflow adapters;
- pinned dependencies and supply-chain controls.

## Consequences

- More domain code is Ligou-owned, but it is the code that differentiates and protects the product.
- SDK/provider updates are localized.
- Framework features can be adopted incrementally without surrendering authority.

## Promotion criteria

A contract spike must implement one flow with two model/voice adapters or test doubles, prove provider serialization isolation, and quantify operating/development burden.

## Alternatives

- **OpenClaw core:** rejected for now due single-operator/personal gateway assumptions.
- **Hermes core:** rejected for now due self-improving personal-agent assumptions.
- **Full bespoke media/model stack:** rejected; unnecessary reinvention.
- **LiveKit/Pipecat core:** deferred unless direct provider/SIP paths fail requirements.
