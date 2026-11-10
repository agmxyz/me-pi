# me-pi

[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

My [Pi](https://github.com/earendil-works/pi) setup, shared as a reference rather than a product. It changes as my workflow does. It contains extensions you can install on their own.

## Extensions

### pi-workers

[![npm](https://img.shields.io/npm/v/@agmxyz/pi-workers)](https://www.npmjs.com/package/@agmxyz/pi-workers)

[`@agmxyz/pi-workers`](packages/pi-workers/README.md) hands searches, reviews and code changes to separate workers, so your main session stays focused.

```sh
pi install npm:@agmxyz/pi-workers
```

Restart Pi or run `/reload`.

Workers are **not sandboxed**: they run with your OS permissions, and `implement` edits and commits in your real checkout. A passing check doesn't mean the code is correct; review the change.

[Package README](packages/pi-workers/README.md) · [Delegation guide](packages/pi-workers/docs/delegate.md) · [Changelog](packages/pi-workers/CHANGELOG.md)

### Small extensions

| Extension | What it does | Filter entry |
|---|---|---|
| [`steps`](extensions/steps.ts) | Live checklist below the editor, set by the model through a `plan` tool. `/steps off` turns it off in every session; `/steps on` turns it back on. | `"extensions/steps.ts"` |
| [`minimal-footer`](extensions/minimal-footer.ts) | One-line footer: `folder (branch)  ctx%/window` left, `model • thinking` right; extension statuses on a second line. | `"extensions/minimal-footer.ts"` |

To install one or both, add this repo to `packages` in `~/.pi/agent/settings.json` with the filter entries you want, then run `/reload`:

```json
{ "packages": [{ "source": "git:github.com/agmxyz/me-pi", "extensions": ["extensions/steps.ts", "extensions/minimal-footer.ts"] }] }
```

Without a filter, `pi install git:github.com/agmxyz/me-pi` loads both plus the pi-workers extensions.

## Setup

My personal setup; it runs this checkout's working tree. You don't need it to use an extension.

- [`GLOBAL_AGENTS.md`](GLOBAL_AGENTS.md): my global policy for Pi sessions
- [`skills/`](skills): user-level skills
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
- A user-visible change to an extension package adds a line under `## [Unreleased]` in its changelog (create the heading if missing).
- Before changing `GLOBAL_AGENTS.md` or the delegate tool's prompt, description or schema, run the [routing evals](evals/README.md). They cost real money and don't run in CI.

## Credits

The skills adapt or build on Matt Pocock's [skills](https://github.com/mattpocock/skills) and Lauren Tan's [pstack](https://github.com/cursor/plugins), both MIT; pinned sources are in each skill's frontmatter `metadata.credits`.

## License

[MIT](LICENSE)
