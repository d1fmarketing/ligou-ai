# ADR-005: Realtime Voice Provider

- Status: **Experimental**
- Date: 2026-08-17

## Context

Voice quality, interruption behavior, operational tool reliability, cost, and capacity cannot be selected from marketing claims or unrelated benchmarks. OpenAI is strategically preferred, and GPT-Realtime-2.1 is public, but GPT-Live-1 is a distinct future candidate.

## Experiment decision

Test `gpt-realtime-2.1` first through a provider-independent VoiceAdapter. Compare it on identical Ligou fixtures with at least one credible alternative path—xAI, Gemini, Nova, or a cascade—chosen by spike cost and feasibility.

GPT-Live-1 remains `Blocked` as a selection until a stable public API contract, pricing, capacity/data terms, and Ligou-specific evaluation exist.

## Hard gates

- no unauthorized/cross-tenant action or protected-ID exposure;
- exact required tool sequence and argument correctness;
- truthful pending/confirmed/failed/unknown language;
- interruption/correction and stale-result safety;
- inbound telephony quality under noisy 8 kHz audio;
- acceptable p95 latency and measured all-in cost;
- capacity and session lifecycle fit;
- normalized export with no SDK-state dependency.

## Consequences

- OpenAI preference influences experiment order, not acceptance criteria.
- Provider portability is tested early.
- GPT-Live can later compete without a speculative compatibility layer.

## No decision yet

No voice provider, model, snapshot, or fallback chain is accepted by this ADR.
