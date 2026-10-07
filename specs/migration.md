# Policy refresh, migration, and reinstall

## Refresh this rig

After a policy change, run `./install.sh` to link updated rig documents, then start a fresh Pi session. Existing sessions may retain previously loaded instructions; `/reload` does not prove that old instructions disappeared. Resolve installer-reported document collisions manually, preserving machine-owned files. Confirm `/me-setup` and `/me-setup status`, skill availability, `~/.agents/CODING_STANDARDS.md`, `~/.agents/DELEGATION.md`, optional independent review, and worker safeguards in the fresh session.

## Reinstall Pi

Reinstalling Pi is optional and separate from updating this rig. First inventory the installed version, launcher/PATH, and supported uninstall/reinstall procedure. Securely back up machine-local credentials, settings, model preferences, and session data outside Git. The managed installation may share `~/.pi/agent` with that state; never delete `~/.pi` or `~/.agents` wholesale.

Reinstall the intended Pi version, then run `./install.sh` and the fresh-session checks above. The installer requires Pi and does not restore credentials, externally managed skills, model preferences, or unrelated integrations from nothing.

## Credential boundary

Keep credentials and live settings in `~/.pi/agent/`, never in the repository. Tracked `settings.json` is a first-install template, not a backup of live auth or settings.
