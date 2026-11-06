# Routing evals

Manual checks that the always-loaded text (`GLOBAL_AGENTS.md`, `PROMPT_GUIDELINES`, the delegate tool's description and schema) still routes natural requests the way it should. Each attempt is one request in a fresh Pi, scored from that Pi's session log. They make real model calls and spend real money, so they never run in `npm run check` or CI; only the scorer and sandbox have hermetic tests there. Tracked in #56.

Run them before merging any change to that text. A 3–12-word edit has flipped routing before (#58: the job id dropped from check 7, check 12 went from inline to `implement`).

## Isolation

Each ref gets its own temp root. `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR` (= `$HOME/.pi/agent`, where `delegate.json` and the worker auth fence also resolve) point inside it. Pi loads me-pi from a clone of the ref with no remote, through a generated `settings.json`, the same way workers load it. Pi runs under `env -i` with an allowlisted environment, on a private tmux server, and writes its session to a per-attempt `--session-dir`. Code-editing checks run in a fresh copy of `fixtures/tiny-cli`; read-only checks run in their own clone of the ref.

The run never touches `install.sh`, live settings, `delegate.json`, skills, `auth.json`, or the live checkout. It hashes those before and after the run and warns if any changed. One thing is shared: the `pi` launcher's managed install (`~/.pi/agent/install`), meaning the Pi binary itself.

Policy `full-rig` (the routing checks) links the clone's `GLOBAL_AGENTS.md` as `AGENTS.md`, links its `skills/`, adds `+codemode`, and installs `npm:pi-web-access@0.46.0` into the sandbox, loaded before me-pi as in the live rig. `extensions-only` (for #56's pilot) loads the me-pi package alone.

Personal skills and extensions are not loaded by default, and routing depends on them. Check 12 on `main` (`e12bc29`), inline runs:

| Setup | Inline |
|---|---|
| Live rig | 4/5 |
| Sandbox, repo skills only (no skills block: they set `disable-model-invocation`) | 1/6 |
| + 15 personal skills | 2/5 |
| + RTK extension only | 3/5 |
| + personal skills and RTK | 5/5 |
| + personal skills and all 4 live extensions | 5/5 |

To match a live rig, pass its skills with `--skill <dir>` (linked read-only) and its extensions with `--extension <file>` (copied). Each record hashes what you added. Compare refs only under the same setup.

## Credentials

`openai-codex` (the coordinator) accepts OAuth only, so it needs a login, not an API key. Make a dedicated eval login once, outside `~/.pi`:

```sh
PI_CODING_AGENT_DIR=~/.config/me-pi-evals/agent pi   # then /login openai-codex, then quit
```

Pass that file with `--auth ~/.config/me-pi-evals/agent/auth.json`. The runner refuses any credential under `~/.pi`. Never copy the live `auth.json`: an OAuth refresh rotates the refresh token, so a copy desyncs the real login. Attempts share the eval login and its subscription quota, and an `account` error stops the sweep.

The pool (`pools/codex.json`) uses `openai-codex` models only. Check 6 also needs a credential for `claude-opus-5-5`, so it is opt-in.

## Run

```sh
node evals/run.ts --dry-run                       # no credentials, no model calls: Pi starts and loads the policy
node evals/run.ts --auth <file>                   # default checks once against HEAD
node evals/run.ts --auth <file> --only 12 --n 5 --ref main --ref my-branch   # compare two refs
node evals/run.ts --auth <file> --only 3 --skill ~/.agents/skills/code-review
```

| Option | Default | Meaning |
|---|---|---|
| `--ref` | `HEAD` | Ref to test; repeat to compare. Attempts interleave across refs, so drift during the sweep hits every ref alike |
| `--only` | all but opt-in | Comma-separated check ids |
| `--n` | 1 | Attempts per check and ref. n=1 is noisy; use 5 where wording changed |
| `--jobs` | 4 | Attempts in parallel |
| `--budget` | 3 | `ME_PI_SPEND_BUDGET_USD` per attempt; it warns, it does not enforce |
| `--out` | `~/.local/state/me-pi-evals/<sweep>.jsonl` | Record file, mode 0600 |
| `--keep` | off | Keep the sandbox roots for inspection |

The run prints one line per attempt, then a table of passes over completed attempts per check and ref, with void, incomplete, and cost columns. Cost is Pi's estimate, not the provider's counter. Rough costs at n=1: check 3 about $2.7, check 4 about $0.8, the rest $0.03–0.5.

## Checks and records

`scenarios/routing.json` lists each check's prompt, follow-up turns, working directory (`repo` or a fixture), and assertions. `score.ts` defines the assertions: `skill`, `delegate` with `count`, `noTool`, `maxOwnRead`, `inline`, `noRerun`, `diffByPath`, `reply`, `maxReplyWords`.

Each record holds:
- the commit, Pi and node versions, the coordinator and the policy;
- hashes of the prompts, assertions, fixture commit, pool, and the git trees of `packages/pi-workers/extensions/` (`extensions/` for refs before the package move), `GLOBAL_AGENTS.md`, and `skills/`;
- the duration, call count, and estimated cost;
- the state, `completed`, `void` (`STOPPED: infra` in `ME_PI_STATUS_LOG`), or `incomplete` (account stop, timeout, or no session log), and the outcome, `pass`, `fail`, or `unknown`;
- a verdict with evidence for every assertion.

Records stay outside the repo. Post only summary tables.
