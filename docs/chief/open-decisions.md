# Open decisions

As of 2026-11-27 these were the user's to decide, planned for a grill session.

1. How a session becomes chief (command, flag, automatic) and what "promote a coordinator to chief" means.
2. Chief editing: fully blocked, or allowed for its own state, docs, trivial fixes.
3. `in-place`: may a coordinator write in the main checkout, or do writers always get a worktree.
4. Approvals: per task or standing repo-level; how they reach a contract.
5. A coordinator refused by `guard`: chief relays the question, or the user attaches.
6. Retry cap per task and what happens when it is hit. (Pi session suggested escalating after two failed runs.)
7. Limit on concurrently running tasks.
8. Background `delegate` jobs in headless coordinators: forbidden or supported another way.
9. Where state lives (git common dir or `<repo>.worktrees/`); private setup or `@agmxyz/pi-workers`.
10. Whether `batch-chief` coexists unchanged until slice 2.
11. What the chief may answer itself versus must delegate.

## Not verified as of 2026-11-27
- `pi -p --session-id <id>` reopens one session across runs and can later be opened interactively. Read in `pi --help` and `docs/cli.md` of Pi 1.6.0 only; never run. First thing to spike.
- Pi's behaviour when two processes open one session; its docs say nothing.
- That a print-mode exit aborts background delegate jobs (read at `delegate.ts:610`, not run).
- Whether herdr updates a pane's session identity atomically (moot unless a herdr viewer is added).
- The agy agent's file:line references, except `watch.ts:279`, `delegate.ts:610`, and the `batch.ts` transitions for `round`, gating and `drop`.
- Cost estimates (2-3 days for slice 1) are the agy agent's.

### Update 2026-11-27 (spike)
The first three items above were run against Pi 1.6.1; see [Spikes](spikes.md). Session reuse works; two concurrent runs silently fork the session; a background delegate job's answer was unavailable in a later run. Interactive opening of a headless session is still untested.

## Environment improvements noticed
- 2026-11-27: read-only workers cannot run `rg`, so a repo-wide mention sweep was incomplete.
- 2026-11-27: the design discussion ran through `herdr agent prompt`, the dependency the chief is meant to drop.

Related: [Architecture](architecture.md), [State machines](state-machines.md), [Landing](landing.md).

## Settled 2026-11-27 (grill round 1)
The user agreed to all of the following. Items 1-11 above are settled by them; the original wording is kept as asked.

1. **Becoming chief**: only by an explicit `/chief` command in an interactive session; refused while another live session holds the lease unless the user confirms a takeover. A headless run never becomes chief.
2. **Chief editing**: blocked from `edit`/`write` in the repo except `docs/chief/`, `GLOSSARY.md`, `docs/adr/`; no trivial-fix exception; `bash` open under guard. [ADR 0004](../adr/0004-chief-does-not-edit-the-repo.md).
3. **Main checkout**: `in-place` stays; one coordinator at a time, on the current branch, only with a clean tree at launch; anything concurrent gets a worktree.
4. **Approvals**: task approvals and standing approvals. Standing covers only ordinary pushes of a task's own branch and opening its PR. Both recorded in the user's words and copied into the contract at launch; a later approval reaches a coordinator only through a new round.
5. **Guard refusals**: coordinator reports BLOCKED with the exact command; the chief relays; on approval the chief records it and starts a round. The chief never runs the command for the coordinator. Known gap: an unattended guard refuses destructive commands regardless of approval, so those need the user to attach or run them.
6. **Retry cap**: after two consecutive FAILED runs the script refuses a third retry until the user says so. ASKED and review rounds do not count.
7. **Concurrency**: at most four RUNNING tasks per repo, as config.
8. **Location**: state under `<repo>.worktrees/.chief/`; code in the private setup, not `@agmxyz/pi-workers`.
9. **batch-chief**: unchanged until PR delivery ships; `/chief` refuses during an unfinished batch run and batch preflight refuses while a lease is held.
10. **Chief's own work**: answers from the event log, wiki, read-only `git`/`gh`, and small reads; delegates the rest; never runs builds, tests or installs.
11. **Background delegate jobs**: refused in unattended sessions, enforced in `packages/pi-workers` (a user-visible package change), not by contract text alone.
12. **Attach**: takes the task's run lock, refused while a run is live, blocks rounds while held; on exit the task returns to its prior state and the chief re-reads the worktree before trusting the old report.

Architecture recorded as [ADR 0003](../adr/0003-chief-drives-headless-pi-coordinators.md). Terms added to `GLOSSARY.md`: Task, Task lifecycle, Run, Round, Landing, PR delivery, Chief lease, Task approval, Standing approval, Attach.

## Settled 2026-11-27 (grill round 2)
The user agreed to all of the following.

13. **Chief records**: supersedes item 2 of round 1 on the same day. The chief writes nothing in the repo; its working memory lives in the state directory; changes to `GLOSSARY.md`, ADRs or repo docs go through a coordinator task. Reason: `in-place` needs a clean main checkout. ADR 0004 was amended before its first commit.
14. **Who accepts**: the chief accepts `none`, `in-place` and `branch` tasks itself after checking the report against the brief. The user is asked only for a question the brief cannot answer, an approval, the retry cap, a drop, and any merge.
15. **Acting without the user**: on a run ending the chief reviews, starts a fix round, answers from the brief, launches queued tasks whose dependencies are done, and accepts, all within assigned work. It invents no tasks and reports what it did at the next natural point.
16. **Review**: for a landing with a diff, the contract requires the coordinator to get an independent review before reporting; the chief gives the diff to one read-only worker and reads only the findings. For `none` it reads the report.
17. **Merging**: the chief never merges. An accepted `branch` task leaves its branch for the user, or the user asks and the chief launches an `in-place` task that merges, with the user's approval.
18. **Brief minimum**: `launch` refuses a brief without a goal, a "done when" check, the landing, and the files or area in scope. For a vague request the chief asks the user.
19. **Cleanup**: the chief removes a clean worktree after accept or drop on its own. It never deletes a branch with unmerged commits, nor any branch without the user's say-so. A dropped task with uncommitted changes keeps its worktree until the user decides.

Note: this wiki (`docs/chief/`) was written by the designing session before any chief existed; under item 13 a running chief would not write here.

## Settled 2026-11-27 (grill round 3)
The user agreed to all of the following.

20. **Other sessions**: the lease limits who is chief, not who may open Pi. Another interactive session in the repo or its worktrees sees a one-line notice naming the chief and is otherwise unrestricted. The user then asked where such a session works: it is on the branch of the directory it starts in, so a session in the main checkout shares files and branch with a running `in-place` coordinator. Whether the notice should name a live run in that checkout was put to the user the same day (see "Still open").
21. **Chief exit**: coordinators keep running; nobody is woken meanwhile; the next `/chief` reconciles and reports. Leaving with runs live asks for confirmation.
22. **Deadlines**: every run has one, 45 minutes by default (a guess, not measured; 90 since #193, see the [Slice 1 spec](slice-1.md#task-lifecycle)), set per task. Passing it marks `OVERDUE` and wakes the chief; nothing is killed. No automatic hard timeout in slice 1.
23. **Model and spend**: coordinators use the chief session's model unless the brief names another. A per-task spend figure only warns.
24. **Worktree setup**: one setup command per repo in config, run by the script when it creates a worktree; a failure fails the launch.
25. **Policy text**: `GLOBAL_AGENTS.md` unchanged in slice 1; chief rules live in `skills/chief/SKILL.md` and apply only while the lease is held; coordinators get rules from the contract.
26. **Slice 1 done**: three real me-pi tasks reach ACCEPTED, one per landing (`none`, `in-place`, `branch`), two running at once, one chief restart mid-way, one attach. Until then nothing goes in `README.md` or `docs/setup.md`.

## Still open as of 2026-11-27
- Whether the other-session notice names a live run in the same checkout (asked, unanswered).
- Opening a headless coordinator session in the interactive TUI was never run; `attach` depends on it.
- The 45-minute deadline and the cap of four running tasks are unmeasured defaults. (The deadline is 90 minutes since #193, from the build runs' durations; the cap is still unmeasured.)
- An approved destructive command in an unattended coordinator still needs the user to attach or run it.
- PR delivery (slice 2) was not grilled: gate, merge intent, live checks, and retiring `skills/batch-chief/`.
- The agy agent's `file:line` references into `batch.ts`, `guard.ts` and `CONTRACT.md` remain mostly unchecked.

## Slice-1 build order (proposed 2026-11-27)
1. Event log and task lifecycle as a pure replay with guarded transitions, with tests; lifted from the pattern in `skills/batch-chief/batch.ts`.
2. Chief lease: claim, stale detection, takeover, generation check.
3. Run wrapper: per-task run lock, `run-started`/`run-ended`, exit file, per-run report path; `launch` for `none` and `in-place` with the clean-tree check and brief minimum.
4. `status` reconcile, deadline and `OVERDUE`, retry cap, concurrency limit.
5. Contract generation with approvals; refuse `background: true` in unattended sessions (`packages/pi-workers`, with its CHANGELOG line).
6. `extensions/chief.ts`: `/chief`, wake on run end, `edit`/`write` block, other-session notice, exit confirmation.
7. Worktrees: `branch` landing, setup command, cleanup.
8. `attach` (spike the interactive open first), `cancel`, `drop`.
9. Mutual refusal with `batch-chief`; `skills/chief/SKILL.md`.
10. The acceptance run of item 26.

## Settled 2026-11-27 (after round 3)
- **Other-session notice names the writer**: the user agreed that when another session opens in a checkout where a run is live, the notice names the task writing there. This settles the first item of "Still open" above.

## Update 2026-11-27 (second spike set)
See [Spikes](spikes.md). New facts that bear on decisions above: a killed run leaves a session that cannot be resumed (bears on 6, retry); SIGKILL leaves child processes alive; project skills do not load in headless runs without trust; guard was not loaded, so decision 5 and the "known gap" beside it were not exercised; interactive open (decision 12) is still unobserved.

## Settled 2026-11-27 (no guard in slice 1)
The initial slice policy was to run coordinators without guard, superseding decision 5 of round 1. This policy was later reversed; see the [Guard section](slice-1.md#guard) for current behavior.
- Under that policy, a coordinator had no hard stop on destructive commands; the contract's list of commands it must not run, and its instruction to stop and report BLOCKED instead, were the only protection.
- A coordinator reached `ASKED` only by its own report, never by a refusal.
- An approved destructive command could run inside a coordinator in a later round, so the "user must attach or run it" gap was gone.
- A coordinator running a command from the contract's forbidden list, visible in its run log, would have shown that guard was needed.

## Superseded in part, 2026-11-27
The [Slice 1 spec](slice-1.md) is later than this page and differs from it: a launch reservation state, results read from the stream as well as the exit status, a fresh session after a lost run, one repo lock for the log, user-only commands, and the agreed cuts. Reasons: [review](review.md), [spikes](spikes.md).

## Superseded 2026-11-27 (guard in coordinators, #197)
"Settled 2026-11-27 (no guard in slice 1)" above was not what was built, and the user reversed it the same day ([#197](https://github.com/agmxyz/me-pi/issues/197)): a coordinator follows the guard state of the chief session that starts its run, guarded by default, and the contract lists no command. Approvals still do not reach guard, so the "known gap" of decision 5 stands in a guarded run: an approved destructive command needs a run started with guard off. See [Guard](slice-1.md#guard).
