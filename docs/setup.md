# Optional full rig setup

This is the author's personal setup, and it runs this checkout's working tree. For delegation only, install the package instead: `pi install npm:@agmxyz/pi-workers`.

`./install.sh` adopts the author's full me-pi rig across all Pi sessions. A package-only install ([pi-workers](../packages/pi-workers/README.md)) needs none of it: it loads the extensions declared in `package.json`, and `pi.skills: []` intentionally keeps the package's conventional skill source directory out of package discovery.

Run `./install.sh` only from the live checkout's main session, never a worktree, temp clone, or worker. If you previously installed `npm:@agmxyz/pi-workers` or `git:github.com/agmxyz/me-pi`, remove that package with `pi remove` before installing this local checkout, to avoid loading the extensions twice. The script requires `pi` on `PATH` and changes personal Pi resources that apply across sessions and projects:

- Links this checkout's `GLOBAL_AGENTS.md` to `~/.pi/agent/AGENTS.md` only when that destination is absent; every Pi session that reads it then uses this policy. An existing file or different link is left unchanged and causes the installer to report an error.
- Links the repo-owned `implement-me-pi`, `implement-spec-me-pi`, and `ticket-readiness` skill directories under `~/.pi/agent/skills/`. Pi discovers these user-level skills from any target project; no per-project copies are needed. Package discovery stays gated with `pi.skills: []`; the skills are exposed only through these user-level links. The repo-only `pi-live-test` lives in `.agents/skills/` and is not linked: Pi loads it only in sessions started inside this checkout, after you grant project trust.
- Preflights the literal repository skill destination paths under `~/.pi/agent/skills/<name>` and `~/.agents/skills/<name>` before setup mutation and leaves existing entries unchanged. It does not scan every discovered directory for duplicate `name` frontmatter in `SKILL.md`, so its preflight is not proof of unique discovery: a renamed pilot under a discovered root such as `~/.agents/skills/` can still collide in Pi's loader. The installer does not migrate a personal copy. For an adopter with a personal pilot, obtain explicit approval before preserving the complete pilot outside all applicable discovery roots and aliases, without a link back, then verify unique discovery through Pi's real loader from each intended project before activation.
- Registers the checkout's root package in Pi and removes a prior `extensions/` package registration when Pi lists that local source, avoiding duplicate extension loading. The root package also loads the rig's `steps.ts` checklist and `minimal-footer.ts`; remove any copies of them from `~/.pi/agent/extensions/`, or the `plan` tool registers twice.
- Installs the unpinned npm package `pi-web-access`, which supplies the web tools used when a delegate call sets `web: true`.
- Does not install Claude Code auth extensions or modify existing Anthropic auth package registrations.
- Copies Pi's `interactive-shell.ts` and `handoff.ts` examples into `~/.pi/agent/extensions/` if absent. Existing copies are not overwritten; differing copies are reported.
- Runs `rtk init --global --agent pi` if `rtk` is available.

Review `GLOBAL_AGENTS.md` and the install script before choosing this setup. Restart Pi or run `/reload` after a successful install to discover the skills. For model pools, worker operation, and recovery, see the [delegate guide](../packages/pi-workers/docs/delegate.md).

Pi loads this checkout as a local path, so it runs whichever branch and working tree are checked out here; after a `git pull` or branch switch, `/reload` picks up the change.

## After install

`install.sh` does not log in or install provider packages. Then:

1. Run `/login` in Pi for each provider you use.
2. For the `claude-code` provider (a Claude subscription), run `pi install https://github.com/earendil-works/pi-claude-code`.
3. Optionally create `~/.pi/agent/delegate.json` to choose worker models; without it, workers use the session's model. See [Configure model pools](../packages/pi-workers/docs/delegate.md#configure-model-pools).
4. Verify: run `/reload`, then `/delegate status` resolves the pools, `/guard` reports `guard on`, and the skills list shows `implement-me-pi`, `implement-spec-me-pi`, and `ticket-readiness` (plus `pi-live-test` when Pi runs inside this checkout).

## Undo

```sh
rm ~/.pi/agent/AGENTS.md                     # only if it links to this checkout's GLOBAL_AGENTS.md
rm ~/.pi/agent/skills/implement-me-pi ~/.pi/agent/skills/implement-spec-me-pi ~/.pi/agent/skills/ticket-readiness
rm ~/.pi/agent/skills/pi-live-test           # left by older installs, if present
pi remove /path/to/me-pi                     # this checkout
pi remove npm:pi-web-access                  # unless you use it elsewhere
rm ~/.pi/agent/extensions/interactive-shell.ts ~/.pi/agent/extensions/handoff.ts   # if unedited
rtk init --global --agent pi --uninstall     # only if install.sh set it up and you don't want it
```
