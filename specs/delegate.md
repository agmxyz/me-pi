# Spec: `delegate` — one-shot pi children

`bin/delegate` runs a role (`agents/<role>.md`) as a one-shot `pi -p` child. Runs live in `$ME_PI_RUNS_ROOT` (default `~/.pi/agent/runs/<id>/`). `$RUN/exit` is the only completion signal.

## Commands

| Command | Behavior |
|---|---|
| `run <role> <task.md\|-> [-C dir] [-w] [-b] [-m model] [-T thinking] [-t secs] [-c usd]` | sync by default; `-b` detaches a watchdog and prints the id; `-t`/`-c` are time/cost caps (defaults 900s / $2) |
| `wait <id>...` | block on `exit`, print `out.md`; marks a vanished watchdog as lost |
| `ls` | id, state, cost, mtime, **cwd** (shared-checkout risk is visible) |
| `kill <id>` | TERM then KILL the child's process group; pid verified against `lstart` |
| `ask <id> "q"` | resume the run's session read-only from its own cwd |
| `harvest <id>` | bring a `-w` run's changes back (below) |
| `prune [--days N] [--dry-run]` | GC old runs and worktrees (below) |

Model: `-m` > `subagents.agentOverrides.<role>` in settings > pi default. An explicit `-m` bypasses the role settings override, including its thinking choice. Thinking: `-T` > settings override (when `-m` is absent) > role frontmatter > pi default. Nested `pi`/`delegate` are blocked by a per-run PATH shim. `ask` resumes with the full saved role prompt.

## Run files

`meta` (`cwd`, `head`, `model`, `tools`, `thinking`, `wt`, `origin`, `started`), `task.md`, `role.md`, `out.md` (+ trailer `[id exit=N cost=$ Ns]`), `err.log`, `session/`, `pid`, `lstart`, `watchdog.pid`, `why` (timeout / cost-cap / lost), `exit`.

## Worktree lifecycle (`-w`)

1. `run -w` creates a detached worktree of `-C dir` at HEAD under `$ME_PI_WT_ROOT` (default `~/.pi/wt`); `meta` records `wt:` and `origin:` (the source toplevel).
2. The writer finishes with **uncommitted** changes in the worktree (roles never commit).
3. `harvest <id>`: requires `exit`; `wt` must exist and be a worktree registered in `origin`. Runs `git add -N .` in the worktree, `git diff --binary` → `$RUN/artifacts/harvest.patch`, `git apply --check` against `origin`, then applies. Any conflict → refuse, nothing applied, patch kept. Prints the applied `--stat`. Never commits; the coordinator reviews and commits.
4. The worktree survives harvest. Only `prune` removes it.

## GC (`prune`)

Candidates: run dirs whose `exit` file is older than N days (default 7, by mtime). Never touches a run without `exit`, or one whose `pid` is still alive (reported as `skip`). For each pruned run its `wt` is removed (`git worktree remove --force`, then `worktree prune`) only if it resolves under `$WT_ROOT`. `--dry-run` lists (`would prune …`, flags worktrees with uncommitted changes) and deletes nothing. Unharvested changes in a pruned worktree are lost — harvest first.

## Tests

`bin/delegate.test.sh` (fake pi, free; harvest/prune use git fixtures) and `ME_PI_ITEST=1 bin/delegate.itest.sh` (real cheap model, < $0.05; case 6 is a harvest round-trip).
