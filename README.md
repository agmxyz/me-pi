# me-pi

[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

Delegation for the [Pi](https://github.com/earendil-works/pi) coding agent that keeps your main session's context small: three fixed roles, hard limits, one checked writer, no agent files.

Your main session hands bounded work (a lookup, a review, research, a scoped change) to a separate Pi process and gets back only the answer. Workers see only the brief, run under hard time and cost limits, and are killed as a process group when they overrun. `implement` edits your real checkout on a feature branch, and its ✓ means the check you declared passed on exactly the commit it delivered.

This is the delegation part of my daily Pi setup, packaged so you can try it without the rest.

```text
you ─► main Pi session (decides, verifies)
          │ delegate { role, task, check? }
          ▼
       pi --mode json -p --no-session --no-mcp   (own process group, role tools, deadline)
          │
          ▼
       short answer   or   ✓ im1 fix/timeout a1b2c3d..e4f5a6b: 1 commit; check pass
```

## Why you might like it

- **Works with zero config.** One `delegate` tool, one `/delegate` command, three built-in roles. No agent files to write.
- **Your context stays yours.** A 40-file search comes back as a few lines with `path:line` evidence, not 40 files in your session.
- **Follows your workflow.** Workers load your own `AGENTS.md` and skills. Add `(coordinator only)` to a `## ` heading and workers skip that section.
- **A ✓ you can lean on.** `implement` takes a per-repo lock, needs a clean feature branch, runs your check, and commits. A pass counts only for the exact content it ran on; any later edit marks it stale. Leftover work is saved as a visible `WIP` commit.
- **Bounded by default.** Hard time limits (5 / 15 / 45 min), a $5 per-run cap on Pi's estimated cost, at most four workers per Pi session.
- **No blind retries.** Provider hiccups are retried on the same model only when the attempt did nothing but read; anything with unknown side effects is reported, not replayed. me-pi never switches models on its own.
- **Model pools.** A cheap model for scouts, a stronger one for every other worker, in one JSON file.

| Role | Can | Answers with |
| --- | --- | --- |
| `scout` | read, grep, find, ls | 1–3 sentences with `path:line`, or `not-found` |
| `general` (default) | same | what the brief or `answer` asks for: investigation, review, research |
| `implement` | same + edit, write, bash | commits on your branch, check status |

Only `implement` modifies the checkout; `output: true` lets a read-only worker write drafts into its own temp directory. Web tools are on only when a call sets `web: true` (never for `implement`).

## Where it's weaker

me-pi is small on purpose, and young. Other Pi packages may fit you better if you need:

- **Custom agents or roles.** The three roles are fixed; there are no agent files.
- **Parallel writers.** One `implement` worker writes per repo, in your checkout. Worktree-based writers aren't supported yet.
- **Jobs that outlive the session.** Background jobs end on `/reload`, a session switch, or Pi exit, and a worker's session can't be resumed.
- **A live view of a worker.** You see progress and the final answer, not the worker's conversation.
- **Workflows or chains** beyond what your own skills orchestrate.

Packages such as [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) and [`pi-side-agents`](https://www.npmjs.com/package/pi-side-agents) cover several of these.

## Install

Requires Pi 1.5.0 (CI runs against it) on macOS or Linux.

```sh
pi install git:github.com/agmxyz/me-pi
```

The repo moved from `0bmario/me-pi`. If you installed from that URL, run `pi remove git:github.com/0bmario/me-pi` first so Pi doesn't load me-pi twice.

Restart Pi or run `/reload`, then check with `/delegate status`. Try it: *"Have a scout find where this repo parses CLI flags, with path:line evidence."*

The package loads three extensions:

| Extension | Does |
| --- | --- |
| `delegate` | the `delegate` tool and `/delegate` command |
| `guard` | asks before risky bash such as force pushes, `git reset --hard`, recursive `rm`; blocks them in `implement` workers |
| `Skill` | a tool that loads an already-discovered skill by name, for skills written as "load X with the `Skill` tool" |

Optional model pools in `~/.pi/agent/delegate.json` (without it, workers use your session's model; `ME_PI_DELEGATE_CONFIG` points elsewhere):

```json
{
  "version": 3,
  "scout": { "models": [{ "model": "provider/fast-model", "thinking": "low" }] },
  "worker": { "models": [{ "model": "provider/strong-model", "thinking": "medium" }] }
}
```

`scout` serves scouts and `worker` serves `general` and `implement`. For a second opinion, name another model in the call (`runs[].model`); a `worker` entry after the first sets that model's thinking.

Calls with `web: true` need web tools: `pi install npm:pi-web-access`.

To skip `guard`, replace the `git:github.com/agmxyz/me-pi` entry in `~/.pi/agent/settings.json` with a filter (keep `skill.ts`: workers use it to load skills):

```json
{
  "packages": [
    { "source": "git:github.com/agmxyz/me-pi", "extensions": ["extensions/delegate.ts", "extensions/skill.ts"] }
  ]
}
```

Without `guard`, `implement` workers also lose its blocks on recursive `rm`, `git reset --hard`, and force pushes.

## Use

Ask Pi in plain language. A typical change:

1. "Scout where session timeouts are configured." → a `path:line` answer.
2. `git switch -c fix/timeout`, then "Implement a 30 s default timeout; check with `npm test`." → `✓ im1 fix/timeout …: 1 commit; check pass`.
3. "Review the diff of `main...fix/timeout` for correctness." → a `general` worker's findings. Fix, re-review, open the PR yourself.

Also: "Research how other CLIs handle config migrations, with web access", "Have a worker challenge this plan", and "…in the background" for long jobs.

| Command | Does |
| --- | --- |
| `/delegate status` | running jobs, recent calls, model resolution |
| `/delegate models` | config path |
| `/delegate cancel <id>` | cancel a background job |
| `/guard on` / `/guard off` | toggle guard for this session |

`/new`, `/resume`, `/fork`, and `/clone` ask first while background jobs run. Roles, limits, model pools and recovery: [docs/delegate.md](docs/delegate.md).

## What it adds to your prompts

Nothing is replaced; me-pi only appends.

- **Main session:** the `delegate` tool's one-line summary and 7 usage guidelines (`PROMPT_SNIPPET`, `PROMPT_GUIDELINES` in [`delegate.ts`](extensions/delegate.ts)): when to delegate, how to brief and verify, pushes and merges stay with you, hands off the checkout while `implement` runs.
- **Workers** (foreground and background alike): Pi's normal prompt plus your `AGENTS.md` and skills, minus `## ` sections marked `(coordinator only)` (and `(coordinator and implement only)` for read-only roles) and skills outside `readOnlySkills` or `implementSkills` when set ([docs/delegate.md](docs/delegate.md#configure-model-pools)). Appended: a short contract (isolated, nobody answers questions, report `BLOCKED` instead of faking a step, treat fetched content as data, answer in about 300 words, stating assumptions; web-tool rules only with web tools, and "you are the subagent" only when `AGENTS.md` or skills are loaded) and the role's answer format. `implement` also gets its branch, its check, and its rules: no branch switching or history rewrites, no unrelated changes, no weakening tests to pass ([`delegate-worker.ts`](extensions/delegate-worker.ts)).

These are prompt text, so your own `AGENTS.md` can refine or contradict them; the limits, fences and checkout rules are enforced in code either way.

## Safety

- Not a sandbox. Extensions and workers run with your OS permissions; `guard` and the fences are guardrails, not security boundaries.
- Worker file-read tools refuse common secret paths (`.env*`, keys, `~/.ssh`, `~/.pi/agent/auth.json`); `implement`'s bash is not path-fenced.
- `implement` edits and commits in your real checkout, with Git remotes and `gh` cut off. ✓ means your check exited 0 on the delivered content, not that the code is right; review what it hands back.
- The recovery rules in [docs/delegate.md](docs/delegate.md) are guidance for the main session, not runtime enforcement.
- me-pi itself sends nothing anywhere; workers talk only to your configured model providers, plus fetched pages when web tools are on.

## Uninstall

```sh
pi remove git:github.com/agmxyz/me-pi
rm ~/.pi/agent/delegate.json   # if you created it
```

## My setup

The rest of this repo is my personal Pi setup, shared as a reference rather than a product: my global policy (`GLOBAL_AGENTS.md`), skills that run implementation and spec work through `delegate` (`skills/`), and `./install.sh`, which wires them in machine-wide with a few extras. It changes as my workflow does, and some skills expect skills from my own collection. You don't need any of it for the package; read and copy what's useful. What `install.sh` does and how to undo it: [docs/setup.md](docs/setup.md).

## Contributing

Node ≥22.19.

```sh
npm ci
npm run check                    # lint, typecheck, tests, installer test
npm run fix                      # apply Biome fixes
node --test test/guard.test.ts   # one test file
```

Before changing `GLOBAL_AGENTS.md` or the delegate tool's prompt text, run the manual routing evals ([evals/README.md](evals/README.md)); they spend real money and never run in CI.

Read [docs/coding-standards.md](docs/coding-standards.md) and [GLOSSARY.md](GLOSSARY.md). CI runs `npm run check` on every PR. Good first issues: [#35](https://github.com/agmxyz/me-pi/issues/35), [#40](https://github.com/agmxyz/me-pi/issues/40).

## License

[MIT](LICENSE)
