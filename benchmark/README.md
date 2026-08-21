# Ligou Voice Gauntlet v1

Ligou Voice Gauntlet is a provider-neutral, reproducible benchmark laboratory
for 50 difficult service-business voice-call scenarios. It does not modify or
replace Ligou's production voice controller.

## Current stage

This branch is building **Stage 0: local deterministic infrastructure**.

- Provider qualification is documentation-only and dated 2026-08-21.
- No paid provider session has run.
- Fake-provider runs prove benchmark architecture only; they never populate a
  paid leaderboard or select a production model.
- Every pre-paid-run report must say `NO_PAID_PROVIDER RESULTS YET`.
- The expected successful no-spend verdict is
  `READY_FOR_PAID_BENCHMARK`—not “best model,” “production ready,” or any claim
  about live provider performance.

The exact candidate registry is
[`config/candidates.json`](config/candidates.json), with claim-by-claim official
evidence in [`PROVIDER-COMPATIBILITY.md`](PROVIDER-COMPATIBILITY.md). Only
`QUALIFIED` records may set `selected_for_v1: true`; conditional candidates do
not receive v1 adapters or paid-plan allocation.

## Paid-run gate

Paid execution is forbidden unless the same process receives both:

```text
BENCHMARK_PAID_RUN_AUTHORIZED=1
BENCHMARK_MAX_SPEND_USD=<finite positive decimal>
```

Those variables are necessary, not sufficient. The paid command must also have
the selected candidate's explicitly named credential variables, a pricing-based
plan that fits below the hard ceiling, and reservation capacity for the entire
planned session before it starts. Adapters do not read repository `.env` files,
discover fallback credentials, or call an unselected candidate.

The runner must stop before the cap, terminate and clean up every live session
on abort, preserve partial traces, and reject a result whose provider usage or
cost evidence is missing. A pricing page supports the estimate; it never
substitutes for per-session provider evidence.

Task 1 made no provider API call, created no credential, and incurred no spend.

## Synthetic audio boundary

Stage 0 caller audio is synthetic, committed, normalized, and hash-addressed so
the same bytes reach every adapter. That makes regression runs reproducible; it
does not make the fixtures equivalent to real callers.

In particular, synthetic clips do not prove performance for Brazilian-accented
English, spontaneous code-switching, emotional speech, real phone-network
artifacts, uncontrolled rooms, natural overlapping speech, or human repair
behavior. Ten human-calibration scripts are committed without recordings so a
later authorized calibration can measure those gaps honestly. Synthetic and
human results must remain separately labeled.

## Stage sequence

1. **Stage 0 — local only:** validate all 50 manifests and audio hashes,
   independent fixture resets, adapter contracts, deterministic scorers,
   traces/reports, fake-provider end-to-end behavior, the budget gate, cleanup,
   and secret containment.
2. **Stage 1 — paid smoke:** only after explicit authorization, run ten
   representative scenarios per selected qualified candidate. Any hard
   disqualification, missing usage, cleanup failure, or budget violation stops
   advancement.
3. **Stage 2 — paid full suite:** every Stage 1 survivor runs all 50 canonical
   scenarios under the same frozen benchmark identity.
4. **Stage 3 — variance:** the top two repeat the 15 hardest scenarios twice
   more. Provider evidence, not fake results or documentation, determines the
   recommendation.

Until Stages 1–3 are separately authorized and executed, the only legitimate
completion statement is the no-spend readiness verdict above.
