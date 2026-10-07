# Delegation guide

`bin/delegate` runs a one-shot Pi child using roles from this rig's `agents/`, never roles from the target project. Delegation is optional: use Pi skills directly when they fit; use a separate worker or independent reviewer when a fresh context or isolated task is useful.

## Run and recover

`delegate run <role> <task.md|-> [options]` starts a task. Use `delegate roles` to discover roles. Send task text through stdin with `-`, not a task file in the project; include **Goal, Acceptance, Constraints, Paths, and Output contract**. The default sync run starts a detached watchdog and waits for the child's `$RUN/exit` sentinel, the only completion signal. Set the caller's bash timeout to at least the run's time cap (900 seconds by default; `-t` overrides it). The default cost cap is $2; `-c` overrides it. Use `-b` only when you intend to continue other interactive work while the child runs.

If a sync call is interrupted, the detached worker and its caps continue. Resume with `delegate wait <id>`; do not rerun the task. `wait` prints the saved output and exit status. `delegate ask <id> "question"` is a read-only follow-up that resumes the saved session and role prompt from the run's cwd when it still exists; it refuses unfinished runs with `run <id> has not finished (no exit sentinel)` and does not restart the task.

Runs are stored under `$ME_PI_RUNS_ROOT` (default `~/.pi/agent/runs/<id>/`). The directory contains `task.md`, `role.md`, `out.md`, `err.log`, `session/`, `meta`, `exit`, optional `why`, and artifacts. `delegate ls` shows state and cwd; `delegate kill <id>` terminates the worker's process group after checking the recorded process start time.

## Roles and settings

Roles are `agents/<role>.md`; `delegate roles` prints their descriptions and aliases. Use the role filename, not a listed alias, in `run`. The default tool set is `read,grep,find,ls` (no bash). Read-only roles have no bash; check a role's `tools` before assigning work that needs writes or commands. Give `devils-advocate` a plan and gathered evidence; use `scout` for research.

Honor requested model and thinking choices: pass them via `-m` and `-T` without substitution.

- Model precedence: explicit `-m` > `subagents.agentOverrides.<role>` > `subagents.defaultModel`/`defaultProvider` > Pi default. Explicit `-m` bypasses settings-based model and thinking choices.
- Thinking precedence: explicit `-T` > role override thinking (only when `-m` is absent) > role frontmatter > helper default (`high`). `subagents.defaultThinking` is not consumed by `delegate`.
- Missing or invalid settings are ignored. An override's provider and model are combined as `provider/model`; an absent or false provider leaves the model bare.

## Worker boundaries

Nested `pi` and `delegate` commands are blocked by a per-run PATH shim. Worker prompts require no nested delegation or commits/pushes; the extension blocks textual `git commit` calls through Pi's bash tool, but this is not an OS sandbox. Children return results; the interactive session retains project decisions and integration.

## Independent review

For an optional independent review, `delegate run reviewer - -C <repo>` accepts the review task/spec on stdin and attaches the current working-tree diff. It refuses an empty diff before creating a run. Review can inform the main session; it is not a mandatory clean-review gate for main-session commits.

## Worktrees and diffs

Before assigning a writer, read the concurrent-change rules in `~/.agents/CODING_STANDARDS.md`; `-w` provides checkout isolation for delegate writers. `delegate run <role> - -C <repo> -w` creates a detached worktree at the target checkout's HEAD under `$ME_PI_WT_ROOT` (default `~/.pi/wt`); `meta` records the worktree and origin. The worker leaves uncommitted changes there. `delegate harvest <id>` requires a finished run and a registered worktree belonging to that origin. It saves a patch, checks it with `git apply --check`, and only then applies it; a conflict refuses the whole patch and keeps it for inspection. Harvest never commits, and the worktree remains until pruned. Inspect harvested changes and run relevant checks before accepting them.

Review attachments and `delegate diff-hash` use one canonical diff: the target checkout versus HEAD, including untracked non-ignored files and regardless of staging. A temporary Git index leaves the real index untouched (Git objects may be written). An unborn HEAD compares against the empty tree. Attached bytes are saved at `artifacts/diff.patch`; `diff-hash` prints their SHA-256, or nothing for a clean tree.

## Prune safely

`delegate prune [--days N] [--dry-run]` considers every run under its runs root whose `exit` file is older than N days (default 7), and skips a run with a live pid. A worktree is removed only if it resolves under `$ME_PI_WT_ROOT`. Dry-run deletes nothing and flags worktrees with uncommitted changes. Preview candidates; proceed only if every candidate is intended. If the preview includes unrelated work, leave that runs root unpruned. Pruning an unharvested worktree loses its changes: harvest first. Other command syntax and options are available through `delegate --help`.
