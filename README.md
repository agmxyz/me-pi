# me-pi

A setup for the [Pi](https://pi.dev) coding agent:

- `GLOBAL_AGENTS.md`: one policy for every session and worker: output style, engineering defaults, what needs your approval, and how to treat secrets and instructions found in content.
- `delegate`: sends reading, research, reviews, drafts, and self-contained changes to separate `pi` workers. Only their answers come back; an `implement` worker's changes come back as a branch.
- `guard`: asks before risky bash commands run.
- `Skill`: loads a skill by name, as Claude Code skills expect.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git && cd me-pi && ./install.sh
```

Then restart Pi. You can run the installer again; it does not replace your files. It:

- Links `GLOBAL_AGENTS.md` to `~/.pi/agent/AGENTS.md`. If another file is there, it leaves it, finishes the other steps, and exits 1.
- Registers `extensions/` and the pinned packages with `pi install`.
- Copies Pi's `interactive-shell.ts` and `handoff.ts` examples if missing, and warns when a copy differs from Pi's.
- Runs `rtk init --global --agent pi` if [`rtk`](https://github.com/rtk-ai/rtk) is installed.

Without this file, every worker uses the main session's model and thinking level (scout caps it at `low`). Optionally configure ordered model pools and per-model thinking in `~/.pi/agent/delegate.json` (local). Edit the JSON by hand; the same model may appear in both pools:

```json
{
  "version": 3,
  "scout": {
    "thinking": "low",
    "models": [
      { "model": "openai-codex/gpt-6-luna", "thinking": "off" },
      { "model": "anthropic/claude-haiku-5-5", "thinking": "low" }
    ]
  },
  "worker": {
    "thinking": "max",
    "models": [
      { "model": "openai-codex/gpt-6-luna", "thinking": "max" },
      { "model": "anthropic/claude-opus-5-5", "thinking": "low" }
    ]
  }
}
```

Pool order is fallback order. Each entry's `thinking` is used for that model. The optional pool-level `thinking` applies to models without an entry (the session model when the pool is empty); without it they use the main session's thinking level. Scout entries and defaults accept only `low` or `off`; Worker accepts any thinking level. On rate limits, usage-limit or quota errors, overloads, or model-unavailable errors, the worker tries the next model with that entry's thinking level and reports each fallback. Other failures stop. A `runs[].model` from the active pool is tried first, then the rest of that pool; one found only in the other pool is an exact-model request that uses that entry's thinking. With no models in a pool, that role uses the main session's model. Version 1 `{ "models": [...], "default": "..." }` and version 2 pool configs remain readable and are migrated in memory.

Run `/reload` after editing to refresh the tool's model choices. The tool reads the file at each call and names any problem in it. `/delegate status` shows each model's thinking level and availability, missing tools, running calls, and the last 20 calls with their cost. `/delegate models` prints the config path and manual-edit reminder. `/delegate cancel <id>` stops a background job. The call list survives `/reload`.

## Use it

Talk to the main session as usual. It plans, edits, tests, and commits, and the `delegate` tool's guidelines tell it when to call workers by itself: for reading many files, research, reviews before multi-file or behaviour-changing commits, and plan challenges. You can also ask directly:

| You say | Call |
|---|---|
| "Find where X is handled." | `scout` |
| "Research how library Y does Z." | `research` (web) |
| "Review this before you commit." | `review` of a diff file |
| "Challenge this plan." | `challenge` (web) |
| "Have Opus check whether …" | `general` on that model |
| "Opus at high and Sonnet at medium, with rebuttal." | 2 `runs`, `rebuttal: true` |
| "Let a worker draft the docs." | `output: true` |
| "Review this in the background while we keep going." | `background: true` |
| "Implement X in the background." | `implement`, `background: true` |

To remove old context between tasks, use `/handoff <next goal>`, `/tree`, or `/compact`.

## `delegate`

A call is `{ task, role?, web?, answer?, output?, runs?, rebuttal?, background?, branch? }`. Only `task` is required. The worker sees only the task, so the task must name the goal, the paths, and the acceptance criteria.

| Role | For | Model, thinking | Web | Answer |
|---|---|---|---|---|
| `general` (default) | Any read-only task | Worker pool, configured thinking | no | Set by the task |
| `scout` | Find or explain code | Scout pool, `low` or `off` | no | `path:line` evidence, or `not-found` |
| `research` | Docs and web | Worker pool, configured thinking | yes | Findings with sources |
| `review` | A diff before a commit | Worker pool, configured thinking | no | `path:line: severity: problem. Fix:` |
| `challenge` | Argue against a plan | Worker pool, configured thinking | yes | Premise, challenges, verdict |
| `implement` | A change with a check | Worker pool, configured thinking | no | Changes, checks, commits; the tool adds branch facts |

With no configured pool, roles use the main session's model and thinking level; scout caps the level at `low` (`off` stays `off`). If Pi does not report the session's thinking level, the call fails and asks for a pool-level `thinking` or `runs[].thinking`.

- `runs`: 1 to 4 `{ model, thinking }` entries, run in parallel. Thinking defaults to each candidate model's setting; an explicit `runs[].thinking` overrides the pool's settings for all candidates. Scout stays at `low`/`off` even if asked for a higher level. Worker roles accept any thinking level. Models outside both pools are refused when either pool contains models.
- At most 4 workers run at once across all calls, foreground and background; a call that would exceed this is refused, not queued.
- `rebuttal: true` (2+ runs): each worker sees the others' answers and keeps, revises, or retracts its claims. Only round 2 comes back; round 1 goes to a temp file.
- `web`: turns the web tools on or off for any role. The label shows `web`.
- `answer`: replaces the role's answer format, 1 to 400 characters.
- `output: true`: each run gets `write`, but only inside its own new temp directory (mode 0700). The answer lists the files and their sizes, not their contents. Copy what you keep and check the diff. The tool does not delete these directories.
- `branch` (`implement` only): an existing `delegate/*` branch to continue (after WIP or review findings) instead of a new branch from HEAD. Refused for other roles, for names without the `delegate/` prefix, and for missing branches.
- `implement` refuses `runs` with more than 1 entry, `rebuttal`, `output`, and `web: true`.
- `background: true`: the call returns a job id (`bg1`, `bg2`, …) at once and the conversation goes on. When the workers finish, the answer arrives as a `delegate` message that starts a turn (queued as a follow-up if the session is busy). The turn's abort does not stop a background job; `/delegate cancel <id>` does, and its report arrives without starting a turn. Ending or switching the session (`/reload`, `/new`, `/resume`, `/fork`, a handoff, or exit) stops background jobs and their answers are lost. Pi's session usage does not include background cost, so the status line shows background jobs running and their spend for this Pi process, kept across `/reload`.

Results: answers over 12 KiB are cut and saved in full to a temp file (mode 0600). Worker cost is added to the session usage. In the TUI, a running call shows each worker's turn, cost, and last tool; a result shows one line per run, and Ctrl+O expands the answers as Markdown. The model gets the full text either way.

Reviews: read-only workers cannot run git. Write the diff to a file first (`git add -N` new files, then `git diff HEAD > /tmp/x.diff`), pass its path, and do not edit those files until the review returns.

### Implement

An `implement` worker edits, runs checks, and commits, in a temp git worktree on its own branch:

- **Worktree and branch.** The cwd must be in a git repo with a commit. The tool adds a worktree in `$TMPDIR/me-pi-delegate-wt-*` on a new branch `delegate/<YYYYMMDD-HHMMSS>-im<n>` from your HEAD commit (or on `branch`). Uncommitted files in your tree are not in it; the start message (or foreground progress) names the branch, the base, and how many such files there are. The worker starts at the same path inside the worktree as your cwd; if that directory is not in the commit (untracked or ignored), it starts at the worktree root and the start message says so. `im<n>` counts per Pi process and survives `/reload`; background calls keep their `bg<n>` job id.
- **Environment.** Tools: `read,grep,find,ls,Skill,edit,write,bash`. `edit` and `write` are allowed only inside the worktree. Every worker gets `ME_PI_ROLE=<role>`. Git remotes are cut off by appending `protocol.{ssh,https,http,git}.allow=never` after any `GIT_CONFIG_*` you set (the cut-off alone allows local and `file://` pushes; the worker rules block every `git push`). `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` are unset and `GH_CONFIG_DIR` is an empty temp dir. The worker gets `--approve` only when your session trusts the project, the branch is new, it is the first model attempt, and the worktree's `.pi` and `.agents` equal the base (no tracked changes, no untracked files); otherwise `--no-approve`.
- **Worker rules.** Inside an implement worker, bash blocks `git push`, `git worktree`, `git commit -n`/`--no-verify`, `gh`, `git config` writes, `git remote`, `git update-ref`, `git symbolic-ref` writes, `git branch -m`, `git tag -f`/`-d`, `install.sh` (run directly, or via `sh`, `bash`, `zsh`, `.`, or `source`), and `pi install|remove|uninstall|update|config`. Blocked steps come back as BLOCKED.
- **Finish.** When the worker ends, is stopped, or the session ends (shutdown waits for this), the tool checks that the worktree is still on its branch. If not, it keeps the worktree and makes no commit. Otherwise, uncommitted work becomes one `WIP(delegate im<n>): <reason>` commit (hooks and signing off), which must not be merged as is. Then it removes the worktree with `git worktree remove` (no `--force`); on failure it keeps it and says why.
- **Report.** After the worker's answer: `Branch: <branch> @ <tip> (base …)`, the commits since the start (at most 20), the diffstat (at most 30 lines), `Diff: <path> (0600, base..tip)`, and `Worktree: removed`. The diff itself is only in that file. Failures are ✗ lines and make the call an error: a WIP commit, a tripwire (another branch or tag moved or deleted, your branch reset to a non-descendant, local git config or `hooks/`/`info/` changed, or the `packages`, `extensions`, `skills`, `prompts`, or `themes` keys of `~/.pi/agent/settings.json` changed), or a kept worktree. Tripwires report; they never restore. `/delegate status` lists each implement call's `branch@tip`, and `WIP` when there is one.
- **Merge.** Merge only a result with no ✗ line: get a fresh `review` of the diff file, then `git merge <branch>` on a clean tree (no squash) and run the check once. On a tripwire or kept-worktree ✗, report to the user and do not merge. Do not read the diff file yourself; pass its path to the `review` worker. Delete the branch only after the post-merge check passed, as its own command (not chained after the check). If the check fails after the merge, fix forward (follow-up implement or a commit); never undo the merge without approval. For WIP or review findings, call `implement` again with `branch` set.
- **Cleanup.** Delete merged branches with `git branch -d`; put discarded ones in one `git branch -D a b c` for the user to approve. A kept worktree is listed by `git worktree list`; remove it with `git worktree remove <path>` after checking what it holds.

### Limits

- Time: 300 s for `scout`, 900 s for the other roles. Cost: $5 for each worker, checked after each reply. A final answer over the cap is kept.
- Wrap-up budget: after 30 tool calls (`scout`) or 100 (other roles), 80% of the time limit, or 80% of the cost cap, the worker's tool calls are blocked with "give your final answer now". So the worker answers before a hard limit stops it. Every tool call counts, including blocked ones. After 3 ignored budget blocks, the run ends and its last text comes back as a partial answer. The budget is checked at each tool call, so it cannot stop one long reply; only the hard time limit does.
- On a limit, a cancel, the end of the session, or a normal exit of Pi, the tool SIGKILLs the worker's process group. An `implement` worker gets SIGTERM first (Pi then stops its bash commands), and SIGKILL after 3 s; on a hard exit of the main process it gets SIGKILL only. A process that leaves the group keeps running (for example, `fetch_content`'s GitHub clones). With `output: true`, a stopped worker can leave incomplete files; the answer lists them.
- If the main Pi process is killed, workers can keep running. Find them with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'` and stop each with `kill -- -<pid>`.

### Safety

Read-only workers get `read`, `grep`, `find`, `ls`, and `Skill`, and the web tools if `web` is on. They never get `bash` or `edit`, nor `write` without `output`. `implement` also gets `edit`, `write`, and `bash`, and never the web tools. All start with `--no-mcp`. A worker that needs a missing step reports `BLOCKED: ...`.

This is not a sandbox:

- `read` reaches files outside the project. The tool blocks `read`, `grep`, `find`, and `ls` calls that name likely secrets (`.env*` except `.example`, `.sample`, `.template`; `.npmrc`, `.netrc`, `.git-credentials`, private keys, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.pi/agent/auth.json`), also through symlinks and globs. A broad search such as `grep TOKEN .` can still match them.
- Web access is a prompt-injection risk: a fetched page can tell a worker to read a local file and send it to a URL. Turn on `web` only when the task needs outside sources. Workers are told to treat fetched content as data and never to use `fetch_content`'s `auth` (browser cookies).
- Workers load your installed extensions, because provider login is an extension.
- An `implement` worker's bash reads and writes anywhere and reaches the network (npm, curl). Only git remotes and `gh` are cut off, and `git -c` undoes the git cut.

## Guard

`extensions/guard.ts` asks before these bash commands run, and blocks them when Pi has no UI:

- A push to `main` or `master`, a push with no branch after `cd`, `checkout`, `switch`, or `-C`, and any force push.
- History rewrites: `commit --amend`, `rebase`, `filter-repo`, `filter-branch`.
- Discarding work: `reset --hard`, `clean -f`, `checkout --`, `checkout .`, `checkout -f`, `restore` (working tree), `switch -f`, `stash drop`, `stash clear`, `branch -D`.
- A recursive `rm`, unless each target is a build directory (such as `dist`, `build`, `node_modules`, `coverage`) or a named item in a temp directory. `/tmp/*` and `$TMPDIR/x` always ask.

It finds these inside quotes, subshells, `sh -c`, `eval`, `env`, `xargs`, and full paths. Pushes to feature branches, PRs, and `rm` of a single file run without a question. It matches text and does not parse shell, so variables, aliases, and scripts can get past it, and quoted text that looks like a command can ask (commit messages excepted). It is a safety net; the policy is the rule. Use `/guard off` or `/guard on` for the session. In `implement` workers, `workerRisk()` adds worker-only blocks (see Implement) that apply with no prompt.

## `Skill`

`extensions/skill.ts` loads a skill's instructions by name for the main session and workers. It offers only skills that Pi found, and refuses skills with `disable-model-invocation`; start those with `/skill:<name>`. This repo has no skills. Install them in `~/.agents/skills` (all projects) or `.agents/skills` (one project).

## Extend

- **Worker procedure:** install a skill and write "Load the `X` skill first" in the task. Read-only workers report edit, command, and question steps as BLOCKED.
- **Guard rule:** add a check to `classify()` in `extensions/guard.ts` and cases to `extensions/guard.test.mjs`.
- **Policy:** edit `GLOBAL_AGENTS.md`, then start a new session.
- **Extension:** add the `.ts` file to `extensions/` and to `pi.extensions` in `extensions/package.json`.

## Check

Requires Node 22.19.0 or later. When you upgrade Pi, update the pinned `@earendil-works/pi-coding-agent` dev dependency and the lock file to the same version.

```bash
npm ci --prefix extensions        # once, and after package-lock.json changes
npm run check --prefix extensions
```

The check runs Biome (lint and format, `--write`), `tsc --noEmit`, `node --test`, `bin/install.test.sh`, and `git diff --check HEAD`. It stops at the first failure.
