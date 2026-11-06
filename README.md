# me-pi

[![check](https://github.com/agmxyz/me-pi/actions/workflows/check.yml/badge.svg)](https://github.com/agmxyz/me-pi/actions/workflows/check.yml)

My [Pi](https://github.com/earendil-works/pi) setup, shared as a reference rather than a product. It changes as my workflow does.

## pi-workers

The part you can install on its own is [`pi-workers`](packages/pi-workers): Pi extensions that send searches, reviews and scoped changes to separate worker processes and bring back their answers, so your main session stays focused on decisions.

```sh
pi install npm:@agmxyz/pi-workers
```

Restart Pi or run `/reload`, then try: "Have a scout find where this project handles configuration, with `path:line` evidence." What it does, how it works, its limits and safety notes: [packages/pi-workers](packages/pi-workers). Delegation and recovery in depth: [packages/pi-workers/docs/delegate.md](packages/pi-workers/docs/delegate.md).

To track `main` instead, install `git:github.com/agmxyz/me-pi`; install only one of the two. The repo moved from `0bmario/me-pi`: if you installed from that URL, run `pi remove git:github.com/0bmario/me-pi` first.

## The rest of the setup

Around `pi-workers`, I use:

- **A global policy** ([`GLOBAL_AGENTS.md`](GLOBAL_AGENTS.md)): output style, engineering defaults, which actions need my approval, and how to handle secrets and untrusted content. Sections marked `(coordinator only)` stay out of worker prompts.
- **Skills** ([`skills/`](skills)): `implement-me-pi` runs one task with a worker and independent review; `implement-spec-me-pi` implements a ticket graph on one branch; `pi-live-test` live-tests a me-pi change in a real Pi. `evolvability-review` is here too, but `install.sh` doesn't link it.
- **[`install.sh`](install.sh)**, which wires these in machine-wide with a few extras.

You don't need any of it for `pi-workers`; read and copy what's useful. Some skills expect others from my own collection.

`./install.sh` changes what Pi loads across all your sessions: it links the policy and skills, registers this checkout as a package, and installs `pi-web-access`. If you installed `pi-workers` from npm or Git, remove it first (`pi remove npm:@agmxyz/pi-workers` or `pi remove git:github.com/agmxyz/me-pi`), so Pi doesn't load the extensions twice. Review the script and [docs/setup.md](docs/setup.md) for requirements, effects and undo steps before running it.

## Contributing

Node ≥22.19.

```sh
npm ci
npm run check                    # lint, typecheck, tests, installer test
npm run fix                      # apply Biome fixes
node --test test/guard.test.ts   # one test file
```

Before changing `GLOBAL_AGENTS.md` or the delegate tool's prompt text, run the manual routing evals ([evals/README.md](evals/README.md)); they spend real money and never run in CI.

Read [docs/coding-standards.md](docs/coding-standards.md) and [GLOSSARY.md](GLOSSARY.md). CI runs `npm run check` on every PR. Good first issues: [#35](https://github.com/agmxyz/me-pi/issues/35), [#40](https://github.com/agmxyz/me-pi/issues/40).

## License

[MIT](LICENSE)
