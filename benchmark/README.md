# Ligou voice evaluation

This directory now has two deliberately separate scopes:

1. `launch-smoke/` is the active, bounded V0.1 gate for the intended production
   candidate.
2. The Voice Gauntlet design and provider research are preserved, deferred
   V0.2/V0.3 inputs. They do not modify or replace Ligou's production voice
   controller.

## Current stage

The 50-scenario Stage 0 build is **checkpointed and deferred**. No generalized
runner, adapters, audio factory, scorers, leaderboard, or reporting platform is
being built on the V0.1 launch path.

- Provider qualification is documentation-only and dated 2026-08-21.
- The current V0.1 smoke candidate is the actual RC default: OpenAI
  `gpt-realtime-2.1` with voice `ash` and authoritative sideband.
- The smoke gate has twelve statically validated scenarios and no live results.
- No paid provider session has run.
- No fake-provider runner or benchmark leaderboard was implemented.
- Provider research does not select a winner or prove production behavior.

The exact candidate registry is
[`config/candidates.json`](config/candidates.json), with claim-by-claim official
evidence in [`PROVIDER-COMPATIBILITY.md`](PROVIDER-COMPATIBILITY.md). Only
`QUALIFIED` records may set `selected_for_v1: true`; conditional candidates do
not receive adapters or paid-plan allocation. The checkpoint and deferred scope
are in [`CHECKPOINT.md`](CHECKPOINT.md) and
[`BACKLOG-V0.2-V0.3.md`](BACKLOG-V0.2-V0.3.md).

## Future paid-run boundary

No paid runner exists in this checkpoint. Any future paid execution remains
forbidden unless the same process receives both:

```text
BENCHMARK_PAID_RUN_AUTHORIZED=1
BENCHMARK_MAX_SPEND_USD=<finite positive decimal>
```

Those variables would be necessary, not sufficient. A future command must also
have explicitly named credential variables, a pricing-based plan below the hard
ceiling, and reservation capacity for its entire session. It must not read
repository `.env` files, discover fallback credentials, or call an unselected
candidate.

Any later runner must stop before the cap, terminate and clean up live sessions
on abort, preserve partial traces, and reject results whose provider usage or
cost evidence is missing. A pricing page may support an estimate; it never
substitutes for per-session provider evidence.

Task 1 made no provider API call, created no credential, and incurred no spend.

## Deferred synthetic-audio boundary

The deferred design proposed committed, normalized, hash-addressed synthetic
caller audio. It was not implemented in this run. If implemented later,
reproducibility must not be misrepresented as equivalence to real callers.

Synthetic clips cannot prove performance for Brazilian-accented English,
spontaneous code-switching, emotional speech, real phone-network artifacts,
uncontrolled rooms, natural overlapping speech, or human repair behavior. The
proposed ten human-calibration scripts and recordings were not created.
Synthetic and human results must remain separately labeled if that backlog is
resumed.

## Deferred gauntlet sequence

1. **Stage 0 — local only:** validate 50 manifests/audio hashes, isolated state,
   adapter contracts, deterministic scorers, traces/reports, a fake provider,
   budget controls, cleanup, and secret containment.
2. **Stage 1 — paid smoke:** run a representative subset only after separate
   authorization and a hard budget cap.
3. **Stage 2 — paid full suite:** run all 50 only for Stage 1 survivors.
4. **Stage 3 — variance:** repeat the hardest cases for the top viable choices.

This sequence is archival planning, not the current work queue. The only active
V0.1 evaluation artifact is the launch smoke gate, whose report truthfully says
`NO_LIVE_RESULTS_YET` until an authorized controlled execution occurs.
