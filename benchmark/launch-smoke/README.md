# Ligou V0.1 launch smoke gate

This directory defines the smallest voice evaluation needed before a controlled
V0.1 pilot. It is a launch gate for the configuration Ligou actually intends to
use, not a provider tournament or a generalized benchmark platform.

## Status

- Primary candidate: OpenAI `gpt-realtime-2.1`, voice `ash`, with the
  authoritative WebSocket sideband.
- The candidate matches the defaults in `voice-controller/src/config.ts` at the
  V0.1 RC snapshot from which this branch was created.
- Secondary candidate: none.
- Scenario definitions: 12/12 present and statically validated.
- Live executions: **none**.
- Report state: `NO_LIVE_RESULTS_YET`.

Run the secret-free structural gate with:

```bash
node --test benchmark/launch-smoke/tests/launch-smoke.test.mjs
node benchmark/launch-smoke/validate.mjs
```

The validator deliberately rejects a thirteenth scenario, a different primary
identity, or generalized score/weight fields. Expanding this gate requires a
new launch decision, not an incidental edit.

## What the gate measures

Each scenario records only:

- pass/fail;
- critical tool correctness;
- measured latency;
- approximate cost derived from actual provider usage evidence;
- hard disqualifications.

There is no composite score or leaderboard. Any hard disqualification fails the
candidate for the pilot until the cause is corrected and the affected cases are
rerun.

## Controlled execution procedure

The repository does not automate a paid or live run in this checkpoint. After
the launch blockers in `docs/release/V0.1-LAUNCH-PATH.md` are closed and a
separate authorization is granted:

1. Use an isolated pilot tenant with synthetic caller identity and known rules.
2. Copy `report-template.json` to an execution-specific evidence location; do
   not overwrite the honest empty template.
3. Run one scenario at a time against the exact primary identity.
4. Preserve the provider session identity, tool trace, authoritative receipt,
   latency timestamps, and provider usage needed to estimate cost.
5. Mark a scenario `PASS` only when every pass condition holds and no hard
   disqualification occurs. Missing or ambiguous evidence is not a pass.
6. Keep customer audio and credentials outside Git.

The accented/noisy-English scenario is a controlled smoke case. It does not
claim to replace real human accent calibration, which remains deferred.

## Files

- `suite.json` — frozen candidate identity and twelve launch-critical cases.
- `report-template.json` — empty, honest result shape.
- `validate.mjs` — fail-closed structural validator.
- `tests/launch-smoke.test.mjs` — independent literal scenario and scope checks.
