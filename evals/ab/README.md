# Coordinator A/B eval

Compares two ways a coordinator runs one real implementation task:

- **Arm A**: `implement-me-pi`, with the `implement` worker doing the edits.
- **Arm B**: `implement-direct` (`skills/implement-direct/`, linked only into arm B's sandbox). The coordinator edits, checks, and commits itself, with read-only `scout` and `general` helpers.

Both arms get the same brief, check, review requirement, and report format, through a contract rendered from `contract.md`. The runner judges each attempt from the worktree and logs it leaves. It does not trust the agent's report.

**Real spend.** Each attempt is a full implementation run with real model calls, often several dollars to tens of dollars. Never run it in `npm run check` or CI. Only the parser, contract, and task validation have hermetic tests (`test/evals-ab.test.ts`).

## Task file

Write a JSON task file outside the repo, for example `~/.local/state/me-pi-evals/tasks/<id>.json`. Do not commit a real one. `task.example.json` shows the shape:

| Field | Meaning |
|---|---|
| `id` | Name used in attempt ids and the record file |
| `repo` | Absolute path of the target git repository. It is cloned with no remote and never modified |
| `base` | Commit SHA each worktree starts from. It is also the fixed review point |
| `branch` | Branch created at `base` in each worktree |
| `brief` | Absolute path of the brief. It is copied into each attempt |
| `check` | The exact check command. The coordinator runs it, and the runner re-runs it on the final HEAD |
| `setup` | Commands run in the worktree, with the sandbox env, before Pi starts (e.g. `["npm ci"]`) |
| `coordinator` | `{provider, model, thinking}` for the coordinator |
| `pool` | The sandbox's `delegate.json` (version 3) |
| `reference` | Optional SHA of a known-good result. It is fetched only after the session, so the agent never sees it |
| `baseline` | Optional free-form object, copied into every record |

## Run

Credentials work as in [`../README.md`](../README.md#credentials): use a dedicated eval login outside `~/.pi`.

```sh
node evals/ab.ts --task ~/.local/state/me-pi-evals/tasks/x.json --dry-run          # no credentials, no model calls
node evals/ab.ts --task <file> --auth <file> --skill ~/.agents/skills/code-review   # A1, B1
node evals/ab.ts --task <file> --auth <file> --skill <dir> --n 3 --arm B             # three arm-B runs
```

`--dry-run` builds one sandbox per arm, prepares the worktree (runs `setup`), writes the contract, starts Pi, and checks that the startup screen lists the arm's skill and `delegate.ts`. It then prints the contract path. With `--keep`, the roots stay for inspection.

| Option | Default | Meaning |
|---|---|---|
| `--task` | required | The task file |
| `--arm` | both | `A` or `B`; repeat for both. Attempts interleave A1, B1, A2, B2… |
| `--n` | 1 | Attempts per arm |
| `--jobs` | 2 | Attempts in parallel |
| `--auth` | required unless `--dry-run` | The eval credential file |
| `--skill`, `--extension`, `--package` | none, none, `npm:pi-web-access@0.46.0` | As in `run.ts`. Arms need `code-review` for the review step |
| `--cap` | 25 | Hard cap in USD per attempt. Also passed as `ME_PI_SPEND_BUDGET_USD` |
| `--timeout-min` | 120 | Wall-clock limit per attempt. It is also `PI_LIVE_TIMEOUT`, and the limit for the setup and re-check commands |
| `--out` | `~/.local/state/me-pi-evals/ab-<id>-<sweep>.jsonl` | Record file, mode 0600. Patches go to the same path without `.jsonl` |
| `--root`, `--keep` | OS temp, off | Where sandboxes go, and whether to keep them |

Both arms' coordinators run with `ME_PI_UNATTENDED=1`. Nobody answers a dialog, so guard refuses risky commands instead of waiting.

**The cap is the runner's.** Every 20 s the runner parses the session log for coordinator cost plus worker cost. When the total reaches `--cap`, it kills Pi (`pi-live.sh stop`) and marks the attempt `capped`. Costs are Pi's estimates, not the provider's counter. A worker's cost reaches the log only when its job finishes, so one running job can overshoot the cap.

The run prints one line per attempt. Then it prints a table per arm: attempts, completed, check green on the final HEAD, and the medians of total cost, wall time, and compactions. It warns if the live `~/.pi/agent` changed during the run.

## Records

Each JSONL record holds:

- `attempt`, `arm`, `n`, `task`, `repo`, `base`, `branch`, `reference`, `baseline`. Also `commit` (the me-pi HEAD under test), the Pi, node and OS versions, `coordinator`, `skill`, and `hashes` of the pool, brief, contract, and extra skills, extensions, and packages.
- `state`: `completed`, `capped`, `timeout`, `incomplete` (start failure, account stop, or no session log), or `void` (`STOPPED: infra`). `note` gives the reason.
- `wallMs`: from Pi's start to its stop.
- `head`, `commits` (`base..head`), and `clean` (no uncommitted changes in the worktree).
- `check`: the runner's own re-run on `head`, with `exit`, `ms`, `timedOut`, and an output `tail`. It runs in the worktree when that is clean. Otherwise it runs in a fresh clone of `head` after `setup` (`where: "clone"`).
- `diffstat` (`base..head`) and `diffVsReference` (`reference..head`, when given), as files, insertions, and deletions.
- `report`: whether the report exists, and its Status (`DONE`, `BLOCKED`, or `unknown`). A copy of the report is saved next to the patch.
- `cost`: coordinator, worker, and total spend (Pi estimates). `workerCostByRole` and `delegateCalls` break worker spend and delegate calls down by role.
- `compactions`: session entries of type `compaction`.
- `blocked`: tool results that begin with `BLOCKED` or a guard denial.
- `patch`: path of `diff.patch` (`base..head`), saved for blind review.

Records and patches stay outside the repo. Post only summary tables.
