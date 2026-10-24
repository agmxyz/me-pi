# Optional full rig setup

You do not need the repository's installer to use the Pi package. A package install loads the extensions declared in `package.json`; it does not adopt the author's global policy, install model pools or skills, or set up the rest of this rig.

`./install.sh` is an optional personal setup for someone deliberately adopting the full me-pi rig. Run it only from the checkout you intend to use. It requires `pi` on `PATH` and makes changes to personal Pi resources that apply across sessions:

- Links this checkout's `GLOBAL_AGENTS.md` to `~/.pi/agent/AGENTS.md` only when that destination is absent. An existing file or different link is left unchanged and causes the installer to report an error.
- Registers the checkout's root package in Pi and removes a prior `extensions/` package registration when Pi lists that local source, avoiding duplicate extension loading.
- Installs `pi-web-access@0.38.0`, which supplies the web tools used by delegate's `research` and `challenge` roles.
- Does not install Claude Code auth extensions or modify existing Anthropic auth package registrations.
- Copies Pi's `interactive-shell.ts` and `handoff.ts` examples into `~/.pi/agent/extensions/` if absent. Existing copies are not overwritten; differing copies are reported.
- Runs `rtk init --global --agent pi` if `rtk` is available.

The global policy link affects every Pi session that reads `~/.pi/agent/AGENTS.md`; it is separate from installing the package. Review `GLOBAL_AGENTS.md` and the install script before choosing this setup. The script preserves an existing policy file rather than replacing it, but reports that the me-pi policy is not active when the destination is occupied.

For a package-only install, use the Git command in the [README](../README.md). The GitHub repository is private, so access and authentication must be available to Pi; GitHub transport has not been tested. See the [delegate guide](delegate.md) for model pools, worker operation, and recovery.
