# Coordinator A/B eval

Compares two ways a coordinator runs one real implementation task:

- **Arm A**: `implement-me-pi`, with the `implement` worker doing the edits.
- **Arm B**: `implement-direct` (`skills/implement-direct/`, linked only into arm B's sandbox). The coordinator edits, checks, and commits itself, with read-only `scout` and `general` helpers.

Both arms get the same brief, check, review requirement, and report format, through a contract rendered from `contract.md`. The runner judges each attempt from the worktree and logs it leaves. It does not trust the agent's report.

**Real spend.** Each attempt is a full implementation run with real model calls, often several dollars to tens of dollars. Never run it in `npm run check` or CI. Hermetic tests (`test/evals-ab.test.ts`) cover the cost parser, the final-state rules, the cost median, the coordinator env, the process sweep, the contract, and task validation. The tmux and model paths are tested only by real runs.

## Task file

Write a JSON task file outside the repo, for example `~/.local/state/me-pi-evals/tasks/<id>.json`. Do not commit a real one. `task.example.json` shows the shape:

| Field | Meaning |
|---|---|
| `id` | Name used in attempt ids and the record file |
| `repo` | Absolute path of the target git repository. It is cloned with no remote and never modified |
| `base` | Commit SHA each worktree starts from. It is also the fixed review point |
| `branch` | Branch created at `base` in each worktree |
| `brief` | Absolute path of the brief. It is copied into each attempt |
| `check` | The exact check command. The coordinator runs it, and the runner re-runs it on the final HEAD, in the worktree and in a fresh clone |
| `setup` | Commands run in the worktree, with the sandbox env, before Pi starts (e.g. `["npm ci"]`) |
| `coordinator` | `{provider, model, thinking}` for the coordinator |
| `pool` | The sandbox's `delegate.json` (version 3) |
| `reference` | Optional SHA of a known-good result. It is fetched only after the session, so the agent never sees it |
| `baseline` | Optional free-form object, copied into every record |

## Run

Credentials work as in [`../README.md`](../README.md#credentials): use a dedicated eval login outside `~/.pi`. Every attempt links the same `--auth` file. If an OAuth token is refreshed while attempts run in parallel, two Pis may race to rotate it and one may be logged out. The runner refreshes the login once before the first attempt, but a run can outlast the token. So `--jobs` defaults to 1. Raise it only with an API-key login, or accept that risk.

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
| `--jobs` | 1 | Attempts in parallel. See the OAuth race above |
| `--auth` | required unless `--dry-run` | The eval credential file |
| `--skill`, `--extension`, `--package` | none, none, `npm:pi-web-access@0.46.0` | As in `run.ts`. Arms need `code-review` for the review step |
| `--cap` | 25 | Hard cap in USD per attempt. Also passed as `ME_PI_SPEND_BUDGET_USD` |
| `--timeout-min` | 120 | Wall-clock limit per attempt. It is also `PI_LIVE_TIMEOUT`, and the limit for the setup and re-check commands |
| `--out` | `~/.local/state/me-pi-evals/ab-<id>-<sweep>.jsonl` | Record file, mode 0600. Patches go to the same path without `.jsonl` |
| `--root`, `--keep` | OS temp, off | Where sandboxes go, and whether to keep them |

Both arms' coordinators run with `ME_PI_UNATTENDED=1`. Nobody answers a dialog, so guard refuses risky commands instead of waiting.

**Credentials in the sandbox.** Pi runs under `env -i` with the sandbox env, so it inherits no `GH_TOKEN` or `GITHUB_TOKEN`. OpenSSH reads `~/.ssh` from the passwd home, not `$HOME`. So the coordinator gets `GIT_SSH_COMMAND=ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes` and `GIT_TERMINAL_PROMPT=0`: git can reach no remote with your keys and cannot prompt.

**The cap is the runner's.** Every 20 s the runner parses the session log for coordinator cost plus worker cost. When the total reaches `--cap`, it stops Pi and marks the attempt `capped`. Costs are Pi's estimates, not the provider's counter. A worker's cost reaches the log only when its job finishes, so one running job can overshoot the cap. If no session log exists 3 minutes after the prompt, the cap would be blind, so the runner stops the attempt as `incomplete` (`no session log`).

**Stopping stops everything.** Every stop (cap, timeout, normal end, error, `--dry-run`) goes the same way. The runner records the tmux pane's pid when Pi starts. On stop it kills the tmux session, then waits up to 20 s for every process whose command line contains the attempt's sandbox root (`pgrep -f`), and the pane's pid, to exit. Delegate workers run in their own process groups, so killing the session does not reach them. The runner SIGTERMs whatever is left, then SIGKILLs it, and checks again. The count it had to signal is the record's `orphansKilled`. Only then does it read HEAD, status, and the check, so an implement worker's shutdown WIP commit cannot race the measurement. A root with a process that survived SIGKILL is never deleted.

**Ctrl-C and errors.** On SIGINT or SIGTERM the runner halts every started attempt the same way, kills running setup and check commands, removes sockets and roots, and exits with 130 or 143. If one attempt throws (e.g. `setup` fails), no new attempt starts. The attempts already running finish and are recorded, then the runner exits with the error. Sockets and roots are removed only after every started Pi is halted.

The run prints one line per attempt. Then it prints a table per arm: attempts, completed, check green in the fresh clone (`checkFresh`), median total cost, and the medians of wall time and compactions. The cost median covers only `completed` attempts whose cost is fully known (`source: "pi-estimate"`). The cell shows how many attempts it left out, so unknown or partial costs never count as $0. The runner warns if the live `~/.pi/agent` changed during the run.

## Records

Each JSONL record holds:

- `attempt`, `arm`, `n`, `task`, `repo`, `base`, `branch`, `reference`, `baseline`. Also `commit` (the me-pi HEAD under test), the Pi, node and OS versions, `coordinator`, `skill`, and `hashes` of the pool, brief, contract, and extra skills, extensions, and packages.
- `state`: `completed`, `capped`, `timeout`, `incomplete` (start failure, account stop, or no session log), or `void` (`STOPPED: infra`, or an arm-B attempt that called `delegate` with role `implement`: note `arm B used implement`). `note` gives the reason.
- `wallMs`: from Pi's start until every process of the attempt has exited.
- `orphansKilled`: how many processes of the attempt were still alive 20 s after the tmux session was killed and had to be signalled.
- `head`, `commits` (`base..head`), and `clean` (no uncommitted changes in the worktree).
- `ignoredLeftovers`: lines of `git clean -ndX` in the worktree, i.e. ignored files the agent left behind.
- `checkInWorktree`: the runner's own re-run of the check in the worktree as the agent left it, with `exit`, `ms`, `timedOut`, and an output `tail`.
- `checkFresh`: the same check in a fresh remote-less clone of `head` after `setup`. Leftover build output cannot make it pass. A failed setup command is named in `setupFailed`. The summary's "check green" uses this.
- `diffstat` (`base..head`) and `diffVsReference` (`reference..head`, when given), as files, insertions, and deletions.
- `report`: whether the report exists, and its Status (`DONE`, `BLOCKED`, or `unknown`). A copy of the report is saved next to the patch.
- `cost`: coordinator spend (the coordinator's own usage), worker spend, and total (Pi estimates). `source` is `pi-estimate`, `partial`, or `unavailable` (no session log). `partial` means a delegate call or background job started but its result never reached the log, usually a job killed at shutdown; `pending` lists them (`bgN` or tool-call ids), and worker and total are lower bounds. `workerCostByRole` and `delegateCalls` break worker spend and delegate calls down by role.
- `implementWorkerSeconds`: the summed run time (`details.view.runs[].ms`) of finished implement jobs, so the work arm A hands off is visible next to `wallMs`.
- `compactions`: session entries of type `compaction`. Coordinator only: workers run with `--no-session`, so their compactions are not logged.
- `blocked`: tool results that begin with `BLOCKED` or a guard denial. Coordinator only, as above. So arm A, which hands context and commands to workers, scores lower on both by design.
- `patch`: path of `diff.patch` (`base..head`), saved for blind review.

Records and patches stay outside the repo. Post only summary tables.
