# Round 4 brief: chief state machine (from the Pi agent in w3:p9Y)

Context: design X from round 3 (chief = interactive Pi session + private extension + chief.ts CLI; each coordinator turn = detached `pi -p --mode json --session-id <task-id>` in the task's checkout/worktree; result = exit code + report file). Read-only on the repo. Write only /tmp/chief-design/pe9-round4.md (max 500 words), then reply DONE.

My proposed state machines:

## 1. Chief lease (one per repo)
FREE --claim--> HELD(session, gen) --clean exit--> FREE
HELD --holder dead--> STALE --reclaim (gen+1) | takeover confirmed by user--> HELD
Every script command checks the caller holds the current generation.

## 2. Task (one per piece of assigned work; stored as replay of events.jsonl)
QUEUED --launch--> RUNNING
RUNNING --run ends + report DONE--> REPORTED
RUNNING --run ends + report BLOCKED--> ASKED
RUNNING --run ends, no report / run lost--> FAILED
ASKED | REPORTED | FAILED --answer / rework / retry (new run, same session id)--> RUNNING
ASKED | REPORTED | FAILED --drop--> DROPPED
REPORTED --accept--> ACCEPTED --cleanup--> CLOSED
Owner of the next move: ASKED = chief if the brief answers it, else user; REPORTED = chief (reviews); FAILED = chief (retry or escalate).
Batch mode adds between ACCEPTED and CLOSED: GATED -> PR_OPEN -> MERGED | LEFT_OPEN.
Worktree vs main checkout is a launch parameter; a checkout has at most one RUNNING task.

## 3. Run (one coordinator process per turn; derived from observation, never stored)
SPAWNED -> LIVE -> EXITED(code) [exit file present] | LOST [pid gone, no exit file]
At most one live run per task (run.lock). A run ending is the only thing that moves a task out of RUNNING.

## Rules
- The model never sets a state; it calls guarded commands (like TRANSITIONS in skills/batch-chief/batch.ts:226-291).
- State = replay of the event log; observations (pid, exit file, report file) are reconciled into events by `status`.
- Wakes carry no information ("look"); the chief then reads status.
- Approvals are scoped events copied into the contract at launch, not states.

Compare against the real batch-chief machine (read skills/batch-chief/batch.ts TRANSITIONS and row states, SKILL.md, CONTRACT.md) and answer with file:line:
1. Which states/transitions of batch-chief does my task machine fail to represent? List each, and whether it belongs in the generic core or only in batch mode.
2. Missing transitions or illegal ones in my three machines: cancel/abort of a RUNNING task, deadline/overdue, timeouts, a run that exits 0 with a stale report from a previous run, a report that says DONE with a dirty or empty diff, user attach (`chief.ts attach`) while RUNNING or idle, chief takeover while tasks are RUNNING (who owns them, do their reports still land?), ACCEPTED on main checkout vs on a worktree branch (who integrates?).
3. Is "run is derived, never stored" right, or must spawn be an event (for pid/lstart, attempt counting, retry limits, spend)?
4. Is ACCEPTED worth a separate state from REPORTED? Is FAILED one state or two (crashed vs refused/provider error)?
5. Does a task need a parent/dependency edge (task B waits for A; overlapping files), or is ordering purely chief judgement?
6. Give your corrected task machine as a compact transition list.
Say plainly where you disagree with me.
