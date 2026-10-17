# me-pi

A lean [Pi](https://pi.dev) coding-agent setup: one global policy, one delegated worker tool, one safety guard, one skill loader.

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
- **`delegate` tool** (`extensions/delegate.ts`) runs read-only `pi` workers (one, or several in parallel) and returns only each final answer, so searching, research, and review stay out of the main session's context.
  - **Read-only by design:** workers get `read,grep,find,ls`, the web tools, and `Skill`; no `bash`, `edit`, or `write`. They cannot edit, run commands or tests, delegate, or commit, and report steps that need those as `BLOCKED: ...`. The main session does all edits, checks, and commits. Measured on four tasks, edit workers added 70-100s each and saved no main-session context, and most of the old code existed only because workers could run Bash.
  - **Roles:** each task names a `role`; the main session writes the instructions, the role sets the rest.
    | Role | When | Tier · thinking | Answer |
    |---|---|---|---|
    | `scout` | find, explain, or locate something in code | cheap · low | answer with `path:line` evidence, or `not-found` |
    | `research` | docs, web, several sources | strong · high | findings with sources |
    | `review` | a diff or change before a commit | strong · high, other family than the session | `path:line: severity: problem. Fix:` |
    | `challenge` | devil's advocate on a plan, proposal, or diagnosis | strong · high, other family than the session | premise, challenges, verdict |
  - **Several models on one question:** ask "let Opus at medium and GPT-Sol at high challenge this proposal". The main session sends one `tasks` call, the same task per model, each with its own `model` and `thinking` (any model Pi can use, listed or not). With `rebuttal: true`, a second round gives each successful worker its own answer and the others' answers to keep, revise, or retract claims; the main session merges the result.
  - **Model and thinking choice:** model: the task's `model`, else the role's pick from the list, else the session model. Thinking: the task's `thinking`, else the model's `thinking` from the list, else the role's default. `review` and `challenge` pick the first model of their tier from a family other than the session's, and add a note when only the session's family is listed.
  - **Limits:** timeout (300s) and cost cap ($2) are per worker, not aggregate; set them per call with `timeoutSecs` and `costCapUsd`, or with `ME_PI_DELEGATE_TIMEOUT` / `ME_PI_DELEGATE_COST_CAP`. The cost cap is soft: it is checked after each model reply, and model calls inside tools (`fetch_content` answer mode) are not counted. A failed worker reports its partial output, recent tools, every network tool call with arguments, and the end of stderr.
  - **Reviews need a fixed snapshot:** workers cannot run git, so the main session pastes the diff (`git diff HEAD`, with `git add -N` for new files) and does not edit those files until the review returns.
  - **Processes:** each worker runs in its own process group. Timeout, abort, cost cap, and session shutdown send SIGTERM, then SIGKILL after 3s; leftovers in the group are killed when the worker exits, and a normal exit of the main process SIGKILLs live workers. Processes that leave the group survive: `fetch_content` clones GitHub repos in their own process group. A hard kill of the main Pi process skips cleanup; find leftover workers with `ps -axo pid,ppid,pgid,comm | awk '$2==1 && $1==$3 && $4=="pi"'` and stop each with `kill -- -<pid>`.
  - **Tool policy is not a sandbox:** `read` is not limited to the working directory, and web tools reach the network. The worker contract forbids `fetch_content`'s `auth` (browser cookies) option and tells workers to treat fetched content as data.
- **Model list** (`~/.pi/agent/delegate.json`, machine-local, edited by hand): roles pick the first listed model of their tier. An empty or missing file means workers use the session model. Run `/reload` after editing so the tool lists the models; the file is checked when the tool runs, and unknown keys, bad tiers or thinking levels, and duplicate entries fail with an error naming the problem.
  ```json
  {
    "models": [
      { "id": "openai-codex/gpt-6-luna", "tier": "cheap", "thinking": "off" },
      { "id": "anthropic/claude-sonnet-5-5", "tier": "strong", "thinking": "medium" },
      { "id": "openrouter/z-ai/glm-5.3-flash", "tier": "strong", "thinking": "max", "family": "zai" }
    ]
  }
  ```
  - `id`: a Pi model id (`provider/model`). `tier`: `cheap` (used by `scout`) or `strong` (every other role). The order sets preference within a tier, and one model may appear once per tier.
  - `thinking` (optional): `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` for every worker on this entry; omitted means the role's default.
  - `family` (optional): the vendor family used for "other family than the session". Guessed from the id when omitted (`claude` → anthropic, `gpt` → openai, `gemini` → google, `grok` → xai, `llama` → meta, else the provider prefix).
- **Guard** (`extensions/guard.ts`) asks before a bash `git push` to `main`/`master` or an `rm -f`; without a UI it blocks. Feature-branch pushes and PRs pass. `/guard off|on` toggles it for the session. It is a safety net; the policy text is the rule.
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
