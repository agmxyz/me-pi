# me-pi

A Pi coding-agent setup that uses Matt Pocock's engineering skills. The main session handles small fixes and coordinates agents for larger work.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git
cd me-pi
./install.sh
```

The installer symlinks extensions, agents, prompts, and `APPEND_SYSTEM.md` into `~/.pi/agent/`, and skills into `~/.agents/skills/`. It copies `settings.json` only if no live settings file exists. Restart pi sessions after installation.

Keep credentials and live settings in `~/.pi/agent/`, not this repo. The tracked `settings.json` is a first-install template.

## Layout

- `extensions/`: pi extensions
- `agents/`: implementer, reviewer, and devil's advocate definitions
- `prompts/`: reusable workflows
- `skills/`: shared skills linked at `~/.agents/skills/`
- `settings.json`: initial settings template
- `APPEND_SYSTEM.md`: main-session system addendum
- `docs/`: architecture decision records
