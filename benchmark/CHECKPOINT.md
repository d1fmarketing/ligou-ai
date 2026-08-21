# Voice benchmark checkpoint — 2026-08-21

The broad Voice Gauntlet has been removed from the V0.1 launch critical path.
Useful work is preserved on `codex/v0.2-voice-gauntlet`; unfinished platform
features are explicitly deferred rather than silently abandoned.

## State captured before this checkpoint commit

- Worktree: `/Users/d1f/.codex/worktrees/ligou-v0.2-voice-gauntlet/Ligou.AI`
- Branch: `codex/v0.2-voice-gauntlet`
- Base RC: `f5e81a4ed234779864072f257a60ceadf1cf453d`
- Pre-checkpoint HEAD: `4c49004bd33c0fb6fe0ee6164a36f398db1ac443`
- Initial uncommitted scope: only the new `benchmark/launch-smoke/` directory.
- Checkpoint completion then added this status, the deferred backlog, launch-path
  status, and the explicit deferral banners needed to leave the branch coherent.
- Production files changed by the benchmark run: none.

## Commits created before the checkpoint

| Commit | Preserved result |
|---|---|
| `2c695590422de8a747661830a874e3f80fe7f2cf` | V0.2 50-scenario design and implementation plan. |
| `4c49004bd33c0fb6fe0ee6164a36f398db1ac443` | Dated provider compatibility research, exact candidate registry, and registry tests. |

## Checklist disposition

### Complete and preserved

- The V0.2 design and seven-task plan are documented.
- Task 1 provider qualification is implemented: five documented candidates,
  two qualified records, three conditional records, and no provider call.
- The compact V0.1 launch smoke definition has twelve cases, a fail-closed
  validator, an empty report template, and focused tests.

### Partial and preserved

- The broad benchmark architecture exists as design only.
- Provider qualification has executable schema/registry tests. A separate
  whole-task independent review was interrupted when the benchmark expansion
  was stopped; no review conclusion is claimed.
- No live provider evidence, paid result, winner, or human calibration exists.

### Not started and deferred

- Task 2: generalized contracts, synthetic state, trace identity, and paid gate.
- Task 3: 50 scenario manifests and ten human-calibration scripts.
- Task 4: deterministic synthetic-audio generation system.
- Task 5: generalized deterministic scorers.
- Task 6: provider adapters, fake provider, and suite runner.
- Task 7: reporting platform, paid plan, and Stage 0 acceptance.

The deferred work is catalogued in `BACKLOG-V0.2-V0.3.md`. None of it is a
prerequisite for closing the external V0.1 launch gates.
