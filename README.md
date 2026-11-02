# me-pi

[![check](https://github.com/0bmario/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/0bmario/me-pi/actions/workflows/check.yml)

Subagents for the [Pi](https://github.com/earendil-works/pi) coding agent, without the framework.

Your main session hands bounded work (a lookup, a review, research, a scoped change) to an isolated worker and gets back only the answer. Its context stays clean, and it keeps every decision. No agent files, no workflow DSL: one tool, sensible roles, hard limits, and changes that land as commits on your branch.

## Why me-pi

- **Small surface.** One `delegate` tool, one `/delegate` command, no agent files to write. Works with zero config.
- **Six fixed roles:** `scout`, `general`, `review`, `research`, `challenge`, `implement`. Each has its own tools and answer shape; only `implement` edits your project.
- **Follows your workflow.** Workers load your own `AGENTS.md` and skills. Add `(coordinator only)` to a `## ` heading and workers skip that section.
- **`implement` delivers commits.** It works on your feature branch, runs the check you give it, and commits; interrupted work is saved as a `WIP` commit.
- **Bounded by default.** Time and cost limits per worker, at most four at once, and worker file reads of secret paths (`.env*`, keys, `~/.ssh`, `~/.pi/agent/auth.json`) blocked.
- **Model pools.** A cheap model for scouts, a stronger one for workers or reviews, set in one JSON file.

Also included: `guard` (asks before risky bash such as force pushes, `git reset --hard`, recursive `rm`) and `Skill` (lets Pi load an already-discovered skill by name).

## Install

Requires Pi 1.5.0 (CI runs against it).

```sh
pi install git:github.com/0bmario/me-pi
```

Restart Pi or run `/reload`, then check with `/delegate status`.

Optional model pools in `~/.pi/agent/delegate.json` (without it, workers use your session's model):

```json
{
  "version": 3,
  "scout": { "models": [{ "model": "provider/fast-model", "thinking": "low" }] },
  "worker": { "models": [{ "model": "provider/strong-model", "thinking": "medium" }] }
}
```

`research` and `challenge` need web tools: `pi install npm:pi-web-access`.

To skip `guard`, replace the `git:github.com/0bmario/me-pi` entry in `~/.pi/agent/settings.json` with a filter (keep `skill.ts`: workers use it to load skills):

```json
{
  "packages": [
    { "source": "git:github.com/0bmario/me-pi", "extensions": ["extensions/delegate.ts", "extensions/skill.ts"] }
  ]
}
```

## Use

Ask Pi in plain language:

- "Have a scout find where the retry policy lives, with path:line evidence."
- "Get a review of the diff in /tmp/change.diff for correctness."
- "Research how other CLIs handle config migrations." / "Challenge this plan."
- "Implement the parser fix on this branch; check with `npm test`." (`implement` always needs a check command.)
- Add "in the background" for long jobs.

| Command | Does |
| --- | --- |
| `/delegate status` | running jobs, recent calls, model resolution |
| `/delegate models` | config path |
| `/delegate cancel <id>` | cancel a background job |
| `/guard on` / `/guard off` | toggle guard for this session |

Roles, limits, model pools and recovery: [docs/delegate.md](docs/delegate.md).

## Safety

- Not a sandbox. Extensions and workers run with your OS permissions; `guard` and the fences are guardrails, not security boundaries.
- `implement` edits and commits in your real checkout. It needs a clean tree on a non-`main`/`master` branch and blocks `git push`; review what it hands back.
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
