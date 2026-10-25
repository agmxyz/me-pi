# me-pi

`me-pi` is a Pi package with three extensions: `delegate` for isolated worker sessions, `guard` for confirmation on risky bash, and `Skill` for loading discovered skills by name.
The main Pi session stays responsible for decisions; delegated work gets its own task and returns an answer without filling the main context with its reading.

## Install for Pi

Install the package from Git:

```sh
pi install git:github.com/0bmario/me-pi
```

Pi must be installed and able to access the repository. The GitHub repository is private, so Git authentication/access must be available to Pi; GitHub transport has not been tested. After changing package settings, use `/reload` or restart Pi to load the updated extensions. `/reload` ends active background delegate jobs, so wait for them first.

To load **only `delegate`**, configure its package filter in your personal Pi settings (usually `~/.pi/agent/settings.json`):

```json
{
  "packages": [
    {
      "source": "git:github.com/0bmario/me-pi",
      "extensions": ["extensions/delegate.ts"]
    }
  ]
}
```

This is the complete `packages` property shape, not a complete settings file. Merge the entry into your existing `packages` array and preserve other settings and entries; if the package is already listed, replace only its declaration with the filtered object. The filter selects one extension entrypoint, while its imported helper modules remain part of the package. It does not activate the separate `guard` or `Skill` extensions. Do not copy `extensions/delegate.ts` alone: it imports sibling modules from this package.

A Pi package install loads the package's declared extensions; it does not install this repository's global `GLOBAL_AGENTS.md` policy, delegate model pools, your skills, or the author's full setup. Web tools for `research` and `challenge` require the separately installed `pi-web-access` extension. The optional author `./install.sh` setup links the global policy and installs other personal resources, affecting all Pi sessions; it is not needed to install the package. See [Full rig setup](docs/setup.md) before choosing it.

## Extensions and everyday use

- **`delegate`** registers a model-callable tool. Ask Pi to “have a scout find where the retry policy is implemented and return path-and-line evidence,” “review this saved diff for correctness,” or “challenge this plan.” All roles except `implement` are read-only unless `output: true` allows drafts in a private temporary directory; `research` and `challenge` use web tools when `pi-web-access` is installed. See the [delegate guide](docs/delegate.md) for roles, model pools, and recovery.
- **`guard`** starts enabled and asks before matching risky bash commands; without an interactive UI it blocks them. Use `/guard on` or `/guard off` to toggle it for the current session. It is a pattern-based safety net, not a command parser or sandbox.
- **`Skill`** lets Pi load a named skill that Pi has already discovered. It does not install or bundle skills.

Use `/delegate status` to check model pools, missing worker tools, running jobs, and recent calls; `/delegate models` prints the model-config path. For long work, ask Pi to set `background: true`. Use the returned ID with `/delegate cancel <id>` to stop a background job.

## Safety

Pi extensions run with Pi's operating-system permissions. Delegated workers are not a sandbox: they read project files, and web-enabled workers combine those reads with network tools. `implement` edits and runs commands in your real checkout, then commits there; use it only on a clean, non-`main`/`master` branch and review its handback. Guard and worker checks are limits, not security boundaries. Read [safety and recovery](docs/delegate.md#safety-and-recovery) before enabling write-capable work.

## Development

Pi is required to install and use the extensions; package behavior is verified against Pi 1.3.0. Development requires Node.js ≥22.19.

```sh
npm ci                            # once, and after package-lock.json changes
npm run check                     # read-only lint, typecheck, tests, installer smoke test, diff check
npm run check --prefix extensions # compatibility/acceptance command; forwards to the root check
npm run fix                       # apply available Biome formatting/lint fixes
```

See [delegate configuration and operation](docs/delegate.md) and [optional full rig setup](docs/setup.md). Pi's [package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) describe package sources, filters, and settings scope.
