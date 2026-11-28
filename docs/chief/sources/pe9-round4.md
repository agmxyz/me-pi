## 1. Missing batch-chief states/transitions (`skills/batch-chief/`)
- **`ASKED(chief)` vs `ASKED(user)` + `escalate` + 1-answer cap** (`batch.ts:113,122,238-250,354-357,806-819`): `answer --basis` verifies an exact brief line; a second question forces `escalate`. **Core.**
- **`drop` from `QUEUED`, `RUNNING`, `GATED`** (`batch.ts:286-290`): yours only drops `ASKED|REPORTED|FAILED`. **Core** (`GATED` = **Batch**).
- **`round` (`task|review|fix|update`) + `GATED --round--> RUNNING`** (`batch.ts:73,256-260,1610`): locks contract post-`task` and reopens `GATED`. `round` = **Core**; `GATED` reopen = **Batch**.
- **`GATED(sha)` + `head-moved -> REPORTED`** (`batch.ts:115,261-265,407-411,969-970,1257-1263`): clears gate, intent, and `live-result` (`batch.ts:434`). **Disagree** on `ACCEPTED->GATED->PR_OPEN`: PR opens during `RUNNING` (`CONTRACT.md:66`); `gate` checks it to enter `GATED(sha)` (`batch.ts:1175-1204`). **Batch.**
- **`merge-intent` pending guard** (`batch.ts:124,266-270,1226-1229,1266-1277`). **Batch.**
- **`live-result` (`before-merge|after-merge`, `liveOwed` on `MERGED`)** (`batch.ts:91,281-285,300,1245-1249,1976-1986`). **Batch.**
- **`deadline` / derived `OVERDUE`** (`batch.ts:372-373,1005-1008`, `SKILL.md:81`). **Core.**

## 2. Missing / illegal transitions
- **Cancel `RUNNING`**: illegal in your model. Add `RUNNING --cancel--> STOPPING` (signal + reap) -> `FAILED(cancelled)|DROPPED`; never mark `DROPPED` while a live process writes.
- **Deadline vs timeout**: `deadline` -> derived `OVERDUE` wake (no kill); optional hard timeout kills run -> `FAILED(timeout)`.
- **Exit 0 + stale report**: shared report paths are brittle (`batch.ts:948` mtime check). Use per-run `report-<task>-<runId>.md`; missing file on exit 0 -> `FAILED(no_report)`.
- **`DONE` + dirty/empty diff**: still `RUNNING -> REPORTED` (report is untrusted, `batch.ts:1213-1214`); refuse `accept`/`gate` on dirty tree (`batch.ts:1175-1181`) or disallowed empty diff.
- **`chief.ts attach`**: refuse while `RUNNING` (corrupts session/worktree). From idle, hold `run.lock` (`ATTACHED`) to block spawns until detach.
- **Takeover while `RUNNING`**: **Disagree** with checking chief gen everywhere. Running tasks belong to the repo log: coordinators keep running, exit/report files land, wakes route to the *current* lease holder (not fixed `chiefPane`, `batch.ts:149,1448`), and gen+1 reconciles. Only chief CLI mutations check gen.
- **`ACCEPTED` main vs worktree**: main checkout is already in place (never delete checkout/branch); worktree `ACCEPTED` is unmerged—integrate or keep branch (`batch.ts:1778-1784`), never silently `CLOSED`.

## 3. Stored vs derived Run
**Disagree** with "never stored." Log `run-started(runId,pid,lstart,round,reportPath,deadline)` and `run-ended(runId,exitCode,reason,spend)`. Without `pid+lstart`, PID reuse breaks liveness; without `runId`, you lose attempt counts, retry caps, spend, and stale-report isolation. Only live process state (`ALIVE|EXITED|LOST`) is derived until reconciled.

## 4. `ACCEPTED` and `FAILED`
- **`ACCEPTED` vs `CLOSED`**: **Disagree** with both. Make `ACCEPTED` terminal in core and keep cleanup orthogonal (`batch.ts:93,1957`; no `CLOSED`). Batch replaces `accept` with `gate -> GATED(sha) -> MERGED|LEFT_OPEN`.
- **`FAILED`**: **One state** `FAILED(reason)` (`crash|lost|timeout|provider|no_report|cancelled`)—same outgoing edges. Guard refusals are `BLOCKED->ASKED`, not `FAILED` (`CONTRACT.md:59,80`).

## 5. Dependencies
Add optional `after: TaskId[]` on `QUEUED` (replaces prose-only overlap ordering, `SKILL.md:58`). `launch` refuses until dependencies are terminal (`ACCEPTED|MERGED`), with `--force`. No extra state.

## 6. Corrected Task Machine
- `QUEUED --launch[after done, checkout free]--> RUNNING(task,runId)`
- `RUNNING --run-ended(DONE|BLOCKED|err)--> REPORTED | ASKED(chief) | FAILED(reason)`
- `RUNNING --cancel--> STOPPING --run-ended--> FAILED(cancelled) | DROPPED`
- `ASKED(chief) --answer(basis,cap 1)--> RUNNING`; `--escalate--> ASKED(user)`
- `ASKED(user) --answer(user)--> RUNNING`
- `REPORTED|FAILED --round(fix|review|update)|retry--> RUNNING`
- `ASKED|REPORTED|FAILED --attach--> ATTACHED --detach--> ASKED|REPORTED|FAILED`
- `REPORTED --accept[clean]--> ACCEPTED` *(core terminal; cleanup orthogonal)*
- **Batch**: `REPORTED --gate--> GATED(sha)` | `GATED --head-moved--> REPORTED` | `GATED --round--> RUNNING` | `GATED --merge[intent,live-pass]--> MERGED` | `GATED --leave-open--> LEFT_OPEN` *(+`live-result` on `GATED|MERGED`)*
- `QUEUED|ASKED|REPORTED|FAILED|GATED --drop(user)--> DROPPED`
