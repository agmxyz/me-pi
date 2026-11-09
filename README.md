# me-pi

[![npm](https://img.shields.io/npm/v/@agmxyz/pi-workers)](https://www.npmjs.com/package/@agmxyz/pi-workers)
[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

Delegation for the [Pi](https://github.com/earendil-works/pi) coding agent, plus the personal setup I build it in.

## pi-workers

[`@agmxyz/pi-workers`](packages/pi-workers/README.md) hands searches, reviews and code changes to separate workers and brings back their answers, so your main Pi session stays focused.

Requires Pi 1.5.0 on macOS or Linux.

```sh
pi install npm:@agmxyz/pi-workers
```

Restart Pi or run `/reload`, then work as usual. Pi delegates when a task is worth it, or when you ask.

- **`scout`** searches read-only and returns a few lines with `path:line` evidence.
- **`general`** reviews, researches or investigates, read-only.
- **`implement`** edits on your feature branch, runs your check, and commits.

Workers are **not sandboxed**: they run with your OS permissions, and `implement` edits and commits in your real checkout. A passing check doesn't mean the code is correct; review the change.

- [Package README](packages/pi-workers/README.md): examples, configuration, limits, safety
- [Delegation guide](packages/pi-workers/docs/delegate.md): roles, model pools, recovery
- [Changelog](packages/pi-workers/CHANGELOG.md)

## My Pi setup

My Pi setup, shared as a reference rather than a product. It changes as my workflow does. You don't need it for `pi-workers`.

- [`GLOBAL_AGENTS.md`](GLOBAL_AGENTS.md): my global policy for Pi sessions
- [`skills/`](skills): my user-level skills
- [`.agents/skills/`](.agents/skills): skills only for this repo
- [`install.sh`](install.sh): installs the setup machine-wide; read [docs/setup.md](docs/setup.md) first

## Contributing

Node ≥22.19.

```sh
npm ci
npm run check                    # lint, typecheck, tests, installer test
npm run fix                      # apply Biome fixes
node --test test/guard.test.ts   # one test file
```

- Follow [docs/coding-standards.md](docs/coding-standards.md) and [GLOSSARY.md](GLOSSARY.md).
- A user-visible change to `packages/pi-workers/` adds a line under `## [Unreleased]` in its [changelog](packages/pi-workers/CHANGELOG.md).
- Changing `GLOBAL_AGENTS.md` or the delegate tool's prompt, description or schema? Run the [routing evals](evals/README.md) first. They cost real money and don't run in CI.

Good first issues: [#35](https://github.com/agmxyz/me-pi/issues/35), [#40](https://github.com/agmxyz/me-pi/issues/40).

## Credits

The skills adapt work from Matt Pocock's [skills](https://github.com/mattpocock/skills) and Lauren Tan's [pstack](https://github.com/cursor/plugins) (both MIT); each skill's frontmatter `metadata.credits` lists the pinned sources.

## License

[MIT](LICENSE)
