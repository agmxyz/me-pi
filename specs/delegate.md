# Spec: `delegate` — one-shot pi children

`bin/delegate` runs a role (`agents/<role>.md` in this repo, never the project) as a one-shot `pi -p` child. Runs live in `$ME_PI_RUNS_ROOT` (default `~/.pi/agent/runs/<id>/`). `$RUN/exit` is the only completion signal.

## Commands

| Command | Behavior |
|---|---|
| `run <role> <task.md\|-> [-C dir] [-w] [-b] [-m model] [-T thinking] [-t secs] [-c usd]` | always starts a session-detached watchdog (perl `setsid`); `-b` prints the id and returns, sync prints `delegate: <id> started …` on stderr, waits for `exit`, prints `out.md`, returns its code. Killing a sync caller never stops the worker, caps, or sentinel; resume with `wait <id>`. `-t`/`-c` are time/cost caps (defaults 900s / $2) |
| `wait <id>...` | block on `exit`, print `out.md`; marks a vanished watchdog as lost |
| `ls` | id, state, cost, mtime, **cwd** (shared-checkout risk is visible) |
| `kill <id>` | TERM then KILL the child's process group; pid verified against `lstart` |
| `ask <id> "q"` | resume the run's session read-only from its own cwd; refuses without `exit` (`run <id> has not finished (no exit sentinel)`) |
| `harvest <id>` | bring a `-w` run's changes back (below) |
| `prune [--days N] [--dry-run]` | GC old runs and worktrees (below) |
| `roles` | `name — description (aliases: …)` per `agents/*.md`; unknown-role errors list the names |
| `diff-hash [-C dir]` | sha256 hex + newline of the canonical diff (below); prints nothing, exit 0, when clean; exit 1 outside git. Needs no `pi` |

Model: `-m` > `subagents.agentOverrides.<role>` in settings > `subagents.defaultModel`/`defaultProvider` in settings > pi default. An explicit `-m` bypasses the role settings override and the rig default, including any thinking choice. Thinking: `-T` > settings override thinking (when `-m` is absent) > role frontmatter > pi default. Falling back to the rig default model never changes the role's frontmatter thinking. Nested `pi`/`delegate` are blocked by a per-run PATH shim. Role frontmatter: `tools`, `thinking`, `attach_diff`, `description`, `aliases` (listed only; `run` takes the file name). Workers fail closed (exit 1, before any model call) if their system prompt contains the coordinator `APPEND_SYSTEM.md`; guard in `extensions/me-setup.ts`. `ask` resumes with the full saved role prompt.

## Optional independent review

Delegation is available alongside direct Pi skill use; it is not a mandatory coordinator workflow. `delegate run reviewer - -C <repo>` accepts the review task/spec on stdin and auto-attaches the current diff. Review findings can inform the interactive session, but main-session commits have no global clean-review prerequisite.

Workers leave changes uncommitted and never publish. `extensions/me-setup.ts` retains worker-only bash commit blocking and the prompt-isolation guard; these are safeguards, not an OS sandbox. Publication requires explicit user authorization under `APPEND_SYSTEM.md`.

## Run files

`meta` (`role`, `cwd`, `head`, `model`, `tools`, `thinking`, `wt`, `origin`, `diff_sha` (hex, or `none`), `started`), `task.md`, `role.md`, `out.md` (+ trailer `[id exit=N cost=$ Ns]`), `err.log`, `session/`, `pid`, `lstart`, `watchdog.pid`, `why` (timeout / cost-cap / lost), `exit`, `artifacts/diff.patch` (`attach_diff` roles).

## Canonical diff (`attach_diff`, `diff-hash`)

One implementation: working tree vs HEAD of the `-C` checkout's toplevel (repo-wide from a subdir), untracked non-ignored files included, staging irrelevant. Built in a temp `GIT_INDEX_FILE` (seeded from the real index for stat reuse, `read-tree --reset HEAD`, `add -A`, `diff --cached --binary HEAD`); the real index is never written (blobs do land in the object store). Unborn HEAD diffs against the empty tree.

A role with `attach_diff: true` (`reviewer`): `run` takes the diff before any `-w` worktree exists, dies `nothing to review: working tree matches HEAD` when empty (no run dir), appends `## Diff (working tree vs HEAD, auto-attached)` + a fenced `diff` block (fence longer than any backtick run in it) to `task.md`, keeps the bytes in `artifacts/diff.patch`, and records `diff_sha:` = sha256 of exactly those bytes = `diff-hash` output for the same tree.

## Worktree lifecycle (`-w`)

1. `run -w` creates a detached worktree of `-C dir` at HEAD under `$ME_PI_WT_ROOT` (default `~/.pi/wt`); `meta` records `wt:` and `origin:` (the source toplevel).
2. The writer finishes with **uncommitted** changes in the worktree (roles never commit).
3. `harvest <id>`: requires `exit`; `wt` must exist and be a worktree registered in `origin`. Runs `git add -N .` in the worktree, `git diff --binary` → `$RUN/artifacts/harvest.patch`, `git apply --check` against `origin`, then applies. Any conflict → refuse, nothing applied, patch kept. Prints the applied `--stat`. Never commits; the coordinator reviews and commits.
4. The worktree survives harvest. Only `prune` removes it.

## GC (`prune`)

Candidates: run dirs whose `exit` file is older than N days (default 7, by mtime). Never touches a run without `exit`, or one whose `pid` is still alive (reported as `skip`). For each pruned run its `wt` is removed (`git worktree remove --force`, then `worktree prune`) only if it resolves under `$WT_ROOT`. `--dry-run` lists (`would prune …`, flags worktrees with uncommitted changes) and deletes nothing. Unharvested changes in a pruned worktree are lost — harvest first.

## Tests

`bin/delegate.test.sh` (fake pi, free; runs a copy of the script against fixture roles `worker`/`differ`, so real `agents/*.md` edits never break it; harvest/prune/diff use git fixtures) and `ME_PI_ITEST=1 bin/delegate.itest.sh` (real cheap model, < $0.05; case 6 is a harvest round-trip).
