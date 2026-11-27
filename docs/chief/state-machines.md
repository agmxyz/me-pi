# State machines

First sketch by the Pi session on 2026-11-27; corrected the same day by the agy agent against `skills/batch-chief/batch.ts` at `me-pi@8f9a81f` ([round 4](sources/pe9-round4.md)). The corrected version is recorded here.

## Chief lease (one per repo)
```
FREE --claim--> HELD(session, generation) --clean exit--> FREE
HELD --holder dead--> STALE --reclaim (generation+1) | takeover confirmed by user--> HELD
```
Only the chief's own commands check the generation. Tasks belong to the repo log, so a takeover does not orphan running tasks: coordinators keep running and wakes go to the current holder.

## Task lifecycle
```
QUEUED --launch [deps done, checkout free]--> RUNNING(runId)
RUNNING --run-ended--> REPORTED | ASKED(chief) | FAILED(reason)
RUNNING --cancel--> STOPPING --run-ended--> FAILED(cancelled) | DROPPED
ASKED(chief) --answer (brief line, once)--> RUNNING
ASKED(chief) --escalate--> ASKED(user) --answer (user's words)--> RUNNING
REPORTED | FAILED --round (fix|review|update) / retry--> RUNNING
ASKED | REPORTED | FAILED --attach--> ATTACHED --detach--> back
REPORTED --accept [clean tree]--> ACCEPTED   (terminal)
any non-terminal except RUNNING --drop (user's words)--> DROPPED
```
- `FAILED` reasons: crash, lost, timeout, provider, no_report, cancelled. A guard refusal is a BLOCKED report and goes to `ASKED`.
- A deadline never kills: it shows `OVERDUE` and wakes the chief. An optional hard timeout kills and gives `FAILED(timeout)`.
- A report is a claim: DONE with a dirty tree still reaches `REPORTED`, and `accept` refuses it.
- Optional `after: [task ids]` makes `launch` wait for dependencies.
- No `CLOSED` state; cleanup is a separate command.

## Runs
Logged as `run-started` (run id, pid, start time, report path, deadline) and `run-ended` (exit code, reason, spend). Only liveness is derived. Each run has its own report file; exit 0 with no file is `FAILED(no_report)`.

## Rules
- The model never sets a state; it calls guarded commands, as `TRANSITIONS` did at `batch.ts:226` (`me-pi@8f9a81f`).
- Wakes carry no information; the chief reads `status`.
- Approvals are scoped events copied into the contract at launch.

## Superseded in part, 2026-11-27
The [Slice 1 spec](slice-1.md) is later than this page and differs from it: a launch reservation state, results read from the stream as well as the exit status, a fresh session after a lost run, one repo lock for the log, user-only commands, and the agreed cuts. Reasons: [review](review.md), [spikes](spikes.md).

PR-only states are on [Landing](landing.md). Undecided points are on [Open decisions](open-decisions.md).
