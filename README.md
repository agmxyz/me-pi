# me-pi

[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

My [Pi](https://github.com/earendil-works/pi) setup, shared as a reference rather than a product. It changes as my workflow does. It contains extensions you can install on their own.

## Extensions

| Extension | What it does | Install |
|---|---|---|
| [`pi-workers`](packages/pi-workers/README.md) [![npm](https://img.shields.io/npm/v/@agmxyz/pi-workers)](https://www.npmjs.com/package/@agmxyz/pi-workers) | Hands searches, research and reviews to separate read-only workers, so your main session stays focused. [Delegation guide](packages/pi-workers/docs/delegate.md) · [Changelog](packages/pi-workers/CHANGELOG.md) | `pi install npm:@agmxyz/pi-workers` |
| [`steps`](docs/extensions.md#steps) | Live checklist below the editor set by the model via a `plan` tool, with elapsed time on the current step and a transcript heading when each step starts. Toggle with `/steps on` and `/steps off`. | `"extensions/steps.ts"` |
| [`watch`](docs/extensions.md#watch) | Tracks long-running background commands in the footer by polling `ps` (no tokens) and wakes the model once when they finish. | `"extensions/watch.ts"` |
| [`minimal-footer`](docs/extensions.md#minimal-footer) | One-line footer showing `folder (branch)  ctx%/window (auto)` left, `model • thinking` right, and extension statuses on a second line. | `"extensions/minimal-footer.ts"` |
| [`autocompact`](docs/extensions.md#autocompact) | Sets Pi's auto-compaction threshold for the current model as a percentage of its context window (`/autocompact 50`, `/autocompact auto`, or `/autocompact` to inspect). | `"extensions/autocompact.ts"` |
| [`compact-tools`](docs/extensions.md#compact-tools) | Replaces Pi's tool boxes with one-line collapsed rows and a compact live area above the editor, hiding no-op lookups and showing output only on failure (or expanded with `ctrl+o`). | `"extensions/compact-tools.ts"` |
| [`hide-thinking-label`](docs/extensions.md#hide-thinking-label) | Removes the `Thinking...` label, and the blank lines around it, that Pi shows for a hidden thinking block. | `"extensions/hide-thinking-label.ts"` |

pi-workers' workers are **not sandboxed**: they run with your OS permissions and can read your project. They never edit it: your session makes every change.

Install pi-workers with its command, then restart Pi or run `/reload`. For the others, add this repo to `packages` in `~/.pi/agent/settings.json` with the filter entries you want, then run `/reload`:

```json
{ "packages": [{ "source": "git:github.com/agmxyz/me-pi", "extensions": ["extensions/steps.ts", "extensions/minimal-footer.ts"] }] }
```

Without a filter, `pi install git:github.com/agmxyz/me-pi` loads all six plus the pi-workers extensions, so don't combine it with the npm install.

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
- A user-visible change to `packages/pi-workers/` adds a line under `## [Unreleased]` in [its changelog](packages/pi-workers/CHANGELOG.md) (create the heading if missing).
- Before changing `GLOBAL_AGENTS.md` or the delegate tool's prompt, description or schema, run the [routing evals](evals/README.md). They cost real money and don't run in CI.

## Credits

The skills adapt or build on Matt Pocock's [skills](https://github.com/mattpocock/skills) and Lauren Tan's [pstack](https://github.com/cursor/plugins), both MIT; pinned sources are in each adapted skill's frontmatter `metadata.credits`.

## License

[MIT](LICENSE)
