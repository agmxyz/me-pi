# me-pi

[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

Home of [`pi-workers`](packages/pi-workers), a package that lets the [Pi](https://github.com/earendil-works/pi) coding agent hand work to separate worker processes, and of my own Pi setup, where I develop it.

## pi-workers

Pi extensions that send searches, reviews and scoped changes to separate worker processes and bring back their answers, so your main session stays focused on decisions.

```sh
pi install npm:@agmxyz/pi-workers
```

Requires Pi 1.5.0 on macOS or Linux. Restart Pi or run `/reload` and work as usual: Pi delegates broad searches, large reviews and multi-file changes on its own, or when you ask it to.

- **`scout`** searches read-only and returns a few sentences with `path:line` evidence.
- **`general`** is a read-only worker Pi briefs as a reviewer, researcher, plan critic or investigator.
- **`implement`** edits on your feature branch, runs the check you name, and commits.

Workers are not sandboxed: they run with your OS permissions, and `implement` edits and commits in your real checkout. A passing check doesn't mean the code is correct; review the change.

- [Package README](packages/pi-workers/README.md): examples, limits, configuration, safety, uninstall
- [Delegation guide](packages/pi-workers/docs/delegate.md): roles, model pools, recovery
- [Changelog](packages/pi-workers/CHANGELOG.md): before 1.0.0, a minor bump may change behavior

## The rest of my setup

Shared as a reference rather than a product; it changes as my workflow does. You don't need any of it for `pi-workers`; read and copy what's useful.

- [`GLOBAL_AGENTS.md`](GLOBAL_AGENTS.md): my global policy. Output style, engineering defaults, which actions need my approval, and how to handle secrets and untrusted content.
- [`skills/`](skills): `implement-me-pi` runs one task with a worker and independent review; `implement-spec-me-pi` implements a ticket graph on one branch; `ticket-readiness` checks which tickets an agent could implement, prove, and merge unattended; `evolvability-review` reviews a diff for the cost it adds to the next change. Some expect other skills from my own collection.
- [`.agents/skills/`](.agents/skills): skills useful only in this repo, such as `pi-live-test`.
- [`install.sh`](install.sh): wires these in machine-wide. It is my personal setup and changes what Pi loads in every session; read [docs/setup.md](docs/setup.md) (requirements, effects, undo) before running it.

## Contributing

Node ≥22.19.

```sh
npm ci
npm run check                    # lint, typecheck, tests, installer test
npm run fix                      # apply Biome fixes
node --test test/guard.test.ts   # one test file
```

Follow [docs/coding-standards.md](docs/coding-standards.md) and [GLOSSARY.md](GLOSSARY.md). A user-visible change to `packages/pi-workers/` adds a line under `## [Unreleased]` in its [CHANGELOG](packages/pi-workers/CHANGELOG.md). Before changing `GLOBAL_AGENTS.md` or the delegate tool's prompt text, run the manual routing evals ([evals/README.md](evals/README.md)); they spend real money and never run in CI. CI runs `npm run check` on every PR.

Good first issues: [#35](https://github.com/agmxyz/me-pi/issues/35), [#40](https://github.com/agmxyz/me-pi/issues/40).

## Credits

The skills adapt work from Matt Pocock's [skills](https://github.com/mattpocock/skills) and Lauren Tan's [pstack](https://github.com/cursor/plugins) (both MIT); each skill's frontmatter `metadata.credits` has the pinned sources.

## License

[MIT](LICENSE)
