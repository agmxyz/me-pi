## 1. Two-valued mode vs per-task landing policy
**Disagree with a two-valued mode; agree with your policy alternative.** A per-task `landing` policy (`none|in-place|branch|pr`) settles Round 4's integration gap cleanly. Pair checkout placement (`main` vs `worktree`) with it: `in-place` requires `main`; `branch`/`pr` require `worktree`; `none` allows either.
- **Guards on `accept` only (terminal `ACCEPTED`)**: `none` (clean tree, empty diff allowed); `in-place` (clean tree, commit on current branch); `branch` (clean worktree, branch ahead of base; cleanup keeps unmerged branch, `batch.ts:1766-1784`).
- **Needs own states**: `pr` only (`GATED(sha)`, `MERGED`, `LEFT_OPEN`, plus `head-moved`, `merge-intent`, `live-result`, `batch.ts:71,115,124,251-285`), because remote PR/CI/merge approval are asynchronous external states.

## 2. Fixed at launch vs promotion
**Fixed at launch.** Promoting `branch -> pr` after `REPORTED` breaks:
1. Contract freeze (`batch.ts:1610-1613`): `branch` contracts omit `CONTRACT.md:52,66-69` (push, `Closes #<n>`, CI wait) and `push` approvals (`batch.ts:793-794,1715-1727`).
2. Worktree ownership (`SKILL.md:95`): chief shouldn't push from a coordinator's worktree, yet `gate` requires `local == PR head` and green CI (`batch.ts:1182-1195`).
If a `branch` task later needs a PR, open a new `pr` task (or post-v1 add explicit `promote` requiring `push` approval and a new `RUNNING` round—never straight to `GATED`).

## 3. SHA-pinning for local merge
**Over-engineering as a state; worth logging as a fact.** Record `sha: HEAD` on `accepted` (a future local-merge command can check it). Skip `GATED(sha)`/`head-moved`: unlike PRs (`batch.ts:969-970,1239-1265`), local branches have no remote CI or `gh pr update-branch` mutating HEAD behind the chief's back.

## 4. Batch-level vs per-task vs dropped
- **preflight** (`batch.ts:624-724`): split—base/tools/rules -> **repo-level chief state** (refreshable); tickets/live -> **per-task fields**.
- **`current` run pointer** (`batch.ts:524-530,652-677`): **dropped** (one continuous repo log; no "finish all first" barrier).
- **max running rows** (`SKILL.md:58`): **repo-level chief config** (+ 1-running-per-checkout lock).
- **overlap ordering** (`SKILL.md:35,58`): **per-task field** (`after: TaskId[]`).
- **live checks** (`batch.ts:127,281-285,300`): **per-task field** (`live`, `live-result`).
- **cleanup** (`batch.ts:1735-1790,1947-2026`): **per-task command** (worktree/scratch/merged branch) + repo-level sweep.
- **ledger** (`batch.ts:1053-1099`): **repo-level derived view**.

## 5. Glossary terms (`GLOSSARY.md` style)
**Task lifecycle**:
The core state machine every task follows from queue to acceptance or drop, independent of git hosting or how changes land.
_Avoid_: Core mode, batch core

**PR delivery**:
The optional GitHub pull-request extension replacing `accept` with SHA-pinned gating, CI verification, and user-approved merge or leave-open.
_Avoid_: Batch mode, PR mode

**Landing**:
The per-task policy, fixed at launch, declaring how accepted work finishes (`none`, `in-place`, `branch`, `pr`) and what `accept` or `gate` verifies.
_Avoid_: Finish mode, task mode

## 6. v1 slice and refusals
**Build in v1**: `none`, `in-place`, `branch` (guard-only on `accept`, zero GitHub state).
**Refuse in v1**: `pr` delivery (`GATED`/`merge-intent`/`head-moved`/CI), promotion, live checks (`batch.ts:1285-1331`), `hold all` (`SKILL.md:39`), and automated local merge/rebase.
