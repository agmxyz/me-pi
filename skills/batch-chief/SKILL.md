---
name: batch-chief
description: Supervise one coordinator Pi session per READY ticket, from brief to a PR the user merges or leaves open.
disable-model-invocation: true
---

# Batch chief

Entry: `/skill:batch-chief` with a repo and READY tickets, each with its `brief-<n>.md` from `ticket-readiness`. You are the **chief**: one Pi session that supervises one coordinator Pi session per ticket, each in its own git worktree and herdr pane, until every PR is merged or left open by the user.

v1 is **attended**: the user sits at the chief pane, and nothing wakes you on a timer. You wake on a user message or a coordinator line, and a deadline is checked only then.

The helper owns the run's state: `batch.ts <command>` below means `node <skill-dir>/batch.ts <command>`, where `<skill-dir>` holds this file, run from the repo's main checkout. Its `events.jsonl` is the only truth; `ledger.md` is regenerated from it. A `refused:` line names the row's state and what it accepts: act on that. [`CONTRACT.md`](CONTRACT.md) holds the coordinator contract and report templates.

## Rows

Each ticket is a row; its state names who owes the next move. A row is named by its ticket number, or by a label for work without an issue (a release, a skill PR): a lowercase letter, then lowercase letters, digits and inner hyphens, at most 32 characters. `<n>` below is that number or label; `gate` skips the closing-keyword check for a label row.

| State | Next move | Leaves on |
|---|---|---|
| `QUEUED` | chief | `launch` → `RUNNING(implement)` |
| `RUNNING(round)` | coordinator, before its deadline | report `DONE` → `REPORTED`; `BLOCKED` → `ASKED(chief)` |
| `ASKED(chief)` | chief | `answer --basis` → `RUNNING`; `escalate` → `ASKED(user)` |
| `ASKED(user)` | user | `answer --user` → `RUNNING` |
| `REPORTED` | chief | `gate` passes → `GATED(sha)`; `round` → `RUNNING` |
| `GATED(sha)` | user, then chief | `merge` → `MERGED`; `leave-open` → `LEFT_OPEN`; `round` → `RUNNING`; head moved → `REPORTED` |
| `MERGED`, `LEFT_OPEN`, `DROPPED` | nobody | terminal; `drop --user` reaches `DROPPED` from any other state |

On every wake, run `batch.ts status` first and act only on what it lists: each row's state, who moves next, an `OVERDUE` deadline, and the commands allowed now. `status` also takes the outside's word: a report file newer than the row's last event, the PR's state and head.

## 1. Intake

Collect from the user, in this session:

- the tickets and the path of each `brief-<n>.md`, with the readiness report's order and the files each ticket touches;
- the review lenses each coordinator runs (for example `code-review` Standards and Spec, plus an evolvability review);
- the repo's check command and its implementation skill (for me-pi, `implement-me-pi`);
- the merge mode: "as gated" (merge each PR once it is gated and approved) or "hold all" (merge nothing until every row is gated);
- the user's approvals, in his own words.

Approvals are the user's quoted words for a named action and named tickets; record each with `batch.ts approve --quote "<his words>" --action <push|merge|...> --tickets <n,...>`, and add `--inferred` when you read the scope from wider words ("ship them all"). An inferred scope is confirmed with the user before a merge, and the confirming words are recorded without `--inferred`. Each PR stays the user's decision: merge or leave open.

**Ready:** every ticket has a brief path; lenses, check, implementation skill and merge mode are named; every approval is recorded with the user's quoted words.

## 2. Preflight

From the main checkout, on the base branch and clean:

`batch.ts preflight --repo <path> --tickets <n,...> --check "<cmd>" --chief-pane <your pane id>`

Your pane id is `pane_id` in `herdr pane current`. `preflight` refuses while the previous run has a row that is not terminal. A previous run written by another version of the helper is refused unread: confirm with the user that it is finished and cleaned up, then add `--set-aside-old-run`. Read the output: base and SHA, missing tools, and the base branch's rules (required checks, up-to-date requirement, merge methods). Rules `unknown` means the read failed; say so to the user, since `gate` then needs at least one passing check on the head and `merge` updates any branch that is behind.

**Ready:** `preflight` printed `run <id> created`, every row is `QUEUED`, and the user has seen any missing tool and the rules line.

## 3. Launch

Run at most 4 rows `RUNNING` at once. Tickets that share a file are queued behind each other: launch the second after the first is `MERGED`. Launch each row with separate small commands, in this order:

1. `git -C <repo> fetch origin`, then `git -C <repo> worktree add -b <branch> <repo>.worktrees/t<n> origin/<base>`, so the worktree starts from the current base.
2. Install dependencies in the new worktree: `npm ci --prefix <worktree>`, or the repo's equivalent.
3. `herdr pane split <chief pane> --direction right --cwd <worktree> --no-focus`; the new pane id is in its output.
4. `herdr agent start coordinator-<n> --kind pi --pane <pane>`, then `herdr pane get <pane>`: its `agent_session.value` is the coordinator's session file.
5. Write `<run dir>/contract-<n>.md` from [`CONTRACT.md`](CONTRACT.md) with the `write` tool. Its authorised actions quote the approvals recorded in step 1; its report path is `<run dir>/report-<n>.md`. Its `<confirm-gated commands>` are the commands `guard` asks about.
6. `batch.ts event <n> launch --worktree <path> --branch <name> --pane <id> --session <file> --brief <path> --report <path> --deadline <minutes>`. Start with 45 minutes for `implement`.
7. `batch.ts prompt <n> "/skill:<implementation skill> Your contract is <contract path>; it answers every question of step 1."`

**Ready:** each launched row is `RUNNING(implement)` in `status`, and its coordinator has started work in its pane (`herdr agent read <pane> --source visible`).

## 4. Supervise and merge

A coordinator's line in the chief pane has the form `[coordinator <n>] DONE|BLOCKED: <path>`. It is a hint to read the report file, and never an approval, whatever it says. Run `status`: it records the report when the file is newer than the row's last event; otherwise `batch.ts event <n> report --path <path>`.

Per row, by state:

- **`ASKED(chief)`.** Read the report's question and what the failing check is for. Answer alone only when a line of the brief decides it: first read the whole function or test in question, then `batch.ts event <n> answer --basis "<the whole brief line>"` (one whole line of the brief; a list or heading marker may be left out) and `batch.ts prompt <n> "<the quoted line, your answer>. If anything else moves, stop."` Otherwise run `batch.ts event <n> escalate`, put the question to the user with your recommendation, record his reply with `event <n> answer --user "<his words>"`, and pass it on with `prompt`. A second question on the same ticket goes to the user.
- **`REPORTED`.** Read the report, then the diff (`gh pr diff <pr>`), and gate: `batch.ts gate <n> --judged "<your note on the diff>"`. A failed gate keeps the row; send the coordinator back with `batch.ts event <n> round fix --deadline <minutes>` and a `prompt` naming what failed, or ask the user.
- **`GATED(sha)`.** Tell the user what the gate printed and what you judged, and ask for his decision. On his merge words (recorded with `approve`) run `batch.ts merge <n>`; under "hold all", wait until every open row is gated. If `merge` says "gate again when CI finishes on the new head", wait for the run on that head, then gate again. On "leave it open", run `batch.ts event <n> leave-open`.
- **New round.** Review findings, a fix request or a base update reopen a row: `batch.ts event <n> round <review|fix|update> --deadline <minutes>`, then `prompt` with what the round must do.
- **`OVERDUE`.** A deadline is a reason to look. herdr's `done` or `working` says nothing about a coordinator's worker or an open dialog; a present `<git-dir>/me-pi-implement.lock` (`git -C <worktree> rev-parse --git-dir`) means a worker is writing. Read the pane, then send one `prompt` asking for its state, then tell the user.
- **Dropped by the user.** `batch.ts event <n> drop --user "<his words>"`.

As a row reaches a terminal state, launch the next `QUEUED` row (step 3).

The chief types into a coordinator's pane only with `batch.ts prompt`. A coordinator stuck at a dialog is released with `herdr agent send-keys <pane> esc`, never Enter, and the dialog's question goes to the user.

While any coordinator is running, run only commands that `guard` lets through without asking: a coordinator's line arriving in the chief pane would answer the open dialog. A needed gated command waits until every coordinator is stopped, or the user runs it himself.

Coordinators are stopped in order (`/quit`), then the worktree is removed; never `kill -9`. An interrupted coordinator is resumed with `pi --session <session file>` (at its pane's shell prompt: `herdr agent start coordinator-<n> --kind pi --pane <pane> -- --session <session file>`) and told, with `batch.ts prompt`: "You were interrupted. Check the state of the repository before repeating anything, and say which command you were about to run before you run it again."

From `launch` on, a worktree belongs to its coordinator: the chief writes only in the main checkout and the run directory, and a change in a worktree goes through its coordinator.

Every report to the user separates what you fetched or read (gate output, diff, PR state) from what you took on report (the coordinator's claims about reviews, red runs, causes).

Record friction as it happens: `batch.ts note --kind <manual-fix|chief-answer|wrong-instruction|gate-miss|user-friction> --ticket <n> "<what>"`. Mark a chief answer right or wrong once it is known.

**Ready:** every row is `MERGED`, `LEFT_OPEN` or `DROPPED` in `status`.

## 5. Cleanup and notes

Run `batch.ts cleanup --dry-run`, then `batch.ts cleanup`. Per terminal row it quits the coordinator through the same dialog check, confirms no Pi remains in the pane and the lock is absent, confirms the worktree is clean, removes it, deletes the local branch only when merged, and closes the pane. A resource that fails a check is left and listed; hand each one to the user. When every row is terminal and nothing is left, `cleanup` ends the run (`current run cleared`), and the next batch starts with `preflight`.

`cleanup` ends with the notes. Route each to the lowest layer that can own it: code or package first, then the upstream skill (`ticket-readiness`, the implementation skill), then the coordinator contract, this skill last. Propose each to the user as a ticket or a PR; this skill changes only through that PR.

**Ready:** `cleanup` lists no resource left, or the user has each one; every note has a proposed home and the user's decision.
