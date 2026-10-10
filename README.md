# me-pi

A Pi coding-agent setup.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git
cd me-pi
./install.sh
```

The installer links repo skills into `~/.agents/skills`, shared coding standards to `~/.agents/CODING_STANDARDS.md`, global output policy to `~/.pi/agent/AGENTS.md`, and `bin/delegate` to `~/.local/bin/delegate`. It registers this rig's Pi package and pinned Pi packages with `pi install`, and seeds `settings.json` only when no live file exists. Existing machine-owned entries are preserved; resolve any reported collision. Pi is required; RTK integration is optional. Restart Pi after installation.

Keep credentials and live settings in `~/.pi/agent/`, outside this repository. Tracked `settings.json` is a first-install template, not a credentials backup. For a policy refresh or migration, follow [specs/migration.md](specs/migration.md) before changing live files.

## Use

- `/me-setup` and `/me-setup status` show rig status. Roles pin model/thinking in `agents/*.md` frontmatter; with no role model, delegated children use Pi's own default model.
- Use Pi skills directly when they fit. For a separate worker or independent review, use `delegate`; before delegating, read [skills/delegate/SKILL.md](skills/delegate/SKILL.md).
- Skills written for another harness may call an unavailable `Skill` tool; read the named skill's `SKILL.md` instead.
- Read engineering guidance at `~/.agents/CODING_STANDARDS.md` before implementation, code edits, debugging, tests, or code review. `GLOBAL_AGENTS.md` holds always-loaded output and publication rules.

## Checks

```bash
npm ci --prefix extensions
npm test --prefix extensions
bin/delegate.test.sh
bin/install.test.sh
```

`bin/delegate.itest.sh` is a paid live-model integration, excluded from routine checks; run only with explicit spend authorization for that invocation.

## Project map

- `extensions/`: Pi package and project-maintained extension
- `agents/`: role prompts; not linked by the installer
- `skills/`: repository-maintained skills, linked individually into `~/.agents/skills`; `skills/delegate/SKILL.md` is the delegation guide
- `CODING_STANDARDS.md`: engineering reference, installed at `~/.agents/CODING_STANDARDS.md`
- `GLOBAL_AGENTS.md`: global output and publication policy
- `docs/`: architecture decisions and research
