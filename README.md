# me-pi

A Pi coding-agent setup for me.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git
cd me-pi
./install.sh
```

The installer registers `extensions/` as a local Pi package; installs pinned `pi-subagents` and `pi-web-access` (with bundled `pi-subagents` prompts disabled); links tracked agent and skill entries individually into machine-owned directories; and seeds `settings.json` only if no live file exists. It copies Pi's interactive-shell example into the live extension directory if missing, and runs RTK's Pi setup when `rtk` is available. Existing user entries are preserved; name collisions are reported rather than overwritten. To refresh the interactive-shell copy, remove it from `~/.pi/agent/extensions/` and rerun the installer.

External installers write to live user directories, not this repo. The installer detaches legacy whole-directory links into this repo without copying their contents back, and refuses a symlinked `settings.json` or package-store links into the repo. Review any collision it reports. Install the `rtk` binary separately if you want its integration. Restart Pi after installation.

Keep credentials and live settings in `~/.pi/agent/`, not this repo. The tracked `settings.json` is a first-install template; `pi install` records package sources in the live settings.

## Commands

- `/me-setup`: choose default and per-agent models; `/me-setup status`: inspect the rig.

## Tests

```bash
npm ci --prefix extensions
npm test --prefix extensions
```

## Layout

- `extensions/`: local Pi package with project-maintained extensions
- `agents/`: implementer, reviewer, and devil's advocate definitions
- `skills/`: curated skills shared with Codex through per-skill links
- `settings.json`: initial settings template
- `APPEND_SYSTEM.md`: main-session system addendum
- `docs/`: architecture decisions and research

## Credits

- `skills/`: most engineering and productivity skills are vendored from [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT), then customized. The rest are local.
- `extensions/minimal.ts`: inspired by the minimal footer in [`disler/pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code).
