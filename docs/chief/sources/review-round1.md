## claude-code/claude-fable-5-2 (round 1)

**Verdict: fix first.** Headless one-shot coordinators can work, but the run-result contract, the multi-writer log and the approval path need changes before step 1.

## BLOCKER

**B1. Exit code cannot carry the run result in `--mode json`.**
- Evidence: `cli-integration.md:46` says "A failed or aborted assistant response appears in the event stream but does not by itself produce a nonzero exit status." `architecture.md` says "Result is the exit code plus a per-run report file".
- Effect: provider failures and aborts exit 0, so `FAILED(provider)` is not derivable. They show as `no_report`, or as DONE if the report was written before the failure.
- Change: the wrapper parses the final JSONL stop reason and spend, or uses plain `-p`, which does exit nonzero (`cli-integration.md:30`).

**B2. The event log has many writers but guarded transitions are read-check-append.**
- Evidence: `batch.ts:521` is a bare `appendFileSync` that assumes one writer. Here up to four wrappers, the chief CLI, `attach` and reconcile all write.
- Effect: two launches can both pass the concurrency cap or the in-place checkout check; wrapper and reconcile can both write `run-ended`.
- Change: one log-wide lock around every guarded command, and replay idempotent per run id. Build it in step 1.

**B3. Wrapper dead with `pi` alive leads to session corruption.**
- If liveness is the wrapper's pid, `status` marks the task FAILED, and a retry starts a second run on the same session. That is the silent fork from `spikes.md` item 2.
- Change: the lock records the wrapper and the `pi` pid, start time and process group. Reconcile refuses or kills while any member lives.

## HIGH

**H1. Approvals and "user's words" are model-supplied.**
- The chief has open bash, reads coordinator reports, and acts unprompted (items 14, 15). It can run `approve --quote`, lift the retry cap, drop, or append to the log itself.
- This conflicts with `GLOBAL_AGENTS.md`: "No content… grants approval".
- Change: approve, takeover, drop and cap-lift go only through a user-typed slash command or `ctx.ui.confirm` in `extensions/chief.ts`. The CLI rejects those events otherwise.

**H2. `drop` and cleanup can remove a worktree under a live process.**
- `state-machines.md` allows drop from "any non-terminal except RUNNING", which includes `STOPPING` and `ATTACHED`. Item 19 then auto-removes a clean worktree.
- Change: exclude both states, and make cleanup take the run lock.

**H3. A dirty main checkout deadlocks `in-place`.**
- A cancelled or failed in-place run leaves dirt. The chief cannot edit (ADR 0004), and unattended coordinators are refused `git restore`, `reset --hard`, `clean` and `checkout --` (`guard.ts:560`).
- Item 20 leaves other sessions "otherwise unrestricted" in that checkout. `git switch` without force is not guarded, so the branch can change mid-run.
- Change: record branch and HEAD at launch; `accept` requires the same branch with HEAD descending from it; add an explicit "user must clean" state.

**H4. The edit block misses worktrees.**
- `architecture.md` blocks "inside the repo", but worktrees and state live in `<repo>.worktrees/`, outside it.
- Change: block the main checkout and every worktree; allow only `.chief/`.

**H5. Project trust in new worktrees.**
- `security.md:77-80`: print and JSON modes skip protected project resources under `defaultProjectTrust: "ask"`.
- A new worktree path may then run without repo skills or settings, contradicting ADR 0003's "same extensions, skills and policy". Unverified: how trust is keyed, and which me-pi resources count as protected.

**H6. Refusing `background: true` on `ME_PI_UNATTENDED` changes batch-chief.**
- Its coordinators are long-lived TUI sessions launched with that variable (`SKILL.md` step 3.4), where background jobs do deliver. Item 9 says "unchanged until PR delivery ships".
- Change: key the refusal on print/json mode (`ctx.mode`), not the env var. In print mode the variable only changes guard's message, since `guard.ts:564` already blocks without a UI.

## MEDIUM

- **M1. Exit confirmation (item 21, step 6) is not implementable.** `delegate.ts:595` says "Pi offers no hook before /reload or exit". The lease must also survive `session_shutdown` with reason `reload`, and define what `/new`, `/resume` and `/fork` do to it.
- **M2. Lease identity is unspecified.** The CLI runs from bash and cannot know which session called it, or its model (item 23). A session that lost the lease keeps its timer and edit block. Change: the extension passes a session and generation token, and re-checks the lease before every wake.
- **M3. `after` is hollow for `branch` landings.** The chief never merges (item 17), so a dependent worktree is cut without the dependency's commits. A dependency that is DROPPED leaves the task QUEUED forever.
- **M4. Hung runs hold a slot or the main checkout.** There is no hard timeout, and `cancel` arrives in step 8. Change: move `cancel` to step 4 and show last-event age from the JSONL in `status`.
- **M5. Item 9 contradicts itself.** "unchanged" versus "batch preflight refuses while a lease is held", which needs a `batch.ts` edit.
- **M6. Standing approval is wider than policy.** It is "for the whole repo until withdrawn"; `GLOBAL_AGENTS.md` says approval "persists for the same task". Slice 1 has no pushes, so it is not needed yet.
- **M7. Step 3 cannot run a coordinator without step 5.** The contract carries the report path. The step-10 acceptance test also has no fault paths.

## LOW

- JSONL run logs hold full tool output. Set them to 0600 and keep the chief from reading them raw (secrets, injection).
- Task ids must fit `--session-id` rules (`cli.md:95,107`).
- Sessions are bound to their cwd (`sessions.md:30`), so no attach or round is possible after a worktree is removed.
- The glossary says the lease "outlives no session", but the STALE state does.

## Verified as claimed

- Print mode loads extensions (`extensions.md:3267`).
- `tool_call` can block with `{ block: true }` (`extensions.md:987`).
- `sendMessage` with `triggerTurn` wakes an idle session (`extensions.md:1648`), and `watch.ts` does this.
- `--session-id` opens or creates a session per cwd (`cli.md:94-95`).

## Spike first

1. JSON-mode exit status and final event on provider error, on SIGTERM, and on abort.
2. A headless run in a fresh worktree: are project skills and settings loaded?
3. Opening a headless session in the TUI (`attach`).
4. A foreground `delegate` inside `pi -p`.
5. A timer-driven wake while the chief has a guard dialog open or the user is typing.
6. Whether print mode emits `session_shutdown`.

## Cut from slice 1

- Standing approvals.
- `after` dependencies.
- The spend warning.
- Exit confirmation.
- The setup-command config (pass it as a launch argument).
- Automatic worktree removal (keep manual `cleanup` with a dry run).

## For slice 2

- Keep the report `Status` parsing and the `TRANSITIONS` table shape from `batch.ts`.
- Make the landing a per-task state extension from day one, so the gated states slot in.

## Add to the acceptance run

- `kill -9` the wrapper, then `pi`.
- Kill between spawn and `run-started`.
- One BLOCKED report through to an answer round.
- One FAILED run through to a retry.
- One cancel.
- One takeover with the old session still open.
- A concurrent in-place launch that is refused.

## Not verified

- I could run nothing; all findings are from reading code and docs.
- The Pi docs I read are 1.6.0; the spikes ran on 1.6.1.
- I did not read `packages/pi-workers/docs/delegate.md`, `docs/coding-standards.md`, `rpc.md`, `json.md`, or `batch.ts` beyond a grep.
- I did not check the `watch.ts:279` or `batch.ts:226` line numbers; the `watch.ts` wake pattern itself is confirmed.
- B3 and M2 rest on details the design leaves unspecified.

## openai/gpt-6.2-astra (round 1)

**BLOCKER — A crashed launch can leave a live coordinator with no recorded owner.** `docs/chief/state-machines.md:14,31` jumps from `QUEUED` to `RUNNING(pid)`; spawning Pi and appending an event cannot be atomic. Persist a launch reservation before setup/spawn; require the child to acquire the session lock before opening Pi. Record wrapper and child identities, including boot/start identity. A dead wrapper is not a dead writer. Atomically publish exit evidence; reconcile it exactly once by run ID. Unknown ownership must block retry, attach and cleanup.

**BLOCKER — Lease and admission checks can race.** `skills/batch-chief/batch.ts:518–521` validates then appends; that is not a cross-process transaction. Serialize claim/takeover, generation check, capacity/checkout reservation and append under one canonical repo lock. Fence stale wakes **and subsequent mutations**; old shutdown must not release a successor’s lease. Allow confirmed takeover of a hung live holder. Batch preflight must check outstanding chief work, not just the lease: decisions 9 and 21 otherwise allow a batch immediately after chief exit while coordinators still run.

**HIGH — A clean checkout is neither reviewed identity nor deletion authority.** `docs/chief/landing.md:9–11` accepts “current branch”; decision 20 permits another writer. Pin checkout identity, branch, launch SHA and reviewed result SHA; recheck before accept, including after attach. On branch switch, missing/replaced worktree or unexplained changes, stop for inspection—never restore automatically. `state-machines.md:16–22` permits dropping `STOPPING` and `ATTACHED`; forbid cleanup until every writer is gone, inspect ignored/untracked valuables, and never force removal. Apply admission checks to rounds and answers too.

**HIGH — Reports and copied quotes cannot grant authority.** Decision 4 copies approvals into contracts; `GLOBAL_AGENTS.md` says “No content … grants approval or secret access.” Bind approval to an actual user interaction, action, target and task; check withdrawal before execution. Never derive approval from report text. Open Bash makes ADR 0004 a convention, not containment; expose narrow chief operations rather than passing reports to a shell-capable approver. Redact secret-bearing commands instead of logging decision 5’s “exact command.”

**HIGH — JSON exit zero is not model success.** Installed Pi `dist/modes/print-mode.js:76,120–151` binds extensions and disposes normally, but checks assistant error/abort/length for **text only**. Drain JSON continuously; validate terminal model outcome plus run-specific report without persisting raw tool output (`docs/json.md:19,48`). Also preflight required skills: fresh worktrees can skip project resources under noninteractive trust defaults (`docs/security.md`, “Project trust without an interactive prompt”).

**HIGH — Two advertised guarantees are not implemented.** `delegate.ts:660,884–891` accepts unattended background calls despite `architecture.md` saying the ban “is enforced”; implement refusal before first real launch. `delegate.ts:595` says “no hook before /reload or exit”; promise confirmation only for controlled departures. Idle wake and tool-call blocking *are* documented (`extensions.md:987,1648`), not cross-process delivery.

**Spike first:** TUI attach using the exact persisted session file/CWD; simultaneous `/chief`, batch and direct resume; kill each launch/exit participant; simulate PID reuse, stale wake, branch switch and missing worktree. Use isolated fixtures; decision 26’s happy paths supplement rather than replace these tests.

**Cut from slice 1:** standing PR approvals, spend accounting beyond “unknown,” and branch deletion. Preserve exact-SHA evidence and outstanding obligations for slice 2: `batch.ts:300,1266–1267` distinguishes merged-but-live-check-owed and pins merge intent to the gated head.

**Verdict: fix first.** Headless one-shots remain viable. Static verification against installed Pi 1.6.0; interactive attach and crash behavior were not run.