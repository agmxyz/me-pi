# me-pi

A setup for the [Pi](https://pi.dev) coding agent:

- `GLOBAL_AGENTS.md`: one policy for every session and worker: output style, engineering defaults, what needs your approval, and how to treat secrets and instructions found in content.
- `delegate`: sends reading, research, reviews, drafts, and self-contained changes to separate `pi` workers. Only their answers come back; an `implement` worker commits on your current branch and hands back 2 lines.
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

Talk to the main session as usual. It plans, edits, tests, and commits, and the `delegate` tool's guidelines tell it when to call workers by itself: for reading many files, research, reviews before multi-file or behaviour-changing commits, plan challenges, and any change whose files it has not read or that takes many steps (`implement`). You can also ask directly:

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

A call is `{ task, role?, web?, answer?, output?, runs?, rebuttal?, background?, check? }`. Only `task` is required. The worker sees only the task, so the task must name the goal, the paths, and the acceptance criteria.

| Role | For | Model, thinking | Web | Answer |
|---|---|---|---|---|
| `general` (default) | Any read-only task | Worker pool, configured thinking | no | Set by the task |
| `scout` | Find or explain code | Scout pool, `low` or `off` | no | `path:line` evidence, or `not-found` |
| `research` | Docs and web | Worker pool, configured thinking | yes | Findings with sources |
| `review` | A diff before a commit | Worker pool, configured thinking | no | `path:line: severity: problem. Fix:` |
| `challenge` | Argue against a plan | Worker pool, configured thinking | yes | Premise, challenges, verdict |
| `implement` | A change with a check | Worker pool, configured thinking | no | One-sentence summary, then BLOCKED lines; the tool builds a 2-line handback |

With no configured pool, roles use the main session's model and thinking level; scout caps the level at `low` (`off` stays `off`). If Pi does not report the session's thinking level, the call fails and asks for a pool-level `thinking` or `runs[].thinking`.

- `runs`: 1 to 4 `{ model, thinking }` entries, run in parallel. Thinking defaults to each candidate model's setting; an explicit `runs[].thinking` overrides the pool's settings for all candidates. Scout stays at `low`/`off` even if asked for a higher level. Worker roles accept any thinking level. Models outside both pools are refused when either pool contains models. `implement` refuses `runs[].model` and `runs[].thinking`: it uses the worker pool in `delegate.json` in order, with each entry's thinking level and fallbacks.
- At most 4 workers run at once across all calls, foreground and background; a call that would exceed this is refused, not queued.
- `rebuttal: true` (2+ runs): each worker sees the others' answers and keeps, revises, or retracts its claims. Only round 2 comes back; round 1 goes to a temp file.
- `web`: turns the web tools on or off for any role. The label shows `web`.
- `answer`: replaces the role's answer format, 1 to 400 characters.
- `output: true`: each run gets `write`, but only inside its own new temp directory (mode 0700). The answer lists the files and their sizes, not their contents. Copy what you keep and check the diff. The tool does not delete these directories.
- `check` (`implement` only, required): the command, run from your cwd, that proves the change. The worker must run it alone, exactly as given, after its last edit. Refused for other roles, and when it contains `|`, `;`, `&&`, or `||` (a chained check can never match the worker's run).
- `implement` refuses `answer`, `runs` with more than 1 entry or with `model` or `thinking`, `rebuttal`, `output`, and `web: true`.
- `background: true`: the call returns a job id (`bg1`, `bg2`, …) at once and the conversation goes on. When the workers finish, the answer arrives as a `delegate` message that starts a turn (queued as a follow-up if the session is busy). The turn's abort does not stop a background job; `/delegate cancel <id>` does, and its report arrives without starting a turn. Ending or switching the session (`/reload`, `/new`, `/resume`, `/fork`, a handoff, or exit) stops background jobs and their answers are lost. Pi's session usage does not include background cost, so the status line shows background jobs running and their spend for this Pi process, kept across `/reload`.

Results: answers over 12 KiB are cut and saved in full to a temp file (mode 0600). Worker cost is added to the session usage. In the TUI, a running call shows each worker's turn, cost, and last tool; a result shows one line per run, and Ctrl+O expands the answers as Markdown. The model gets the full text either way.

Reviews: read-only workers cannot run git. Write the diff to a file first (`git add -N` new files, then `git diff HEAD > /tmp/x.diff`), pass its path, and do not edit those files until the review returns.

### Implement

One `implement` worker edits, runs `check`, and commits on your current branch, in your checkout. The main session may not edit or git-write in that repo until the handback; use `background: true` to keep talking. Worktree mode (a temp worktree per job, merged back after review) was dropped: on the same task it took 237 s and about 23k main-session context, against 127 s and about 20k when the main session did the work itself, because of the merge ceremony.

- **Use.** Before a goal's first implement, commit your work, `git switch -c goal/<slug>` if on `main`/`master`, and note the base SHA. Call with `background: true`, and give the goal, repo-relative paths, acceptance criteria, and `check`. Trust a ✓ handback (no diff read, no review, no re-check). For ✗ WIP, send a follow-up implement or `git revert`; for a tripwire ✗, stop and tell the user. At goal end, run one `review` of `git diff <base>..HEAD` written to a temp file, tell the reviewer which check passed (from the handbacks) so it does not report the check as BLOCKED, and fix findings by follow-up. Never push a range containing a `WIP(delegate` commit.
- **Prepare.** Refused before any worker starts, leaving nothing behind, unless the cwd is in a git repo with a commit, HEAD is on a branch that is not `main` or `master` (`git switch -c goal/<slug>` first), no merge, rebase, cherry-pick, or revert is in progress, and `git status --porcelain` is empty (untracked files count). One job per repo: the lock `<git-common-dir>/me-pi-implement.lock` holds `<pid> <id>`, created atomically (written to a temp file, then linked). A live pid, or content that does not parse, refuses the call and names the job; a dead pid's lock is taken over. If HEAD's subject starts with `WIP(delegate`, the worker is told to finish that first.
- **Environment.** The worker runs in your cwd. Tools: `read,grep,find,ls,Skill,edit,write,bash`. `edit` and `write` are allowed only inside the repo (`ME_PI_OUTPUT_DIR`) and never inside the git common dir (`ME_PI_DENY_DIR`), so hooks are fenced too. Git remotes are cut off by appending `protocol.{ssh,https,http,git}.allow=never` after any `GIT_CONFIG_*` you set; `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` are unset and `GH_CONFIG_DIR` is an empty temp dir. The worker gets `--approve` only when your session trusts the project and it is the first model attempt (a clean tree means `.pi` equals the trusted HEAD); otherwise `--no-approve`. `ME_PI_PARENT` is the main Pi pid: when it is gone, or the worker's parent is pid 1, the worker's next tool call is blocked and the run ends.
- **Worker rules.** Inside an implement worker, bash blocks `git push`, `git worktree`, `git switch`, `git checkout`, `git merge`, `git cherry-pick`, `git pull`, `git stash` (except `list` and `show`), `git commit -n`/`--no-verify`, `gh`, `git config` writes, `git remote`, `git update-ref`, `git symbolic-ref` writes, `git branch -m`, `git tag -f`/`-d`, `install.sh` (run directly, or via `sh`, `bash`, `zsh`, `.`, or `source`), and `pi install|remove|uninstall|update|config`. Blocked steps come back as BLOCKED.
- **Check.** The tool watches the worker's bash calls. A call whose command equals `check` (whitespace collapsed; a leading `rtk ` and a trailing `2>&1` allowed; any `|` or `;` disqualifies) sets the check to pass or fail from Pi's error flag; a successful `edit` or `write` after it makes it stale. The state carries across model fallbacks.
- **Main session during a job.** Until the handback, the main session's `edit` and `write` inside the repo are blocked, and so is bash running a git tree write (`add`, `rm`, `mv`, `commit`, `merge`, `rebase`, `reset`, `restore`, `checkout`, `switch`, `stash` except `list`/`show`, `cherry-pick`, `revert`, `am`, `apply`, `pull`, `clean`, `update-index`, `read-tree`, `checkout-index`, `sparse-checkout`, `submodule`, `update-ref`, `symbolic-ref`, and `branch -f/-m/-M/-d/-D`) there. Bash counts as there when a `git -C <dir>` or leading `cd <dir>` target is inside the repo, or else when the cwd is inside it or the command names it. Reads (`git log`, `status`, `diff`) pass. The message names the job and, for a background job, `/delegate cancel <id>`.
- **Finish.** When the worker ends, is stopped, or the session ends (shutdown waits for this), and it never throws: if HEAD is no longer the job's branch, it is ✗ "HEAD moved" with no WIP commit. Otherwise uncommitted work becomes one `WIP(delegate im<n>): <reason>` commit on the branch (hooks and signing off; the reason is the failure's first line, at most 200 characters), which is ✗. Then `base..tip` is read from git; ✗ if the base is not an ancestor of the tip, if any commit is a merge, or if any commit is older than the job start minus 60 s (a fast-forward to existing work). Tripwires are ✗ too: a ref under `refs/heads`, `refs/tags`, or `refs/stash` other than the job's branch moved or was deleted (new refs and tags, and `refs/remotes`, are fine); local git config (other than upstream tracking) or the common dir's `hooks/`/`info/` changed; the `packages`, `extensions`, `skills`, `prompts`, or `themes` keys of `~/.pi/agent/settings.json` changed; or `.pi` or `.agents` changed in the range ("review before /reload"). Tripwires report; they never restore. Last, it writes the details file, releases the lock if it still holds this job's id, and removes the gh dir.
- **Handback.** The tool result is two lines, for example:

  ```
  ✓ im3 goal/x 9f8e7d6..1a2b3c4: 2 commits, 3 files +40 -5; check ✓ `npm run check --prefix extensions` [glm-5.3-flash @high $0.04 118s]
  Added the retry option. Details: $TMPDIR/me-pi-delegate-<pid>/im3.md
  ```

  The second line is the worker's first line (at most 200 characters, control characters quoted). Extra lines appear only when needed: up to 3 `BLOCKED:` lines (`+N more BLOCKED in details`) and ✗ lines (the failure, WIP, a failed, stale, or missing check, range problems, tripwires). ✓ only when the worker answered, there is no WIP and no ✗, and the check passed. The details file (0600) holds the commits, diffstat, check runs, full answer, tools, fallbacks, and stderr tail; there is no diff file. The TUI view keeps the full answer. `/delegate status` lists each implement call's `branch base..tip`, the check state, and `WIP` when there is one.

### Limits

- Time: 300 s for `scout`, 1800 s for `implement`, 900 s for the other roles. Cost: $5 for each worker, checked after each reply. A final answer over the cap is kept.
- Wrap-up budget: after 30 tool calls (`scout`) or 100 (other roles), 80% of the time limit, or 80% of the cost cap, the worker's tool calls are blocked with "give your final answer now". So the worker answers before a hard limit stops it. Every tool call counts, including blocked ones. After 3 ignored budget blocks, the run ends and its last text comes back as a partial answer. The budget is checked at each tool call, so it cannot stop one long reply; only the hard time limit does.
- On a limit, a cancel, the end of the session, or a normal exit of Pi, the tool SIGKILLs the worker's process group. An `implement` worker gets SIGTERM first (Pi then stops its bash commands), and SIGKILL after 3 s, before the WIP commit; on a hard exit of the main process it gets SIGKILL only. A process that leaves the group keeps running (for example, `fetch_content`'s GitHub clones). With `output: true`, a stopped worker can leave incomplete files; the answer lists them.
- If the main Pi process is killed, workers can keep running. Find them with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'` and stop each with `kill -- -<pid>`.

### Safety

Read-only workers get `read`, `grep`, `find`, `ls`, and `Skill`, and the web tools if `web` is on. They never get `bash` or `edit`, nor `write` without `output`. `implement` also gets `edit`, `write`, and `bash`, and never the web tools. All start with `--no-mcp`. A worker that needs a missing step reports `BLOCKED: ...`.

This is not a sandbox:

- `read` reaches files outside the project. The tool blocks `read`, `grep`, `find`, and `ls` calls that name likely secrets (`.env*` except `.example`, `.sample`, `.template`; `.npmrc`, `.netrc`, `.git-credentials`, private keys, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.pi/agent/auth.json`), also through symlinks and globs. A broad search such as `grep TOKEN .` can still match them.
- Web access is a prompt-injection risk: a fetched page can tell a worker to read a local file and send it to a URL. Turn on `web` only when the task needs outside sources. Workers are told to treat fetched content as data and never to use `fetch_content`'s `auth` (browser cookies).
- Workers load your installed extensions, because provider login is an extension.
- An `implement` worker writes in your real checkout, not a copy. Its bash reads and writes anywhere and reaches the network (npm, curl). Only git remotes and `gh` are cut off, and `git -c` undoes the git cut. Ignored files (such as `.env`) cannot be restored from git.
- A hard kill of the main Pi process leaves a dirty tree and a stale lock; the lock frees itself once its pid is dead (the next `implement` takes it over), the worker stops at its next tool call, and the tree needs a manual commit or cleanup.
- A bash child that ignores SIGTERM can outlive the stop and still write while the WIP commit is made.
- Check matching is textual: a bash `sed` or other write after the check is not seen, so the check stays ✓.
- Edits that you or the main session make through an editor or a bash write (not a git tree write) during a job end up in the worker's commits.
- In the live me-pi checkout, workers and `/reload` load worker-edited extensions. Run me-pi goals in a clone.
- WIP commits break `git bisect` until fixed. There are no parallel writes in one repo.

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
