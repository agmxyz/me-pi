# Write worker: the `implement` role (slice 2)

Status: design, not implemented. Base: branch `generic-delegate-worker` at `e70acfb`. Code line numbers refer to that tree; README line numbers refer to the working tree, which already documents that background jobs stop on `/new`, `/resume`, `/fork`, and handoff (uncommitted). Pi refs are to `extensions/node_modules/@earendil-works/pi-coding-agent` 1.3.0 (`dist/` unless noted).

Evidence tags: **(verified)** checked against code or by a command while writing this doc. **(measured)** measured earlier by the user. **(unverified)** not checked yet; the test plan covers it.

## Goal

Make `~/.agents/skills/chief-of-staff/SKILL.md` work in a Pi main session: "all work in subagents, background agents, protect your context". Slice 1 (`1f9f127`, `e70acfb`) added background jobs: `background: true`, job ids, followUp delivery, `/delegate cancel`, a 4-worker cap, and a spend status line. Every worker is still read-only, so the main session still writes all code. Slice 2 adds one write-capable role, `implement`. It edits, runs checks, and commits on its own branch in a temp worktree. The main session gets back facts, not the diff.

Non-goals for slice 2: an OS sandbox (slice 4), a scheduler (Pi 1.3.0 has none; docs list none (verified); later a launchd job running `pi -p`), parallel implement panels, and jobs that survive `/reload`.

## Recommended design

### Call surface

- `role: "implement"`. Tools: `read,grep,find,ls,Skill,edit,write,bash`. No web tools. Model and thinking come from the worker pool, as for every non-scout role (`delegate.ts:433-434`).
- Refused for implement, before a worker starts: `runs` with more than 1 entry, `rebuttal`, `output`, `web: true`. These checks go with the others at `delegate.ts:1074-1109`.
- New parameter `branch` (implement only): an existing `delegate/*` branch to continue, instead of a new branch from HEAD. **Addition:** without it, a follow-up task cannot finish a WIP branch, because a new branch from main HEAD does not contain the WIP commits. It is refused if the name lacks the `delegate/` prefix or the branch does not exist. Git refuses a branch that is already checked out in another worktree.
- `background: true` is recommended in the guidelines, not required. A foreground implement call blocks the turn for up to 900 s, and the turn's abort cancels it, which produces a WIP commit.
- Limits stay as they are: 900 s, 100 tool calls, $5 (`delegate.ts:32-42`, `:731`, `:601`). The 4-worker cap already counts an implement run as 1 worker (`delegate.ts:1121-1126`).
- `answer` may still replace the answer format. The extension's facts block (below) is always appended.

### Worktree and branch (main process, before spawn)

1. `git -C <ctx.cwd> rev-parse --show-toplevel --show-prefix HEAD` gives the repo root, the cwd prefix inside it, and the base SHA. Fail loudly when the cwd is not in a repo or has no commits.
2. Implement id: `im<n>` from a per-implement counter on `globalThis`, as the spend is kept (`delegate.ts:1041-1046`), for foreground and background calls alike. **Correction:** only background calls get a job id (`bg<n>`, `delegate.ts:1259`); a foreground call's `_id` is Pi's tool-call id, so neither the branch nor `WIP(delegate <id>)` would be defined. Branch name: `delegate/<YYYYMMDD-HHMMSS>-im<n>`, for example `delegate/20261020-214012-im3`. Plain `delegate/im<n>` collides: the counter restarts in each new Pi process, and leftover branches are expected (slice 3 lists them). `git worktree add -b` refuses an existing name, so a collision fails loudly.
3. `mkdtemp($TMPDIR/me-pi-delegate-wt-)` (mode 0700), then:
   - New branch: `git worktree add -b <branch> <dir> <base>`.
   - With `branch`: `git worktree add <dir> <branch>`, base = `git merge-base HEAD <branch>`, start = the branch tip.
   Adding a worktree into an empty mkdtemp directory works and took 23 ms on a small repo (verified). The worker's cwd is `<dir>/<prefix>`.
4. Snapshots for the tripwires (see Finish): the resource keys of `~/.pi/agent/settings.json`, and `git for-each-ref refs/heads refs/tags refs/stash`, the main session's current branch and tip, `git config --local --list`, and a hash of the common git dir's `hooks/` and `info/`.
5. The start message (or foreground progress) states the base SHA and the number of uncommitted files in the main tree. The worker does not get those files.

### Worker process

Spawn as today (`delegate.ts:582-606`), with these differences:

- `--tools read,grep,find,ls,Skill,edit,write,bash`.
- `--approve` only when all hold: `ctx.isProjectTrusted()` (`dist/core/extensions/types.d.ts:238`), a new branch (no `branch`), the first attempt (not a model fallback, which reuses the worktree), and `git diff --quiet <base> -- .pi .agents` in the worktree. Else `--no-approve`. **Correction:** with `branch` or on fallback, `.pi`/`.agents` may hold code an earlier worker wrote; main's trust covers only HEAD. **Addition:** the worktree path has no saved trust decision, and JSON mode cannot prompt. Without the flag, project `.pi` resources and project `.agents/skills` are silently skipped (Pi `docs/security.md`, "Project trust without an interactive prompt"). The user measured this for `.pi` extensions and saw no hang. The flag mirrors the main session's own decision for the same repo at HEAD, so it applies only while the worktree's trust-relevant files equal HEAD's.
- Environment: start from `process.env`, then:
  - `ME_PI_RUN=1`, `ME_PI_ROLE=implement`, and `ME_PI_BUDGET` as today.
  - `ME_PI_OUTPUT_DIR=<worktree root>`. This reuses `writeBlockedIn` (`delegate.ts:144-157`), so `edit` and `write` outside the worktree are blocked. Relative paths resolve inside, because cwd is in the worktree. Bash is not fenced.
  - Remote cut-off: append `protocol.{ssh,https,http,git}.allow=never` through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_i`, and `GIT_CONFIG_VALUE_i`. Start at the existing count; do not overwrite it. Verified here on git 2.53: `ls-remote https://…` gives "transport 'https' not allowed", while a push to a local path and to `file://` still succeeds. The user measured that ssh is also blocked and local clones work. `git -c` overrides this, so it prevents accidents, not misuse.
  - gh cut-off: unset `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`. Set `GH_CONFIG_DIR` to an empty 0700 temp dir. The user measured the result: "not logged into any GitHub hosts".
  - No generic token scrub. Provider keys stay, because Pi needs them.
- System prompt: `WORKER_CONTRACT` (shared lines) plus the implement lines (see Wording changes). They name the worktree, the branch, and the base.
- Model fallback (`delegate.ts:756-801`) retries in the same worktree, so the next model sees the previous attempt's work. The contract tells the worker to start with `git status` and `git log`.

### Worker-only rules (bash `tool_call`, inside the worker)

Add `export function workerRisk(command)` to `guard.ts`. It reuses `AT_COMMAND` and `GIT_COMMAND` (`guard.ts:19`, `:26`), so all shell matching stays in one file and is tested in `guard.test.mjs`. The delegate worker hook (`delegate.ts:1003-1018`) calls it for `bash` when `ME_PI_ROLE=implement`, and blocks with "Blocked: <reason>; list it as BLOCKED". It blocks:

| Command | Reason |
|---|---|
| `git push` (any target, including `.`) | push is main-session only; a local `git push . x:main` is not stopped by the protocol cut-off |
| `git worktree` | the extension owns worktrees |
| `git commit` with `-n` or `--no-verify` | hooks must run |
| `gh` | main-session only |
| `git config` writes, `git remote` | worktrees share the common dir's config: `core.hooksPath`, `remote set-url` would run or redirect in main's next commit/push |
| `git update-ref`, `git symbolic-ref`, `git branch -m`/`-M`, `git tag -f`/`-d` | move or rename shared refs, including main's current branch |
| `./install.sh`, `…/install.sh`, `sh` / `bash` / `zsh install.sh`; `pi install`, `pi remove`, `pi uninstall`, `pi update`, `pi config` | would register the temp worktree in `~/.pi/agent/settings.json` |

`guard.ts` itself also loads in workers, because workers load installed extensions. It blocks its usual set when there is no UI (`guard.ts:176-177`): amend, rebase, `reset --hard`, `branch -D`, and recursive `rm` outside build and temp dirs. The rules match only the command text the model sends. They never see processes that a script starts, so `npm run check` internals are unaffected (see Answers to c023d4d).

### Install guard and settings tripwire (fix a)

The repo's `AGENTS.md:1` tells agents to run `./install.sh`, which runs `pi install "$REPO/extensions"` (`install.sh:64`). Pi identifies local packages by resolved absolute path (Pi `docs/packages.md`, "Understand scope and identity"). So a worker in a worktree would register a second copy that vanishes with the worktree, and Pi would load both. The live install is `"../../fun/me-pi/extensions"` (`~/.pi/agent/settings.json:11`) (verified). Three layers:

1. A contract line (Wording changes).
2. The worker rules above.
3. A tripwire. Before spawn and after finish, compare only `packages`, `extensions`, `skills`, `prompts`, and `themes` in `$PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent`). **Correction:** do not compare the whole file. Pi writes `defaultModel` and the thinking level to the same file when the user switches models (`docs/settings.md:13-16`), so a whole-file check gives false alarms during long jobs. On a change, report a ✗ line with before and after, and do not restore automatically: the main session may have changed it on purpose.

### Stop, finish, report

**Stop (correction):** today `stop()` SIGKILLs the worker's process group (`delegate.ts:615-620`, `:495-502`). Pi's bash tool starts every command in its own process group (`dist/core/tools/bash.js:65`, `detached: true`) (verified). So a SIGKILL leaves the running command alive, for example `biome check --write` inside `npm run check`, while the finish step commits and removes the worktree. Pi's print and JSON mode handles SIGTERM by killing its tracked bash groups, then disposing and exiting (`dist/modes/print-mode.js:31-45`) (verified). For implement: SIGTERM the group, wait up to 3 s for `close`, then SIGKILL. Read-only roles keep the SIGKILL path. The synchronous `process.on("exit")` path (`delegate.ts:484-489`) can only SIGKILL, so a hard exit of the main process can orphan bash commands (Risks).

**Finish** must run in a promise that `running` tracks. **Correction:** today `running` holds only the per-run `runWorker` promises (`delegate.ts:1153-1161`), while finish lives in `call()`; so `session_shutdown`, which awaits `running` (`delegate.ts:1048-1052`), would return before the WIP commit and worktree removal. Add the whole implement `call()` promise (prepare through finish) to `running`. Pi awaits `session_shutdown` handlers in sequence, with no timeout, on reload (`dist/core/agent-session.js:2972`), on new, resume, and fork (`dist/core/agent-session-runtime.js:102-111`), and on quit (`:297-301`). See `runner.js:80-86` and `:813-819` (verified). The extra `/reload` delay is **(unverified)**; expect about the SIGTERM grace plus a few git commands. Steps:

1. Check that `git -C <wt> symbolic-ref -q HEAD` is the job's branch. If not: ✗ line, no WIP commit, keep the worktree, skip step 2.
2. If `git status --porcelain` is not empty: `git add -A`, then `git commit --no-verify -m "WIP(delegate <id>): <reason>"`. The reason is the worker's failure or stop reason, or "left uncommitted by the worker". This is the only `--no-verify` and the only commit the extension makes. Ignored files such as `node_modules` are not added.
3. Facts, all read from git, not from the worker:
   - the tip SHA;
   - `git log --format='%h %s' <start>..<tip>`: at most 20 lines, and subjects with control characters quoted as in `listOutput` (`delegate.ts:213`);
   - `git diff --stat <base>..<tip>`: at most 30 lines plus the summary;
   - `git diff <base>..<tip>` written to `<tmpdir>/me-pi-delegate-<pid>/<id>.diff`. That is the directory `saveFull` uses (dir 0700, file 0600, `delegate.ts:838-848`).
4. Tripwires:
   - the settings resource keys;
   - refs under `refs/heads`, `refs/tags`, and `refs/stash` that were **moved or deleted**, other than `delegate/*` and the main session's current branch (both legitimately move during a job). **Addition:** worktrees share refs, so `git update-ref` or `git branch -f` in a worker would change the user's branches. Git itself refuses `git checkout`, `git branch -f`, and `fetch` into a branch that another worktree has checked out, but `git update-ref` moves it (verified).
   - the main session's current branch: ✗ when it moved and its old tip is not an ancestor of the new tip (main's own commits during the job are fast-forwards). Unfenced bash can still commit in the main checkout via absolute paths; the guidelines require repo-relative paths in implement tasks.
   - shared git config and hooks: ✗ on any change in `git config --local --list` or the `hooks/`/`info/` hash. A worker can set `core.hooksPath`, `remote set-url`, or drop `hooks/pre-push`, and husky's `prepare` during `npm ci` sets `core.hooksPath`; main's next commit or push would run it with credentials. No auto-restore; report before and after.
5. `git worktree remove <wt>` without `--force`. Verified: it deletes a worktree whose only leftovers are ignored (`node_modules`), and it refuses one with untracked files. On failure, keep the worktree and report its path. Also delete the `GH_CONFIG_DIR` temp dir.

**Report.** The worker's answer (capped at 12 KiB as today, `delegate.ts:46`), then:

```
Branch: delegate/20261020-214012-im3 @ 1a2b3c4 (base 9f8e7d6, your HEAD at start)
Commits (2, oldest first):
  5d6e7f8 test: cover X
  1a2b3c4 feat: X
Diffstat: 3 files changed, 40 insertions(+), 5 deletions(-)
  extensions/delegate.ts | 30 +++++---
  …
Diff: /var/folders/…/me-pi-delegate-4242/im3.diff (0600, base..tip)
Worktree: removed
```

Failure lines start with ✗ and set `isError` and `failed` in the history:

- `✗ WIP 7c8d9e0 (stopped: timeout after 900s): a.ts, b.ts. Do not merge; continue with branch: "delegate/…".`
- `✗ Tripwire: …`
- `✗ Worktree kept at …: <reason>`

The diff content never goes into the result. Background delivery stays as in slice 1 (`delegate.ts:1264-1277`). After a shutdown, the report is dropped, but the branch and the WIP commit remain.

### Code layout

- New `extensions/delegate-implement.ts`, imported by `delegate.ts` like `delegate-command.ts`; not a `pi.extensions` entry. Interface: `prepare(cwd, id, branch?) → Worktree`, `workerEnv(env, wt) → env`, `finish(wt, outcome) → Facts`, `formatFacts(facts) → string`. All git calls are async `execFile`, so the TUI does not block.
- `delegate.ts`:
  - the role and its answer format;
  - the implement validation and the `branch` schema;
  - in `runWorkerAttempt`: tools, flags, env, and the SIGTERM stop;
  - the finish step in `call()`;
  - in the worker hook: `workerRisk`.
- `guard.ts`: `workerRisk`.
- `delegate-render.ts`: an optional footer line with the branch, the tip, and WIP.
- Size estimate: about 300 lines of code and 250 lines of tests (unverified). The code removed in c023d4d was about 2,000 lines.

## What stays main-only

- `git push`, PR creation, merging or closing PRs. Approval rules per `GLOBAL_AGENTS.md:15`.
- Any git remote operation: fetch, pull, clone from remotes. Workers have no remote transports.
- `git merge <delegate branch>` into the main session's branch: plain merge, fast-forward when possible, no squash, on a clean tree.
- Deleting branches. A merged branch: `git branch -d` (not in the approval list at `GLOBAL_AGENTS.md:16`, and the guard does not ask, `guard.ts:113-116`). Discarded or unmerged branches: one batched `git branch -D a b c`, which the guard asks the user to confirm (see Decisions).
- Worktree add and remove (the extension), `./install.sh`, `pi install`, and edits under `~/.pi`.
- Undoing a bad merge (`git reset --hard ORIG_HEAD` needs approval) and the final check.

## Verification contract

| Who | Must | Trusted as |
|---|---|---|
| Worker | Install what the repo names, run the check the task or the repo names, and commit only passing steps. Its answer lists each check command with pass or fail, plus its commits. Failing or unchecked work stays uncommitted and becomes WIP. | A claim. |
| Extension | Branch@tip, base, commits, diffstat, and the diff file, all from git. WIP flag and reason, tripwires, worktree state. | Fact. |
| Main session | Merge only with no ✗ line: (1) fresh `review` worker on the diff file with the acceptance criteria; (2) `git merge` on a clean tree; (3) run the check once on the merged result. A red check: fix forward, or send a follow-up implement on a new branch; undoing needs approval. WIP or review findings: follow-up implement with `branch`. Never merge a WIP tip. | The gate. |

Goal log (chief-of-staff "tribal knowledge"): merged commit SHAs on the main session's branch, open `delegate/*` branches, and saved diff and answer files. No separate log file.

## Answers to c023d4d

c023d4d removed edit workers because (1) each added 70-100 s, (2) they saved no main-session context, and (3) the worker git wrapper broke `npm run check` in repos whose tests commit.

1. **70-100 s overhead.** It was paid on the critical path: a foreground worker blocked the main session. Implement jobs run in the background (slice 1), so the main session keeps talking to the user. The fixed overhead is small:
   - worktree add: 0.02 s (verified, small repo);
   - `npm ci`: 2.3 s (measured);
   - one `npm run check`: 11.2 s (measured); 4 in parallel take 13 s wall clock on 10 cores (measured).

   Model turns dominate the rest. If the user waits on the result, total latency is still of the old order (unverified). The win is parallel work and a responsive main session, not speed. The guidelines keep 1-3 file edits in the main session.
2. **No main-context savings.** Old edit workers left uncommitted edits in the main checkout, so the main session had to read the diff to review and commit it. Now the worker commits, and the main session gets about 15 lines of facts. A read-only `review` worker reads the diff file. The main session reads the diff only when the review flags something. The savings are the diff, the worker's exploration, and its test output (unverified). Live check step 8 measures them.
3. **The git wrapper broke `npm run check`.** The old PATH shim intercepted every `git` in the worker's process tree, including test fixtures. This repo's own check commits in a fixture (`bin/install.test.sh:39-45`, run by `extensions/package.json:6`). The new design has no PATH shim:
   - the worker rules match only the command text the model sends;
   - the protocol cut-off affects only remote transports (local and `file://` pushes and commits work, verified);
   - gh has no credentials.

   **Same failure class, new carrier:** the worker env (`ME_PI_*`, `GIT_CONFIG_*`, `GH_CONFIG_DIR`) is inherited by the target repo's tests. `delegate.test.mjs` clears only `ME_PI_RUN` (`:190`). So `setup()` must also clear `ME_PI_OUTPUT_DIR`, `ME_PI_BUDGET`, and `ME_PI_ROLE`. Tests that need network git fail in workers, and the worker reports them as BLOCKED. The live check runs this repo's check inside a worker to prove it.

c023d4d also cut sessions, locks, BASH_ENV shell tracking, the Bash parser, coordinator mode, and the approval field. None of them returns:

- runs are one-shot;
- a worktree per job replaces locks, because git refuses a branch that is checked out twice;
- Pi's own SIGTERM handler replaces BASH_ENV;
- `guard.ts` regexes replace the parser;
- remote actions stay main-only, so no approval field is needed.

## Wording changes

**`PROMPT_SNIPPET`** (`delegate.ts:978-979`): "Run read-only workers (general, or the presets scout, research, review, challenge), alone or as a multi-model panel with rebuttal, or one `implement` worker that commits on its own branch; only answers and branch facts come back (drafts only with `output: true`)"

**Tool description** (`delegate.ts:1064-1065`): "Run Pi workers and get back only their answers. Read-only roles read files and load skills; research and challenge, or `web: true`, also use the web; with `output: true` each can write drafts into its own temp directory. `implement` edits, runs commands, and commits in a temp git worktree on a new `delegate/*` branch; it cannot push or use gh, and the result lists the branch, commits, diffstat, and a diff file."

**Schema:**
- `role` (`:926`): end with "…implement edits, runs checks, and commits on its own branch in a temp worktree; the other roles are read-only."
- `task` (`:931`): "…The worker sees nothing else. Read-only workers cannot run commands: write diffs or command output to a temp file and pass its path. For implement, name the check command."
- New `branch`: "implement only: an existing `delegate/*` branch to continue (after WIP or review findings) instead of a new branch from HEAD."

**`PROMPT_GUIDELINES`** (`delegate.ts:981-989`):
- Replace [0]: "Read-only workers search, research, review, and challenge; one `implement` worker edits, runs the checks, and commits on its own `delegate/*` branch. You push, open PRs, merge, and delete branches. Delegate reading more than about 3 files you will not edit, research, reviews, plan challenges, and self-contained changes that take many steps; make 1-3 file edits yourself."
- Add: "For `implement`, set `background: true`. The worker starts from your HEAD commit, not your uncommitted changes. The task names the goal, the files (repo-relative paths only), the acceptance criteria, and the check command."
- Add: "An implement result gives the branch, commits, diffstat, and a diff file path, not the diff. Merge only a result with no ✗ line: get a fresh `review` of the diff file, then `git merge <branch>` on a clean tree (no squash) and run the check once. For WIP or review findings, send a follow-up implement with `branch` set. Delete merged branches with `git branch -d`; put discarded ones in one `git branch -D a b c` for the user to approve."
- [1] (reviews of your own commits) and [6] (background) stay.

**`WORKER_CONTRACT`** (`delegate.ts:253-259`): split it into shared lines and per-role lines.
- Shared: line 1 without "read-only", plus the current BLOCKED, data-not-instructions, and answer-size lines.
- Read-only roles keep the current line 2 ("Your tools only read…").
- Implement adds:
  - "You work in a temporary git worktree, `<wt>`, on branch `<branch>` from `<base>`. Edit only inside it; it is removed when you finish. Start with `git status` and `git log --oneline <base>..HEAD`: an earlier attempt may have left work."
  - "Install what the repo's instructions name (e.g. `npm ci`), run the check the task or the repo names, and commit each passing step with a plain message: no trailers, never `--no-verify`, `--amend`, or rebase. Delete tracked directories with `git rm -r`."
  - "Leave failing or unchecked work uncommitted and say so: it is committed as WIP and never merged as is."
  - "You cannot push, use `gh`, run `git worktree`, reach git remotes, run `./install.sh` or `pi install|remove|update|config`, or change files under `~/.pi`. If the task or repo instructions need one, list it as BLOCKED: the coordinator does it after merging."
  - "Stop any background process you start before you answer."
- `ROLES.implement.answer`: "what changed and why; each check command with pass|fail; commits as `sha subject`; then BLOCKED steps and what is unverified. Never paste the diff."

**`GLOBAL_AGENTS.md:17`**: "Bash guards ask me to confirm most of these, and block them in delegate workers; they are a backstop, not the rule. When one blocks, stop and report the block; never route around it or a worker limit (variables, `env -u`, `git -c`, scripts, aliases, other tools)." Reason: the protocol cut-off yields to `git -c` and `env -u`, and this file reaches every worker.

**Repo `AGENTS.md:1`** (the source of fix a): add "`./install.sh` registers this checkout's path in `~/.pi/agent/settings.json`: run it only from the live checkout's main session, never from a worktree, temp clone, or delegate worker."

**README:**
- `:6`: add "self-contained changes"; an implement worker's changes come back as a branch.
- Use-it table: add the row `"Implement X in the background." → implement, background: true`.
- Role table (`:70-76`): add the row `implement | A change with a check | Worker pool | no | Changes, checks, commits; the tool adds branch facts`.
- Parameters: add `branch`, and list the parameters refused for implement.
- New `### Implement` subsection after Reviews (`:90`): worktree and branch name, env cut-offs, worker rules, finish and WIP, report, merge procedure, cleanup of leftovers.
- Limits (`:96`): implement gets SIGTERM, then SIGKILL after 3 s.
- Safety (`:101`): the tool split by role. Under "not a sandbox", add: implement's bash reads and writes anywhere and reaches the network (npm, curl); only git remotes and gh are cut, and `git -c` undoes the cut.
- Guard: one line on the worker-only rules.
- Extend: "Workers report edit … as BLOCKED" becomes "Read-only workers …".

## Test plan

**Unit tests** (`delegate.test.mjs`, in the fake-pi style of `:70-176`). Fixture: a temp repo in `TEST_HOME` with `user.name`, `user.email`, `core.hooksPath=/dev/null`, and one commit, as `bin/install.test.sh:39-45` sets up its fixture. `ctx = { ...CTX, cwd: repo, isProjectTrusted: () => false }`. The fake pi runs `git` with `spawnSync` in its cwd. New `FAKE_PI_MODE`s:

- `implement-commit`: writes a file, commits, answers. Assert:
  - `delegate/<ts>-im1@<sha>` in the result;
  - the commit list and diffstat are present;
  - the diff file is mode 0600, and its content is not in the result;
  - the worktree is gone; the branch exists;
  - the main repo's HEAD and tree are unchanged.
- `implement-dirty`: writes a file without committing. Assert a `WIP(delegate im1)` commit, the ✗ line, and `isError`.
- `hang` plus `/delegate cancel`: the worker got SIGTERM first (the fake traps TERM and writes a marker); a WIP commit; the report arrives without a turn.
- `hang` plus `session_shutdown`: the handler resolves only after the WIP commit exists, and no message is sent.
- `echo-env`:
  - `GIT_CONFIG_*` is appended after a preset `GIT_CONFIG_COUNT=1`;
  - `GH_CONFIG_DIR` is set and the token vars are unset;
  - `--tools` is the implement list;
  - `--no-approve` with `isProjectTrusted: () => false`, `--approve` with `true`;
  - cwd is the worktree plus the prefix.
- `move-ref`: moves another branch. Assert the ✗ tripwire.
- `move-main`: resets the main checkout's branch to a non-descendant. Assert ✗.
- `touch-config`: `git config core.hooksPath x`, and separately writes `hooks/pre-push` in the common dir. Assert ✗ for each.
- `--approve` is not passed with `branch`, on a fallback attempt, or when the worktree's `.pi` differs from base.
- Foreground implement: branch and WIP use an `im<n>` id.
- `checkout-other`: switches HEAD to another branch. Assert ✗, no WIP commit, worktree kept.
- `touch-settings`: with `PI_CODING_AGENT_DIR` set to a temp dir, a change to `packages` is flagged; a change to `defaultModel` only is not.
- `branch` continuation: commits are listed from the start tip; refused for non-`delegate/` names and missing branches.
- Refusals: implement with 2 runs, `rebuttal`, `output`, or `web: true`; a cwd outside a repo.
- Unique branch names across a simulated reload (the counter on `globalThis`).
- Worker hook with `ME_PI_ROLE=implement`: `write` outside the worktree is blocked; `bash` `git push` is blocked.
- `setup()` clears every `ME_PI_*`.
- The role enum test (`:254`) and the guideline test (`:1343`) are updated.

**`guard.test.mjs`:** `workerRisk` blocks `git push origin x`, `git push . HEAD:main`, `git -C x worktree add`, `git commit -nm x`, `gh pr list`, `git config core.hooksPath x`, `git remote set-url origin x`, `git update-ref refs/heads/main x`, `git symbolic-ref HEAD x`, `git branch -M x`, `git tag -d v1`, `./install.sh`, `bash install.sh`, `/abs/install.sh`, and `pi install ./x`. It passes `npm run check --prefix extensions`, `../bin/install.test.sh`, `git commit -m "mention git push"`, `grep 'gh ' file`, `git config --get user.name`, and `git merge main`.

**Live check** (fix b: workers load the installed extension, which is the live checkout, `~/.pi/agent/settings.json:11`; so Pi runs the live code while the implement target is a scratch clone):

1. In the live checkout: `npm run check --prefix extensions`. Confirm that `pi list` shows `../../fun/me-pi/extensions`, and record `shasum ~/.pi/agent/settings.json`.
2. `git clone /Users/mmo/fun/me-pi "$TMPDIR/me-pi-scratch"`, then `git -C "$TMPDIR/me-pi-scratch" remote add gh git@github.com:0bmario/me-pi.git`, then `tmux new-session -d -s wt -c "$TMPDIR/me-pi-scratch" pi`.
3. Self-hosting task, background: "In README.md, <small real edit>; run `npm ci --prefix extensions` and `npm run check --prefix extensions`; commit." Check:
   - the job id and status line;
   - the followUp report;
   - `ls -l` on the diff file (0600);
   - `git worktree list` shows only the main worktree;
   - `git log` on the branch.

   This also proves that `bin/install.test.sh`'s fixture commit and the `delegate.test.mjs` suite pass inside a worker.
4. Review the diff file with a `review` worker, `git merge`, run the check, `git branch -d`.
5. Negative task: "run `git ls-remote gh`, `git push gh HEAD`, `gh pr list`, `./install.sh`". Expect BLOCKED lines and "transport 'ssh' not allowed", and an unchanged settings `shasum`.
6. Cancel a long task with `/delegate cancel`. Expect:
   - a report without a turn;
   - a WIP commit;
   - no leftover `node --test` or biome processes (`pgrep -fl 'node --test|biome'`);
   - the worktree removed.
7. `/reload` during a job: measure the delay from `/reload` to the prompt (unverified item). Confirm the WIP commit and the worktree removal.
8. Context: run the same small task (a) in the main session and (b) through implement, review, and merge. Compare the main session's context tokens from the footer. Expected: (b) is smaller by at least the diff size; record the numbers in the slice-2 commit message.
9. `kill -9` the main pi during a job, then document the leftovers (worktree, orphaned groups) for slice 3.

Done when `npm run check --prefix extensions` is green and steps 3-8 pass.

## Rollout

- **Slice 2** (this doc), as 4 commits:
  1. `guard.ts` `workerRisk` and its tests;
  2. `delegate-implement.ts`, the role, the stop and finish steps, and tests;
  3. the wording (`delegate.ts` strings, README, `GLOBAL_AGENTS.md:17`, `AGENTS.md:1`);
  4. the live check, with its results in the commit message.
- **Slice 3: leftovers.**
  - `/delegate status` lists `delegate/*` branches: merged into HEAD or not, WIP tip (subject `WIP(delegate`), age.
  - It lists worktrees under `$TMPDIR/me-pi-delegate-wt-*`, including ones already deleted (offer `git worktree prune`).
  - It prints one batched `git branch -D …` for the user, and never runs it.
  - It saves reports that could not be delivered because of a shutdown.
- **Slice 4: sandbox.**
  - A custom bash tool for implement workers, with a `spawnHook` (Pi `docs/environment-variables.md`, "Custom Shell Tools"). It wraps commands in a macOS `sandbox-exec` profile: writes only to the worktree, `$TMPDIR`, and the npm cache; secret paths unreadable. Feasibility on Darwin 27 is unverified.
  - Then reconsider `runs > 1` for implement.
- **Later:** a launchd scheduler running `pi -p` for chief-of-staff schedules.

## Risks

- **Not a sandbox until slice 4.** Bash can:
  - read secrets: `~/.ssh` and env tokens (the secret-path block covers only `read`, `grep`, `find`, and `ls`, `delegate.ts:101-102`);
  - write outside the worktree;
  - reach the network (npm, curl, ssh);
  - re-enable git remotes with `git -c`.

  No web tools lowers the injection surface; repo content can still steer the worker.
- **Orphaned processes.** Background processes the worker starts (`&`, daemons) outlive their bash command (Pi untracks them, `bash.js:117`). A hard kill of the main pi only SIGKILLs worker groups, and their bash groups survive.
- **WIP `git add -A`** can commit untracked, non-ignored secrets or large files into a local commit. That commit is never pushed or merged as is, and the report lists the files.
- **A stale `index.lock`** after a SIGKILL fallback makes the WIP commit fail. The worktree is then kept and reported, and the lock is never deleted automatically.
- **Concurrent implement jobs** on one repo: merge conflicts at merge time (a follow-up with `branch` can merge the main branch and resolve them), and rare shared `.git` lock contention (unverified).
- **Per-worktree dependency installs** cost time, disk, and registry network. Repos with heavy installs make implement slow.
- **Shutdown drops the report.** `/reload`, `/new`, `/resume`, `/fork`, `/handoff`, and quit all end jobs; only the branch tells what happened until slice 3.
- **macOS purges old `$TMPDIR` files** (unverified timing). A kept worktree can then vanish and needs `git worktree prune`.
- **A spent budget yields WIP**, because tools are blocked (`delegate.ts:1004-1011`). Each overrun costs a follow-up job.
- **Untrusted text.** The worker's answer and commit subjects can carry prompt injection. Main treats them as data (`GLOBAL_AGENTS.md:21`), and subjects are quoted.
- **Submodules and LFS** are not initialized for the worker, LFS fetches over https may still work, since git-lfs uses its own HTTP client, not git's protocol allowlist (unverified).

## Decisions

None open. Decided 2026-10-20: the main session deletes **merged** `delegate/*` branches with `git branch -d` without asking (`-d` refuses unmerged branches; `GLOBAL_AGENTS.md:16` lists only `-D`). Discarded or unmerged branches go in one batched `git branch -D a b c` for the user to approve.
