# me-pi

A setup for the [Pi](https://pi.dev) coding agent: one global policy plus three extensions. The main session plans and talks to you; `delegate` sends token-heavy reading, research, reviews, and self-contained changes to separate `pi` workers, so only their answers (or a 2-line handback) come back. The code is the source of truth; this file says where to look and why things are the way they are.

## Files

| Path | Job |
|---|---|
| `GLOBAL_AGENTS.md` | Policy for every Pi session and worker: output, engineering defaults, approval, secrets. Linked to `~/.pi/agent/AGENTS.md`. |
| `AGENTS.md` | Instructions for working on this repo. |
| `package.json` | Public Pi package manifest and root development commands; explicitly lists the three extension entrypoints. |
| `package-lock.json`, `tsconfig.json`, `biome.json` | The single root source for pinned development dependencies, type checking, and lint configuration. |
| `install.sh` | Links the policy, registers this root package and `pi-web-access`, removes a prior `extensions/` package registration, copies Pi's `interactive-shell.ts` and `handoff.ts` examples, and runs `rtk init` if present. Idempotent; never overwrites your policy file or copied examples. |
| `extensions/package.json` | Private compatibility manifest for prior `extensions/` installations and the prefix check; keeps three explicit entrypoints and forwards `check` to the root. |
| `test/install.test.sh` | Hermetic test of `install.sh` (all writes under `/tmp`). |
| `extensions/delegate.ts` | The `delegate` tool: roles, model pools, worker processes, limits, in-worker blocks. |
| `extensions/delegate-implement.ts` | The `implement` role's checkout lifecycle: `prepare`, `finish`, `formatHandback`. |
| `extensions/delegate-command.ts` | `/delegate status \| models \| cancel <id>`. |
| `extensions/delegate-render.ts` | TUI view of calls and results. |
| `extensions/guard.ts` | Asks before risky bash; also the implement worker's bash rules. |
| `extensions/skill.ts` | The `Skill` tool. |
| `test/*.test.mjs` | Extension behavior tests and package-manifest assertions. |

## Install and Check

Needs `pi` on PATH and Node ≥22.19.

```bash
git clone https://github.com/0bmario/me-pi.git && cd me-pi && ./install.sh   # then restart Pi
npm ci                         # once, and after package-lock.json changes
npm run check                  # Biome, tsc, node --test, test/install.test.sh, git diff --check
npm run check --prefix extensions  # compatibility command; forwards to the root check
```

`install.sh` registers this checkout's root directory as a local Pi package and removes a prior registration of its `extensions/` subdirectory so the same extensions cannot load twice. The root `package.json` declares the three public entrypoints and the HTTPS repository URL used by Pi package discovery; local installation does not test GitHub transport. This repository is private, so GitHub access requires authentication. The `extensions/package.json` manifest remains a compatibility shim for existing installs and the prefix check.

Optional model pools live in `~/.pi/agent/delegate.json` (local, hand-edited, `/reload` after). Without it every worker uses the main session's model and thinking. Shape and validation: `validModelSet`, `resolveRun` in `extensions/delegate.ts`.

When you upgrade Pi, bump the pinned `@earendil-works/pi-coding-agent` dev dependency and the lock file to the same version.

## `delegate`

Roles, parameters, and when the main session should delegate are in `ROLES`, `buildSchema`, and `PROMPT_GUIDELINES` in `extensions/delegate.ts`; the model reads those, so they are the spec. Design decisions:

- **Workers are child `pi --mode json -p` processes, not in-process agents.** Each sees only the task, so its reading never enters the main context. `runWorkerAttempt`.
- **Read-only by default (except `output: true`, which writes only to the worker's own dir); web only for `research`/`challenge` or `web: true`.** A worker with both local reads and web tools can be steered by a fetched page into sending files out. `LOCAL_TOOLS`, `WEB_TOOLS`.
- **Workers cannot delegate.** The extension registers no tool when `ME_PI_RUN` is set; it only installs the in-worker blocks (budget, secret paths, write fence, orphan stop). Default export.
- **Every worker is told it is the delegated subagent,** so repo instructions like "delegate to a subagent" do not turn into `BLOCKED`. `CONTRACT_SHARED`.
- **Pool order is fallback order; only availability errors fall back** (rate limit, quota, overload, unknown model); other failures stop. Scout is capped at `low`/`off`. `retryableAvailabilityFailure`, `resolveRun`.
- **Wrap-up budget before the hard limit.** Past 80% of time or cost, or the tool-call count, tool calls are blocked with "give your final answer now", so a worker answers instead of being killed mid-run; after 3 ignored blocks the run ends with its last text as a partial answer. `LIMITS`, `budgetSpent`, `MAX_BLOCKED_OVER_BUDGET`.
- **Hard cap of 4 workers across all calls, refused not queued.** `MAX_RUNS`.
- **Answers over 12 KiB are cut; the full text goes to a 0600 temp file.** The main context is what this protects. `ANSWER_CAP`, `saveFull`.
- **Process groups.** Workers run detached so one SIGKILL stops their children; groups are killed on Pi exit and shared across `/reload`. `liveGroups`, `killGroup`.
- **Reviews take a diff file.** Read-only workers cannot run git: write `git diff HEAD` to a temp file (`git add -N` new files first) and pass the path.

### implement

One `implement` worker edits, runs `check`, and commits on your current branch, **in your checkout**. Worktree mode (temp worktree per job, merged back after review) was dropped: on the same task it took 237 s and ~23k main-session context, vs 127 s and ~20k with the main session doing the work itself, because of the merge ceremony.

- Run with `background: true`; stop with `/delegate cancel <id>`.
- **Prepare refuses, leaving nothing behind,** unless: a git repo with a commit, HEAD on a branch other than `main`/`master` (`git switch -c goal/<slug>` first), no merge/rebase/cherry-pick/revert in progress, `git status --porcelain` empty. Clean tree means the worker's commits are only its own. `prepare`, `IN_PROGRESS`.
- **One job per repo** via `<git-common-dir>/me-pi-implement.lock` (`<pid> <id>`, created by linking a written temp file so it appears atomically); a dead pid's lock is taken over. `takeLock`, `linkLock`.
- **The main session is fenced while a job runs:** `edit`/`write` in the repo and git tree writes there are blocked, since they would land in the worker's commits or move its branch. The `tool_call` handler on `writing` in `delegate.ts`; `gitTreeWrite` in `guard.ts`.
- **The worker is fenced:** `edit`/`write` only inside the repo and never in the git common dir (so hooks too); git remotes cut via appended `protocol.*.allow=never`; GitHub tokens unset and `GH_CONFIG_DIR` empty; worker-only bash blocks (push, switch, merge, stash, `--no-verify`, `gh`, `install.sh`, `pi install`, …). `workerEnv`, `writeBlockedIn`, `workerRisk`.
- **`--approve` only on the first model attempt of a trusted project:** a clean tree means `.pi` equals the trusted HEAD; a fallback may run the earlier attempt's edits. `runWorker`.
- **Orphan stop:** if the main Pi dies, the worker's next tool call is blocked and the run ends. `ME_PI_PARENT`.
- **The check is watched, not trusted.** A bash call textually equal to `check` (normalized; one leading `cd <cwd> &&` allowed) sets pass/fail; a later successful `edit`/`write` makes it stale. `check` is refused if chained (`|`, `;`, `&&`, `||`), because a chained check never matches the worker's run. `isCheckRun`, `trackCheck`.
- **Stop is SIGTERM, then SIGKILL after 3 s,** so Pi stops its bash commands before the WIP commit. `LIMITS.termGraceMs`.
- **Finish never throws.** Leftovers become one `WIP(delegate im<n>): <reason>` commit (hooks and signing off: it only saves work). The range is read from git, not from the worker; ✗ if the base is not an ancestor, a commit is a merge, or a commit predates the job by more than 60 s (fast-forward to existing work). `finish`, `finishSteps`, `CLOCK_SKEW_MS`.
- **Tripwires report, never restore:** other refs under `refs/heads|tags|stash` moved or deleted, local git config (except upstream tracking) or `hooks/`/`info/` changed, `~/.pi/agent/settings.json` resource keys changed, `.pi`/`.agents` changed in the range. `gitTripwires`, `settingsTripwire`, `SETTINGS_RESOURCES`.
- **Handback is 2 lines plus only needed ✗/BLOCKED lines;** everything else is in a 0600 details file. ✓ only with an answer, no WIP, no problems, and check pass. Trust a ✓ (no diff read, no re-check); see `PROMPT_GUIDELINES` for WIP, tripwire, and goal-end review handling. `formatHandback`, `writeDetails`.

## `guard`

Asks before risky bash (pushes to `main`/`master`, force push, history rewrites, discarding work, recursive `rm` outside build/temp dirs); blocks when Pi has no UI. `/guard on|off` per session. Rules: `classify`, `gitRisk`, `pushRisk`, `DISPOSABLE` in `extensions/guard.ts`.

- **A pattern match, not a parser.** It finds commands inside quotes, subshells, `sh -c`, `eval`, `env`, `xargs`, and full paths (`AT_COMMAND`), but variables, aliases, and scripts get past it. The policy in `GLOBAL_AGENTS.md` is the rule; guard is a net.
- **Commit messages and `cat`/`git` heredoc bodies are blanked first,** so text that mentions a command does not ask. `withoutMessages`.
- **A bare push after `cd`, `checkout`, `switch`, or `-C` asks,** because the branch read before the command says nothing about the target.

## `Skill`

Loads a skill's instructions by name. Exists because Claude Code skills say "call the Skill tool" and Pi has none: measured on the `implement` skill, without it neither the main session nor a worker loaded `tdd` or `code-review` (the worker reported `BLOCKED`), and a system-prompt rule to read `SKILL.md` was ignored; with it, the worker loaded both. Serves only skills Pi discovered; refuses `disable-model-invocation` skills (start those with `/skill:<name>`). Named `Skill`, capitalized, to match those skills' wording. `extensions/skill.ts`.

## Safety limits: not a sandbox

- `read` reaches outside the project. Secret paths are blocked by name, glob, and symlink (`secretPathIn`), but a broad search like `grep TOKEN .` can still match inside them.
- `web` is a prompt-injection channel: a page can tell a worker to read a file and send it out. Workers are told to treat content as data and never use `fetch_content`'s `auth`.
- Workers load your installed extensions (provider login is an extension).
- An `implement` worker writes your real checkout. Its bash reads and writes anywhere and reaches the network; only git remotes and `gh` are cut, and `git -c` or `env -u` undoes that. Ignored files (`.env`) cannot be restored from git.
- Check matching is textual: a bash write (`sed -i`) after the check is not seen, so it stays ✓.
- Editor or bash writes you make during a job (not git tree writes) end up in the worker's commits.
- A bash child that ignores SIGTERM can keep writing while the WIP commit is made. A process that leaves the group survives the kill.
- If the main Pi is killed: the tree stays dirty and needs manual cleanup; the lock frees itself once its pid is dead; an `implement` worker stops at its next tool call, but other workers keep running until a limit. Find leftovers with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'`, stop with `kill -- -<pid>`.
- In the live me-pi checkout, workers and `/reload` load worker-edited extensions. Run me-pi goals in a clone.
- WIP commits break `git bisect` until squashed.

## Changing things

- **Policy:** `GLOBAL_AGENTS.md`; takes effect in new sessions.
- **When and how the main session delegates:** `PROMPT_GUIDELINES`, `PROMPT_SNIPPET` in `extensions/delegate.ts`.
- **Worker instructions and answer formats:** `ROLES`, `CONTRACT_SHARED`, `WORKER_CONTRACT`, `implementContract`.
- **Limits:** `LIMITS`, `MAX_RUNS`, `ANSWER_CAP` (`delegate.ts`); `GIT_LIMITS`, `CLOCK_SKEW_MS` (`delegate-implement.ts`).
- **Secret paths:** `HOME_SECRETS`, `SECRET_NAMES`, `SECRET_GLOB`.
- **Guard rules:** `classify` (main session), `workerRisk` (implement), `TREE_WRITES` (main-session fence) in `guard.ts`; add cases to `test/guard.test.mjs`.
- **Worker procedure:** install a skill and put "Load the `X` skill first" in the task.
- **New extension:** add the `.ts` file to `extensions/` and list its root-relative path in `pi.extensions` in `package.json`. Until the installer switches to the root package, keep `extensions/package.json`'s compatibility entrypoints in sync.
