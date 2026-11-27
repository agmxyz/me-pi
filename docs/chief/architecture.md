# Architecture

Agreed on 2026-11-27 between the Pi session and the agy agent ([round 3](sources/pe9-round3.md)), after the user required that the chief not depend on herdr and be able to replace `skills/batch-chief/`. Earlier herdr-pane proposals ([round 1](sources/pe9-round1.md), [round 2](sources/pe9-round2.md)) are superseded by this page.

## Shape
- **Chief**: a normal interactive Pi session in any terminal.
- **Private extension `extensions/chief.ts`**: holds the per-repo lease; wakes the chief when a run ends; blocks `edit` and `write` inside the repo while the session is chief. The wake follows `extensions/watch.ts:279` (`pi.sendMessage` with `triggerTurn`), as of `me-pi@8f9a81f`.
- **CLI `chief.ts`**: lock, launch, send, status, approve, attach, cleanup. State is the replay of an append-only event log.
- **Skill `skills/chief/SKILL.md`**: judgment only (sizing, worktree choice, review, escalation).
- **Coordinator**: one detached `pi -p --mode json --session-id <task-id>` process per turn, in the task's checkout or worktree, with `ME_PI_UNATTENDED=1`. Result is the exit code plus a per-run report file.
- **`chief.ts attach <id>`**: opens an idle coordinator session interactively in any terminal (the agy agent's idea).
- herdr or tmux: optional viewer only.

## Failure handling
- Guard dialogs: `ME_PI_UNATTENDED=1` makes guard refuse; the coordinator reports BLOCKED.
- Background `delegate` jobs: a print-mode run ends the session, and `packages/pi-workers/extensions/delegate.ts:610` aborts them on `session_shutdown` (as of `me-pi@8f9a81f`). Proposed: forbid them in headless coordinators.
- Two runs on one session: a per-task `run.lock` with pid and start time.
- Chief dies: each run's wrapper writes an exit file; `status` reconciles on restart.

## Rejected for the first version
- A per-repo daemon owning long-lived `pi --mode rpc` coordinators: one crash kills every coordinator.
- A pi-durable host: see [pi-durable](pi-durable.md).

## Ground it builds on
What `batch-chief` did as of `me-pi@8f9a81f`: [scout report](sources/scout-batch-chief.md). No single-chief lock existed there.

## Update 2026-11-27
The "proposed" ban on background delegate jobs above was decided and is enforced in the package; the run lock was shown to be required by a [spike](spikes.md). State location and the remaining choices are in [Open decisions](open-decisions.md), section "Settled 2026-11-27". Recorded as ADR 0003 and ADR 0004 in `docs/adr/`.

## Superseded in part, 2026-11-27
The [Slice 1 spec](slice-1.md) is later than this page and differs from it: a launch reservation state, results read from the stream as well as the exit status, a fresh session after a lost run, one repo lock for the log, user-only commands, and the agreed cuts. Reasons: [review](review.md), [spikes](spikes.md).

Related: [State machines](state-machines.md), [Landing](landing.md), [Open decisions](open-decisions.md).
