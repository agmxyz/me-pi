# Round 5 brief: "core" vs "batch-only / PR mode" (from the Pi agent in w3:p9Y)

Read-only on the repo. Write only /tmp/chief-design/pe9-round5.md (max 450 words), then reply DONE.

How I explained the split to the user:
- Core (every task): user says "do X", a coordinator does it, chief reviews the report and accepts. Ends at ACCEPTED. Assumes no GitHub, PR, or branch; also fits "investigate this" or "fix in place".
- PR mode (I had called it "batch mode only", a bad name: nothing to do with running several tasks): task must ship through a PR. `gate` replaces `accept`: REPORTED -> GATED(sha); GATED -head-moved-> REPORTED; GATED -> MERGED (user approval) | LEFT_OPEN; GATED -round-> RUNNING.
- A task is in one mode or the other, chosen at launch. Build core first; PR-mode steps later let it replace skills/batch-chief.

Questions (cite file:line in skills/batch-chief/{batch.ts,SKILL.md,CONTRACT.md} where you rely on existing behaviour):
1. Is a two-valued "mode" the right abstraction? My alternative: a per-task "finish policy" saying how accepted work lands: `none` (research/answer, no diff), `in-place` (commit on the current branch of the main checkout), `branch` (worktree branch kept, user or chief merges locally), `pr` (gate/merge). Does that also settle the open point from round 4 (who commits/integrates an ACCEPTED task on main vs a worktree)? Which policies need their own states, and which are only guards on `accept`?
2. Fixed at launch, or may a task be promoted (e.g. `branch` -> `pr` after the report)? What breaks if promotion is allowed (contract already written, approvals scope, CONTRACT.md step "push the branch and open the PR")?
3. Does a local-merge policy need the same sha-pinning as GATED (accept pins HEAD; a later commit voids it)? Or is that over-engineering for the core?
4. What in batch-chief is truly BATCH-level (about a set of tasks, not one PR task): preflight, the `current` run pointer, max running rows, overlap ordering, live checks, cleanup, ledger? For each: becomes repo-level chief state, becomes a per-task field, or is dropped.
5. Naming: propose glossary-ready terms for the two layers and the policy field (GLOSSARY.md style: one-line definition + "Avoid").
6. Smallest set of policies for the first slice, and what you would refuse to build in v1.
Say plainly where you disagree with me.
