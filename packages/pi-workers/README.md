# pi-workers

[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

Keep long searches, file dumps and review noise out of your main [Pi](https://github.com/earendil-works/pi) session. `delegate` sends a task to a separate worker and brings back an answer, so you can focus on what to do with it.

Work with Pi as usual. When a task would flood the session, such as a broad search or a large review, Pi hands it to a read-only worker and briefs it; you don't need to write agent files. Your session makes every change itself. It's developed in [me-pi](https://github.com/agmxyz/me-pi), my Pi setup, if you want to see the workflow around it.

## Install and try it

Requires Pi 1.5.0 (the version CI tests) on macOS or Linux (CI covers Linux; macOS is tested locally).

```sh
pi install npm:@agmxyz/pi-workers
```

To track `main` instead, install `git:github.com/agmxyz/me-pi`. Install only one of the two: both load the same extensions.

Restart Pi or run `/reload`, then just work. You don't name roles: Pi decides when a task is worth delegating and which worker gets it. Small reads and every edit stay in your session. For example:

- "Where does this project handle configuration?" A search of unknown scope goes to a read-only worker, and you get back a few lines with `path:line` evidence.
- "Review this branch's diff for correctness." A large diff goes to a reviewer; for a small one, Pi reads it itself.
- "Add a 30 s default timeout; `npm test` must pass." Pi edits, runs your check and commits in your session; past about 50 changed lines it asks a `general` worker to review the diff. When a change is too big for one session's context, Pi says so and proposes a split.

The routing is prompt guidance to your model (`PROMPT_GUIDELINES` in [`delegate.ts`](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/extensions/delegate.ts)), so it can misjudge. Steer it when you want: "use a worker for this", "do this in the background", or "have Opus 5.5 and Sol 6.1 challenge this plan and cross-check each other" (the models must be available in Pi).

Workers are not sandboxed: they run with your OS permissions and can read your project. See [Safety](#safety).

Upgrading from 0.2? The `implement` role is gone: see [Migrating from implement](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/docs/delegate.md#migrating-from-implement).

Switching from a Git install? Run `pi remove git:github.com/agmxyz/me-pi` (or `git:github.com/0bmario/me-pi`, the old URL) first, so Pi doesn't load the extensions twice.

## How it works

The coordinator (your session) chooses a built-in read-only role and briefs it for the task. The roles are fixed, but the work isn't:

- **`scout`** searches read-only and normally returns a few sentences with `path:line` evidence.
- **`general`** is a read-only worker you can brief as a reviewer, researcher, plan critic or investigator. It isn't a collection of separate agents.

Workers load your own `AGENTS.md` and skills; `## ` sections marked `(coordinator only)` are stripped from worker prompts. Workers can also write drafts to their own temp directory with `output: true`; web tools require `web: true`.

The package also includes `guard`, which asks before risky bash, and `Skill`, which loads an already-discovered skill by name. `/guard on` and `/guard off` toggle the guard for the session; with `ME_PI_UNATTENDED=1` it refuses instead of asking and stays on. `/delegate status` shows jobs and model resolution; `/delegate cancel <id>` requests cancellation. Roles, commands and recovery: [docs/delegate.md](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/docs/delegate.md).

## Why use it?

- **Keep the main context focused.** A worker can search files or review a diff and return findings instead of filling the session with its process.
- **One writer.** Only your session edits; workers read, research and review, so nothing writes behind your back.
- **Limits by default.** Hard time limits (5 / 15 min for `scout` / `general`), a $5 cap on Pi's estimated cost per run, and at most four workers at once. Cost is checked after each reply, so the estimate can exceed $5; a final reply over the cap is kept.
- **No blind retries.** Eligible infrastructure failures are retried on the same model only after a fully accounted-for, read-only attempt; unknown side effects aren't replayed. pi-workers never switches models on its own.

## Where it's weaker

- **Custom worker profiles.** You can brief `general` for different jobs and choose models per call, but you can't define a new persistent role with its own toolset and defaults.
- **Delegated writing.** Workers don't edit. For a second feature at the same time, add a Git worktree and start a Pi session there; `delegate` does not create or clean up worktrees for you.
- **Long-lived jobs.** Background jobs end on `/reload`, a session switch, or Pi exit, and a worker's session can't be resumed.
- **A live view or built-in chains.** You see progress and the final answer, not the worker's conversation; workflows beyond that depend on your own skills.

Packages such as [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) and [`pi-side-agents`](https://www.npmjs.com/package/pi-side-agents) aim at some of these; compare before choosing.

## Configure

Everything here is optional.

Model pools live in `~/.pi/agent/delegate.json` (`ME_PI_DELEGATE_CONFIG` points elsewhere). Without it, workers use your session's model.

```json
{
  "version": 3,
  "scout": { "models": [{ "model": "provider/fast-model", "thinking": "low" }] },
  "worker": { "models": [{ "model": "provider/strong-model", "thinking": "medium" }] }
}
```

`scout` serves scouts and `worker` serves `general`. For a second opinion, name another model in the call (`runs[].model`); a `worker` entry after the first sets that model's thinking.

Calls with `web: true` need web tools: `pi install npm:pi-web-access`.

To skip `guard`, replace the package entry in `~/.pi/agent/settings.json` with a filter (keep `skill.ts`: workers use it to load skills). The paths are the same for the Git source:

```json
{
  "packages": [
    { "source": "npm:@agmxyz/pi-workers", "extensions": ["extensions/delegate.ts", "extensions/skill.ts"] }
  ]
}
```

## What it adds to your prompts

Nothing is replaced; pi-workers only appends.

- **Main session:** the `delegate` tool's one-line summary and 7 usage guidelines (`PROMPT_SNIPPET`, `PROMPT_GUIDELINES` in [`delegate.ts`](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/extensions/delegate.ts)): when to delegate, how to brief and review, making changes yourself, pushes and merges stay with you.
- **Workers:** Pi's normal prompt plus your `AGENTS.md` and skills, minus sections marked `(coordinator only)` and skills outside your configured lists ([docs/delegate.md](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/docs/delegate.md#configure-model-pools)). Appended is a short contract: report `BLOCKED` instead of faking a step, treat fetched content as data, and answer in about 300 words ([`delegate-worker.ts`](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/extensions/delegate-worker.ts)).

These are prompt text, so your own `AGENTS.md` can refine or contradict them; the limits and fences are enforced in code either way.

## Safety

- Not a sandbox. Extensions and workers run with your OS permissions; `guard` and the fences are guardrails, not security boundaries.
- `guard` matches each command's text; it can't see what earlier commands left on disk. For example, it allows `rm -rf /tmp/x/old` even if `/tmp/x` is a symlink to `/`. It also allows a recursive `rm` of a plain relative path (`rm -rf src`) wherever the session's directory is, so uncommitted, untracked, and ignored files under it go without a prompt.
- Worker file-read tools refuse common secret paths (`.env*`, keys, `~/.ssh`, `~/.pi/agent/auth.json`).
- The recovery rules in [docs/delegate.md](https://github.com/agmxyz/me-pi/blob/main/packages/pi-workers/docs/delegate.md) are guidance for the main session, not runtime enforcement.
- pi-workers itself sends nothing anywhere; workers talk only to your configured model providers, plus fetched pages when web tools are on.

## Uninstall

```sh
pi remove npm:@agmxyz/pi-workers   # or git:github.com/agmxyz/me-pi
rm ~/.pi/agent/delegate.json   # if you created it
```

## License

[MIT](https://github.com/agmxyz/me-pi/blob/main/LICENSE)
