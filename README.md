# me-pi

A Pi coding-agent setup for me.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git
cd me-pi
./install.sh
```

The installer registers `extensions/` as a local Pi package; installs pinned `pi-web-access`; links tracked agent and skill entries individually into machine-owned directories; links the `delegate` helper into `~/.local/bin` when that directory exists; and seeds `settings.json` only if no live file exists. It copies Pi's interactive-shell example into the live extension directory if missing, and runs RTK's Pi setup when `rtk` is available. Existing user entries are preserved; name collisions are reported rather than overwritten. To refresh the interactive-shell copy, remove it from `~/.pi/agent/extensions/` and rerun the installer.

External installers write to live user directories, not this repo. The installer detaches legacy whole-directory links into this repo without copying their contents back, and refuses a symlinked `settings.json` or package-store links into the repo. Review any collision it reports. Install the `rtk` binary separately if you want its integration. Restart Pi after installation.

Keep credentials and live settings in `~/.pi/agent/`, not this repo. The tracked `settings.json` is a first-install template; `pi install` records package sources in the live settings.

## Commands

- `/me-setup`: interactive default and per-agent model chooser; `/me-setup status`: inspect the rig. Choices persist in live `subagents.*` settings and `delegate` applies matching role overrides.

## Tests

```bash
npm ci --prefix extensions
npm test --prefix extensions
```

## Layout

- `extensions/`: local Pi package with the project-maintained extension
- `agents/`: implementer, reviewer, and devil's advocate definitions
- `skills/`: repo-maintained personal skills shared with Codex through per-skill links
- `settings.json`: initial settings template
- `APPEND_SYSTEM.md`: main-session system addendum
- `GLOBAL_AGENTS.md`: personal Output + Engineering rules for every agent; linked as `~/.pi/agent/AGENTS.md` (main + workers), imported by `~/.claude/CLAUDE.md`, copied into `~/.codex/AGENTS.md`
- `docs/`: architecture decisions and research
