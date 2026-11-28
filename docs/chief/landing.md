# Landing

On 2026-11-27 the Pi session first described a "core" versus "batch mode only" split. The same day it was replaced by a per-task landing policy, agreed with the agy agent ([round 5](sources/pe9-round5.md)). The "mode" wording is superseded.

**Landing**: the per-task policy, fixed at launch, for how accepted work finishes.

| Landing | Runs in | `accept` checks | Who integrates |
|---|---|---|---|
| `none` | main checkout or worktree | clean tree; empty diff allowed | nobody |
| `in-place` | main checkout | clean tree, commit on current branch | the coordinator's commit |
| `branch` | worktree | clean worktree, branch ahead of base | user or chief merges locally later |
| `pr` | worktree | replaced by the gate | GitHub merge with user approval |

- Only `pr` adds states: `REPORTED --gate--> GATED(sha)`, `GATED --head-moved--> REPORTED`, `GATED --round--> RUNNING`, `GATED --> MERGED | LEFT_OPEN`. In `batch-chief` the coordinator opens the PR while RUNNING (`skills/batch-chief/CONTRACT.md:66`, `me-pi@8f9a81f`).
- Fixed at launch: promoting `branch` to `pr` would break the contract already given to the coordinator. A new `pr` task is opened instead.
- Local landings record the accepted commit as a fact, with no pinned state.

## What happens to batch-level parts of batch-chief
Proposed by the agy agent on 2026-11-27, line references unchecked:
- `current` run pointer: dropped; one continuous log per repo.
- Preflight: base, tools, rules become repo-level state; tickets and live checks become task fields.
- Max running rows: repo-level config.
- Overlap ordering: the task's `after` field.
- Cleanup: per-task command plus a repo sweep. Ledger: derived view.

## Slices
- Slice 1: `none`, `in-place`, `branch`; no GitHub state.
- Slice 2: PR delivery, then retire `skills/batch-chief/`. The two coexist in between.

## Proposed glossary terms (not yet in `GLOSSARY.md`)
Task lifecycle, Landing, PR delivery. Avoid: batch mode, PR mode, core mode.

Related: [State machines](state-machines.md).
