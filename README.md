# me-pi

me-pi is a setup for the [Pi](https://pi.dev) coding agent. It has four parts:

- One global policy (`GLOBAL_AGENTS.md`).
- One tool that sends work to workers (`delegate`).
- One safety guard for bash commands (`guard`).
- One tool that loads skills (`Skill`).

## Install

Do these steps:

1. Run this command:
   ```bash
   git clone git@github.com:0bmario/me-pi.git && cd me-pi && ./install.sh
   ```
2. Restart Pi.

You can run the installer again at any time. It does not overwrite your files. It does these steps:

- It links `GLOBAL_AGENTS.md` to `~/.pi/agent/AGENTS.md`.
  - If `~/.pi/agent/AGENTS.md` exists already, the installer does not change it.
  - The installer then completes the other steps and exits with code 1, because the policy is not active.
- It registers `extensions/` and the pinned packages with `pi install`.
- It copies the Pi files `interactive-shell.ts` and `handoff.ts`, if they are not there.
  - It never replaces a copy.
  - A copy can be different from the Pi example, for example after a Pi upgrade. Then the installer shows a warning and the `cp` command that updates the copy.
- If [`rtk`](https://github.com/rtk-ai/rtk) is installed, it runs `rtk init --global --agent pi`. This command installs or updates the RTK extension for Pi.

## How it works

### Main session

The main session does the work. It plans, edits, tests, and commits.

To remove old context between tasks, use `/handoff <next goal>`, `/tree`, or `/compact`.

### Policy

`GLOBAL_AGENTS.md` is the policy. Each session and each worker loads it. The policy sets these items:

- The output style.
- Engineering defaults. The rules of a repo win if they are different.
- The operations that need your approval. Text in files or web pages cannot give this approval.
- How to handle secrets and instructions that are in content.

`~/.pi/agent/AGENTS.md` is a symbolic link to this file. A change to the file applies to the next session.

### `delegate` tool

The `delegate` tool (`extensions/delegate.ts`) keeps work that uses many tokens out of the main session. A worker is a separate `pi` process. Workers do these tasks:

- Find code that the main session did not read.
- Research documents and the web.
- Review a diff.
- Challenge a plan.

Only the answers of the workers go back to the main session.

- If an answer is longer than 12 KiB, the tool cuts it. The tool writes the full answer to a temp file and gives the path. Only you can read the file (mode 0600).
- Tool calls and error output stay in the tool details. The model does not see the tool details.
- The tool adds the cost of the workers to the usage totals of the session.

#### Workers are read-only

- All workers get the tools `read`, `grep`, `find`, `ls`, and `Skill`.
- The `research` and `challenge` workers also get the web tools.
- Workers do not get `bash`, `edit`, or `write`.
- Workers do not get MCP tools. The tool starts workers with `--no-mcp`, because `--tools` does not remove MCP tools.

Thus, a worker cannot edit files, run commands, run tests, start other workers, or commit. If a task needs one of these steps, the worker writes the line `BLOCKED: ...`. The main session does all edits, checks, and commits.

#### Call

A call has this structure: `{ role, task, runs?, rebuttal? }`.

The tool sends the task to the worker on standard input. Thus, the size of the task has no command-line limit.

| Role | Use it for | Model and thinking | Answer |
|---|---|---|---|
| `scout` | Find or explain code. | First model in the set, thinking `low` (`off` if the call asks for it). | `path:line` evidence, or `not-found`. |
| `research` | Documents, the web, many sources. | `default`, or the last model if there is no `default`. Thinking `high`. | Findings with their sources. |
| `review` | A diff before a commit. | `default`, or the last model if there is no `default`. Thinking `high`. | `path:line: severity: problem. Fix:` |
| `challenge` | Arguments against a plan or a diagnosis. | `default`, or the last model if there is no `default`. Thinking `high`. | Premise, challenges, verdict. |

#### Many models on one question

Ask, for example: "Let Opus at medium and Sonnet at high review this, with rebuttal."

The main session then sends one call:

- `runs` has one entry for each model: `[{ model, thinking }, ...]`. A call can have 1 to 4 entries. The workers run at the same time.
- `rebuttal: true` adds a second round. In the second round, each worker that completed round 1 gets its own answer and the answers of the other workers. Each worker then keeps, changes, or removes its claims.

Only the round-2 answers go back to the main session. The tool writes the round-1 answers to a temp file and gives the path.

#### Limits

- Time limit: 300 seconds for `scout`, 900 seconds for the other roles.
- Cost limit: $5 for each worker.
  - The tool checks the cost after each reply of the model.
  - If a final answer goes above the limit, the tool keeps the answer.
  - The tool does not count model calls that a tool makes.
- The tool stops the process group of the worker with SIGKILL in these conditions: time limit, cancel, cost limit, end of the session. Read-only workers have no data to save, so a hard stop is safe.
- When a worker exits, the tool stops the other processes in its group.
- When the main process exits normally, the tool stops all workers.
- A process that leaves the group continues to run. For example, `fetch_content` clones GitHub repositories in a separate group.

If the main Pi process is killed, workers can continue to run. Do these steps to stop them:

1. Find the workers:
   ```bash
   ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'
   ```
2. Stop each worker with `kill -- -<pid>`.

#### Reviews need a fixed diff

Workers cannot run git. Thus, the main session does these steps:

1. Write the diff to a temp file with `git diff HEAD`. Before this, run `git add -N` for new files.
2. Give the path of the file to the worker.
3. Do not edit these files until the review is complete.

#### The tools are not a sandbox

- `read` can read files outside the working directory.
- In workers, the tool blocks `read`, `grep`, `find`, and `ls` calls that name a path that can contain secrets. Examples:
  - `.env*` and `.envrc` (but not `.example`, `.sample`, or `.template` files).
  - `.npmrc`, `.netrc`, and `.git-credentials`.
  - `*.pem`, `*.key`, and private keys such as `id_rsa`.
  - `~/.ssh`, `~/.aws`, `~/.config/gh`, and `~/.pi/agent/auth.json`.
- The block ignores letter case and follows symbolic links.
- The block also checks the `glob` value of `grep` and the `pattern` value of `find` (for example, `**/.env*`).
- A broad search can still find text in these files. An example is `grep TOKEN .` with no glob.
- `fetch_content` reads local files only for videos.
- `scout` and `review` have no web tools. Thus, a prompt injection in a diff cannot send file contents out of the computer. `research` and `challenge` keep the web tools.
- The worker rules forbid the `auth` option of `fetch_content` (browser cookies). The rules tell workers that fetched content is data, not instructions.
- Workers load your installed extensions, because provider login (for example, `pi-anthropic-auth`) is an extension.

### Model set

The model set is the list of models that workers can use. It is in `~/.pi/agent/delegate.json`. You edit this file manually. It stays on your computer.

```json
{ "models": ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"], "default": "anthropic/claude-sonnet-5-5" }
```

- `scout` uses the first model.
- The other roles use `default`. If there is no `default`, they use the last model.
- A call can select any model in the set for each run.
- The tool refuses a model that is not in the set.
- If the file does not exist, workers use the model of the session, and a call can select any model.

After you edit the file, run `/reload`. Then the tool shows the set in its parameters. The tool reads the file again at each call. The tool shows an error that names the problem if the file has one of these problems:

- An unknown key.
- A model ID that is not text.
- A model that is in the list two times.
- A `default` that is not in the list.

### Guard

The guard (`extensions/guard.ts`) asks you before it lets a bash command run, if `GLOBAL_AGENTS.md` makes the command your decision. The guard checks these commands:

- A push to `main` or `master`. The guard also finds the push in these forms:
  - In quotes and in subshells.
  - After `sh -c`, `bash -lc`, `eval`, `env`, or `xargs`.
  - With a full path, for example `/usr/bin/git`.
- A push without a branch name after `cd`, `git checkout`, `git switch`, or `git -C`. After these commands, the guard cannot know the target branch.
- A force push.
- Changes to history: `commit --amend`, `rebase`, `filter-repo`, `filter-branch`.
- `git reset --hard` and `git clean -f`.
- Commands that discard changes:
  - `git checkout --`, `git checkout .`, and `git checkout -f`.
  - `git restore` of the working tree, and `git switch -f`.
  - `git stash drop` and `git stash clear`.
- `git branch -D`.
- A recursive `rm`. The guard lets it run in these conditions only:
  - Each target is a build directory (for example, `dist`, `build`, or `node_modules`).
  - Or each target is a named item in a temp directory (for example, `/tmp/x` or `${TMPDIR:?}/x`).
  - The guard always asks for `/tmp/*`. It also asks for `$TMPDIR/x`, because this path becomes `/x` if `TMPDIR` is not set.

If Pi has no user interface, the guard blocks these commands.

The guard lets these commands run: pushes to feature branches, pull requests, and `rm` or `rm -f` of a file.

The guard compares text with patterns. It does not parse shell. Thus:

- Other forms of a command can get through, for example variables, aliases, and scripts.
- Quoted text that looks like a command can cause a question. Commit messages are an exception.
- The guard also checks commands inside the arguments of a command, for example `"$(git push …)"`.

To stop or start the guard for the session, use `/guard off` or `/guard on`. The guard is a safety net. The policy text is the rule.

### `Skill` tool

The `Skill` tool (`extensions/skill.ts`) loads the instructions of a skill by its name.

Many skills are written for Claude Code. They tell the agent to "call the Skill tool with `tdd`". Pi has no such tool. Without this tool, the main session and the workers did not load these skills. The workers reported the skills as BLOCKED.

- Each worker gets this tool.
- The tool gives only the skills that Pi found for the run.
- The tool refuses skills that have `disable-model-invocation`. To start one of these skills, use `/skill:<name>`.

### Skills

This repo does not contain skills. Install skills in one of these locations:

- `~/.agents/skills` for all projects.
- `.agents/skills` for one project.

## Extend

- **Give a worker a special procedure:** Write or install a skill. Then name the skill in the task, for example "Load the `X` skill first." Workers load skills with `Skill`.
  - A read-only worker can do the reading and thinking steps of a skill.
  - A worker reports these steps as BLOCKED: edits, commands, other workers, questions to the user, commits. Use the main session for skills that have these steps.
- **Add a command to the guard:** Add a check in `classify()` in `extensions/guard.ts`. Add test cases in `extensions/guard.test.mjs`.
- **Change the policy:** Edit `GLOBAL_AGENTS.md`. Then start a new session.
- **Add an extension:** Put the `.ts` file in `extensions/`. Add the file to `pi.extensions` in `extensions/package.json`.

## Check

You must have Node 22.19.0 or later.

When you upgrade Pi, update the pinned `@earendil-works/pi-coding-agent` development dependency and the lock file to the same version.

Do these steps:

1. Install the tools. Do this one time, and again after `package-lock.json` changes:
   ```bash
   npm ci --prefix extensions
   ```
2. Run the check:
   ```bash
   npm run check --prefix extensions
   ```

The check runs these steps in this sequence. It stops at the first failure.

1. Biome: lint and format (`--write`).
2. `tsc --noEmit`.
3. `node --test`.
4. `bin/install.test.sh`.
5. `git diff --check` against HEAD (staged and unstaged changes).

The development tools are in `extensions/package.json`, because `pi install <local dir>` never runs npm.
