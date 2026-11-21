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
| [`steps`](extensions/steps.ts) | Steps the model sets through a `plan` tool. Each step it starts leaves one heading in the transcript (`▸ 2/5 Wire the parser`), drawn once and never changed; one line below the editor shows the current step and how long it has run (`● 2/5 Wire the parser · 12s`). `/steps off` turns it off for new sessions and this one (others on `/reload`); `/steps on` turns it back on. | `"extensions/steps.ts"` |
| [`minimal-footer`](extensions/minimal-footer.ts) | One-line footer: `folder (branch)  ctx%/window` left, `model • thinking` right; extension statuses on a second line. | `"extensions/minimal-footer.ts"` |
| [`compact-tools`](extensions/compact-tools.ts) | One-line rows for tool calls while tool output is collapsed, with no background box. The transcript shows what was done, not what came back: a status glyph (`●` running, `✓` done, `✗` failed), what ran, and facts such as `40 lines · 4.2s`. `bash` drops a leading `cd` (the directory is named, as `in web`, only when it differs from the command row above), `set -e`, `2>&1` and a closing `\| tail -N` from the command and cuts a long one in the middle (at its end when only a few characters over); `edit` shows `+added -removed`; `read` and `write` show a short path and a line count. Only a failure shows output: a failed command keeps its end from the first error-like line in its last 20 lines, and at least 5, with the error-like lines in red and `file:line` references as links where the terminal supports them. A duration of 30s or more is yellow. While the agent works, a call shows only in a three-line area above the editor, the running one with its elapsed time and the end of its output. A row enters the transcript once the next step shows what became of it. Followed by another step, a call known to change nothing (`read`, `rg`, `git log`, a passing `npm test`) keeps no line, and those that open a stretch of work are one count (`⋮ 5 calls, nothing changed`); any command the extension does not know keeps its line, and so does a passing run of a command that failed earlier. Writing to a file under `/tmp` counts as changing nothing, unless the work is done there. A step followed by text keeps its line, and a line once drawn is never taken back, so a row that has scrolled away does not change and Pi does not have to repaint the screen. Failures, writes, and edits show as soon as the call ends and stay, and a call made before one of them, or before a tool that draws its own row, in the same message shows with it, running or not; a failed command still on screen shrinks to `✗ … · passed later` once the same command passes, also behind a runner such as `uv run` (one that has scrolled away stays as drawn); a passing run that ends in a pipe does not count, since the shell reports only the last program's exit code. When the agent stops, the area becomes one line that sums up the run: `✗ open: npm run lint · exit 1 · 2 files changed · 6 calls · 1m 12s`, naming the newest failure still open. Other tools keep their own lines behind the glyph; the line of a tool that draws its own shell, such as a `plan` step heading, stands above the first row of its message, wherever in the message the tool was called. Failed `write` and `edit` calls and expanded rows (`ctrl+o`) show everything. | `"extensions/compact-tools.ts"` |
| [`hide-thinking-label`](extensions/hide-thinking-label.ts) | Removes the `Thinking...` label, and the blank lines around it, that Pi shows for a hidden thinking block. | `"extensions/hide-thinking-label.ts"` |

To install any of them, add this repo to `packages` in `~/.pi/agent/settings.json` with the filter entries you want, then run `/reload`:

```json
{ "packages": [{ "source": "git:github.com/agmxyz/me-pi", "extensions": ["extensions/steps.ts", "extensions/minimal-footer.ts"] }] }
```

Without a filter, `pi install git:github.com/agmxyz/me-pi` loads all four plus the pi-workers extensions.

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
