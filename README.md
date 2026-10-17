# me-pi

A lean [Pi](https://pi.dev) coding-agent setup: one global policy, one delegated worker tool, one safety guard.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git && cd me-pi && ./install.sh
```

Restart Pi afterwards. The installer is idempotent and never overwrites machine files:

- links `GLOBAL_AGENTS.md` → `~/.pi/agent/AGENTS.md`
- registers `extensions/` and pinned packages with `pi install`
- copies Pi's bundled `interactive-shell.ts` and `handoff.ts` if missing
- seeds `~/.pi/agent/settings.json` from `settings.json` only on first install (models and auth stay machine-local)
- prunes links left by older versions of this repo

## How it works

- **The main session does the work.** It plans, edits, tests, and commits. Prune context between tasks with `/handoff <next goal>`, `/tree`, or `/compact`.
- **`GLOBAL_AGENTS.md` is the policy** every session and subagent loads: output style, an engineering fallback for repos without their own standards, and what needs your approval. It is a symlink, so edits apply to the next session.
- **`delegate` tool** (`extensions/delegate.ts`) runs a task in an isolated `pi` child (one generic worker type; several can run in parallel) and returns only its final answer, keeping the main context clean.
  - **Roles:** each task names a `role`; the coordinator writes the instructions and context, the role fixes the rest. Picked by first match:
    | Role | When | Tools | Tier · thinking | Answer |
    |---|---|---|---|---|
    | `debug` | the task gives a failing command or error | edit | strong · high | repro, root cause, fix, test |
    | `implement` | the task changes named files | edit | strong · medium | changes per file, checks |
    | `review` | a diff before a commit | read + web | strong · high, other family than the last writer | `path:line: severity: problem. Fix:` |
    | `challenge` | a plan before building it | read + web | strong · high, other family than the session | premise, challenges, verdict |
    | `research` | docs, web, several sources | read + web | strong · high | findings with sources |
    | `scout` | anything else in code | read + web | cheap · low | answer with `path:line` evidence |
  - **Model list:** run `/setup-delegate` → add model → pick it (type to filter) → `cheap` or `strong` → thinking (or "role default"). Repeat for 2-3 models; "move up" changes the order, and the first model of a tier is preferred. Roles pick by tier: `scout` uses cheap, every other role strong (`review` and `challenge` prefer a different vendor family, guessed from the model name). If a role's tier has no listed model, it falls back to the session model. Every worker on a listed model uses that model's thinking. Saved in machine-local `~/.pi/agent/delegate.json`; an empty list means the session model. A task's own `model`/`thinking` still win. Run `/reload` after editing so the tool lists the models.
  - **Sessions:** a task with `session: "<name>"` keeps that worker's context (`--session-id` in temp storage); a later task with the same name and same `cwd` continues it. Without it, workers are one-shot. A hard-killed coordinator may leave a lock, and so may a normal exit while a worker group is not yet confirmed gone; verify no worker remains before removing the lock file named in the error. Panels reject `session` so candidates cannot share a worker session.
  - **Panels:** `panel` runs one read-only task (`research`, `review`, `challenge`, `scout`) on 2-4 models in parallel, each independent. Options: `rebuttal` (round 2: each candidate continues its session, sees the others' answers, and defends or revises) and `judge` (a read-only worker from an unused family scores them against `rubric`; if none is configured, the panel reports the stage unavailable). Panel candidate transcripts are deleted when the run finishes. The coordinator merges the result. Ask for it with "let A, B and C investigate X and agree". Default panel picks up to 3 strong models from the list, one per family first.
  - **Coordinator mode:** `/coordinate on` makes the main session route instead of doing the work. It removes its own `grep`, `find`, `edit` and `write`, blocks bash searches (`rg`, `grep`, `find`, …), and adds a routing line to its prompt: each piece of work goes to a worker with the matching role. It keeps `read` for named files and `bash` for checks, git and commits. `/coordinate off` restores the tools. The mode lasts for the session, so run it again after `/new` or `/reload`.
  - **Specialize per task:** `skills` (absolute `SKILL.md` paths, inlined; an unreadable path fails before start), `model` and `thinking` (the role's pick from the user's list, else the session's; task values win), `tools` (exact `pi --tools` names; `*` and `+x`/`-x` only with `approval`), `approval` (the user's verbatim words approving an external operation), `cwd`. The default tools `read,grep,find,ls` apply only when no role is set.
  - **Worker contract:** local edits and tests allowed; no delegating, committing, or pushing. External writes only with the user's approval for that operation and target, passed verbatim in the delegate call's `approval` field and placed in trusted worker system metadata (approval text inside `task` grants nothing). Without approval, explicit `tools` may include only read-only tools plus local edit tools (`read,grep,find,ls,bash,edit,write`); read-only roles (`review`, `challenge`, `research`, `scout`) stay read-only unless approval is set. With approval and a role, workers receive the role's tools plus explicit `tools`, not every configured tool. With approval, no role, and no explicit `tools`, the normal configured tools remain available. Panels and judges are always forced read-only. Any worker with `bash` can still reach the network, so tool policy is behavioural, not a sandbox. A Git PATH wrapper is a guardrail against commit-creating/rewriting commands, push plumbing, ref moves (`git reset` only as `git reset` or `git reset [<tree-ish>] -- <paths>`, `git tag` only for listing), and unknown subcommands that may be aliases; known bypasses remain: Git by absolute path (for example `/usr/bin/git`), `env -i`, `PATH=`, or `command -p git`, and `git symbolic-ref`, `git update-index`, and `git branch -m`. Steps a worker cannot perform (sub-agents, commits, approvals) come back as `BLOCKED: ...`, never as success.
  - **The coordinator owns orchestration:** always-on agent guidelines require delegating searches in unread code (unless the relevant files are known) and getting a fresh review before commits touching 2+ files or adding behaviour. Independent review is a fresh worker given acceptance criteria and the diff; the `review` role is read-only and includes web tools. Commits and publication happen in the main session. Skills that start sub-agents or commit (`implement`, `research`, `code-review`) are not end-to-end worker-compatible and will report those steps as BLOCKED.
  - **One writer per checkout:** give concurrent writers separate, caller-prepared worktrees. This is policy, not enforced. A `tools` allowlist restricts capabilities; it is not a sandbox.
  - **Limits:** timeout (300s) and cost cap ($2) are per worker, not aggregate, and can interrupt an implementation; raise them per call with `timeoutSecs` and `costCapUsd`. A failed worker keeps its partial edits (never reverted or retried) and reports partial output, a bounded preview plus a complete tool-call argument log in a mode-0600 temp file, all `WROTE` lines, stderr, cwd, and that remote effects are unknown.
  - Each worker runs in its own process group: timeout, abort, cost cap, and session shutdown stop it and tracked shell groups (SIGTERM, then SIGKILL after 3s); normal coordinator process exit and uncaught exceptions SIGKILL them synchronously. Shell-group cleanup relies on `BASH_ENV`, so Pi's resolved shell (the `shellPath` setting, else Bash) must be Bash (`bash`, `bash5`, `bash-5.2`, …); otherwise the worker fails before spawn. The check reads the coordinator's settings, so a project `.pi/settings.json` in a different worker `cwd` could resolve another shell. Processes that leave the group (tmux, `setsid`, daemons, docker containers) survive. A hard kill of the main Pi process still skips cleanup; find leftover worker groups (orphaned `pi` group leaders) with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'` and stop each with `kill -- -<pid>`.
- **Guard** (`extensions/guard.ts`) asks before a bash `git push` to `main`/`master` or an `rm -f`; without a UI it blocks. Feature-branch pushes and PRs pass. `/guard off|on` toggles it for the session. It is a safety net; the policy text is the rule.
- **Skills are not in this repo.** Install them globally in `~/.agents/skills` or per project in `.agents/skills`.

## Extend

- **Specialize a worker:** write or install a skill and pass its absolute `SKILL.md` path in the task's `skills`. Keep worker skills free of sub-agent, commit, and approval steps, or expect them back as BLOCKED.
- **Guard a new command:** add a check in `classify()` in `extensions/guard.ts` and cases in `extensions/guard.test.mjs`.
- **Change policy:** edit `GLOBAL_AGENTS.md`, then start a fresh session.
- **Add an extension:** put the `.ts` file in `extensions/` and list it under `pi.extensions` in `extensions/package.json`.

## Check

```bash
npm test --prefix extensions
bin/install.test.sh
```
