# me-pi

A Pi coding-agent setup for me.

## Install

```bash
git clone git@github.com:0bmario/me-pi.git
cd me-pi
./install.sh
```

The installer registers `extensions/` as a local Pi package; installs pinned `pi-web-access`; links tracked agent and skill entries individually into machine-owned directories; links shared coding standards at `~/.agents/CODING_STANDARDS.md`; links the `delegate` helper into `~/.local/bin` when that directory exists; and seeds `settings.json` only if no live file exists. It copies Pi's interactive-shell example into the live extension directory if missing, and runs RTK's Pi setup when `rtk` is available. Existing user entries are preserved; name collisions are reported rather than overwritten. To refresh the interactive-shell copy, remove it from `~/.pi/agent/extensions/` and rerun the installer.

External installers write to live user directories, not this repo. The installer detaches legacy whole-directory links into this repo without copying their contents back, and refuses a symlinked `settings.json` or package-store links into the repo. Review any collision it reports. Install the `rtk` binary separately if you want its integration. Restart Pi after installation.

Keep credentials and live settings in `~/.pi/agent/`, not this repo. The tracked `settings.json` is a first-install template; `pi install` records package sources in the live settings.

## Commands

- `/me-setup`: interactive default and per-agent model chooser; `/me-setup status`: inspect the rig. Choices persist in live `subagents.*` settings and `delegate` applies matching role overrides.

## Workflows

Pi is the main interactive driver. Use relevant skills directly for planning, research, implementation/TDD, and review; use `delegate` when a separate worker or independent review helps. No global clean-review gate applies to main-session commits. Delegate workers still leave changes uncommitted and cannot publish.

External tools own their invocation, configuration and execution rules; consult their instructions when selecting one. `/me-setup` configures only Pi/delegate models. Publication authorization is defined in `GLOBAL_AGENTS.md`.

Matt Pocock skills in `~/.agents/skills` remain externally managed, not vendored or installed by this rig. Pi discovers that directory; use `/skill:name` to invoke an installed skill explicitly. Skills written for another harness may reference an unavailable Skill tool: read the named skill's `SKILL.md` instead. Their review/commit steps do not authorize publication.

## Migration and reinstall

Start a fresh Pi session after this policy change. Existing sessions may retain old instructions; `/reload` is not proof that previously supplied restrictions disappeared. Verify `/me-setup`, `/me-setup status`, skill availability, optional independent review and worker safeguards in the fresh session.

Reinstalling Pi is optional and separate from this refactor. First inventory the installed version, launcher/PATH and supported uninstall/reinstall procedure. Securely back up machine-local credentials, settings, models and session data outside Git. The managed installation may share `~/.pi/agent` with that state: do not delete `~/.pi` or `~/.agents` wholesale. Reinstall the intended Pi version, then run `./install.sh` and the fresh-session checks. This installer requires Pi and does not restore auth, external skills, model preferences or unrelated integrations from nothing.

## Tests

```bash
npm ci --prefix extensions
npm test --prefix extensions
bin/delegate.test.sh
bin/install.test.sh
```

Installer checks use a temporary HOME, fixture repo and fake Pi/RTK; no live installation or network calls. `bin/delegate.itest.sh` is an opt-in paid test; run only with explicit spend approval.

## Layout

- `extensions/`: local Pi package with the project-maintained extension
- `agents/`: implementer, reviewer, devil's advocate, and scout definitions
- `skills/`: repo-maintained personal skills shared with Codex through per-skill links
- `settings.json`: initial settings template
- `APPEND_SYSTEM.md`: optional delegation instructions for main sessions
- `GLOBAL_AGENTS.md`: always-loaded output/authorization rules and coding-standards pointer; linked as `~/.pi/agent/AGENTS.md` (main + workers), imported by `~/.claude/CLAUDE.md`, copied into `~/.codex/AGENTS.md`
- `CODING_STANDARDS.md`: engineering reference, read before implementation, code edits, debugging, tests or review; linked at `~/.agents/CODING_STANDARDS.md` for cwd-independent access
- `docs/`: architecture decisions and research
