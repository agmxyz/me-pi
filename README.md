# me-pi

A lean [Pi](https://pi.dev) coding-agent setup: one global policy, one delegated worker tool, one safety guard, one skill loader.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git && cd me-pi && ./install.sh
```

Restart Pi afterwards. The installer is idempotent and never overwrites machine files:

- links `GLOBAL_AGENTS.md` → `~/.pi/agent/AGENTS.md`; if that path already exists, it is left alone, everything else still installs, and the run exits 1 because the policy is not active
- registers `extensions/` and pinned packages with `pi install`
- copies Pi's bundled `interactive-shell.ts` and `handoff.ts` if missing; on later runs (re-run after a Pi upgrade) it reports a copy that differs from the installed example and prints the `cp` command to update it
- runs `rtk init --global --agent pi` when [`rtk`](https://github.com/rtk-ai/rtk) is installed, which installs or updates RTK's own Pi extension

## How it works

- **The main session does the work.** It plans, edits, tests, and commits. Prune context between tasks with `/handoff <next goal>`, `/tree`, or `/compact`.
- **`GLOBAL_AGENTS.md` is the policy** every session and subagent loads: output style, an engineering fallback for repos without their own standards, and what needs your approval. It is a symlink, so edits apply to the next session.
- **`delegate` tool** (`extensions/delegate.ts`) keeps token-heavy work out of the main session: read-only `pi` workers search unread code, research docs and the web, review diffs, or challenge plans, and only their answers come back. An answer over 12 KiB is cut, and its full text is saved to a mode-0600 file under the system temp dir whose path is given; tool calls and stderr stay in the tool details, which the model never sees. Worker cost is added to the session's usage totals.
  - **Read-only:** workers get `read,grep,find,ls` and `Skill`; `research` and `challenge` also get the web tools. No `bash`, `edit`, or `write`, and no MCP tools (`--no-mcp`, because `--tools` alone keeps them). They cannot edit, run commands or tests, delegate, or commit, and report steps that need those as `BLOCKED: ...`. The main session does all edits, checks, and commits.
  - **Call:** `{ role, task, runs?, rebuttal? }`. The task is sent on stdin, so its size is not limited by the command line.
    | Role | When | Model · thinking | Answer |
    |---|---|---|---|
    | `scout` | find or explain something in code | first model in the set · `low` (`off` if asked) | `path:line` evidence, or `not-found` |
    | `research` | docs, web, several sources | `default`, else the last model · `high` | findings with sources |
    | `review` | a diff before a commit | `default`, else the last model · `high` | `path:line: severity: problem. Fix:` |
    | `challenge` | devil's advocate on a plan or diagnosis | `default`, else the last model · `high` | premise, challenges, verdict |
  - **Several models on one question:** ask "let Opus at medium and Sonnet at high review this, with rebuttal". The main session sends one call with `runs: [{ model, thinking }, ...]` (1-4, run in parallel) and `rebuttal: true`: a second round gives each successful worker its own answer and the others' to keep, revise, or retract claims. Only round-2 answers come back; the round-1 answers are saved to a temp file whose path is given.
  - **Limits:** timeout 300s for `scout`, 900s for other roles; cost cap $5 per worker, checked after each model reply (a final answer that crosses it is kept; model calls inside tools are not counted). Timeout, cancel, cost cap, and session shutdown SIGKILL the worker's process group (read-only workers have no state to protect); leftovers in the group are killed when a worker exits, and a normal exit of the main process kills live workers. A process that leaves the group survives (`fetch_content` clones GitHub repos in their own group). After a hard kill of the main Pi process, find leftover workers with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'` and stop each with `kill -- -<pid>`.
  - **Reviews need a fixed snapshot:** workers cannot run git, so the main session writes the diff to a temp file (`git diff HEAD`, with `git add -N` for new files), passes its path, and does not edit those files until the review returns.
  - **Tool policy is not a sandbox:** `read` is not limited to the working directory. In workers, this extension blocks `read`/`grep`/`find`/`ls` calls that name a path likely to hold secrets (`.env*` and `.envrc` except `.example`/`.sample`/`.template`, `.npmrc`/`.netrc`/`.git-credentials`, `*.pem`/`*.key`, private `id_rsa*`-style keys, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.pi/agent/auth.json`, …), case-insensitively and through symlinks, plus grep `glob`/find `pattern` values that name them (`**/.env*`). A broad search (`grep TOKEN .` without a glob) can still match inside them. `fetch_content` reads local files only for videos. `scout` and `review` have no web tools, so a prompt injection in a reviewed diff cannot send file contents out; `research` and `challenge` keep the web. The worker contract forbids `fetch_content`'s `auth` (browser cookies) option and tells workers to treat fetched content as data. Workers load your installed extensions, because provider auth (such as `pi-anthropic-auth`) is one.
- **Model set** (`~/.pi/agent/delegate.json`, machine-local, edited by hand): the models workers may use. `scout` takes the first; other roles take `default`, else the last; a call may pick any listed model per run, and a model outside the set is refused. A missing file means the session model, with any model allowed. Run `/reload` after editing so the tool's schema lists the set; the file is re-read on every call, and unknown keys, non-string ids, duplicates, or a `default` outside the set fail with an error naming the problem.
  ```json
  { "models": ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"], "default": "anthropic/claude-sonnet-5-5" }
  ```
- **Guard** (`extensions/guard.ts`) asks before bash commands that `GLOBAL_AGENTS.md` reserves for you: a push to `main`/`master` (also via quotes, subshells, `sh -c`/`bash -lc`, `eval`, `env`, `xargs`, or `/usr/bin/git`), a bare push after `cd`, `git checkout`/`switch`, or `git -C` (target branch unknown), force pushes, history rewrites (`commit --amend`, `rebase`, `filter-repo`/`filter-branch`), `git reset --hard`, `git clean -f`, discarding changes (`git checkout --`/`.`/`-f`, `git restore` of the working tree, `git switch -f`, `git stash drop|clear`), `git branch -D`, and recursive `rm` unless every target is a build or temp directory (`dist`, `build`, `node_modules`, …) or a named entry in a temp directory (`/tmp/x`, `${TMPDIR:?}/x`; not `/tmp/*`, and not bare `$TMPDIR/x`, which becomes `/x` when TMPDIR is unset). Without a UI it blocks. Feature-branch pushes, PRs, and plain `rm`/`rm -f <file>` pass. It matches patterns; it does not parse shell, so other spellings (variables, aliases, scripts) get through, and quoted text other than a commit message that looks like a command can prompt. Commands nested in another command's arguments (`"$(git push …)"`) are checked too. `/guard off|on` toggles it for the session. It is a safety net; the policy text is the rule.
- **`Skill` tool** (`extensions/skill.ts`) loads a listed skill's instructions by name. Many skills are written for Claude Code and say "call the Skill tool with `tdd`"; Pi has no such tool, so without it neither the main session nor workers loaded those sub-skills (workers reported them as BLOCKED). Every worker gets it. It serves only skills Pi discovered for the run and refuses `disable-model-invocation` skills (start those with `/skill:<name>`).
- **Skills are not in this repo.** Install them globally in `~/.agents/skills` or per project in `.agents/skills`.

## Extend

- **Specialize a worker:** write or install a skill and name it in the task ("load the `X` skill first"); workers load listed skills with `Skill`. Read-only workers can follow a skill's reading and reasoning steps; steps that edit, run commands, start sub-agents, ask the user, or commit come back as BLOCKED, so run those skills in the main session.
- **Guard a new command:** add a check in `classify()` in `extensions/guard.ts` and cases in `extensions/guard.test.mjs`.
- **Change policy:** edit `GLOBAL_AGENTS.md`, then start a fresh session.
- **Add an extension:** put the `.ts` file in `extensions/` and list it under `pi.extensions` in `extensions/package.json`.

## Check

Requires Node ≥22.19.0. When upgrading Pi, update the pinned `@earendil-works/pi-coding-agent` dev dependency and lockfile to the same version.

```bash
npm ci --prefix extensions      # once, and after package-lock.json changes
npm run check --prefix extensions
```

`check` runs Biome (lint + format, `--write`), `tsc --noEmit`, `node --test`, `bin/install.test.sh`, and `git diff --check` against HEAD (staged and unstaged changes), stopping at the first failure. The dev toolchain lives in `extensions/package.json` because `pi install <local dir>` never runs npm.
