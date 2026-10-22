---
name: implement-goal
description: Orchestrate a spec, ticketed implementation goal (including a single-ticket goal), or PR workflow using Pi delegate implement jobs; load before the first implement job to track the goal base, sequencing, checks, review, and delivery.
---

# Implement a goal

Use this for a spec, ticketed goal, or PR workflow. Preserve stronger user and repository requirements. This skill does not authorize remote or destructive actions; act only within the user's approval and applicable policy.

## Before the first implement job

1. Read the full spec and every ticket that can affect the goal. Record the goal base SHA before implementation. Commit the agreed spec and tickets before the first job so an implement worker starts from the intended HEAD.
2. Work on a goal branch, not `main` or `master`. If the current tree contains existing work, commit it before dispatch; the worker starts from HEAD and refuses a dirty tree.
3. For each job, name the ticket and spec sections, repo-relative paths, acceptance criteria, and one exact check command. Do not ask the worker to clarify: decide from the agreed spec and list unresolved questions as `BLOCKED`. Agree test seams with the user or take them from the ticket/spec, then identify them in the task as confirmed.
4. Before your own commit that changes two or more files or adds behavior, get a fresh review of `git diff HEAD`: include acceptance criteria, mention checks already run, withhold self-assessment, and do not edit the reviewed files until the review returns.

## Sequence jobs

- Dispatch one implement job per ticket in dependency order; batch only tiny tickets. Use `background: true` for substantial work. Until handback, do not edit, commit, or switch branches in that checkout.
- A handback reports an implement job, not a ticket. A passing handback is sufficient for that job: do not immediately reread its diff, review it, or rerun its check. Ticket closure still follows the ticket's passing-commit criterion, and this does not suppress the later goal-wide review.
- On each passing handback, start the next already-authorized ready job in the same turn. Never report waiting when no job is running and a ready job can start.
- A failed check or interrupted job may leave a `WIP(delegate ...)` commit. Read the handback and details, then continue or revert only as authorized. Report every `BLOCKED` line and tripwire; stop on a tripwire that requires the user's decision.
- For a GitHub tracker, save `gh issue view` output to temp files and pass those paths to the worker. Close no external issue per job. Local ticket status changes belong only in the passing commit for that ticket.

## Claude Code workflow overlay

When adapting a Claude Code skill workflow, run one background implement job per ticket on the goal branch, in dependency order. The goal branch is the integration branch; worktree creation, resets, merges, and cleanup steps do not apply. Use `scout` or general with `output: true` for exploration, then pass its output directory to later jobs. For a code-review workflow, make two `review` calls in one turn: one for repository standards and one for the spec.

## Goal review and delivery

1. Ensure the last implementation or fix job runs the full required suite. Tell reviewers which exact checks passed on the final commit so they do not report those checks as `BLOCKED`.
2. Review `git diff <goal-base>..HEAD` once against both repository standards and the complete spec. If using the `code-review` skill, follow its two-axis review procedure. Do not treat this goal review as a substitute for any separate review required by the repository or user.
3. Make at most one fix job for high- or medium-severity review findings. Report remaining findings, spec ambiguities, and lower-severity items to the user; do not enter a review/fix loop.
4. If the user requested a PR or the tracker workflow requires one, follow the approved timing: after the first passing handback, push and open a draft PR with the relevant `Closes #N`; update it only after a passing handback and mark it ready after goal review. Otherwise, do not create remote artifacts. Remote actions require applicable user authorization.
5. If the goal range contains `WIP(delegate ...)` commits, disclose them in the PR body and recommend squash-merging. Never merge WIP commits unsquashed, and obtain approval for any merge or destructive cleanup.
