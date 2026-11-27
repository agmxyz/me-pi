# Always-On Chief Design (Round 3)

## 1. `@earendil-works/pi-durable` Verdict: **No**
1. **Wrong runtime layer:** Built on `pi-ai` and `chord` (`README.md:7,94-105`) with its own extension/registry model (`README.md:102-104`), not `pi-coding-agent`—so `guard`, `delegate`, skills, `AGENTS.md`, and Pi's TUI don't load. Building a daemon + UI on an experimental API that "changes without notice" (`README.md:3`) is pure churn.
2. **No cross-process locking:** "One process writes a storage at a time; there is no cross-process locking" (`README.md:1051`, `README.md:127`). You still must build the daemon, lock, and client yourself.

## 2. X, Y, Z: Worst Failure Mode & Loss vs `batch-chief`
- **X (detached `pi -p --mode json --session-id`):** *Worst:* mid-turn crash leaves partial state and kills background `delegate` jobs (`delegate.ts:610-615`); concurrent runs on one `--session-id` corrupt the session. *Loses:* live mid-turn pane typing/observation (`SKILL.md:68,89`, `CONTRACT.md:60-61`).
- **Y (per-repo daemon + `pi --mode rpc`):** *Worst:* daemon crash/upgrade kills every active coordinator at once, plus socket/daemon lifecycle bugs. *Loses:* `batch-chief`'s zero-daemon simplicity and interactive pane intervention.
- **Z (`pi-durable` daemon):** *Worst:* breaking API churn (`README.md:3`) and policy drift from `pi-coding-agent`. *Loses:* the entire Pi extension/skill ecosystem.

## 3. What Breaks in X & Mechanisms
- **Guard dialogs (`guard.ts:560-564`):** Safe already—`ME_PI_UNATTENDED=1` and `!ctx.hasUI` refuse immediately; coordinator reports `BLOCKED` (`CONTRACT.md:59`).
- **Background `delegate` jobs (`delegate.ts:610-615`):** `pi -p` exits at turn end, firing `session_shutdown` and aborting them. Mechanism: forbid `background: true` in headless coordinators (foreground `delegate` already runs parallel `runs`); refuse it when `ME_PI_UNATTENDED=1`.
- **Two runs on one `--session-id`:** Atomic `O_CREAT|O_EXCL` per-task `run.lock` with `{pid, lstart}`, checked via `ps` `lstart` (`extensions/watch.ts:232-234`) before spawn and removed by a wrapper on exit.
- **Orphans after chief dies:** Wrapper writes an `exit` file (`watch.ts:233,350-355`). On restart, `chief.ts status` checks `run.lock` PID/`lstart` + `exit` + `report.md` + `ME_PI_STATUS_LOG`, reconciling finished runs and re-watching live PIDs (`watch.ts:307-311`).

## 4. Pick, Disagreements & First Slice
**Pick: X.** I disagree with keeping Y for v1 (shared daemon = shared blast radius) and with supporting `background: true` delegate jobs in headless mode (forbid them).
**First slice:** `chief.ts` (`lock`, `launch` with worktree + `run.lock` + wrapper, `send` follow-up on `--session-id`, `status`, `approve`, `cleanup`) + thin private `extensions/chief.ts` (30s poll → `pi.sendMessage` wake + `edit`/`write` block in `<repo>`). Port `gate`/`merge`/`live` from `batch.ts` second to retire `batch-chief`.

## 5. Unlisted Idea: Terminal-Agnostic `chief.ts attach <id>`
When a coordinator is `BLOCKED`/stuck, the user runs `chief.ts attach <id>` in *any* terminal: it verifies `run.lock` is idle (or stops cleanly), holds the lock, and execs interactive `pi --session <id>` in the worktree; on exit it releases the lock and reconciles state. That restores `batch-chief`'s human-in-pane escape hatch without herdr/tmux.
