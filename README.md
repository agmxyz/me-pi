# me-pi — personal pi agent rig

Single source of truth for my pi coding-agent config. Live dirs symlink here; edit the repo, both drivers see it.

## Layout

```
extensions/   pi extensions (TypeScript, self-contained — publishable)
agents/       subagent definitions (.md, frontmatter + system prompt)
prompts/      workflow prompt templates
skills/       shared skill set (~/.agents/skills — discovered by pi AND codex)
settings.json template (installed on first run; live file not symlinked)
APPEND_SYSTEM.md  global system-prompt addendum
install.sh    idempotent installer (symlinks everything into place)
```

## Install (new machine)

```bash
git clone git@github.com:0bmario/me-pi.git
cd me-pi && ./install.sh
```

## Conventions

- **Secrets never enter this repo.** `auth.json`, `models-store.json`, `sessions/` live in `~/.pi/agent/` and are gitignored. `.gitignore` was the first commit.
- **Extensions stay self-contained** (single file or dir with `index.ts`, no cross-imports, no hardcoded personal paths) so any one of them can be extracted into a publishable pi package (`pi install npm:...`, keyword `pi-package`).
- **Skills are harness-agnostic** — this `skills/` dir is the spec location `~/.agents/skills` (symlinked), consumed natively by pi and Codex. Keep descriptions neutral ("the agent", not "Codex").
- Subagent model assignment lives in `~/.pi/agent/settings.json` under `subagents.*` (role → model), not hardcoded in agent files.

## Contents

- extensions: `rtk.ts` (bash → rtk rewrites), `interactive-shell.ts` (`!nvim`, `!lazygit`…)
- agents: (populated during subagent rollout — implementer, reviewer, devil's advocate, council)
