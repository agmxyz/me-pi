# me-pi

A setup for the [Pi](https://pi.dev) coding agent:

- `GLOBAL_AGENTS.md`: one policy for every session and worker: output style, engineering defaults, what needs your approval, and how to treat secrets and instructions found in content.
- `delegate`: sends reading, research, reviews, and drafts to separate `pi` workers. Only their answers come back.
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

Optionally configure ordered model pools and thinking levels in `~/.pi/agent/delegate.json` (local). Pick them with `/delegate models` or edit the file by hand. The same model may appear in both pools:

```json
{
  "version": 2,
  "scout": { "models": ["openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"], "thinking": "low" },
  "worker": { "models": ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5-5"], "thinking": "max" }
}
```

The first model is tried first. Scout uses its pool with `low` or `off`; every other role shares the worker pool and its thinking level. On rate limits, overloads, or model-unavailable errors, the worker tries the next model and reports each fallback. Other failures stop. A `runs[].model` from the active pool is tried first, then the rest of that pool; one found only in the other pool is an exact-model request. With no models in a pool, that role uses the session model. The old `{ "models": [...], "default": "..." }` config remains readable and is migrated when `/delegate models` saves.

Run `/reload` to refresh the tool's pool choices. The tool reads the file at each call and names any problem in it. `/delegate status` shows each pool's order and availability, missing tools, running calls, and the last 20 calls with their cost. The call list survives `/reload`. `/delegate models` opens separate searchable lists for Scout and Worker: type to filter, Enter adds or removes a model, Ctrl+S finishes each list, and Esc cancels. It then lets you choose thinking for each pool and writes the file (mode 0600) after confirmation. It offers `/reload` only when the agent is idle and no workers run.

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

To remove old context between tasks, use `/handoff <next goal>`, `/tree`, or `/compact`.

## `delegate`

A call is `{ task, role?, web?, answer?, output?, runs?, rebuttal? }`. Only `task` is required. The worker sees only the task, so the task must name the goal, the paths, and the acceptance criteria.

| Role | For | Model, thinking | Web | Answer |
|---|---|---|---|---|
| `general` (default) | Any read-only task | Worker pool, configured thinking (`max` by default) | no | Set by the task |
| `scout` | Find or explain code | Scout pool, `low` by default (`off` also allowed) | no | `path:line` evidence, or `not-found` |
| `research` | Docs and web | Worker pool, configured thinking | yes | Findings with sources |
| `review` | A diff before a commit | Worker pool, configured thinking | no | `path:line: severity: problem. Fix:` |
| `challenge` | Argue against a plan | Worker pool, configured thinking | yes | Premise, challenges, verdict |

With no configured pool, roles use the session model. With no config file, scout defaults to `low` and other roles to `max`.

- `runs`: 1 to 4 `{ model, thinking }` entries, run in parallel. Thinking defaults to the role's pool setting; scout stays at `low`/`off` even if asked for a higher level. Worker roles accept any thinking level. Models outside both pools are refused when pools are configured.
- `rebuttal: true` (2+ runs): each worker sees the others' answers and keeps, revises, or retracts its claims. Only round 2 comes back; round 1 goes to a temp file.
- `web`: turns the web tools on or off for any role. The label shows `web`.
- `answer`: replaces the role's answer format, 1 to 400 characters.
- `output: true`: each run gets `write`, but only inside its own new temp directory (mode 0700). The answer lists the files and their sizes, not their contents. Copy what you keep and check the diff. The tool does not delete these directories.

Results: answers over 12 KiB are cut and saved in full to a temp file (mode 0600). Worker cost is added to the session usage. In the TUI, a running call shows each worker's turn, cost, and last tool; a result shows one line per run, and Ctrl+O expands the answers as Markdown. The model gets the full text either way.

Reviews: workers cannot run git. Write the diff to a file first (`git add -N` new files, then `git diff HEAD > /tmp/x.diff`), pass its path, and do not edit those files until the review returns.

### Limits

- Time: 300 s for `scout`, 900 s for the other roles. Cost: $5 for each worker, checked after each reply. A final answer over the cap is kept.
- Wrap-up budget: after 30 tool calls (`scout`) or 100 (other roles), 80% of the time limit, or 80% of the cost cap, the worker's tool calls are blocked with "give your final answer now". So the worker answers before a hard limit stops it. Every tool call counts, including blocked ones. After 3 ignored budget blocks, the run ends and its last text comes back as a partial answer. The budget is checked at each tool call, so it cannot stop one long reply; only the hard time limit does.
- On a limit, a cancel, the end of the session, or a normal exit of Pi, the tool SIGKILLs the worker's process group. A process that leaves the group keeps running (for example, `fetch_content`'s GitHub clones). With `output: true`, a stopped worker can leave incomplete files; the answer lists them.
- If the main Pi process is killed, workers can keep running. Find them with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'` and stop each with `kill -- -<pid>`.

### Safety

Workers get `read`, `grep`, `find`, `ls`, and `Skill`, and the web tools if `web` is on. They never get `bash` or `edit`, nor `write` without `output`. They start with `--no-mcp`. A worker that needs a missing step reports `BLOCKED: ...`.

This is not a sandbox:

- `read` reaches files outside the project. The tool blocks `read`, `grep`, `find`, and `ls` calls that name likely secrets (`.env*` except `.example`, `.sample`, `.template`; `.npmrc`, `.netrc`, `.git-credentials`, private keys, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.pi/agent/auth.json`), also through symlinks and globs. A broad search such as `grep TOKEN .` can still match them.
- Web access is a prompt-injection risk: a fetched page can tell a worker to read a local file and send it to a URL. Turn on `web` only when the task needs outside sources. Workers are told to treat fetched content as data and never to use `fetch_content`'s `auth` (browser cookies).
- Workers load your installed extensions, because provider login is an extension.

## Guard

`extensions/guard.ts` asks before these bash commands run, and blocks them when Pi has no UI:

- A push to `main` or `master`, a push with no branch after `cd`, `checkout`, `switch`, or `-C`, and any force push.
- History rewrites: `commit --amend`, `rebase`, `filter-repo`, `filter-branch`.
- Discarding work: `reset --hard`, `clean -f`, `checkout --`, `checkout .`, `checkout -f`, `restore` (working tree), `switch -f`, `stash drop`, `stash clear`, `branch -D`.
- A recursive `rm`, unless each target is a build directory (such as `dist`, `build`, `node_modules`, `coverage`) or a named item in a temp directory. `/tmp/*` and `$TMPDIR/x` always ask.

It finds these inside quotes, subshells, `sh -c`, `eval`, `env`, `xargs`, and full paths. Pushes to feature branches, PRs, and `rm` of a single file run without a question. It matches text and does not parse shell, so variables, aliases, and scripts can get past it, and quoted text that looks like a command can ask (commit messages excepted). It is a safety net; the policy is the rule. Use `/guard off` or `/guard on` for the session.

## `Skill`

`extensions/skill.ts` loads a skill's instructions by name for the main session and workers. It offers only skills that Pi found, and refuses skills with `disable-model-invocation`; start those with `/skill:<name>`. This repo has no skills. Install them in `~/.agents/skills` (all projects) or `.agents/skills` (one project).

## Extend

- **Worker procedure:** install a skill and write "Load the `X` skill first" in the task. Workers report edit, command, and question steps as BLOCKED.
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
