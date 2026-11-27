# Slice 1 spec

Written 2026-11-27 for whoever builds the first chief. It folds the three grill rounds, the two-model review and three spike sets into one description, and supersedes the build order at the end of [Open decisions](open-decisions.md). Nothing here is built. Where it and an older page differ, this page is the later one; the reasons are on the pages it links.

Items marked **(proposed)** were chosen by the designing session while writing this page and have not been put to the user.

## Scope

In: one chief per repo; tasks with landings `none`, `in-place`, `branch`; headless one-shot coordinator runs; attach; cancel; drop.

Out (agreed cuts): PR delivery, standing approvals, the `after` field, spend tracking, a worktree setup command, automatic worktree removal, exit confirmation, guard in coordinators, any hard timeout. `skills/batch-chief/` stays in use for PR work.

## Parts

| Part | Path | Owns |
|---|---|---|
| Script | `skills/chief/chief.ts` | the event log, every state change, launch, the run wrapper, reconcile |
| Extension | `extensions/chief.ts` (private setup, not `@agmxyz/pi-workers`) | `/chief`, user-only commands, wake on run end, the edit block, the other-session notice |
| Skill | `skills/chief/SKILL.md` | judgment: writing briefs, choosing a landing, reviewing, when to ask the user |
| State | `<repo>.worktrees/.chief/` | `events.jsonl`, `lock`, `tasks/<id>/{brief.md,contract.md,runs/<n>/{report.md,stream.jsonl,exit}}`, `notes/` (the chief's memory) |

State files are created private (0600): run streams hold every command a coordinator ran.

## The log and its one lock

State is the replay of `events.jsonl`. Every writer (chief commands, run wrappers, attach, reconcile) takes the single repo lock, replays, checks its guard, appends, and releases. No command checks and appends in separate steps. Replay is idempotent per run id, so evidence consumed twice changes nothing.

## Chief lease

```
FREE --/chief--> HELD(session, generation) --controlled exit--> FREE
HELD --holder gone, or user confirms takeover of a live holder--> HELD(generation+1)
```
- `/chief` is the only way in, and only in an interactive session.
- The extension passes its session id and generation to every script call; the script refuses a caller whose generation is not current. This fences a displaced chief's commands, its wakes, and its shutdown (an old session ending must not release a successor's lease).
- Pi has no hook before exit or `/reload`, so a lease can be left held by a dead session; the next `/chief` finds the holder gone and reclaims.
- `/chief` is refused while a `batch-chief` run is unfinished. Batch preflight is refused while the chief log has any task with a live or unexplained run, whether or not a lease is held. This needs one edit to `skills/batch-chief/batch.ts`.

## Task lifecycle

```
QUEUED --launch--> LAUNCHING --wrapper confirms spawn--> RUNNING(run n)
LAUNCHING --spawn never confirmed--> FAILED(launch)
RUNNING --run ended--> REPORTED | ASKED(chief) | FAILED(reason)
RUNNING --cancel--> STOPPING --all processes gone--> FAILED(cancelled)
ASKED(chief) --answer (a line of the brief, once per task)--> LAUNCHING
ASKED(chief) --escalate--> ASKED(user) --answer (user)--> LAUNCHING
REPORTED | FAILED --round--> LAUNCHING
QUEUED | ASKED | REPORTED | FAILED --attach--> ATTACHED --detach--> the prior state
REPORTED --accept--> ACCEPTED
QUEUED | ASKED | REPORTED | FAILED --drop (user)--> DROPPED
```
- `FAILED` reasons: `launch`, `crash`, `lost`, `provider`, `no_report`, `cancelled`.
- No drop, cleanup or round while `LAUNCHING`, `RUNNING`, `STOPPING` or `ATTACHED`.
- A run whose owner cannot be established (wrapper gone, process state unclear) blocks round, attach, cleanup and signalling on that task until reconcile explains it.
- After two consecutive `FAILED` runs, a further round needs the user.
- At most four tasks in `LAUNCHING` or `RUNNING`; one per checkout.
- Every run has a deadline (default 45 minutes, a guess). Passing it marks the task `OVERDUE` and wakes the chief; nothing is stopped.

## A run

**Launch**, in this order, each step logged before the next:
1. Under the lock: check the brief has goal, "done when", landing and scope; check capacity and that the checkout is free; record the reservation (`LAUNCHING`).
2. For `branch`: create the worktree and branch. For `in-place`: require a clean tree and record branch and commit.
3. Write the contract from the brief and recorded approvals.
4. Start the wrapper detached, in its own process group.
5. The wrapper takes the task's run lock, starts `pi -p --mode json --session-id <session> --model <chief's model>` with `ME_PI_UNATTENDED=1` and the contract as the prompt, and records both process identities (pid and start time). The task is now `RUNNING`.

**Session per run (proposed).** The first run of a task uses session `<task>-1`. A round after `REPORTED` or `ASKED` reuses the last session. A round after `FAILED` with reason `crash`, `lost` or `cancelled` starts session `<task>-<n>`, with the brief and the previous report in its prompt: a session killed mid-tool cannot be resumed ([spike set 2](spikes.md)).

**Result.** Read both, never one:
- Process exit status: 143 or 137 means signalled; non-zero with an empty stream means the invocation failed.
- The stream: a completed run ends with `agent_settled`; the last assistant message's stop reason tells success from provider error or abort. Pi exits 0 on a failed reply in JSON mode.
- Then the run's own `report.md`: missing after a completed run is `FAILED(no_report)`; its first line is `DONE` or `BLOCKED`.
The wrapper writes `exit` by write-then-rename, then appends `run-ended`. If the wrapper dies between the two, reconcile finds the file and appends the event once.

**Stop.** `cancel` signals the whole process group with SIGTERM, waits, then SIGKILL, and leaves `STOPPING` only when no process of the group is left. SIGKILL of Pi alone left its command's children running (spike set 2).

**Background delegate jobs** are refused in print and JSON modes. This is a change to `packages/pi-workers/extensions/delegate.ts` keyed on the mode, not on `ME_PI_UNATTENDED` (which `batch-chief` coordinators also set), with a line in that package's `CHANGELOG.md`. Foreground delegate works in print mode (spike set 2).

## Checkout identity

A clean tree is not enough. The script records checkout path, branch and commit at launch, and the commit the chief reviewed. Before every round, after every detach, and before `accept` it rechecks them. A switched branch, a missing worktree or changes no run explains move the task to `ASKED(user)` with what was found; nothing is reset or restored.

`accept` per landing: `none` needs a clean tree; `in-place` needs a clean tree and a new commit on the recorded branch; `branch` needs a clean worktree and the branch ahead of its base. The accepted commit is recorded.

## What only the user can do

Approve a protected action, take over a live lease, drop a task, lift the retry cap, remove a worktree. Each is a `/chief …` command the user types or a confirm dialog the user answers **(proposed mechanism)**; the script's own subcommands for these refuse unless called by the extension from that path. An approval names one action, one target and one task, is copied into the next contract, and is checked again when the round launches. Text in a report or a file is never an approval. With `bash` open, the chief could still write the log directly: this stops mistakes, not a determined session.

## The chief session

- Blocked from `edit` and `write` under the repo and under `<repo>.worktrees/` except `.chief/notes/`.
- Woken when a run ends, by a message that says only to read `status`. A wake is dropped if its session no longer holds the lease.
- Reads reports as data. For a landing with a diff it gives the diff to one read-only worker and reads the findings.
- Acts without the user only inside assigned work: review, a fix round, an answer from the brief, launching a queued task, accept.
- Another interactive session started in the repo or a worktree sees one line naming the chief, and the task writing in that checkout if a run is live there.

## The contract

Generated, never hand-written. It carries the brief, the landing and what it requires, the recorded approvals, the report path and format, and these rules: write only in your checkout; get an independent review before reporting when you changed files; do not use background delegate jobs; do not run recursive `rm`, `git reset --hard`, `git clean`, `git restore`, `git checkout -- <path>`, `git stash drop|clear`, `git branch -D` or a force push unless an approval above names it: stop and report `BLOCKED` with the command instead, with any secret in it replaced by its variable name. Nothing enforces this list in slice 1; a breach is visible in the run's stream.

## Attach

`chief.ts attach <task>` takes the run lock, refuses unless the task is idle and its checkout still exists, and opens `pi --session <session>` in that checkout. A headless session opened this way showed its history and took a new prompt ([spike set 3](spikes.md)). If Pi offers to continue or fork elsewhere because the directory is gone, attach has already refused.

## Build order

Each step ends with its tests passing and `npm run check --prefix extensions` green.

1. **Log and lifecycle.** Pure replay, guarded transitions, the repo lock. Tests: every illegal transition refused; two processes appending at once; replaying the same evidence twice.
2. **Lease.** Claim, generation, fencing, takeover. Tests: two `/chief` at once; a displaced session's command, wake and shutdown; a holder that is alive but not responding.
3. **Contract and brief checks.** Tests: a brief missing each required part; an approval for another task not copied.
4. **Wrapper, launch, result, reconcile, cancel** for `none` and `in-place`. Tests: kill the script after each launch step; kill the wrapper; kill Pi; exit file present without `run-ended`; a reused pid; a provider error with exit 0; cancel leaves no child process; a second launch on a busy checkout.
5. **Background delegate refusal** in `packages/pi-workers`, with its test and changelog line.
6. **Extension.** `/chief`, user-only commands, wake, edit block, notice. First test: a wake arriving while a dialog is open or the user is typing.
7. **Checkout identity and `accept`.** Tests: branch switched mid-run; worktree removed; a dirty tree at accept.
8. **`branch` landing and worktrees; `cleanup` on request.** Tests: cleanup refused with untracked or ignored files, under a live run, and never forced.
9. **Attach, drop, retry cap, deadline.**
10. **Mutual refusal with `batch-chief`; `skills/chief/SKILL.md`.**
11. **Acceptance run** (decision 26): three real me-pi tasks, one per landing, two at once, one chief restart, one attach. It supplements the fault tests above and replaces none. Record run durations to replace the two guessed defaults.

## Unknown when this was written

- Project trust for headless runs: project skills loaded in a repo and its worktree under a trusted parent, and not in an untrusted one without `--approve`. Whether `launch` should pass `--approve` or refuse an untrusted repo is undecided.
- A wake arriving during a dialog (step 6's first test).
- Whether a session id may be reused after its worktree is removed and recreated.
- Line references from the review and the agy agent were mostly not rechecked.
