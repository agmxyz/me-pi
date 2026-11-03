# me-pi

[![check](https://github.com/0bmario/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/0bmario/me-pi/actions/workflows/check.yml)

Bounded subagents for the [Pi](https://github.com/earendil-works/pi) coding agent. No worktrees, no sandbox, no agent files.

Your main session hands bounded work (a lookup, a review, research, a scoped change) to a separate worker process and gets back only the answer. Workers see only the brief, run under hard time and cost limits, and are killed as a process group when they overrun. `implement` edits your real checkout on a feature branch, and its ✓ means the check you declared passed on exactly what it delivered.

```text
you ─► main Pi session (decides, verifies)
          │ delegate { role, task, check? }
          ▼
       pi --mode json -p --no-session --no-mcp   (own process group, role tools, deadline)
          │
          ▼
       short answer   or   ✓ im1 fix/timeout a1b2c3d..e4f5a6b: 1 commit; check pass
```

## Why me-pi

- **Small surface.** One `delegate` tool, one `/delegate` command, six built-in roles. Works with zero config.
- **Follows your workflow.** Workers load your own `AGENTS.md` and skills. Add `(coordinator only)` to a `## ` heading and workers skip that section.
- **One writer, verified commits.** `implement` takes a per-repo lock, needs a clean feature branch, runs your check, and commits. A pass counts only for the exact checkout content it ran on; any later edit marks it stale. Leftover work is saved as a visible `WIP` commit.
- **Bounded by default.** Hard time limits (5 / 15 / 45 min), a $5 per-run cap on Pi's estimated cost, at most four workers per Pi session.
- **No blind retries.** Provider hiccups are retried on the same model only when the attempt did nothing but reads; anything with unknown side effects is reported, not replayed.
- **Model pools.** A cheap model for scouts, a stronger one for workers or reviews, in one JSON file.

| Role | Can | Answers with |
| --- | --- | --- |
| `scout` | read, grep, find, ls | 1–3 sentences with `path:line`, or `not-found` |
| `general` | same | what the task asks for |
| `review` | same | severity-ranked `path:line` findings |
| `research` / `challenge` | same + web | sources and conflicts / up to 5 challenges and a verdict |
| `implement` | same + edit, write, bash | commits on your branch, check status |

Also included: `guard` (asks before risky bash such as force pushes, `git reset --hard`, recursive `rm`) and `Skill` (lets Pi load an already-discovered skill by name).

## Install

Requires Pi 1.5.0 (CI runs against it) on macOS or Linux.

```sh
pi install git:github.com/0bmario/me-pi
```

Restart Pi or run `/reload`, then check with `/delegate status`. Try it, no config needed: *"Have a scout find where this repo parses CLI flags, with path:line evidence."*

Optional model pools in `~/.pi/agent/delegate.json` (without it, workers use your session's model):

```json
{
  "version": 3,
  "scout": { "models": [{ "model": "provider/fast-model", "thinking": "low" }] },
  "worker": { "models": [{ "model": "provider/strong-model", "thinking": "medium" }] },
  "review": { "models": [{ "model": "provider/other-strong-model", "thinking": "high" }] }
}
```

`scout` serves scouts, `review` serves reviews, and `worker` serves every other role. `review` is optional and falls back to `worker`; a different model there gives you a second opinion on the work it reviews.

`research` and `challenge` need web tools: `pi install npm:pi-web-access`.

To skip `guard`, replace the `git:github.com/0bmario/me-pi` entry in `~/.pi/agent/settings.json` with a filter (keep `skill.ts`: workers use it to load skills):

```json
{
  "packages": [
    { "source": "git:github.com/0bmario/me-pi", "extensions": ["extensions/delegate.ts", "extensions/skill.ts"] }
  ]
}
```

Without `guard`, `implement` workers also lose its blocks on recursive `rm`, `git reset --hard`, and force pushes.

## Use

Ask Pi in plain language. A typical change:

1. "Scout where session timeouts are configured." → a `path:line` answer.
2. `git switch -c fix/timeout`, then "Implement a 30 s default timeout; check with `npm test`." → `✓ im1 fix/timeout …: 1 commit; check pass`.
3. "Review the diff of `main...fix/timeout` for correctness." → severity-ranked findings. Fix, re-review, open the PR yourself.

Also: "Research how other CLIs handle config migrations", "Challenge this plan", and "…in the background" for long jobs.

| Command | Does |
| --- | --- |
| `/delegate status` | running jobs, recent calls, model resolution |
| `/delegate models` | config path |
| `/delegate cancel <id>` | cancel a background job |
| `/guard on` / `/guard off` | toggle guard for this session |

Background jobs end on `/reload` or when Pi exits. Roles, limits, model pools and recovery: [docs/delegate.md](docs/delegate.md).

## What it adds to your prompts

Nothing is replaced; me-pi only appends.

- **Main session:** the `delegate` tool's one-line summary and 8 usage guidelines (`PROMPT_SNIPPET`, `PROMPT_GUIDELINES` in [`delegate.ts`](extensions/delegate.ts)): when to delegate, how to brief and verify, pushes and merges stay with you, hands off the checkout while `implement` runs.
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
pi remove git:github.com/0bmario/me-pi
rm ~/.pi/agent/delegate.json   # if you created it
```

## Author's full setup

From a clone, `./install.sh` installs my personal rig machine-wide (global policy, skills, extras). You don't need it for the package. What it does and how to undo it: [docs/setup.md](docs/setup.md).

## Contributing

Node ≥22.19.

```sh
npm ci
npm run check                    # lint, typecheck, tests, installer test
npm run fix                      # apply Biome fixes
node --test test/guard.test.ts   # one test file
```

Read [docs/coding-standards.md](docs/coding-standards.md) and [GLOSSARY.md](GLOSSARY.md). CI runs `npm run check` on every PR. Good first issues: [#35](https://github.com/0bmario/me-pi/issues/35), [#40](https://github.com/0bmario/me-pi/issues/40).

## License

[MIT](LICENSE)
