# me-pi

`me-pi` is a Pi package with three extensions: `delegate` for isolated worker sessions, `guard` for confirmation on risky bash, and `Skill` for loading discovered skills by name.
The main Pi session stays responsible for decisions; delegated work gets its own task and returns an answer without filling the main context with its reading.

## Install for Pi

Install the package from Git:

```sh
pi install git:github.com/0bmario/me-pi
```

Pi must be installed and able to access the repository. After changing package settings, use `/reload` or restart Pi to load the updated extensions. `/reload` ends active background delegate jobs, so wait for them first.

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

A package install loads only the declared extensions. It does not install the global `GLOBAL_AGENTS.md` policy, delegate model pools, or the repo's skills: `pi.skills: []` intentionally keeps the package's conventional skill sources out of package discovery. The optional author `./install.sh` adopts the full rig for all Pi sessions (global policy link, user-level `implement-me-pi` and `implement-spec-me-pi` skills, `pi-web-access`, and more); read [Full rig setup](docs/setup.md) before choosing it.

**A4 activation gate:** Standing recovery depends on the currently governing policy, supported provenance-capable runtime, and matching reviewed skills being installed and loaded, with every lifecycle gate revalidated in the actual session using them. This README is not a live status ledger; verify the current session before relying on A4. Gate and envelope: [delegate guide](docs/delegate.md#standing-bounded-coordinator-recovery--load-gated); dated adoption evidence: [setup guide](docs/setup.md).

## Extensions and everyday use

- **`delegate`** registers a model-callable tool. Ask Pi to “have a scout find where the retry policy is implemented and return path-and-line evidence,” “review this saved diff for correctness,” or “challenge this plan.” See the [delegate guide](docs/delegate.md) for roles, model pools, status and cancellation, limits, and recovery.
- **`guard`** starts enabled and asks before matching risky bash commands; without an interactive UI it blocks them. Use `/guard on` or `/guard off` to toggle it for the current session. It is a pattern-based safety net, not a command parser or sandbox.
- **`Skill`** lets Pi load a named skill that Pi has already discovered. It does not install or bundle skills.

## Safety

Pi extensions and delegated workers run with Pi's operating-system permissions and are not a sandbox; guard and worker checks are limits, not security boundaries. `implement` edits, runs commands, and commits in your real checkout, so use it only on a clean, non-`main`/`master` branch and review its handback. Read [safety and recovery](docs/delegate.md#safety-and-recovery) before enabling write-capable work.

## Development

Pi is required to install and use the extensions; package behavior is verified against Pi 1.3.0. Development requires Node.js ≥22.19.

```sh
npm ci                            # once, and after package-lock.json changes
npm run check                     # read-only lint, typecheck, tests, installer smoke test, diff check
npm run check --prefix extensions # compatibility/acceptance command; forwards to the root check
npm run fix                       # apply available Biome formatting/lint fixes
```

Pi's [package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) describe package sources, filters, and settings scope.
