# me-pi

A lean [Pi](https://pi.dev) coding-agent setup: one global policy, three read-only subagents, one safety guard.

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
- **`delegate` tool** (`extensions/delegate.ts`) hands bounded read-only work to an isolated `pi` child and returns only its final answer, keeping search and review noise out of the main context. Roles live in `agents/`:
  - `scout`: answers one codebase question with `path:line` evidence
  - `reviewer`: reviews the uncommitted diff (attached automatically) on standards and spec
  - `devils-advocate`: attacks a plan before you commit to it

  Children get only `read, grep, find, ls`, cannot delegate further, and run with a timeout and cost cap. Several tasks can run in parallel. The model is the session's unless the role pins one or you name one ("review using X at high").
- **Guard** (`extensions/guard.ts`) asks before a bash `git push` to `main`/`master` or an `rm -f`; without a UI it blocks. Feature-branch pushes and PRs pass. `/guard off|on` toggles it for the session. It is a safety net; the policy text is the rule.
- **Skills are not in this repo.** Install them globally in `~/.agents/skills` or per project in `.agents/skills`.

## Extend

- **Add a subagent:** create `agents/<name>.md`. Frontmatter: `name`, `description`, `thinking`, `tools` (keep it read-only), optional `attach_diff: true` and `model: provider/id`. The body is the prompt; end it with an output contract. Roles are re-read on every call; restart Pi to refresh the tool's role list.
- **Guard a new command:** add a check in `classify()` in `extensions/guard.ts` and cases in `extensions/guard.test.mjs`.
- **Change policy:** edit `GLOBAL_AGENTS.md`, then start a fresh session.
- **Add an extension:** put the `.ts` file in `extensions/` and list it under `pi.extensions` in `extensions/package.json`.

## Check

```bash
npm test --prefix extensions
bin/install.test.sh
```
