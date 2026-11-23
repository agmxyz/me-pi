# Coordinator A/B eval

Compares two ways a coordinator runs real implementation tasks:

- **Arm A**: `implement-me-pi`, with the `implement` worker doing the edits.
- **Arm B**: `implement-direct` (`evals/ab/skills/implement-direct/`, linked only into arm B's sandbox). The coordinator edits, checks, and commits itself, with read-only `scout` and `general` helpers.

**Arm A no longer exists as recorded.** `@agmxyz/pi-workers` 0.3.0 removed the `implement` role, and `implement-me-pi` now writes directly, so on this checkout both arms run a writing coordinator. The comparison and its evidence are in [ADR 0001](../../docs/adr/0001-coordinators-write-no-implement-worker.md); to re-run it as recorded, run the runner from a commit before 0.3.0.

Both arms get the same brief, check, review requirement, and report format, through a contract rendered from `contract.md`. The runner judges each attempt from the worktree and logs it leaves. It does not trust the agent's report.

**Real spend.** Each attempt is a full implementation run with real model calls, often several dollars to tens of dollars. Never run it in `npm run check` or CI. Hermetic tests (`test/evals-ab.test.ts`) cover the cost parser, the final-state rules, the cost median, acceptance, synthetic pass scoring, the synth target build, the per-coordinator pool, the summary table, the attempt queue and resume, the sleep-gap clock, the coordinator env, the process sweep, the contract, and task validation; `test/evals-sandbox.test.ts` covers the sandbox's short TMPDIR and its clone without `evals/synth`, in the tree or in git's objects. The tmux and model paths are tested only by real runs.

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
| `coordinators` | Instead of `coordinator`: a list of `{provider, model, thinking}`. Each attempt runs one; its pool is `pool` (default `evals/pools/codex.json`) with `scout` and `worker` both set to that coordinator's model and thinking, so the skill lists stay |
| `reference` | Optional SHA of a known-good result. It is fetched only after the session, so the agent never sees it |
| `baseline` | Optional free-form object, copied into every record |

## Run

Credentials work as in [`../README.md`](../README.md#credentials): use a dedicated eval login outside `~/.pi`. Every attempt links the same `--auth` file. If an OAuth token is refreshed while attempts run in parallel, two Pis may race to rotate it and one may be logged out. The runner refreshes the login once before the first attempt, but a run can outlast the token. So `--jobs` defaults to 1. Raise it only with an API-key login, or accept that risk.

```sh
node evals/ab.ts --task ~/.local/state/me-pi-evals/tasks/x.json --dry-run          # no credentials, no model calls
node evals/ab.ts --task <file> --auth <file> --skill ~/.agents/skills/code-review   # A1, B1
node evals/ab.ts --task <file> --auth <file> --skill <dir> --n 3 --arm B             # three arm-B runs
node evals/ab.ts --task <t1> --task <t2> --auth <file> --skill <dir> --n 2           # t1 A1, t1 B1, t2 A1, t2 B1, t1 A2…
node evals/ab.ts --task <t1> --task <t2> --auth <file> --skill <dir> --n 2 --resume <records.jsonl>
```

`--dry-run` builds one sandbox per attempt (task × coordinator × arm, so 28 for the synthetic suite), prepares the worktree (runs `setup`), writes the contract, starts Pi, and checks that the startup screen lists the arm's skill and `delegate.ts`. It then prints the contract path. With `--keep`, the roots stay for inspection.

| Option | Default | Meaning |
|---|---|---|
| `--task` | `--task` or `--tasks` required | A task file; repeat for several tasks (ids must differ). Attempts interleave: for each n, each coordinator, each task, each arm |
| `--tasks` | | A JSON array of task entries (e.g. `evals/synth/tasks.json`), added to the `--task` ones |
| `--arm` | both | `A` or `B`; repeat for both. Attempts interleave A1, B1, A2, B2… |
| `--n` | 1 | Attempts per task and arm |
| `--jobs` | 1 | Attempts in parallel. See the OAuth race above |
| `--auth` | required unless `--dry-run` | The eval credential file |
| `--skill`, `--extension`, `--package` | none, none, `npm:pi-web-access@0.46.0` | As in `run.ts`. Arms need `code-review` for the review step |
| `--cap` | 25 | Hard cap in USD per attempt. Also passed as `ME_PI_SPEND_BUDGET_USD` |
| `--timeout-min` | 120 | Active-time limit per attempt (see sleep below). It is also `PI_LIVE_TIMEOUT`, and the limit for the setup and re-check commands |
| `--out` | `~/.local/state/me-pi-evals/ab-<id>-<sweep>.jsonl`, or `ab-multi-<sweep>.jsonl` with several tasks | Record file, mode 0600. Patches go to the same path without `.jsonl` |
| `--resume` | none | A record file from an interrupted sweep. Attempts (task, coordinator, arm, n) it already holds as `completed`, `capped`, or `void` are skipped; `timeout` and `incomplete` ones run again. New records are appended to it, and `--out`, if given, must name the same file. Pass the same `--task`, `--tasks`, `--arm`, and `--n` as before |
| `--root`, `--keep` | OS temp, off | Where sandboxes go, and whether to keep them (with their TMPDIRs) |

**Short TMPDIR.** Each sandbox's `TMPDIR` is its own `/tmp/mpe-XXXXXX`, not a directory under the sandbox root: under the OS temp dir it would be about 70 bytes, too long for the Unix sockets a target's tests create there (macOS caps socket paths near 104 bytes, so `listen` fails with `EINVAL`). It belongs to the sandbox: the sweep below also looks for processes in it, and it is removed with the root.

**No sleep.** On macOS the runner runs `caffeinate -i -s -w <runner pid>` for the whole sweep (`-s` also blocks system sleep on AC power) and kills it at exit; without `caffeinate` it warns and goes on. If the machine sleeps anyway, the timeout counts active time only: when a 20 s watchdog tick comes more than 60 s after the previous one, the gap is added to the record's `suspendedMs` and the deadline moves by it.

Both arms' coordinators run with `ME_PI_UNATTENDED=1`. Nobody answers a dialog, so guard refuses risky commands instead of waiting.

**Credentials in the sandbox.** Pi runs under `env -i` with the sandbox env, so it inherits no `GH_TOKEN` or `GITHUB_TOKEN`. OpenSSH reads `~/.ssh` from the passwd home, not `$HOME`. So the coordinator gets `protocol.ssh.allow=never` (through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`) and `GIT_TERMINAL_PROMPT=0`: git refuses every ssh remote (`fatal: transport 'ssh' not allowed`) and cannot prompt. The runner sets no `GIT_SSH_COMMAND`: a target's own tests may assert it is unset, and piops' did, failing its check in every attempt of the first multi-task sweep.

**The cap is the runner's.** Every 20 s the runner parses the session log for coordinator cost plus worker cost. When the total reaches `--cap`, it stops Pi and marks the attempt `capped`. Costs are Pi's estimates, not the provider's counter. A worker's cost reaches the log only when its job finishes, so one running job can overshoot the cap. If no session log exists 3 minutes after the prompt, the cap would be blind, so the runner stops the attempt as `incomplete` (`no session log`).

**Stopping stops everything.** Every stop (cap, timeout, normal end, error, `--dry-run`) goes the same way. The runner records the tmux pane's pid when Pi starts. On stop it kills the tmux session, then waits up to 20 s for every process whose command line contains the attempt's sandbox root or TMPDIR (`pgrep -f`), or whose working directory is inside one (`lsof`), and the pane's pid, to exit. Delegate workers run in their own process groups, so killing the session does not reach them. The runner SIGTERMs whatever is left, then SIGKILLs it, and checks again. The count it had to signal is the record's `orphansKilled`. Only then does it read HEAD, status, and the check, so an implement worker's shutdown WIP commit cannot race the measurement. A root with a process that survived SIGKILL is never deleted.

**Ctrl-C and errors.** On SIGINT or SIGTERM the runner halts every started attempt the same way, kills running setup and check commands, removes sockets and roots, and exits with 130 or 143. If one attempt throws (e.g. `setup` fails), no new attempt starts. The attempts already running finish and are recorded, then the runner exits with the error. Sockets and roots are removed only after every started Pi is halted.

The run prints one line per attempt. Then it prints a table with a row per coordinator, task, and arm, a total row per coordinator and arm when there are several tasks, and an `all` row per arm when there are several coordinators: attempts, completed, check green in the fresh clone (`checkFresh`), accepted, pass (synthetic tasks; `–` otherwise), median total cost, and the medians of wall time and compactions. With `--resume` the table covers the earlier records too; a re-run attempt replaces its earlier record. The cost median covers only `completed` attempts whose cost is fully known (`source: "pi-estimate"`). The cell shows how many attempts it left out, so unknown or partial costs never count as $0. The runner warns if the live `~/.pi/agent` changed during the run.

## Synthetic suite

`evals/synth/` holds a TypeScript fixture repo (`fixture/`) and tasks under `tasks/<id>/`: `brief.md` (the only part an agent sees), `meta.json` (`expect`: `done` or `blocked`, and `blockedKeywords` for `blocked`), `hidden/*.test.ts`, an optional `base/` overlay, and `reference/` (a known-good result; a `blocked` task has none, its base is the reference). `evals/synth/verify.sh <tasks-dir> <id>` checks one task's oracle offline (`<tasks-dir>` must be an absolute path, because the script changes directory): the hidden tests fail on the base (pass, for `blocked`), and the reference passes `npm run check` and every hidden test. `evals/synth/tasks.json` lists the sweep's tasks with both coordinators; its paths are relative to it:

```sh
node evals/ab.ts --tasks evals/synth/tasks.json --auth <file> --skill ~/.agents/skills/code-review --n 2
```

An entry with `"kind": "synth"` has `id`, `dir`, `fixture`, `check`, `setup`, and `coordinator(s)`. The runner builds its target once per sweep with `fixtureRepo` (the fixture, then `base/` copied over it; the first commit is the same every sweep and is the `base`), uses `<dir>/brief.md`, and branch `task/<id>`.

**Scoring.** After the attempt's processes are swept, the runner copies `hidden/*.test.ts` into `test/` of the fresh clone where `checkFresh` ran and runs `node --test` on exactly those files (same timeout): `hidden` holds `files`, `exit`, `ms`, `timedOut`, and a `tail`. For `expect: "done"`, `pass` = `accepted` and `hidden.exit` is 0. For `expect: "blocked"`, `pass` = the report's Status is `BLOCKED`, its text contains one of `blockedKeywords` (any case), and `git diff --name-only <base> HEAD -- src` is empty.

**The oracle stays hidden.** The target holds only the fixture plus `base/`: never `hidden/`, `reference/`, or `meta.json`. Every sandbox deletes `evals/synth` from its me-pi clone right after cloning, then replaces the clone's history with a single commit, so Pi, its skills, and its workers cannot read the oracle there, neither in the tree nor from git's objects. Before this, `git show` could recover it from the clone's history, so synthetic results from earlier runs, the 26/28 baseline included, were measured without this guarantee. The agent can still reach the live checkout by absolute path; the runner does not fence it.

## Records

Each JSONL record holds:

- `attempt`, `arm`, `n`, `task`, `repo`, `base`, `branch`, `reference`, `baseline`. Also `commit` (the me-pi HEAD under test), the Pi, node and OS versions, `coordinator`, `skill`, and `hashes` of the pool, brief, contract, and extra skills, extensions, and packages.
- `state`: `completed`, `capped`, `timeout`, `incomplete` (start failure, account stop, or no session log), or `void` (`STOPPED: infra`, or an arm-B attempt that called `delegate` with role `implement`: note `arm B used implement`). `note` gives the reason.
- `accepted`: the attempt delivered: `state` is `completed`, the report's Status is `DONE`, `checkFresh` exited 0, and `headIsWip` is false. A green check alone is not delivery: an implement worker's shutdown WIP commit or a BLOCKED report can pass it.
- `pass`, `expect`, `hidden`: synthetic tasks only; see below.
- `wallMs`: from Pi's start until every process of the attempt has exited. It includes any sleep; `suspendedMs` is the part the timeout did not count.
- `orphansKilled`: how many processes of the attempt were still alive 20 s after the tmux session was killed and had to be signalled.
- `head`, `headIsWip` (its subject starts with `WIP(`, an implement worker's shutdown commit), `commits` (`base..head`), and `clean` (no uncommitted changes in the worktree).
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
