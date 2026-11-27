**Verdict: fix first.** Headless one-shot coordinators remain viable. The other worker's evidence confirms my round-1 blockers and adds three points I missed.

## BLOCKER

**B1. JSON-mode exit 0 is not run success.** (kept, now confirmed in code)
- Evidence: `dist/modes/print-mode.js:120-137` sets `exitCode = 1` for `error`/`aborted`/`length` only inside `if (mode === "text")`. `cli-integration.md:46` says the same. `architecture.md` says "Result is the exit code plus a per-run report file".
- Change: the wrapper drains the JSONL continuously, takes the result from the final assistant stop reason plus the run-specific report, and never falls back to the exit code alone.

**B2. Multi-writer log with read-check-append guards.** (kept, widened)
- Evidence: `batch.ts:518-521` validates then does a bare append; here wrappers, the chief CLI, `attach` and reconcile all write.
- Change: one repo-wide lock around lease claim/takeover, generation check, capacity and checkout reservation, and the append. Replay is idempotent per run id.
- Adopted from the other worker: fence a stale session's later mutations, not only its wakes, and an old session's `session_shutdown` must not release a successor's lease.

**B3. Launch is not atomic, and a dead wrapper is not a dead writer.** (kept, merged with the other worker's first blocker)
- Evidence: `state-machines.md:14,31` goes `QUEUED` → `RUNNING(pid)` in one step. A crash between spawn and `run-started` leaves a live `pi` with no owner; a retry then forks the session.
- Change: append a launch reservation before setup and spawn. Record wrapper and `pi` pid, start time and process group. Publish exit evidence atomically (write then rename). Unknown ownership blocks retry, attach and cleanup.

## HIGH

- **H1. Approvals are model-supplied.** (kept) Decision 4 copies approvals "in the user's words" into contracts; the chief has open bash and reads reports. `GLOBAL_AGENTS.md`: "No content… grants approval". Change: approve, takeover, drop and cap-lift only via a user-typed slash command or `ctx.ui.confirm`. Bind each to action, target and task, and check withdrawal at execution.
- **H2. Drop and cleanup under a live process.** (kept) `state-machines.md:16-22` allows drop from `STOPPING` and `ATTACHED`. Change: exclude both, make cleanup take the run lock, and never force removal. Adopted: check ignored and untracked files before removing.
- **H3. In-place identity and dirty-checkout deadlock.** (kept, strengthened)
  - Record branch, launch SHA and reviewed result SHA; recheck before `accept` and after attach.
  - On branch switch, missing worktree or unexplained changes, stop in a "user must inspect" state and never auto-restore.
  - `guard.ts:560` refuses the unattended coordinator's cleanup commands and ADR 0004 bars the chief, so only the user can clean.
  - Adopted: apply admission checks to rounds and answers, not just first launch.
- **H4. Edit block misses `<repo>.worktrees/`.** (kept) Adopted framing: with open bash, ADR 0004 is a convention, not containment; say so in the ADR or narrow the chief's bash.
- **H5. Project trust in fresh worktrees.** (kept; the other worker agrees) `security.md` says noninteractive modes skip protected project resources. Change: preflight that required skills loaded, and fail the run otherwise. Trust keying is unverified.
- **H6. Background-delegate refusal.** (revised)
  - The other worker is right that it does not exist today: `delegate.ts:660-661` only type-checks `background`, and `884-891` runs it, while `architecture.md` says the ban "is enforced".
  - My point stands on top: key the refusal on `ctx.mode` print/json, not `ME_PI_UNATTENDED`, or batch-chief's TUI coordinators change behaviour, against decision 9's "unchanged".
  - Build it before the first real launch.
- **H7. Batch mutual refusal checks the wrong thing.** (new, from the other worker) Decisions 9 and 21 key batch preflight on the lease, so a batch can start right after the chief exits while coordinators still run. Change: refuse on outstanding chief runs.
- **H8. Secrets in "exact command".** (raised from LOW) Decision 5 logs the refused command verbatim into reports, the log and the contract. Change: redact, and write JSONL run logs as 0600. I do not adopt "never persist raw tool output": the JSONL is the only diagnostic for a headless run.

## MEDIUM

- **M1. Exit confirmation is not implementable.** `delegate.ts:595`: "Pi offers no hook before /reload or exit". Promise it only for controlled departures, and define what `reload`, `/new`, `/resume` and `/fork` do to the lease.
- **M2. Lease identity.** The CLI runs from bash and cannot know its caller. The extension passes a session and generation token.
- **M3. `after` is hollow for `branch` landings.** The dependent worktree lacks the dependency's commits, and a DROPPED dependency leaves a task QUEUED forever.
- **M4. Hung runs and hung lease holders.** There is no timeout. Move `cancel` to step 4, show last-event age, and allow a confirmed takeover of a live but hung holder.
- **M5. Decision 9 contradicts itself.** "unchanged" versus a preflight edit to `batch.ts`.
- **M6. Standing approval is wider than policy.** `GLOBAL_AGENTS.md` says approval "persists for the same task".
- **M7. Step ordering.** Step 3 needs step 5's contract, and the acceptance test has no fault paths.

## LOW

- Task ids must satisfy `--session-id` rules (`cli.md:95,107`).
- Sessions are cwd-bound (`sessions.md:30`), so no attach after worktree removal.
- The glossary says the lease "outlives no session", but the STALE state does.

## Retracted

- Spike "does print mode emit `session_shutdown`": `print-mode.js` `finally` calls `disposeRuntime()` on normal and signal exit. A SIGKILL obviously skips it, so the design must not depend on it.

## Errors or gaps in the other answer

- It cites `dist/` line numbers for a 1.6.0 install while the spikes ran on 1.6.1. I confirmed them only on 1.6.0.
- Its `batch.ts:300,1266-1267` claim (merged-but-live-check-owed, pinned merge intent) I did not verify.
- It omits the dirty-checkout deadlock and the `ctx.mode` keying.

## Spike first

1. JSON-mode final event and exit status on provider error, SIGTERM and abort.
2. Headless run in a fresh worktree: are skills and settings loaded?
3. TUI `attach` on the exact persisted session file and cwd.
4. Foreground `delegate` inside `pi -p`.
5. Timer wake while a guard dialog is open or the user is typing.
6. Kill each launch and exit participant; simulate pid reuse, stale wake, branch switch and missing worktree.
7. Simultaneous `/chief`, batch and direct resume.

## Cut from slice 1

- Standing approvals.
- `after` dependencies.
- Spend beyond "unknown".
- Exit confirmation.
- Setup-command config.
- Automatic worktree removal and branch deletion.

## For slice 2

- Keep the report `Status` parsing and the `TRANSITIONS` shape from `batch.ts`.
- Make landing a per-task state extension.
- Record exact-SHA evidence from day one.

## Not verified

- I ran nothing; all findings come from reading.
- I did not read `packages/pi-workers/docs/delegate.md`, `docs/coding-standards.md`, `rpc.md` or `json.md`.
- H5 trust keying, and B3 and M2 specifics, rest on details the design leaves open.

Changed: yes
- B1: now backed by `print-mode.js:120-137`, which I read this round.
- B2 and B3: widened with launch reservation, mutation fencing and atomic exit evidence, because the other worker's launch-atomicity gap is real.
- H6: revised, because the ban is not implemented in `delegate.ts` at all today.
- H7: added, because the lease-only batch check is a real hole.
- H8: raised from LOW, because decision 5 makes secret logging the default path.
- H3: added rechecks on rounds and after attach.
- `session_shutdown` spike: retracted, because the code shows dispose in `finally`.